import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { listProjects, getPackageScripts } from "./core.mjs";
import { createDecision, getDecision, updateDecision } from "./decision-store.mjs";
import { getObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration, updateOrchestration } from "./orchestration-store.mjs";
import { listJobs } from "./job-queue.mjs";
import { listRuns, RUN_STATES } from "./run-manager.mjs";
import { createPlanRevision } from "./plan-lifecycle.mjs";
import { buildIntegrationEvidence, buildRunEvidence } from "./interaction.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { aiRepairApplicable, runProcess } from "./executor.mjs";
import { globalDevServerManager } from "./dev-server-manager.mjs";
import { topologicalOrder } from "./task-graph.mjs";
import {
  applyIntegrationPatches,
  cleanupIntegrationWorkspace,
  prepareIntegrationWorkspace,
  rollbackIntegrationWorkspace,
} from "./integration-workspace.mjs";

const INTEGRATION_LEASE = {
  namespace: "integration-manager",
  purpose: "objective integration manager",
  ttlMs: 15 * 60 * 1000,
  reclaimDeadOwner: true,
  waitTimeoutMs: 2_000,
};

export class IntegrationManagerError extends Error {
  constructor(message, { statusCode = 409, code = "INTEGRATION_MANAGER_ERROR", details = null } = {}) {
    super(message);
    this.name = "IntegrationManagerError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new IntegrationManagerError(message, options);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function artifactPath(runsRoot, orchestrationId) {
  return path.join(runsRoot, "integration", orchestrationId, "aggregate-evidence.json");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return filePath;
}

function context({ runsRoot, objectiveId, orchestrationId = null }) {
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) fail(`Objective tidak ditemukan: ${objectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId } });
  const selectedId = orchestrationId ?? objective.activeOrchestrationId;
  const orchestration = selectedId ? getOrchestration(runsRoot, selectedId) : null;
  if (!orchestration) fail(`Orchestration tidak ditemukan: ${selectedId ?? objectiveId}`, { statusCode: 404, code: "ORCHESTRATION_NOT_FOUND", details: { code: "ORCHESTRATION_NOT_FOUND", orchestrationId: selectedId } });
  const plan = getPlan(runsRoot, orchestration.planId, { knownProjectIds: objective.projectIds, projectIds: objective.projectIds, budget: objective.budget });
  if (!plan || plan.objectiveId !== objective.objectiveId) fail("Integration plan tidak cocok dengan objective.", { code: "PLAN_OBJECTIVE_MISMATCH", details: { code: "PLAN_OBJECTIVE_MISMATCH" } });
  return { objective, plan, orchestration };
}

function sourceNodes(plan, integrationNodeId = null) {
  const integrationNode = integrationNodeId
    ? plan.nodes.find((node) => node.nodeId === integrationNodeId)
    : plan.nodes.find((node) => node.type === "INTEGRATION");
  if (integrationNode) {
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    const sourceIds = new Set();
    const visit = (nodeId) => {
      if (sourceIds.has(nodeId)) return;
      sourceIds.add(nodeId);
      for (const dependency of byId.get(nodeId)?.dependsOn ?? []) visit(dependency);
    };
    for (const dependency of integrationNode.dependsOn ?? []) visit(dependency);
    return { integrationNode, nodes: plan.nodes.filter((node) => node.type !== "INTEGRATION"), requiredNodeIds: [...sourceIds] };
  }
  return { integrationNode: null, nodes: plan.nodes.filter((node) => node.type !== "INTEGRATION"), requiredNodeIds: plan.nodes.filter((node) => node.type !== "INTEGRATION").map((node) => node.nodeId) };
}

function currentJob(jobs, orchestrationId, nodeId, attempt = 1) {
  return jobs
    .filter((job) => job.orchestrationId === orchestrationId && job.nodeId === nodeId && Number(job.attempt ?? 1) === Number(attempt))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
}

function sourceRunEvidence({ runsRoot, jobs, runs, orchestration, nodes }) {
  const errors = [];
  const sourceRuns = [];
  for (const node of nodes) {
    const runtime = orchestration.nodes[node.nodeId];
    if (!runtime || runtime.state !== "DONE") {
      errors.push({ nodeId: node.nodeId, code: "PREDECESSOR_NOT_DONE", state: runtime?.state ?? null });
      continue;
    }
    const job = currentJob(jobs, orchestration.orchestrationId, node.nodeId, runtime.attempt);
    const run = runtime.runId
      ? runs.find((candidate) => candidate.runId === runtime.runId)
      : job?.runId ? runs.find((candidate) => candidate.runId === job.runId) : null;
    if (!job) errors.push({ nodeId: node.nodeId, code: "SOURCE_JOB_MISSING" });
    if (!run) errors.push({ nodeId: node.nodeId, code: "SOURCE_RUN_MISSING", jobId: job?.jobId ?? null });
    if (run && run.state !== RUN_STATES.DONE) errors.push({ nodeId: node.nodeId, code: "SOURCE_RUN_NOT_DONE", runId: run.runId, state: run.state });
    const evidence = run ? buildRunEvidence(run, { runsRoot }) : null;
    const commit = run?.execution?.result?.gitCommit ?? run?.execution?.workspace?.gitCommit ?? null;
    if (run && !commit?.commitHash) errors.push({ nodeId: node.nodeId, code: "SOURCE_COMMIT_MISSING", runId: run.runId });
    sourceRuns.push({
      nodeId: node.nodeId,
      projectId: run?.project?.id ?? node.projectId ?? null,
      allowedPaths: node.allowedPaths ?? [],
      changedPaths: run?.execution?.scopeAudit?.changedPaths ?? [],
      job,
      run,
      evidence,
      commit,
    });
  }
  return { sourceRuns, errors };
}

function normalizeScript(raw) {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value.startsWith("npm run ")) return value.slice("npm run ".length).trim();
    return value;
  }
  if (raw && typeof raw === "object") return String(raw.script ?? raw.name ?? "").trim();
  return "";
}

function verificationRequests({ plan, projects }) {
  const requested = Array.isArray(plan.integration?.projectVerification) ? plan.integration.projectVerification : [];
  const requests = [];
  for (const project of projects) {
    const scripts = requested.length ? requested : project.verificationDefaults ?? [];
    for (const raw of scripts) {
      const normalized = normalizeScript(raw);
      if (!normalized) continue;
      const separator = normalized.indexOf(":");
      const scopedProject = separator > 0 && projects.some((candidate) => candidate.id === normalized.slice(0, separator))
        ? normalized.slice(0, separator)
        : null;
      const script = scopedProject ? normalized.slice(separator + 1).trim() : normalized;
      if (scopedProject && scopedProject !== project.id) continue;
      requests.push({ projectId: project.id, script });
    }
  }
  return requests;
}

function crossProjectVerificationRequests({ plan, projects }) {
  const requested = Array.isArray(plan.integration?.crossProjectVerification) ? plan.integration.crossProjectVerification : [];
  const requests = [];
  for (const raw of requested) {
    const normalized = normalizeScript(raw);
    if (!normalized) continue;
    const separator = normalized.indexOf(":");
    const scopedProject = separator > 0 && projects.some((candidate) => candidate.id === normalized.slice(0, separator))
      ? normalized.slice(0, separator)
      : null;
    const script = scopedProject ? normalized.slice(separator + 1).trim() : normalized;
    const targets = scopedProject ? projects.filter((project) => project.id === scopedProject) : projects;
    for (const project of targets) requests.push({ projectId: project.id, script, scope: "CROSS_PROJECT" });
  }
  return requests;
}

function needsLocalServices({ plan, requests }) {
  if (Array.isArray(plan.integration?.localServices) && plan.integration.localServices.length > 0) return true;
  return requests.some((request) => /(?:e2e|browser|playwright|cypress|visual)/i.test(request.script));
}

function requestedServiceProjectIds({ plan, projects }) {
  const configured = Array.isArray(plan.integration?.localServices) ? plan.integration.localServices : [];
  const ids = configured.map((item) => typeof item === "string" ? item : item?.projectId).filter(Boolean);
  return ids.length ? projects.filter((project) => ids.includes(project.id)) : projects;
}

function repositoryAcceptance({ projects, sourceRuns, verification }) {
  return projects.map((project) => {
    const runs = sourceRuns.filter((source) => source.projectId === project.id);
    const checks = verification.filter((result) => result.projectId === project.id && result.scope !== "CROSS_PROJECT");
    const runIds = runs.map((run) => run.run?.runId ?? run.job?.runId).filter(Boolean);
    const diffs = runs.map((run) => ({ runId: run.run?.runId ?? run.job?.runId ?? null, changedPaths: run.changedPaths ?? [], allowedPaths: run.allowedPaths ?? [] }));
    const status = runs.length > 0
      && runs.every((run) => run.run?.state === "DONE" && Boolean(run.commit?.commitHash))
      && checks.length > 0
      && checks.every((check) => check.status === "PASS")
      ? "PASS"
      : "FAIL";
    return {
      projectId: project.id,
      baseline: null,
      runIds,
      diffs,
      checks,
      acceptance: { gate: "PER_REPOSITORY", status },
    };
  });
}

async function runApprovedVerification({ project, script, scope = "PROJECT", verificationRunner, serviceUrls = {} }) {
  const command = `npm run ${script}`;
  if (verificationRunner) {
    const response = await verificationRunner({ project, projectId: project.id, script, command, cwd: project.repository, scope, approved: true, serviceUrls });
    return { projectId: project.id, script, scope, command, serviceUrls, ...(response ?? {}), exitCode: response?.exitCode ?? null, status: response?.exitCode === 0 ? "PASS" : "FAIL" };
  }
  const response = await runProcess({
    command: "npm",
    args: ["run", script],
    cwd: project.repository,
    stage: "verification",
    writableRoots: [project.repository],
    readableRoots: [project.repository],
    env: { ...process.env, ORCHESTRATOR_PROJECT_URLS: JSON.stringify(serviceUrls) },
    allowLoopback: scope === "CROSS_PROJECT",
  });
  return { projectId: project.id, script, scope, command, serviceUrls, ...response, status: response.exitCode === 0 ? "PASS" : "FAIL" };
}

function baseline(repository) {
  try { return execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null; } catch { return null; }
}

function blockerDecision({ runsRoot, objective, orchestration, sourceRuns, sourceErrors, verification, evidence, now }) {
  const baseDecisionId = `decision-integration-${orchestration.orchestrationId}`;
  const previous = getDecision(runsRoot, orchestration.integration?.blockerDecisionId ?? baseDecisionId);
  const recoveryAttempt = previous && previous.state !== "OPEN"
    ? Number(previous.evidence?.recoveryAttempt ?? 0) + 1
    : Number(previous?.evidence?.recoveryAttempt ?? 0);
  const decisionId = recoveryAttempt > 0 ? `${baseDecisionId}-r${recoveryAttempt}` : baseDecisionId;
  const existing = getDecision(runsRoot, decisionId);
  if (existing) return existing;
  return createDecision({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      decisionId,
      objectiveId: objective.objectiveId,
      nodeId: null,
      runId: null,
      type: "INTEGRATION_CONFLICT",
      state: "OPEN",
      evidence: {
        orchestrationId: orchestration.orchestrationId,
        planId: orchestration.planId,
        planFingerprint: orchestration.planFingerprint,
        sourceRunIds: evidence.sourceRunIds,
        sourceErrors,
        verification,
        recoveryAttempt,
        aggregateEvidence: evidence,
      },
      requestedAction: "Resolve failed orchestration integration after reviewing aggregate evidence.",
      allowedChoices: ["RETRY", "REPAIR_PLAN", "SCOPE_EXPANSION", "CANCEL"],
      creator: "SYSTEM",
      createdAt: iso(now),
      resolution: null,
    },
  });
}

function finalizeIntegration({ runsRoot, contextValue, artifact, verification, sourceErrors, now }) {
  return withDurableLease({ runsRoot, ...INTEGRATION_LEASE, key: contextValue.orchestration.orchestrationId }, () => {
    const current = getOrchestration(runsRoot, contextValue.orchestration.orchestrationId);
    const crossProject = contextValue.objective.mode === "CROSS_PROJECT_INCIDENT";
    const repositoryAcceptanceFailed = crossProject && (!Array.isArray(artifact.repositoryAcceptance) || artifact.repositoryAcceptance.length !== contextValue.objective.projectIds.length || artifact.repositoryAcceptance.some((item) => item.acceptance?.status !== "PASS"));
    const crossVerificationFailed = crossProject && artifact.crossProjectVerification?.required === true && artifact.crossProjectVerification.status !== "PASS";
    const failed = sourceErrors.length > 0 || artifact.complete !== true || artifact.scope.changedPathsWithinUnion !== true || artifact.verification.status !== "PASS" || repositoryAcceptanceFailed || crossVerificationFailed;
    const integrationNode = contextValue.plan.nodes.find((node) => node.type === "INTEGRATION");
    const decision = failed
      ? blockerDecision({ runsRoot, objective: contextValue.objective, orchestration: current, sourceRuns: artifact.sourceRuns ?? [], sourceErrors, verification, evidence: artifact, now })
      : null;
    const nextIntegration = {
      ...(current.integration ?? {}),
      state: failed ? "BLOCKED" : "PASSED",
      sourceRunIds: artifact.sourceRunIds,
      commitHashes: artifact.commitHashes,
      aggregateScope: artifact.scope,
      verification: artifact.verification.results,
      evidencePath: artifact.artifactPath,
      ...(decision ? { blockerDecisionId: decision.decisionId } : {}),
      completedAt: iso(now),
    };
    const updated = updateOrchestration({
      runsRoot,
      orchestrationId: current.orchestrationId,
      expectedRevision: current.revision,
      now,
      update: (record) => ({
        ...record,
        state: failed ? "BLOCKED" : "DONE",
        nodes: integrationNode
          ? {
            ...record.nodes,
            [integrationNode.nodeId]: {
              ...record.nodes[integrationNode.nodeId],
              state: failed ? "FAILED" : "DONE",
              lastError: failed ? { code: "INTEGRATION_VERIFICATION_FAILED", message: "Aggregate integration verification failed." } : null,
            },
          }
          : record.nodes,
        integration: nextIntegration,
      }),
      validationOptions: { plan: contextValue.plan },
    });
    const persistedArtifact = { ...artifact, status: failed ? "BLOCKED" : "PASSED", blockerDecisionId: decision?.decisionId ?? null, completedAt: iso(now) };
    writeJsonAtomic(artifact.artifactPath, persistedArtifact);
    return { action: failed ? "INTEGRATION_BLOCKED" : "INTEGRATION_COMPLETED", integration: updated.integration, orchestration: updated, evidence: persistedArtifact, decision };
  });
}

const SAFE_RETRY_SOURCE_ERRORS = new Set([
  "SOURCE_JOB_MISSING",
  "SOURCE_RUN_MISSING",
  "SOURCE_RUN_NOT_DONE",
  "SOURCE_COMMIT_MISSING",
]);

const SAFE_RETRY_PATTERN = /\b(?:timeout|timed out|rate[- ]?limit|429|ECONN(?:RESET|REFUSED|TIMEDOUT)|ENOTFOUND|EAI_AGAIN|provider|sandbox|permission|temporar(?:y|ily)|unavailable|network)\b/i;

export function classifyIntegrationFailure({ evidence = null } = {}) {
  const sourceErrors = Array.isArray(evidence?.sourceErrors) ? evidence.sourceErrors : [];
  const verification = Array.isArray(evidence?.verification?.results)
    ? evidence.verification.results
    : Array.isArray(evidence?.verification)
      ? evidence.verification
      : [];
  const reasons = [];
  for (const sourceError of sourceErrors) {
    if (SAFE_RETRY_SOURCE_ERRORS.has(String(sourceError?.code ?? ""))) reasons.push({ source: "source", code: sourceError.code, nodeId: sourceError.nodeId ?? null });
  }
  for (const result of verification.filter((item) => item?.status !== "PASS")) {
    const message = [result.error, result.stderrTail, result.stdoutTail].filter(Boolean).join(" ");
    if (!aiRepairApplicable({ message }) || SAFE_RETRY_PATTERN.test(message)) {
      reasons.push({ source: "verification", projectId: result.projectId ?? null, script: result.script ?? null, message: message || null });
    }
  }
  if (reasons.length > 0) {
    return {
      classification: "INFRASTRUCTURE",
      strategy: "SAFE_RETRY",
      repairApplicable: false,
      reasons,
    };
  }
  return {
    classification: "PRODUCT",
    strategy: "TARGETED_REPAIR",
    repairApplicable: true,
    reasons: verification.filter((item) => item?.status !== "PASS").map((item) => ({
      source: "verification",
      projectId: item.projectId ?? null,
      script: item.script ?? null,
      message: item.error ?? null,
    })),
  };
}

function repairCycleLimit(objective) {
  return Number(objective?.budget?.maxRepairCycles ?? 1);
}

function repairCycle(plan) {
  return Number(plan?.repair?.cycle ?? 0);
}

function repairProject({ plan, evidence }) {
  const verificationProjectIds = [...new Set((evidence?.verification?.results ?? [])
    .filter((result) => result?.status !== "PASS" && result?.projectId)
    .map((result) => result.projectId))];
  if (verificationProjectIds.length > 1) {
    fail("Targeted repair membutuhkan satu project target yang eksplisit.", {
      code: "REPAIR_PROJECT_AMBIGUOUS",
      details: { code: "REPAIR_PROJECT_AMBIGUOUS", projects: verificationProjectIds },
    });
  }
  const sourceProjectIds = [...new Set((evidence?.sourceRuns ?? []).map((source) => source.projectId).filter(Boolean))];
  const projectId = verificationProjectIds[0] ?? (sourceProjectIds.length === 1 ? sourceProjectIds[0] : null);
  if (!projectId || !plan.projects.includes(projectId)) {
    fail("Targeted repair tidak dapat menentukan project target dari evidence integration.", {
      code: "REPAIR_PROJECT_UNRESOLVED",
      details: { code: "REPAIR_PROJECT_UNRESOLVED", projects: sourceProjectIds },
    });
  }
  return projectId;
}

function repairPaths({ plan, evidence, projectId }) {
  const sources = (evidence?.sourceRuns ?? []).filter((source) => source.projectId === projectId);
  const changedPaths = sources.flatMap((source) => Array.isArray(source.changedPaths) ? source.changedPaths : []);
  const allowedPaths = [
    ...sources.flatMap((source) => Array.isArray(source.allowedPaths) ? source.allowedPaths : []),
    ...plan.nodes.filter((node) => node.projectId === projectId).flatMap((node) => node.allowedPaths ?? []),
  ];
  const paths = [...new Set([...changedPaths, ...allowedPaths].map((value) => String(value).trim()).filter(Boolean))].sort();
  if (!paths.length) {
    fail("Targeted repair membutuhkan allowed paths atau changed paths yang dapat ditelusuri.", {
      code: "REPAIR_PATHS_UNRESOLVED",
      details: { code: "REPAIR_PATHS_UNRESOLVED", projectId },
    });
  }
  return paths;
}

function repairTests({ plan, evidence, projectId }) {
  const failedScripts = (evidence?.verification?.results ?? [])
    .filter((result) => result?.status !== "PASS" && (!result.projectId || result.projectId === projectId))
    .map((result) => normalizeScript(result.script ?? result.command))
    .filter(Boolean);
  const plannedScripts = Array.isArray(plan.integration?.projectVerification)
    ? plan.integration.projectVerification.map(normalizeScript).filter(Boolean)
    : [];
  const tests = [...new Set([...failedScripts, ...plannedScripts])];
  if (!tests.length) {
    fail("Targeted repair membutuhkan verification test yang eksplisit.", {
      code: "REPAIR_TESTS_UNRESOLVED",
      details: { code: "REPAIR_TESTS_UNRESOLVED", projectId },
    });
  }
  return tests;
}

function repairCandidate({ objective, plan, evidence, now }) {
  const cycle = repairCycle(plan) + 1;
  const maximum = repairCycleLimit(objective);
  if (cycle > maximum) {
    fail(`Batas repair cycle tercapai: ${repairCycle(plan)}/${maximum}.`, {
      statusCode: 409,
      code: "MAX_REPAIR_CYCLES_EXCEEDED",
      details: { code: "MAX_REPAIR_CYCLES_EXCEEDED", cycle: repairCycle(plan), maxRepairCycles: maximum },
    });
  }
  if (plan.nodes.length >= Number(objective.budget?.maxSubtasks ?? plan.nodes.length)) {
    fail("Targeted repair akan melampaui budget maxSubtasks objective.", {
      statusCode: 409,
      code: "REPAIR_NODE_BUDGET_EXCEEDED",
      details: { code: "REPAIR_NODE_BUDGET_EXCEEDED", maxSubtasks: objective.budget?.maxSubtasks, currentNodes: plan.nodes.length },
    });
  }
  const projectId = repairProject({ plan, evidence });
  const allowedPaths = repairPaths({ plan, evidence, projectId });
  const verification = repairTests({ plan, evidence, projectId });
  const integrationNode = plan.nodes.find((node) => node.type === "INTEGRATION");
  const dependencies = integrationNode?.dependsOn?.length
    ? [...integrationNode.dependsOn]
    : plan.nodes.filter((node) => node.type !== "INTEGRATION").map((node) => node.nodeId);
  const dependencyNodes = plan.nodes.filter((node) => dependencies.includes(node.nodeId));
  const sourceNode = dependencyNodes.find((node) => node.projectId === projectId) ?? plan.nodes.find((node) => node.projectId === projectId);
  const nodeId = `REPAIR-${cycle}`;
  if (plan.nodes.some((node) => node.nodeId === nodeId)) {
    fail(`Repair node sudah ada: ${nodeId}.`, { code: "REPAIR_NODE_ALREADY_EXISTS", details: { code: "REPAIR_NODE_ALREADY_EXISTS", nodeId } });
  }
  const repairNode = {
    nodeId,
    title: `Targeted repair after integration failure (cycle ${cycle})`,
    purpose: "Repair the verified product failure within the explicit paths and rerun the recorded integration tests.",
    projectId,
    role: sourceNode?.role ?? "GENERAL",
    type: "IMPLEMENTATION",
    dependsOn: dependencies,
    acceptanceCriteria: [
      "The recorded product integration failure is repaired.",
      `Verification scripts pass: ${verification.join(", ")}.`,
      "All changes remain within the explicit allowed paths.",
    ],
    allowedPaths,
    verification,
    risk: sourceNode?.risk ?? plan.risk,
    complexity: sourceNode?.complexity ?? plan.complexity,
    requiresChanges: true,
    canRunInParallel: false,
    writeConflictGroup: `integration-repair:${projectId}`,
    contextFrom: dependencies,
    skills: [],
  };
  const nodes = plan.nodes.map((node) => node.type === "INTEGRATION"
    ? { ...node, dependsOn: [nodeId], contextFrom: [...new Set([...(node.contextFrom ?? []), nodeId])] }
    : node);
  nodes.push(repairNode);
  const preservedSourceRunIds = Array.isArray(evidence?.sourceRunIds) ? [...evidence.sourceRunIds] : [];
  const preservedCommitHashes = Array.isArray(evidence?.commitHashes) ? [...evidence.commitHashes] : [];
  const candidate = {
    ...structuredClone(plan),
    state: "PENDING_APPROVAL",
    approvedBy: null,
    approvedAt: null,
    nodes,
    repair: {
      cycle,
      maxCycles: maximum,
      nodeId,
      parentPlanId: plan.planId,
      parentPlanFingerprint: plan.planFingerprint,
      sourceRunIds: preservedSourceRunIds,
      commitHashes: preservedCommitHashes,
      preservedChangedPaths: evidence?.scope?.changedPaths ?? [],
      trigger: {
        classification: "PRODUCT",
        orchestrationId: evidence?.orchestrationId ?? null,
        verification: evidence?.verification ?? null,
      },
      createdAt: iso(now),
    },
  };
  return { candidate, repairNode, cycle, maximum, projectId, allowedPaths, verification };
}

function attachRepairProposal({ runsRoot, decision, proposal, now }) {
  if (!decision) return null;
  return updateDecision({
    runsRoot,
    decisionId: decision.decisionId,
    expectedRevision: decision.revision,
    now,
    update: (record) => ({
      ...record,
      evidence: {
        ...record.evidence,
        repairProposal: {
          planId: proposal.plan.planId,
          planFingerprint: proposal.plan.planFingerprint,
          revision: proposal.plan.revision,
          nodeId: proposal.repairNode.nodeId,
          cycle: proposal.cycle,
          allowedPaths: proposal.allowedPaths,
          verification: proposal.verification,
          parentPlanId: proposal.plan.repair.parentPlanId,
          parentPlanFingerprint: proposal.plan.repair.parentPlanFingerprint,
          sourceRunIds: proposal.plan.repair.sourceRunIds,
          commitHashes: proposal.plan.repair.commitHashes,
        },
      },
    }),
  });
}

export function proposeIntegrationRepair({ runsRoot, objectiveId, orchestrationId = null, now = new Date() } = {}) {
  const contextValue = context({ runsRoot, objectiveId, orchestrationId });
  const evidence = getIntegrationEvidence({ runsRoot, orchestrationId: contextValue.orchestration.orchestrationId });
  if (!evidence || evidence.status !== "BLOCKED") {
    fail("Targeted repair membutuhkan blocked integration evidence.", {
      code: "INTEGRATION_EVIDENCE_NOT_BLOCKED",
      details: { code: "INTEGRATION_EVIDENCE_NOT_BLOCKED", orchestrationId: contextValue.orchestration.orchestrationId },
    });
  }
  const classification = classifyIntegrationFailure({ evidence });
  if (classification.classification !== "PRODUCT") {
    fail("Kegagalan integration diklasifikasikan sebagai infrastructure; gunakan safe retry.", {
      code: "INTEGRATION_REPAIR_NOT_APPLICABLE",
      details: { code: "INTEGRATION_REPAIR_NOT_APPLICABLE", classification },
    });
  }
  if (contextValue.objective.activePlanId !== contextValue.plan.planId) {
    fail("Integration evidence berasal dari plan yang sudah tidak aktif.", {
      statusCode: 409,
      code: "STALE_INTEGRATION_PLAN",
      details: { code: "STALE_INTEGRATION_PLAN", activePlanId: contextValue.objective.activePlanId, planId: contextValue.plan.planId },
    });
  }
  const proposal = repairCandidate({ objective: contextValue.objective, plan: contextValue.plan, evidence, now });
  const revision = createPlanRevision({ runsRoot, objectiveId: contextValue.objective.objectiveId, candidate: proposal.candidate, now });
  const blockerId = contextValue.orchestration.integration?.blockerDecisionId ?? `decision-integration-${contextValue.orchestration.orchestrationId}`;
  const blocker = getDecision(runsRoot, blockerId);
  const decision = attachRepairProposal({ runsRoot, decision: blocker, proposal: { ...proposal, plan: revision.plan }, now });
  return {
    action: "INTEGRATION_REPAIR_PROPOSED",
    classification,
    objective: revision.objective,
    previousPlan: revision.previousPlan,
    plan: revision.plan,
    repairNode: proposal.repairNode,
    decision,
    evidence,
    nextAction: "Review and approve the repair plan revision before materialization.",
  };
}

export function recoverIntegration({ runsRoot, objectiveId, orchestrationId = null, now = new Date() } = {}) {
  const contextValue = context({ runsRoot, objectiveId, orchestrationId });
  const evidence = getIntegrationEvidence({ runsRoot, orchestrationId: contextValue.orchestration.orchestrationId });
  if (!evidence || evidence.status !== "BLOCKED") {
    fail("Integration recovery membutuhkan blocked integration evidence.", {
      code: "INTEGRATION_EVIDENCE_NOT_BLOCKED",
      details: { code: "INTEGRATION_EVIDENCE_NOT_BLOCKED", orchestrationId: contextValue.orchestration.orchestrationId },
    });
  }
  const classification = classifyIntegrationFailure({ evidence });
  if (classification.classification === "INFRASTRUCTURE") {
    return {
      action: "INTEGRATION_SAFE_RETRY_RECOMMENDED",
      classification,
      objective: contextValue.objective,
      plan: contextValue.plan,
      orchestration: contextValue.orchestration,
      evidence,
      decision: contextValue.orchestration.integration?.blockerDecisionId
        ? getDecision(runsRoot, contextValue.orchestration.integration.blockerDecisionId)
        : null,
      nextAction: "Resolve the integration blocker with RETRY, then rerun the approved integration verification.",
    };
  }
  return proposeIntegrationRepair({ runsRoot, objectiveId, orchestrationId: contextValue.orchestration.orchestrationId, now });
}

export async function startIntegration({ runsRoot, vaultRoot, objectiveId, orchestrationId = null, integrationNodeId = null, verificationRunner = null, processRunner = null, devServerManager = globalDevServerManager, now = new Date() } = {}) {
  if (!runsRoot || !vaultRoot || !objectiveId) fail("Integration membutuhkan runsRoot, vaultRoot, dan objectiveId.", { code: "INTEGRATION_ARGUMENTS_REQUIRED" });
  const prepared = withDurableLease({ runsRoot, ...INTEGRATION_LEASE, key: orchestrationId ?? objectiveId }, () => {
    const contextValue = context({ runsRoot, objectiveId, orchestrationId });
    if (contextValue.plan.integration?.required !== true) return { action: "INTEGRATION_NOT_REQUIRED", ...contextValue };
    if (contextValue.orchestration.integration?.state === "PASSED") return { action: "INTEGRATION_ALREADY_COMPLETED", ...contextValue };
    if (contextValue.orchestration.integration?.state === "RUNNING") return { action: "INTEGRATION_IN_PROGRESS", ...contextValue };
    const source = sourceNodes(contextValue.plan, integrationNodeId);
    if (source.nodes.length === 0) fail("Integration membutuhkan sedikitnya satu predecessor node.", { code: "INTEGRATION_SOURCE_NODES_EMPTY", details: { code: "INTEGRATION_SOURCE_NODES_EMPTY" } });
    const notDone = source.nodes.filter((node) => contextValue.orchestration.nodes[node.nodeId]?.state !== "DONE").map((node) => ({ nodeId: node.nodeId, state: contextValue.orchestration.nodes[node.nodeId]?.state ?? null }));
    if (notDone.length) fail("Integration belum boleh dimulai sebelum seluruh predecessor DONE.", { code: "INTEGRATION_PREDECESSORS_NOT_DONE", details: { code: "INTEGRATION_PREDECESSORS_NOT_DONE", nodes: notDone } });
    const updated = updateOrchestration({
      runsRoot,
      orchestrationId: contextValue.orchestration.orchestrationId,
      expectedRevision: contextValue.orchestration.revision,
      now,
      update: (record) => ({ ...record, state: "INTEGRATING", integration: { ...(record.integration ?? {}), state: "RUNNING", sourceNodeIds: source.nodes.map((node) => node.nodeId), startedAt: iso(now), verification: [], artifacts: record.integration?.artifacts ?? [] } }),
      validationOptions: { plan: contextValue.plan },
    });
    return { action: "INTEGRATION_STARTED", contextValue: { ...contextValue, orchestration: updated }, source };
  });
  if (["INTEGRATION_NOT_REQUIRED", "INTEGRATION_ALREADY_COMPLETED", "INTEGRATION_IN_PROGRESS"].includes(prepared.action)) return prepared;

  const { contextValue, source } = prepared;
  const jobs = listJobs(runsRoot);
  const runs = listRuns(runsRoot);
  const sourceEvidence = sourceRunEvidence({ runsRoot, jobs, runs, orchestration: contextValue.orchestration, nodes: source.nodes });
  const projects = listProjects(vaultRoot).projects.filter((project) => contextValue.plan.projects.includes(project.id));
  const requests = verificationRequests({ plan: contextValue.plan, projects });
  const crossRequests = crossProjectVerificationRequests({ plan: contextValue.plan, projects });
  const verification = [];
  const services = [];
  const startedServices = [];
  const serviceUrls = {};
  const projectBaselines = Object.fromEntries(projects.map((project) => [project.id, baseline(project.repository)]));
  try {
    if (needsLocalServices({ plan: contextValue.plan, requests: crossRequests })) {
      for (const project of requestedServiceProjectIds({ plan: contextValue.plan, projects })) {
        const scripts = getPackageScripts(project.repository);
        const serviceRunId = `integration-${contextValue.orchestration.orchestrationId}-${project.id}`;
        if (!scripts.dev) {
          services.push({ projectId: project.id, status: "FAIL", host: "127.0.0.1", port: null, url: null, error: "Approved local service requires a dev script in package.json." });
          continue;
        }
        try {
          const started = await devServerManager.startDevServer({ runsRoot, runId: serviceRunId, projectId: project.id, repository: project.repository, host: "127.0.0.1" });
          services.push({ projectId: project.id, status: "PASS", host: started.host ?? "127.0.0.1", port: started.port, url: started.url, startedAt: started.startedAt });
          serviceUrls[project.id] = started.url;
          startedServices.push(serviceRunId);
        } catch (error) {
          services.push({ projectId: project.id, status: "FAIL", host: "127.0.0.1", port: null, url: null, error: error.message });
        }
      }
      for (const service of services.filter((item) => item.status !== "PASS")) {
        verification.push({ projectId: service.projectId, script: "dev", scope: "CROSS_PROJECT", command: "npm run dev", serviceUrls, exitCode: 1, status: "FAIL", error: service.error });
      }
    }
    if (!requests.length) verification.push({ projectId: null, script: null, scope: "PROJECT", command: null, exitCode: null, status: "FAIL", error: "No approved project verification script is configured." });
    for (const request of requests) {
      const project = projects.find((candidate) => candidate.id === request.projectId);
      const scripts = project ? getPackageScripts(project.repository) : {};
      if (!project || !scripts[request.script]) {
        verification.push({ ...request, scope: "PROJECT", command: `npm run ${request.script}`, exitCode: null, status: "FAIL", error: "Verification script is not available in the approved project package scripts." });
        continue;
      }
      try {
        verification.push(await runApprovedVerification({ project, script: request.script, scope: "PROJECT", verificationRunner: verificationRunner ?? processRunner, serviceUrls }));
      } catch (error) {
        verification.push({ ...request, scope: "PROJECT", command: `npm run ${request.script}`, exitCode: null, status: "FAIL", error: error.message });
      }
    }
    if (!crossRequests.length && contextValue.objective.mode === "CROSS_PROJECT_INCIDENT") {
      verification.push({ projectId: null, script: null, scope: "CROSS_PROJECT", command: null, exitCode: 1, status: "FAIL", error: "No approved cross-project verification script is configured." });
    }
    for (const request of crossRequests) {
      const project = projects.find((candidate) => candidate.id === request.projectId);
      const scripts = project ? getPackageScripts(project.repository) : {};
      if (!project || !scripts[request.script]) {
        verification.push({ ...request, command: `npm run ${request.script}`, serviceUrls, exitCode: null, status: "FAIL", error: "Cross-project verification script is not available in the approved project package scripts." });
        continue;
      }
      try {
        verification.push(await runApprovedVerification({ project, script: request.script, scope: "CROSS_PROJECT", verificationRunner: verificationRunner ?? processRunner, serviceUrls }));
      } catch (error) {
        verification.push({ ...request, command: `npm run ${request.script}`, serviceUrls, exitCode: null, status: "FAIL", error: error.message });
      }
    }
    const acceptance = repositoryAcceptance({ projects, sourceRuns: sourceEvidence.sourceRuns, verification });
    for (const item of acceptance) item.baseline = projectBaselines[item.projectId] ?? null;
    const artifactFile = artifactPath(runsRoot, contextValue.orchestration.orchestrationId);
    const artifact = buildIntegrationEvidence({
      objective: contextValue.objective,
      plan: contextValue.plan,
      orchestration: contextValue.orchestration,
      sourceRuns: sourceEvidence.sourceRuns.map((item) => ({ ...item, run: item.run, allowedPaths: item.allowedPaths })),
      verification,
      artifactPath: artifactFile,
      projectBaselines,
      services,
      repositoryAcceptance: acceptance,
    });
    artifact.sourceErrors = sourceEvidence.errors;
    return finalizeIntegration({ runsRoot, contextValue, artifact, verification, sourceErrors: sourceEvidence.errors, now });
  } finally {
    for (const serviceRunId of startedServices.reverse()) {
      try { devServerManager.stopDevServer(serviceRunId); } catch {}
    }
  }
}

function aggregateSourcePatches({ source, sourceEvidence, plan, projectId }) {
  const byNode = new Map(sourceEvidence.sourceRuns.map((item) => [item.nodeId, item]));
  const sourceIds = new Set(source.nodes.filter((node) => node.projectId === projectId).map((node) => node.nodeId));
  const ordered = topologicalOrder(plan.nodes).filter((nodeId) => sourceIds.has(nodeId));
  return ordered.map((nodeId) => {
    const item = byNode.get(nodeId);
    const commit = item?.commit;
    const parentCommit = commit?.parentCommit ?? item?.run?.execution?.workspace?.baseCommit ?? null;
    if (!item?.run?.runId || !commit?.commitHash || !parentCommit) {
      fail(`Patch aggregate untuk node ${nodeId} belum memiliki provenance Git lengkap.`, {
        code: "INTEGRATION_PATCH_PROVENANCE_MISSING",
        details: { nodeId, runId: item?.run?.runId ?? null, commitHash: commit?.commitHash ?? null, parentCommit },
      });
    }
    return {
      nodeId,
      runId: item.run.runId,
      commitHash: commit.commitHash,
      parentCommit,
      changedPaths: item.changedPaths,
    };
  });
}

export async function prepareAggregateIntegration({
  runsRoot,
  vaultRoot,
  objectiveId,
  orchestrationId = null,
  projectId = null,
  verificationRunner = null,
  now = new Date(),
} = {}) {
  if (!runsRoot || !vaultRoot || !objectiveId) fail("Aggregate integration membutuhkan runsRoot, vaultRoot, dan objectiveId.", { code: "INTEGRATION_ARGUMENTS_REQUIRED" });
  const contextValue = context({ runsRoot, objectiveId, orchestrationId });
  const source = sourceNodes(contextValue.plan);
  const sourceProjects = [...new Set(source.nodes.map((node) => node.projectId))];
  const targetProjectId = projectId ?? sourceProjects[0];
  if (!targetProjectId || sourceProjects.some((candidate) => candidate !== targetProjectId)) {
    fail("Aggregate integration V2-052 hanya menerima source patches dari satu project.", {
      code: "INTEGRATION_AGGREGATE_ONE_PROJECT_REQUIRED",
      details: { sourceProjects, projectId: targetProjectId },
    });
  }
  const project = listProjects(vaultRoot).projects.find((candidate) => candidate.id === targetProjectId);
  if (!project) fail(`Project aggregate tidak ditemukan: ${targetProjectId}`, { code: "PROJECT_NOT_FOUND", details: { projectId: targetProjectId } });
  const jobs = listJobs(runsRoot);
  const runs = listRuns(runsRoot);
  const sourceEvidence = sourceRunEvidence({ runsRoot, jobs, runs, orchestration: contextValue.orchestration, nodes: source.nodes });
  if (sourceEvidence.errors.length) {
    fail("Aggregate integration membutuhkan seluruh source run DONE dengan provenance lengkap.", {
      code: "INTEGRATION_SOURCE_EVIDENCE_INCOMPLETE",
      details: { sourceErrors: sourceEvidence.errors },
    });
  }
  const patches = aggregateSourcePatches({ source, sourceEvidence, plan: contextValue.plan, projectId: targetProjectId });
  const firstSource = sourceEvidence.sourceRuns.find((item) => item.projectId === targetProjectId);
  const baseCommit = firstSource?.run?.execution?.workspace?.baseCommit ?? patches[0]?.parentCommit ?? null;
  const workspace = prepareIntegrationWorkspace({
    runsRoot,
    orchestrationId: contextValue.orchestration.orchestrationId,
    projectId: targetProjectId,
    sourceRepository: project.repository,
    baseCommit,
    objectiveId: contextValue.objective.objectiveId,
    planId: contextValue.plan.planId,
  });
  let applied;
  try {
    applied = applyIntegrationPatches({
      workspace,
      patches,
      allowedPaths: contextValue.plan.nodes.filter((node) => node.projectId === targetProjectId).flatMap((node) => node.allowedPaths ?? []),
    });
  } catch (error) {
    throw error;
  }

  const requests = verificationRequests({ plan: contextValue.plan, projects: [{ ...project, repository: applied.workspacePath }] });
  const verification = [];
  for (const request of requests) {
    try {
      verification.push(await runApprovedVerification({
        project: { ...project, repository: applied.workspacePath },
        script: request.script,
        verificationRunner,
      }));
    } catch (error) {
      verification.push({ ...request, command: `npm run ${request.script}`, exitCode: null, status: "FAIL", error: error.message });
    }
  }
  const artifactFile = artifactPath(runsRoot, contextValue.orchestration.orchestrationId);
  const artifact = buildIntegrationEvidence({
    objective: contextValue.objective,
    plan: contextValue.plan,
    orchestration: contextValue.orchestration,
    sourceRuns: sourceEvidence.sourceRuns,
    verification,
    artifactPath: artifactFile,
  });
  artifact.aggregateWorkspace = {
    path: path.relative(runsRoot, applied.workspacePath).split(path.sep).join("/"),
    baseCommit: applied.baseCommit,
    state: applied.state,
    objectiveId: contextValue.objective.objectiveId,
    planId: contextValue.plan.planId,
    patchRunIds: patches.map((patch) => patch.runId),
    changedPaths: applied.changedPaths,
    previewPath: applied.aggregateDiffPath
      ? path.relative(runsRoot, applied.aggregateDiffPath).split(path.sep).join("/")
      : null,
  };
  artifact.projectBaselines = { [targetProjectId]: applied.frozenSourceHead };
  artifact.status = verification.every((result) => result.status === "PASS") ? "READY_FOR_ACCEPTANCE" : "BLOCKED";
  let finalWorkspace = applied;
  if (artifact.status === "BLOCKED") {
    const rolledBack = rollbackIntegrationWorkspace({ workspace: applied, reason: "Aggregate verification failed." });
    artifact.aggregateWorkspace.state = rolledBack.state;
    artifact.aggregateWorkspace.rollbackPath = rolledBack.rollbackArtifactPath
      ? path.relative(runsRoot, rolledBack.rollbackArtifactPath).split(path.sep).join("/")
      : null;
    finalWorkspace = rolledBack;
  }
  writeJsonAtomic(artifactFile, { ...artifact, generatedAt: iso(now) });
  return {
    action: artifact.status === "READY_FOR_ACCEPTANCE" ? "AGGREGATE_INTEGRATION_READY" : "AGGREGATE_INTEGRATION_BLOCKED",
    workspace: finalWorkspace,
    evidence: artifact,
    sourceRuns: sourceEvidence.sourceRuns,
    verification,
  };
}

export { applyIntegrationPatches, cleanupIntegrationWorkspace, prepareIntegrationWorkspace, rollbackIntegrationWorkspace };

export function getIntegrationEvidence({ runsRoot, orchestrationId } = {}) {
  const filePath = artifactPath(runsRoot, orchestrationId);
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) { fail(`Aggregate evidence corrupt: ${error.message}`, { code: "INTEGRATION_EVIDENCE_CORRUPT", details: { code: "INTEGRATION_EVIDENCE_CORRUPT", filePath } }); }
}
