import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireDurableLease,
  DurableLeaseError,
  readDurableLease,
  releaseDurableLease,
  releaseDurableLeaseByOwner,
  runtimeOwnerAlive,
  withDurableLease,
} from "./durable-runtime.mjs";
import { redactSensitive } from "./redaction.mjs";
import { injectFault } from "./fault-injection.mjs";

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
  if (!/^[A-Za-z0-9._-]+$/.test(jobId) || [".", ".."].includes(jobId)) throw new Error(`Job ID tidak valid: ${jobId}`);
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
  try {
    injectFault("queue.write.before-temp", { filePath, jobId: value.jobId });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(redactSensitive(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    injectFault("queue.write.before-rename", { filePath, jobId: value.jobId });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

const PROJECT_RESERVATION_NAMESPACE = "project-reservations";
const JOB_EXECUTION_NAMESPACE = "job-executions";

function activeJobState(state) {
  return [JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(state);
}

function releaseJobExecutionLease(runsRoot, job) {
  return releaseDurableLeaseByOwner({
    runsRoot,
    namespace: JOB_EXECUTION_NAMESPACE,
    key: job.jobId,
    predicate: (lease) => lease.metadata?.jobId === job.jobId,
  });
}

function releaseProjectReservation(runsRoot, job) {
  return releaseDurableLeaseByOwner({
    runsRoot,
    namespace: PROJECT_RESERVATION_NAMESPACE,
    key: job.projectId,
    predicate: (lease) => lease.metadata?.jobId === job.jobId,
  });
}

function releaseInactiveProjectReservation(runsRoot, projectId) {
  const current = readDurableLease(runsRoot, PROJECT_RESERVATION_NAMESPACE, projectId);
  if (!current) return false;
  let ownerJob = null;
  try { ownerJob = getJob(runsRoot, current.metadata?.jobId); } catch {}
  if ((ownerJob && activeJobState(ownerJob.state)) || runtimeOwnerAlive(current.owner)) return false;
  return releaseDurableLeaseByOwner({
    runsRoot,
    namespace: PROJECT_RESERVATION_NAMESPACE,
    key: projectId,
    predicate: (latest) => latest.leaseId === current.leaseId,
  });
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
  return withDurableLease({
    runsRoot,
    namespace: "job-admission",
    key: `${projectId}:${taskId}`,
    purpose: `job admission ${projectId}/${taskId}`,
    ttlMs: 60_000,
    waitTimeoutMs: 2_000,
  }, () => {
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
      schemaVersion: 2,
      revision: 0,
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
      claim: null,
    };
    const filePath = jobPath(runsRoot, jobId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    injectFault("queue.admission.before-create", { filePath, projectId, taskId, jobId });
    fs.writeFileSync(filePath, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { created: true, job };
  });
}

export function updateJob(runsRoot, jobId, patch) {
  const updated = withDurableLease({
    runsRoot,
    namespace: "job-mutations",
    key: jobId,
    purpose: `job mutation ${jobId}`,
    ttlMs: 60_000,
    waitTimeoutMs: 2_000,
  }, () => {
    const job = getJob(runsRoot, jobId);
    const next = {
      ...job,
      ...patch,
      schemaVersion: Math.max(2, Number(job.schemaVersion || 1)),
      revision: Number(job.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    writeAtomic(jobPath(runsRoot, jobId), next);
    return next;
  });
  if (updated.state !== JOB_STATES.RUNNING) releaseJobExecutionLease(runsRoot, updated);
  if (![JOB_STATES.RUNNING, JOB_STATES.REVIEW].includes(updated.state)) releaseProjectReservation(runsRoot, updated);
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
  for (const candidate of queued) {
    releaseInactiveProjectReservation(runsRoot, candidate.projectId);
    let projectLease = null;
    let executionLease = null;
    try {
      projectLease = acquireDurableLease({
        runsRoot,
        namespace: PROJECT_RESERVATION_NAMESPACE,
        key: candidate.projectId,
        purpose: `project reservation ${candidate.projectId}`,
        metadata: { jobId: candidate.jobId, projectId: candidate.projectId },
        ttlMs: null,
        reclaimDeadOwner: false,
      });

      const conflicting = listJobs(runsRoot).find((job) => (
        job.jobId !== candidate.jobId
        && job.projectId === candidate.projectId
        && activeJobState(job.state)
      ));
      const latest = getJob(runsRoot, candidate.jobId);
      if (conflicting || latest.state !== JOB_STATES.QUEUED) {
        releaseDurableLease(projectLease);
        continue;
      }

      executionLease = acquireDurableLease({
        runsRoot,
        namespace: JOB_EXECUTION_NAMESPACE,
        key: candidate.jobId,
        purpose: `job execution ${candidate.jobId}`,
        metadata: { jobId: candidate.jobId, projectId: candidate.projectId },
        ttlMs: null,
      });
      const claimedAt = new Date().toISOString();
      return updateJob(runsRoot, candidate.jobId, {
        state: JOB_STATES.RUNNING,
        startedAt: latest.startedAt ?? claimedAt,
        error: null,
        claim: {
          claimId: executionLease.record.leaseId,
          claimedAt,
          owner: executionLease.record.owner,
          projectReservationId: projectLease.record.leaseId,
        },
        scheduling: {
          strategy: "PARALLEL_DISTINCT_PROJECTS",
          projectExclusive: true,
          durable: true,
        },
      });
    } catch (error) {
      if (executionLease) releaseDurableLease(executionLease);
      if (projectLease) releaseDurableLease(projectLease);
      if (error instanceof DurableLeaseError || error.code === "DURABLE_LEASE_HELD") continue;
      throw error;
    }
  }
  return null;
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
    } else if (run?.state === "CLAIMED") {
      patch = {
        state: JOB_STATES.QUEUED,
        runState: run.state,
        resumeRunId: run.runId,
        error: null,
        recovery: "REQUEUED_SAFE_BEFORE_AGENT",
      };
    } else if (["PENDING_APPROVAL", "APPROVED"].includes(run?.state)) {
      patch = {
        state: JOB_STATES.QUEUED,
        runState: run.state,
        resumeRunId: null,
        recovery: "REQUEUED_SAFE_PRE_EXECUTION",
      };
    } else if (run && job.state === JOB_STATES.RUNNING && runtimeOwnerAlive(run.execution?.runtimeOwner)) {
      patch = null;
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

export function hasActiveJobs(runsRoot) {
  const jobs = listJobs(runsRoot);
  return jobs.some((job) => [JOB_STATES.QUEUED, JOB_STATES.RUNNING].includes(job.state));
}
