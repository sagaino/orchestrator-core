import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createOrchestration } from "../src/orchestration-store.mjs";
import { buildObjectiveEvidence, acceptObjective } from "../src/objective-evidence.mjs";

console.log("Running objective-evidence.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "objective-evidence-"));
const runsRoot = path.join(root, "runs");
const timestamp = "2026-08-23T00:00:00.000Z";
const objectiveId = "objective-evidence-fixture";
const planId = "plan-objective-evidence-fixture-r1";
const orchestrationId = "orch-objective-evidence-fixture";
const planFingerprint = "a".repeat(64);
const budget = { maxSubtasks: 2, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: 1000, deadlineAt: null };

createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "BLOCKED", request: "Review objective evidence fixture.", requestedBy: "fixture-user", projectIds: ["fixture-project"], freshProject: null, activePlanId: planId, activeOrchestrationId: orchestrationId, budget, createdAt: timestamp, updatedAt: timestamp } });
createPlan({
  runsRoot,
  record: {
    schemaVersion: 1, revision: 1, planId, objectiveId, state: "APPROVED", summary: "Evidence fixture plan.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null, projects: ["fixture-project"],
    nodes: [{ nodeId: "N01", title: "Inspect fixture", purpose: "Inspect the fixture.", projectId: "fixture-project", role: "DIAGNOSTIC", type: "DIAGNOSTIC", dependsOn: [], acceptanceCriteria: ["Evidence is available."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [] }],
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false }, risk: "LOW", complexity: "LOW", approvedBy: "fixture-user", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, planFingerprint,
  },
  validationOptions: { knownProjectIds: ["fixture-project"], budget },
});
createOrchestration({
  runsRoot,
  record: {
    schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId, state: "BLOCKED", planFingerprint,
    nodes: { N01: { state: "BLOCKED", taskId: "TASK-N01", jobId: null, runId: null, attempt: 1, blockedBy: [], lastError: { code: "FIXTURE_BLOCKED", message: "Fixture blocker." } } },
    integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 12, agentInvocations: 1, retries: 0 }, createdAt: timestamp, updatedAt: timestamp,
    materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: [] },
  },
  validationOptions: { plan: { nodes: [{ nodeId: "N01" }] } },
});

const evidence = buildObjectiveEvidence({ runsRoot, objectiveId });
assert.equal(evidence.mode, "objective-evidence");
assert.equal(evidence.nodes[0].nodeId, "N01");
assert.equal(evidence.nodes[0].state, "BLOCKED");
assert.equal(evidence.usage.actual.totalTokens, 12);
assert.equal(evidence.finalAcceptance.canAccept, false);
assert.equal(evidence.blockers[0].kind, "NODE");
assert.throws(() => acceptObjective({ runsRoot, objectiveId, acceptedBy: "fixture-user" }), (error) => error.code === "OBJECTIVE_ACCEPTANCE_BLOCKED");
console.log("objective-evidence.test.mjs: All tests passed!");
