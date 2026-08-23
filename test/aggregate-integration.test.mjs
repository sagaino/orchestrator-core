import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDecision } from "../src/decision-store.mjs";
import { enqueueTaskJob, updateJob } from "../src/job-queue.mjs";
import { createObjective } from "../src/objective-store.mjs";
import { createOrchestration } from "../src/orchestration-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { cleanupIntegrationWorkspace, getIntegrationEvidence, prepareAggregateIntegration } from "../src/integration-manager.mjs";

console.log("Running aggregate-integration.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-integration-"));
const timestamp = "2026-08-23T00:00:00.000Z";

function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function createFixture(name) {
  const fixtureRoot = path.join(root, name);
  const vaultRoot = path.join(fixtureRoot, "vault");
  const runsRoot = path.join(fixtureRoot, "runs");
  const repository = path.join(fixtureRoot, "repository");
  const objectiveId = `objective-${name}`;
  const orchestrationId = `orchestration-${name}`;
  const projectId = "integration-project";
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", projectId, "tasks"), { recursive: true });
  fs.mkdirSync(repository, { recursive: true });
  git(fixtureRoot, ["init", "-q", repository]);
  git(repository, ["config", "user.email", "aggregate-integration@example.invalid"]);
  git(repository, ["config", "user.name", "Aggregate Integration Test"]);
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e pass" } }));
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src", "feature.js"), "baseline\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "baseline"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "-qc", "patches"]);
  git(repository, ["commit", "--allow-empty", "-qm", "diagnostic patch"]);
  const diagnosticCommit = git(repository, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repository, "src", "feature.js"), "implemented\n");
  git(repository, ["add", "src/feature.js"]);
  git(repository, ["commit", "-qm", "implementation patch"]);
  const implementationCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "-q", "-C", "main", baseCommit]);

  const projectPage = "02-Projects/integration-project/project.md";
  fs.writeFileSync(path.join(vaultRoot, projectPage), "---\ntype: project\n---\n\n# Integration Project\n");
  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
    "# Project Registry",
    "| project_id | project_page | repository | agent | graphify | graphify_output |",
    "|---|---|---|---|---|---|",
    `| ${projectId} | [[${projectPage}]] | ${repository} | agy | false | ${path.join(repository, "graph.json")} |`,
  ].join("\n"));

  const plan = {
    schemaVersion: 1, revision: 1, planId: `plan-${name}`, objectiveId, state: "APPROVED",
    summary: "Aggregate integration fixture.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null,
    projects: [projectId], integration: { required: true, projectVerification: ["test"], crossProjectVerification: [], previewRequired: true }, risk: "LOW", complexity: "LOW",
    nodes: [
      { nodeId: "N01", title: "Diagnose", purpose: "Record context.", projectId, role: "DIAGNOSTIC", type: "DIAGNOSTIC", dependsOn: [], acceptanceCriteria: ["Context is recorded."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [] },
      { nodeId: "N02", title: "Implement", purpose: "Apply implementation.", projectId, role: "BACKEND", type: "IMPLEMENTATION", dependsOn: ["N01"], acceptanceCriteria: ["Feature is implemented."], allowedPaths: ["src/feature.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "integration", contextFrom: ["N01"], skills: [] },
      { nodeId: "N03", title: "Integrate", purpose: "Verify aggregate workspace.", projectId, role: "INTEGRATION", type: "INTEGRATION", dependsOn: ["N02"], acceptanceCriteria: ["Aggregate verification passes."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N02"], skills: [] },
    ],
    approvedBy: "human:test", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  plan.planFingerprint = planFingerprint(plan);
  const tasks = ["N01", "N02", "N03"].map((nodeId, index) => {
    const taskId = `TASK-${index + 1}`;
    const relativePath = `02-Projects/${projectId}/tasks/${taskId.toLowerCase()}.md`;
    fs.writeFileSync(path.join(vaultRoot, relativePath), `---\ntitle: ${nodeId}\ntask_id: ${taskId}\nproject: ${projectId}\nstatus: DONE\n---\n# ${nodeId}\n`);
    return { nodeId, projectId, taskId, path: relativePath, dependencies: [], orchestrationDependencies: [] };
  });

  createObjective({ runsRoot, record: {
    schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING", request: "Run aggregate integration.", requestedBy: "human:test", projectIds: [projectId], freshProject: null,
    activePlanId: plan.planId, activeOrchestrationId: orchestrationId, budget: { maxSubtasks: 4, maxParallelAgents: 1, maxRetriesPerNode: 1, maxRepairCycles: 1, maxTotalTokens: null, deadlineAt: null }, createdAt: timestamp, updatedAt: timestamp,
  } });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: [projectId], budget: { maxSubtasks: 4, maxParallelAgents: 1, maxRetriesPerNode: 1, maxRepairCycles: 1 } } });
  createDecision({ runsRoot, record: {
    schemaVersion: 1, revision: 0, decisionId: `decision-plan-${name}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED",
    evidence: { planId: plan.planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp,
    resolution: { action: "APPROVE", resolvedBy: "human:test", resolvedAt: timestamp },
  } });
  createOrchestration({ runsRoot, record: {
    schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId: plan.planId, state: "RUNNING", planFingerprint: plan.planFingerprint,
    nodes: Object.fromEntries(tasks.map((task) => [task.nodeId, { state: task.nodeId === "N03" ? "BLOCKED" : "DONE", taskId: task.taskId, jobId: task.nodeId === "N03" ? null : `job-${task.nodeId}`, runId: task.nodeId === "N03" ? null : `run-${task.nodeId}`, attempt: 1, blockedBy: task.nodeId === "N03" ? ["TASK-2"] : [], lastError: null }])),
    integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 0, agentInvocations: 0, retries: 0 }, createdAt: timestamp, updatedAt: timestamp,
    materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks },
  }, validationOptions: { plan } });

  const commits = { N01: { commitHash: diagnosticCommit, parentCommit: baseCommit }, N02: { commitHash: implementationCommit, parentCommit: diagnosticCommit } };
  for (const [index, nodeId] of ["N01", "N02"].entries()) {
    const task = tasks[index];
    const runId = `run-${nodeId}`;
    const queued = enqueueTaskJob({ runsRoot, projectId, taskId: task.taskId, taskPath: task.path, requestedBy: "human:test", orchestrationManaged: true, schedulerAuthorized: true, orchestrationMetadata: { objectiveId, planId: plan.planId, orchestrationId, nodeId, attempt: 1, planFingerprint: plan.planFingerprint, approvalDecisionId: `decision-plan-${name}`, approvedBy: "human:test", approvedAt: timestamp } });
    updateJob(runsRoot, queued.job.jobId, { state: "DONE", runId, runState: "DONE", createdAt: timestamp });
    fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
      schemaVersion: 1, revision: 0, runId, state: "DONE", createdAt: timestamp, updatedAt: timestamp, project: { id: projectId, repository }, task: { id: task.taskId, path: task.path, allowedPaths: nodeId === "N02" ? ["src/feature.js"] : [] },
      execution: { scopeAudit: { passed: true, changedPaths: nodeId === "N02" ? ["src/feature.js"] : [], allowedPaths: nodeId === "N02" ? ["src/feature.js"] : [], outOfScopePaths: [], deniedPaths: [] }, verification: [{ command: "test", exitCode: 0 }], result: { gitCommit: { committed: true, ...commits[nodeId] } }, workspace: { state: "CLEANED", appliedAt: timestamp, baseCommit, appliedPaths: nodeId === "N02" ? ["src/feature.js"] : [], postApplyVerification: [{ command: "test", exitCode: 0 }] } },
      completion: { completedAt: timestamp, completedBy: "human:test", humanApproved: true }, knowledge: { approval: { approvedAt: timestamp, approvedBy: "human:test", classification: "PROJECT_ONLY", destination: "PROJECT" } }, history: [],
    }, null, 2));
  }
  return { fixtureRoot, vaultRoot, runsRoot, repository, objectiveId, orchestrationId, projectId, baseCommit };
}

async function runFixture(name, exitCode) {
  const fixture = createFixture(name);
  const sourceHeadBefore = git(fixture.repository, ["rev-parse", "HEAD"]);
  const sourceStatusBefore = git(fixture.repository, ["status", "--porcelain=v1"]);
  let result;
  try {
    result = await prepareAggregateIntegration({
      ...fixture,
      verificationRunner: async ({ cwd }) => ({ exitCode, stdoutTail: `verified in ${cwd}` }),
    });
    const evidence = getIntegrationEvidence({ runsRoot: fixture.runsRoot, orchestrationId: fixture.orchestrationId });
    assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), sourceHeadBefore, "source HEAD remains frozen");
    assert.equal(git(fixture.repository, ["status", "--porcelain=v1"]), sourceStatusBefore, "source worktree remains unchanged");
    assert.equal(evidence.aggregateWorkspace.objectiveId, fixture.objectiveId);
    assert.ok(evidence.aggregateWorkspace.previewPath);
    assert.equal(fs.existsSync(path.join(fixture.runsRoot, evidence.aggregateWorkspace.previewPath)), true);
    if (exitCode === 0) {
      assert.equal(result.action, "AGGREGATE_INTEGRATION_READY");
      assert.equal(result.evidence.status, "READY_FOR_ACCEPTANCE");
      assert.equal(result.workspace.state, "READY_FOR_VERIFICATION");
      assert.deepEqual(result.evidence.aggregateWorkspace.changedPaths, ["src/feature.js"]);
      assert.equal(fs.readFileSync(path.join(result.workspace.workspacePath, "src", "feature.js"), "utf8"), "implemented\n");
    } else {
      assert.equal(result.action, "AGGREGATE_INTEGRATION_BLOCKED");
      assert.equal(result.evidence.status, "BLOCKED");
      assert.equal(result.workspace.state, "ROLLED_BACK");
      assert.equal(fs.readFileSync(path.join(result.workspace.workspacePath, "src", "feature.js"), "utf8"), "baseline\n");
      assert.equal(fs.existsSync(result.workspace.rollbackArtifactPath), true);
    }
  } finally {
    if (result?.workspace?.workspacePath && fs.existsSync(result.workspace.workspacePath)) {
      cleanupIntegrationWorkspace({ workspace: result.workspace, runsRoot: fixture.runsRoot });
    }
  }
}

try {
  await runFixture("ready", 0);
  await runFixture("verification-failure", 1);
  console.log("aggregate-integration.test.mjs: All tests passed!");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
