import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createDisasterRecoveryBackup,
  restoreDisasterRecoveryBackup,
  verifyDisasterRecoveryBackup,
} from "../src/disaster-recovery.mjs";
import { assertExecutionAllowed, readRecoveryMode } from "../src/recovery-mode.mjs";

console.log("Running disaster-recovery.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-dr-"));
const vaultRoot = path.join(root, "vault-source");
const runsRoot = path.join(root, "runs-source");
const backupRoot = path.join(root, "backups");

function rewriteManifestChecksum(backupPath) {
  const manifestText = fs.readFileSync(path.join(backupPath, "manifest.json"), "utf8");
  const checksum = createHash("sha256").update(manifestText).digest("hex");
  fs.writeFileSync(path.join(backupPath, "manifest.sha256"), `${checksum}  manifest.json\n`, { mode: 0o600 });
}

try {
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "fixture", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "01-Wiki"), { recursive: true });
  fs.mkdirSync(path.join(runsRoot, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(runsRoot, "events"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), "# Registry\n", { mode: 0o640 });
  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "fixture", "tasks", "TASK-001.md"), "status: DONE\n", { mode: 0o600 });
  fs.writeFileSync(path.join(vaultRoot, "01-Wiki", "recovery.md"), "# Recovery knowledge\n", { mode: 0o644 });
  fs.writeFileSync(path.join(runsRoot, "runtime", "api-token.json"), `{\"token\":\"${"a".repeat(64)}\"}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(runsRoot, "events", "task-001.jsonl"), "{\"event\":\"DONE\"}\n", { mode: 0o640 });

  assert.throws(() => createDisasterRecoveryBackup({
    vaultRoot,
    runsRoot,
    backupRoot,
    runtime: { running: true },
    allowDaemonIdle: false,
  }), /runtime belum quiescent/);

  const idleBackup = createDisasterRecoveryBackup({
    vaultRoot,
    runsRoot,
    backupRoot,
    runtime: { running: true },
    allowDaemonIdle: true,
    now: new Date("2026-08-21T00:00:00.000Z"),
  });
  assert.equal(idleBackup.status, "READY");
  assert.equal(idleBackup.consistency.daemonStopped, false);
  assert.equal(idleBackup.consistency.daemonRunning, true);
  assert.equal(idleBackup.consistency.daemonIdleAllowed, true);

  fs.mkdirSync(backupRoot, { recursive: true });
  const lockPath = path.join(backupRoot, ".backup.lock");
  fs.writeFileSync(lockPath, "existing-owner\n", { mode: 0o600 });
  assert.throws(() => createDisasterRecoveryBackup({
    vaultRoot,
    runsRoot,
    backupRoot,
    runtime: { running: false },
  }), /EEXIST/);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "existing-owner\n");
  fs.unlinkSync(lockPath);

  const created = createDisasterRecoveryBackup({
    vaultRoot,
    runsRoot,
    backupRoot,
    runtime: { running: false },
    now: new Date("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(created.status, "READY");
  assert.equal(created.consistency.daemonStopped, true);
  assert.equal(created.recovery.executionBlocked, true);

  const verified = verifyDisasterRecoveryBackup({ backupPath: created.backupPath });
  assert.equal(verified.status, "VERIFIED");
  assert.equal(verified.fileCount, 6);

  const restoreRoot = path.join(root, "quarantine-restore");
  const restored = restoreDisasterRecoveryBackup({ backupPath: created.backupPath, targetRoot: restoreRoot });
  assert.equal(restored.status, "RESTORED_TO_QUARANTINE");
  assert.equal(restored.executionBlocked, true);
  assert.equal(fs.readFileSync(path.join(restoreRoot, "vault", "project-registry.md"), "utf8"), "# Registry\n");
  assert.equal(fs.readFileSync(path.join(restoreRoot, "runs", "events", "task-001.jsonl"), "utf8"), "{\"event\":\"DONE\"}\n");
  assert.equal(fs.statSync(path.join(restoreRoot, "runs", "runtime", "api-token.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(restoreRoot, "RECOVERY_MODE.json"), "utf8")).executionBlocked, true);
  assert.equal(readRecoveryMode(path.join(restoreRoot, "runs")).executionBlocked, true);
  assert.throws(() => assertExecutionAllowed(path.join(restoreRoot, "runs")), /mutasi diblokir/);

  const corruptFile = path.join(created.backupPath, "data", "vault", "project-registry.md");
  fs.appendFileSync(corruptFile, "corrupt\n");
  assert.throws(() => verifyDisasterRecoveryBackup({ backupPath: created.backupPath }), /Checksum backup entry tidak valid/);
  fs.writeFileSync(corruptFile, "# Registry\n", { mode: 0o640 });

  fs.unlinkSync(path.join(created.backupPath, "READY"));
  assert.throws(() => verifyDisasterRecoveryBackup({ backupPath: created.backupPath }), /Backup incomplete/);
  fs.writeFileSync(path.join(created.backupPath, "READY"), `${created.backupId}\n`, { mode: 0o600 });

  const manifestPath = path.join(created.backupPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.schemaVersion = 999;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  rewriteManifestChecksum(created.backupPath);
  assert.throws(() => verifyDisasterRecoveryBackup({ backupPath: created.backupPath }), /schema tidak kompatibel/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("disaster-recovery.test.mjs passed");
