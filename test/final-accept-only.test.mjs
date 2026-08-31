import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { planObjective } from "../src/objective-planning.mjs";

console.log("Running final-accept-only.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "final-accept-only-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "repository");
fs.mkdirSync(path.join(vaultRoot, "02-Projects", "autopilot-app"), { recursive: true });
fs.mkdirSync(repository, { recursive: true });
fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --version" } }));
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| autopilot-app | [[02-Projects/autopilot-app/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));
fs.writeFileSync(path.join(vaultRoot, "02-Projects", "autopilot-app", "project.md"), "---\ntitle: Autopilot App\nverification_defaults:\n  - test\n---\n# Autopilot App\n");

const candidate = (objective) => ({
  schemaVersion: 1,
  planId: `plan-${objective.objectiveId}-r1`,
  objectiveId: objective.objectiveId,
  revision: 1,
  state: "PENDING_APPROVAL",
  summary: "Run the bounded autopilot diagnostic.",
  architectureDecisions: [],
  assumptions: [],
  clarificationNeeded: false,
  clarificationQuestion: null,
  projects: ["autopilot-app"],
  nodes: [{
    nodeId: "N01",
    title: "Inspect autopilot fixture",
    purpose: "Verify the fixture without changing product files.",
    projectId: "autopilot-app",
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
    apiToken: "a".repeat(64),
    env: {
      ORCHESTRATOR_PROFILE: "LOCAL_PILOT",
      ORCHESTRATOR_APPROVAL_MODE: "FINAL_ACCEPT_ONLY",
      ORCHESTRATOR_AUTO_FINALIZE_TASKS: "0",
      ORCHESTRATOR_OBJECTIVES_ENABLED: "1",
      ORCHESTRATOR_OBJECTIVE_SCHEDULER: "1",
      ORCHESTRATOR_PARALLEL_OBJECTIVES: "0",
      ORCHESTRATOR_SAME_PROJECT_PARALLEL: "0",
      ORCHESTRATOR_CROSS_PROJECT: "1",
      ORCHESTRATOR_TELEGRAM_ENABLED: "0",
      ORCHESTRATOR_SKILLS_ENABLED: "0",
      ORCHESTRATOR_SKILL_AUTO_ROUTING: "0",
      ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS: "2",
      ORCHESTRATOR_MAX_PARALLEL_JOBS: "3",
    },
    services: {
      objectivesEnabled: () => true,
      crossProjectEnabled: () => false,
      planObjective: (options) => planObjective({ ...options, decomposer: async ({ objective }) => ({ status: "PLAN_REVIEW", plan: candidate(objective) }) }),
    },
  });
  await service.start();
  const sessionResponse = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
  session = (await sessionResponse.json()).data;

  const created = await request("POST", "/api/objectives", { body: { mode: "EXISTING_PROJECT", projectIds: ["autopilot-app"], request: "Inspect the autopilot fixture." }, idempotencyKey: "autopilot-objective" });
  assert.equal(created.response.status, 201);
  const objectiveId = created.data.data.objective.objectiveId;
  const planned = await request("POST", `/api/objectives/${objectiveId}/generate-plan`, { body: {}, idempotencyKey: "autopilot-plan" });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.data.data.automation.approvalMode, "FINAL_ACCEPT_ONLY");
  assert.equal(planned.data.data.automation.started, true);
  assert.equal(planned.data.data.plan.state, "APPROVED");
  assert.equal(planned.data.data.objective.state, "MATERIALIZING");
  assert.equal(planned.data.data.tasks.length, 1);

  const evidence = await request("GET", `/api/objectives/${objectiveId}/evidence`, { idempotencyKey: "autopilot-evidence" });
  assert.equal(evidence.data.data.automation.finalAcceptOnly, true);
  assert.equal(evidence.data.data.finalAcceptance.canAccept, false);
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("final-accept-only.test.mjs: All tests passed!");
