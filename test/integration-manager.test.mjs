import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createDecision } from "../src/decision-store.mjs";
import { createOrchestration, getOrchestration, updateOrchestration } from "../src/orchestration-store.mjs";
import { enqueueTaskJob, getJob, updateJob } from "../src/job-queue.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { getIntegrationEvidence, startIntegration } from "../src/integration-manager.mjs";

console.log("Running integration-manager.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "integration-manager-"));
const timestamp = "2026-08-23T00:00:00.000Z";

function createFixture(objectiveId, { verificationExitCode = 0, n02State = "DONE", missingRun = false } = {}) {
  const vaultRoot = path.join(root, `${objectiveId}-vault`);
  const runsRoot = path.join(root, `${objectiveId}-runs`);
  const repository = path.join(root, `${objectiveId}-repository`);
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "integration-project", "tasks"), { recursive: true });
  fs.mkdirSync(repository, { recursive: true });
  execFileSync("git", ["-C", repository, "init", "-q"]);
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e pass" } }));
  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "integration-project", "project.md"), "---\ntype: project\n---\n\n# Integration Project\n");
  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
    "# Project Registry",
    "| project_id | project_page | repository | agent | graphify | graphify_output |",
    "|---|---|---|---|---|---|",
    `| integration-project | [[02-Projects/integration-project/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
  ].join("\n"));
  const plan = {
    schemaVersion: 1, revision: 1, planId: `plan-${objectiveId}-r1`, objectiveId, state: "APPROVED",
    summary: "Sequential integration fixture.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null,
    projects: ["integration-project"], integration: { required: true, projectVerification: ["test"], crossProjectVerification: [], previewRequired: false }, risk: "LOW", complexity: "LOW",
    nodes: [
      { nodeId: "N01", title: "Diagnose integration", purpose: "Record integration input.", projectId: "integration-project", role: "DIAGNOSTIC", type: "DIAGNOSTIC", dependsOn: [], acceptanceCriteria: ["Input is recorded."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [] },
      { nodeId: "N02", title: "Implement integration", purpose: "Implement integration input.", projectId: "integration-project", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: ["N01"], acceptanceCriteria: ["Integration input is implemented."], allowedPaths: ["src/feature.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "integration", contextFrom: ["N01"], skills: [] },
      { nodeId: "N03", title: "Run integration", purpose: "Run the aggregate integration verification.", projectId: "integration-project", role: "INTEGRATION", type: "INTEGRATION", dependsOn: ["N02"], acceptanceCriteria: ["Integration verification is recorded."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N02"], skills: [] },
    ],
    approvedBy: "human:integration", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  plan.planFingerprint = planFingerprint(plan);
  const taskMappings = ["N01", "N02", "N03"].map((nodeId, index) => {
    const taskId = `TASK-${index + 1}`;
    const relativePath = `02-Projects/integration-project/tasks/${taskId.toLowerCase()}.md`;
    fs.writeFileSync(path.join(vaultRoot, relativePath), `---\ntitle: ${nodeId}\ntask_id: ${taskId}\nproject: integration-project\nstatus: DONE\n---\n# ${nodeId}\n`);
    return { nodeId, projectId: "integration-project", taskId, path: relativePath, dependencies: [], orchestrationDependencies: [] };
  });
  createObjective({ runsRoot, record: {
    schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING", request: "Run integration.", requestedBy: "human:integration", projectIds: ["integration-project"], freshProject: null,
    activePlanId: plan.planId, activeOrchestrationId: `orch-${objectiveId}`, budget: { maxSubtasks: 3, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: null, deadlineAt: null }, createdAt: timestamp, updatedAt: timestamp,
  } });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: ["integration-project"], budget: { maxSubtasks: 3, maxParallelAgents: 1, maxRetriesPerNode: 1 } } });
  createDecision({ runsRoot, record: {
    schemaVersion: 1, revision: 0, decisionId: `decision-plan-approval-${plan.planId}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED",
    evidence: { planId: plan.planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve integration plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp,
    resolution: { action: "APPROVE", resolvedBy: "human:integration", resolvedAt: timestamp },
  } });
  const orchestrationId = `orch-${objectiveId}`;
  const runtimeState = { N01: "DONE", N02: n02State, N03: "BLOCKED" };
  createOrchestration({ runsRoot, record: {
    schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId: plan.planId, state: n02State === "DONE" ? "RUNNING" : "BLOCKED", planFingerprint: plan.planFingerprint,
    nodes: Object.fromEntries(["N01", "N02", "N03"].map((nodeId, index) => [nodeId, { state: runtimeState[nodeId], taskId: taskMappings[index].taskId, jobId: nodeId === "N03" ? null : `job-${nodeId}`, runId: nodeId === "N03" || (missingRun && nodeId === "N02") ? null : `run-${nodeId}`, attempt: 1, blockedBy: nodeId === "N03" ? ["TASK-2"] : [], lastError: null }])),
    integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 0, agentInvocations: 0, retries: 0 }, createdAt: timestamp, updatedAt: timestamp,
    materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: taskMappings },
  }, validationOptions: { plan } });

  for (const [index, nodeId] of ["N01", "N02"].entries()) {
    const mapping = taskMappings[index];
    const runId = `run-${nodeId}`;
    const queued = enqueueTaskJob({ runsRoot, projectId: mapping.projectId, taskId: mapping.taskId, taskPath: mapping.path, requestedBy: "human:integration", orchestrationManaged: true, schedulerAuthorized: true, orchestrationMetadata: { objectiveId, planId: plan.planId, orchestrationId, nodeId, attempt: 1, planFingerprint: plan.planFingerprint, approvalDecisionId: `decision-plan-approval-${plan.planId}`, approvedBy: "human:integration", approvedAt: timestamp } });
    updateJob(runsRoot, queued.job.jobId, { state: n02State === "RUNNING" && nodeId === "N02" ? "RUNNING" : "DONE", runId: missingRun && nodeId === "N02" ? null : runId, runState: "DONE", createdAt: new Date(Date.parse(timestamp) + index * 1000).toISOString() });
    if (missingRun && nodeId === "N02") continue;
    fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
      schemaVersion: 1, revision: 0, runId, state: "DONE", createdAt: timestamp, updatedAt: timestamp, project: { id: "integration-project", repository }, task: { id: mapping.taskId, path: mapping.path, allowedPaths: nodeId === "N02" ? ["src/feature.js"] : [] },
      execution: { scopeAudit: { passed: true, changedPaths: nodeId === "N02" ? ["src/feature.js"] : [], allowedPaths: nodeId === "N02" ? ["src/feature.js"] : [], outOfScopePaths: [], deniedPaths: [] }, verification: [{ command: "test", exitCode: 0 }], result: { gitCommit: { committed: true, commitHash: `${nodeId}-commit` } }, workspace: { state: "CLEANED", appliedAt: timestamp, appliedPaths: nodeId === "N02" ? ["src/feature.js"] : [], postApplyVerification: [{ command: "test", exitCode: 0 }] } },
      completion: { completedAt: timestamp, completedBy: "human:integration", humanApproved: true }, knowledge: { approval: { approvedAt: timestamp, approvedBy: "human:integration", classification: "PROJECT_ONLY", destination: "PROJECT" } }, history: [],
    }, null, 2));
  }
  return { vaultRoot, runsRoot, objectiveId, orchestrationId, repository };
}

try {
  const blockedFixture = createFixture("obj-integration-blocked", { n02State: "RUNNING" });
  await assert.rejects(
    () => startIntegration(blockedFixture),
    (error) => error.code === "INTEGRATION_PREDECESSORS_NOT_DONE",
  );

  const passedFixture = createFixture("obj-integration-pass");
  const passed = await startIntegration({ ...passedFixture, verificationRunner: async () => ({ exitCode: 0, stdoutTail: "ok" }) });
  assert.equal(passed.action, "INTEGRATION_COMPLETED");
  assert.equal(passed.orchestration.state, "DONE");
  assert.equal(passed.integration.state, "PASSED");
  assert.deepEqual(passed.evidence.sourceRunIds, ["run-N01", "run-N02"]);
  assert.deepEqual(passed.evidence.commitHashes, ["N01-commit", "N02-commit"]);
  assert.deepEqual(passed.evidence.scope.unionOfApprovedNodeScopes, ["src/feature.js"]);
  assert.equal(getIntegrationEvidence({ runsRoot: passedFixture.runsRoot, orchestrationId: passedFixture.orchestrationId }).status, "PASSED");

  const failedFixture = createFixture("obj-integration-failed", { verificationExitCode: 1 });
  const failed = await startIntegration({ ...failedFixture, verificationRunner: async () => ({ exitCode: 1, stderrTail: "integration mismatch" }) });
  assert.equal(failed.action, "INTEGRATION_BLOCKED");
  assert.equal(failed.orchestration.state, "BLOCKED");
  assert.equal(failed.integration.state, "BLOCKED");
  assert.equal(failed.decision.type, "INTEGRATION_CONFLICT");
  assert.equal(failed.decision.state, "OPEN");
  assert.equal(getOrchestration(failedFixture.runsRoot, failedFixture.orchestrationId).integration.blockerDecisionId, failed.decision.decisionId);

  const missingFixture = createFixture("obj-integration-missing-run", { missingRun: true });
  const missing = await startIntegration({ ...missingFixture, verificationRunner: async () => ({ exitCode: 0 }) });
  assert.equal(missing.action, "INTEGRATION_BLOCKED");
  assert.ok(missing.decision.evidence.sourceErrors.some((error) => error.code === "SOURCE_RUN_MISSING"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("integration-manager.test.mjs: All tests passed!");
