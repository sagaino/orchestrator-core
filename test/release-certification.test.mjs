import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGuardedSelfUpdateCertification } from "../src/release-certification.mjs";

console.log("Running release-certification.test.mjs...");

const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p65-certification-runs-"));
try {
  const report = await runGuardedSelfUpdateCertification({ runsRoot, operatorIdentity: "local:p65-certification-test" });
  assert.equal(report.status, "CERTIFIED_HUMAN_GATE_REQUIRED");
  assert.equal(report.humanGate.approved, false);
  assert.equal(report.checks.successfulActivation, true);
  assert.equal(report.checks.forcedRollback, true);
  assert.equal(report.checks.stableRestoredAfterRollback, true);
  assert.equal(report.checks.candidateIntegrity, true);
  assert.equal(report.checks.auditReconstructsBothOutcomes, true);
  assert.equal(report.audit.valid, true);
  assert.equal(fs.existsSync(report.bundlePath), true);
  assert.equal(fs.existsSync(`${report.bundlePath}.sha256`), true);
} finally {
  fs.rmSync(runsRoot, { recursive: true, force: true });
}

console.log("release-certification.test.mjs: All tests passed!");

