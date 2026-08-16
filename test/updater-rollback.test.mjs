import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupRuntimeSource,
  restoreRuntimeSource,
  checkQueueDrained,
  performGuardedUpdate,
} from "../src/updater.mjs";
import { JOB_STATES } from "../src/job-queue.mjs";

console.log("Running updater-rollback.test.mjs...");

const tempSource = fs.mkdtempSync(path.join(os.tmpdir(), "updater-src-"));
const tempRuns = fs.mkdtempSync(path.join(os.tmpdir(), "updater-runs-"));
const tempCandidate = fs.mkdtempSync(path.join(os.tmpdir(), "updater-cand-"));

try {
  // 1. Setup mock source repository
  fs.mkdirSync(path.join(tempSource, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempSource, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  fs.writeFileSync(path.join(tempSource, "src", "index.mjs"), "console.log('stable v1.0.0');");

  // 2. Test Backup and Restore
  const backup = backupRuntimeSource({ sourceRoot: tempSource, runsRoot: tempRuns });
  assert.equal(backup.filesCount >= 2, true);
  assert.equal(fs.existsSync(backup.backupDir), true);

  // Modify source
  fs.writeFileSync(path.join(tempSource, "src", "index.mjs"), "console.log('corrupted');");
  assert.match(fs.readFileSync(path.join(tempSource, "src", "index.mjs"), "utf8"), /corrupted/);

  // Restore source
  restoreRuntimeSource({ backupDir: backup.backupDir, sourceRoot: tempSource });
  assert.match(fs.readFileSync(path.join(tempSource, "src", "index.mjs"), "utf8"), /stable v1\.0\.0/);

  // 3. Test Queue Drain Check
  const jobsDir = path.join(tempRuns, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const emptyDrain = checkQueueDrained(tempRuns);
  assert.equal(emptyDrain.drained, true);

  // Add running job
  const runningJob = {
    schemaVersion: 1,
    jobId: "job-run-1",
    projectId: "p1",
    taskId: "T-1",
    taskPath: "t.md",
    state: JOB_STATES.RUNNING,
  };
  fs.writeFileSync(path.join(jobsDir, "job-run-1.json"), JSON.stringify(runningJob, null, 2));
  const busyDrain = checkQueueDrained(tempRuns);
  assert.equal(busyDrain.drained, false);
  assert.equal(busyDrain.runningJobCount, 1);

  // Cleanup job
  fs.unlinkSync(path.join(jobsDir, "job-run-1.json"));

  // 4. Test Failure Drill: Simulated Broken Update with Automatic Rollback
  fs.mkdirSync(path.join(tempCandidate, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempCandidate, "src", "index.mjs"), "console.log('broken release candidate');");

  let mockDaemonState = "STOPPED";
  const mockDaemonOps = {
    startDaemon: async () => {
      mockDaemonState = "STARTED";
    },
    stopDaemon: async () => {
      mockDaemonState = "STOPPED";
    },
    verifyHealth: async () => {
      // Simulate health check failure for the broken candidate
      const currentSource = fs.readFileSync(path.join(tempSource, "src", "index.mjs"), "utf8");
      if (currentSource.includes("broken release candidate")) {
        return { healthy: false, error: "Process crashed on boot" };
      }
      return { healthy: true, status: { running: true, healthy: true } };
    },
  };

  const progressEvents = [];
  const drillResult = await performGuardedUpdate({
    sourceRoot: tempSource,
    releaseCandidateRoot: tempCandidate,
    runsRoot: tempRuns,
    daemonOps: mockDaemonOps,
    onProgress: (evt) => progressEvents.push(evt.stage),
  });

  assert.equal(drillResult.success, false);
  assert.equal(drillResult.rolledBack, true);
  assert.match(drillResult.error, /Process crashed on boot/);

  // Verify that source was automatically restored to stable v1.0.0
  const finalSource = fs.readFileSync(path.join(tempSource, "src", "index.mjs"), "utf8");
  assert.match(finalSource, /stable v1\.0\.0/);

  // Verify progression of events
  assert.equal(progressEvents.includes("CREATING_RUNTIME_BACKUP"), true);
  assert.equal(progressEvents.includes("ROLLBACK_INITIATED"), true);
} finally {
  fs.rmSync(tempSource, { recursive: true, force: true });
  fs.rmSync(tempRuns, { recursive: true, force: true });
  fs.rmSync(tempCandidate, { recursive: true, force: true });
}

console.log("updater-rollback.test.mjs: All tests passed!");
