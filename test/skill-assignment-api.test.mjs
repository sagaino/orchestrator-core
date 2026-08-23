import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createOrchestratorServer } from "../src/server.mjs";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";

console.log("Running skill-assignment-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-assignment-api-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repository = path.join(root, "repository");
const skillRoot = path.join(runsRoot, "runtime", "skills");
const objectiveId = "objective-skill-assignment-api";
const planId = "plan-objective-skill-assignment-api-r1";
const timestamp = "2026-08-23T00:00:00.000Z";
const budget = { maxSubtasks: 1, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: 1000, deadlineAt: null };
const instructionText = "Review the API fixture.\n";
const checksum = createHash("sha256").update(instructionText).digest("hex");

fs.mkdirSync(path.join(vaultRoot, "02-Projects", "skill-api-project"), { recursive: true });
fs.mkdirSync(repository, { recursive: true });
fs.mkdirSync(skillRoot, { recursive: true });
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| skill-api-project | [[02-Projects/skill-api-project/project.md]] | ${repository} | agy | false | ${repository}/graph.json |`,
].join("\n"));
fs.writeFileSync(path.join(vaultRoot, "02-Projects", "skill-api-project", "project.md"), "---\ntitle: Skill API Project\ntype: project\n---\n# Skill API Project\n");
fs.writeFileSync(path.join(skillRoot, "api-review.md"), instructionText);
fs.writeFileSync(path.join(skillRoot, "registry.json"), JSON.stringify({
  schemaVersion: 1,
  kind: "ai-os-skill-registry",
  revision: 1,
  updatedAt: timestamp,
  agentWritable: false,
  skills: [{
    schemaVersion: 1,
    kind: "ai-os-skill",
    skillId: "api-review",
    version: "1.0.0",
    purpose: "Review the API fixture.",
    supportedRoles: ["BACKEND"],
    supportedTaskTypes: ["IMPLEMENTATION"],
    requiredContextTypes: ["PLAN"],
    requiredCapabilities: ["context.read"],
    compatibleProjectSignals: [],
    riskLevel: "LOW",
    instructions: { resourcePath: "api-review.md", sha256: checksum },
    verificationRequirements: ["test"],
    enabled: true,
    provenance: { source: "LOCAL_HUMAN", humanInstaller: "local:api-operator", installedAt: timestamp, sourceRef: "fixture" },
  }],
}, null, 2));

createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "PLAN_REVIEW", request: "Assign API review skill.", requestedBy: "local:api-operator", projectIds: ["skill-api-project"], freshProject: null, activePlanId: planId, activeOrchestrationId: null, budget, createdAt: timestamp, updatedAt: timestamp } });
createPlan({ runsRoot, record: {
  schemaVersion: 1, revision: 1, planId, objectiveId, state: "PENDING_APPROVAL", summary: "API skill assignment fixture.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null, projects: ["skill-api-project"],
  nodes: [{ nodeId: "N01", title: "Implement API", purpose: "Implement the API fixture.", projectId: "skill-api-project", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["API passes."], allowedPaths: ["src/api.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "api", contextFrom: [], skills: [] }],
  integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false }, risk: "LOW", complexity: "LOW", approvedBy: null, approvedAt: null, createdAt: timestamp, updatedAt: timestamp,
}, validationOptions: { knownProjectIds: ["skill-api-project"], budget } });

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
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}${requestPath}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  const data = await response.json();
  const nextNonce = response.headers.get("x-action-nonce");
  if (nextNonce && operatorSession) operatorSession.actionNonce = nextNonce;
  return { response, data };
}

try {
  service = createOrchestratorServer({ vaultRoot, runsRoot, port: 0, host: "127.0.0.1", apiToken: "s".repeat(64) });
  await service.start();
  operatorSession = (await (await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } })).json()).data;

  const catalog = await request("GET", "/api/skills");
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.data.data.skills[0].skillId, "api-review");
  const assigned = await request("POST", `/api/objectives/${objectiveId}/plan/skills`, { body: { assignments: [{ nodeId: "N01", skillId: "api-review", version: "1.0.0" }] }, idempotencyKey: "skill-assignment-api-1" });
  assert.equal(assigned.response.status, 201, JSON.stringify(assigned.data));
  assert.equal(assigned.data.data.plan.revision, 2);
  assert.equal(assigned.data.data.plan.nodes[0].skills[0].checksum, checksum);
  const approved = await request("POST", `/api/objectives/${objectiveId}/approve-plan`, { body: { planFingerprint: assigned.data.data.plan.planFingerprint }, idempotencyKey: "skill-assignment-api-approve" });
  assert.equal(approved.response.status, 201, JSON.stringify(approved.data));
  assert.equal(approved.data.data.plan.state, "APPROVED");
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("skill-assignment-api.test.mjs: All tests passed!");
