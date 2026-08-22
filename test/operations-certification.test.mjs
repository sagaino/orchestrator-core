import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOperationsCertification, verifyOperationsCertification } from "../src/operations-certification.mjs";
import { recordRecoveryDrill, recordVerifiedBackup } from "../src/operations-governance.mjs";

console.log("Running operations-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-p85-certification-"));
const runsRoot = path.join(root, "runs");
const vaultRoot = path.join(root, "vault");
const backupPath = path.join(root, "external-backup");
const now = new Date("2026-08-22T00:00:00.000Z");
const soakReport = {
  status: "PASS",
  virtualWindow: { durationHours: 72, steps: 288 },
  invariants: [{ id: "NO_DUPLICATE_INVOCATION", passed: true }, { id: "NO_LOST_UPDATE", passed: true }],
  workload: { apiFailures: 0, sseRejected: 0, artifacts: { bytes: 100 } },
  capacity: { maxArtifactBytes: 1000 },
};
const readinessFn = () => ({
  status: "READY",
  admission: { allowed: true, blockers: [] },
  alerts: [],
  checks: [
    { id: "runtime-storage", status: "PASS" },
    { id: "queue-age", status: "PASS" },
  ],
  signals: {},
});
const knowledgeHealthFn = () => ({ verdict: "PASS", summary: { errors: 0, warnings: 0 } });
const auditFn = () => ({ valid: true, errors: [] });
const backupVerifierFn = () => ({ status: "VERIFIED", fileCount: 1, totalBytes: 10 });

try {
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(backupPath, { recursive: true });
  recordVerifiedBackup({ runsRoot, backupPath, verification: { verifiedAt: now.toISOString(), fileCount: 1, totalBytes: 10 }, manifest: { backupId: "p85-backup", createdAt: now.toISOString(), completedAt: now.toISOString() }, independentTarget: true });
  recordRecoveryDrill({ runsRoot, performedBy: "p85-operator", evidence: "quarantine restore verified", result: "PASS", rtoMinutes: 10, now });

  const certified = createOperationsCertification({ runsRoot, vaultRoot, soakReport, now, readinessFn, knowledgeHealthFn, auditFn, backupVerifierFn, capacity: { maxArtifactBytes: 1000 } });
  assert.equal(certified.status, "CERTIFICATION_READY");
  assert.deepEqual(certified.blockers, []);
  assert.equal(certified.humanGate.confirmed, false);
  assert.equal(verifyOperationsCertification({ bundleFilePath: certified.bundlePath }).valid, true);

  const blocked = createOperationsCertification({
    runsRoot,
    vaultRoot,
    soakReport,
    now,
    readinessFn: () => ({ ...readinessFn(), alerts: [{ alertId: "OPS_TEST", owner: null, runbookSteps: [] }] }),
    knowledgeHealthFn,
    auditFn,
    backupVerifierFn,
    capacity: { maxArtifactBytes: 1000 },
  });
  assert.equal(blocked.status, "CONDITIONAL");
  assert.ok(blocked.blockers.includes("ALERT_OWNERSHIP_ACTION"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operations-certification.test.mjs passed");
