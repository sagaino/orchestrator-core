import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createDecision } from "../src/decision-store.mjs";
import { createOrchestration, getOrchestration, updateOrchestration } from "../src/orchestration-store.mjs";
import { enqueueTaskJob, updateJob } from "../src/job-queue.mjs";
import { approvePlan, planFingerprint } from "../src/plan-lifecycle.mjs";
import { materializeApprovedPlan } from "../src/task-materializer.mjs";
import { resolveDecision } from "../src/orchestration-scheduler.mjs";
import { acceptObjective } from "../src/objective-evidence.mjs";
import { recoverIntegration, startIntegration } from "../src/integration-manager.mjs";
import { createSequentialIntegrationCertification, verifySequentialIntegrationCertification } from "../src/sequential-integration-certification.mjs";

console.log("Running sequential-integration-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sequential-integration-certification-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "repository");
const timestamp = "2026-08-23T00:00:00.000Z";
const objectiveId = "obj-v2043-pilot";
const planId = `plan-${objectiveId}-r1`;
const orchestrationId = `orch-${objectiveId}`;
fs.mkdirSync(path.join(vaultRoot, "02-Projects", "pilot-project", "tasks"), { recursive: true });
fs.mkdirSync(repository, { recursive: true });
execFileSync("git", ["-C", repository, "init", "-q"]);
fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node -e pass" } }));
fs.writeFileSync(path.join(vaultRoot, "02-Projects", "pilot-project", "project.md"), "---\ntype: project\n---\n\n# Pilot Project\n");
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| pilot-project | [[02-Projects/pilot-project/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));

const nodes = [
  { nodeId: "N01", title: "Diagnose pilot", purpose: "Record the pilot diagnosis.", projectId: "pilot-project", role: "DIAGNOSTIC", type: "DIAGNOSTIC", dependsOn: [], acceptanceCriteria: ["Diagnosis is recorded."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [] },
  { nodeId: "N02", title: "Implement pilot", purpose: "Implement the pilot change.", projectId: "pilot-project", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: ["N01"], acceptanceCriteria: ["Pilot change is implemented."], allowedPaths: ["src/feature.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "pilot", contextFrom: ["N01"], skills: [] },
  { nodeId: "N03", title: "Integrate pilot", purpose: "Run the aggregate integration verification.", projectId: "pilot-project", role: "INTEGRATION", type: "INTEGRATION", dependsOn: ["N02"], acceptanceCriteria: ["Integration verification passes."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N02"], skills: [] },
];
const budget = { maxSubtasks: 5, maxParallelAgents: 1, maxRetriesPerNode: 1, maxRepairCycles: 1, maxTotalTokens: null, deadlineAt: null };
const plan = { schemaVersion: 1, revision: 1, planId, objectiveId, state: "APPROVED", summary: "V2-043 sequential integration pilot.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null, projects: ["pilot-project"], nodes, integration: { required: true, projectVerification: ["test"], crossProjectVerification: [], previewRequired: false }, risk: "LOW", complexity: "LOW", approvedBy: "human:v2043", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
plan.planFingerprint = planFingerprint(plan);

function writeRun(runId, taskId, allowedPaths, changedPaths, repositoryPath = repository) {
  fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
    schemaVersion: 1, revision: 0, runId, state: "DONE", createdAt: timestamp, updatedAt: timestamp,
    project: { id: "pilot-project", repository: repositoryPath }, task: { id: taskId, title: taskId, path: `02-Projects/pilot-project/tasks/${taskId.toLowerCase()}.md`, allowedPaths, status: "DONE" },
    approval: { approvedAt: timestamp, approvedBy: "human:v2043", scope: "EXECUTE_TASK" },
    completion: { completedAt: timestamp, completedBy: "human:v2043", humanApproved: true },
    knowledge: { approval: { approvedAt: timestamp, approvedBy: "human:v2043", classification: "PROJECT_ONLY", destination: "PROJECT" } },
    execution: { scopeAudit: { passed: true, changedPaths, allowedPaths, outOfScopePaths: [], deniedPaths: [] }, verification: [{ command: "test", exitCode: 0 }], result: { gitCommit: { committed: true, commitHash: `${runId}-commit`, paths: changedPaths } }, workspace: { state: "CLEANED", appliedAt: timestamp, appliedPaths: changedPaths, postApplyVerification: [{ command: "test", exitCode: 0 }] } },
    history: [],
  }, null, 2));
}

try {
  createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING", request: "Certify sequential integration repair.", requestedBy: "human:v2043", projectIds: ["pilot-project"], freshProject: null, activePlanId: planId, activeOrchestrationId: orchestrationId, budget, createdAt: timestamp, updatedAt: timestamp } });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: ["pilot-project"], budget } });
  createDecision({ runsRoot, record: { schemaVersion: 1, revision: 0, decisionId: `decision-plan-approval-${planId}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED", evidence: { planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve the sequential integration plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp, resolution: { action: "APPROVE", resolvedBy: "human:v2043", resolvedAt: timestamp } } });
  for (const [index, node] of nodes.entries()) {
    const taskId = `TASK-${index + 1}`;
    const taskPath = path.join(vaultRoot, `02-Projects/pilot-project/tasks/${taskId.toLowerCase()}.md`);
    fs.writeFileSync(taskPath, `---\ntitle: ${node.title}\ntask_id: ${taskId}\nproject: pilot-project\nstatus: DONE\n---\n# ${node.title}\n`);
  }
  const taskMappings = nodes.map((node, index) => ({ nodeId: node.nodeId, projectId: "pilot-project", taskId: `TASK-${index + 1}`, path: `02-Projects/pilot-project/tasks/task-${index + 1}.md`, dependencies: [], orchestrationDependencies: [] }));
  createOrchestration({ runsRoot, record: { schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId, state: "BLOCKED", planFingerprint: plan.planFingerprint, nodes: { N01: { state: "DONE", taskId: "TASK-1", jobId: "job-N01", runId: "run-N01", attempt: 1, blockedBy: [], lastError: null }, N02: { state: "DONE", taskId: "TASK-2", jobId: "job-N02", runId: "run-N02", attempt: 1, blockedBy: [], lastError: null }, N03: { state: "BLOCKED", taskId: "TASK-3", jobId: null, runId: null, attempt: 1, blockedBy: ["TASK-2"], lastError: null } }, integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 20, agentInvocations: 2, retries: 0 }, createdAt: timestamp, updatedAt: timestamp, materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: taskMappings } }, validationOptions: { plan } });
  for (const [index, node] of nodes.slice(0, 2).entries()) {
    const taskId = `TASK-${index + 1}`;
    const queued = enqueueTaskJob({ runsRoot, projectId: "pilot-project", taskId, taskPath: taskMappings[index].path, requestedBy: "human:v2043", orchestrationManaged: true, schedulerAuthorized: true, orchestrationMetadata: { objectiveId, planId, orchestrationId, nodeId: node.nodeId, attempt: 1, planFingerprint: plan.planFingerprint, approvalDecisionId: `decision-plan-approval-${planId}`, approvedBy: "human:v2043", approvedAt: timestamp } });
    updateJob(runsRoot, queued.job.jobId, { state: "DONE", runId: `run-${node.nodeId}`, runState: "DONE" });
    writeRun(`run-${node.nodeId}`, taskId, node.allowedPaths, node.allowedPaths);
  }

  const failed = await startIntegration({ runsRoot, vaultRoot, objectiveId, verificationRunner: async () => ({ exitCode: 1, stderrTail: "integration mismatch" }) });
  assert.equal(failed.action, "INTEGRATION_BLOCKED");
  const repair = recoverIntegration({ runsRoot, objectiveId });
  assert.equal(repair.action, "INTEGRATION_REPAIR_PROPOSED");
  const approved = approvePlan({ runsRoot, objectiveId, planId: repair.plan.planId, expectedFingerprint: repair.plan.planFingerprint, approvedBy: "human:v2043" });
  assert.equal(approved.plan.state, "APPROVED");
  const materialized = materializeApprovedPlan({ vaultRoot, runsRoot, objectiveId, planId: approved.plan.planId, expectedFingerprint: approved.plan.planFingerprint, orchestrationId: "orch-obj-v2043-repair" });
  const repairOrchestration = materialized.orchestration;
  const repairPlan = materialized.plan;
  const runtime = Object.fromEntries(repairPlan.nodes.map((node) => [node.nodeId, { ...(repairOrchestration.nodes[node.nodeId] ?? {}), state: node.type === "INTEGRATION" ? "READY" : "DONE", jobId: node.type === "INTEGRATION" ? null : `job-repair-${node.nodeId}`, runId: node.type === "INTEGRATION" ? null : `run-repair-${node.nodeId}`, taskId: repairOrchestration.materialization.tasks.find((task) => task.nodeId === node.nodeId)?.taskId ?? null, attempt: 1, blockedBy: [], lastError: null }]));
  for (const node of repairPlan.nodes.filter((candidate) => candidate.type !== "INTEGRATION")) {
    const task = repairOrchestration.materialization.tasks.find((candidate) => candidate.nodeId === node.nodeId);
    const queued = enqueueTaskJob({ runsRoot, projectId: node.projectId, taskId: task.taskId, taskPath: task.path, requestedBy: "human:v2043", orchestrationManaged: true, schedulerAuthorized: true, orchestrationMetadata: { objectiveId, planId: repairPlan.planId, orchestrationId: repairOrchestration.orchestrationId, nodeId: node.nodeId, attempt: 1, planFingerprint: repairPlan.planFingerprint, approvalDecisionId: `decision-plan-approval-${repairPlan.planId}`, approvedBy: "human:v2043", approvedAt: timestamp } });
    updateJob(runsRoot, queued.job.jobId, { state: "DONE", runId: `run-repair-${node.nodeId}`, runState: "DONE" });
    writeRun(`run-repair-${node.nodeId}`, task.taskId, node.allowedPaths, node.type === "IMPLEMENTATION" ? node.allowedPaths : []);
  }
  updateOrchestration({ runsRoot, orchestrationId: repairOrchestration.orchestrationId, expectedRevision: repairOrchestration.revision, update: (record) => ({ ...record, state: "RUNNING", nodes: runtime }), validationOptions: { plan: repairPlan } });
  const final = await startIntegration({ runsRoot, vaultRoot, objectiveId, orchestrationId: repairOrchestration.orchestrationId, verificationRunner: async () => ({ exitCode: 0, stdoutTail: "integration passed" }) });
  assert.equal(final.action, "INTEGRATION_COMPLETED");
  assert.equal(getOrchestration(runsRoot, repairOrchestration.orchestrationId).nodes.N03.state, "DONE");
  resolveDecision({ runsRoot, decisionId: failed.decision.decisionId, action: "REPAIR_PLAN", resolvedBy: "human:v2043" });
  const accepted = acceptObjective({ runsRoot, objectiveId, acceptedBy: "human:v2043" });
  assert.equal(accepted.objective.state, "DONE");
  const certification = createSequentialIntegrationCertification({ runsRoot, objectiveId, initialOrchestrationId: orchestrationId, now: new Date(timestamp) });
  assert.equal(certification.status, "CERTIFICATION_READY");
  assert.deepEqual(certification.blockers, []);
  assert.equal(verifySequentialIntegrationCertification({ bundleFilePath: certification.bundlePath }).valid, true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("sequential-integration-certification.test.mjs: All tests passed!");
