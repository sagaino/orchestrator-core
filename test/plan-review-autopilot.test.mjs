import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { planObjective } from "../src/objective-planning.mjs";
import { reviewAutomationFailurePatch, shouldAutomaticallyFinalizeReview } from "../src/daemon.mjs";

console.log("Running plan-review-autopilot.test.mjs...");

assert.equal(shouldAutomaticallyFinalizeReview({
  env: { ORCHESTRATOR_APPROVAL_MODE: "PLAN_REVIEW_THEN_AUTOPILOT" },
  job: { objectiveId: "obj-1", orchestrationId: "orch-1", orchestration: { managed: true } },
  manifest: { state: "RETROSPECTIVE" },
}), true);
assert.equal(shouldAutomaticallyFinalizeReview({
  env: { ORCHESTRATOR_APPROVAL_MODE: "MANUAL" },
  job: { objectiveId: "obj-1", orchestrationId: "orch-1", orchestration: { managed: true } },
  manifest: { state: "RETROSPECTIVE" },
}), false);
assert.deepEqual(
  reviewAutomationFailurePatch({
    job: { jobId: "job-1", runState: "RETROSPECTIVE" },
    manifest: { state: "FAILED" },
    error: new Error("Workspace apply conflict."),
    now: new Date("2026-08-24T09:00:00.000Z"),
  }),
  {
    state: "FAILED",
    runState: "FAILED",
    finishedAt: "2026-08-24T09:00:00.000Z",
    error: "Workspace apply conflict.",
    reviewAutomation: {
      status: "FAILED",
      lastAttemptAt: "2026-08-24T09:00:00.000Z",
      approvedBy: "system:autopilot",
      error: "Workspace apply conflict.",
    },
  },
);
assert.equal(shouldAutomaticallyFinalizeReview({
  env: { ORCHESTRATOR_APPROVAL_MODE: "PLAN_REVIEW_THEN_AUTOPILOT" },
  job: { projectId: "legacy-project" },
  manifest: { state: "RETROSPECTIVE" },
}), false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-autopilot-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "repository");
fs.mkdirSync(path.join(vaultRoot, "02-Projects", "review-app"), { recursive: true });
fs.mkdirSync(repository, { recursive: true });
fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --version" } }));
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| review-app | [[02-Projects/review-app/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));
fs.writeFileSync(path.join(vaultRoot, "02-Projects", "review-app", "project.md"), "---\ntitle: Review App\nverification_defaults:\n  - test\n---\n# Review App\n");

const candidate = (objective) => ({
  schemaVersion: 1,
  planId: `plan-${objective.objectiveId}-r1`,
  objectiveId: objective.objectiveId,
  revision: 1,
  state: "PENDING_APPROVAL",
  summary: "Run the bounded review diagnostic.",
  architectureDecisions: [],
  assumptions: [],
  clarificationNeeded: false,
  clarificationQuestion: null,
  projects: ["review-app"],
  nodes: [{
    nodeId: "N01",
    title: "Inspect review fixture",
    purpose: "Verify the fixture without changing product files.",
    projectId: "review-app",
    role: "DIAGNOSTIC",
    type: "DIAGNOSTIC",
    dependsOn: [],
    acceptanceCriteria: ["The fixture is inspected."],
    allowedPaths: [],
    verification: ["test"],
    risk: "LOW",
    complexity: "LOW",
    requiresChanges: false,
    canRunInParallel: false,
    writeConflictGroup: null,
    contextFrom: [],
    skills: [],
  }],
  integration: { required: false, projectVerification: ["test"], crossProjectVerification: [], previewRequired: false },
  risk: "LOW",
  complexity: "LOW",
  approvedBy: null,
  approvedAt: null,
});

let service;
let session;
async function request(method, requestPath, { body = null, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${service.token}`, "Idempotency-Key": idempotencyKey };
  if (session && ["POST", "PUT", "DELETE"].includes(method)) {
    headers["X-Operator-Session"] = session.sessionId;
    headers["X-Action-Nonce"] = session.actionNonce;
  }
  if (body !== null) headers["Content-Type"] = "application/json";
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
    apiToken: "b".repeat(64),
    env: { ...process.env, ORCHESTRATOR_APPROVAL_MODE: "PLAN_REVIEW_THEN_AUTOPILOT" },
    services: {
      objectivesEnabled: () => true,
      crossProjectEnabled: () => false,
      planObjective: (options) => planObjective({ ...options, decomposer: async ({ objective }) => ({ status: "PLAN_REVIEW", plan: candidate(objective) }) }),
    },
  });
  await service.start();
  const sessionResponse = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
  session = (await sessionResponse.json()).data;

  const created = await request("POST", "/api/objectives", { body: { mode: "EXISTING_PROJECT", projectIds: ["review-app"], request: "Inspect the review fixture." }, idempotencyKey: "review-objective" });
  assert.equal(created.response.status, 201);
  const objectiveId = created.data.data.objective.objectiveId;
  const planned = await request("POST", `/api/objectives/${objectiveId}/generate-plan`, { body: {}, idempotencyKey: "review-plan" });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.data.data.automation.approvalMode, "PLAN_REVIEW_THEN_AUTOPILOT");
  assert.equal(planned.data.data.automation.started, false);
  assert.equal(planned.data.data.plan.state, "PENDING_APPROVAL");
  assert.equal(planned.data.data.objective.state, "PLAN_REVIEW");

  const approved = await request("POST", `/api/objectives/${objectiveId}/approve-plan`, {
    body: { planFingerprint: planned.data.data.plan.planFingerprint },
    idempotencyKey: "review-approval",
  });
  assert.equal(approved.response.status, 201);
  assert.equal(approved.data.data.automation.approvalMode, "PLAN_REVIEW_THEN_AUTOPILOT");
  assert.equal(approved.data.data.automation.started, true);
  assert.equal(approved.data.data.tasks.length, 1);
  assert.equal(approved.data.data.objective.state, "MATERIALIZING");

  const evidence = await request("GET", `/api/objectives/${objectiveId}/evidence`, { idempotencyKey: "review-evidence" });
  assert.equal(evidence.data.data.automation.planReviewRequired, true);
  assert.equal(evidence.data.data.automation.finalAcceptOnly, false);
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("plan-review-autopilot.test.mjs: All tests passed!");
