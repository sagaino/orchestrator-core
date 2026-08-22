import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessMigrationCompatibility,
  executeVersionedMigration,
  runMigrationMatrixCertification,
  verifyMigrationMatrixReport,
} from "../src/migration-upgrade.mjs";

console.log("Running migration-upgrade.test.mjs...");

const report = runMigrationMatrixCertification({ now: new Date("2026-08-22T00:00:00.000Z") });
assert.equal(report.status, "PASS");
assert.equal(report.humanGate.required, true);
assert.ok(report.results.every((item) => item.status === "PASS"));

const compatibility = assessMigrationCompatibility({ matrixId: "future-schema", sourceRuntime: "future", sourceSchemaVersion: 99 });
assert.equal(compatibility.compatible, false);
assert.equal(compatibility.failClosed, true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-migration-test-"));
try {
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  const rejected = executeVersionedMigration({ runsRoot, migrationId: "missing-backup", matrixId: "phase4-to-v1", sourceRuntime: "phase4", sourceSchemaVersion: 1, steps: ["must-not-run"] });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.failClosed, true);
  const reportRoot = path.join(root, "report");
  fs.mkdirSync(reportRoot, { recursive: true });
  const persisted = runMigrationMatrixCertification({ reportRoot, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(verifyMigrationMatrixReport({ reportPath: persisted.reportPath }).valid, true);
  fs.appendFileSync(persisted.reportPath, "tamper");
  assert.equal(verifyMigrationMatrixReport({ reportPath: persisted.reportPath }).valid, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("migration-upgrade.test.mjs passed");
