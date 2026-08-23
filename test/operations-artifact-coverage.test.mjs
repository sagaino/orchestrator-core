import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDisasterRecoveryBackup, restoreDisasterRecoveryBackup, verifyDisasterRecoveryBackup } from "../src/disaster-recovery.mjs";
import { summarizeOperationsArtifacts } from "../src/operations-artifacts.mjs";
import { previewRetention, recordRecoveryDrill, recoveryDrillStatus } from "../src/operations-governance.mjs";

console.log("Running operations-artifact-coverage.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-artifact-coverage-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const backupRoot = path.join(root, "backups");
const now = new Date("2026-08-23T00:00:00.000Z");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

try {
  fs.mkdirSync(vaultRoot, { recursive: true });
  writeJson(path.join(runsRoot, "objectives", "obj-active.json"), { objectiveId: "obj-active", state: "RUNNING" });
  writeJson(path.join(runsRoot, "plans", "plan-active.json"), { planId: "plan-active", state: "APPROVED" });
  writeJson(path.join(runsRoot, "orchestrations", "orch-active.json"), { orchestrationId: "orch-active", state: "RUNNING" });
  writeJson(path.join(runsRoot, "decisions", "decision-open.json"), { decisionId: "decision-open", state: "OPEN" });
  writeJson(path.join(runsRoot, "integration", "orch-active", "aggregate-evidence.json"), { orchestrationId: "orch-active", status: "RUNNING" });
  fs.mkdirSync(path.join(runsRoot, "workspace-artifacts", "old-safe-artifact"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runsRoot, "workspace-artifacts", "old-safe-artifact", "output.txt"), "safe artifact\n", { mode: 0o600 });
  const oldDate = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(path.join(runsRoot, "workspace-artifacts", "old-safe-artifact"), oldDate, oldDate);

  const sourceCoverage = summarizeOperationsArtifacts({ runsRoot });
  assert.equal(sourceCoverage.complete, true);
  assert.deepEqual(sourceCoverage.requiredCollections, ["objectives", "plans", "orchestrations", "decisions", "integration"]);
  assert.equal(sourceCoverage.protectedActiveRecordCount, 4);
  assert.equal(sourceCoverage.collections.integration.fileCount, 1);

  const retention = previewRetention({ runsRoot, olderThanDays: 30, now });
  assert.equal(retention.summary.candidateCount, 1);
  assert.equal(retention.candidates[0].category, "workspace-artifacts");
  assert.equal(retention.protection.activeStateNeverPurged, true);
  assert.equal(retention.protection.protectedActiveRecordCount, 4);
  assert.equal(retention.candidates.some((candidate) => ["objectives", "plans", "orchestrations", "decisions", "integration"].includes(candidate.category)), false);

  const backup = createDisasterRecoveryBackup({ vaultRoot, runsRoot, backupRoot, runtime: { running: false }, now });
  assert.equal(backup.artifactCoverage.complete, true);
  assert.equal(backup.artifactCoverage.collections.integration.fileCount, 1);
  const verified = verifyDisasterRecoveryBackup({ backupPath: backup.backupPath });
  assert.equal(verified.artifactCoverage.complete, true);
  assert.equal(verified.artifactCoverage.protectedActiveRecordCount, 4);

  const restoreRoot = path.join(root, "quarantine");
  const restored = restoreDisasterRecoveryBackup({ backupPath: backup.backupPath, targetRoot: restoreRoot });
  assert.equal(restored.executionBlocked, true);
  assert.equal(fs.existsSync(path.join(restoreRoot, "runs", "objectives", "obj-active.json")), true);
  assert.equal(fs.existsSync(path.join(restoreRoot, "runs", "integration", "orch-active", "aggregate-evidence.json")), true);

  const drill = recordRecoveryDrill({ runsRoot, performedBy: "coverage-operator", evidence: "quarantine restore coverage verified", now });
  assert.equal(drill.artifactCoverage.complete, true);
  assert.equal(recoveryDrillStatus({ runsRoot, now }).artifactCoverage.protectedActiveRecordCount, 4);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operations-artifact-coverage.test.mjs passed");
