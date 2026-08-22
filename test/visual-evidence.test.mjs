import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVisualEvidence, getVisualEvidence, listVisualEvidence, persistVisualEvidence, validateVisualEvidence } from "../src/visual-evidence.mjs";

console.log("Running visual-evidence.test.mjs...");

const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visual-evidence-runs-"));
const artifactPath = path.join(runsRoot, "runtime", "captures", "desktop.png");
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, "deterministic-png-fixture");

try {
  const evidence = createVisualEvidence({
    evidenceId: "visual-fixture-1",
    runId: "run-visual-1",
    route: "/dashboard",
    viewport: { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
    reference: { kind: "path", path: "references/dashboard.png", checksum: "reference-fixture" },
    actual: { status: "CAPTURED", capturedAt: "2026-08-22T00:00:00.000Z" },
    comparison: { status: "PASS", method: "pixel-diff", score: 0.99, mismatchPixels: 2, notes: [] },
    accessibility: { status: "PASS", findings: [] },
    revision: { number: 2, requestedBy: "reviewer", reason: "Spacing revision" },
    artifactPath,
    createdAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.mode, "visual-evidence");
  assert.equal(evidence.artifact.exists, true);
  assert.equal(evidence.artifact.bytes, fs.statSync(artifactPath).size);
  assert.match(evidence.artifact.sha256, /^[a-f0-9]{64}$/);

  const persisted = persistVisualEvidence({ runsRoot, evidence });
  assert.equal(fs.existsSync(persisted.persistence.path), true);
  assert.equal(fs.existsSync(persisted.persistence.checksumPath), true);
  assert.equal(listVisualEvidence({ runsRoot, runId: "run-visual-1" }).length, 1);
  assert.equal(getVisualEvidence({ runsRoot, runId: "run-visual-1", evidenceId: "visual-fixture-1" }).route, "/dashboard");

  const unavailable = createVisualEvidence({ runId: "run-visual-2", route: "/missing", viewport: { name: "mobile", width: 390, height: 844 }, actual: { status: "UNAVAILABLE" } });
  assert.equal(unavailable.actual.status, "UNAVAILABLE");
  assert.equal(unavailable.comparison.status, "UNKNOWN");
  assert.equal(validateVisualEvidence({ ...evidence, artifact: { ...evidence.artifact, sha256: "bad" } }).valid, false);
  assert.throws(() => createVisualEvidence({ runId: "bad/run", route: "/x", viewport: { name: "x", width: 1, height: 1 } }), /VISUAL_EVIDENCE_INVALID|tidak valid/);
} finally {
  fs.rmSync(runsRoot, { recursive: true, force: true });
}

console.log("visual-evidence.test.mjs: All tests passed!");

