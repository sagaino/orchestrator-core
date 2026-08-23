import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecision, getDecision, listDecisions } from "../src/decision-store.mjs";
import { createObjective, getObjective } from "../src/objective-store.mjs";
import { createOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { requestNodeRetry, resolveDecision, schedulerTick } from "../src/orchestration-scheduler.mjs";

console.log("Running orchestration-budget.test.mjs...");

function fixture({ budget = {}, usage = {}, nodeStates = null, nodeCount = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-budget-"));
  const runsRoot = path.join(root, "runs");
  const vaultRoot = path.join(root, "vault");
  fs.mkdirSync(vaultRoot, { recursive: true });
  const objectiveId = "obj-budget-fixture";
  const orchestrationId = "orch-budget-fixture";
  const timestamp = "2026-08-23T00:00:00.000Z";
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    nodeId: `N${String(index + 1).padStart(2, "0")}`,
    title: `Budget node ${index + 1}`,
    purpose: "Exercise objective budget enforcement.",
    projectId: "budget-project",
    role: "BACKEND",
    type: "IMPLEMENTATION",
    dependsOn: [],
    acceptanceCriteria: ["Budget enforcement is durable."],
    allowedPaths: [`src/node-${index + 1}.js`],
    verification: ["test"],
    risk: "LOW",
    complexity: "LOW",
    requiresChanges: true,
    canRunInParallel: false,
    writeConflictGroup: `node-${index + 1}`,
    contextFrom: [],
    skills: [],
  }));
  const plan = {
    schemaVersion: 1,
    revision: 1,
    planId: "plan-budget-fixture",
    objectiveId,
    state: "APPROVED",
    summary: "Budget fixture plan.",
    architectureDecisions: [],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["budget-project"],
    nodes,
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
    risk: "LOW",
    complexity: "LOW",
    approvedBy: "human:budget-fixture",
    approvedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  plan.planFingerprint = planFingerprint(plan);
  const resolvedBudget = { maxSubtasks: nodeCount, maxParallelAgents: 2, maxRetriesPerNode: 1, maxTotalTokens: null, deadlineAt: null, ...budget };
  const tasks = nodes.map((node) => ({ nodeId: node.nodeId, projectId: node.projectId, taskId: `TASK-${node.nodeId}`, path: `02-Projects/budget-project/tasks/${node.nodeId.toLowerCase()}.md`, dependencies: [], orchestrationDependencies: [] }));
  const runtimeNodes = Object.fromEntries(nodes.map((node, index) => [node.nodeId, {
    state: nodeStates?.[node.nodeId] ?? "READY",
    taskId: `TASK-${node.nodeId}`,
    jobId: null,
    runId: null,
    attempt: 1,
    blockedBy: [],
    lastError: null,
    ...(nodeStates?.[node.nodeId] === "FAILED" ? { attempt: 2 } : {}),
  }]));
  createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING", request: "Enforce objective budgets.", requestedBy: "human:budget-fixture", projectIds: ["budget-project"], freshProject: null, activePlanId: plan.planId, activeOrchestrationId: orchestrationId, budget: resolvedBudget, createdAt: timestamp, updatedAt: timestamp } });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: ["budget-project"], budget: resolvedBudget } });
  createDecision({ runsRoot, record: { schemaVersion: 1, revision: 0, decisionId: "decision-plan-approval-plan-budget-fixture", objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED", evidence: { planId: plan.planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve budget fixture plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp, resolution: { action: "APPROVE", resolvedBy: "human:budget-fixture", resolvedAt: timestamp } } });
  createOrchestration({ runsRoot, record: { schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId: plan.planId, state: "CREATED", planFingerprint: plan.planFingerprint, nodes: runtimeNodes, integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: usage.totalTokens ?? 0, agentInvocations: usage.agentInvocations ?? 0, retries: usage.retries ?? 0 }, createdAt: timestamp, updatedAt: timestamp, materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks } }, validationOptions: { plan } });
  return { root, runsRoot, vaultRoot, objectiveId, orchestrationId, plan };
}

try {
  const tokenFixture = fixture({ budget: { maxSubtasks: 2, maxParallelAgents: 1, maxTotalTokens: 10 }, usage: { totalTokens: 10 }, nodeStates: { N01: "DONE", N02: "READY" } });
  const blocked = schedulerTick({ runsRoot: tokenFixture.runsRoot, vaultRoot: tokenFixture.vaultRoot, enabled: true, now: new Date("2026-08-23T01:00:00.000Z") });
  assert.equal(blocked.queued.length, 0);
  assert.equal(blocked.budgetBlockers[0].budgetCode, "TOKEN_CEILING");
  const tokenDecision = getDecision(tokenFixture.runsRoot, blocked.budgetBlockers[0].decisionId);
  assert.equal(tokenDecision.type, "BUDGET_EXCEEDED");
  assert.equal(getOrchestration(tokenFixture.runsRoot, tokenFixture.orchestrationId).nodes.N01.state, "DONE", "completed evidence remains available");

  const increased = resolveDecision({ runsRoot: tokenFixture.runsRoot, decisionId: tokenDecision.decisionId, action: "INCREASE_BUDGET", budget: { maxTotalTokens: 20 }, resolvedBy: "human:budget-reviewer", now: new Date("2026-08-23T01:01:00.000Z") });
  assert.equal(increased.decision.resolution.action, "INCREASE_BUDGET");
  assert.equal(increased.decision.resolution.resolvedBy, "human:budget-reviewer");
  assert.equal(getObjective(tokenFixture.runsRoot, tokenFixture.objectiveId).budget.maxTotalTokens, 20);
  const resumed = schedulerTick({ runsRoot: tokenFixture.runsRoot, vaultRoot: tokenFixture.vaultRoot, enabled: true, now: new Date("2026-08-23T01:02:00.000Z") });
  assert.equal(resumed.queued.length, 1);
  assert.equal(getOrchestration(tokenFixture.runsRoot, tokenFixture.orchestrationId).nodes.N01.state, "DONE");
  fs.rmSync(tokenFixture.root, { recursive: true, force: true });

  const deadlineFixture = fixture({ budget: { deadlineAt: "2026-08-23T00:00:00.000Z" }, nodeStates: { N01: "READY", N02: "READY" } });
  const deadline = schedulerTick({ runsRoot: deadlineFixture.runsRoot, vaultRoot: deadlineFixture.vaultRoot, enabled: true, now: new Date("2026-08-23T00:00:01.000Z") });
  assert.equal(deadline.queued.length, 0);
  assert.equal(getDecision(deadlineFixture.runsRoot, deadline.budgetBlockers[0].decisionId).evidence.budgetCode, "DEADLINE_EXCEEDED");
  fs.rmSync(deadlineFixture.root, { recursive: true, force: true });

  const concurrencyFixture = fixture({ budget: { maxParallelAgents: 1 }, nodeCount: 3 });
  const concurrency = schedulerTick({ runsRoot: concurrencyFixture.runsRoot, vaultRoot: concurrencyFixture.vaultRoot, enabled: true, env: { ORCHESTRATOR_MAX_PARALLEL_JOBS: "3" }, now: new Date("2026-08-23T00:00:00.000Z") });
  assert.equal(concurrency.queued.length, 1);
  assert.equal(concurrency.budgetBlockers[0].budgetCode, "CONCURRENCY_CEILING");
  fs.rmSync(concurrencyFixture.root, { recursive: true, force: true });

  const retryFixture = fixture({ budget: { maxRetriesPerNode: 1 }, nodeStates: { N01: "FAILED", N02: "BLOCKED" } });
  assert.throws(() => requestNodeRetry({ runsRoot: retryFixture.runsRoot, objectiveId: retryFixture.objectiveId, nodeId: "N01", reason: "Retry ceiling fixture.", requestedBy: "human:retry-reviewer" }), (error) => error.code === "MAX_RETRIES_EXCEEDED");
  assert.equal(listDecisions(retryFixture.runsRoot).find((item) => item.type === "BUDGET_EXCEEDED")?.evidence.budgetCode, "RETRY_CEILING");
  fs.rmSync(retryFixture.root, { recursive: true, force: true });
} finally {
  // Fixtures are removed at each assertion boundary so completed evidence can be checked before cleanup.
}

console.log("orchestration-budget.test.mjs: All tests passed!");
