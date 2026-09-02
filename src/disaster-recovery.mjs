import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { daemonStatus } from "./daemon.mjs";
import { listJobs, JOB_STATES } from "./job-queue.mjs";
import { listRuns, RUN_STATES } from "./run-manager.mjs";
import { normalizeSafeRelativePath } from "./security.mjs";
import { recoveryModePath } from "./recovery-mode.mjs";
import { readBackupStatus, recordVerifiedBackup } from "./operations-governance.mjs";
import { assertBackupArtifactCoverage, summarizeOperationsArtifacts } from "./operations-artifacts.mjs";

export const DR_SCHEMA_VERSION = 1;
export const DR_RPO_TARGET_HOURS = 24;
export const DR_RTO_TARGET_MINUTES = 15;

const ACTIVE_RUN_STATES = new Set([
  RUN_STATES.CLAIMING,
  RUN_STATES.CLAIMED,
  RUN_STATES.RUNNING,
  RUN_STATES.VERIFYING,
  RUN_STATES.CHANGES_REQUESTED,
]);

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertDisjoint(left, right, label) {
  if (isInside(left, right) || isInside(right, left)) {
    throw new Error(`${label} harus berada di luar source dataset dan tidak boleh menaunginya.`);
  }
}

function safeRemovePartial(parent, target) {
  if (!isInside(parent, target) || path.resolve(parent) === path.resolve(target)) {
    throw new Error(`Partial backup target tidak aman untuk dibersihkan: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function walkDataset(root, { excludeTopLevel = new Set() } = {}) {
  const entries = [];
  const skippedEntries = [];
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relativeDirectory && excludeTopLevel.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        // Symlinks are intentionally not copied or followed. Workspaces commonly
        // contain dependency links such as node_modules/.bin/*, while restoring
        // them could recreate links that escape the backup root.
        skippedEntries.push({
          path: relative,
          type: "symlink",
          reason: "SYMLINK_SKIPPED",
        });
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        entries.push({
          path: relative,
          type: "file",
          mode: stat.mode & 0o777,
          sizeBytes: stat.size,
          sha256: sha256File(absolute),
        });
      }
    }
  };
  walk(root);
  return {
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
    skippedEntries: skippedEntries.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function copyDataset({ dataset, sourceRoot, dataRoot, excludeTopLevel }) {
  const walked = walkDataset(sourceRoot, { excludeTopLevel });
  const entries = walked.entries;
  const destinationRoot = path.join(dataRoot, dataset);
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    const source = path.join(sourceRoot, ...entry.path.split("/"));
    const destination = path.join(destinationRoot, ...entry.path.split("/"));
    if (entry.type === "directory") {
      fs.mkdirSync(destination, { recursive: true, mode: entry.mode });
      fs.chmodSync(destination, entry.mode);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, entry.mode);
    const copiedHash = sha256File(destination);
    if (copiedHash !== entry.sha256 || fs.statSync(destination).size !== entry.sizeBytes) {
      throw new Error(`Source berubah atau hasil copy tidak konsisten: ${dataset}/${entry.path}`);
    }
    totalBytes += entry.sizeBytes;
    fileCount += 1;
  }

  return {
    dataset,
    sourceRoot: path.resolve(sourceRoot),
    fileCount,
    totalBytes,
    entries,
    skippedEntries: walked.skippedEntries,
  };
}

export function assessDisasterRecoveryReadiness({ runsRoot, runtime = null, allowDaemonIdle = false } = {}) {
  const status = runtime ?? daemonStatus({ runsRoot });
  const activeJobs = listJobs(runsRoot)
    .filter((job) => job.state === JOB_STATES.RUNNING)
    .map((job) => ({ jobId: job.jobId, state: job.state, projectId: job.projectId }));
  const activeRuns = listRuns(runsRoot)
    .filter((run) => ACTIVE_RUN_STATES.has(run.state))
    .map((run) => ({ runId: run.runId, state: run.state, projectId: run.project?.id ?? null }));
  const daemonBlocker = status.running
    ? (allowDaemonIdle
        ? (activeJobs.length > 0 || activeRuns.length > 0
            ? [{ code: "DAEMON_BUSY", message: "Daemon sedang memproses job aktif; tunggu hingga idle." }]
            : [])
        : [{ code: "DAEMON_RUNNING", message: "Daemon harus dihentikan sebelum consistent backup." }])
    : [];
  const blockers = [
    ...daemonBlocker,
    ...activeJobs.map((job) => ({ code: "ACTIVE_JOB", message: `${job.jobId} masih ${job.state}.`, ...job })),
    ...activeRuns.map((run) => ({ code: "ACTIVE_RUN", message: `${run.runId} masih ${run.state}.`, ...run })),
  ];
  return {
    ready: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    daemonRunning: Boolean(status.running),
    daemonIdle: Boolean(status.running && activeJobs.length === 0 && activeRuns.length === 0),
    activeJobs,
    activeRuns,
    blockers,
  };
}

function writeManifest(backupPath, manifest) {
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(backupPath, "manifest.json"), manifestText, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(path.join(backupPath, "manifest.sha256"), `${sha256Text(manifestText)}  manifest.json\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.writeFileSync(path.join(backupPath, "READY"), `${manifest.backupId}\n`, { encoding: "utf8", mode: 0o600 });
}

export function createDisasterRecoveryBackup({
  vaultRoot,
  runsRoot,
  backupRoot,
  runtime = null,
  allowDaemonIdle = false,
  now = new Date(),
} = {}) {
  for (const [label, root] of Object.entries({ vaultRoot, runsRoot })) {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`${label} tidak ditemukan atau bukan direktori: ${root}`);
    }
  }
  if (!backupRoot) throw new Error("backupRoot wajib diisi.");
  const resolvedBackupRoot = path.resolve(backupRoot);
  assertDisjoint(vaultRoot, resolvedBackupRoot, "Backup root");
  assertDisjoint(runsRoot, resolvedBackupRoot, "Backup root");

  const readiness = assessDisasterRecoveryReadiness({ runsRoot, runtime, allowDaemonIdle });
  if (!readiness.ready) {
    const error = new Error("Consistent backup ditolak karena runtime belum quiescent.");
    error.code = "DR_NOT_QUIESCENT";
    error.details = { blockers: readiness.blockers };
    throw error;
  }

  fs.mkdirSync(resolvedBackupRoot, { recursive: true, mode: 0o700 });
  const backupId = `dr-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const partialPath = path.join(resolvedBackupRoot, `.${backupId}.partial`);
  const backupPath = path.join(resolvedBackupRoot, backupId);
  const lockPath = path.join(resolvedBackupRoot, ".backup.lock");
  let lockDescriptor = null;
  const startedAtMs = Date.now();

  try {
    lockDescriptor = fs.openSync(lockPath, "wx", 0o600);
    fs.mkdirSync(path.join(partialPath, "data"), { recursive: true, mode: 0o700 });
    const datasets = [
      copyDataset({ dataset: "vault", sourceRoot: vaultRoot, dataRoot: path.join(partialPath, "data") }),
      copyDataset({
        dataset: "runs",
        sourceRoot: runsRoot,
        dataRoot: path.join(partialPath, "data"),
        excludeTopLevel: new Set(["disaster-recovery", "daemon", ".orchestrator.pids"]),
      }),
    ];
    const artifactCoverage = summarizeOperationsArtifacts({ runsRoot });
    const completedAt = new Date();
    const manifest = {
      schemaVersion: DR_SCHEMA_VERSION,
      kind: "personal-ai-os-disaster-recovery-backup",
      backupId,
      status: "READY",
      createdAt: now.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Date.now() - startedAtMs,
      checksumAlgorithm: "sha256",
      consistency: {
        mode: readiness.daemonRunning ? "IDLE_DAEMON_SNAPSHOT" : "QUIESCENT_SNAPSHOT",
        daemonStopped: !readiness.daemonRunning,
        daemonRunning: readiness.daemonRunning,
        daemonIdleAllowed: Boolean(allowDaemonIdle),
        activeJobCount: 0,
        activeRunCount: 0,
      },
      recovery: {
        restoreMode: "QUARANTINE_ONLY",
        executionBlocked: true,
        rpoTargetHours: DR_RPO_TARGET_HOURS,
        rtoTargetMinutes: DR_RTO_TARGET_MINUTES,
      },
      configurationSnapshot: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        vaultRoot: path.resolve(vaultRoot),
        runsRoot: path.resolve(runsRoot),
        projectRegistry: "vault/project-registry.md",
        runtimeToken: "runs/runtime/api-token.json",
      },
      datasets,
      artifactCoverage,
      summary: {
        datasetCount: datasets.length,
        fileCount: datasets.reduce((sum, item) => sum + item.fileCount, 0),
        totalBytes: datasets.reduce((sum, item) => sum + item.totalBytes, 0),
      },
    };
    writeManifest(partialPath, manifest);
    fs.renameSync(partialPath, backupPath);
    const result = {
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
      backupId,
      status: manifest.status,
      createdAt: manifest.createdAt,
      completedAt: manifest.completedAt,
      durationMs: manifest.durationMs,
      consistency: manifest.consistency,
      recovery: manifest.recovery,
      configurationSnapshot: manifest.configurationSnapshot,
      artifactCoverage: manifest.artifactCoverage,
      summary: manifest.summary,
      backupPath,
      manifestPath: path.join(backupPath, "manifest.json"),
    };
    const verification = verifyDisasterRecoveryBackup({ backupPath, now });
    recordVerifiedBackup({ runsRoot, backupPath, verification, manifest, sourceRoots: [vaultRoot, runsRoot] });
    return result;
  } catch (error) {
    if (fs.existsSync(partialPath)) safeRemovePartial(resolvedBackupRoot, partialPath);
    throw error;
  } finally {
    if (lockDescriptor !== null) {
      fs.closeSync(lockDescriptor);
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
  }
}

function readAndValidateManifest(backupPath) {
  const readyPath = path.join(backupPath, "READY");
  const manifestPath = path.join(backupPath, "manifest.json");
  const checksumPath = path.join(backupPath, "manifest.sha256");
  if (!fs.existsSync(readyPath) || !fs.existsSync(manifestPath) || !fs.existsSync(checksumPath)) {
    throw new Error("Backup incomplete: READY, manifest.json, dan manifest.sha256 wajib tersedia.");
  }
  const manifestText = fs.readFileSync(manifestPath, "utf8");
  const recordedChecksum = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  if (recordedChecksum !== sha256Text(manifestText)) throw new Error("Checksum manifest backup tidak valid.");
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== DR_SCHEMA_VERSION || manifest.kind !== "personal-ai-os-disaster-recovery-backup") {
    throw new Error(`Backup schema tidak kompatibel: ${manifest.schemaVersion ?? "unknown"}.`);
  }
  if (manifest.status !== "READY" || fs.readFileSync(readyPath, "utf8").trim() !== manifest.backupId) {
    throw new Error("Backup marker tidak cocok dengan manifest.");
  }
  if (!Array.isArray(manifest.datasets) || !manifest.datasets.length) throw new Error("Backup tidak memiliki dataset.");
  return manifest;
}

export function verifyDisasterRecoveryBackup({ backupPath, now = new Date() } = {}) {
  if (!backupPath || !fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) {
    throw new Error(`Backup path tidak ditemukan: ${backupPath}`);
  }
  const startedAtMs = Date.now();
  const manifest = readAndValidateManifest(backupPath);
  const artifactCoverage = assertBackupArtifactCoverage({ manifest, backupPath });
  let fileCount = 0;
  let totalBytes = 0;
  for (const dataset of manifest.datasets) {
    const datasetRoot = path.join(backupPath, "data", dataset.dataset);
    if (!fs.existsSync(datasetRoot) || !fs.statSync(datasetRoot).isDirectory()) {
      throw new Error(`Dataset backup hilang: ${dataset.dataset}.`);
    }
    for (const entry of dataset.entries ?? []) {
      const relative = normalizeSafeRelativePath(entry.path, { label: "Backup entry" });
      const absolute = path.join(datasetRoot, ...relative.split("/"));
      if (!fs.existsSync(absolute)) throw new Error(`Backup entry hilang: ${dataset.dataset}/${relative}`);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Backup entry tidak boleh berupa symlink: ${dataset.dataset}/${relative}`);
      if ((stat.mode & 0o777) !== entry.mode) throw new Error(`Permission backup berubah: ${dataset.dataset}/${relative}`);
      if (entry.type === "directory") {
        if (!stat.isDirectory()) throw new Error(`Tipe backup entry tidak cocok: ${dataset.dataset}/${relative}`);
        continue;
      }
      if (!stat.isFile() || stat.size !== entry.sizeBytes || sha256File(absolute) !== entry.sha256) {
        throw new Error(`Checksum backup entry tidak valid: ${dataset.dataset}/${relative}`);
      }
      fileCount += 1;
      totalBytes += stat.size;
    }
  }
  if (fileCount !== manifest.summary?.fileCount || totalBytes !== manifest.summary?.totalBytes) {
    throw new Error("Ringkasan backup tidak cocok dengan file yang diverifikasi.");
  }
  const result = {
    schemaVersion: DR_SCHEMA_VERSION,
    backupId: manifest.backupId,
    status: "VERIFIED",
    verifiedAt: now.toISOString(),
    durationMs: Date.now() - startedAtMs,
    fileCount,
    totalBytes,
    artifactCoverage,
  };
  Object.defineProperty(result, "manifest", { value: manifest, enumerable: false });
  return result;
}

export function registerVerifiedDisasterRecoveryBackup({ runsRoot, backupPath, vaultRoot = null, now = new Date() } = {}) {
  const verification = verifyDisasterRecoveryBackup({ backupPath, now });
  const previous = readBackupStatus(runsRoot);
  return recordVerifiedBackup({
    runsRoot,
    backupPath,
    verification,
    manifest: verification.manifest,
    sourceRoots: vaultRoot ? [vaultRoot, runsRoot] : [],
    independentTarget: vaultRoot ? null : previous?.independentTarget ?? null,
  });
}

export function restoreDisasterRecoveryBackup({ backupPath, targetRoot } = {}) {
  if (!targetRoot) throw new Error("targetRoot wajib diisi.");
  const resolvedTarget = path.resolve(targetRoot);
  const resolvedBackup = path.resolve(backupPath);
  assertDisjoint(resolvedBackup, resolvedTarget, "Restore target");
  if (fs.existsSync(resolvedTarget)) throw new Error("Restore target harus belum ada agar restore bersifat atomic.");

  const verification = verifyDisasterRecoveryBackup({ backupPath: resolvedBackup });
  const parent = path.dirname(resolvedTarget);
  const partial = path.join(parent, `.${path.basename(resolvedTarget)}.${randomUUID().slice(0, 8)}.partial`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const startedAtMs = Date.now();

  try {
    fs.mkdirSync(partial, { recursive: true, mode: 0o700 });
    for (const dataset of verification.manifest.datasets) {
      const sourceRoot = path.join(resolvedBackup, "data", dataset.dataset);
      const destinationRoot = path.join(partial, dataset.dataset);
      fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
      for (const entry of dataset.entries ?? []) {
        const relative = normalizeSafeRelativePath(entry.path, { label: "Restore entry" });
        const source = path.join(sourceRoot, ...relative.split("/"));
        const destination = path.join(destinationRoot, ...relative.split("/"));
        if (entry.type === "directory") {
          fs.mkdirSync(destination, { recursive: true, mode: entry.mode });
          fs.chmodSync(destination, entry.mode);
          continue;
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, entry.mode);
        if (sha256File(destination) !== entry.sha256) throw new Error(`Restore checksum gagal: ${dataset.dataset}/${relative}`);
      }
    }
    const recoveryRecord = {
      schemaVersion: DR_SCHEMA_VERSION,
      mode: "RECOVERY_QUARANTINE",
      executionBlocked: true,
      backupId: verification.backupId,
      restoredAt: new Date().toISOString(),
      instruction: "Jangan arahkan daemon ke dataset ini sebelum validasi dan explicit promotion selesai.",
    };
    fs.writeFileSync(path.join(partial, "RECOVERY_MODE.json"), `${JSON.stringify(recoveryRecord, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const runtimeRecoveryPath = recoveryModePath(path.join(partial, "runs"));
    fs.mkdirSync(path.dirname(runtimeRecoveryPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(runtimeRecoveryPath, `${JSON.stringify(recoveryRecord, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(partial, resolvedTarget);
    return {
      schemaVersion: DR_SCHEMA_VERSION,
      status: "RESTORED_TO_QUARANTINE",
      backupId: verification.backupId,
      targetRoot: resolvedTarget,
      vaultRoot: path.join(resolvedTarget, "vault"),
      runsRoot: path.join(resolvedTarget, "runs"),
      executionBlocked: true,
      durationMs: Date.now() - startedAtMs,
      fileCount: verification.fileCount,
      totalBytes: verification.totalBytes,
    };
  } catch (error) {
    if (fs.existsSync(partial)) safeRemovePartial(parent, partial);
    throw error;
  }
}
