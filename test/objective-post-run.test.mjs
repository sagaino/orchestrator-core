import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObjective, getObjective, updateObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createOrchestration, getOrchestration, updateOrchestration } from "../src/orchestration-store.mjs";
import { automaticPostRunTick } from "../src/objective-post-run.mjs";

console.log("Running objective-post-run.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "objective-post-run-"));
const runsRoot = path.join(root, "runs");
const vaultRoot = path.join(root, "vault");
const timestamp = "2026-08-24T00:00:00.000Z";
const objectiveId = "obj-post-run-fixture";
const planId = "plan-post-run-fixture-r1";
const orchestrationId = "orch-post-run-fixture";
const runId = "run-post-run-fixture";
const fingerprint = "a".repeat(64);
const budget = { maxSubtasks: 1, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: null, deadlineAt: null };

try {
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(path.join(runsRoot, "integration", orchestrationId), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, "integration", orchestrationId, "aggregate-evidence.json"), JSON.stringify({ status: "PASSED" }));
  fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    runId,
    state: "DONE",
    createdAt: timestamp,
    updatedAt: timestamp,
    approval: null,
    task: { id: "TASK-FIXTURE", title: "Post-run fixture", path: "fixture.md", status: "DONE", allowedPaths: [] },
    project: { id: "shop", repository: path.join(root, "shop") },
    taskFingerprint: "fixture",
    graph: null,
    retrieval: null,
    plan: { verificationCommands: [] },
    execution: {
      claimedAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      result: { gitCommit: { commitHash: "b".repeat(40), parentCommit: "c".repeat(40), commitMessage: "fixture" } },
      workspace: { state: "CLEANED", path: path.join(root, "missing-workspace"), appliedPaths: [] },
      scopeAudit: { changedPaths: [], outOfScopePaths: [] },
      verification: { results: [{ script: "test", status: "PASS", passed: true }] },
    },
    knowledge: { approval: { approvedAt: timestamp, approvedBy: "system:autopilot", destination: "PROJECT" }, sync: { syncedAt: timestamp } },
    completion: { completedAt: timestamp, completedBy: "system:autopilot" },
    history: [],
  }, null, 2));

  const node = {
    nodeId: "node-fixture",
    title: "Post-run fixture node",
    purpose: "Exercise automatic post-run delivery gates.",
    projectId: "shop",
    role: "DIAGNOSTIC",
    type: "DIAGNOSTIC",
    dependsOn: [],
    acceptanceCriteria: ["The post-run pipeline is complete."],
    allowedPaths: [],
    verification: ["test"],
    risk: "LOW",
    complexity: "LOW",
    requiresChanges: false,
    canRunInParallel: false,
    writeConflictGroup: null,
    contextFrom: [],
    skills: [],
  };
  const plan = {
    schemaVersion: 1,
    planId,
    objectiveId,
    revision: 1,
    state: "APPROVED",
    summary: "Post-run fixture plan.",
    architectureDecisions: [],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["shop"],
    nodes: [node],
    verificationIntent: {
      status: "RESOLVED",
      requested: [{ capability: "UNIT", script: "test", source: "PROJECT_DEFAULT" }],
      resolved: [{ capability: "UNIT", script: "test", source: "PROJECT_DEFAULT" }],
      missing: [],
    },
    integration: { required: true, projectVerification: ["test"], crossProjectVerification: [], previewRequired: false },
    risk: "LOW",
    complexity: "LOW",
    approvedBy: "fixture-user",
    approvedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    planFingerprint: fingerprint,
  };
  createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING", request: "Exercise post-run automation.", requestedBy: "fixture-user", projectIds: ["shop"], freshProject: null, activePlanId: planId, activeOrchestrationId: orchestrationId, budget, createdAt: timestamp, updatedAt: timestamp } });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: ["shop"], budget } });
  createOrchestration({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      orchestrationId,
      objectiveId,
      planId,
      state: "DONE",
      planFingerprint: fingerprint,
      nodes: { [node.nodeId]: { state: "DONE", taskId: "TASK-FIXTURE", jobId: null, runId, attempt: 1, blockedBy: [], lastError: null } },
      integration: { state: "RUNNING", projectBaselines: {}, artifacts: [], verification: [], rollback: null, startedAt: timestamp },
      usage: { totalTokens: 0, agentInvocations: 0, retries: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
      postRunAutomation: { status: "WAITING", phase: "INTEGRATION", lastAttemptAt: "2026-08-23T00:00:00.000Z" },
    },
    validationOptions: { plan },
  });

  const result = await automaticPostRunTick({
    runsRoot,
    vaultRoot,
    env: { ORCHESTRATOR_APPROVAL_MODE: "PLAN_REVIEW_THEN_AUTOPILOT" },
    now: new Date("2026-08-24T00:01:00.000Z"),
    services: {
      startIntegration: async ({ runsRoot: integrationRunsRoot, orchestrationId: targetId }) => {
        const current = getOrchestration(integrationRunsRoot, targetId, { plan });
        const orchestration = updateOrchestration({
          runsRoot: integrationRunsRoot,
          orchestrationId: targetId,
          expectedRevision: current.revision,
          now: new Date("2026-08-24T00:01:00.000Z"),
          update: (record) => ({ ...record, state: "DONE", integration: { ...record.integration, state: "PASSED", verification: [{ script: "test", status: "PASS" }] } }),
          validationOptions: { plan },
        });
        return { action: "INTEGRATION_COMPLETED", orchestration };
      },
    },
  });
  assert.equal(result.completed.length, 1);
  assert.equal(result.exceptions.length, 0);
  assert.equal(getOrchestration(runsRoot, orchestrationId, { plan }).postRunAutomation.status, "COMPLETED");
  assert.equal(getObjective(runsRoot, objectiveId).state, "RESULT_REVIEW");

  const idempotent = await automaticPostRunTick({ runsRoot, vaultRoot, env: { ORCHESTRATOR_APPROVAL_MODE: "PLAN_REVIEW_THEN_AUTOPILOT" }, now: new Date("2026-08-24T00:02:00.000Z") });
  assert.equal(idempotent.completed.length, 0);
  assert.equal(idempotent.blocked.length, 0);
  assert.equal(idempotent.exceptions.length, 0);
  assert.equal(idempotent.skipped.length, 0);

  updateObjective({
    runsRoot,
    objectiveId,
    expectedRevision: getObjective(runsRoot, objectiveId).revision,
    now: new Date("2026-08-24T00:03:00.000Z"),
    patch: { state: "RUNNING" },
  });
  const blockedOrchestration = getOrchestration(runsRoot, orchestrationId, { plan });
  updateOrchestration({
    runsRoot,
    orchestrationId,
    expectedRevision: blockedOrchestration.revision,
    now: new Date("2026-08-24T00:03:00.000Z"),
    update: (record) => ({ ...record, postRunAutomation: { ...record.postRunAutomation, status: "BLOCKED", phase: "DELIVERY_GATES", lastAttemptAt: timestamp } }),
    validationOptions: { plan },
  });
  let previewCalls = 0;
  const blocked = await automaticPostRunTick({
    runsRoot,
    vaultRoot,
    env: { ORCHESTRATOR_APPROVAL_MODE: "PLAN_REVIEW_THEN_AUTOPILOT" },
    now: new Date("2026-08-24T00:04:00.000Z"),
    services: {
      devServerManager: { startAggregateProjectPreview: async () => { previewCalls += 1; throw new Error("must not retry blocked post-run"); } },
    },
  });
  assert.equal(blocked.completed.length, 0);
  assert.equal(blocked.exceptions.length, 0);
  assert.equal(blocked.skipped[0].reason, "BLOCKED_REQUIRES_REVIEW");
  assert.equal(previewCalls, 0);
  assert.equal(getObjective(runsRoot, objectiveId).state, "BLOCKED");

  const disabled = await automaticPostRunTick({ runsRoot, vaultRoot, env: { ORCHESTRATOR_APPROVAL_MODE: "MANUAL" } });
  assert.equal(disabled.enabled, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("objective-post-run.test.mjs: All tests passed!");
