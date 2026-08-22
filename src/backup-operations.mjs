import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  backupStatusPath,
  operationsConfig,
  readBackupStatus,
  readRecoveryDrill,
  recoveryDrillStatus,
  recordRecoveryDrill,
  recordVerifiedBackup,
} from "./operations-governance.mjs";
import { verifyDisasterRecoveryBackup } from "./disaster-recovery.mjs";

const SCHEDULE_SCHEMA_VERSION = 1;
const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function runtimePath(runsRoot, fileName) {
  return path.join(runsRoot, "runtime", "operations", fileName);
}

function writePrivateJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function isIndependentTarget(backupRoot, sourceRoots) {
  return sourceRoots.every((sourceRoot) => {
    const relative = path.relative(path.resolve(sourceRoot), path.resolve(backupRoot));
    return relative !== "" && (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative));
  });
}

function validateBackupRoot(backupRoot, sourceRoots = []) {
  if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error("Backup target harus berupa absolute path.");
  if (sourceRoots.some((sourceRoot) => {
    const relative = path.relative(path.resolve(sourceRoot), path.resolve(backupRoot));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  })) throw new Error("Backup target harus berada di luar Vault dan runtime roots.");
}

export function backupTargetStatus({ runsRoot, vaultRoot, backupRoot = null } = {}) {
  const status = readBackupStatus(runsRoot);
  const target = backupRoot ?? status?.backupPath ?? null;
  const independent = target && vaultRoot ? isIndependentTarget(target, [vaultRoot, runsRoot]) : status?.independentTarget ?? null;
  return {
    schemaVersion: 1,
    action: "BACKUP_TARGET_STATUS",
    configuredTarget: target,
    exists: Boolean(target && fs.existsSync(target)),
    independentTarget: independent,
    registeredBackup: status,
    guardrail: "Target status read-only; scheduling tidak mempromosikan restore dan tidak menghapus backup.",
  };
}

export function previewBackupSchedule({ runsRoot, vaultRoot, backupRoot, intervalHours = 24, commandPath = process.execPath, now = new Date() } = {}) {
  const hours = Number(intervalHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 365) throw new Error("intervalHours harus integer 1-8760.");
  validateBackupRoot(backupRoot, [vaultRoot, runsRoot]);
  const label = "com.personal-ai-orchestrator.backup";
  const logRoot = runtimePath(runsRoot, "backup-scheduler");
  const argumentsList = [commandPath, path.join(MODULE_ROOT, "orchestrator.mjs"), "dr-backup", path.resolve(backupRoot), "--vault", path.resolve(vaultRoot), "--runs", path.resolve(runsRoot)];
  const plist = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\"><dict>",
    `  <key>Label</key><string>${label}</string>`,
    `  <key>ProgramArguments</key><array>${argumentsList.map((value) => `<string>${String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`).join("")}</array>`,
    `  <key>StartInterval</key><integer>${hours * 60 * 60}</integer>`,
    "  <key>RunAtLoad</key><false/>",
    `  <key>StandardOutPath</key><string>${path.join(logRoot, "stdout.log")}</string>`,
    `  <key>StandardErrorPath</key><string>${path.join(logRoot, "stderr.log")}</string>`,
    "</dict></plist>",
  ].join("\n");
  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    action: "BACKUP_SCHEDULE_PREVIEW",
    generatedAt: now.toISOString(),
    label,
    intervalHours: hours,
    backupRoot: path.resolve(backupRoot),
    independentTarget: true,
    launchd: { plist, installCommand: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`, activated: false },
    operations: ["CREATE_QUIESCENT_BACKUP", "VERIFY_BACKUP", "REGISTER_VERIFIED_STATUS"],
    forbiddenAutomaticActions: ["RESTORE", "PROMOTE_RESTORE", "PERMANENT_DELETE", "RETENTION_PURGE"],
  };
}

export function installBackupSchedule({ runsRoot, vaultRoot, backupRoot, intervalHours = 24, confirmed = false, now = new Date() } = {}) {
  if (confirmed !== true) throw new Error("Install schedule membutuhkan confirmation eksplisit.");
  const preview = previewBackupSchedule({ runsRoot, vaultRoot, backupRoot, intervalHours, now });
  const schedulePath = runtimePath(runsRoot, "backup-schedule.json");
  const plistPath = runtimePath(runsRoot, "backup-schedule.plist");
  writePrivateJson(schedulePath, { ...preview, installedAt: now.toISOString(), launchctlActivated: false });
  fs.mkdirSync(path.dirname(plistPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plistPath, `${preview.launchd.plist}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...preview, action: "BACKUP_SCHEDULE_INSTALLED", schedulePath, plistPath, launchctlActivated: false, nextAction: "Operator may inspect plist and activate it separately with launchd after review." };
}

export function readBackupSchedule({ runsRoot } = {}) {
  try { return JSON.parse(fs.readFileSync(runtimePath(runsRoot, "backup-schedule.json"), "utf8")); } catch { return null; }
}

export function previewBackupRotation({ backupRoot, sourceRoots = [], olderThanDays = 30, keepLatest = 2, now = new Date() } = {}) {
  if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error("Backup root harus berupa absolute path.");
  validateBackupRoot(backupRoot, sourceRoots);
  const days = Number(olderThanDays);
  const keep = Number(keepLatest);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("olderThanDays harus integer 1-3650.");
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error("keepLatest harus integer 1-1000.");
  const entries = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")) : [];
  const backups = entries.map((entry) => {
    const backupPath = path.join(backupRoot, entry.name);
    const manifestPath = path.join(backupPath, "manifest.json");
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}
    const modifiedAt = fs.statSync(backupPath).mtime.toISOString();
    return { backupId: manifest?.backupId ?? entry.name, backupPath, status: manifest?.status ?? "INVALID", createdAt: manifest?.createdAt ?? null, modifiedAt, verified: Boolean(manifest?.status === "READY" && fs.existsSync(path.join(backupPath, "READY"))) };
  }).sort((left, right) => String(right.createdAt ?? right.modifiedAt).localeCompare(String(left.createdAt ?? left.modifiedAt)));
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const candidates = backups.slice(keep).filter((item) => Date.parse(item.createdAt ?? item.modifiedAt) < cutoff);
  return {
    schemaVersion: 1,
    action: "BACKUP_ROTATION_PREVIEW",
    generatedAt: now.toISOString(),
    backupRoot: path.resolve(backupRoot),
    olderThanDays: days,
    keepLatest: keep,
    backups,
    candidates,
    summary: { backupCount: backups.length, candidateCount: candidates.length },
    guardrail: "Preview-only. Tidak ada backup yang dipindahkan, dipromosikan, atau dihapus permanen.",
  };
}

export function verifyRegisteredBackup({ runsRoot } = {}) {
  const status = readBackupStatus(runsRoot);
  if (!status?.backupPath) throw new Error("Belum ada backup terverifikasi yang terdaftar.");
  const verification = verifyDisasterRecoveryBackup({ backupPath: status.backupPath });
  const updated = recordVerifiedBackup({ runsRoot, backupPath: status.backupPath, verification, manifest: verification.manifest, independentTarget: status.independentTarget });
  return { schemaVersion: 1, action: "REGISTERED_BACKUP_VERIFIED", verification, status: updated };
}

export function backupRecoveryStatus({ runsRoot, vaultRoot, now = new Date(), config = operationsConfig() } = {}) {
  const schedule = readBackupSchedule({ runsRoot });
  const target = backupTargetStatus({ runsRoot, vaultRoot, backupRoot: schedule?.backupRoot ?? null });
  const drill = recoveryDrillStatus({ runsRoot, now, config });
  return { schemaVersion: 1, action: "BACKUP_RECOVERY_STATUS", generatedAt: now.toISOString(), target, schedule, drill, registeredBackup: readBackupStatus(runsRoot), guardrails: { automaticRestore: false, automaticPromotion: false, permanentDelete: false } };
}

export { recordRecoveryDrill };
