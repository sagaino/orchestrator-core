import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDecision } from "../src/decision-store.mjs";
import { createObjective } from "../src/objective-store.mjs";
import { createOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { claimNextJob, JOB_STATES, listJobs, updateJob } from "../src/job-queue.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { schedulerTick } from "../src/orchestration-scheduler.mjs";
import { createMultiAgentCertification, verifyMultiAgentCertification } from "../src/multi-agent-certification.mjs";

console.log("Running multi-agent-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-certification-"));
const timestamp = "2026-08-23T00:00:00.000Z";

function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function createFixture() {
  const vaultRoot = path.join(root, "vault");
  const runsRoot = path.join(root, "runs");
  const repository = path.join(root, "repository");
  const projectId = "certification-project";
  const objectiveId = "objective-v2054";
  const orchestrationId = "orchestration-v2054";
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", projectId, "tasks"), { recursive: true });
  fs.mkdirSync(repository, { recursive: true });
  git(root, ["init", "-q", repository]);
  git(repository, ["config", "user.email", "multi-agent-certification@example.invalid"]);
  git(repository, ["config", "user.name", "Multi-Agent Certification Test"]);
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e pass" } }));
  fs.writeFileSync(path.join(repository, "src", "a.js"), "baseline-a\n");
  fs.writeFileSync(path.join(repository, "src", "b.js"), "baseline-b\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "baseline"]);

  const projectPage = `02-Projects/${projectId}/project.md`;
  fs.writeFileSync(path.join(vaultRoot, projectPage), "---\ntype: project\n---\n\n# Certification Project\n");
  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
    "# Project Registry",
    "| project_id | project_page | repository | agent | graphify | graphify_output |",
    "|---|---|---|---|---|---|",
    `| ${projectId} | [[${projectPage}]] | ${repository} | agy | false | ${path.join(repository, "graph.json")} |`,
  ].join("\n"));

  const nodes = [
    { nodeId: "N01", title: "Parallel A", purpose: "Implement independent branch A.", projectId, role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["A passes."], allowedPaths: ["src/a.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: true, writeConflictGroup: "branch-a", contextFrom: [], skills: [] },
    { nodeId: "N02", title: "Parallel B", purpose: "Implement independent branch B.", projectId, role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["B passes."], allowedPaths: ["src/b.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: true, writeConflictGroup: "branch-b", contextFrom: [], skills: [] },
    { nodeId: "N03", title: "Aggregate integration", purpose: "Integrate both parallel branches.", projectId, role: "INTEGRATION", type: "INTEGRATION", dependsOn: ["N01", "N02"], acceptanceCriteria: ["Aggregate integration passes."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N01", "N02"], skills: [] },
    { nodeId: "N04", title: "Final verification", purpose: "Run the final pilot verification.", projectId, role: "TESTING", type: "VERIFICATION", dependsOn: ["N03"], acceptanceCriteria: ["Final verification passes."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N03"], skills: [] },
  ];
  const plan = {
    schemaVersion: 1, revision: 1, planId: "plan-v2054", objectiveId, state: "APPROVED",
    summary: "Multi-agent certification pilot.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null,
    projects: [projectId], nodes, integration: { required: true, projectVerification: ["test"], crossProjectVerification: [], previewRequired: true }, risk: "LOW", complexity: "LOW",
    approvedBy: "human:v2054", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  plan.planFingerprint = planFingerprint(plan);
  const tasks = nodes.map((node) => {
    const taskId = `TASK-${node.nodeId}`;
    const taskPath = `02-Projects/${projectId}/tasks/${node.nodeId.toLowerCase()}.md`;
    fs.writeFileSync(path.join(vaultRoot, taskPath), `---\ntitle: ${node.title}\ntask_id: ${taskId}\nproject: ${projectId}\nstatus: DONE\n---\n# ${node.title}\n`);
    return { nodeId: node.nodeId, projectId, taskId, path: taskPath, dependencies: node.dependsOn, orchestrationDependencies: node.dependsOn };
  });

  createObjective({ runsRoot, record: {
    schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING", request: "Certify multi-agent execution.", requestedBy: "human:v2054", projectIds: [projectId], freshProject: null,
    activePlanId: plan.planId, activeOrchestrationId: orchestrationId, budget: { maxSubtasks: 4, maxParallelAgents: 2, maxRetriesPerNode: 1, maxTotalTokens: 600, deadlineAt: null }, createdAt: timestamp, updatedAt: timestamp,
  } });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: [projectId], budget: { maxSubtasks: 4, maxParallelAgents: 2, maxRetriesPerNode: 1, maxTotalTokens: 600 } } });
  createDecision({ runsRoot, record: {
    schemaVersion: 1, revision: 0, decisionId: `decision-plan-approval-${plan.planId}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED",
    evidence: { planId: plan.planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve V2-054 pilot.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp,
    resolution: { action: "APPROVE", resolvedBy: "human:v2054", resolvedAt: timestamp },
  } });
  createOrchestration({ runsRoot, record: {
    schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId: plan.planId, state: "CREATED", planFingerprint: plan.planFingerprint,
    nodes: Object.fromEntries(tasks.map((task) => [task.nodeId, { state: task.nodeId === "N04" ? "BLOCKED" : "READY", taskId: task.taskId, jobId: null, runId: null, attempt: 1, blockedBy: task.nodeId === "N04" ? ["TASK-N03"] : [], lastError: null }])),
    integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 240, agentInvocations: 4, retries: 0 }, createdAt: timestamp, updatedAt: timestamp,
    materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks },
  }, validationOptions: { plan } });
  return { vaultRoot, runsRoot, repository, projectId, objectiveId, orchestrationId, plan };
}

function writeRun(fixture, nodeId, runId, changedPaths, totalTokens) {
  fs.writeFileSync(path.join(fixture.runsRoot, `${runId}.json`), JSON.stringify({
    schemaVersion: 1, revision: 0, runId, state: "DONE", createdAt: timestamp, updatedAt: timestamp,
    project: { id: fixture.projectId, repository: fixture.repository }, task: { id: `TASK-${nodeId}`, path: `02-Projects/${fixture.projectId}/tasks/${nodeId.toLowerCase()}.md`, allowedPaths: changedPaths },
    execution: { usage: { totalTokens }, scopeAudit: { passed: true, changedPaths, allowedPaths: changedPaths, outOfScopePaths: [], deniedPaths: [] }, verification: [{ command: "test", exitCode: 0 }], result: { status: "PASS", gitCommit: { committed: false, commitHash: `${runId}-commit` } }, workspace: { state: "CLEANED", appliedPaths: changedPaths } },
    completion: { completedAt: timestamp, completedBy: "human:v2054", humanApproved: true }, history: [],
  }, null, 2));
}

function finishNode(fixture, job, nodeId, startedAt, finishedAt, changedPaths, totalTokens) {
  updateJob(fixture.runsRoot, job.jobId, { startedAt, state: JOB_STATES.RUNNING });
  const runId = `run-${nodeId.toLowerCase()}`;
  writeRun(fixture, nodeId, runId, changedPaths, totalTokens);
  updateJob(fixture.runsRoot, job.jobId, { state: JOB_STATES.DONE, runId, runState: "DONE", finishedAt });
}

try {
  const fixture = createFixture();
  const env = { ORCHESTRATOR_MAX_PARALLEL_JOBS: "2", ORCHESTRATOR_PARALLEL_OBJECTIVES: "1", ORCHESTRATOR_SAME_PROJECT_PARALLEL: "1" };
  const first = schedulerTick({ vaultRoot: fixture.vaultRoot, runsRoot: fixture.runsRoot, enabled: true, env, now: new Date(timestamp) });
  assert.deepEqual(first.queued.map((job) => job.nodeId), ["N01", "N02"]);
  const firstA = claimNextJob(fixture.runsRoot, { allowSameProjectParallel: true });
  const firstB = claimNextJob(fixture.runsRoot, { allowSameProjectParallel: true });
  finishNode(fixture, firstA, "N01", "2026-08-23T00:00:10.000Z", "2026-08-23T00:00:30.000Z", ["src/a.js"], 80);
  finishNode(fixture, firstB, "N02", "2026-08-23T00:00:12.000Z", "2026-08-23T00:00:28.000Z", ["src/b.js"], 90);

  const second = schedulerTick({ vaultRoot: fixture.vaultRoot, runsRoot: fixture.runsRoot, enabled: true, env });
  assert.deepEqual(second.queued.map((job) => job.nodeId), ["N03"]);
  const integrationJob = claimNextJob(fixture.runsRoot, { allowSameProjectParallel: true });
  finishNode(fixture, integrationJob, "N03", "2026-08-23T00:00:35.000Z", "2026-08-23T00:00:40.000Z", [], 40);

  const third = schedulerTick({ vaultRoot: fixture.vaultRoot, runsRoot: fixture.runsRoot, enabled: true, env });
  assert.deepEqual(third.queued.map((job) => job.nodeId), ["N04"]);
  const verificationJob = claimNextJob(fixture.runsRoot, { allowSameProjectParallel: true });
  finishNode(fixture, verificationJob, "N04", "2026-08-23T00:00:45.000Z", "2026-08-23T00:00:50.000Z", [], 30);
  schedulerTick({ vaultRoot: fixture.vaultRoot, runsRoot: fixture.runsRoot, enabled: true, env });
  assert.equal(getOrchestration(fixture.runsRoot, fixture.orchestrationId).state, "DONE");
  assert.equal(listJobs(fixture.runsRoot).filter((job) => job.state === JOB_STATES.RUNNING).length, 0);

  const restartEvidence = {
    status: "PASS",
    safe: true,
    restartPoint: "N02",
    sourceUnchanged: true,
    duplicateExecution: false,
    recoverableReject: { verified: true, rejectedRunId: "run-n02", replayed: false, noDuplicate: true },
  };
  const certification = createMultiAgentCertification({ ...fixture, restartEvidence, now: new Date(timestamp) });
  assert.equal(certification.status, "CERTIFICATION_READY");
  assert.deepEqual(certification.blockers, []);
  assert.equal(certification.humanGate.required, true);
  assert.equal(certification.metrics.maxConcurrency, 2);
  assert.equal(certification.metrics.totalTokens, 240);
  assert.equal(certification.checks.find((item) => item.id === "GENUINE_PARALLEL_EXECUTION").status, "PASS");
  assert.equal(certification.checks.find((item) => item.id === "DAG_INTEGRATION_ORDER").status, "PASS");
  assert.equal(verifyMultiAgentCertification({ bundleFilePath: certification.bundlePath }).valid, true);

  const missingRestart = createMultiAgentCertification({ ...fixture, now: new Date(timestamp) });
  assert.equal(missingRestart.status, "CONDITIONAL");
  assert.ok(missingRestart.blockers.includes("RESTART_RECOVERY"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("multi-agent-certification.test.mjs: All tests passed!");
