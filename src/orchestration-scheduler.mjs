import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { listProjects } from "./core.mjs";
import { getObjective, updateObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { createDecision, getDecision, updateDecision } from "./decision-store.mjs";
import { getOrchestration, listOrchestrations, updateOrchestration } from "./orchestration-store.mjs";
import { enqueueTaskJob, JOB_STATES, listJobs, sameProjectParallelEnabled, updateJob } from "./job-queue.mjs";
import { detectWriteConflicts, topologicalOrder } from "./task-graph.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { classifyIntegrationFailure, getIntegrationEvidence } from "./integration-manager.mjs";
import { budgetSnapshot, ensureBudgetExceededDecision, resolveBudgetExceededDecision } from "./orchestration-budget.mjs";
import { parallelObjectivesEnabled } from "./rollout-flags.mjs";
import { resetOrchestrationTaskToBacklog } from "./run-manager.mjs";
import { finalAcceptOnlyEnabled } from "./approval-policy.mjs";

const ACTIVE_NODE_STATES = new Set(["QUEUED", "RUNNING", "REVIEW"]);
const TERMINAL_NODE_STATES = new Set(["DONE", "FAILED", "CANCELLED"]);
const TERMINAL_ORCHESTRATION_STATES = new Set(["DONE", "FAILED", "CANCELLED"]);
const DEFAULT_GLOBAL_PARALLEL_JOBS = 2;
const MAX_GLOBAL_PARALLEL_JOBS = 8;

export class OrchestrationSchedulerError extends Error {
  constructor(message, { statusCode = 409, code = "ORCHESTRATION_SCHEDULER_ERROR", details = null } = {}) {
    super(message);
    this.name = "OrchestrationSchedulerError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new OrchestrationSchedulerError(message, options);
}

export function orchestrationSchedulerEnabled(env = process.env) {
  return ["1", "true", "on"].includes(String(env.ORCHESTRATOR_OBJECTIVE_SCHEDULER ?? "0").trim().toLowerCase());
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function configuredGlobalParallelJobs(env = process.env) {
  const raw = env.ORCHESTRATOR_MAX_PARALLEL_JOBS;
  if (raw === undefined || raw === "") return DEFAULT_GLOBAL_PARALLEL_JOBS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_GLOBAL_PARALLEL_JOBS) {
    fail(`ORCHESTRATOR_MAX_PARALLEL_JOBS harus integer antara 1 dan ${MAX_GLOBAL_PARALLEL_JOBS}.`, {
      code: "INVALID_GLOBAL_PARALLEL_CEILING",
      details: { code: "INVALID_GLOBAL_PARALLEL_CEILING", value: raw },
    });
  }
  return value;
}

function gitOutput(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sourceBaseline(repository) {
  const status = gitOutput(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    repository,
    baseCommit: gitOutput(repository, ["rev-parse", "HEAD"]),
    frozenSourceStatus: status,
    frozenSourceStatusHash: createHash("sha256").update(status).digest("hex"),
  };
}

function sameProjectParallelProjects(plan) {
  if (plan.integration?.required !== true) return [];
  const counts = new Map();
  for (const node of plan.nodes) {
    if (node.canRunInParallel !== true) continue;
    counts.set(node.projectId, (counts.get(node.projectId) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([projectId]) => projectId).sort();
}

function completedSiblingBaselineDrift({ runsRoot, orchestration, projectId }) {
  const tasks = materializedTaskMap(orchestration);
  const siblingJobs = listJobs(runsRoot).filter((job) => (
    job.orchestrationId === orchestration.orchestrationId
    && tasks.get(job.nodeId)?.projectId === projectId
  ));
  return siblingJobs.length > 0
    && siblingJobs.every((job) => job.state === JOB_STATES.DONE)
    && siblingJobs.some((job) => job.state === JOB_STATES.DONE);
}

function freezeSameProjectBaselines({ vaultRoot, runsRoot, plan, orchestration, now }) {
  const projectIds = sameProjectParallelProjects(plan);
  if (!projectIds.length) return { orchestration, active: false, projectIds: [], allowFrozenBaselineDrift: false };
  if (!vaultRoot) {
    fail("Same-project parallel membutuhkan vaultRoot untuk membekukan repository baseline.", {
      code: "SAME_PROJECT_BASELINE_ROOT_REQUIRED",
      details: { code: "SAME_PROJECT_BASELINE_ROOT_REQUIRED" },
    });
  }
  const projects = listProjects(vaultRoot).projects;
  const existing = orchestration.integration?.projectBaselines ?? {};
  const existingDrift = orchestration.integration?.sameProjectParallel?.expectedBaselineDrift ?? null;
  const baselines = { ...existing };
  let changed = false;
  let allowFrozenBaselineDrift = false;
  let allowedCurrentCommit = null;
  let expectedBaselineDrift = null;
  for (const projectId of projectIds) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) fail(`Project baseline tidak ditemukan: ${projectId}`, { code: "SAME_PROJECT_PROJECT_NOT_FOUND", details: { projectId } });
    let current;
    try {
      current = sourceBaseline(project.repository);
    } catch (error) {
      fail(`Repository baseline tidak dapat dibekukan untuk ${projectId}: ${error.message}`, { code: "SAME_PROJECT_BASELINE_UNAVAILABLE", details: { projectId } });
    }
    if (current.frozenSourceStatus) {
      fail(`Repository ${projectId} harus clean sebelum same-project parallel diaktifkan.`, {
        code: "SAME_PROJECT_BASELINE_DIRTY",
        details: { projectId, statusHash: current.frozenSourceStatusHash },
      });
    }
    const previous = baselines[projectId];
    if (previous && typeof previous === "object") {
      if (previous.baseCommit !== current.baseCommit || previous.frozenSourceStatusHash !== current.frozenSourceStatusHash) {
        const sameRecordedDrift = existingDrift?.projectId === projectId
          && existingDrift.currentBaseCommit === current.baseCommit
          && existingDrift.currentSourceStatusHash === current.frozenSourceStatusHash;
        if (sameRecordedDrift || completedSiblingBaselineDrift({ runsRoot, orchestration, projectId })) {
          allowFrozenBaselineDrift = true;
          allowedCurrentCommit = current.baseCommit;
          expectedBaselineDrift = {
            projectId,
            currentBaseCommit: current.baseCommit,
            currentSourceStatusHash: current.frozenSourceStatusHash,
            observedAt: new Date(now).toISOString(),
          };
          if (!sameRecordedDrift) changed = true;
          continue;
        }
        fail(`Frozen baseline berubah untuk project ${projectId}.`, {
          code: "SAME_PROJECT_BASELINE_DRIFT",
          details: { projectId, frozenBaseCommit: previous.baseCommit, currentBaseCommit: current.baseCommit },
        });
      }
      continue;
    }
    baselines[projectId] = { ...current, frozenAt: new Date(now).toISOString() };
    changed = true;
  }
  if (!changed && orchestration.integration?.sameProjectParallel?.enabled === true) {
    return { orchestration, active: true, projectIds, allowFrozenBaselineDrift, allowedCurrentCommit };
  }
  const updated = updateOrchestration({
    runsRoot,
    orchestrationId: orchestration.orchestrationId,
    expectedRevision: orchestration.revision,
    now,
    update: (record) => ({
      ...record,
      integration: {
        ...(record.integration ?? {}),
        projectBaselines: baselines,
        sameProjectParallel: {
          enabled: true,
          activatedAt: record.integration?.sameProjectParallel?.activatedAt ?? new Date(now).toISOString(),
          ...(expectedBaselineDrift ? { expectedBaselineDrift } : {}),
        },
      },
    }),
    validationOptions: { plan },
  });
  return { orchestration: updated, active: true, projectIds, allowFrozenBaselineDrift, allowedCurrentCommit };
}

function planOptions(objective) {
  return {
    knownProjectIds: objective.projectIds,
    projectIds: objective.projectIds,
    budget: objective.budget,
  };
}

function nodeIdFromJob(job) {
  return job?.nodeId ?? job?.orchestration?.nodeId ?? null;
}

function orchestrationIdFromJob(job) {
  return job?.orchestrationId ?? job?.orchestration?.orchestrationId ?? null;
}

function jobsByNode(jobs, orchestrationId) {
  const result = new Map();
  for (const job of jobs) {
    if (orchestrationIdFromJob(job) !== orchestrationId) continue;
    const nodeId = nodeIdFromJob(job);
    if (!nodeId) continue;
    const entries = result.get(nodeId) ?? [];
    entries.push(job);
    entries.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    result.set(nodeId, entries);
  }
  return result;
}

function jobToNodeState(job) {
  if (!job) return null;
  if (job.state === JOB_STATES.QUEUED) return "QUEUED";
  if (job.state === JOB_STATES.RUNNING) return "RUNNING";
  if (job.state === JOB_STATES.REVIEW) return "REVIEW";
  if (job.state === JOB_STATES.DONE) return "DONE";
  if (job.state === JOB_STATES.FAILED) return "FAILED";
  if (job.state === JOB_STATES.CANCELLED) return "CANCELLED";
  return null;
}

function taskIdFor(runtimeNode) {
  return runtimeNode?.taskId ?? null;
}

function dependencyFailure(node, runtimeNodes) {
  return node.dependsOn
    .map((dependency) => ({ dependency, runtime: runtimeNodes[dependency] }))
    .filter(({ runtime }) => ["FAILED", "BLOCKED", "CANCELLED"].includes(runtime?.state));
}

function reconcileRuntimeNodes({ plan, orchestration, jobs }) {
  const nextNodes = structuredClone(orchestration.nodes);
  const jobsForNode = jobsByNode(jobs, orchestration.orchestrationId);
  const ordered = topologicalOrder(plan.nodes);
  let changed = false;

  for (const nodeId of ordered) {
    const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    const current = nextNodes[nodeId];
    if (!current) fail(`Runtime orchestration kehilangan node ${nodeId}.`, { code: "ORCHESTRATION_NODE_MISSING", details: { code: "ORCHESTRATION_NODE_MISSING", nodeId } });
    const currentAttempt = Number(current.attempt ?? 1);
    const job = (jobsForNode.get(nodeId) ?? []).find((candidate) => Number(candidate.attempt ?? 1) === currentAttempt) ?? null;
    const jobState = jobToNodeState(job);
    if (jobState && current.state !== jobState) {
      current.state = jobState;
      current.lastError = jobState === "FAILED" ? (job.error || { code: "NODE_JOB_FAILED" }) : null;
      changed = true;
    } else if (!job && current.state === "QUEUED") {
      current.state = "READY";
      current.jobId = null;
      current.lastError = null;
      changed = true;
    } else if (!job && ["RUNNING", "REVIEW"].includes(current.state)) {
      current.state = "BLOCKED";
      current.lastError = { code: "MISSING_NODE_JOB", message: "Job hilang saat node berada dalam state aktif; scheduler tidak mengulang pekerjaan yang statusnya tidak pasti." };
      changed = true;
    }
    if (job && current.jobId !== job.jobId) {
      current.jobId = job.jobId;
      changed = true;
    }

    const failures = dependencyFailure(node, nextNodes);
    if (TERMINAL_NODE_STATES.has(current.state)) continue;
    if (failures.length) {
      const blockedBy = failures.map(({ dependency }) => taskIdFor(nextNodes[dependency])).filter(Boolean);
      const nextError = { code: "PREDECESSOR_FAILED", dependencies: blockedBy };
      if (current.state !== "BLOCKED" || JSON.stringify(current.lastError) !== JSON.stringify(nextError)) {
        current.state = "BLOCKED";
        current.blockedBy = blockedBy;
        current.lastError = nextError;
        changed = true;
      }
      continue;
    }
    if (current.state === "BLOCKED" && (!current.lastError || current.lastError.code === "PREDECESSOR_FAILED") && node.dependsOn.every((dependency) => nextNodes[dependency]?.state === "DONE")) {
      current.state = "READY";
      current.blockedBy = [];
      current.lastError = null;
      changed = true;
    }
  }

  return { nodes: nextNodes, changed };
}

function orchestrationState(nodes, currentState) {
  const states = Object.values(nodes).map((node) => node.state);
  if (states.length > 0 && states.every((state) => state === "DONE")) return "DONE";
  if (states.some((state) => ACTIVE_NODE_STATES.has(state))) return "RUNNING";
  if (states.some((state) => state === "READY")) return "RUNNING";
  if (states.some((state) => state === "FAILED") || Object.values(nodes).some((node) => node.state === "BLOCKED" && node.lastError)) return "BLOCKED";
  return currentState === "CREATED" ? "CREATED" : "RUNNING";
}

function approvalMetadata({ objective, plan, orchestrationId }) {
  const decisionId = `decision-plan-approval-${plan.planId}`;
  const decision = getDecision(objective.runsRoot, decisionId);
  if (!decision || decision.type !== "PLAN_APPROVAL" || decision.state !== "RESOLVED") {
    fail("Scheduler menolak plan tanpa provenance approval human yang durable.", {
      code: "PLAN_APPROVAL_PROVENANCE_MISSING",
      details: { code: "PLAN_APPROVAL_PROVENANCE_MISSING", planId: plan.planId },
    });
  }
  return {
    objectiveId: objective.objectiveId,
    planId: plan.planId,
    orchestrationId,
    nodeId: null,
    planFingerprint: plan.planFingerprint,
    approvalDecisionId: decision.decisionId,
    approvedBy: plan.approvedBy,
    approvedAt: plan.approvedAt,
  };
}

function materializedTaskMap(orchestration) {
  return new Map((orchestration.materialization?.tasks ?? []).map((task) => [task.nodeId, task]));
}

function queueCandidate({ runsRoot, objective, plan, orchestration, nodeId, task, sameProjectParallel = false, baseline = null, allowFrozenBaselineDrift = false, allowedCurrentCommit = null }) {
  if (!task?.path || !task?.taskId || !task?.projectId) {
    fail(`Materialized task untuk node ${nodeId} tidak lengkap.`, {
      code: "MATERIALIZED_TASK_MISSING",
      details: { code: "MATERIALIZED_TASK_MISSING", nodeId },
    });
  }
  const metadata = {
    ...approvalMetadata({ objective: { ...objective, runsRoot }, plan, orchestrationId: orchestration.orchestrationId }),
    nodeId,
    attempt: orchestration.nodes[nodeId]?.attempt ?? 1,
    sameProjectParallel,
    baseCommit: baseline?.baseCommit ?? null,
    frozenSourceStatus: baseline?.frozenSourceStatus ?? null,
    frozenSourceStatusHash: baseline?.frozenSourceStatusHash ?? null,
    allowFrozenBaselineDrift,
    allowedCurrentCommit,
  };
  const queued = enqueueTaskJob({
    runsRoot,
    projectId: task.projectId,
    taskId: task.taskId,
    taskPath: task.path,
    requestedBy: plan.approvedBy,
    orchestrationManaged: true,
    schedulerAuthorized: true,
    orchestrationMetadata: metadata,
  });
  return { ...queued, metadata };
}

function persistOrchestration({ runsRoot, orchestration, plan, nodes, state, now }) {
  const unchanged = state === orchestration.state && JSON.stringify(nodes) === JSON.stringify(orchestration.nodes);
  const persisted = unchanged
    ? orchestration
    : updateOrchestration({
      runsRoot,
      orchestrationId: orchestration.orchestrationId,
      expectedRevision: orchestration.revision,
      now,
      update: (record) => ({ ...record, nodes, state, updatedAt: nowIso(now) }),
      validationOptions: { plan },
    });
  return persisted;
}

function updateObjectiveState({ runsRoot, objective, orchestration }) {
  if (!objective || objective.activeOrchestrationId !== orchestration.orchestrationId) return objective;
  if (["CANCELLED", "DONE"].includes(objective.state)) return objective;
  let desiredState = null;
  if (orchestration.state === "BLOCKED") desiredState = "BLOCKED";
  else if (orchestration.state === "RUNNING") desiredState = "RUNNING";
  else if (orchestration.state === "INTEGRATING") desiredState = "INTEGRATING";
  else if (orchestration.state === "DONE") desiredState = "RESULT_REVIEW";
  else if (orchestration.state === "FAILED") desiredState = "FAILED";
  else if (orchestration.state === "CANCELLED") desiredState = "CANCELLED";

  if (!desiredState || objective.state === desiredState) return objective;
  return updateObjective({
    runsRoot,
    objectiveId: objective.objectiveId,
    expectedRevision: objective.revision,
    update: (record) => ({ ...record, state: desiredState }),
  });
}

function orchestrationContext({ runsRoot, objectiveId = null, orchestrationId = null }) {
  const objective = objectiveId ? getObjective(runsRoot, objectiveId) : null;
  const directOrchestration = orchestrationId ? getOrchestration(runsRoot, orchestrationId) : null;
  const resolvedObjective = objective ?? (directOrchestration ? getObjective(runsRoot, directOrchestration.objectiveId) : null);
  if (!resolvedObjective) fail("Objective orchestration tidak ditemukan.", { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId, orchestrationId } });
  const resolvedOrchestrationId = orchestrationId ?? resolvedObjective.activeOrchestrationId;
  if (!resolvedOrchestrationId) fail("Objective belum memiliki orchestration aktif.", { code: "ORCHESTRATION_NOT_FOUND", details: { code: "ORCHESTRATION_NOT_FOUND", objectiveId: resolvedObjective.objectiveId } });
  const orchestration = directOrchestration?.orchestrationId === resolvedOrchestrationId
    ? directOrchestration
    : getOrchestration(runsRoot, resolvedOrchestrationId);
  if (!orchestration) fail(`Orchestration tidak ditemukan: ${resolvedOrchestrationId}`, { statusCode: 404, code: "ORCHESTRATION_NOT_FOUND", details: { code: "ORCHESTRATION_NOT_FOUND", orchestrationId: resolvedOrchestrationId } });
  const plan = getPlan(runsRoot, orchestration.planId, planOptions(resolvedObjective));
  if (!plan || plan.objectiveId !== resolvedObjective.objectiveId) fail("Orchestration plan tidak cocok dengan objective.", { code: "PLAN_OBJECTIVE_MISMATCH", details: { code: "PLAN_OBJECTIVE_MISMATCH" } });
  return { objective: resolvedObjective, orchestration, plan };
}

function retryDecisionId(orchestrationId, nodeId, nextAttempt) {
  return `decision-node-retry-${orchestrationId}-${nodeId}-a${nextAttempt}`;
}

export function requestNodeRetry({ runsRoot, objectiveId, orchestrationId = null, nodeId, reason, requestedBy, now = new Date() } = {}) {
  const identity = String(requestedBy ?? "").trim();
  if (!identity) fail("Human retry identity wajib berasal dari operator session.", { statusCode: 403, code: "RETRIER_REQUIRED", details: { code: "RETRIER_REQUIRED" } });
  const requestedNodeId = String(nodeId ?? "").trim();
  if (!requestedNodeId) fail("nodeId wajib diisi untuk retry.", { code: "NODE_ID_REQUIRED", details: { code: "NODE_ID_REQUIRED" } });
  const text = String(reason ?? "").trim();
  if (!text) fail("Alasan retry wajib diisi.", { code: "RETRY_REASON_REQUIRED", details: { code: "RETRY_REASON_REQUIRED" } });
  return withDurableLease({
    runsRoot,
    namespace: "orchestration-scheduler",
    key: "global",
    purpose: "request orchestration node retry",
    ttlMs: 60_000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 2_000,
  }, () => {
    const context = orchestrationContext({ runsRoot, objectiveId, orchestrationId });
    const runtime = context.orchestration.nodes[requestedNodeId];
    if (!runtime) fail(`Node tidak ditemukan: ${requestedNodeId}`, { statusCode: 404, code: "NODE_NOT_FOUND", details: { code: "NODE_NOT_FOUND", nodeId: requestedNodeId } });
    if (runtime.state !== "FAILED") fail(`Retry hanya dapat diminta untuk node FAILED; state saat ini ${runtime.state}.`, { code: "NODE_RETRY_NOT_ALLOWED", details: { code: "NODE_RETRY_NOT_ALLOWED", nodeId: requestedNodeId, state: runtime.state } });
    const retryCount = Math.max(0, Number(runtime.attempt ?? 1) - 1);
    if (retryCount >= context.objective.budget.maxRetriesPerNode) {
      const snapshot = budgetSnapshot({ runsRoot, objective: context.objective, orchestration: context.orchestration, plan: context.plan, now });
      const blocker = ensureBudgetExceededDecision({
        runsRoot,
        objective: context.objective,
        orchestration: context.orchestration,
        plan: context.plan,
        violation: { code: "RETRY_CEILING", field: "maxRetriesPerNode", observed: retryCount, ceiling: context.objective.budget.maxRetriesPerNode, nodeId: requestedNodeId },
        snapshot,
        now,
      });
      fail(`Batas retry node tercapai: ${retryCount}/${context.objective.budget.maxRetriesPerNode}.`, { statusCode: 409, code: "MAX_RETRIES_EXCEEDED", details: { code: "MAX_RETRIES_EXCEEDED", nodeId: requestedNodeId, retryCount, maxRetriesPerNode: context.objective.budget.maxRetriesPerNode, decisionId: blocker.decision.decisionId } });
    }
    const nextAttempt = Number(runtime.attempt ?? 1) + 1;
    const decisionId = retryDecisionId(context.orchestration.orchestrationId, requestedNodeId, nextAttempt);
    const existing = getDecision(runsRoot, decisionId);
    if (existing) return { decision: existing, orchestration: context.orchestration, alreadyRequested: true };
    const decision = createDecision({
      runsRoot,
      record: {
        schemaVersion: 1,
        revision: 0,
        decisionId,
        objectiveId: context.objective.objectiveId,
        nodeId: requestedNodeId,
        runId: runtime.runId ?? null,
        type: "NODE_RETRY",
        state: "OPEN",
        evidence: {
          orchestrationId: context.orchestration.orchestrationId,
          planId: context.plan.planId,
          planFingerprint: context.plan.planFingerprint,
          nodeId: requestedNodeId,
          currentAttempt: runtime.attempt,
          nextAttempt,
          reason: text,
          maxRetriesPerNode: context.objective.budget.maxRetriesPerNode,
        },
        requestedAction: "Retry this failed orchestration node after human review",
        allowedChoices: ["RETRY", "CANCEL"],
        creator: "SYSTEM",
        createdAt: nowIso(now),
        resolution: null,
      },
    });
    return { decision, orchestration: context.orchestration, alreadyRequested: false };
  });
}

function automaticRetrySafe(runtime) {
  const code = String(runtime?.lastError?.code ?? "").toUpperCase();
  const message = String(runtime?.lastError?.message ?? "");
  if (["MISSING_NODE_JOB", "PREDECESSOR_FAILED", "CANCELLATION_REQUESTED"].includes(code)) return false;
  if (/scope|uncertain|stale|out.of.scope|permission/i.test(`${code} ${message}`)) return false;
  return ["NODE_JOB_FAILED", "DEV_SERVER_STARTUP_FAILED", "RUN_FAILED", "VERIFICATION_FAILED", "WORKER_ERROR"].includes(code)
    || /startup|verification|worker|exit code/i.test(`${code} ${message}`);
}

export function automaticNodeRecoveryTick({ vaultRoot, runsRoot, env = process.env, now = new Date() } = {}) {
  if (!finalAcceptOnlyEnabled(env)) return { enabled: false, retried: [], exceptions: [] };
  const retried = [];
  const exceptions = [];
  for (const orchestration of listOrchestrations(runsRoot)) {
    if (!["BLOCKED", "FAILED"].includes(orchestration.state)) continue;
    let context;
    try {
      context = orchestrationContext({ runsRoot, orchestrationId: orchestration.orchestrationId });
    } catch (error) {
      exceptions.push({ orchestrationId: orchestration.orchestrationId, error: error.message });
      continue;
    }
    for (const [nodeId, runtime] of Object.entries(context.orchestration.nodes ?? {})) {
      if (runtime.state !== "FAILED" || !automaticRetrySafe(runtime)) continue;
      const retryCount = Math.max(0, Number(runtime.attempt ?? 1) - 1);
      if (retryCount >= Number(context.objective.budget?.maxRetriesPerNode ?? 0)) continue;
      try {
        const requested = requestNodeRetry({
          runsRoot,
          objectiveId: context.objective.objectiveId,
          orchestrationId: context.orchestration.orchestrationId,
          nodeId,
          reason: "Automatic retry untuk failure node yang aman dalam mode FINAL_ACCEPT_ONLY.",
          requestedBy: "system:autopilot",
          now,
        });
        const resolved = resolveDecision({
          vaultRoot,
          runsRoot,
          decisionId: requested.decision.decisionId,
          action: "RETRY",
          resolvedBy: "system:autopilot",
          now,
        });
        retried.push({ orchestrationId: context.orchestration.orchestrationId, nodeId, decisionId: resolved.decision?.decisionId ?? requested.decision.decisionId, attempt: retryCount + 2 });
      } catch (error) {
        exceptions.push({ orchestrationId: context.orchestration.orchestrationId, nodeId, error: error.message });
      }
    }
  }
  return { enabled: true, retried, exceptions };
}

function clearFailedDescendantBlockers({ plan, nodes, failedNodeId }) {
  const ordered = topologicalOrder(plan.nodes);
  const descendants = new Set();
  for (const nodeId of ordered) {
    const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node.dependsOn.some((dependency) => dependency === failedNodeId || descendants.has(dependency))) descendants.add(nodeId);
  }
  for (const nodeId of descendants) {
    const node = nodes[nodeId];
    if (node?.state === "BLOCKED" && node.lastError?.code === "PREDECESSOR_FAILED") {
      node.lastError = null;
      node.blockedBy = plan.nodes.find((candidate) => candidate.nodeId === nodeId)?.dependsOn
        .map((dependency) => nodes[dependency]?.taskId)
        .filter(Boolean) ?? [];
    }
  }
}

export function applyNodeRetryDecision({ vaultRoot, runsRoot, decisionId, now = new Date() } = {}) {
  return withDurableLease({
    runsRoot,
    namespace: "orchestration-scheduler",
    key: "global",
    purpose: "apply orchestration node retry decision",
    ttlMs: 60_000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 2_000,
  }, () => {
    const decision = getDecision(runsRoot, decisionId);
    if (!decision) fail(`Decision tidak ditemukan: ${decisionId}`, { statusCode: 404, code: "DECISION_NOT_FOUND", details: { code: "DECISION_NOT_FOUND", decisionId } });
    if (decision.type !== "NODE_RETRY" || decision.state !== "RESOLVED" || decision.resolution?.action !== "RETRY") {
      fail("Decision retry belum resolved dengan action RETRY.", { code: "RETRY_DECISION_NOT_RESOLVED", details: { code: "RETRY_DECISION_NOT_RESOLVED", decisionId } });
    }
    if (decision.retryAppliedAt) return { decision, orchestration: orchestrationContext({ runsRoot, objectiveId: decision.objectiveId }).orchestration, alreadyApplied: true };
    const context = orchestrationContext({ runsRoot, objectiveId: decision.objectiveId });
    const runtime = context.orchestration.nodes[decision.nodeId];
    if (!runtime) fail(`Node tidak ditemukan: ${decision.nodeId}`, { statusCode: 404, code: "NODE_NOT_FOUND", details: { code: "NODE_NOT_FOUND", nodeId: decision.nodeId } });
    if (context.orchestration.state === "CANCELLED") fail("Orchestration sudah dibatalkan; retry tidak diizinkan.", { code: "ORCHESTRATION_CANCELLED", details: { code: "ORCHESTRATION_CANCELLED" } });
    if (runtime.state !== "FAILED") fail(`Node tidak lagi berada pada state FAILED; state saat ini ${runtime.state}.`, { code: "NODE_RETRY_NOT_ALLOWED", details: { code: "NODE_RETRY_NOT_ALLOWED", nodeId: decision.nodeId, state: runtime.state } });
    if (decision.evidence?.planFingerprint !== context.plan.planFingerprint || decision.evidence?.planId !== context.plan.planId) {
      fail("Decision retry berasal dari plan fingerprint yang stale.", { statusCode: 409, code: "STALE_RETRY_DECISION", details: { code: "STALE_RETRY_DECISION", decisionId } });
    }
    const retryCount = Math.max(0, Number(runtime.attempt ?? 1) - 1);
    if (retryCount >= context.objective.budget.maxRetriesPerNode) fail("Batas retry node tercapai.", { statusCode: 409, code: "MAX_RETRIES_EXCEEDED", details: { code: "MAX_RETRIES_EXCEEDED", nodeId: decision.nodeId } });
    const task = materializedTaskMap(context.orchestration).get(decision.nodeId);
    if (!task) fail(`Materialized task untuk node ${decision.nodeId} tidak ditemukan.`, { code: "MATERIALIZED_TASK_MISSING", details: { code: "MATERIALIZED_TASK_MISSING", nodeId: decision.nodeId } });
    resetOrchestrationTaskToBacklog({
      vaultRoot,
      task,
      failedJobId: runtime.jobId,
      retriedBy: decision.resolution.resolvedBy,
      reason: decision.evidence?.reason,
      now,
    });
    const nodes = structuredClone(context.orchestration.nodes);
    nodes[decision.nodeId] = {
      ...nodes[decision.nodeId],
      state: "READY",
      attempt: Number(nodes[decision.nodeId].attempt ?? 1) + 1,
      jobId: null,
      runId: null,
      blockedBy: [],
      lastError: null,
    };
    clearFailedDescendantBlockers({ plan: context.plan, nodes, failedNodeId: decision.nodeId });
    const orchestration = updateOrchestration({
      runsRoot,
      orchestrationId: context.orchestration.orchestrationId,
      expectedRevision: context.orchestration.revision,
      now,
      update: (record) => ({ ...record, nodes, state: "RUNNING", retry: { nodeId: decision.nodeId, attempt: nodes[decision.nodeId].attempt, decisionId, retriedAt: nowIso(now), retriedBy: decision.resolution.resolvedBy } }),
      validationOptions: { plan: context.plan },
    });
    const appliedDecision = updateDecision({
      runsRoot,
      decisionId,
      expectedRevision: decision.revision,
      now,
      update: (record) => ({ ...record, retryAppliedAt: nowIso(now), retryAttempt: nodes[decision.nodeId].attempt }),
    });
    return { decision: appliedDecision, orchestration, alreadyApplied: false };
  });
}

export function resolveDecision({ vaultRoot, runsRoot, decisionId, action, resolvedBy, budget = null, now = new Date() } = {}) {
  const selectedAction = String(action ?? "").trim().toUpperCase();
  const identity = String(resolvedBy ?? "").trim();
  if (!identity) fail("Human decision identity wajib berasal dari operator session.", { statusCode: 403, code: "DECISION_RESOLVER_REQUIRED", details: { code: "DECISION_RESOLVER_REQUIRED" } });
  const decision = getDecision(runsRoot, decisionId);
  if (!decision) fail(`Decision tidak ditemukan: ${decisionId}`, { statusCode: 404, code: "DECISION_NOT_FOUND", details: { code: "DECISION_NOT_FOUND", decisionId } });
  if (!decision.allowedChoices.includes(selectedAction)) fail(`Action decision tidak diizinkan: ${selectedAction}.`, { statusCode: 422, code: "DECISION_ACTION_NOT_ALLOWED", details: { code: "DECISION_ACTION_NOT_ALLOWED", allowedChoices: decision.allowedChoices } });
  if (decision.type === "INTEGRATION_CONFLICT" && selectedAction === "RETRY") {
    const evidence = decision.evidence?.orchestrationId
      ? getIntegrationEvidence({ runsRoot, orchestrationId: decision.evidence.orchestrationId })
      : null;
    const classification = classifyIntegrationFailure({ evidence });
    if (classification.classification !== "INFRASTRUCTURE") {
      fail("Integration retry hanya aman untuk failure infrastructure; gunakan targeted repair proposal.", {
        statusCode: 409,
        code: "INTEGRATION_RETRY_NOT_SAFE",
        details: { code: "INTEGRATION_RETRY_NOT_SAFE", classification },
      });
    }
  }
  if (decision.state === "RESOLVED") {
    if (decision.resolution?.action !== selectedAction) fail("Decision sudah resolved dengan action berbeda.", { statusCode: 409, code: "DECISION_ALREADY_RESOLVED", details: { code: "DECISION_ALREADY_RESOLVED", decisionId } });
    if (decision.type === "NODE_RETRY" && selectedAction === "RETRY" && !decision.retryAppliedAt) return applyNodeRetryDecision({ vaultRoot, runsRoot, decisionId, now });
    return { decision, alreadyResolved: true };
  }
  if (decision.state !== "OPEN") fail(`Decision tidak dapat di-resolve dari state ${decision.state}.`, { code: "DECISION_NOT_OPEN", details: { code: "DECISION_NOT_OPEN", decisionId } });
  if (decision.type === "BUDGET_EXCEEDED" && selectedAction === "INCREASE_BUDGET") {
    return resolveBudgetExceededDecision({ runsRoot, decisionId, budget, resolvedBy: identity, now });
  }
  if (decision.type === "BUDGET_EXCEEDED" && selectedAction === "CANCEL") {
    const cancellation = cancelOrchestration({ runsRoot, objectiveId: decision.objectiveId, orchestrationId: decision.evidence?.orchestrationId ?? null, cancelledBy: identity, now });
    const resolved = updateDecision({
      runsRoot,
      decisionId,
      expectedRevision: decision.revision,
      now,
      update: (record) => ({ ...record, state: "RESOLVED", resolution: { action: selectedAction, resolvedBy: identity, resolvedAt: nowIso(now) } }),
    });
    return { decision: resolved, orchestration: cancellation.orchestration, alreadyResolved: false };
  }
  const resolved = updateDecision({
    runsRoot,
    decisionId,
    expectedRevision: decision.revision,
    now,
    update: (record) => ({ ...record, state: "RESOLVED", resolution: { action: selectedAction, resolvedBy: identity, resolvedAt: nowIso(now) } }),
  });
  if (resolved.type === "NODE_RETRY" && selectedAction === "RETRY") return applyNodeRetryDecision({ vaultRoot, runsRoot, decisionId, now });
  return { decision: resolved, alreadyResolved: false };
}

export function cancelOrchestration({ runsRoot, objectiveId, orchestrationId = null, cancelledBy, now = new Date() } = {}) {
  const identity = String(cancelledBy ?? "").trim();
  if (!identity) fail("Human cancellation identity wajib berasal dari operator session.", { statusCode: 403, code: "CANCELLER_REQUIRED", details: { code: "CANCELLER_REQUIRED" } });
  return withDurableLease({
    runsRoot,
    namespace: "orchestration-scheduler",
    key: "global",
    purpose: "cancel orchestration",
    ttlMs: 60_000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 2_000,
  }, () => {
    const context = orchestrationContext({ runsRoot, objectiveId, orchestrationId });
    if (context.orchestration.state === "CANCELLED") return { orchestration: context.orchestration, alreadyCancelled: true };
    const jobs = listJobs(runsRoot);
    const nodes = structuredClone(context.orchestration.nodes);
    const ordered = topologicalOrder(context.plan.nodes);
    const activeNodeIds = new Set(Object.entries(nodes).filter(([, node]) => ["RUNNING", "REVIEW"].includes(node.state)).map(([nodeId]) => nodeId));
    for (const [nodeId, runtime] of Object.entries(nodes)) {
      const job = jobs.find((candidate) => candidate.orchestrationId === context.orchestration.orchestrationId && candidate.nodeId === nodeId && candidate.jobId === runtime.jobId);
      if (!job || ![JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job.state)) continue;
      activeNodeIds.add(nodeId);
      runtime.state = job.state === JOB_STATES.REVIEW ? "REVIEW" : "RUNNING";
      runtime.runId = job.runId ?? runtime.runId ?? null;
    }
    for (const nodeId of ordered) {
      const node = context.plan.nodes.find((candidate) => candidate.nodeId === nodeId);
      const runtime = nodes[nodeId];
      if (runtime.state === "DONE" || runtime.state === "CANCELLED") continue;
      if (activeNodeIds.has(nodeId)) {
        runtime.lastError = { code: "CANCELLATION_REQUESTED", message: "Node sedang aktif; cancellation tidak memutus run yang mungkin sudah mengubah repository." };
        continue;
      }
      if (runtime.state === "QUEUED") {
        const job = jobs.find((candidate) => candidate.jobId === runtime.jobId);
        if (job && job.state === JOB_STATES.QUEUED) updateJob(runsRoot, job.jobId, { state: JOB_STATES.CANCELLED, error: "Cancelled by human orchestration decision." });
        runtime.state = "CANCELLED";
        runtime.lastError = { code: "CANCELLED_BY_HUMAN", cancelledBy: identity };
        continue;
      }
      const activePredecessor = node.dependsOn.some((dependency) => activeNodeIds.has(dependency) || nodes[dependency]?.lastError?.code === "CANCELLATION_ACTIVE_NODE");
      if (activePredecessor) {
        runtime.state = "BLOCKED";
        runtime.lastError = { code: "CANCELLATION_ACTIVE_NODE", message: "Descendant tetap blocked karena predecessor aktif dibiarkan selesai." };
        runtime.blockedBy = node.dependsOn.map((dependency) => nodes[dependency]?.taskId).filter(Boolean);
      } else {
        runtime.state = "CANCELLED";
        runtime.lastError = { code: "CANCELLED_BY_HUMAN", cancelledBy: identity };
      }
    }
    const orchestration = updateOrchestration({
      runsRoot,
      orchestrationId: context.orchestration.orchestrationId,
      expectedRevision: context.orchestration.revision,
      now,
      update: (record) => ({ ...record, nodes, state: "CANCELLED", cancellation: { cancelledBy: identity, cancelledAt: nowIso(now), policy: "CANCEL_PENDING_PRESERVE_ACTIVE" } }),
      validationOptions: { plan: context.plan },
    });
    return { orchestration, alreadyCancelled: false };
  });
}

function activeQueueJob(job) {
  return [JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job?.state);
}

function orchestrationHasActiveWork(orchestration) {
  if (TERMINAL_ORCHESTRATION_STATES.has(orchestration?.state)) return false;
  return Object.values(orchestration?.nodes ?? {}).some((node) => ACTIVE_NODE_STATES.has(node?.state));
}

export function objectiveSchedulingAllowed({ orchestration, activeObjectiveIds = new Set(), allowParallelObjectives = false } = {}) {
  if (allowParallelObjectives || activeObjectiveIds.size === 0) return true;
  return activeObjectiveIds.has(orchestration?.objectiveId);
}

function scheduleOne({ vaultRoot = null, runsRoot, orchestration, now, env = process.env }) {
  if (TERMINAL_ORCHESTRATION_STATES.has(orchestration.state)) return { orchestration, queued: [], changed: false };
  const objective = getObjective(runsRoot, orchestration.objectiveId);
  if (!objective) fail(`Objective scheduler tidak ditemukan: ${orchestration.objectiveId}`, { code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId: orchestration.objectiveId } });
  if (objective.state === "CANCELLED") return { orchestration, queued: [], changed: false };
  const plan = getPlan(runsRoot, orchestration.planId, planOptions(objective));
  if (!plan || plan.state !== "APPROVED" || plan.planFingerprint !== orchestration.planFingerprint) {
    fail(`Orchestration ${orchestration.orchestrationId} tidak memiliki plan approved yang cocok.`, { code: "STALE_APPROVED_PLAN", details: { code: "STALE_APPROVED_PLAN", orchestrationId: orchestration.orchestrationId } });
  }
  const jobs = listJobs(runsRoot);
  const sameProjectFlag = sameProjectParallelEnabled(env);
  const frozen = sameProjectFlag
    ? freezeSameProjectBaselines({ vaultRoot, runsRoot, plan, orchestration, now })
    : { orchestration, active: false, projectIds: [], allowFrozenBaselineDrift: false };
  let activeOrchestration = frozen.orchestration;
  const reconciled = reconcileRuntimeNodes({ plan, orchestration: activeOrchestration, jobs });
  let nodes = reconciled.nodes;
  let state = orchestrationState(nodes, orchestration.state);
  const queued = [];
  const globalCeiling = configuredGlobalParallelJobs(env);
  const budgetTasks = materializedTaskMap(activeOrchestration);
  const hasReadyWork = plan.nodes.some((node) => nodes[node.nodeId]?.state === "READY" && node.dependsOn.every((dependency) => nodes[dependency]?.state === "DONE") && budgetTasks.get(node.nodeId)?.projectId);
  const initialBudget = budgetSnapshot({ runsRoot, objective, orchestration: activeOrchestration, plan, jobs, now, objectiveParallelLimit: objective.budget?.maxParallelAgents });
  if (JSON.stringify(initialBudget.usage) !== JSON.stringify(activeOrchestration.usage)) {
    activeOrchestration = updateOrchestration({
      runsRoot,
      orchestrationId: activeOrchestration.orchestrationId,
      expectedRevision: activeOrchestration.revision,
      now,
      update: (record) => ({ ...record, usage: initialBudget.usage }),
      validationOptions: { plan },
    });
  }
  const budgetBlockers = [];
  for (const violation of initialBudget.violations) {
    if (!hasReadyWork) continue;
    const blocker = ensureBudgetExceededDecision({ runsRoot, objective, orchestration: activeOrchestration, plan, violation, snapshot: initialBudget, now });
    budgetBlockers.push({ code: "BUDGET_EXCEEDED", budgetCode: violation.code, decisionId: blocker.decision.decisionId, nodeId: violation.nodeId ?? null });
  }
  if (budgetBlockers.length) {
    state = "BLOCKED";
    const persisted = persistOrchestration({ runsRoot, orchestration: activeOrchestration, plan, nodes, state, now });
    updateObjectiveState({ runsRoot, objective, orchestration: persisted });
    return { orchestration: persisted, queued, changed: reconciled.changed || persisted !== orchestration, budgetBlockers };
  }
  const activeJobs = jobs.filter(activeQueueJob);
  const objectiveJobs = activeJobs.filter((job) => job.objectiveId === objective.objectiveId);
  let globalOccupancy = activeJobs.length;
  let objectiveOccupancy = objectiveJobs.length;
  const maxObjectiveParallel = Number(objective.budget?.maxParallelAgents ?? 1);
  const tasks = budgetTasks;
  const sameProjectMode = frozen.active;
  const sameProjectBaseline = new Map(Object.entries(activeOrchestration.integration?.projectBaselines ?? {}));
  const sameProjectNode = (nodeId) => {
    const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
    return sameProjectMode && node?.canRunInParallel === true && frozen.projectIds.includes(node.projectId);
  };
  const activeSameProjectNodeIds = new Set();
  const activeSameProjectProjects = new Set();
  const occupiedProjects = new Set();
  for (const job of activeJobs) {
    if (sameProjectNode(job.nodeId) && job.sameProjectParallel === true) {
      activeSameProjectNodeIds.add(job.nodeId);
      if (job.projectId) activeSameProjectProjects.add(job.projectId);
    }
    else if ([JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job.state) && job.projectId) occupiedProjects.add(job.projectId);
  }
  for (const [nodeId, runtime] of Object.entries(nodes)) {
    if (ACTIVE_NODE_STATES.has(runtime.state)) {
      const projectId = tasks.get(nodeId)?.projectId;
      if (projectId && sameProjectNode(nodeId)) {
        activeSameProjectNodeIds.add(nodeId);
        activeSameProjectProjects.add(projectId);
      }
      else if (projectId) occupiedProjects.add(projectId);
    }
  }
  const ordered = topologicalOrder(plan.nodes);
  const conflicts = new Set(detectWriteConflicts(plan.nodes).flatMap((conflict) => {
    const [left, right] = conflict.nodeIds;
    return [`${left}:${right}`, `${right}:${left}`];
  }));
  const selectedSameProjectNodeIds = new Set();

  for (const nodeId of ordered) {
    const candidate = plan.nodes.find((node) => node.nodeId === nodeId);
    const runtime = nodes[nodeId];
    if (runtime?.state !== "READY" || !candidate.dependsOn.every((dependency) => nodes[dependency]?.state === "DONE")) continue;
    const task = tasks.get(candidate.nodeId);
    if (!task?.projectId) continue;
    if (globalOccupancy >= globalCeiling) break;
    if (objectiveOccupancy >= maxObjectiveParallel) {
      const snapshot = budgetSnapshot({ runsRoot, objective, orchestration: activeOrchestration, plan, jobs, now, candidateNodeId: candidate.nodeId, objectiveParallelLimit: maxObjectiveParallel, activeAgents: objectiveOccupancy });
      const violation = snapshot.violations.find((item) => item.code === "CONCURRENCY_CEILING");
      if (violation) {
        const blocker = ensureBudgetExceededDecision({ runsRoot, objective, orchestration: activeOrchestration, plan, violation, snapshot, now });
        budgetBlockers.push({ code: "BUDGET_EXCEEDED", budgetCode: violation.code, decisionId: blocker.decision.decisionId, nodeId: candidate.nodeId });
        state = "BLOCKED";
      }
      break;
    }
    const candidateSameProject = sameProjectNode(candidate.nodeId);
    if (candidateSameProject) {
      if (occupiedProjects.has(task.projectId)) continue;
      const relatedActive = [...activeSameProjectNodeIds, ...selectedSameProjectNodeIds]
        .filter((activeNodeId) => plan.nodes.find((node) => node.nodeId === activeNodeId)?.projectId === task.projectId);
      if (relatedActive.some((activeNodeId) => conflicts.has(`${candidate.nodeId}:${activeNodeId}`))) continue;
    } else if (occupiedProjects.has(task.projectId) || activeSameProjectProjects.has(task.projectId)) continue;
    const queuedCandidate = queueCandidate({
      runsRoot,
      objective,
      plan,
      orchestration: activeOrchestration,
      nodeId: candidate.nodeId,
      task,
      sameProjectParallel: candidateSameProject,
      baseline: sameProjectBaseline.get(task.projectId),
      allowFrozenBaselineDrift: frozen.allowFrozenBaselineDrift,
      allowedCurrentCommit: frozen.allowedCurrentCommit,
    });
    queued.push(queuedCandidate);
    nodes = structuredClone(nodes);
    nodes[candidate.nodeId] = {
      ...nodes[candidate.nodeId],
      state: "QUEUED",
      jobId: queuedCandidate.job.jobId,
      lastError: null,
    };
    if (candidateSameProject) selectedSameProjectNodeIds.add(candidate.nodeId);
    else occupiedProjects.add(task.projectId);
    globalOccupancy += 1;
    objectiveOccupancy += 1;
    state = "RUNNING";
  }
  const persisted = persistOrchestration({ runsRoot, orchestration: activeOrchestration, plan, nodes, state, now });
  updateObjectiveState({ runsRoot, objective, orchestration: persisted });
  return { orchestration: persisted, queued, changed: reconciled.changed || queued.length > 0 || persisted !== orchestration, budgetBlockers };
}

export function schedulerTick({ vaultRoot = null, runsRoot, enabled = orchestrationSchedulerEnabled(), now = new Date(), env = process.env } = {}) {
  if (!runsRoot) fail("runsRoot wajib disediakan.", { code: "SCHEDULER_ROOT_REQUIRED" });
  if (!enabled) return { schemaVersion: 1, enabled: false, action: "DISABLED", queued: [], blocked: [], budgetBlockers: [], completed: [] };
  return withDurableLease({
    runsRoot,
    namespace: "orchestration-scheduler",
    key: "global",
    purpose: "parallel orchestration scheduler tick",
    ttlMs: 60_000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 0,
  }, () => {
    const results = [];
    const orchestrations = listOrchestrations(runsRoot);
    const allowParallelObjectives = parallelObjectivesEnabled(env);
    const activeObjectiveIds = new Set(orchestrations.filter(orchestrationHasActiveWork).map((orchestration) => orchestration.objectiveId));
    for (const orchestration of orchestrations) {
      if (!objectiveSchedulingAllowed({ orchestration, activeObjectiveIds, allowParallelObjectives })) {
        results.push({ orchestrationId: orchestration.orchestrationId, orchestration, queued: [], blocked: [], budgetBlockers: [], completed: [], changed: false, blockedReason: "PARALLEL_OBJECTIVES_DISABLED" });
        continue;
      }
      try {
        const result = scheduleOne({ vaultRoot, runsRoot, orchestration, now, env });
        results.push({ orchestrationId: orchestration.orchestrationId, ...result });
        if (!allowParallelObjectives && result.queued?.length) activeObjectiveIds.add(orchestration.objectiveId);
      } catch (error) {
        results.push({ orchestrationId: orchestration.orchestrationId, error: { code: error.code ?? "SCHEDULER_ERROR", message: error.message } });
      }
    }
    return {
      schemaVersion: 1,
      enabled: true,
      action: "TICK_COMPLETED",
      queued: results.flatMap((result) => result.queued ?? []).map((item) => item.job),
      blocked: results.filter((result) => result.orchestration?.state === "BLOCKED").map((result) => result.orchestrationId),
      budgetBlockers: results.flatMap((result) => result.budgetBlockers ?? []),
      completed: results.filter((result) => result.orchestration?.state === "DONE").map((result) => result.orchestrationId),
      admissionBlocked: results.filter((result) => result.blockedReason === "PARALLEL_OBJECTIVES_DISABLED").map((result) => result.orchestrationId),
      results,
    };
  });
}

export const orchestrationSchedulerTick = schedulerTick;
export const scheduleOrchestrationTick = schedulerTick;
export const runOrchestrationScheduler = schedulerTick;
