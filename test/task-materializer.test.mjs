import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObjective } from "../src/objective-store.mjs";
import { createPlanRevision, approvePlan, planFingerprint } from "../src/plan-lifecycle.mjs";
import { getOrchestration } from "../src/orchestration-store.mjs";
import { getObjective } from "../src/objective-store.mjs";
import { materializeApprovedPlan } from "../src/task-materializer.mjs";
import { readMarkdown, buildContext } from "../src/core.mjs";
import { validateTaskReadiness } from "../src/task-readiness.mjs";
import { clearFaultInjection, configureFaultInjection } from "../src/fault-injection.mjs";

console.log("Running task-materializer.test.mjs...");

const timestamp = "2026-08-23T00:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-materializer-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repositories = new Map();
fs.mkdirSync(vaultRoot, { recursive: true });

for (const projectId of ["frontend", "backend"]) {
  const repository = path.join(root, projectId);
  repositories.set(projectId, repository);
  fs.mkdirSync(repository, { recursive: true });
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --version" } }));
  const page = path.join(vaultRoot, "02-Projects", projectId, "project.md");
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, `---\ntype: project\n---\n\n# ${projectId}\n`);
}
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| frontend | [[02-Projects/frontend/project.md]] | ${repositories.get("frontend")} | agy | false | ${root}/frontend/graph.json |`,
  `| backend | [[02-Projects/backend/project.md]] | ${repositories.get("backend")} | agy | false | ${root}/backend/graph.json |`,
].join("\n"));

function objective(objectiveId) {
  return createObjective({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      objectiveId,
      mode: "CROSS_PROJECT_INCIDENT",
      state: "PLANNING",
      request: "Repair the checkout flow across the frontend and backend projects.",
      requestedBy: "human:test",
      projectIds: ["frontend", "backend"],
      freshProject: null,
      activePlanId: null,
      activeOrchestrationId: null,
      budget: { maxSubtasks: 4, maxParallelAgents: 2, maxRetriesPerNode: 2, maxTotalTokens: null, deadlineAt: null },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
}

function candidate(objectiveId) {
  return {
    schemaVersion: 1,
    planId: "placeholder",
    objectiveId,
    revision: 1,
    state: "PENDING_APPROVAL",
    summary: "Repair the checkout flow with an explicit cross-project dependency.",
    architectureDecisions: ["Keep the backend contract as the integration source of truth."],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["frontend", "backend"],
    nodes: [
      {
        nodeId: "N01",
        title: "Diagnose checkout contract",
        purpose: "Identify the checkout contract mismatch before implementation begins.",
        projectId: "backend",
        role: "DIAGNOSTIC",
        type: "DIAGNOSTIC",
        dependsOn: [],
        acceptanceCriteria: ["The contract mismatch is recorded for downstream tasks."],
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
        title: "Implement checkout adapter",
        purpose: "Implement the frontend adapter that consumes the approved checkout contract.",
        projectId: "frontend",
        role: "FRONTEND",
        type: "IMPLEMENTATION",
        dependsOn: ["N01"],
        acceptanceCriteria: ["The adapter consumes the documented checkout contract."],
        allowedPaths: ["src/checkout-adapter.js"],
        verification: ["test"],
        risk: "MEDIUM",
        complexity: "MEDIUM",
        requiresChanges: true,
        canRunInParallel: false,
        writeConflictGroup: "checkout",
        contextFrom: ["N01"],
        skills: [],
      },
      {
        nodeId: "N03",
        title: "Verify checkout integration",
        purpose: "Verify the materialized frontend and backend checkout work together.",
        projectId: "frontend",
        role: "TESTING",
        type: "VERIFICATION",
        dependsOn: ["N02"],
        acceptanceCriteria: ["The checkout integration verification result is recorded."],
        allowedPaths: [],
        verification: ["test"],
        risk: "LOW",
        complexity: "LOW",
        requiresChanges: false,
        canRunInParallel: false,
        writeConflictGroup: null,
        contextFrom: ["N02"],
        skills: [],
      },
    ],
    integration: { required: true, projectVerification: ["test"], crossProjectVerification: ["test"], previewRequired: true },
    risk: "MEDIUM",
    complexity: "MEDIUM",
    approvedBy: null,
    approvedAt: null,
    createdAt: timestamp,
  };
}

function approve(objectiveId) {
  const planned = createPlanRevision({ runsRoot, objectiveId, candidate: candidate(objectiveId), now: new Date(timestamp) });
  const fingerprint = planFingerprint(planned.plan);
  return approvePlan({ runsRoot, objectiveId, planId: planned.plan.planId, expectedFingerprint: fingerprint, approvedBy: "human:operator", now: new Date(timestamp) });
}

try {
  const firstObjective = objective("obj-materialize-one");
  const approved = approve(firstObjective.objectiveId);
  const result = materializeApprovedPlan({
    vaultRoot,
    runsRoot,
    objectiveId: firstObjective.objectiveId,
    planId: approved.plan.planId,
    expectedFingerprint: approved.planFingerprint,
    now: new Date(timestamp),
  });

  assert.equal(result.action, "TASKS_MATERIALIZED");
  assert.equal(result.tasks.length, 3);
  assert.equal(result.objective.state, "MATERIALIZING");
  assert.equal(result.orchestration.state, "CREATED");
  assert.equal(result.orchestration.nodes.N01.state, "READY");
  assert.equal(result.orchestration.nodes.N02.state, "BLOCKED");
  assert.equal(result.orchestration.nodes.N02.blockedBy[0], "TASK-001");
  assert.equal(result.orchestration.nodes.N02.jobId, null);
  assert.equal(result.orchestration.nodes.N02.runId, null);

  const backendTask = readMarkdown(path.join(vaultRoot, result.tasks.find((task) => task.projectId === "backend").relativePath), vaultRoot);
  const frontendTask = readMarkdown(path.join(vaultRoot, result.tasks.find((task) => task.projectId === "frontend" && task.nodeId === "N02").relativePath), vaultRoot);
  assert.equal(backendTask.metadata.objective_id, firstObjective.objectiveId);
  assert.equal(backendTask.metadata.plan_id, approved.plan.planId);
  assert.equal(backendTask.metadata.orchestration_managed, true);
  assert.equal(backendTask.metadata.node_id, "N01");
  assert.deepEqual(frontendTask.metadata.dependencies, []);
  assert.deepEqual(frontendTask.metadata.orchestration_dependencies, ["backend:TASK-001"]);
  assert.equal(frontendTask.metadata.master_task, firstObjective.objectiveId);
  assert.match(frontendTask.body, /The adapter consumes the documented checkout contract\./);
  assert.match(frontendTask.body, /src\/checkout-adapter\.js/);

  const rootReadiness = validateTaskReadiness(buildContext(vaultRoot, "backend", backendTask.path), { readMarkdown });
  assert.equal(rootReadiness.ready, true);
  const verificationTask = readMarkdown(path.join(vaultRoot, result.tasks.find((task) => task.nodeId === "N03").relativePath), vaultRoot);
  const dependentReadiness = validateTaskReadiness(buildContext(vaultRoot, "frontend", verificationTask.path), { readMarkdown });
  assert.equal(dependentReadiness.ready, false);
  assert.ok(dependentReadiness.blockers.some((blocker) => blocker.id === "DEPENDENCIES"));

  const repeated = materializeApprovedPlan({
    vaultRoot,
    runsRoot,
    objectiveId: firstObjective.objectiveId,
    planId: approved.plan.planId,
    expectedFingerprint: approved.planFingerprint,
  });
  assert.equal(repeated.action, "TASKS_ALREADY_MATERIALIZED");
  assert.equal(repeated.tasks.length, 3);
  assert.equal(getOrchestration(runsRoot, result.orchestration.orchestrationId).revision, 0);

  assert.throws(() => materializeApprovedPlan({
    vaultRoot,
    runsRoot,
    objectiveId: firstObjective.objectiveId,
    planId: approved.plan.planId,
    expectedFingerprint: "0".repeat(64),
  }), (error) => error.code === "PLAN_FINGERPRINT_MISMATCH");

  const rollbackObjective = objective("obj-materialize-rollback");
  const rollbackApproval = approve(rollbackObjective.objectiveId);
  configureFaultInjection({ "task.materializer.after-rename": 1 });
  try {
    assert.throws(() => materializeApprovedPlan({
      vaultRoot,
      runsRoot,
      objectiveId: rollbackObjective.objectiveId,
      planId: rollbackApproval.plan.planId,
      expectedFingerprint: rollbackApproval.planFingerprint,
    }), (error) => error.injected === true);
  } finally {
    clearFaultInjection();
  }
  for (const projectId of ["frontend", "backend"]) {
    const taskDirectory = path.join(vaultRoot, "02-Projects", projectId, "tasks");
    const files = fs.existsSync(taskDirectory) ? fs.readdirSync(taskDirectory).filter((name) => name.endsWith(".md")) : [];
    assert.deepEqual(files.sort(), projectId === "frontend" ? ["task-001.md", "task-002.md"] : ["task-001.md"]);
  }
  assert.equal(getOrchestration(runsRoot, "orch-obj-materialize-rollback"), null);
  assert.equal(getObjective(runsRoot, rollbackObjective.objectiveId).activeOrchestrationId, null);

  assert.throws(() => materializeApprovedPlan({
    vaultRoot,
    runsRoot,
    objectiveId: rollbackObjective.objectiveId,
    planId: rollbackApproval.plan.planId,
  }), (error) => error.code === "PLAN_FINGERPRINT_REQUIRED");
} finally {
  clearFaultInjection();
}

console.log("task-materializer.test.mjs: All tests passed!");
