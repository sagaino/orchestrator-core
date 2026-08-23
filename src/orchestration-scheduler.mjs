import { getObjective, updateObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getDecision } from "./decision-store.mjs";
import { listOrchestrations, updateOrchestration } from "./orchestration-store.mjs";
import { enqueueTaskJob, JOB_STATES, listJobs } from "./job-queue.mjs";
import { topologicalOrder } from "./task-graph.mjs";
import { withDurableLease } from "./durable-runtime.mjs";

const ACTIVE_NODE_STATES = new Set(["QUEUED", "RUNNING", "REVIEW"]);
const TERMINAL_NODE_STATES = new Set(["DONE", "FAILED", "CANCELLED"]);
const TERMINAL_ORCHESTRATION_STATES = new Set(["DONE", "FAILED", "CANCELLED"]);

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
    const previous = result.get(nodeId);
    const isActive = [JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job.state);
    const previousIsActive = previous && [JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(previous.state);
    if (!previous || (isActive && !previousIsActive) || String(job.createdAt).localeCompare(String(previous.createdAt)) > 0) {
      result.set(nodeId, job);
    }
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
    const job = jobsForNode.get(nodeId);
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
    if (current.state === "BLOCKED" && !current.lastError && node.dependsOn.every((dependency) => nextNodes[dependency]?.state === "DONE")) {
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
  if (states.some((state) => state === "FAILED") || Object.values(nodes).some((node) => node.state === "BLOCKED" && node.lastError)) return "BLOCKED";
  if (states.length > 0 && states.every((state) => state === "DONE")) return "DONE";
  if (states.some((state) => ACTIVE_NODE_STATES.has(state))) return "RUNNING";
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

function queueCandidate({ runsRoot, objective, plan, orchestration, nodeId, task }) {
  if (!task?.path || !task?.taskId || !task?.projectId) {
    fail(`Materialized task untuk node ${nodeId} tidak lengkap.`, {
      code: "MATERIALIZED_TASK_MISSING",
      details: { code: "MATERIALIZED_TASK_MISSING", nodeId },
    });
  }
  const metadata = { ...approvalMetadata({ objective: { ...objective, runsRoot }, plan, orchestrationId: orchestration.orchestrationId }), nodeId };
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
  if (["CANCELLED", "FAILED", "DONE"].includes(objective.state)) return objective;
  const desiredState = orchestration.state === "BLOCKED" ? "BLOCKED" : orchestration.state === "RUNNING" ? "RUNNING" : null;
  if (!desiredState || objective.state === desiredState) return objective;
  return updateObjective({
    runsRoot,
    objectiveId: objective.objectiveId,
    expectedRevision: objective.revision,
    update: (record) => ({ ...record, state: desiredState }),
  });
}

function scheduleOne({ runsRoot, orchestration, now }) {
  if (TERMINAL_ORCHESTRATION_STATES.has(orchestration.state)) return { orchestration, queued: null, changed: false };
  const objective = getObjective(runsRoot, orchestration.objectiveId);
  if (!objective) fail(`Objective scheduler tidak ditemukan: ${orchestration.objectiveId}`, { code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId: orchestration.objectiveId } });
  if (objective.state === "CANCELLED") return { orchestration, queued: null, changed: false };
  const plan = getPlan(runsRoot, orchestration.planId, planOptions(objective));
  if (!plan || plan.state !== "APPROVED" || plan.planFingerprint !== orchestration.planFingerprint) {
    fail(`Orchestration ${orchestration.orchestrationId} tidak memiliki plan approved yang cocok.`, { code: "STALE_APPROVED_PLAN", details: { code: "STALE_APPROVED_PLAN", orchestrationId: orchestration.orchestrationId } });
  }
  const jobs = listJobs(runsRoot);
  const reconciled = reconcileRuntimeNodes({ plan, orchestration, jobs });
  let nodes = reconciled.nodes;
  let state = orchestrationState(nodes, orchestration.state);
  let queued = null;
  const active = Object.values(nodes).some((node) => ACTIVE_NODE_STATES.has(node.state));
  if (!active && !["BLOCKED", "DONE"].includes(state)) {
    const ordered = topologicalOrder(plan.nodes);
    const candidate = ordered
      .map((nodeId) => plan.nodes.find((node) => node.nodeId === nodeId))
      .find((node) => nodes[node.nodeId]?.state === "READY" && node.dependsOn.every((dependency) => nodes[dependency]?.state === "DONE"));
    if (candidate) {
      const tasks = materializedTaskMap(orchestration);
      queued = queueCandidate({ runsRoot, objective, plan, orchestration, nodeId: candidate.nodeId, task: tasks.get(candidate.nodeId) });
      nodes = structuredClone(nodes);
      nodes[candidate.nodeId] = {
        ...nodes[candidate.nodeId],
        state: "QUEUED",
        jobId: queued.job.jobId,
        lastError: null,
      };
      state = "RUNNING";
    }
  }
  const persisted = persistOrchestration({ runsRoot, orchestration, plan, nodes, state, now });
  updateObjectiveState({ runsRoot, objective, orchestration: persisted });
  return { orchestration: persisted, queued, changed: reconciled.changed || Boolean(queued) || persisted !== orchestration };
}

export function schedulerTick({ vaultRoot = null, runsRoot, enabled = orchestrationSchedulerEnabled(), now = new Date() } = {}) {
  if (!runsRoot) fail("runsRoot wajib disediakan.", { code: "SCHEDULER_ROOT_REQUIRED" });
  if (!enabled) return { schemaVersion: 1, enabled: false, action: "DISABLED", queued: [], blocked: [], completed: [] };
  return withDurableLease({
    runsRoot,
    namespace: "orchestration-scheduler",
    key: "global",
    purpose: "sequential orchestration scheduler tick",
    ttlMs: 60_000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 0,
  }, () => {
    const results = [];
    for (const orchestration of listOrchestrations(runsRoot)) {
      try {
        const result = scheduleOne({ runsRoot, orchestration, now });
        results.push({ orchestrationId: orchestration.orchestrationId, ...result });
      } catch (error) {
        results.push({ orchestrationId: orchestration.orchestrationId, error: { code: error.code ?? "SCHEDULER_ERROR", message: error.message } });
      }
    }
    return {
      schemaVersion: 1,
      enabled: true,
      action: "TICK_COMPLETED",
      queued: results.filter((result) => result.queued).map((result) => result.queued.job),
      blocked: results.filter((result) => result.orchestration?.state === "BLOCKED").map((result) => result.orchestrationId),
      completed: results.filter((result) => result.orchestration?.state === "DONE").map((result) => result.orchestrationId),
      results,
    };
  });
}

export const orchestrationSchedulerTick = schedulerTick;
export const scheduleOrchestrationTick = schedulerTick;
export const runOrchestrationScheduler = schedulerTick;
