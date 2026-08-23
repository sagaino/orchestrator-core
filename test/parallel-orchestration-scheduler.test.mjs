import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createDecision } from "../src/decision-store.mjs";
import { createOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { claimNextJob, getJob, JOB_STATES, listJobs, updateJob } from "../src/job-queue.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { schedulerTick } from "../src/orchestration-scheduler.mjs";

console.log("Running parallel-orchestration-scheduler.test.mjs...");

const timestamp = "2026-08-23T00:00:00.000Z";

function budget(maxParallelAgents = 3) {
  return { maxSubtasks: 4, maxParallelAgents, maxRetriesPerNode: 2, maxTotalTokens: null, deadlineAt: null };
}

function planFor(objectiveId, planId) {
  const nodes = [
    ["N01", "project-a", "DIAGNOSTIC", []],
    ["N02", "project-b", "BACKEND", []],
    ["N03", "project-c", "FRONTEND", []],
    ["N04", "project-a", "TESTING", ["N01"]],
  ].map(([nodeId, projectId, role, dependsOn]) => ({
    nodeId,
    title: `${nodeId} task`,
    purpose: `${nodeId} purpose`,
    projectId,
    role,
    type: role === "TESTING" ? "VERIFICATION" : role === "DIAGNOSTIC" ? "DIAGNOSTIC" : "IMPLEMENTATION",
    dependsOn,
    acceptanceCriteria: [`${nodeId} acceptance passes.`],
    allowedPaths: ["DIAGNOSTIC", "TESTING"].includes(role) ? [] : [`src/${nodeId.toLowerCase()}.js`],
    verification: ["test"],
    risk: "LOW",
    complexity: "LOW",
    requiresChanges: !["DIAGNOSTIC", "TESTING"].includes(role),
    canRunInParallel: dependsOn.length === 0,
    writeConflictGroup: projectId,
    contextFrom: dependsOn,
    skills: [],
  }));
  const plan = {
    schemaVersion: 1,
    revision: 1,
    planId,
    objectiveId,
    state: "APPROVED",
    summary: "Parallel distinct-project scheduler fixture.",
    architectureDecisions: [],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["project-a", "project-b", "project-c"],
    nodes,
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
    risk: "LOW",
    complexity: "LOW",
    approvedBy: "human:parallel-test",
    approvedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { ...plan, planFingerprint: planFingerprint(plan) };
}

function createFixture({ maxParallelAgents = 3 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-orchestration-") );
  const runsRoot = path.join(root, "runs");
  const vaultRoot = path.join(root, "vault");
  const objectiveId = `obj-${path.basename(root)}`;
  const planId = `plan-${objectiveId}`;
  const plan = planFor(objectiveId, planId);
  const objectiveBudget = budget(maxParallelAgents);
  fs.mkdirSync(vaultRoot, { recursive: true });
  createObjective({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      objectiveId,
      mode: "CROSS_PROJECT_INCIDENT",
      state: "MATERIALIZING",
      request: "Run parallel scheduler fixture.",
      requestedBy: "human:test",
      projectIds: ["project-a", "project-b", "project-c"],
      freshProject: null,
      activePlanId: planId,
      activeOrchestrationId: `orch-${objectiveId}`,
      budget: objectiveBudget,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: plan.projects, budget: objectiveBudget } });
  createDecision({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      decisionId: `decision-plan-approval-${planId}`,
      objectiveId,
      nodeId: null,
      runId: null,
      type: "PLAN_APPROVAL",
      state: "RESOLVED",
      evidence: { planId, planFingerprint: plan.planFingerprint },
      requestedAction: "Approve the parallel scheduler fixture.",
      allowedChoices: ["APPROVE", "CANCEL"],
      creator: "SYSTEM",
      createdAt: timestamp,
      resolution: { action: "APPROVE", resolvedBy: "human:parallel-test", resolvedAt: timestamp },
    },
  });
  const tasks = plan.nodes.map((node) => ({
    nodeId: node.nodeId,
    projectId: node.projectId,
    taskId: `TASK-${node.nodeId}`,
    path: `02-Projects/${node.projectId}/tasks/${node.nodeId}.md`,
    dependencies: node.dependsOn,
    orchestrationDependencies: node.dependsOn.map((dependency) => `${plan.nodes.find((item) => item.nodeId === dependency)?.projectId}:${dependency}`),
  }));
  createOrchestration({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      orchestrationId: `orch-${objectiveId}`,
      objectiveId,
      planId,
      state: "CREATED",
      planFingerprint: plan.planFingerprint,
      nodes: {
        N01: { state: "READY", taskId: "TASK-N01", jobId: null, runId: null, attempt: 1, blockedBy: [], lastError: null },
        N02: { state: "READY", taskId: "TASK-N02", jobId: null, runId: null, attempt: 1, blockedBy: [], lastError: null },
        N03: { state: "READY", taskId: "TASK-N03", jobId: null, runId: null, attempt: 1, blockedBy: [], lastError: null },
        N04: { state: "BLOCKED", taskId: "TASK-N04", jobId: null, runId: null, attempt: 1, blockedBy: ["TASK-N01"], lastError: null },
      },
      integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null },
      usage: { totalTokens: 0, agentInvocations: 0, retries: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
      materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks },
    },
    validationOptions: { plan },
  });
  return { runsRoot, vaultRoot, objectiveId, orchestrationId: `orch-${objectiveId}`, plan };
}

const fixture = createFixture();
const env = { ORCHESTRATOR_MAX_PARALLEL_JOBS: "2" };
const first = schedulerTick({ runsRoot: fixture.runsRoot, vaultRoot: fixture.vaultRoot, enabled: true, env, now: new Date(timestamp) });
assert.deepEqual(first.queued.map((job) => job.nodeId), ["N01", "N02"]);
assert.equal(new Set(first.queued.map((job) => job.projectId)).size, 2);
assert.equal(first.queued.length, 2, "global ceiling limits one objective to two queued workers");

const repeated = schedulerTick({ runsRoot: fixture.runsRoot, vaultRoot: fixture.vaultRoot, enabled: true, env });
assert.equal(repeated.queued.length, 0, "repeated ticks do not duplicate queued nodes");
assert.equal(listJobs(fixture.runsRoot).length, 2);

const firstClaim = claimNextJob(fixture.runsRoot);
const secondClaim = claimNextJob(fixture.runsRoot);
assert.ok(firstClaim);
assert.ok(secondClaim);
assert.notEqual(firstClaim.projectId, secondClaim.projectId, "project-exclusive leases still allow distinct projects to run concurrently");
assert.equal(listJobs(fixture.runsRoot).filter((job) => job.state === JOB_STATES.RUNNING).length, 2);

updateJob(fixture.runsRoot, firstClaim.jobId, { state: JOB_STATES.DONE, runState: "DONE" });
updateJob(fixture.runsRoot, secondClaim.jobId, { state: JOB_STATES.DONE, runState: "DONE" });
const next = schedulerTick({ runsRoot: fixture.runsRoot, vaultRoot: fixture.vaultRoot, enabled: true, env });
assert.deepEqual(next.queued.map((job) => job.nodeId), ["N03", "N04"]);
assert.equal(getOrchestration(fixture.runsRoot, fixture.orchestrationId).nodes.N01.state, "DONE");
assert.equal(getOrchestration(fixture.runsRoot, fixture.orchestrationId).nodes.N04.state, "QUEUED");

const failedFixture = createFixture({ maxParallelAgents: 3 });
const failedFirst = schedulerTick({ runsRoot: failedFixture.runsRoot, vaultRoot: failedFixture.vaultRoot, enabled: true, env });
const failedRoot = failedFirst.queued.find((job) => job.nodeId === "N01");
const independent = failedFirst.queued.find((job) => job.nodeId === "N02");
updateJob(failedFixture.runsRoot, failedRoot.jobId, { state: JOB_STATES.FAILED, error: "branch A failed" });
updateJob(failedFixture.runsRoot, independent.jobId, { state: JOB_STATES.DONE, runState: "DONE" });
const afterFailure = schedulerTick({ runsRoot: failedFixture.runsRoot, vaultRoot: failedFixture.vaultRoot, enabled: true, env });
const failedState = getOrchestration(failedFixture.runsRoot, failedFixture.orchestrationId);
assert.deepEqual(afterFailure.queued.map((job) => job.nodeId), ["N03"], "unrelated branch remains schedulable");
assert.equal(failedState.nodes.N01.state, "FAILED");
assert.equal(failedState.nodes.N04.state, "BLOCKED");
assert.equal(failedState.nodes.N04.lastError.code, "PREDECESSOR_FAILED");
assert.equal(failedState.nodes.N02.state, "DONE", "unrelated branch may finish despite failed branch");
assert.equal(failedState.state, "RUNNING");
updateJob(failedFixture.runsRoot, afterFailure.queued[0].jobId, { state: JOB_STATES.DONE, runState: "DONE" });
const fullyFailed = schedulerTick({ runsRoot: failedFixture.runsRoot, vaultRoot: failedFixture.vaultRoot, enabled: true, env });
assert.equal(fullyFailed.queued.length, 0);
assert.equal(getOrchestration(failedFixture.runsRoot, failedFixture.orchestrationId).state, "BLOCKED");

const missingJobFixture = createFixture({ maxParallelAgents: 3 });
const missingJobRun = getOrchestration(missingJobFixture.runsRoot, missingJobFixture.orchestrationId);
missingJobRun.nodes.N01 = { ...missingJobRun.nodes.N01, state: "RUNNING", jobId: "missing-job", runId: "uncertain-run" };
missingJobRun.nodes.N02 = { ...missingJobRun.nodes.N02, state: "BLOCKED", lastError: { code: "TEST_BLOCKED" } };
missingJobRun.nodes.N03 = { ...missingJobRun.nodes.N03, state: "BLOCKED", lastError: { code: "TEST_BLOCKED" } };
// Persisting an uncertain active node is intentionally represented by a durable
// orchestration mutation in production; the scheduler must block it, not replay it.
const orchestrationPath = path.join(missingJobFixture.runsRoot, `orchestrations/${missingJobFixture.orchestrationId}.json`);
const persisted = JSON.parse(fs.readFileSync(orchestrationPath, "utf8"));
persisted.nodes = missingJobRun.nodes;
fs.writeFileSync(orchestrationPath, `${JSON.stringify(persisted, null, 2)}\n`);
const restart = schedulerTick({ runsRoot: missingJobFixture.runsRoot, vaultRoot: missingJobFixture.vaultRoot, enabled: true, env });
assert.equal(restart.queued.length, 0, "restart reconciliation never replays an uncertain node");
assert.equal(getOrchestration(missingJobFixture.runsRoot, missingJobFixture.orchestrationId).nodes.N01.lastError.code, "MISSING_NODE_JOB");
assert.equal(listJobs(missingJobFixture.runsRoot).length, 0);

console.log("parallel-orchestration-scheduler.test.mjs: All tests passed!");
