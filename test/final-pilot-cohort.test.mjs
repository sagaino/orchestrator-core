import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFinalPilotCohort, verifyFinalPilotCohortReport } from "../src/final-pilot-cohort.mjs";

console.log("Running final-pilot-cohort.test.mjs...");

const report = runFinalPilotCohort({ now: new Date("2026-08-22T00:00:00.000Z") });
assert.equal(report.status, "PASS");
assert.equal(report.humanGate.required, true);
assert.equal(report.humanGate.confirmed, false);
assert.equal(report.scope.taskCount, 10);
assert.equal(report.scope.projectCount, 3);
assert.equal(report.checks.acceptedPathsAuthorized, true);
assert.equal(report.checks.noDuplicateInvocation, true);
assert.equal(report.checks.noSecretExposure, true);
assert.equal(report.checks.rejectedFailedMutationsSafe, true);
assert.equal(report.checks.completeEvidence, true);
assert.ok(report.tasks.some((task) => task.category === "request-changes"));
assert.ok(report.tasks.some((task) => task.category === "knowledge-create"));
assert.ok(report.tasks.some((task) => task.category === "knowledge-update"));
assert.ok(report.tasks.some((task) => task.category === "rejection"));
assert.ok(report.tasks.some((task) => task.category === "failure-recovery"));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-pilot-report-"));
try {
  const persisted = runFinalPilotCohort({ reportRoot: root, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(verifyFinalPilotCohortReport({ reportPath: persisted.reportPath }).valid, true);
  fs.appendFileSync(persisted.reportPath, "tamper");
  assert.equal(verifyFinalPilotCohortReport({ reportPath: persisted.reportPath }).valid, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("final-pilot-cohort.test.mjs passed");
