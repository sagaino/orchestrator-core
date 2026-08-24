import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDisasterRecoveryBackup } from "../src/disaster-recovery.mjs";
import {
  backupRecoveryStatus,
  installBackupSchedule,
  previewBackupRotation,
  previewBackupSchedule,
  recordRecoveryDrill,
  verifyRegisteredBackup,
} from "../src/backup-operations.mjs";
import { operationsConfig, operationsReadiness, recoveryDrillStatus, readBackupStatus } from "../src/operations-governance.mjs";

console.log("Running backup-operations.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-backup-operations-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const backupRoot = path.join(root, "external-backups");
const now = new Date("2026-08-22T00:00:00.000Z");

try {
  fs.mkdirSync(path.join(vaultRoot, "notes"), { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "notes", "readme.md"), "backup evidence\n");
  fs.writeFileSync(path.join(runsRoot, "runtime-state.json"), "quiescent\n");
  fs.mkdirSync(path.join(runsRoot, "workspaces", "task", "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, "workspace-target.txt"), "dependency target\n");
  fs.symlinkSync(
    "../../../workspace-target.txt",
    path.join(runsRoot, "workspaces", "task", "node_modules", ".bin", "acorn"),
  );

  const backup = createDisasterRecoveryBackup({ vaultRoot, runsRoot, backupRoot, runtime: { running: false }, now });
  const registered = readBackupStatus(runsRoot);
  assert.equal(registered.backupId, backup.backupId);
  assert.equal(registered.independentTarget, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup.backupPath, "manifest.json"), "utf8"));
  const skippedSymlink = manifest.datasets
    .find((dataset) => dataset.dataset === "runs")
    ?.skippedEntries
    ?.find((entry) => entry.path.endsWith("node_modules/.bin/acorn"));
  assert.deepEqual(skippedSymlink, {
    path: "workspaces/task/node_modules/.bin/acorn",
    type: "symlink",
    reason: "SYMLINK_SKIPPED",
  });

  const schedulePreview = previewBackupSchedule({ runsRoot, vaultRoot, backupRoot, intervalHours: 12, now });
  assert.equal(schedulePreview.intervalHours, 12);
  assert.equal(schedulePreview.launchd.activated, false);
  assert.match(schedulePreview.launchd.plist, /StartInterval.*43200/s);
  assert.match(schedulePreview.launchd.plist, /--vault/);
  assert.deepEqual(schedulePreview.forbiddenAutomaticActions, ["RESTORE", "PROMOTE_RESTORE", "PERMANENT_DELETE", "RETENTION_PURGE"]);
  assert.equal(fs.existsSync(path.join(runsRoot, "runtime", "operations", "backup-schedule.json")), false);

  assert.throws(() => installBackupSchedule({ runsRoot, vaultRoot, backupRoot }), /confirmation eksplisit/);
  const installed = installBackupSchedule({ runsRoot, vaultRoot, backupRoot, intervalHours: 24, confirmed: true, now });
  assert.equal(installed.launchctlActivated, false);
  assert.equal(fs.existsSync(installed.schedulePath), true);
  assert.equal(fs.existsSync(installed.plistPath), true);

  for (const [name, createdAt] of [["old-a", "2026-06-01T00:00:00.000Z"], ["old-b", "2026-06-02T00:00:00.000Z"], ["latest", "2026-08-21T00:00:00.000Z"]]) {
    const directory = path.join(backupRoot, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ backupId: name, status: "READY", createdAt }));
    fs.writeFileSync(path.join(directory, "READY"), `${name}\n`);
  }
  const rotation = previewBackupRotation({ backupRoot, sourceRoots: [vaultRoot, runsRoot], olderThanDays: 30, keepLatest: 1, now });
  assert.equal(rotation.summary.candidateCount, 2);
  assert.equal(rotation.guardrail.includes("Preview-only"), true);
  assert.equal(fs.existsSync(path.join(backupRoot, "old-a")), true);

  const verified = verifyRegisteredBackup({ runsRoot });
  assert.equal(verified.action, "REGISTERED_BACKUP_VERIFIED");
  assert.equal(verified.status.independentTarget, true);

  const drill = recordRecoveryDrill({ runsRoot, performedBy: "test-operator", evidence: "restore to quarantine verified", now, intervalDays: 30 });
  assert.equal(recoveryDrillStatus({ runsRoot, now }).status, "CURRENT");
  assert.equal(recoveryDrillStatus({ runsRoot, now: new Date("2026-09-22T00:00:01.000Z") }).status, "OVERDUE");
  assert.equal(drill.intervalDays, 30);

  const recoveryStatus = backupRecoveryStatus({ runsRoot, vaultRoot, now });
  assert.equal(recoveryStatus.target.independentTarget, true);
  assert.equal(recoveryStatus.schedule.launchctlActivated, false);
  assert.equal(recoveryStatus.drill.status, "CURRENT");
  assert.deepEqual(recoveryStatus.guardrails, { automaticRestore: false, automaticPromotion: false, permanentDelete: false });

  const readiness = operationsReadiness({ runsRoot, now, config: { ...operationsConfig(), recoveryDrillIntervalDays: 30 }, daemon: { running: false, heartbeatAt: null } });
  assert.equal(readiness.checks.find((item) => item.id === "backup-target").status, "PASS");
  assert.equal(readiness.checks.find((item) => item.id === "backup-schedule").status, "WARN", "schedule artifact is installed but launchd remains an explicit operator action");
  assert.equal(readiness.admission.allowed, true, "schedule reminder must not block task admission");
  assert.equal(readiness.checks.find((item) => item.id === "recovery-drill").status, "PASS");

  const schedulePath = path.join(runsRoot, "runtime", "operations", "backup-schedule.json");
  const schedule = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
  fs.writeFileSync(schedulePath, JSON.stringify({ ...schedule, launchctlActivated: true }));
  const activeScheduleReadiness = operationsReadiness({ runsRoot, now, config: { ...operationsConfig(), recoveryDrillIntervalDays: 30 }, daemon: { running: false, heartbeatAt: null } });
  assert.equal(activeScheduleReadiness.checks.find((item) => item.id === "backup-schedule").status, "PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("backup-operations.test.mjs passed");
