import assert from "node:assert/strict";
import { runSoakCapacityHarness } from "../src/soak-capacity-harness.mjs";

console.log("Running soak-capacity-harness.test.mjs...");

const report = await runSoakCapacityHarness({
  durationHours: 1,
  stepMinutes: 15,
  workers: 2,
  apiRequestsPerStep: 4,
  sseClients: 2,
  restartEverySteps: 2,
  artifactBytesPerStep: 64,
  maxArtifactBytes: 10_000,
  persistReport: false,
  cleanupOwnedWorkspace: true,
});

assert.equal(report.status, "PASS", JSON.stringify(report, null, 2));
assert.equal(report.guardrails.syntheticJobsExecuted, false);
assert.equal(report.guardrails.automaticApproval, false);
assert.equal(report.workload.duplicateAdmissions, 0);
assert.equal(report.workload.apiFailures, 0);
assert.ok(report.workload.restarts >= 1);
assert.ok(report.invariants.every((item) => item.passed));

console.log("soak-capacity-harness.test.mjs passed");
