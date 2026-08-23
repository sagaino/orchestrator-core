import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { listJobs } from "../src/job-queue.mjs";
import { listRuns } from "../src/run-manager.mjs";
import { objectivesEnabled } from "../src/objective-intake.mjs";

console.log("Running objective-intake-api.test.mjs...");
assert.equal(objectivesEnabled({}), false);
assert.equal(objectivesEnabled({ ORCHESTRATOR_OBJECTIVES_ENABLED: "1" }), true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "objective-intake-api-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "repository");
fs.mkdirSync(path.join(vaultRoot, "02-Projects", "starter-app"), { recursive: true });
fs.mkdirSync(repository, { recursive: true });
fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ name: "starter-app", scripts: { test: "node -e pass" } }));
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| starter-app | [[02-Projects/starter-app/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));
fs.writeFileSync(path.join(vaultRoot, "02-Projects", "starter-app", "project.md"), "---\ntitle: Starter App\ntype: project\n---\n# Starter App\n");

let service;
let operatorSession;
async function request(method, requestPath, { body = null, idempotencyKey = null } = {}) {
  const headers = { Authorization: `Bearer ${service.token}` };
  if (operatorSession && ["POST", "PUT", "DELETE"].includes(method)) {
    headers["X-Operator-Session"] = operatorSession.sessionId;
    headers["X-Action-Nonce"] = operatorSession.actionNonce;
  }
  if (body !== null) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}${requestPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  const nextNonce = response.headers.get("x-action-nonce");
  if (nextNonce && operatorSession) operatorSession.actionNonce = nextNonce;
  return { response, data };
}

try {
  service = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: 0,
    host: "127.0.0.1",
    apiToken: "o".repeat(64),
    services: {
      objectivesEnabled: () => true,
      crossProjectEnabled: () => false,
    },
  });
  await service.start();
  const sessionResponse = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
  operatorSession = (await sessionResponse.json()).data;

  const existingBody = { mode: "EXISTING_PROJECT", projectIds: ["starter-app"], request: "Review the starter project architecture.", budget: { maxSubtasks: 3, maxParallelAgents: 1, maxRetriesPerNode: 1 } };
  const created = await request("POST", "/api/objectives", { body: existingBody, idempotencyKey: "objective-create-1" });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.data.objective.state, "PLANNING");
  assert.equal(created.data.data.planning.tasksCreated, 0);
  assert.equal(created.data.data.planning.jobsCreated, 0);
  assert.equal(created.data.data.planning.runsCreated, 0);
  const objectiveId = created.data.data.objective.objectiveId;

  const duplicate = await request("POST", "/api/objectives", { body: existingBody, idempotencyKey: "objective-create-1" });
  assert.equal(duplicate.response.status, 201);
  assert.equal(duplicate.response.headers.get("x-cache"), "IDEMPOTENT_HIT");
  assert.equal(duplicate.data.data.objective.objectiveId, objectiveId);

  const listed = await request("GET", "/api/objectives");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.data.data.length, 1);
  assert.equal(listed.data.data[0].objectiveId, objectiveId);

  const read = await request("GET", `/api/objectives/${objectiveId}`);
  assert.equal(read.response.status, 200);
  assert.equal(read.data.data.objectiveId, objectiveId);
  assert.equal((await request("GET", "/api/objectives/missing-objective")).response.status, 404);

  const missingProject = await request("POST", "/api/objectives", { body: { mode: "EXISTING_PROJECT", projectIds: ["missing"], request: "This must fail." }, idempotencyKey: "objective-missing" });
  assert.equal(missingProject.response.status, 404);
  assert.equal(missingProject.data.error.details.code, "PROJECT_NOT_FOUND");

  const crossProject = await request("POST", "/api/objectives", { body: { mode: "CROSS_PROJECT_INCIDENT", projectIds: ["starter-app", "missing"], request: "Diagnose a linked incident." }, idempotencyKey: "objective-cross" });
  assert.equal(crossProject.response.status, 409);
  assert.equal(crossProject.data.error.details.code, "FEATURE_DISABLED");

  const freshTarget = path.join(root, "fresh-project");
  const fresh = await request("POST", "/api/objectives", { body: { mode: "FRESH_PROJECT", projectIds: ["fresh-app"], projectId: "fresh-app", targetDirectory: freshTarget, blueprint: "frontend-vite", request: "Create a fresh app shell." }, idempotencyKey: "objective-fresh" });
  assert.equal(fresh.response.status, 201);
  assert.equal(fresh.data.data.objective.state, "GENESIS_REVIEW");
  assert.equal(fresh.data.data.objective.freshProject.action, "ONBOARD_WITH_EXISTING_BLUEPRINT");
  assert.equal(fresh.data.data.objective.freshProject.blueprint, "frontend-vite");
  assert.equal(fs.existsSync(freshTarget), false);

  const missingKey = await request("POST", "/api/objectives", { body: existingBody });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.data.error.details.code, "IDEMPOTENCY_REQUIRED");

  assert.equal(listJobs(runsRoot).length, 0);
  assert.equal(listRuns(runsRoot).length, 0);
  assert.equal(fs.existsSync(path.join(vaultRoot, "02-Projects", "starter-app", "tasks")), false);
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("objective-intake-api.test.mjs: All tests passed!");
