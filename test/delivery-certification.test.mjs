import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecision } from "../src/decision-store.mjs";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan, updatePlan } from "../src/plan-store.mjs";
import { createOrchestration } from "../src/orchestration-store.mjs";
import { createVisualEvidence, createAggregatePreviewEvidence, persistVisualEvidence, persistAggregatePreviewEvidence } from "../src/visual-evidence.mjs";
import { createDeliveryCertification, verifyDeliveryCertification, acceptDeliveryCertification } from "../src/delivery-certification.mjs";

console.log("Running delivery-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-certification-"));
const runsRoot = path.join(root, "runs");
const artifactPath = path.join(root, "capture.png");
const timestamp = "2026-08-23T00:00:00.000Z";
const objectiveId = "objective-delivery-fixture";
const planId = "plan-objective-delivery-fixture-r1";
const orchestrationId = "orch-objective-delivery-fixture";
const runId = "run-objective-delivery-fixture";
const planFingerprint = "b".repeat(64);
const budget = { maxSubtasks: 1, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: 1000, deadlineAt: null };
fs.mkdirSync(runsRoot, { recursive: true });
fs.writeFileSync(artifactPath, "delivery visual fixture");
fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
  schemaVersion: 1,
  revision: 0,
  runId,
  state: "DONE",
  createdAt: timestamp,
  updatedAt: timestamp,
  project: { id: "delivery-project", repository: root },
  task: { id: "DELIVERY-001", path: "tasks/delivery.md", allowedPaths: ["src/App.tsx"] },
  completion: { completedAt: timestamp, completedBy: "delivery-reviewer", humanApproved: true },
  knowledge: { approval: { approvedAt: timestamp, approvedBy: "delivery-reviewer", classification: "PROJECT_ONLY", destination: "PROJECT" } },
  execution: {
    scopeAudit: { passed: true, changedPaths: ["src/App.tsx"], allowedPaths: ["src/App.tsx"], outOfScopePaths: [], deniedPaths: [] },
    result: { gitCommit: { committed: true, commitHash: "delivery-commit" } },
    verification: [{ command: "npm test", status: "PASS", exitCode: 0 }],
    workspace: { path: path.join(runsRoot, "workspaces", runId), state: "CLEANED", artifactPath: "workspace-artifacts/delivery" },
  },
  history: [],
}, null, 2));

try {
  createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "DONE", request: "Certify delivery fixture.", requestedBy: "delivery-reviewer", projectIds: ["delivery-project"], freshProject: null, activePlanId: planId, activeOrchestrationId: orchestrationId, budget, createdAt: timestamp, updatedAt: timestamp } });
  createPlan({ runsRoot, record: {
    schemaVersion: 1, revision: 1, planId, objectiveId, state: "APPROVED", summary: "Delivery certification fixture.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null, projects: ["delivery-project"],
    verificationIntent: {
      status: "RESOLVED",
      requested: [{ capability: "UNIT", script: "npm test", source: "PROJECT_DEFAULT" }],
      resolved: [{ capability: "UNIT", script: "npm test", source: "PROJECT_DEFAULT" }],
      missing: [],
    },
    nodes: [{ nodeId: "N01", title: "Deliver fixture", purpose: "Complete delivery fixture.", projectId: "delivery-project", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["Delivery is complete."], allowedPaths: ["src/App.tsx"], verification: ["npm test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [] }],
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: true }, risk: "LOW", complexity: "LOW", approvedBy: "delivery-reviewer", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, planFingerprint,
  }, validationOptions: { knownProjectIds: ["delivery-project"], budget } });
  createOrchestration({ runsRoot, record: { schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId, state: "DONE", planFingerprint, nodes: { N01: { state: "DONE", taskId: "DELIVERY-001", jobId: null, runId, attempt: 1, blockedBy: [], lastError: null } }, integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null }, usage: { totalTokens: 10, agentInvocations: 1, retries: 0 }, createdAt: timestamp, updatedAt: timestamp, materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: [] } }, validationOptions: { plan: { nodes: [{ nodeId: "N01" }] } } });
  createDecision({ runsRoot, record: { schemaVersion: 1, revision: 0, decisionId: "decision-delivery-acceptance", objectiveId, nodeId: null, runId: null, type: "OBJECTIVE_ACCEPTANCE", state: "RESOLVED", evidence: {}, requestedAction: "Accept delivery fixture.", allowedChoices: ["ACCEPT", "CANCEL"], creator: "SYSTEM", createdAt: timestamp, resolution: { action: "ACCEPT", resolvedBy: "delivery-reviewer", resolvedAt: timestamp } } });
  persistVisualEvidence({ runsRoot, evidence: createVisualEvidence({ evidenceId: "delivery-visual-1", runId, route: "/dashboard", viewport: { name: "desktop", width: 1440, height: 900 }, actual: { status: "CAPTURED", path: artifactPath }, comparison: { status: "PASS", method: "fixture" }, accessibility: { status: "PASS", findings: [] }, artifactPath }) });
  persistAggregatePreviewEvidence({ runsRoot, evidence: createAggregatePreviewEvidence({ objectiveId, preview: { sessionId: "delivery-preview-1", status: "READY", host: "127.0.0.1", previews: [{ projectId: "delivery-project", runId, url: "http://127.0.0.1:5310", host: "127.0.0.1", port: 5310, status: "STOPPED", startedAt: timestamp }], unavailable: [], cleanup: { status: "CLEANED", stoppedAt: timestamp, stoppedRunIds: [runId], errors: [] }, expiresAt: timestamp } }) });

  const certificate = createDeliveryCertification({ runsRoot, objectiveId, now: new Date(timestamp) });
  assert.equal(certificate.status, "HUMAN_GATE_REQUIRED", JSON.stringify(certificate, null, 2));
  assert.equal(certificate.checks.every((check) => check.status === "PASS"), true);
  assert.equal(verifyDeliveryCertification({ bundlePath: certificate.bundlePath }).valid, true);
  const accepted = acceptDeliveryCertification({ bundlePath: certificate.bundlePath, approvedBy: "delivery-gate", now: new Date("2026-08-23T01:00:00.000Z") });
  assert.equal(accepted.status, "CERTIFIED");
  assert.equal(accepted.humanGate.confirmed, true);
  assert.equal(verifyDeliveryCertification({ bundlePath: certificate.bundlePath }).valid, true);
  fs.appendFileSync(certificate.bundlePath, "tamper\n");
  assert.equal(verifyDeliveryCertification({ bundlePath: certificate.bundlePath }).valid, false);

  // Backend-only implementation nodes use automated/API evidence and must
  // not be blocked merely because they have no screenshot capture.
  fs.rmSync(path.join(runsRoot, "runtime", "visual-evidence"), { recursive: true, force: true });
  const backendNoVisualCertificate = createDeliveryCertification({ runsRoot, objectiveId, now: new Date("2026-08-23T01:30:00.000Z") });
  assert.equal(backendNoVisualCertificate.blockers.includes("VISUAL_E2E_EVIDENCE_COMPLETE"), false, JSON.stringify(backendNoVisualCertificate, null, 2));
  assert.equal(backendNoVisualCertificate.checks.find((check) => check.id === "VISUAL_E2E_EVIDENCE_COMPLETE").evidence.required, false);

  // A read-only/API diagnostic plan may explicitly opt out of aggregate
  // preview and visual capture. Certification must not block that plan.
  updatePlan({
    runsRoot,
    id: planId,
    expectedRevision: 1,
    update: (current) => ({ ...current, integration: { ...current.integration, previewRequired: false } }),
    validationOptions: { knownProjectIds: ["delivery-project"], budget },
  });
  fs.rmSync(path.join(runsRoot, "runtime", "visual-evidence"), { recursive: true, force: true });
  const noPreviewCertificate = createDeliveryCertification({ runsRoot, objectiveId, now: new Date("2026-08-23T02:00:00.000Z") });
  assert.equal(noPreviewCertificate.status, "HUMAN_GATE_REQUIRED", JSON.stringify(noPreviewCertificate, null, 2));
  assert.deepEqual(noPreviewCertificate.blockers, []);
  assert.equal(noPreviewCertificate.checks.find((check) => check.id === "PREVIEW_COMPLETE").evidence.required, false);
  assert.equal(noPreviewCertificate.checks.find((check) => check.id === "VISUAL_E2E_EVIDENCE_COMPLETE").evidence.required, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("delivery-certification.test.mjs: All tests passed!");
