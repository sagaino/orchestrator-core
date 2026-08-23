import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createDecision } from "../src/decision-store.mjs";
import { createOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { enqueueTaskJob } from "../src/job-queue.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";
import { getIntegrationEvidence, startIntegration } from "../src/integration-manager.mjs";
import { buildObjectiveEvidence } from "../src/objective-evidence.mjs";
import { DevServerManager } from "../src/dev-server-manager.mjs";

console.log("Running cross-project-verification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-project-verification-"));
const timestamp = "2026-08-23T00:00:00.000Z";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const vaultRoot = path.join(root, "vault");
  const runsRoot = path.join(root, "runs");
  const repositories = {
    frontend: path.join(root, "frontend"),
    backend: path.join(root, "backend"),
  };
  for (const [projectId, repository] of Object.entries(repositories)) {
    fs.mkdirSync(repository, { recursive: true });
    execFileSync("git", ["-C", repository, "init", "-q"]);
    fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({
      scripts: { dev: projectId === "backend" ? "./start.sh" : "node -e pass", test: "node -e pass", "test:contract": "node -e pass", "test:e2e": "node -e pass" },
    }));
    fs.writeFileSync(path.join(repository, "src.js"), `${projectId}\n`);
    execFileSync("git", ["-C", repository, "config", "user.email", `${projectId}@example.invalid`]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Cross Project Fixture"]);
    execFileSync("git", ["-C", repository, "add", "package.json", "src.js"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "fixture baseline"]);
  }
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "frontend"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "backend"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "frontend", "project.md"), "---\ntype: project\n---\n# Frontend\n");
  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "backend", "project.md"), "---\ntype: project\n---\n# Backend\n");
  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
    "# Project Registry",
    "| project_id | project_page | repository | agent | graphify | graphify_output |",
    "|---|---|---|---|---|---|",
    "| frontend | [[02-Projects/frontend/project.md]] | " + repositories.frontend + " | agy | false | " + repositories.frontend + "/graph.json |",
    "| backend | [[02-Projects/backend/project.md]] | " + repositories.backend + " | agy | false | " + repositories.backend + "/graph.json |",
  ].join("\n"));

  const objectiveId = "obj-cross-verification";
  const plan = {
    schemaVersion: 1,
    revision: 1,
    planId: `plan-${objectiveId}-r1`,
    objectiveId,
    state: "APPROVED",
    summary: "Verify the coordinated frontend/backend release.",
    architectureDecisions: [],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["backend", "frontend"],
    integration: {
      required: true,
      projectVerification: ["test"],
      crossProjectVerification: ["backend:test:contract", "frontend:test:e2e"],
      previewRequired: true,
    },
    nodes: [
      { nodeId: "N01", title: "Frontend change", purpose: "Apply the frontend fix.", projectId: "frontend", role: "FRONTEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["Frontend fix is committed."], allowedPaths: ["src.js"], verification: ["test"], risk: "MEDIUM", complexity: "MEDIUM", requiresChanges: true, canRunInParallel: true, writeConflictGroup: "frontend", contextFrom: [], skills: [] },
      { nodeId: "N02", title: "Backend change", purpose: "Apply the backend fix.", projectId: "backend", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["Backend fix is committed."], allowedPaths: ["src.js"], verification: ["test"], risk: "MEDIUM", complexity: "MEDIUM", requiresChanges: true, canRunInParallel: true, writeConflictGroup: "backend", contextFrom: [], skills: [] },
      { nodeId: "N03", title: "Cross-project verification", purpose: "Verify the coordinated release.", projectId: "backend", role: "INTEGRATION", type: "INTEGRATION", dependsOn: ["N01", "N02"], acceptanceCriteria: ["Per-repository and cross-project checks pass."], allowedPaths: [], verification: ["test:contract"], risk: "MEDIUM", complexity: "HIGH", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N01", "N02"], skills: [] },
    ],
    risk: "MEDIUM",
    complexity: "HIGH",
    approvedBy: "human:verification",
    approvedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  plan.planFingerprint = planFingerprint(plan);
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: ["frontend", "backend"], budget: { maxSubtasks: 3, maxParallelAgents: 2, maxRetriesPerNode: 1, maxRepairCycles: 1 } } });
  createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "CROSS_PROJECT_INCIDENT", state: "RUNNING", request: "Verify the coordinated release.", requestedBy: "human:verification", projectIds: ["frontend", "backend"], freshProject: null, activePlanId: plan.planId, activeOrchestrationId: `orch-${objectiveId}`, budget: { maxSubtasks: 3, maxParallelAgents: 2, maxRetriesPerNode: 1, maxRepairCycles: 1, maxTotalTokens: 10_000, deadlineAt: null }, createdAt: timestamp, updatedAt: timestamp } });
  createDecision({ runsRoot, record: { schemaVersion: 1, revision: 0, decisionId: `decision-plan-approval-${plan.planId}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED", evidence: { planId: plan.planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve verification plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp, resolution: { action: "APPROVE", resolvedBy: "human:verification", resolvedAt: timestamp } } });

  const taskMappings = {};
  const runtimeNodes = {};
  for (const [index, [nodeId, projectId]] of [["N01", "frontend"], ["N02", "backend"]].entries()) {
    const taskId = `TASK-${index + 1}`;
    const taskPath = `02-Projects/${projectId}/tasks/${taskId.toLowerCase()}.md`;
    taskMappings[nodeId] = { nodeId, projectId, taskId, path: taskPath, dependencies: [], orchestrationDependencies: [] };
    fs.mkdirSync(path.join(vaultRoot, "02-Projects", projectId, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, taskPath), `---\ntask_id: ${taskId}\nproject: ${projectId}\nstatus: DONE\n---\n# ${taskId}\n`);
    const job = enqueueTaskJob({ runsRoot, projectId, taskId, taskPath, requestedBy: "human:verification", orchestrationManaged: true, schedulerAuthorized: true, orchestrationMetadata: { objectiveId, planId: plan.planId, orchestrationId: `orch-${objectiveId}`, nodeId, attempt: 1, planFingerprint: plan.planFingerprint, approvalDecisionId: `decision-plan-approval-${plan.planId}`, approvedBy: "human:verification", approvedAt: timestamp } });
    const runId = `run-${projectId}`;
    writeJson(path.join(runsRoot, `${runId}.json`), { schemaVersion: 1, revision: 0, runId, state: "DONE", createdAt: timestamp, updatedAt: timestamp, project: { id: projectId, repository: repositories[projectId] }, task: { id: taskId, path: taskPath, allowedPaths: ["src.js"] }, execution: { scopeAudit: { passed: true, changedPaths: ["src.js"], allowedPaths: ["src.js"], outOfScopePaths: [], deniedPaths: [] }, result: { gitCommit: { committed: true, commitHash: `${projectId}-commit` } }, workspace: { baseCommit: `${projectId}-base`, state: "CLEANED", appliedPaths: ["src.js"] }, verification: [{ command: "test", exitCode: 0 }] }, history: [] });
    runtimeNodes[nodeId] = { state: "DONE", taskId, jobId: job.jobId ?? null, runId, attempt: 1, blockedBy: [], lastError: null };
  }
  runtimeNodes.N03 = { state: "READY", taskId: null, jobId: null, runId: null, attempt: 1, blockedBy: [], lastError: null };
  createOrchestration({ runsRoot, record: { schemaVersion: 1, revision: 0, orchestrationId: `orch-${objectiveId}`, objectiveId, planId: plan.planId, state: "RUNNING", planFingerprint: plan.planFingerprint, nodes: runtimeNodes, integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 20, agentInvocations: 2, retries: 0 }, createdAt: timestamp, updatedAt: timestamp, materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: taskMappings } }, validationOptions: { plan } });
  return { vaultRoot, runsRoot, objectiveId, orchestrationId: `orch-${objectiveId}`, repositories };
}

const fixture = createFixture();
const serviceStarts = [];
const serviceStops = [];
const verificationCalls = [];
const devServerManager = {
  async startDevServer(input) {
    assert.equal(input.host, "127.0.0.1");
    assert.match(input.runId, /^integration-orch-obj-cross-verification-/);
    serviceStarts.push(input);
    const port = input.projectId === "frontend" ? 5311 : 5312;
    return { runId: input.runId, projectId: input.projectId, host: input.host, port, url: `http://127.0.0.1:${port}`, status: "RUNNING", startedAt: timestamp };
  },
  stopDevServer(runId) { serviceStops.push(runId); return { stopped: true, runId }; },
};
const result = await startIntegration({
  ...fixture,
  devServerManager,
  verificationRunner: async (input) => {
    verificationCalls.push(input);
    assert.equal(input.approved, true);
    return { exitCode: 0, stdoutTail: `${input.scope}:${input.projectId}:${input.script}` };
  },
});
assert.equal(result.action, "INTEGRATION_COMPLETED");
assert.equal(result.integration.state, "PASSED");
assert.equal(serviceStarts.length, 1);
assert.equal(serviceStarts[0].projectId, "frontend");
assert.equal(serviceStops.length, 1);
assert.equal(verificationCalls.length, 4);
assert.deepEqual(new Set(verificationCalls.map((input) => input.scope)), new Set(["PROJECT", "CROSS_PROJECT"]));
assert.ok(verificationCalls.filter((input) => input.scope === "CROSS_PROJECT").every((input) => input.serviceUrls.frontend.startsWith("http://127.0.0.1:") && input.serviceUrls.backend === undefined));
assert.ok(verificationCalls.filter((input) => input.scope === "CROSS_PROJECT").every((input) => input.command.startsWith("npm run ")));

const evidence = getIntegrationEvidence({ runsRoot: fixture.runsRoot, orchestrationId: fixture.orchestrationId });
assert.deepEqual(Object.keys(evidence.projectBaselines).sort(), ["backend", "frontend"]);
assert.equal(evidence.sourceRuns.length, 2);
assert.equal(evidence.repositoryAcceptance.every((item) => item.acceptance.status === "PASS"), true);
assert.equal(evidence.crossProjectVerification.status, "PASS");
assert.equal(evidence.crossProjectVerification.results.length, 2);
assert.equal(evidence.services.every((service) => service.host === "127.0.0.1"), true);
assert.equal(buildObjectiveEvidence({ runsRoot: fixture.runsRoot, objectiveId: fixture.objectiveId }).finalAcceptance.canAccept, true);
assert.equal(getOrchestration(fixture.runsRoot, fixture.orchestrationId).state, "DONE");

await assert.rejects(
  () => new DevServerManager().startDevServer({ runsRoot: fixture.runsRoot, runId: "public-bind", repository: fixture.repositories.frontend, host: "0.0.0.0" }),
  /loopback/,
);

console.log("cross-project-verification.test.mjs: All tests passed!");
