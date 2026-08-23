import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { getDecision, decisionPath } from "../src/decision-store.mjs";
import { listJobs } from "../src/job-queue.mjs";
import { listRuns } from "../src/run-manager.mjs";

console.log("Running fresh-project-genesis-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-project-genesis-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const successTarget = path.join(root, "success-project");
const failedTarget = path.join(root, "failed-project");
fs.mkdirSync(vaultRoot, { recursive: true });
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
].join("\n"));

let service;
let session;
let successCalls = 0;
let failureCalls = 0;
let failureMode = true;
const successOnboard = async (input) => {
  successCalls += 1;
  return { schemaVersion: 1, action: "NEW_PROJECT_CREATED", onboardingId: "onboard-success-1", project: { id: input.projectId, repository: input.targetDirectory, blueprint: input.blueprint } };
};
const failureThenSuccessOnboard = async (input) => {
  failureCalls += 1;
  if (failureMode) throw new Error("injected onboarding failure");
  return { schemaVersion: 1, action: "NEW_PROJECT_CREATED", onboardingId: "onboard-retry-1", project: { id: input.projectId, repository: input.targetDirectory, blueprint: input.blueprint } };
};

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
      onboardNewProject: successOnboard,
    },
  });
  await service.start();
  const sessionResponse = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
  session = (await sessionResponse.json()).data;

  const successObjective = await request("POST", "/api/objectives", {
    body: { mode: "FRESH_PROJECT", projectId: "success-app", targetDirectory: successTarget, blueprint: "frontend-vite", request: "Create the success fixture." },
    idempotencyKey: "genesis-objective-success",
  });
  assert.equal(successObjective.response.status, 201);
  const successId = successObjective.data.data.objective.objectiveId;

  const approved = await request("POST", `/api/objectives/${successId}/approve-genesis`, { body: {}, idempotencyKey: "genesis-approve-success" });
  assert.equal(approved.response.status, 201);
  assert.equal(approved.data.data.objective.state, "PLANNING");
  assert.equal(approved.data.data.objective.freshProject.onboarding.state, "COMPLETED");
  assert.equal(approved.data.data.decision.type, "FRESH_PROJECT_CREATION");
  assert.equal(approved.data.data.decision.creator, "SYSTEM");
  assert.equal(approved.data.data.decision.resolution.action, "APPROVE");
  assert.equal(successCalls, 1);

  const repeatedApproval = await request("POST", `/api/objectives/${successId}/approve-genesis`, { body: {}, idempotencyKey: "genesis-approve-success-again" });
  assert.equal(repeatedApproval.response.status, 200);
  assert.equal(repeatedApproval.data.data.alreadyCompleted, true);
  assert.equal(successCalls, 1);
  assert.equal(fs.existsSync(decisionPath(runsRoot, `decision-genesis-${successId}`)), true);

  const failedObjective = await request("POST", "/api/objectives", {
    body: { mode: "FRESH_PROJECT", projectId: "failed-app", targetDirectory: failedTarget, blueprint: "frontend-vite", request: "Create the failure fixture." },
    idempotencyKey: "genesis-objective-failure",
  });
  const failedId = failedObjective.data.data.objective.objectiveId;
  // The server's injected service is replaced by the mutable dispatcher through a fresh server below.
  await service.stop();
  service = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: 0,
    host: "127.0.0.1",
    apiToken: "g".repeat(64),
    services: {
      objectivesEnabled: () => true,
      crossProjectEnabled: () => false,
      onboardNewProject: failureThenSuccessOnboard,
    },
  });
  await service.start();
  const retrySessionResponse = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
  session = (await retrySessionResponse.json()).data;

  const failed = await request("POST", `/api/objectives/${failedId}/approve-genesis`, { body: {}, idempotencyKey: "genesis-approve-failure" });
  assert.equal(failed.response.status, 502);
  assert.equal(failed.data.error.details.code, "FRESH_PROJECT_ONBOARDING_FAILED");
  const failedState = await request("GET", `/api/objectives/${failedId}`);
  assert.equal(failedState.data.data.state, "FAILED");
  assert.equal(failedState.data.data.freshProject.onboarding.state, "FAILED");
  assert.equal(failedState.data.data.freshProject.onboarding.cleanup.clean, true);
  assert.equal(fs.existsSync(failedTarget), false);
  const failureDecision = getDecision(runsRoot, `decision-genesis-${failedId}`);
  assert.equal(failureDecision.type, "FRESH_PROJECT_CREATION");
  assert.equal(failureDecision.resolution.action, "APPROVE");

  failureMode = false;
  const retried = await request("POST", `/api/objectives/${failedId}/approve-genesis`, { body: {}, idempotencyKey: "genesis-approve-retry" });
  assert.equal(retried.response.status, 201);
  assert.equal(retried.data.data.objective.state, "PLANNING");
  assert.equal(retried.data.data.objective.freshProject.onboarding.state, "COMPLETED");
  assert.equal(failureCalls, 2);
  assert.equal(listJobs(runsRoot).length, 0);
  assert.equal(listRuns(runsRoot).length, 0);
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("fresh-project-genesis-api.test.mjs: All tests passed!");
