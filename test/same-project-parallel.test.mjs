import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDecision } from "../src/decision-store.mjs";
import { createObjective } from "../src/objective-store.mjs";
import { createOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { claimNextJob, getJob, JOB_STATES, listJobs, updateJob } from "../src/job-queue.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { prepareIsolatedWorkspace } from "../src/workspace-manager.mjs";
import { runProcess } from "../src/executor.mjs";
import { schedulerTick } from "../src/orchestration-scheduler.mjs";

console.log("Running same-project-parallel.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "same-project-parallel-"));
const timestamp = "2026-08-23T00:00:00.000Z";

function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function createFixture(name) {
  const fixtureRoot = path.join(root, name);
  const vaultRoot = path.join(fixtureRoot, "vault");
  const runsRoot = path.join(fixtureRoot, "runs");
  const repository = path.join(fixtureRoot, "repository");
  const projectId = "same-project";
  const objectiveId = `objective-${name}`;
  const orchestrationId = `orchestration-${name}`;
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", projectId, "tasks"), { recursive: true });
  fs.mkdirSync(repository, { recursive: true });
  git(fixtureRoot, ["init", "-q", repository]);
  git(repository, ["config", "user.email", "same-project@example.invalid"]);
  git(repository, ["config", "user.name", "Same Project Parallel Test"]);
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e pass" } }));
  fs.writeFileSync(path.join(repository, "src", "a.js"), "a-baseline\n");
  fs.writeFileSync(path.join(repository, "src", "b.js"), "b-baseline\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "baseline"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);

  const projectPage = `02-Projects/${projectId}/project.md`;
  fs.writeFileSync(path.join(vaultRoot, projectPage), "---\ntype: project\n---\n\n# Same Project\n");
  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
    "# Project Registry",
    "| project_id | project_page | repository | agent | graphify | graphify_output |",
    "|---|---|---|---|---|---|",
    `| ${projectId} | [[${projectPage}]] | ${repository} | agy | false | ${path.join(repository, "graph.json")} |`,
  ].join("\n"));

  const plan = {
    schemaVersion: 1, revision: 1, planId: `plan-${name}`, objectiveId, state: "APPROVED",
    summary: "Same-project parallel fixture with aggregate integration.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null,
    projects: [projectId], integration: { required: true, projectVerification: ["test"], crossProjectVerification: [], previewRequired: true }, risk: "LOW", complexity: "LOW",
    nodes: [
      { nodeId: "N01", title: "Implement A", purpose: "Implement the first independent path.", projectId, role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["A is implemented."], allowedPaths: ["src/a.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: true, writeConflictGroup: "same-project-a", contextFrom: [], skills: [] },
      { nodeId: "N02", title: "Implement B", purpose: "Implement the second independent path.", projectId, role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["B is implemented."], allowedPaths: ["src/b.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: true, writeConflictGroup: "same-project-b", contextFrom: [], skills: [] },
      { nodeId: "N03", title: "Integrate", purpose: "Verify the aggregate result after both branches finish.", projectId, role: "INTEGRATION", type: "INTEGRATION", dependsOn: ["N01", "N02"], acceptanceCriteria: ["Aggregate verification is ready."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N01", "N02"], skills: [] },
    ],
    approvedBy: "human:test", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  plan.planFingerprint = planFingerprint(plan);
  const tasks = plan.nodes.map((node) => {
    const taskId = `TASK-${node.nodeId}`;
    const taskPath = `02-Projects/${projectId}/tasks/${node.nodeId.toLowerCase()}.md`;
    fs.writeFileSync(path.join(vaultRoot, taskPath), `---\ntitle: ${node.title}\ntask_id: ${taskId}\nproject: ${projectId}\nstatus: READY\n---\n# ${node.title}\n`);
    return { nodeId: node.nodeId, projectId, taskId, path: taskPath, dependencies: node.dependsOn, orchestrationDependencies: node.dependsOn };
  });

  createObjective({ runsRoot, record: {
    schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "MATERIALIZING", request: "Run same-project parallel.", requestedBy: "human:test", projectIds: [projectId], freshProject: null,
    activePlanId: plan.planId, activeOrchestrationId: orchestrationId, budget: { maxSubtasks: 3, maxParallelAgents: 2, maxRetriesPerNode: 1, maxTotalTokens: null, deadlineAt: null }, createdAt: timestamp, updatedAt: timestamp,
  } });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: [projectId], budget: { maxSubtasks: 3, maxParallelAgents: 2, maxRetriesPerNode: 1 } } });
  createDecision({ runsRoot, record: {
    schemaVersion: 1, revision: 0, decisionId: `decision-plan-approval-${plan.planId}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED",
    evidence: { planId: plan.planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve same-project parallel fixture.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp,
    resolution: { action: "APPROVE", resolvedBy: "human:test", resolvedAt: timestamp },
  } });
  createOrchestration({ runsRoot, record: {
    schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId: plan.planId, state: "CREATED", planFingerprint: plan.planFingerprint,
    nodes: Object.fromEntries(tasks.map((task) => [task.nodeId, { state: task.nodeId === "N03" ? "BLOCKED" : "READY", taskId: task.taskId, jobId: null, runId: null, attempt: 1, blockedBy: task.nodeId === "N03" ? ["TASK-N01", "TASK-N02"] : [], lastError: null }])),
    integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 0, agentInvocations: 0, retries: 0 }, createdAt: timestamp, updatedAt: timestamp,
    materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks },
  }, validationOptions: { plan } });
  return { fixtureRoot, vaultRoot, runsRoot, repository, projectId, objectiveId, orchestrationId, plan, baseCommit };
}

try {
  const defaultFixture = createFixture("default");
  const defaultTick = schedulerTick({ vaultRoot: defaultFixture.vaultRoot, runsRoot: defaultFixture.runsRoot, enabled: true, env: { ORCHESTRATOR_MAX_PARALLEL_JOBS: "2" }, now: new Date(timestamp) });
  assert.equal(defaultTick.queued.length, 1, "same-project parallel remains disabled by default");
  assert.equal(defaultTick.queued[0].sameProjectParallel, false);

  const fixture = createFixture("enabled");
  const env = { ORCHESTRATOR_MAX_PARALLEL_JOBS: "2", ORCHESTRATOR_SAME_PROJECT_PARALLEL: "1" };
  const first = schedulerTick({ vaultRoot: fixture.vaultRoot, runsRoot: fixture.runsRoot, enabled: true, env, now: new Date(timestamp) });
  assert.deepEqual(first.queued.map((job) => job.nodeId), ["N01", "N02"]);
  assert.ok(first.queued.every((job) => job.sameProjectParallel === true));
  const frozen = getOrchestration(fixture.runsRoot, fixture.orchestrationId).integration.projectBaselines[fixture.projectId];
  assert.equal(frozen.baseCommit, fixture.baseCommit);
  assert.equal(frozen.frozenSourceStatus, "");
  assert.equal(first.queued[0].baseCommit, fixture.baseCommit);
  assert.equal(schedulerTick({ vaultRoot: fixture.vaultRoot, runsRoot: fixture.runsRoot, enabled: true, env }).queued.length, 0, "repeated ticks do not duplicate same-project branches");
  assert.equal(claimNextJob(fixture.runsRoot), null, "project-exclusive claim remains the default at the queue boundary");

  const claimedA = claimNextJob(fixture.runsRoot, { allowSameProjectParallel: true });
  const claimedB = claimNextJob(fixture.runsRoot, { allowSameProjectParallel: true });
  assert.ok(claimedA);
  assert.ok(claimedB);
  assert.equal(claimedA.projectId, fixture.projectId);
  assert.equal(claimedB.projectId, fixture.projectId);
  assert.equal(claimedA.scheduling.sameProjectParallel, true);
  assert.equal(claimedB.scheduling.sameProjectParallel, true);

  const workspaceA = await prepareIsolatedWorkspace({
    manifest: { runId: "run-a", project: { id: fixture.projectId, repository: fixture.repository }, execution: { orchestration: { sameProjectParallel: true, baseCommit: fixture.baseCommit, frozenSourceStatus: "" } } },
    runsRoot: fixture.runsRoot,
    eventLogPath: path.join(fixture.runsRoot, "events", "run-a.jsonl"),
    processRunner: runProcess,
  });
  const workspaceB = await prepareIsolatedWorkspace({
    manifest: { runId: "run-b", project: { id: fixture.projectId, repository: fixture.repository }, execution: { orchestration: { sameProjectParallel: true, baseCommit: fixture.baseCommit, frozenSourceStatus: "" } } },
    runsRoot: fixture.runsRoot,
    eventLogPath: path.join(fixture.runsRoot, "events", "run-b.jsonl"),
    processRunner: runProcess,
  });
  assert.notEqual(workspaceA.path, workspaceB.path);
  assert.equal(workspaceA.baseCommit, fixture.baseCommit);
  assert.equal(workspaceB.baseCommit, fixture.baseCommit);
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), fixture.baseCommit);
  git(fixture.repository, ["worktree", "remove", "--force", workspaceA.path]);
  git(fixture.repository, ["worktree", "remove", "--force", workspaceB.path]);
  git(fixture.repository, ["worktree", "prune"]);

  updateJob(fixture.runsRoot, claimedA.jobId, { state: JOB_STATES.DONE, runState: "DONE" });
  updateJob(fixture.runsRoot, claimedB.jobId, { state: JOB_STATES.DONE, runState: "DONE" });
  const afterBranches = schedulerTick({ vaultRoot: fixture.vaultRoot, runsRoot: fixture.runsRoot, enabled: true, env });
  assert.deepEqual(afterBranches.queued.map((job) => job.nodeId), ["N03"]);
  assert.equal(afterBranches.queued[0].sameProjectParallel, false, "integration node returns to exclusive mode");

  fs.writeFileSync(path.join(fixture.repository, "drift.txt"), "drift\n");
  git(fixture.repository, ["add", "drift.txt"]);
  git(fixture.repository, ["commit", "-qm", "baseline drift"]);
  await assert.rejects(
    () => prepareIsolatedWorkspace({
      manifest: { runId: "run-drift", project: { id: fixture.projectId, repository: fixture.repository }, execution: { orchestration: { sameProjectParallel: true, baseCommit: fixture.baseCommit, frozenSourceStatus: "" } } },
      runsRoot: fixture.runsRoot,
      eventLogPath: path.join(fixture.runsRoot, "events", "run-drift.jsonl"),
      processRunner: runProcess,
    }),
    (error) => error.code === "SAME_PROJECT_BASELINE_DRIFT",
  );
  assert.equal(listJobs(fixture.runsRoot).filter((job) => job.state === JOB_STATES.RUNNING).length, 0);
  console.log("same-project-parallel.test.mjs: All tests passed!");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
