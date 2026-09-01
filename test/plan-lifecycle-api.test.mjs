import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { getDecision } from "../src/decision-store.mjs";
import { getPlan } from "../src/plan-store.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";

console.log("Running plan-lifecycle-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-api-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "repository");
fs.mkdirSync(repository, { recursive: true });
fs.mkdirSync(vaultRoot, { recursive: true });
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| lifecycle-app | [[02-Projects/lifecycle-app/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));

function candidate({ approvedBy = null } = {}) {
  return {
    schemaVersion: 1,
    planId: "plan-placeholder-r1",
    objectiveId: "obj-placeholder",
    revision: 1,
    state: "PENDING_APPROVAL",
    summary: "Review the lifecycle fixture.",
    architectureDecisions: ["Keep the diagnostic node read-only."],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["lifecycle-app"],
    nodes: [{
      nodeId: "N01",
      title: "Inspect lifecycle",
      purpose: "Verify the lifecycle fixture without writing product code.",
      projectId: "lifecycle-app",
      role: "DIAGNOSTIC",
      type: "DIAGNOSTIC",
      dependsOn: [],
      acceptanceCriteria: ["The lifecycle state is visible."],
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
    verificationIntent: {
      contractVersion: 1,
      required: [{ projectId: "lifecycle-app", capability: "UNIT", source: "EXPLICIT" }],
      resolved: [{ projectId: "lifecycle-app", capability: "UNIT", script: "test" }],
      missing: [],
      status: "RESOLVED",
    },
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
    risk: "LOW",
    complexity: "LOW",
    approvedBy,
    approvedAt: null,
    createdAt: "2026-08-22T00:00:00.000Z",
  };
}

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
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}${requestPath}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
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
    apiToken: "p".repeat(64),
    services: { objectivesEnabled: () => true, crossProjectEnabled: () => false },
  });
  await service.start();
  const sessionResponse = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
  session = (await sessionResponse.json()).data;

  const created = await request("POST", "/api/objectives", {
    body: { mode: "EXISTING_PROJECT", projectIds: ["lifecycle-app"], request: "Review the lifecycle fixture." },
    idempotencyKey: "lifecycle-objective",
  });
  assert.equal(created.response.status, 201);
  const objectiveId = created.data.data.objective.objectiveId;

  const modelApproval = await request("POST", `/api/objectives/${objectiveId}/plan`, {
    body: { plan: candidate({ approvedBy: "model-forged-identity" }) },
    idempotencyKey: "lifecycle-forged-plan",
  });
  assert.equal(modelApproval.response.status, 422);
  assert.equal(modelApproval.data.error.details.code, "MODEL_APPROVAL_FORBIDDEN");

  const planned = await request("POST", `/api/objectives/${objectiveId}/plan`, {
    body: { plan: candidate() },
    idempotencyKey: "lifecycle-plan-r1",
  });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.data.data.plan.planId, `plan-${objectiveId}-r1`);
  assert.equal(planned.data.data.revision, 1);
  const planOne = planned.data.data.plan;
  const fingerprintOne = planFingerprint(planOne);
  assert.equal(planOne.planFingerprint, fingerprintOne);

  const approvedOne = await request("POST", `/api/objectives/${objectiveId}/approve-plan`, {
    body: { planId: planOne.planId, planFingerprint: fingerprintOne, approvedBy: "spoofed-body-identity" },
    idempotencyKey: "lifecycle-approve-r1",
  });
  assert.equal(approvedOne.response.status, 201);
  assert.equal(approvedOne.data.data.plan.state, "APPROVED");
  assert.notEqual(approvedOne.data.data.decision.resolution.resolvedBy, "spoofed-body-identity");
  assert.equal(approvedOne.data.data.decision.evidence.planFingerprint, fingerprintOne);
  assert.deepEqual(approvedOne.data.data.decision.evidence.projects, ["lifecycle-app"]);
  assert.equal(approvedOne.data.data.decision.evidence.risk, "LOW");

  const changed = await request("POST", `/api/objectives/${objectiveId}/request-plan-changes`, {
    body: { reason: "Add a second review pass." },
    idempotencyKey: "lifecycle-request-r2",
  });
  assert.equal(changed.response.status, 201);
  assert.equal(changed.data.data.plan.planId, `plan-${objectiveId}-r2`);
  assert.equal(changed.data.data.plan.state, "PENDING_APPROVAL");
  assert.equal(getPlan(runsRoot, planOne.planId).state, "SUPERSEDED");

  const staleApproval = await request("POST", `/api/objectives/${objectiveId}/approve-plan`, {
    body: { planId: planOne.planId },
    idempotencyKey: "lifecycle-stale-approval",
  });
  assert.equal(staleApproval.response.status, 409);
  assert.equal(staleApproval.data.error.details.code, "STALE_PLAN_REVISION");

  const approvedTwo = await request("POST", `/api/objectives/${objectiveId}/approve-plan`, {
    body: { planId: changed.data.data.plan.planId },
    idempotencyKey: "lifecycle-approve-r2",
  });
  assert.equal(approvedTwo.response.status, 201);
  const repeated = await request("POST", `/api/objectives/${objectiveId}/approve-plan`, {
    body: { planId: changed.data.data.plan.planId },
    idempotencyKey: "lifecycle-approve-r2-again",
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.data.data.alreadyApproved, true);
  assert.equal(getDecision(runsRoot, `decision-plan-approval-${changed.data.data.plan.planId}`).revision, 0);

  const clarified = await request("POST", `/api/objectives/${objectiveId}/clarify`, {
    body: { answer: "The second review should remain read-only." },
    idempotencyKey: "lifecycle-clarify-r3",
  });
  assert.equal(clarified.response.status, 201);
  assert.equal(clarified.data.data.plan.planId, `plan-${objectiveId}-r3`);
  assert.equal(clarified.data.data.objective.state, "PLAN_REVIEW");
  assert.equal(getPlan(runsRoot, changed.data.data.plan.planId).state, "SUPERSEDED");

  const expanded = await request("POST", `/api/objectives/${objectiveId}/scope-expansion`, {
    body: { reason: "Human review added an integration verification requirement." },
    idempotencyKey: "lifecycle-scope-r4",
  });
  assert.equal(expanded.response.status, 201);
  assert.equal(expanded.data.data.plan.planId, `plan-${objectiveId}-r4`);
  assert.equal(expanded.data.data.decision.type, "SCOPE_EXPANSION");
  assert.equal(getPlan(runsRoot, clarified.data.data.plan.planId).state, "SUPERSEDED");

  const decisions = await request("GET", `/api/decisions?objectiveId=${objectiveId}`);
  assert.equal(decisions.response.status, 200);
  assert.equal(decisions.data.data.some((decision) => decision.type === "SCOPE_EXPANSION"), true);

  const cancelled = await request("POST", `/api/objectives/${objectiveId}/cancel`, { body: {}, idempotencyKey: "lifecycle-cancel" });
  assert.equal(cancelled.response.status, 201);
  assert.equal(cancelled.data.data.objective.state, "CANCELLED");
  assert.equal(cancelled.data.data.plan.state, "CANCELLED");
  const repeatedCancel = await request("POST", `/api/objectives/${objectiveId}/cancel`, { body: {}, idempotencyKey: "lifecycle-cancel-again" });
  assert.equal(repeatedCancel.response.status, 200);
  assert.equal(repeatedCancel.data.data.alreadyCancelled, true);

  const read = await request("GET", `/api/objectives/${objectiveId}`);
  assert.equal(read.response.status, 200);
  assert.equal(read.data.data.plan.planId, expanded.data.data.plan.planId);
  assert.equal(read.data.data.decisions.length >= 4, true);
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("plan-lifecycle-api.test.mjs: All tests passed!");
