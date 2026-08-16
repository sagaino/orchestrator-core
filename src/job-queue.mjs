import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const JOB_STATES = Object.freeze({
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  REVIEW: "REVIEW",
  DONE: "DONE",
  FAILED: "FAILED",
});

function jobsRoot(runsRoot) {
  return path.join(runsRoot, "jobs");
}

function safeJobId(jobId) {
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) throw new Error(`Job ID tidak valid: ${jobId}`);
  return jobId;
}

function jobPath(runsRoot, jobId) {
  return path.join(jobsRoot(runsRoot), `${safeJobId(jobId)}.json`);
}

import { validateJob } from "./schema.mjs";

function writeAtomic(filePath, value) {
  const validation = validateJob(value);
  if (!validation.valid) {
    throw new Error(`Job schema invalid: ${validation.errors.join(", ")}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

export function listJobs(runsRoot) {
  const root = jobsRoot(runsRoot);
  if (!fs.existsSync(root)) return [];
  const jobs = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
      if (validateJob(job).valid) {
        jobs.push(job);
      }
    } catch {}
  }
  return jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function getJob(runsRoot, jobId) {
  const filePath = jobPath(runsRoot, jobId);
  if (!fs.existsSync(filePath)) throw new Error(`Job tidak ditemukan: ${jobId}`);
  const job = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const validation = validateJob(job);
  if (!validation.valid) {
    throw new Error(`Corrupted job ${jobId}: ${validation.errors.join(", ")}`);
  }
  return job;
}

export function enqueueTaskJob({
  runsRoot,
  projectId,
  taskId,
  taskPath,
  requestedBy = "user",
  intakeTelemetry = null,
}) {
  const duplicate = listJobs(runsRoot).find((job) => (
    job.projectId === projectId
    && job.taskId === taskId
    && [JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job.state)
  ));
  if (duplicate) return { created: false, job: duplicate };

  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const jobId = `${String(taskId).toLowerCase()}-${stamp}-${randomUUID().slice(0, 8)}`;
  const job = {
    schemaVersion: 1,
    jobId,
    state: JOB_STATES.QUEUED,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    projectId,
    taskId,
    taskPath,
    requestedBy: String(requestedBy).trim() || "user",
    intakeTelemetry,
    runId: null,
    runState: null,
    error: null,
  };
  const filePath = jobPath(runsRoot, jobId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { created: true, job };
}

export function updateJob(runsRoot, jobId, patch) {
  const job = getJob(runsRoot, jobId);
  const updated = { ...job, ...patch, updatedAt: new Date().toISOString() };
  writeAtomic(jobPath(runsRoot, jobId), updated);
  return updated;
}

export function reservedProjectIds(runsRoot) {
  return [...new Set(
    listJobs(runsRoot)
      .filter((job) => [JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job.state))
      .map((job) => job.projectId),
  )].sort();
}

export function claimNextJob(runsRoot, { blockedProjectIds = [] } = {}) {
  const jobs = listJobs(runsRoot);
  const reserved = new Set([
    ...jobs
      .filter((job) => [JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job.state))
      .map((job) => job.projectId),
    ...blockedProjectIds,
  ]);
  const queued = jobs
    .filter((job) => job.state === JOB_STATES.QUEUED)
    .filter((job) => !reserved.has(job.projectId))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  if (!queued.length) return null;
  return updateJob(runsRoot, queued[0].jobId, {
    state: JOB_STATES.RUNNING,
    startedAt: new Date().toISOString(),
    scheduling: {
      strategy: "PARALLEL_DISTINCT_PROJECTS",
      projectExclusive: true,
    },
  });
}

export function updateJobForRun(runsRoot, runId, patch) {
  const job = listJobs(runsRoot).find((item) => item.runId === runId);
  return job ? updateJob(runsRoot, job.jobId, patch) : null;
}

export function reconcileJobs(runsRoot, runs) {
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const reconciled = [];
  for (const job of listJobs(runsRoot)) {
    if (![JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(job.state)) continue;
    const run = job.runId ? runsById.get(job.runId) : null;
    let patch = null;

    if (!run && job.state === JOB_STATES.RUNNING) {
      patch = { state: JOB_STATES.QUEUED, error: null, recovery: "REQUEUED_BEFORE_RUN_CREATED" };
    } else if (run?.state === "DONE") {
      patch = { state: JOB_STATES.DONE, runState: run.state, recovery: "RECONCILED_FROM_RUN" };
    } else if (run?.state === "FAILED") {
      patch = {
        state: JOB_STATES.FAILED,
        runState: run.state,
        error: run.execution?.result?.error ?? "Run gagal sebelum daemon restart.",
        recovery: "RECONCILED_FROM_RUN",
      };
    } else if (["REVIEW", "RETROSPECTIVE", "KNOWLEDGE_APPROVAL", "WIKI_SYNCED"].includes(run?.state)) {
      patch = { state: JOB_STATES.REVIEW, runState: run.state, recovery: "RECONCILED_FROM_RUN" };
    } else if (["PENDING_APPROVAL", "APPROVED"].includes(run?.state)) {
      patch = { state: JOB_STATES.QUEUED, runState: run.state, recovery: "REQUEUED_SAFE_PRE_EXECUTION" };
    } else if (run && job.state === JOB_STATES.RUNNING) {
      patch = {
        state: JOB_STATES.FAILED,
        runState: run.state,
        error: `Daemon restart terjadi saat run ${run.state}; worktree harus direview sebelum recovery.`,
        recovery: "MANUAL_REVIEW_REQUIRED",
      };
    }

    if (patch) reconciled.push(updateJob(runsRoot, job.jobId, patch));
  }
  return reconciled;
}
