import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVisualEvidence, listVisualEvidence, persistVisualEvidence } from "../src/visual-evidence.mjs";
import { captureVisualEvidence } from "../src/visual-qa.mjs";
import { completeVisualRevision, createVisualRevisionRecord, getVisualRevision, listVisualRevisions } from "../src/visual-revision.mjs";

console.log("Running visual-revision.test.mjs...");

const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visual-revision-runs-"));
const artifactPath = path.join(runsRoot, "fixture.png");
fs.writeFileSync(artifactPath, "fixture");

function persistEvidence(evidenceId, runId = "revision-run") {
  return persistVisualEvidence({ runsRoot, evidence: createVisualEvidence({ evidenceId, runId, route: "/operations", viewport: { name: "desktop", width: 1440, height: 900 }, actual: { status: "CAPTURED", path: artifactPath }, comparison: { status: "PASS", method: "fixture" }, accessibility: { status: "PASS", findings: [] }, revision: { number: 1 }, artifactPath }) });
}

try {
  const before = persistEvidence("before-1");
  const record = createVisualRevisionRecord({ runsRoot, runId: "revision-run", iteration: 1, requestedBy: "reviewer", reason: "Fix spacing", visualAnnotations: [{ id: "pin-1", x: 12, y: 30, comment: "Align card" }], inlineComments: [{ file: "src/App.tsx", line: 10, comment: "Use shared spacing token." }], beforeEvidenceIds: [before.evidenceId, "missing-id"] });
  assert.equal(record.status, "AWAITING_AFTER_EVIDENCE");
  assert.deepEqual(record.beforeEvidenceIds, ["before-1"]);
  assert.equal(record.visualAnnotations.length, 1);
  assert.equal(listVisualRevisions({ runsRoot, runId: "revision-run" }).length, 1);
  assert.equal(getVisualRevision({ runsRoot, runId: "revision-run", iteration: 1 }).reason, "Fix spacing");

  const after = persistEvidence("after-1");
  const completed = completeVisualRevision({ runsRoot, runId: "revision-run", iteration: 1, afterEvidenceIds: [after.evidenceId, "missing-id"] });
  assert.equal(completed.status, "COMPLETED");
  assert.deepEqual(completed.afterEvidenceIds, ["after-1"]);

  const tampered = createVisualRevisionRecord({ runsRoot, runId: "revision-run", iteration: 99, requestedBy: "reviewer", reason: "Integrity check" });
  fs.appendFileSync(tampered.persistence.path, "tampered\n");
  assert.throws(() => getVisualRevision({ runsRoot, runId: "revision-run", iteration: 99 }), /tidak ditemukan/);
  assert.equal(listVisualRevisions({ runsRoot, runId: "revision-run" }).some((item) => item.iteration === 99), false);

  const capture = await captureVisualEvidence({
    runsRoot,
    runId: "capture-revision-run",
    baseUrl: "http://127.0.0.1:4173",
    route: "/operations",
    revision: { number: 2, iteration: 2, requestedBy: "reviewer", reason: "Fix spacing" },
    viewportNames: ["desktop"],
    timeoutMs: 500,
    captureViewport: async ({ outputPath }) => {
      fs.writeFileSync(outputPath, "capture-after-fixture");
      return { status: "CAPTURED", processTree: { strategy: "fixture", bounded: true } };
    },
  });
  assert.equal(capture.revisionLink.status, "LINK_FAILED");

  createVisualRevisionRecord({ runsRoot, runId: "capture-revision-run", iteration: 2, requestedBy: "reviewer", reason: "Fix spacing", beforeEvidenceIds: [] });
  const secondCapture = await captureVisualEvidence({
    runsRoot,
    runId: "capture-revision-run",
    baseUrl: "http://127.0.0.1:4173",
    route: "/operations",
    revision: { number: 2, iteration: 2 },
    viewportNames: ["desktop"],
    timeoutMs: 500,
    captureViewport: async ({ outputPath }) => {
      fs.writeFileSync(outputPath, "capture-after-fixture-2");
      return { status: "CAPTURED", processTree: { strategy: "fixture", bounded: true } };
    },
  });
  assert.equal(secondCapture.revisionLink.status, "COMPLETED");
  assert.equal(secondCapture.revisionLink.afterEvidenceIds.length, 1);
  assert.equal(listVisualEvidence({ runsRoot, runId: "capture-revision-run" }).length, 2);
} finally {
  fs.rmSync(runsRoot, { recursive: true, force: true });
}

console.log("visual-revision.test.mjs: All tests passed!");
