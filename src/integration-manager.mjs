import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { listProjects, getPackageScripts } from "./core.mjs";
import { createDecision, getDecision } from "./decision-store.mjs";
import { getObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration, updateOrchestration } from "./orchestration-store.mjs";
import { listJobs } from "./job-queue.mjs";
import { listRuns, RUN_STATES } from "./run-manager.mjs";
import { buildIntegrationEvidence, buildRunEvidence } from "./interaction.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { runProcess } from "./executor.mjs";

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
    sourceRuns.push({ nodeId: node.nodeId, allowedPaths: node.allowedPaths ?? [], job, run, evidence, commit });
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

async function runApprovedVerification({ project, script, verificationRunner }) {
  const command = `npm run ${script}`;
  if (verificationRunner) {
    const response = await verificationRunner({ project, projectId: project.id, script, command, cwd: project.repository });
    return { projectId: project.id, script, command, ...(response ?? {}), exitCode: response?.exitCode ?? null, status: response?.exitCode === 0 ? "PASS" : "FAIL" };
  }
  const response = await runProcess({
    command: "npm",
    args: ["run", script],
    cwd: project.repository,
    stage: "verification",
    writableRoots: [project.repository],
    readableRoots: [project.repository],
  });
  return { projectId: project.id, script, command, ...response, status: response.exitCode === 0 ? "PASS" : "FAIL" };
}

function baseline(repository) {
  try { return execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null; } catch { return null; }
}

function blockerDecision({ runsRoot, objective, orchestration, sourceRuns, sourceErrors, verification, evidence, now }) {
  const decisionId = `decision-integration-${orchestration.orchestrationId}`;
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
        aggregateEvidence: evidence,
      },
      requestedAction: "Resolve failed orchestration integration after reviewing aggregate evidence.",
      allowedChoices: ["RETRY", "SCOPE_EXPANSION", "CANCEL"],
      creator: "SYSTEM",
      createdAt: iso(now),
      resolution: null,
    },
  });
}

function finalizeIntegration({ runsRoot, contextValue, artifact, verification, sourceErrors, now }) {
  return withDurableLease({ runsRoot, ...INTEGRATION_LEASE, key: contextValue.orchestration.orchestrationId }, () => {
    const current = getOrchestration(runsRoot, contextValue.orchestration.orchestrationId);
    const failed = sourceErrors.length > 0 || artifact.complete !== true || artifact.scope.changedPathsWithinUnion !== true || artifact.verification.status !== "PASS";
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
      update: (record) => ({ ...record, state: failed ? "BLOCKED" : "DONE", integration: nextIntegration }),
      validationOptions: { plan: contextValue.plan },
    });
    const persistedArtifact = { ...artifact, status: failed ? "BLOCKED" : "PASSED", blockerDecisionId: decision?.decisionId ?? null, completedAt: iso(now) };
    writeJsonAtomic(artifact.artifactPath, persistedArtifact);
    return { action: failed ? "INTEGRATION_BLOCKED" : "INTEGRATION_COMPLETED", integration: updated.integration, orchestration: updated, evidence: persistedArtifact, decision };
  });
}

export async function startIntegration({ runsRoot, vaultRoot, objectiveId, orchestrationId = null, integrationNodeId = null, verificationRunner = null, processRunner = null, now = new Date() } = {}) {
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
  const verification = [];
  if (!requests.length) verification.push({ projectId: null, script: null, command: null, exitCode: null, status: "FAIL", error: "No approved project verification script is configured." });
  for (const request of requests) {
    const project = projects.find((candidate) => candidate.id === request.projectId);
    const scripts = project ? getPackageScripts(project.repository) : {};
    if (!project || !scripts[request.script]) {
      verification.push({ ...request, command: `npm run ${request.script}`, exitCode: null, status: "FAIL", error: "Verification script is not available in the approved project package scripts." });
      continue;
    }
    try {
      verification.push(await runApprovedVerification({ project, script: request.script, verificationRunner: verificationRunner ?? processRunner }));
    } catch (error) {
      verification.push({ ...request, command: `npm run ${request.script}`, exitCode: null, status: "FAIL", error: error.message });
    }
  }
  const artifactFile = artifactPath(runsRoot, contextValue.orchestration.orchestrationId);
  const artifact = buildIntegrationEvidence({
    objective: contextValue.objective,
    plan: contextValue.plan,
    orchestration: contextValue.orchestration,
    sourceRuns: sourceEvidence.sourceRuns.map((item) => ({ ...item, run: item.run, allowedPaths: item.allowedPaths })),
    verification,
    artifactPath: artifactFile,
  });
  artifact.projectBaselines = Object.fromEntries(projects.map((project) => [project.id, baseline(project.repository)]));
  return finalizeIntegration({ runsRoot, contextValue, artifact, verification, sourceErrors: sourceEvidence.errors, now });
}

export function getIntegrationEvidence({ runsRoot, orchestrationId } = {}) {
  const filePath = artifactPath(runsRoot, orchestrationId);
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) { fail(`Aggregate evidence corrupt: ${error.message}`, { code: "INTEGRATION_EVIDENCE_CORRUPT", details: { code: "INTEGRATION_EVIDENCE_CORRUPT", filePath } }); }
}
