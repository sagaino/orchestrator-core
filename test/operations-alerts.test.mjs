import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acknowledgeOperationsAlert,
  listOperationsAlertAcknowledgements,
  listOperationsAlertResolutions,
  operationsReadiness,
  resolveOperationsAlert,
} from "../src/operations-governance.mjs";

console.log("Running operations-alerts.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-alerts-"));
const runsRoot = path.join(root, "runs");
try {
  const first = acknowledgeOperationsAlert({
    runsRoot,
    alertId: "OPS_PROVIDER_FAILURES",
    dedupeKey: "provider-failures:WARN",
    acknowledgedBy: "operator",
    owner: "provider-oncall",
    snoozeMinutes: 30,
    note: "triage started",
    now: new Date("2026-08-22T01:00:00.000Z"),
  });
  assert.equal(first.owner, "provider-oncall");
  assert.equal(first.snoozeUntil, "2026-08-22T01:30:00.000Z");
  assert.equal(first.kind, "ACKNOWLEDGEMENT");

  const duplicate = acknowledgeOperationsAlert({
    runsRoot,
    alertId: "OPS_PROVIDER_FAILURES",
    dedupeKey: "provider-failures:WARN",
    acknowledgedBy: "operator-2",
    now: new Date("2026-08-22T01:20:00.000Z"),
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(listOperationsAlertAcknowledgements({ runsRoot, alertId: "OPS_PROVIDER_FAILURES" }).length, 1);

  assert.throws(() => acknowledgeOperationsAlert({ runsRoot, alertId: "OPS_PROVIDER_FAILURES", acknowledgedBy: "operator", snoozeMinutes: 0 }), /snoozeMinutes/);
  assert.throws(() => resolveOperationsAlert({ runsRoot, alertId: "OPS_PROVIDER_FAILURES", resolvedBy: "operator", evidence: {} }), /evidence/);
  const resolution = resolveOperationsAlert({
    runsRoot,
    alertId: "OPS_PROVIDER_FAILURES",
    resolvedBy: "operator",
    evidence: { runId: "run-provider-recovery", reference: "03-Sources/other/provider-recovery.json", summary: "Provider recovered and retry evidence captured." },
    now: new Date("2026-08-22T02:00:00.000Z"),
  });
  assert.equal(resolution.kind, "RESOLUTION");
  assert.equal(listOperationsAlertResolutions({ runsRoot, alertId: "OPS_PROVIDER_FAILURES" }).length, 1);

  const readiness = operationsReadiness({ runsRoot, now: new Date("2026-08-22T02:10:00.000Z") });
  const backupAlert = readiness.alerts.find((alert) => alert.alertId === "OPS_BACKUP");
  assert.ok(backupAlert);
  assert.equal(backupAlert.ownerRole, "recovery-operator");
  assert.ok(Array.isArray(backupAlert.runbookSteps));
  assert.equal(readiness.admission.allowed, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operations-alerts.test.mjs: All tests passed!");
