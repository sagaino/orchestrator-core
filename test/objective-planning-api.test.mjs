import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { planObjective } from "../src/objective-planning.mjs";
import { listJobs } from "../src/job-queue.mjs";
import { listRuns } from "../src/run-manager.mjs";

console.log("Running objective-planning-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "objective-planning-api-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "repository");
fs.mkdirSync(path.join(vaultRoot, "02-Projects", "planning-app"), { recursive: true });
fs.mkdirSync(repository, { recursive: true });
fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({
  dependencies: { react: "^18.3.1" },
  devDependencies: { vite: "^5.4.2", typescript: "^5.5.4" },
  scripts: { test: "node --version", build: "node --version" },
}));
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| planning-app | [[02-Projects/planning-app/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));
fs.writeFileSync(path.join(vaultRoot, "02-Projects", "planning-app", "project.md"), "---\ntitle: Planning App\nverification_defaults:\n  - test\n---\n# Planning App\nUse the repository as source of truth.\n");

function candidate(objective) {
  return {
    schemaVersion: 1,
    planId: `plan-${objective.objectiveId}-r1`,
    objectiveId: objective.objectiveId,
    revision: 1,
    state: "PENDING_APPROVAL",
    summary: "Implement the requested planning fixture safely.",
    architectureDecisions: [],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["planning-app"],
    nodes: [{
      nodeId: "N01",
      title: "Implement planning fixture",
      purpose: "Apply the requested bounded fixture change.",
      projectId: "planning-app",
      role: "GENERAL",
      type: "IMPLEMENTATION",
      dependsOn: [],
      acceptanceCriteria: ["The requested fixture change is implemented."],
      allowedPaths: ["src/fixture.js"],
      verification: ["test"],
      risk: "LOW",
      complexity: "LOW",
      requiresChanges: true,
      canRunInParallel: false,
      writeConflictGroup: "fixture",
      contextFrom: [],
      skills: [],
    }],
    integration: { required: false, projectVerification: ["test"], crossProjectVerification: [], previewRequired: false },
    risk: "LOW",
    complexity: "LOW",
    approvedBy: null,
    approvedAt: null,
    createdAt: "2026-08-23T00:00:00.000Z",
  };
}

let providerCalls = 0;
let clarifyFirst = false;
let failNextPlanning = false;
const decomposer = async ({ objective, projectContexts }) => {
  providerCalls += 1;
  assert.deepEqual(projectContexts[0].verification, ["test"]);
  if (failNextPlanning) {
    failNextPlanning = false;
    return { status: "INVALID_PROVIDER_ENVELOPE", plan: null, readOnly: true };
  }
  if (clarifyFirst && !objective.request.includes("Human clarification")) {
    return { status: "NEEDS_CLARIFICATION", objectiveState: "NEEDS_CLARIFICATION", clarificationNeeded: true, clarificationQuestion: "File mana yang menjadi target?", plan: null, readOnly: true, planning: { started: true, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 } };
  }
  return { status: "PLAN_REVIEW", objectiveState: "PLAN_REVIEW", clarificationNeeded: false, clarificationQuestion: null, plan: candidate(objective), readOnly: true, planning: { started: true, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 } };
};

let service;
let session;
async function request(method, requestPath, { body = null, idempotencyKey = null } = {}) {
  const headers = { Authorization: `Bearer ${service.token}` };
  if (session && ["POST", "PUT", "DELETE"].includes(method)) {
    headers["X-Operator-Session"] = session.sessionId;
    headers["X-Action-Nonce"] = session.actionNonce;
  }
  if (body !== null) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}${requestPath}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  const data = await response.json();
  const nextNonce = response.headers.get("x-action-nonce");
  if (nextNonce && session) session.actionNonce = nextNonce;
  return { response, data };
}

try {
  service = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: 0,
    host: "127.0.0.1",
    apiToken: "g".repeat(64),
    services: {
      objectivesEnabled: () => true,
      crossProjectEnabled: () => false,
      planObjective: (options) => planObjective({ ...options, decomposer }),
    },
  });
  await service.start();
  const sessionResponse = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
  session = (await sessionResponse.json()).data;

  const created = await request("POST", "/api/objectives", { body: { mode: "EXISTING_PROJECT", projectIds: ["planning-app"], request: "Implement a deterministic fixture.", attachments: [{ type: "MOCKUP", fileName: "fixture.png", relativeVaultPath: "00-Inbox/assets/fixture.png", sizeBytes: 10 }] }, idempotencyKey: "planning-objective" });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.data.objective.attachments[0].fileName, "fixture.png");
  const objectiveId = created.data.data.objective.objectiveId;

  const planned = await request("POST", `/api/objectives/${objectiveId}/generate-plan`, { body: {}, idempotencyKey: "generate-plan" });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.data.data.objective.state, "PLAN_REVIEW");
  assert.equal(planned.data.data.plan.planId, `plan-${objectiveId}-r1`);
  assert.equal(listJobs(runsRoot).length, 0);
  assert.equal(listRuns(runsRoot).length, 0);

  const duplicate = await request("POST", `/api/objectives/${objectiveId}/generate-plan`, { body: {}, idempotencyKey: "generate-plan" });
  assert.equal(duplicate.response.headers.get("x-cache"), "IDEMPOTENT_HIT");
  assert.equal(providerCalls, 1);

  clarifyFirst = true;
  const clarificationObjective = await request("POST", "/api/objectives", { body: { mode: "EXISTING_PROJECT", projectIds: ["planning-app"], request: "Change the ambiguous fixture." }, idempotencyKey: "clarification-objective" });
  const clarificationId = clarificationObjective.data.data.objective.objectiveId;
  const needed = await request("POST", `/api/objectives/${clarificationId}/generate-plan`, { body: {}, idempotencyKey: "clarification-needed" });
  assert.equal(needed.data.data.objective.state, "NEEDS_CLARIFICATION");
  assert.equal(needed.data.data.clarificationQuestion, "File mana yang menjadi target?");
  const clarified = await request("POST", `/api/objectives/${clarificationId}/generate-plan`, { body: { clarification: "Gunakan src/fixture.js." }, idempotencyKey: "clarification-answer" });
  assert.equal(clarified.data.data.objective.state, "PLAN_REVIEW");
  assert.equal(clarified.data.data.objective.planning, undefined);

  const recoveryBody = { mode: "EXISTING_PROJECT", projectIds: ["planning-app"], request: "Recover a provider planning failure." };
  const recoveryCreated = await request("POST", "/api/objectives", { body: recoveryBody, idempotencyKey: "recovery-objective" });
  assert.equal(recoveryCreated.response.status, 201);
  const recoveryId = recoveryCreated.data.data.objective.objectiveId;
  failNextPlanning = true;
  const failedPlan = await request("POST", `/api/objectives/${recoveryId}/generate-plan`, { body: {}, idempotencyKey: "recovery-plan-failure" });
  assert.equal(failedPlan.response.status, 502);

  const resumed = await request("POST", "/api/objectives", { body: recoveryBody, idempotencyKey: "recovery-objective-after-failure" });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.data.data.alreadyExisting, true);
  assert.equal(resumed.data.data.objective.objectiveId, recoveryId);
  const recoveredPlan = await request("POST", `/api/objectives/${recoveryId}/generate-plan`, { body: {}, idempotencyKey: "recovery-plan-retry" });
  assert.equal(recoveredPlan.response.status, 201);
  assert.equal(recoveredPlan.data.data.objective.objectiveId, recoveryId);

  const cancelledBody = { mode: "EXISTING_PROJECT", projectIds: ["planning-app"], request: "Retry after cancellation should create a new objective." };
  const cancelledCreated = await request("POST", "/api/objectives", { body: cancelledBody, idempotencyKey: "cancelled-objective" });
  const cancelledId = cancelledCreated.data.data.objective.objectiveId;
  const cancelledPlan = await request("POST", `/api/objectives/${cancelledId}/generate-plan`, { body: {}, idempotencyKey: "cancelled-plan" });
  assert.equal(cancelledPlan.response.status, 201);
  const cancelled = await request("POST", `/api/objectives/${cancelledId}/cancel`, { body: {}, idempotencyKey: "cancel-objective" });
  assert.equal(cancelled.response.status, 201);
  assert.equal(cancelled.data.data.objective.state, "CANCELLED");
  const cancelledRetry = await request("POST", `/api/objectives/${cancelledId}/generate-plan`, { body: {}, idempotencyKey: "cancelled-plan-retry" });
  assert.equal(cancelledRetry.response.status, 409);
  assert.equal(cancelledRetry.data.error.details.code, "OBJECTIVE_CANCELLED_RECREATE_REQUIRED");
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("objective-planning-api.test.mjs: All tests passed!");
