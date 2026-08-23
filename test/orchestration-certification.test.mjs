import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createDecision } from "../src/decision-store.mjs";
import { createOrchestration } from "../src/orchestration-store.mjs";
import { enqueueTaskJob, updateJob } from "../src/job-queue.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { createSequentialOrchestrationCertification, verifySequentialOrchestrationCertification } from "../src/orchestration-certification.mjs";

console.log("Running orchestration-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-certification-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "pilot-project");
const timestamp = "2026-08-23T00:00:00.000Z";
const objectiveId = "obj-v2033-pilot";
const planId = `plan-${objectiveId}-r1`;
const orchestrationId = `orch-${objectiveId}`;
fs.mkdirSync(vaultRoot, { recursive: true });
fs.mkdirSync(repository, { recursive: true });
execFileSync("git", ["-C", repository, "init", "-q"]);
fs.mkdirSync(path.join(vaultRoot, "02-Projects", "pilot-project", "tasks"), { recursive: true });
fs.writeFileSync(path.join(vaultRoot, "02-Projects", "pilot-project", "project.md"), "---\ntype: project\n---\n\n# Pilot Project\n");
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| pilot-project | [[02-Projects/pilot-project/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));

const nodes = [
  { nodeId: "N01", title: "Diagnose pilot", purpose: "Record the pilot diagnosis.", projectId: "pilot-project", role: "DIAGNOSTIC", type: "DIAGNOSTIC", dependsOn: [], acceptanceCriteria: ["Diagnosis is recorded."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [] },
  { nodeId: "N02", title: "Implement pilot", purpose: "Implement the pilot change.", projectId: "pilot-project", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: ["N01"], acceptanceCriteria: ["Pilot change is implemented."], allowedPaths: ["src/pilot.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "pilot", contextFrom: ["N01"], skills: [] },
  { nodeId: "N03", title: "Verify pilot", purpose: "Verify the pilot change.", projectId: "pilot-project", role: "TESTING", type: "VERIFICATION", dependsOn: ["N02"], acceptanceCriteria: ["Pilot verification passes."], allowedPaths: [], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N02"], skills: [] },
];
const plan = {
  schemaVersion: 1,
  revision: 1,
  planId,
  objectiveId,
  state: "APPROVED",
  summary: "Sequential V2.3 pilot plan.",
  architectureDecisions: [],
  assumptions: [],
  clarificationNeeded: false,
  clarificationQuestion: null,
  projects: ["pilot-project"],
  nodes,
  integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
  risk: "LOW",
  complexity: "LOW",
  approvedBy: "human:v2033",
  approvedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};
plan.planFingerprint = planFingerprint(plan);

function taskDocument(node, taskId) {
  const allowed = node.allowedPaths.length ? `[${node.allowedPaths.join(", ")}]` : "[]";
  return [
    "---",
    `title: ${node.title}`,
    `task_id: ${taskId}`,
    "project: pilot-project",
    "status: DONE",
    `allowed_paths: ${allowed}`,
    "requires_changes: false",
    `objective_id: \"${objectiveId}\"`,
    `plan_id: \"${planId}\"`,
    `orchestration_id: \"${orchestrationId}\"`,
    `node_id: \"${node.nodeId}\"`,
    "orchestration_managed: true",
    "---",
    "",
    `# ${node.title}`,
    "",
    "## Acceptance Criteria",
    "",
    `- ${node.acceptanceCriteria[0]}`,
  ].join("\n");
}

const taskMappings = nodes.map((node, index) => {
  const taskId = `TASK-${String(index + 1).padStart(3, "0")}`;
  const relativePath = `02-Projects/pilot-project/tasks/${taskId.toLowerCase()}.md`;
  fs.writeFileSync(path.join(vaultRoot, relativePath), taskDocument(node, taskId));
  return { nodeId: node.nodeId, projectId: node.projectId, taskId, path: relativePath, dependencies: [], orchestrationDependencies: [] };
});

try {
  createObjective({
    runsRoot,
    record: {
      schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING",
      request: "Certify sequential pilot execution.", requestedBy: "human:v2033", projectIds: ["pilot-project"], freshProject: null,
      activePlanId: planId, activeOrchestrationId: orchestrationId,
      budget: { maxSubtasks: 3, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: null, deadlineAt: null },
      createdAt: timestamp, updatedAt: timestamp,
    },
  });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: ["pilot-project"], budget: { maxSubtasks: 3, maxParallelAgents: 1, maxRetriesPerNode: 1 } } });
  createDecision({
    runsRoot,
    record: {
      schemaVersion: 1, revision: 0, decisionId: `decision-plan-approval-${planId}`, objectiveId, nodeId: null, runId: null,
      type: "PLAN_APPROVAL", state: "RESOLVED", evidence: { planId, planFingerprint: plan.planFingerprint },
      requestedAction: "Approve the sequential pilot plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp,
      resolution: { action: "APPROVE", resolvedBy: "human:v2033", resolvedAt: timestamp },
    },
  });
  createOrchestration({
    runsRoot,
    record: {
      schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId, state: "DONE", planFingerprint: plan.planFingerprint,
      nodes: Object.fromEntries(nodes.map((node, index) => [node.nodeId, { state: "DONE", taskId: taskMappings[index].taskId, jobId: `job-${node.nodeId}`, runId: `run-${node.nodeId}`, attempt: 1, blockedBy: [], lastError: null }])),
      integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null },
      usage: { totalTokens: 0, agentInvocations: 0, retries: 0 }, createdAt: timestamp, updatedAt: timestamp,
      materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: taskMappings },
    },
    validationOptions: { plan },
  });

  for (const [index, node] of nodes.entries()) {
    const task = taskMappings[index];
    const runId = `run-${node.nodeId}`;
    const queued = enqueueTaskJob({
      runsRoot,
      projectId: task.projectId,
      taskId: task.taskId,
      taskPath: task.path,
      requestedBy: "human:v2033",
      orchestrationManaged: true,
      schedulerAuthorized: true,
      orchestrationMetadata: { objectiveId, planId, orchestrationId, nodeId: node.nodeId, attempt: 1, planFingerprint: plan.planFingerprint, approvalDecisionId: `decision-plan-approval-${planId}`, approvedBy: "human:v2033", approvedAt: timestamp },
    });
    const createdAt = new Date(Date.parse(timestamp) + index * 1000).toISOString();
    updateJob(runsRoot, queued.job.jobId, { state: "DONE", runId, runState: "DONE", createdAt });
    fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
      schemaVersion: 1, revision: 0, runId, state: "DONE", createdAt, updatedAt: createdAt,
      project: { id: "pilot-project", repository }, task: { id: task.taskId, title: node.title, path: task.path, allowedPaths: node.allowedPaths, status: "DONE" },
      completion: { completedAt: createdAt, completedBy: "human:v2033", humanApproved: true },
      knowledge: { approval: { approvedAt: createdAt, approvedBy: "human:v2033", classification: "PROJECT_ONLY", destination: "PROJECT" } },
      execution: { scopeAudit: { passed: true, changedPaths: node.allowedPaths, allowedPaths: node.allowedPaths, outOfScopePaths: [], deniedPaths: [] }, verification: [{ command: "test", exitCode: 0 }], result: { knowledgeDecision: "PROJECT_ONLY", gitCommit: { committed: true, commitHash: `${node.nodeId}-commit`, paths: node.allowedPaths } }, workspace: { state: "CLEANED", appliedAt: createdAt, appliedPaths: node.allowedPaths, postApplyVerification: [{ command: "test", exitCode: 0 }] } },
      history: [],
    }, null, 2));
  }

  const blocked = createSequentialOrchestrationCertification({ runsRoot, vaultRoot, objectiveId, restartEvidence: { status: "PASS", phase: "BLOCKED", safe: true }, now: new Date(timestamp) });
  assert.equal(blocked.status, "CERTIFICATION_READY");
  assert.deepEqual(blocked.blockers, []);
  assert.equal(blocked.humanGate.required, true);
  assert.equal(blocked.checks.find((check) => check.id === "CANONICAL_TASK_MAPPING").status, "PASS");
  assert.equal(blocked.evidence.nodeEvidence.length, 3);
  assert.equal(verifySequentialOrchestrationCertification({ bundleFilePath: blocked.bundlePath }).valid, true);

  const missingRestart = createSequentialOrchestrationCertification({ runsRoot, vaultRoot, objectiveId, now: new Date(timestamp) });
  assert.equal(missingRestart.status, "CONDITIONAL");
  assert.ok(missingRestart.blockers.includes("RESTART_RECOVERY"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("orchestration-certification.test.mjs: All tests passed!");
