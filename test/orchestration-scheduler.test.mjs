import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObjective, getObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createDecision } from "../src/decision-store.mjs";
import { createOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { enqueueTaskJob, getJob, JOB_STATES, listJobs, updateJob } from "../src/job-queue.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import {
  orchestrationSchedulerEnabled,
  schedulerTick,
} from "../src/orchestration-scheduler.mjs";

console.log("Running orchestration-scheduler.test.mjs...");

const timestamp = "2026-08-23T00:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-scheduler-"));
const runsRoot = path.join(root, "runs");
const vaultRoot = path.join(root, "vault");
fs.mkdirSync(vaultRoot, { recursive: true });

function budget() {
  return { maxSubtasks: 4, maxParallelAgents: 1, maxRetriesPerNode: 2, maxTotalTokens: null, deadlineAt: null };
}

function planFor(objectiveId, planId) {
  const plan = {
    schemaVersion: 1,
    revision: 1,
    planId,
    objectiveId,
    state: "APPROVED",
    summary: "Sequential scheduler fixture.",
    architectureDecisions: [],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["scheduler-project"],
    nodes: [
      {
        nodeId: "N01",
        title: "Inspect scheduler input",
        purpose: "Inspect the scheduler input before any implementation begins.",
        projectId: "scheduler-project",
        role: "DIAGNOSTIC",
        type: "DIAGNOSTIC",
        dependsOn: [],
        acceptanceCriteria: ["The scheduler input is recorded."],
        allowedPaths: [],
        verification: ["test"],
        risk: "LOW",
        complexity: "LOW",
        requiresChanges: false,
        canRunInParallel: false,
        writeConflictGroup: null,
        contextFrom: [],
        skills: [],
      },
      {
        nodeId: "N02",
        title: "Apply scheduler result",
        purpose: "Apply the verified scheduler result after the diagnostic task completes.",
        projectId: "scheduler-project",
        role: "BACKEND",
        type: "IMPLEMENTATION",
        dependsOn: ["N01"],
        acceptanceCriteria: ["The scheduler result is applied safely."],
        allowedPaths: ["src/scheduler-result.js"],
        verification: ["test"],
        risk: "LOW",
        complexity: "LOW",
        requiresChanges: true,
        canRunInParallel: false,
        writeConflictGroup: "scheduler",
        contextFrom: ["N01"],
        skills: [],
      },
    ],
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
    risk: "LOW",
    complexity: "LOW",
    approvedBy: "human:scheduler",
    approvedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { ...plan, planFingerprint: planFingerprint(plan) };
}

function createFixture(objectiveId, { initialState = "CREATED", initialNodes = null } = {}) {
  const planId = `plan-${objectiveId}-r1`;
  const plan = planFor(objectiveId, planId);
  createObjective({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      objectiveId,
      mode: "EXISTING_PROJECT",
      state: "MATERIALIZING",
      request: "Run the sequential scheduler fixture.",
      requestedBy: "human:test",
      projectIds: ["scheduler-project"],
      freshProject: null,
      activePlanId: planId,
      activeOrchestrationId: `orch-${objectiveId}`,
      budget: budget(),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: ["scheduler-project"], budget: budget() } });
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
      requestedAction: "Approve this exact plan revision for later materialization",
      allowedChoices: ["APPROVE", "CANCEL"],
      creator: "SYSTEM",
      createdAt: timestamp,
      resolution: { action: "APPROVE", resolvedBy: "human:scheduler", resolvedAt: timestamp },
    },
  });
  const taskDirectory = path.join(vaultRoot, "02-Projects", "scheduler-project", "tasks");
  fs.mkdirSync(taskDirectory, { recursive: true });
  fs.writeFileSync(path.join(taskDirectory, "task-001.md"), "---\ntitle: Inspect scheduler input\ntask_id: TASK-001\nproject: scheduler-project\nstatus: BACKLOG\n---\n# Inspect scheduler input\n");
  fs.writeFileSync(path.join(taskDirectory, "task-002.md"), "---\ntitle: Apply scheduler result\ntask_id: TASK-002\nproject: scheduler-project\nstatus: BACKLOG\n---\n# Apply scheduler result\n");
  const nodes = initialNodes ?? {
    N01: { state: "READY", taskId: "TASK-001", jobId: null, runId: null, attempt: 1, blockedBy: [], lastError: null },
    N02: { state: "BLOCKED", taskId: "TASK-002", jobId: null, runId: null, attempt: 1, blockedBy: ["TASK-001"], lastError: null },
  };
  createOrchestration({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      orchestrationId: `orch-${objectiveId}`,
      objectiveId,
      planId,
      state: initialState,
      planFingerprint: plan.planFingerprint,
      nodes,
      integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null },
      usage: { totalTokens: 0, agentInvocations: 0, retries: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
      materialization: {
        state: "MATERIALIZED",
        materializedAt: timestamp,
        tasks: [
          { nodeId: "N01", projectId: "scheduler-project", taskId: "TASK-001", path: "02-Projects/scheduler-project/tasks/task-001.md", dependencies: [], orchestrationDependencies: [] },
          { nodeId: "N02", projectId: "scheduler-project", taskId: "TASK-002", path: "02-Projects/scheduler-project/tasks/task-002.md", dependencies: ["TASK-001"], orchestrationDependencies: ["scheduler-project:TASK-001"] },
        ],
      },
    },
    validationOptions: { plan },
  });
  return { plan, orchestrationId: `orch-${objectiveId}` };
}

try {
  assert.equal(orchestrationSchedulerEnabled({ ORCHESTRATOR_OBJECTIVE_SCHEDULER: "0" }), false);
  assert.equal(orchestrationSchedulerEnabled({ ORCHESTRATOR_OBJECTIVE_SCHEDULER: "1" }), true);
  assert.equal(schedulerTick({ runsRoot, enabled: false }).action, "DISABLED");

  const fixture = createFixture("obj-scheduler");
  const first = schedulerTick({ vaultRoot, runsRoot, enabled: true, now: new Date(timestamp) });
  assert.equal(first.queued.length, 1);
  assert.equal(first.queued[0].taskId, "TASK-001");
  assert.equal(first.queued[0].objectiveId, "obj-scheduler");
  assert.equal(first.queued[0].planId, fixture.plan.planId);
  assert.equal(first.queued[0].orchestrationId, fixture.orchestrationId);
  assert.equal(first.queued[0].nodeId, "N01");
  assert.equal(first.queued[0].planApproval.decisionId, `decision-plan-approval-${fixture.plan.planId}`);
  assert.equal(first.queued[0].planApproval.planFingerprint, fixture.plan.planFingerprint);
  assert.equal(getOrchestration(runsRoot, fixture.orchestrationId).nodes.N01.state, "QUEUED");
  assert.equal(getOrchestration(runsRoot, fixture.orchestrationId).nodes.N02.state, "BLOCKED");
  assert.equal(listJobs(runsRoot).length, 1);

  const repeated = schedulerTick({ vaultRoot, runsRoot, enabled: true });
  assert.equal(repeated.queued.length, 0);
  assert.equal(listJobs(runsRoot).length, 1);

  const firstJob = listJobs(runsRoot)[0];
  updateJob(runsRoot, firstJob.jobId, { state: JOB_STATES.DONE, runState: "DONE" });
  const second = schedulerTick({ vaultRoot, runsRoot, enabled: true });
  assert.equal(second.queued.length, 1);
  assert.equal(second.queued[0].taskId, "TASK-002");
  assert.equal(getOrchestration(runsRoot, fixture.orchestrationId).nodes.N01.state, "DONE");
  assert.equal(getOrchestration(runsRoot, fixture.orchestrationId).nodes.N02.state, "QUEUED");
  assert.equal(listJobs(runsRoot).length, 2);

  const failed = createFixture("obj-scheduler-failed");
  schedulerTick({ vaultRoot, runsRoot, enabled: true });
  const failedRootJob = listJobs(runsRoot).find((job) => job.orchestrationId === failed.orchestrationId);
  updateJob(runsRoot, failedRootJob.jobId, { state: JOB_STATES.FAILED, error: "diagnostic failed" });
  const afterFailure = schedulerTick({ vaultRoot, runsRoot, enabled: true });
  assert.equal(afterFailure.queued.some((job) => job.orchestrationId === failed.orchestrationId), false);
  const failedState = getOrchestration(runsRoot, failed.orchestrationId);
  assert.equal(failedState.state, "BLOCKED");
  assert.equal(failedState.nodes.N01.state, "FAILED");
  assert.equal(failedState.nodes.N02.state, "BLOCKED");
  assert.equal(failedState.nodes.N02.lastError.code, "PREDECESSOR_FAILED");

  const uncertain = createFixture("obj-scheduler-restart", {
    initialState: "RUNNING",
    initialNodes: {
      N01: { state: "RUNNING", taskId: "TASK-001", jobId: "job-missing-after-restart", runId: "run-uncertain", attempt: 1, blockedBy: [], lastError: null },
      N02: { state: "BLOCKED", taskId: "TASK-002", jobId: null, runId: null, attempt: 1, blockedBy: ["TASK-001"], lastError: null },
    },
  });
  const restart = schedulerTick({ vaultRoot, runsRoot, enabled: true });
  assert.equal(restart.queued.some((job) => job.orchestrationId === uncertain.orchestrationId), false);
  const restartState = getOrchestration(runsRoot, uncertain.orchestrationId);
  assert.equal(restartState.state, "BLOCKED");
  assert.equal(restartState.nodes.N01.lastError.code, "MISSING_NODE_JOB");
  assert.equal(listJobs(runsRoot).some((job) => job.orchestrationId === uncertain.orchestrationId), false);

  assert.throws(() => enqueueTaskJob({
    runsRoot,
    projectId: "scheduler-project",
    taskId: "TASK-MANUAL",
    taskPath: "02-Projects/scheduler-project/tasks/task-manual.md",
    orchestrationManaged: true,
  }), (error) => error.code === "ORCHESTRATION_MANAGED_TASK");
  assert.equal(getJob(runsRoot, firstJob.jobId).state, JOB_STATES.DONE);
} finally {
  // Fixture roots are temporary and intentionally left for failure diagnostics.
}

console.log("orchestration-scheduler.test.mjs: All tests passed!");
