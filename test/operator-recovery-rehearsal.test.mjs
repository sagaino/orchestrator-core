import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOperatorRecoveryRehearsal, verifyRecoveryRehearsalReport } from "../src/operator-recovery-rehearsal.mjs";

console.log("Running operator-recovery-rehearsal.test.mjs...");

const report = runOperatorRecoveryRehearsal({ now: new Date("2026-08-22T00:00:00.000Z") });
assert.equal(report.status, "PASS");
assert.equal(report.humanGate.required, true);
assert.equal(report.humanGate.confirmed, false);
assert.equal(report.promotion.performed, false);
assert.equal(report.restore.executionBlocked, true);
assert.equal(report.restore.reconstruction.registryRestored, true);
assert.equal(report.restore.reconstruction.taskRestored, true);
assert.equal(report.restore.reconstruction.auditRestored, true);
assert.equal(report.restore.reconstruction.executionBlocked, true);
assert.equal(report.checks.documentationComplete, true);
assert.equal(report.checks.backupVerified, true);
assert.equal(report.checks.quarantinePreserved, true);
assert.equal(report.checks.mutationBlocked, true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-rehearsal-report-"));
try {
  const persisted = runOperatorRecoveryRehearsal({ reportRoot: root, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(verifyRecoveryRehearsalReport({ reportPath: persisted.reportPath }).valid, true);
  fs.appendFileSync(persisted.reportPath, "tamper");
  assert.equal(verifyRecoveryRehearsalReport({ reportPath: persisted.reportPath }).valid, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operator-recovery-rehearsal.test.mjs passed");
