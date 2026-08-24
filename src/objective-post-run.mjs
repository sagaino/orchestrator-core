import fs from "node:fs";
import path from "node:path";
import { listProjects } from "./core.mjs";
import { getObjective, listObjectives } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration, listOrchestrations, updateOrchestration } from "./orchestration-store.mjs";
import { getRun } from "./run-manager.mjs";
import { readDurableLease, withDurableLease } from "./durable-runtime.mjs";
import { buildObjectiveEvidence } from "./objective-evidence.mjs";
import { buildDeliveryCertificationEvidence } from "./delivery-certification.mjs";
import { startIntegration } from "./integration-manager.mjs";
import { globalDevServerManager } from "./dev-server-manager.mjs";
import { captureVisualEvidence } from "./visual-qa.mjs";
import { createAggregatePreviewEvidence, persistAggregatePreviewEvidence } from "./visual-evidence.mjs";
import { autopilotAfterPlanApprovalEnabled } from "./approval-policy.mjs";

const NON_RUNNABLE_PREVIEW_NODE_TYPES = new Set(["INTEGRATION", "VERIFICATION"]);
const POST_RUN_RETRY_DELAY_MS = 15_000;
const POST_RUN_LEASE = {
  namespace: "objective-post-run",
  purpose: "automatic objective post-run delivery pipeline",
  ttlMs: 20 * 60 * 1000,
  reclaimDeadOwner: true,
  waitTimeoutMs: 0,
};

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function hasIsolatedWorkspace(runsRoot, runId) {
  if (!runsRoot || !runId) return false;
  try {
    const run = getRun(runsRoot, runId);
    const workspacePath = run?.execution?.workspace?.path;
    return typeof workspacePath === "string" && fs.existsSync(workspacePath);
  } catch {
    return false;
  }
}

export function selectAggregatePreviewCandidates({ evidence, projects = [], runsRoot } = {}) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const nodesByProject = new Map();
  for (const node of evidence?.nodes ?? []) {
    if (node.state !== "DONE" || !node.runId || !node.projectId) continue;
    if (NON_RUNNABLE_PREVIEW_NODE_TYPES.has(String(node.type ?? "").toUpperCase())) continue;
    const current = nodesByProject.get(node.projectId);
    const currentHasWorkspace = current ? hasIsolatedWorkspace(runsRoot, current.runId) : false;
    const candidateHasWorkspace = hasIsolatedWorkspace(runsRoot, node.runId);
    if (!current || (!currentHasWorkspace && candidateHasWorkspace) || (!currentHasWorkspace && !candidateHasWorkspace)) {
      nodesByProject.set(node.projectId, { node, hasWorkspace: candidateHasWorkspace });
    }
  }

  const planApproved = evidence?.plan?.state === "APPROVED";
  return (evidence?.objective?.projectIds ?? []).map((projectId) => {
    const selected = nodesByProject.get(projectId);
    const project = projectById.get(projectId);
    const repository = selected?.hasWorkspace ? null : project?.repository ?? null;
    const available = Boolean(selected && (selected.hasWorkspace || repository));
    return {
      projectId,
      runId: selected?.node.runId ?? null,
      repository,
      environment: { ORCHESTRATOR_RUNS: path.resolve(runsRoot) },
      unavailableReason: planApproved ? (available ? null : "NO_RUNNABLE_PREVIEW_SOURCE") : "PLAN_NOT_APPROVED",
      unavailableMessage: planApproved
        ? (available ? null : "Tidak ada isolated workspace atau repository terdaftar untuk preview project ini.")
        : "Preview hanya tersedia setelah plan objective di-approve.",
    };
  });
}

function planOptions(objective) {
  return { knownProjectIds: objective.projectIds, projectIds: objective.projectIds, budget: objective.budget };
}

function currentContext({ runsRoot, objective }) {
  const plan = objective.activePlanId ? getPlan(runsRoot, objective.activePlanId, planOptions(objective)) : null;
  const orchestration = objective.activeOrchestrationId ? getOrchestration(runsRoot, objective.activeOrchestrationId, { plan: plan ?? undefined }) : null;
  return { objective, plan, orchestration };
}

function retryDue(postRunAutomation, now) {
  const lastAttemptAt = Date.parse(postRunAutomation?.lastAttemptAt ?? "");
  return !Number.isFinite(lastAttemptAt) || now.getTime() - lastAttemptAt >= POST_RUN_RETRY_DELAY_MS;
}

function updatePostRunAutomation({ runsRoot, orchestration, plan, now, patch }) {
  return updateOrchestration({
    runsRoot,
    orchestrationId: orchestration.orchestrationId,
    expectedRevision: orchestration.revision,
    now,
    update: (record) => ({
      ...record,
      postRunAutomation: {
        ...(record.postRunAutomation ?? {}),
        ...patch,
        updatedAt: iso(now),
      },
    }),
    validationOptions: { plan },
  });
}

function certificationBlockers({ runsRoot, objectiveId }) {
  return buildDeliveryCertificationEvidence({ runsRoot, objectiveId, automatic: true });
}

function recoverStaleIntegration({ runsRoot, orchestration, plan, now }) {
  if (orchestration.integration?.state !== "RUNNING") return orchestration;
  const lease = readDurableLease(runsRoot, "integration-manager", orchestration.orchestrationId);
  if (lease) return orchestration;
  return updateOrchestration({
    runsRoot,
    orchestrationId: orchestration.orchestrationId,
    expectedRevision: orchestration.revision,
    now,
    update: (record) => ({
      ...record,
      state: "DONE",
      integration: {
        ...(record.integration ?? {}),
        state: "NOT_READY",
        sourceNodeIds: record.integration?.sourceNodeIds ?? [],
        staleRecovery: { recoveredAt: iso(now), reason: "INTEGRATION_LEASE_MISSING" },
      },
    }),
    validationOptions: { plan },
  });
}

async function runPreviewAndVisualCapture({ runsRoot, vaultRoot, objectiveId, evidence, now, devServerManager, captureRunner }) {
  const projects = listProjects(vaultRoot).projects;
  const candidates = selectAggregatePreviewCandidates({ evidence, projects, runsRoot });
  const preview = await devServerManager.startAggregateProjectPreview({
    runsRoot,
    objectiveId,
    candidates,
    maxProjects: Math.max(1, Math.min(4, candidates.length || 1)),
    maxServers: Math.max(1, Math.min(4, candidates.length || 1)),
  });
  persistAggregatePreviewEvidence({
    runsRoot,
    evidence: createAggregatePreviewEvidence({ preview, objectiveId, createdAt: iso(now) }),
  });

  const captureErrors = [];
  try {
    for (const item of preview.previews ?? []) {
      if (!item.runId) {
        captureErrors.push({ projectId: item.projectId, message: "Preview tidak memiliki runId untuk capture visual." });
        continue;
      }
      const server = devServerManager.getDevServerStatus(item.runId);
      if (!server.url) {
        captureErrors.push({ projectId: item.projectId, runId: item.runId, message: "Dev server preview tidak menyediakan URL." });
        continue;
      }
      const capture = await captureRunner({
        runsRoot,
        runId: item.runId,
        baseUrl: server.url,
        route: "/",
        reference: { kind: "NONE" },
        revision: { number: 1, requestedBy: "system:autopilot", reason: "Automatic post-run delivery evidence" },
        timeoutMs: 30_000,
        now,
      });
      if (capture?.status !== "PASS") captureErrors.push({ projectId: item.projectId, runId: item.runId, message: `Capture visual berstatus ${capture?.status ?? "UNKNOWN"}.` });
    }
  } finally {
    const stopped = devServerManager.stopAggregatePreview(preview.sessionId, objectiveId);
    if (stopped?.status && stopped.status !== "NOT_FOUND") {
      persistAggregatePreviewEvidence({
        runsRoot,
        evidence: createAggregatePreviewEvidence({ preview: stopped, objectiveId, createdAt: iso(now) }),
      });
    }
  }

  if (preview.status !== "READY") {
    const error = new Error(`Aggregate preview berstatus ${preview.status}.`);
    error.code = "POST_RUN_PREVIEW_NOT_READY";
    error.details = { status: preview.status, unavailable: preview.unavailable ?? [] };
    throw error;
  }
  if (captureErrors.length) {
    const error = new Error("Capture visual otomatis belum seluruhnya berhasil.");
    error.code = "POST_RUN_VISUAL_CAPTURE_FAILED";
    error.details = { captureErrors };
    throw error;
  }
  return { preview, captureCount: (preview.previews ?? []).length };
}

async function processObjective({ runsRoot, vaultRoot, objective, now, services }) {
  let initial = currentContext({ runsRoot, objective });
  if (initial.orchestration?.state === "INTEGRATING") {
    const recovered = recoverStaleIntegration({ runsRoot, orchestration: initial.orchestration, plan: initial.plan, now });
    initial = { ...initial, orchestration: recovered };
  }
  if (!initial.plan || initial.plan.state !== "APPROVED" || !initial.orchestration || initial.orchestration.state !== "DONE") {
    return { action: "SKIPPED", objectiveId: objective.objectiveId, reason: "POST_RUN_PREREQUISITES_NOT_READY" };
  }

  const previous = initial.orchestration.postRunAutomation ?? {};
  if (previous.status === "COMPLETED" || !retryDue(previous, now)) {
    return { action: "SKIPPED", objectiveId: objective.objectiveId, reason: previous.status === "COMPLETED" ? "ALREADY_COMPLETED" : "RETRY_BACKOFF" };
  }

  let orchestration = updatePostRunAutomation({
    runsRoot,
    orchestration: initial.orchestration,
    plan: initial.plan,
    now,
    patch: { status: "RUNNING", phase: "PRECHECK", startedAt: previous.startedAt ?? iso(now), lastAttemptAt: iso(now), attempts: Number(previous.attempts ?? 0) + 1, error: null },
  });

  try {
    let certificate = certificationBlockers({ runsRoot, objectiveId: objective.objectiveId });
    if (certificate.blockers.includes("INTEGRATION_COMPLETE")) {
      orchestration = recoverStaleIntegration({
        runsRoot,
        orchestration: getOrchestration(runsRoot, orchestration.orchestrationId, { plan: initial.plan }),
        plan: initial.plan,
        now,
      });
      if (orchestration.integration?.state === "RUNNING") {
        const waiting = updatePostRunAutomation({ runsRoot, orchestration, plan: initial.plan, now, patch: { status: "WAITING", phase: "INTEGRATION", error: null } });
        return { action: "SKIPPED", objectiveId: objective.objectiveId, reason: "INTEGRATION_IN_PROGRESS", orchestration: waiting };
      }
      orchestration = updatePostRunAutomation({ runsRoot, orchestration, plan: initial.plan, now, patch: { phase: "INTEGRATION" } });
      const integrationRunner = services?.startIntegration ?? startIntegration;
      const integration = await integrationRunner({ runsRoot, vaultRoot, objectiveId: objective.objectiveId, orchestrationId: orchestration.orchestrationId, now });
      if (["INTEGRATION_IN_PROGRESS"].includes(integration?.action)) {
        const waiting = updatePostRunAutomation({ runsRoot, orchestration: integration.orchestration ?? getOrchestration(runsRoot, orchestration.orchestrationId), plan: initial.plan, now, patch: { status: "WAITING", phase: "INTEGRATION", error: null } });
        return { action: "SKIPPED", objectiveId: objective.objectiveId, reason: "INTEGRATION_IN_PROGRESS", orchestration: waiting };
      }
      if (["INTEGRATION_BLOCKED"].includes(integration?.action)) {
        const blocked = updatePostRunAutomation({ runsRoot, orchestration: integration.orchestration ?? getOrchestration(runsRoot, orchestration.orchestrationId), plan: initial.plan, now, patch: { status: "BLOCKED", phase: "INTEGRATION", error: "Integration membutuhkan resolusi blocker." } });
        return { action: "BLOCKED", objectiveId: objective.objectiveId, phase: "INTEGRATION", orchestration: blocked, decisionId: integration.decision?.decisionId ?? null };
      }
      certificate = certificationBlockers({ runsRoot, objectiveId: objective.objectiveId });
    }

    if (certificate.blockers.includes("PREVIEW_COMPLETE") || certificate.blockers.includes("VISUAL_E2E_EVIDENCE_COMPLETE") || certificate.blockers.includes("CLEANUP_COMPLETE")) {
      orchestration = getOrchestration(runsRoot, orchestration.orchestrationId, { plan: initial.plan });
      orchestration = updatePostRunAutomation({ runsRoot, orchestration, plan: initial.plan, now, patch: { phase: "PREVIEW_AND_EVIDENCE" } });
      const evidence = buildObjectiveEvidence({ runsRoot, objectiveId: objective.objectiveId });
      const devServerManager = services?.devServerManager ?? globalDevServerManager;
      const captureRunner = services?.captureVisualEvidence ?? captureVisualEvidence;
      await runPreviewAndVisualCapture({ runsRoot, vaultRoot, objectiveId: objective.objectiveId, evidence, now, devServerManager, captureRunner });
    }

    certificate = certificationBlockers({ runsRoot, objectiveId: objective.objectiveId });
    if (certificate.blockers.length) {
      const blocked = updatePostRunAutomation({ runsRoot, orchestration: getOrchestration(runsRoot, orchestration.orchestrationId, { plan: initial.plan }), plan: initial.plan, now, patch: { status: "BLOCKED", phase: "DELIVERY_GATES", blockers: certificate.blockers, error: "Delivery evidence masih memiliki blocker." } });
      return { action: "BLOCKED", objectiveId: objective.objectiveId, phase: "DELIVERY_GATES", blockers: certificate.blockers, orchestration: blocked };
    }
    const completed = updatePostRunAutomation({ runsRoot, orchestration: getOrchestration(runsRoot, orchestration.orchestrationId, { plan: initial.plan }), plan: initial.plan, now, patch: { status: "COMPLETED", phase: "READY_FOR_FINAL_ACCEPTANCE", completedAt: iso(now), blockers: [], error: null } });
    return { action: "COMPLETED", objectiveId: objective.objectiveId, orchestration: completed };
  } catch (error) {
    const current = getOrchestration(runsRoot, orchestration.orchestrationId, { plan: initial.plan });
    const failed = updatePostRunAutomation({
      runsRoot,
      orchestration: current,
      plan: initial.plan,
      now,
      patch: {
        status: "EXCEPTION",
        phase: current.postRunAutomation?.phase ?? "UNKNOWN",
        error: { code: error.code ?? "POST_RUN_AUTOMATION_ERROR", message: error.message, details: error.details ?? null },
      },
    });
    return { action: "EXCEPTION", objectiveId: objective.objectiveId, phase: failed.postRunAutomation?.phase ?? null, error: error.message, orchestration: failed };
  }
}

export async function automaticPostRunTick({ vaultRoot, runsRoot, env = process.env, now = new Date(), services = {} } = {}) {
  if (!autopilotAfterPlanApprovalEnabled(env)) return { enabled: false, completed: [], blocked: [], exceptions: [], skipped: [] };
  const results = { enabled: true, completed: [], blocked: [], exceptions: [], skipped: [] };
  const objectives = listObjectives(runsRoot).filter((objective) => !["CANCELLED", "DONE"].includes(objective.state) && objective.activeOrchestrationId);
  for (const objective of objectives) {
    let orchestration = null;
    try {
      orchestration = getOrchestration(runsRoot, objective.activeOrchestrationId);
      const result = await withDurableLease({ runsRoot, ...POST_RUN_LEASE, key: objective.objectiveId }, () => processObjective({ runsRoot, vaultRoot, objective, now, services }));
      if (result.action === "COMPLETED") results.completed.push({ objectiveId: objective.objectiveId, phase: result.orchestration?.postRunAutomation?.phase ?? null });
      else if (result.action === "BLOCKED") results.blocked.push({ objectiveId: objective.objectiveId, phase: result.phase, blockers: result.blockers ?? [], decisionId: result.decisionId ?? null });
      else if (result.action === "EXCEPTION") results.exceptions.push({ objectiveId: objective.objectiveId, phase: result.phase, error: result.error });
      else results.skipped.push({ objectiveId: objective.objectiveId, reason: result.reason ?? "SKIPPED" });
    } catch (error) {
      if (error?.code === "DURABLE_LEASE_HELD") results.skipped.push({ objectiveId: objective.objectiveId, reason: "LEASE_HELD" });
      else results.exceptions.push({ objectiveId: objective.objectiveId, orchestrationId: orchestration?.orchestrationId ?? null, error: error.message });
    }
  }
  return results;
}
