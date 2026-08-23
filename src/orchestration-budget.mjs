import { createDecision, getDecision, listDecisions, updateDecision } from "./decision-store.mjs";
import { getObjective, updateObjective } from "./objective-store.mjs";
import { listJobs } from "./job-queue.mjs";
import { listRuns } from "./run-manager.mjs";
import { withDurableLease } from "./durable-runtime.mjs";

const ACTIVE_JOB_STATES = new Set(["QUEUED", "RUNNING", "REVIEW"]);
const INTEGER_BUDGET_FIELDS = ["maxSubtasks", "maxParallelAgents", "maxRetriesPerNode", "maxRepairCycles"];

export class OrchestrationBudgetError extends Error {
  constructor(message, { statusCode = 409, code = "ORCHESTRATION_BUDGET_ERROR", details = null } = {}) {
    super(message);
    this.name = "OrchestrationBudgetError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new OrchestrationBudgetError(message, options);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function budgetFieldFor(code) {
  return {
    NODE_CEILING: "maxSubtasks",
    CONCURRENCY_CEILING: "maxParallelAgents",
    RETRY_CEILING: "maxRetriesPerNode",
    TOKEN_CEILING: "maxTotalTokens",
    DEADLINE_EXCEEDED: "deadlineAt",
  }[code] ?? null;
}

function relevantJobs({ runsRoot, objective, orchestration, jobs = null }) {
  const source = jobs ?? listJobs(runsRoot);
  return source.filter((job) => job.orchestrationId === orchestration.orchestrationId || (job.objectiveId === objective.objectiveId && job.orchestrationId === orchestration.orchestrationId));
}

function observedTokens({ runsRoot, jobs, orchestration }) {
  const runs = new Map(listRuns(runsRoot).map((run) => [run.runId, run]));
  const seen = new Set();
  const runTokens = jobs.reduce((total, job) => {
    if (!job.runId || seen.has(job.runId)) return total;
    seen.add(job.runId);
    const run = runs.get(job.runId);
    return total + numberOrZero(run?.execution?.usage?.totalTokens ?? run?.telemetry?.tokens?.totalTokens ?? 0);
  }, 0);
  return Math.max(numberOrZero(orchestration.usage?.totalTokens), runTokens);
}

export function budgetSnapshot({ runsRoot, objective, orchestration, plan, jobs = null, now = new Date(), candidateNodeId = null, objectiveParallelLimit = null, activeAgents = null } = {}) {
  if (!runsRoot || !objective || !orchestration || !plan) fail("Budget snapshot membutuhkan objective, plan, orchestration, dan runsRoot.", { code: "BUDGET_CONTEXT_REQUIRED" });
  const relevant = relevantJobs({ runsRoot, objective, orchestration, jobs });
  const active = relevant.filter((job) => ACTIVE_JOB_STATES.has(job.state));
  const retries = Object.values(orchestration.nodes ?? {}).reduce((total, node) => total + Math.max(0, Number(node.attempt ?? 1) - 1), 0);
  const totalTokens = Math.max(numberOrZero(orchestration.usage?.totalTokens), observedTokens({ runsRoot, jobs: relevant, orchestration }));
  const usage = {
    totalTokens,
    agentInvocations: Math.max(numberOrZero(orchestration.usage?.agentInvocations), relevant.filter((job) => job.runId).length),
    retries: Math.max(numberOrZero(orchestration.usage?.retries), retries),
  };
  const budget = objective.budget ?? {};
  const violations = [];
  if (plan.nodes.length > Number(budget.maxSubtasks)) violations.push({ code: "NODE_CEILING", field: "maxSubtasks", observed: plan.nodes.length, ceiling: budget.maxSubtasks });
  if (budget.maxTotalTokens !== null && budget.maxTotalTokens !== undefined && totalTokens >= Number(budget.maxTotalTokens)) {
    violations.push({ code: "TOKEN_CEILING", field: "maxTotalTokens", observed: totalTokens, ceiling: budget.maxTotalTokens });
  }
  if (budget.deadlineAt && new Date(now).getTime() >= Date.parse(budget.deadlineAt)) {
    violations.push({ code: "DEADLINE_EXCEEDED", field: "deadlineAt", observed: iso(now), ceiling: budget.deadlineAt });
  }
  if (candidateNodeId) {
    const observedActiveAgents = activeAgents === null ? active.length : Number(activeAgents);
    if (observedActiveAgents >= Number(budget.maxParallelAgents)) {
      violations.push({ code: "CONCURRENCY_CEILING", field: "maxParallelAgents", observed: observedActiveAgents, ceiling: budget.maxParallelAgents, nodeId: candidateNodeId });
    }
    const runtime = orchestration.nodes?.[candidateNodeId];
    const retryCount = Math.max(0, Number(runtime?.attempt ?? 1) - 1);
    if (retryCount >= Number(budget.maxRetriesPerNode)) {
      violations.push({ code: "RETRY_CEILING", field: "maxRetriesPerNode", observed: retryCount, ceiling: budget.maxRetriesPerNode, nodeId: candidateNodeId });
    }
  }
  return {
    budget,
    usage,
    activeAgents: active.length,
    objectiveParallelLimit: objectiveParallelLimit ?? Number(budget.maxParallelAgents ?? 1),
    plannedNodes: plan.nodes.length,
    violations,
    remainingTokens: budget.maxTotalTokens === null || budget.maxTotalTokens === undefined ? null : Math.max(0, Number(budget.maxTotalTokens) - totalTokens),
  };
}

export function budgetViolation({ snapshot, code } = {}) {
  return snapshot?.violations?.find((item) => item.code === code) ?? null;
}

export function ensureBudgetExceededDecision({ runsRoot, objective, orchestration, plan, violation, snapshot, now = new Date() } = {}) {
  if (!violation?.code) fail("Budget violation code wajib diisi.", { code: "BUDGET_VIOLATION_REQUIRED" });
  const existing = listDecisions(runsRoot).find((decision) => (
    decision.type === "BUDGET_EXCEEDED"
    && decision.objectiveId === objective.objectiveId
    && decision.evidence?.orchestrationId === orchestration.orchestrationId
    && decision.evidence?.budgetCode === violation.code
    && decision.state === "OPEN"
  ));
  if (existing) return { decision: existing, alreadyRequested: true };
  const decisionId = `decision-budget-${orchestration.orchestrationId}-${violation.code.toLowerCase()}-r${objective.revision}`;
  const decision = createDecision({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      decisionId,
      objectiveId: objective.objectiveId,
      nodeId: violation.nodeId ?? null,
      runId: orchestration.nodes?.[violation.nodeId]?.runId ?? null,
      type: "BUDGET_EXCEEDED",
      state: "OPEN",
      evidence: {
        budgetCode: violation.code,
        budgetField: violation.field ?? budgetFieldFor(violation.code),
        observed: violation.observed,
        ceiling: violation.ceiling,
        budget: snapshot?.budget ?? objective.budget,
        usage: snapshot?.usage ?? orchestration.usage,
        remainingTokens: snapshot?.remainingTokens ?? null,
        objectiveId: objective.objectiveId,
        orchestrationId: orchestration.orchestrationId,
        planId: plan.planId,
        nodeId: violation.nodeId ?? null,
        detectedAt: iso(now),
      },
      requestedAction: "Increase the objective budget after human review or cancel the orchestration.",
      allowedChoices: ["INCREASE_BUDGET", "CANCEL"],
      creator: "SYSTEM",
      createdAt: iso(now),
      resolution: null,
    },
  });
  return { decision, alreadyRequested: false };
}

function assertIncrease(previous, next, field) {
  if (INTEGER_BUDGET_FIELDS.includes(field)) {
    if (previous[field] === undefined && next[field] === undefined) return false;
    if (!Number.isInteger(next[field]) || next[field] <= 0) fail(`Budget ${field} harus positive integer.`, { code: "INVALID_BUDGET_INCREASE", details: { code: "INVALID_BUDGET_INCREASE", field } });
    if (Number.isInteger(previous[field]) && next[field] < previous[field]) fail(`Budget ${field} tidak boleh diturunkan.`, { code: "BUDGET_DECREASE_FORBIDDEN", details: { code: "BUDGET_DECREASE_FORBIDDEN", field } });
    return next[field] > previous[field];
  }
  if (field === "maxTotalTokens") {
    if (next[field] !== null && (!Number.isInteger(next[field]) || next[field] <= 0)) fail("Budget maxTotalTokens harus null atau positive integer.", { code: "INVALID_BUDGET_INCREASE", details: { code: "INVALID_BUDGET_INCREASE", field } });
    if (previous[field] === null || previous[field] === undefined) {
      if (next[field] !== null && next[field] !== undefined) fail("Budget maxTotalTokens tidak boleh diturunkan dari unlimited.", { code: "BUDGET_DECREASE_FORBIDDEN", details: { code: "BUDGET_DECREASE_FORBIDDEN", field } });
      return false;
    }
    if (next[field] !== null && next[field] < previous[field]) fail("Budget maxTotalTokens tidak boleh diturunkan.", { code: "BUDGET_DECREASE_FORBIDDEN", details: { code: "BUDGET_DECREASE_FORBIDDEN", field } });
    return next[field] === null || next[field] > previous[field];
  }
  if (field === "deadlineAt") {
    if (next[field] !== null && (!next[field] || !Number.isFinite(Date.parse(next[field])))) fail("Budget deadlineAt harus null atau ISO timestamp.", { code: "INVALID_BUDGET_INCREASE", details: { code: "INVALID_BUDGET_INCREASE", field } });
    if (previous[field] === null || previous[field] === undefined) {
      if (next[field] !== null && next[field] !== undefined) fail("Budget deadlineAt tidak boleh diturunkan dari unlimited.", { code: "BUDGET_DECREASE_FORBIDDEN", details: { code: "BUDGET_DECREASE_FORBIDDEN", field } });
      return false;
    }
    if (next[field] !== null && Date.parse(next[field]) < Date.parse(previous[field])) fail("Budget deadlineAt tidak boleh dipercepat.", { code: "BUDGET_DECREASE_FORBIDDEN", details: { code: "BUDGET_DECREASE_FORBIDDEN", field } });
    return next[field] === null || Date.parse(next[field]) > Date.parse(previous[field]);
  }
  return false;
}

export function resolveBudgetExceededDecision({ runsRoot, decisionId, budget, resolvedBy, now = new Date() } = {}) {
  return withDurableLease({ runsRoot, namespace: "orchestration-budget", key: String(decisionId), purpose: "resolve budget increase decision", ttlMs: 60_000, reclaimDeadOwner: true, waitTimeoutMs: 2_000 }, () => {
    const decision = getDecision(runsRoot, decisionId);
    if (!decision || decision.type !== "BUDGET_EXCEEDED") fail(`Budget decision tidak ditemukan: ${decisionId}`, { statusCode: 404, code: "DECISION_NOT_FOUND", details: { code: "DECISION_NOT_FOUND", decisionId } });
    const identity = String(resolvedBy ?? "").trim();
    if (!identity) fail("Human budget decision identity wajib berasal dari operator session.", { statusCode: 403, code: "DECISION_RESOLVER_REQUIRED", details: { code: "DECISION_RESOLVER_REQUIRED" } });
    if (!budget || typeof budget !== "object" || Array.isArray(budget)) fail("Budget baru wajib berupa object.", { code: "BUDGET_INCREASE_REQUIRED", details: { code: "BUDGET_INCREASE_REQUIRED" } });
    const objective = getObjective(runsRoot, decision.objectiveId);
    if (!objective) fail(`Objective tidak ditemukan: ${decision.objectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND" } });
    if (decision.state !== "OPEN") fail(`Budget decision tidak dapat di-resolve dari state ${decision.state}.`, { code: "DECISION_NOT_OPEN", details: { code: "DECISION_NOT_OPEN", decisionId } });
    const nextBudget = { ...objective.budget, ...budget };
    const relevantField = decision.evidence?.budgetField ?? budgetFieldFor(decision.evidence?.budgetCode);
    const fields = [...new Set([...INTEGER_BUDGET_FIELDS, "maxTotalTokens", "deadlineAt"])];
    const increased = fields.filter((field) => assertIncrease(objective.budget, nextBudget, field));
    if (relevantField && !increased.includes(relevantField)) fail(`Budget ${relevantField} harus dinaikkan untuk mengatasi ceiling ${decision.evidence?.budgetCode}.`, { code: "BUDGET_INCREASE_NOT_RELEVANT", details: { code: "BUDGET_INCREASE_NOT_RELEVANT", field: relevantField } });
    const updatedObjective = updateObjective({ runsRoot, objectiveId: objective.objectiveId, expectedRevision: objective.revision, now, update: (record) => ({ ...record, budget: nextBudget }) });
    const updatedDecision = updateDecision({
      runsRoot,
      decisionId,
      expectedRevision: decision.revision,
      now,
      update: (record) => ({ ...record, state: "RESOLVED", resolution: { action: "INCREASE_BUDGET", resolvedBy: identity, resolvedAt: iso(now), budget: nextBudget } }),
    });
    return { objective: updatedObjective, decision: updatedDecision, alreadyResolved: false };
  });
}
