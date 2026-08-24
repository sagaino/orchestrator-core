import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildObjectiveVisualEvidence, nodeRequiresVisualEvidence } from "../src/objective-visual-evidence.mjs";
import { createVisualEvidence, persistVisualEvidence } from "../src/visual-evidence.mjs";
import { createVisualRevisionRecord } from "../src/visual-revision.mjs";

console.log("Running objective-visual-evidence.test.mjs...");

assert.equal(nodeRequiresVisualEvidence({ type: "IMPLEMENTATION", role: "FRONTEND" }), true);
assert.equal(nodeRequiresVisualEvidence({ type: "IMPLEMENTATION", role: "BACKEND" }), false);
assert.equal(nodeRequiresVisualEvidence({ type: "VERIFICATION", role: "TESTING" }), false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "objective-visual-evidence-"));
const runsRoot = path.join(root, "runs");
const artifactPath = path.join(root, "capture.png");
const runId = "visual-objective-run";
const objectiveId = "objective-visual-fixture";
fs.mkdirSync(runsRoot, { recursive: true });
fs.writeFileSync(artifactPath, "visual fixture");
fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
  schemaVersion: 1,
  runId,
  state: "RETROSPECTIVE",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  project: { id: "visual-project", repository: root },
  task: { id: "VISUAL-001", path: "tasks/visual.md", allowedPaths: ["src/App.tsx"] },
  execution: { reviewChanges: [{ iteration: 1 }], workspace: { state: "ACTIVE" } },
  history: [],
}, null, 2));

try {
  const evidence = persistVisualEvidence({
    runsRoot,
    evidence: createVisualEvidence({
      evidenceId: "visual-ref-1",
      runId,
      route: "/dashboard",
      viewport: { name: "desktop", width: 1440, height: 900 },
      actual: { status: "CAPTURED", path: artifactPath },
      comparison: { status: "FAIL", method: "fixture" },
      accessibility: { status: "PASS", findings: [] },
      artifactPath,
    }),
  });
  createVisualRevisionRecord({ runsRoot, runId, iteration: 1, requestedBy: "reviewer", reason: "Fix dashboard spacing", beforeEvidenceIds: [evidence.evidenceId] });

  const report = buildObjectiveVisualEvidence({
    runsRoot,
    objective: { objectiveId },
    nodes: [{ nodeId: "N01", projectId: "visual-project", runId, state: "DONE" }],
  });
  assert.equal(report.mode, "objective-visual-evidence");
  assert.equal(report.summary.evidenceCount, 1);
  assert.deepEqual(report.summary.routes, ["/dashboard"]);
  assert.deepEqual(report.summary.viewports, ["desktop"]);
  assert.equal(report.nodes[0].evidenceRefs[0].nodeId, "N01");
  assert.equal(report.nodes[0].evidenceRefs[0].projectId, "visual-project");
  assert.equal(report.nodes[0].evidenceRefs[0].checks.comparisonStatus, "FAIL");
  assert.equal("path" in report.nodes[0].evidenceRefs[0], false, "aggregate report must not duplicate artifact paths");
  assert.equal(report.nodes[0].requestChanges.available, true);
  assert.equal(report.nodes[0].revisions[0].status, "AWAITING_AFTER_EVIDENCE");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("objective-visual-evidence.test.mjs: All tests passed!");
