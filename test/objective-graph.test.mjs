import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createOrchestration } from "../src/orchestration-store.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { buildObjectiveGraph } from "../src/objective-graph.mjs";

console.log("Running objective-graph.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "objective-graph-"));
const objectiveId = "obj-graph-fixture";
const planId = "plan-obj-graph-fixture-r1";
const orchestrationId = "orch-obj-graph-fixture";
const timestamp = "2026-08-23T00:00:00.000Z";
const nodes = Array.from({ length: 7 }, (_, index) => ({
  nodeId: `N${String(index + 1).padStart(2, "0")}`,
  title: `Node ${index + 1}`,
  purpose: "Graph fixture node",
  projectId: index % 2 ? "backend" : "frontend",
  role: index === 0 ? "DIAGNOSTIC" : index % 2 ? "BACKEND" : "FRONTEND",
  type: index === 0 ? "DIAGNOSTIC" : "IMPLEMENTATION",
  dependsOn: index === 0 ? [] : [`N${String(index).padStart(2, "0")}`],
  acceptanceCriteria: ["Node is represented in the graph."],
  allowedPaths: index === 0 ? [] : [`src/node-${index + 1}.js`],
  verification: ["test"],
  risk: "LOW",
  complexity: "LOW",
  requiresChanges: index !== 0,
  canRunInParallel: false,
  writeConflictGroup: null,
  contextFrom: [],
  skills: [],
}));
const plan = {
  schemaVersion: 1,
  revision: 1,
  planId,
  objectiveId,
  state: "APPROVED",
  summary: "Graph fixture",
  architectureDecisions: [],
  assumptions: [],
  clarificationNeeded: false,
  clarificationQuestion: null,
  projects: ["frontend", "backend"],
  nodes,
  integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
  risk: "LOW",
  complexity: "LOW",
  approvedBy: "fixture",
  approvedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
plan.planFingerprint = planFingerprint(plan);

try {
  createObjective({ runsRoot: root, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING", request: "Render a bounded objective graph.", requestedBy: "fixture", projectIds: ["frontend", "backend"], freshProject: null, activePlanId: planId, activeOrchestrationId: orchestrationId, budget: { maxSubtasks: 10, maxParallelAgents: 2, maxRetriesPerNode: 1, maxTotalTokens: 1000, deadlineAt: null }, createdAt: timestamp, updatedAt: timestamp } });
  createPlan({ runsRoot: root, record: plan, validationOptions: { knownProjectIds: ["frontend", "backend"], budget: { maxSubtasks: 10, maxParallelAgents: 2, maxRetriesPerNode: 1, maxTotalTokens: 1000 } } });
  createOrchestration({ runsRoot: root, record: { schemaVersion: 1, revision: 3, orchestrationId, objectiveId, planId, state: "RUNNING", planFingerprint: plan.planFingerprint, nodes: Object.fromEntries(nodes.map((node, index) => [node.nodeId, { state: index < 2 ? "DONE" : "READY", taskId: `task-${node.nodeId}`, jobId: index < 2 ? `job-${node.nodeId}` : null, runId: index < 2 ? `run-${node.nodeId}` : null, attempt: 1, blockedBy: [], lastError: null }])), integration: { state: "NOT_REQUIRED", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 10, agentInvocations: 2, retries: 0 }, createdAt: timestamp, updatedAt: timestamp, materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: [] } }, validationOptions: { plan } });

  const first = buildObjectiveGraph({ runsRoot: root, objectiveId, page: 1, pageSize: 3 });
  const firstAgain = buildObjectiveGraph({ runsRoot: root, objectiveId, page: 1, pageSize: 3 });
  assert.deepEqual(firstAgain, first);
  assert.equal(first.bounded, true);
  assert.equal(first.nodes.length, 3);
  assert.equal(first.summary.totalNodes, 7);
  assert.equal(first.summary.totalEdges, 6);
  assert.equal(first.summary.totalPages, 3);
  assert.equal(first.summary.hasNext, true);
  assert.equal(first.nodes[0].statusLabel, "DONE");
  assert.deepEqual(first.edges.map((edge) => edge.id), ["N01->N02", "N02->N03"]);

  const last = buildObjectiveGraph({ runsRoot: root, objectiveId, page: 99, pageSize: 3 });
  assert.equal(last.summary.page, 3);
  assert.equal(last.summary.hasNext, false);
  assert.deepEqual(last.nodes.map((node) => node.id), ["N07"]);

  const capped = buildObjectiveGraph({ runsRoot: root, objectiveId, pageSize: 1000 });
  assert.equal(capped.summary.pageSize, 100);
  assert.equal(capped.nodes.length, 7);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("objective-graph.test.mjs: All tests passed!");
