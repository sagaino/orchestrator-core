import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { listJobs, JOB_STATES } from "./job-queue.mjs";
import { daemonStatus, startDaemon, stopDaemon } from "./daemon.mjs";

export const RUNTIME_SOURCE_ITEMS = Object.freeze([
  "src",
  "templates",
  "schemas",
  "docs",
  "package.json",
  "package-lock.json",
  "start.sh",
  "stop.sh",
  "README.md",
  "docs/PHASE_6_RELEASE_CONTRACT.md",
]);

export function runtimeBackupsRoot(runsRoot) {
  return path.join(runsRoot, "runtime-backups");
}

export function checkQueueDrained(runsRoot) {
  const jobs = listJobs(runsRoot);
  const runningJobs = jobs.filter((job) => job.state === JOB_STATES.RUNNING);
  return {
    drained: runningJobs.length === 0,
    runningJobCount: runningJobs.length,
    runningJobs,
  };
}

function copyRecursiveSync(src, dest, excludes = new Set(["node_modules", ".git", "runs"])) {
  if (!fs.existsSync(src)) return 0;
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    const basename = path.basename(src);
    if (excludes.has(basename)) return 0;
    fs.mkdirSync(dest, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(src)) {
      count += copyRecursiveSync(path.join(src, entry), path.join(dest, entry), excludes);
    }
    return count;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 1;
}

export function backupRuntimeSource({ sourceRoot, runsRoot }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backupId = `${stamp}-${randomUUID().slice(0, 8)}`;
  const backupDir = path.join(runtimeBackupsRoot(runsRoot), backupId);
  fs.mkdirSync(backupDir, { recursive: true });

  let filesCount = 0;
  const presentItems = [];
  // Backup every source item that a release candidate is allowed to replace.
  for (const item of RUNTIME_SOURCE_ITEMS) {
    const srcPath = path.join(sourceRoot, item);
    const destPath = path.join(backupDir, item);
    if (fs.existsSync(srcPath)) {
      filesCount += copyRecursiveSync(srcPath, destPath);
      presentItems.push(item);
    }
  }

  const manifest = {
    schemaVersion: 1,
    backupId,
    backedUpAt: new Date().toISOString(),
    sourceRoot,
    filesCount,
    items: presentItems,
  };
  fs.writeFileSync(path.join(backupDir, "backup-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return { backupId, backupDir, filesCount, backedUpAt: manifest.backedUpAt };
}

export function restoreRuntimeSource({ backupDir, sourceRoot }) {
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Backup directory not found: ${backupDir}`);
  }

  const backupManifest = fs.existsSync(path.join(backupDir, "backup-manifest.json"))
    ? JSON.parse(fs.readFileSync(path.join(backupDir, "backup-manifest.json"), "utf8"))
    : {};
  const presentItems = Array.isArray(backupManifest.items)
    ? new Set(backupManifest.items)
    : new Set(RUNTIME_SOURCE_ITEMS.filter((item) => fs.existsSync(path.join(backupDir, item))));
  for (const item of RUNTIME_SOURCE_ITEMS) {
    const backupItemPath = path.join(backupDir, item);
    const targetItemPath = path.join(sourceRoot, item);
    if (presentItems.has(item) && fs.existsSync(backupItemPath)) {
      fs.rmSync(targetItemPath, { recursive: true, force: true });
      copyRecursiveSync(backupItemPath, targetItemPath);
    } else if (!presentItems.has(item)) {
      fs.rmSync(targetItemPath, { recursive: true, force: true });
    }
  }
}

export async function verifyHealth({ runsRoot, timeoutMs = 30000, pollIntervalMs = 500, startTime = Date.now() }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = daemonStatus({ runsRoot });
    if (status.running && status.healthy && status.heartbeatAgeMs !== null && status.heartbeatAgeMs <= 45000) {
      return { healthy: true, status, elapsedMs: Date.now() - startTime };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { healthy: false, error: `Health check timeout after ${timeoutMs}ms`, elapsedMs: Date.now() - startTime };
}

export async function performGuardedUpdate({
  sourceRoot,
  releaseCandidateRoot,
  runsRoot,
  vaultRoot = null,
  cliPath = path.join(sourceRoot, "src", "orchestrator.mjs"),
  timeoutMs = 30000,
  onProgress = () => {},
  daemonOps = { startDaemon, stopDaemon, verifyHealth },
}) {
  onProgress({ stage: "QUEUE_DRAIN_CHECK" });
  const queue = checkQueueDrained(runsRoot);
  if (!queue.drained) {
    throw new Error(`Cannot update: queue is not drained (${queue.runningJobCount} running jobs).`);
  }

  onProgress({ stage: "CREATING_RUNTIME_BACKUP" });
  const backup = backupRuntimeSource({ sourceRoot, runsRoot });

  let updateApplied = false;
  try {
    onProgress({ stage: "STOPPING_DAEMON" });
    try {
      await daemonOps.stopDaemon({ runsRoot });
    } catch {}

    onProgress({ stage: "APPLYING_RELEASE_CANDIDATE" });
    copyRecursiveSync(releaseCandidateRoot, sourceRoot, new Set(["node_modules", ".git", "runs", "candidate-manifest.json", "checksums.sha256"]));
    updateApplied = true;

    onProgress({ stage: "STARTING_NEW_DAEMON" });
    await daemonOps.startDaemon({ runsRoot, cliPath, vaultRoot });

    onProgress({ stage: "VERIFYING_HEALTH" });
    const healthResult = await daemonOps.verifyHealth({ runsRoot, timeoutMs });
    if (!healthResult.healthy) {
      throw new Error(`New daemon health check failed: ${healthResult.error}`);
    }

    onProgress({ stage: "UPDATE_COMPLETED_SUCCESSFULLY" });
    return {
      success: true,
      rolledBack: false,
      backupDir: backup.backupDir,
      health: healthResult.status,
    };
  } catch (err) {
    onProgress({ stage: "ROLLBACK_INITIATED", error: err.message });
    if (updateApplied) {
      try {
        try {
          await daemonOps.stopDaemon({ runsRoot });
        } catch {}
        restoreRuntimeSource({ backupDir: backup.backupDir, sourceRoot });
        await daemonOps.startDaemon({ runsRoot, cliPath, vaultRoot });
        await daemonOps.verifyHealth({ runsRoot, timeoutMs });
      } catch (rollbackErr) {
        return {
          success: false,
          rolledBack: false,
          errorCode: err.code ?? null,
          error: `Update failed (${err.message}) and rollback encountered error: ${rollbackErr.message}`,
          backupDir: backup.backupDir,
        };
      }
    }
    return {
      success: false,
      rolledBack: true,
      errorCode: err.code ?? null,
      error: err.message,
      backupDir: backup.backupDir,
    };
  }
}
