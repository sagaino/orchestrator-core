import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { diagnoseCrossProject } from "../src/cross-project-diagnostics.mjs";
import { createCrossProjectIncidentCertification, verifyCrossProjectIncidentCertification } from "../src/cross-project-incident-certification.mjs";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan } from "../src/plan-store.mjs";
import { createDecision } from "../src/decision-store.mjs";
import { createOrchestration } from "../src/orchestration-store.mjs";
import { planFingerprint } from "../src/plan-lifecycle.mjs";

console.log("Running cross-project-incident-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-project-incident-certification-"));
const timestamp = "2026-08-23T00:00:00.000Z";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepository(repository, projectId, baselineFile, changedFile) {
  fs.mkdirSync(repository, { recursive: true });
  execFileSync("git", ["-C", repository, "init", "-q"]);
  execFileSync("git", ["-C", repository, "config", "user.email", `${projectId}@example.invalid`]);
  execFileSync("git", ["-C", repository, "config", "user.name", "V2-065 Pilot"]);
  fs.mkdirSync(path.dirname(path.join(repository, baselineFile)), { recursive: true });
  fs.writeFileSync(path.join(repository, baselineFile), "baseline\n");
  execFileSync("git", ["-C", repository, "add", baselineFile]);
  execFileSync("git", ["-C", repository, "commit", "-qm", `${projectId} baseline`]);
  fs.writeFileSync(path.join(repository, changedFile), "contract fix\n");
  execFileSync("git", ["-C", repository, "add", changedFile]);
  execFileSync("git", ["-C", repository, "commit", "-qm", `${projectId} contract incident fix`]);
}

const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repositories = {
  frontend: path.join(root, "frontend"),
  backend: path.join(root, "backend"),
};
createRepository(repositories.frontend, "frontend", "src/client.js", "src/client-contract.js");
createRepository(repositories.backend, "backend", "src/server.js", "src/server-contract.js");
for (const projectId of Object.keys(repositories)) {
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", projectId), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "02-Projects", projectId, "project.md"), `---\ntype: project\n---\n# ${projectId}\n`);
}
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| frontend | [[02-Projects/frontend/project.md]] | ${repositories.frontend} | agy | false | ${repositories.frontend}/graph.json |`,
  `| backend | [[02-Projects/backend/project.md]] | ${repositories.backend} | agy | false | ${repositories.backend}/graph.json |`,
].join("\n"));

const objectiveId = "obj-v2065-real-linked-bug";
const planId = `plan-${objectiveId}-r1`;
const orchestrationId = `orch-${objectiveId}`;
const objective = {
  schemaVersion: 1,
  revision: 0,
  objectiveId,
  mode: "CROSS_PROJECT_INCIDENT",
  state: "RESULT_REVIEW",
  request: "Users receive a 400 response when the frontend submits a valid order to the backend.",
  requestedBy: "human:v2065-pilot",
  projectIds: ["frontend", "backend"],
  freshProject: null,
  activePlanId: planId,
  activeOrchestrationId: orchestrationId,
  budget: { maxSubtasks: 4, maxParallelAgents: 2, maxRetriesPerNode: 1, maxRepairCycles: 1, maxTotalTokens: 2_000, deadlineAt: null },
  createdAt: timestamp,
  updatedAt: timestamp,
};
createObjective({ runsRoot, record: objective });

const diagnosis = {
  schemaVersion: 1,
  diagnosticId: `diagnostic-${objectiveId}-r1`,
  objectiveId,
  outcome: "BOTH",
  summary: "Frontend sends orderAmount while the backend contract requires amount; both repositories must be updated together.",
  evidence: [
    { evidenceId: "ev-frontend-request", projectId: "frontend", source: "browser network trace", reproduction: "Submit a valid order from the checkout screen.", observation: "The request body contains orderAmount.", expected: "The request body contains amount.", actual: "Backend returns 400 because amount is missing." },
    { evidenceId: "ev-backend-contract", projectId: "backend", source: "contract test", reproduction: "Run npm run test:contract with the captured request.", observation: "The schema rejects orderAmount.", expected: "The schema accepts amount.", actual: "Contract validation fails before order creation." },
  ],
  implicatedProjects: ["frontend", "backend"],
  confidence: "HIGH",
  clarificationNeeded: false,
  clarificationQuestion: null,
  readOnly: true,
};

const diagnosticRun = await diagnoseCrossProject({
  objective,
  projectContexts: [
    { projectId: "frontend", role: "frontend", repository: repositories.frontend, summary: "Checkout client sends order payload.", verification: ["test:e2e"] },
    { projectId: "backend", role: "backend", repository: repositories.backend, summary: "Order API validates request contract.", verification: ["test:contract"] },
  ],
  relationshipContext: "frontend CONSUMES_API backend via order contract",
  processRunner: async (input) => {
    assert.equal(input.stage, "cross-project-diagnostic");
    assert.match(input.args.join(" "), /Users receive a 400 response/);
    return { exitCode: 0, stdoutTail: JSON.stringify(diagnosis) };
  },
  now: new Date(timestamp),
});
assert.equal(diagnosticRun.status, "DIAGNOSIS_READY");
assert.equal(diagnosticRun.diagnosis.readOnly, true);

const nodes = [
  { nodeId: "N01", title: "Diagnose order contract", purpose: "Reproduce and classify the linked frontend/backend incident.", projectId: "frontend", role: "DIAGNOSTIC", type: "DIAGNOSTIC", dependsOn: [], acceptanceCriteria: ["Root cause is evidenced."], allowedPaths: [], verification: ["test"], risk: "MEDIUM", complexity: "HIGH", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [] },
  { nodeId: "N02", title: "Update frontend payload", purpose: "Send the contract field expected by the backend.", projectId: "frontend", role: "FRONTEND", type: "IMPLEMENTATION", dependsOn: ["N01"], acceptanceCriteria: ["Frontend contract usage is fixed."], allowedPaths: ["src/client-contract.js"], verification: ["test"], risk: "MEDIUM", complexity: "MEDIUM", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "frontend", contextFrom: ["N01"], skills: [] },
  { nodeId: "N03", title: "Update backend contract", purpose: "Accept the corrected order payload contract.", projectId: "backend", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: ["N01"], acceptanceCriteria: ["Backend contract is compatible."], allowedPaths: ["src/server-contract.js"], verification: ["test"], risk: "MEDIUM", complexity: "MEDIUM", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "backend", contextFrom: ["N01"], skills: [] },
  { nodeId: "N04", title: "Run cross-project E2E", purpose: "Verify the corrected order flow across both repositories.", projectId: "backend", role: "INTEGRATION", type: "INTEGRATION", dependsOn: ["N02", "N03"], acceptanceCriteria: ["Contract and E2E checks pass."], allowedPaths: [], verification: ["test:contract"], risk: "MEDIUM", complexity: "HIGH", requiresChanges: false, canRunInParallel: false, writeConflictGroup: null, contextFrom: ["N02", "N03"], skills: [] },
];
const plan = { schemaVersion: 1, revision: 1, planId, objectiveId, state: "APPROVED", summary: "Certify the linked order contract incident fix.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null, projects: ["frontend", "backend"], nodes, integration: { required: true, projectVerification: ["test"], crossProjectVerification: ["frontend:test:e2e", "backend:test:contract"], previewRequired: false }, risk: "MEDIUM", complexity: "HIGH", approvedBy: "human:v2065-pilot", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
plan.planFingerprint = planFingerprint(plan);
createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: objective.projectIds, budget: objective.budget } });
createDecision({ runsRoot, record: { schemaVersion: 1, revision: 0, decisionId: `decision-plan-approval-${planId}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED", evidence: { planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve V2-065 pilot plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp, resolution: { action: "APPROVE", resolvedBy: "human:v2065-pilot", resolvedAt: timestamp } } });

createOrchestration({
  runsRoot,
  record: {
    schemaVersion: 1,
    revision: 0,
    orchestrationId,
    objectiveId,
    planId,
    state: "DONE",
    planFingerprint: plan.planFingerprint,
    nodes: Object.fromEntries(nodes.map((node, index) => [node.nodeId, { state: "DONE", taskId: `TASK-${index + 1}`, jobId: `job-${node.nodeId}`, runId: node.type === "INTEGRATION" ? null : `run-${node.nodeId}`, attempt: 1, blockedBy: [], lastError: null }])),
    integration: { state: "PASSED", projectBaselines: { frontend: "frontend-base", backend: "backend-base" }, artifacts: [], verification: [], rollback: null },
    usage: { totalTokens: 620, agentInvocations: 3, retries: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
    materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: [] },
  },
  validationOptions: { plan },
});

const integrationEvidence = {
  schemaVersion: 1,
  mode: "integration-evidence",
  status: "PASSED",
  objectiveId,
  planId,
  orchestrationId,
  sourceRuns: [
    { nodeId: "N02", runId: "run-N02", projectId: "frontend", commitHash: "frontend-fix", changedPaths: ["src/client-contract.js"], allowedPaths: ["src/client-contract.js"] },
    { nodeId: "N03", runId: "run-N03", projectId: "backend", commitHash: "backend-fix", changedPaths: ["src/server-contract.js"], allowedPaths: ["src/server-contract.js"] },
  ],
  projectBaselines: { frontend: "frontend-base", backend: "backend-base" },
  services: [{ projectId: "frontend", status: "PASS", host: "127.0.0.1", port: 5311, url: "http://127.0.0.1:5311" }, { projectId: "backend", status: "PASS", host: "127.0.0.1", port: 5312, url: "http://127.0.0.1:5312" }],
  repositoryAcceptance: [
    { projectId: "frontend", baseline: "frontend-base", runIds: ["run-N02"], diffs: [{ runId: "run-N02", changedPaths: ["src/client-contract.js"], allowedPaths: ["src/client-contract.js"] }], checks: [{ projectId: "frontend", script: "test", command: "npm run test", scope: "PROJECT", status: "PASS" }], acceptance: { gate: "PER_REPOSITORY", status: "PASS" } },
    { projectId: "backend", baseline: "backend-base", runIds: ["run-N03"], diffs: [{ runId: "run-N03", changedPaths: ["src/server-contract.js"], allowedPaths: ["src/server-contract.js"] }], checks: [{ projectId: "backend", script: "test", command: "npm run test", scope: "PROJECT", status: "PASS" }], acceptance: { gate: "PER_REPOSITORY", status: "PASS" } },
  ],
  verification: { status: "PASS", results: [{ projectId: "frontend", script: "test", command: "npm run test", scope: "PROJECT", status: "PASS" }, { projectId: "backend", script: "test", command: "npm run test", scope: "PROJECT", status: "PASS" }, { projectId: "frontend", script: "test:e2e", command: "npm run test:e2e", scope: "CROSS_PROJECT", status: "PASS", serviceUrls: { frontend: "http://127.0.0.1:5311", backend: "http://127.0.0.1:5312" } }, { projectId: "backend", script: "test:contract", command: "npm run test:contract", scope: "CROSS_PROJECT", status: "PASS", serviceUrls: { frontend: "http://127.0.0.1:5311", backend: "http://127.0.0.1:5312" } }] },
  crossProjectVerification: { required: true, status: "PASS", results: [{ projectId: "frontend", script: "test:e2e", command: "npm run test:e2e", scope: "CROSS_PROJECT", status: "PASS", serviceUrls: { frontend: "http://127.0.0.1:5311", backend: "http://127.0.0.1:5312" } }, { projectId: "backend", script: "test:contract", command: "npm run test:contract", scope: "CROSS_PROJECT", status: "PASS", serviceUrls: { frontend: "http://127.0.0.1:5311", backend: "http://127.0.0.1:5312" } }] },
};
writeJson(path.join(runsRoot, "integration", orchestrationId, "aggregate-evidence.json"), integrationEvidence);

try {
  const certification = createCrossProjectIncidentCertification({ runsRoot, vaultRoot, objectiveId, diagnosis: diagnosticRun.diagnosis, now: new Date(timestamp) });
  assert.equal(certification.status, "HUMAN_GATE_REQUIRED");
  assert.deepEqual(certification.blockers, []);
  assert.equal(certification.humanGate.required, true);
  assert.equal(certification.humanGate.confirmed, false);
  assert.deepEqual(certification.scope.requiredProjectIds, ["frontend", "backend"]);
  assert.equal(verifyCrossProjectIncidentCertification({ bundleFilePath: certification.bundlePath }).valid, true);

  const outOfScopeEvidence = { ...integrationEvidence, sourceRuns: [...integrationEvidence.sourceRuns, { nodeId: "N99", runId: "run-unrelated", projectId: "unrelated", commitHash: "unrelated-fix", changedPaths: ["src/unrelated.js"], allowedPaths: ["src/unrelated.js"] }] };
  writeJson(path.join(runsRoot, "integration", orchestrationId, "aggregate-evidence.json"), outOfScopeEvidence);
  const blocked = createCrossProjectIncidentCertification({ runsRoot, vaultRoot, objectiveId, diagnosis: diagnosticRun.diagnosis, now: new Date(timestamp) });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.includes("IMPLEMENTATION_BOUNDARY"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("cross-project-incident-certification.test.mjs: All tests passed!");
