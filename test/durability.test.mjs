import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  claimNextJob,
  enqueueTaskJob,
  getJob,
  JOB_STATES,
  listJobs,
  reconcileJobs,
  updateJob,
} from "../src/job-queue.mjs";
import { beginInvocation, runDurableInvocation } from "../src/durable-runtime.mjs";
import { processClaimedJob } from "../src/daemon.mjs";
import { getRun, reconcileInterruptedRuns, RUN_STATES, updateRunExecution } from "../src/run-manager.mjs";
import { buildRunEvidence } from "../src/interaction.mjs";

const execFileAsync = promisify(execFile);
const selfPath = fileURLToPath(import.meta.url);

function decodePayload(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function waitForGate(gatePath) {
  while (!fs.existsSync(gatePath)) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function workerMain(mode, payload) {
  await waitForGate(payload.gatePath);
  if (mode === "claim") {
    const job = claimNextJob(payload.runsRoot);
    process.stdout.write(JSON.stringify({ jobId: job?.jobId ?? null }));
    return;
  }
  if (mode === "enqueue") {
    const result = enqueueTaskJob({ runsRoot: payload.runsRoot, ...payload.job });
    process.stdout.write(JSON.stringify({ created: result.created, jobId: result.job.jobId }));
    return;
  }
  if (mode === "invoke") {
    const result = await runDurableInvocation({
      runsRoot: payload.runsRoot,
      invocationId: payload.invocationId,
      runId: payload.runId,
      stage: "TEST",
      execute: async () => {
        fs.appendFileSync(payload.sideEffectPath, "executed\n", "utf8");
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { exitCode: 0, stdoutTail: "ok", stderrTail: "", finalResult: { ok: true } };
      },
    });
    process.stdout.write(JSON.stringify({ ok: true, replayed: result.durableReplay === true }));
    return;
  }
  if (mode === "orphan-invocation") {
    const handle = beginInvocation({
      runsRoot: payload.runsRoot,
      invocationId: payload.invocationId,
      runId: payload.runId,
      stage: "TEST_ORPHAN",
    });
    process.stdout.write(JSON.stringify({ started: handle.started }));
    return;
  }
  if (mode === "update-run") {
    const result = updateRunExecution({
      runsRoot: payload.runsRoot,
      runId: payload.runId,
      executionPatch: payload.patch,
      event: payload.event,
    });
    process.stdout.write(JSON.stringify({ revision: result.revision }));
    return;
  }
  throw new Error(`Unknown worker mode: ${mode}`);
}

async function runWorkers(mode, count, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const workers = Array.from({ length: count }, () => execFileAsync(process.execPath, [selfPath, `--worker=${mode}`, encoded]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(payload.gatePath, "go\n", "utf8");
  const settled = await Promise.allSettled(workers);
  return settled.map((item) => {
    if (item.status === "rejected") return { ok: false, error: item.reason.stderr || item.reason.message };
    try { return { ok: true, ...JSON.parse(item.value.stdout) }; }
    catch { return { ok: false, error: item.value.stdout || item.value.stderr }; }
  });
}

function enqueue(runsRoot, projectId, taskId) {
  return enqueueTaskJob({
    runsRoot,
    projectId,
    taskId,
    taskPath: `02-Projects/${projectId}/tasks/${taskId.toLowerCase()}.md`,
    requestedBy: "durability-test",
  }).job;
}

function writeTask(vaultRoot, projectId, taskId, status) {
  const relativePath = `02-Projects/${projectId}/tasks/${taskId.toLowerCase()}.md`;
  const absolutePath = path.join(vaultRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `---\ntask_id: ${taskId}\nstatus: ${status}\nupdated: 2026-08-22\n---\n# ${taskId}\n`, "utf8");
  return relativePath;
}

function writeRun({ runsRoot, vaultRoot, runId, projectId, taskId, state, taskStatus, owner = null }) {
  const taskPath = writeTask(vaultRoot, projectId, taskId, taskStatus);
  const repository = path.join(vaultRoot, "repositories", projectId);
  fs.mkdirSync(repository, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    revision: 0,
    runId,
    state,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    project: { id: projectId, repository },
    task: { id: taskId, path: taskPath, status: taskStatus },
    execution: {
      claimedAt: "2026-08-22T00:00:00.000Z",
      startedAt: "2026-08-22T00:00:01.000Z",
      finishedAt: null,
      result: null,
      ...(owner ? { runtimeOwner: owner } : {}),
    },
    history: [],
  };
  fs.writeFileSync(path.join(runsRoot, `${runId}.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function testMain() {
  console.log("Running durability.test.mjs...");

  // Atomic admission: concurrent callers converge on one durable job.
  const admissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-admission-"));
  try {
    const gatePath = path.join(admissionRoot, "gate");
    const results = await runWorkers("enqueue", 8, {
      runsRoot: admissionRoot,
      gatePath,
      job: {
        projectId: "project-a",
        taskId: "TASK-001",
        taskPath: "02-Projects/project-a/tasks/task-001.md",
        requestedBy: "concurrency-test",
      },
    });
    assert.equal(results.filter((item) => item.ok).length, 8);
    assert.equal(new Set(results.map((item) => item.jobId)).size, 1);
    assert.equal(results.filter((item) => item.created).length, 1);
    assert.equal(listJobs(admissionRoot).length, 1);
  } finally {
    fs.rmSync(admissionRoot, { recursive: true, force: true });
  }

  // Eight processes race for one job; only one may claim it.
  const claimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-claim-"));
  try {
    const job = enqueue(claimRoot, "project-a", "TASK-CLAIM");
    const gatePath = path.join(claimRoot, "gate");
    const results = await runWorkers("claim", 8, { runsRoot: claimRoot, gatePath });
    assert.equal(results.filter((item) => item.ok && item.jobId === job.jobId).length, 1);
    assert.equal(results.filter((item) => item.ok && item.jobId === null).length, 7);
    assert.equal(getJob(claimRoot, job.jobId).state, JOB_STATES.RUNNING);
  } finally {
    fs.rmSync(claimRoot, { recursive: true, force: true });
  }

  // Project reservation blocks a second task in the same project, while distinct projects run in parallel.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-project-"));
  try {
    enqueue(projectRoot, "same-project", "TASK-A");
    enqueue(projectRoot, "same-project", "TASK-B");
    let gatePath = path.join(projectRoot, "gate-same");
    let results = await runWorkers("claim", 4, { runsRoot: projectRoot, gatePath });
    assert.equal(results.filter((item) => item.ok && item.jobId).length, 1);
    assert.equal(listJobs(projectRoot).filter((job) => job.state === JOB_STATES.QUEUED).length, 1);

    const parallelRoot = path.join(projectRoot, "parallel");
    fs.mkdirSync(parallelRoot);
    enqueue(parallelRoot, "project-a", "TASK-A");
    enqueue(parallelRoot, "project-b", "TASK-B");
    gatePath = path.join(parallelRoot, "gate");
    results = await runWorkers("claim", 4, { runsRoot: parallelRoot, gatePath });
    assert.equal(results.filter((item) => item.ok && item.jobId).length, 2);
    assert.equal(listJobs(parallelRoot).filter((job) => job.state === JOB_STATES.RUNNING).length, 2);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  // A stable invocation identity allows exactly one side effect and durable replay of its result.
  const invocationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-invocation-"));
  try {
    const gatePath = path.join(invocationRoot, "gate");
    const sideEffectPath = path.join(invocationRoot, "side-effects.log");
    const invocationId = "run-1:implementation";
    await runWorkers("invoke", 8, {
      runsRoot: invocationRoot,
      gatePath,
      sideEffectPath,
      invocationId,
      runId: "run-1",
    });
    const executions = fs.readFileSync(sideEffectPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(executions.length, 1);
    let replayExecuted = false;
    const replay = await runDurableInvocation({
      runsRoot: invocationRoot,
      invocationId,
      runId: "run-1",
      stage: "TEST",
      execute: async () => {
        replayExecuted = true;
        return { exitCode: 0 };
      },
    });
    assert.equal(replay.durableReplay, true);
    assert.equal(replayExecuted, false);

    const orphanGate = path.join(invocationRoot, "orphan-gate");
    const orphanId = "run-2:implementation";
    const orphan = await runWorkers("orphan-invocation", 1, {
      runsRoot: invocationRoot,
      gatePath: orphanGate,
      invocationId: orphanId,
      runId: "run-2",
    });
    assert.equal(orphan[0].started, true);
    let uncertainExecuted = false;
    await assert.rejects(
      runDurableInvocation({
        runsRoot: invocationRoot,
        invocationId: orphanId,
        runId: "run-2",
        stage: "TEST_ORPHAN",
        execute: async () => { uncertainExecuted = true; },
      }),
      /tidak dijalankan ulang/,
    );
    assert.equal(uncertainExecuted, false);
  } finally {
    fs.rmSync(invocationRoot, { recursive: true, force: true });
  }

  // Concurrent non-state manifest updates merge through revision retry instead of silently overwriting.
  const revisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-revision-"));
  try {
    const vaultRoot = path.join(revisionRoot, "vault");
    const runsRoot = path.join(revisionRoot, "runs");
    fs.mkdirSync(vaultRoot);
    fs.mkdirSync(runsRoot);
    writeRun({
      runsRoot,
      vaultRoot,
      runId: "revision-run",
      projectId: "revision-project",
      taskId: "REV-001",
      state: RUN_STATES.REVIEW,
      taskStatus: "REVIEW",
    });
    const gatePath = path.join(revisionRoot, "gate");
    const payloads = [
      { patch: { workerA: true }, event: "WORKER_A" },
      { patch: { workerB: true }, event: "WORKER_B" },
    ];
    const workers = payloads.map((payload) => execFileAsync(process.execPath, [
      selfPath,
      "--worker=update-run",
      Buffer.from(JSON.stringify({ runsRoot, gatePath, runId: "revision-run", ...payload })).toString("base64url"),
    ]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(gatePath, "go\n", "utf8");
    await Promise.all(workers);
    const updated = getRun(runsRoot, "revision-run");
    assert.equal(updated.execution.workerA, true);
    assert.equal(updated.execution.workerB, true);
    assert.equal(updated.history.filter((item) => ["WORKER_A", "WORKER_B"].includes(item.event)).length, 2);
  } finally {
    fs.rmSync(revisionRoot, { recursive: true, force: true });
  }

  // Restart reconciliation preserves REVIEW/QUEUED, resumes pre-agent CLAIMED, and fails uncertain execution safely.
  const restartRoot = fs.mkdtempSync(path.join(os.tmpdir(), "durable-restart-"));
  try {
    const vaultRoot = path.join(restartRoot, "vault");
    const runsRoot = path.join(restartRoot, "runs");
    fs.mkdirSync(vaultRoot);
    fs.mkdirSync(runsRoot);
    const deadOwner = { instanceId: "dead", pid: 999_999_999, hostname: os.hostname(), startedAt: "2026-08-22T00:00:00.000Z" };
    const fixtures = [
      ["claimed-run", "claimed-project", "CLAIM-001", RUN_STATES.CLAIMED, "IN_PROGRESS", null],
      ["running-run", "running-project", "RUN-001", RUN_STATES.RUNNING, "IN_PROGRESS", deadOwner],
      ["verifying-run", "verifying-project", "VERIFY-001", RUN_STATES.VERIFYING, "IN_PROGRESS", deadOwner],
      ["review-run", "review-project", "REVIEW-001", RUN_STATES.REVIEW, "REVIEW", null],
    ];
    const jobs = new Map();
    for (const [runId, projectId, taskId, state, taskStatus, owner] of fixtures) {
      writeRun({ runsRoot, vaultRoot, runId, projectId, taskId, state, taskStatus, owner });
      const job = enqueue(runsRoot, projectId, taskId);
      jobs.set(runId, updateJob(runsRoot, job.jobId, {
        state: state === RUN_STATES.REVIEW ? JOB_STATES.REVIEW : JOB_STATES.RUNNING,
        runId,
        runState: state,
      }));
    }
    const queuedJob = enqueue(runsRoot, "queued-project", "QUEUE-001");

    const runRecovery = reconcileInterruptedRuns({ vaultRoot, runsRoot });
    assert.equal(runRecovery.find((item) => item.runId === "claimed-run").action, "SAFE_TO_RESUME_BEFORE_AGENT");
    assert.equal(getRun(runsRoot, "claimed-run").state, RUN_STATES.CLAIMED);
    assert.equal(getRun(runsRoot, "running-run").state, RUN_STATES.FAILED);
    assert.equal(getRun(runsRoot, "verifying-run").state, RUN_STATES.FAILED);
    assert.equal(getRun(runsRoot, "review-run").state, RUN_STATES.REVIEW);
    const claimedEvidence = buildRunEvidence(getRun(runsRoot, "claimed-run"));
    assert.equal(claimedEvidence.restart.status, "RECONCILED");
    assert.equal(claimedEvidence.restart.action, "SAFE_TO_RESUME_BEFORE_AGENT");
    assert.match(claimedEvidence.nextAction, /aman/);
    const interruptedEvidence = buildRunEvidence(getRun(runsRoot, "running-run"));
    assert.equal(interruptedEvidence.restart.status, "MANUAL_RECOVERY_REQUIRED");
    assert.equal(interruptedEvidence.restart.previousState, RUN_STATES.RUNNING);
    assert.match(interruptedEvidence.nextAction, /recover atau retry/);

    reconcileJobs(runsRoot, [
      getRun(runsRoot, "claimed-run"),
      getRun(runsRoot, "running-run"),
      getRun(runsRoot, "verifying-run"),
      getRun(runsRoot, "review-run"),
    ]);
    const claimedJob = getJob(runsRoot, jobs.get("claimed-run").jobId);
    assert.equal(claimedJob.state, JOB_STATES.QUEUED);
    assert.equal(claimedJob.resumeRunId, "claimed-run");
    assert.equal(getJob(runsRoot, jobs.get("running-run").jobId).state, JOB_STATES.FAILED);
    assert.equal(getJob(runsRoot, jobs.get("verifying-run").jobId).state, JOB_STATES.FAILED);
    assert.equal(getJob(runsRoot, jobs.get("review-run").jobId).state, JOB_STATES.REVIEW);
    assert.equal(getJob(runsRoot, queuedJob.jobId).state, JOB_STATES.QUEUED);

    const resumedClaim = claimNextJob(runsRoot);
    assert.equal(resumedClaim.jobId, claimedJob.jobId);
    let resumeCalls = 0;
    const resumed = await processClaimedJob({
      vaultRoot,
      runsRoot,
      job: resumedClaim,
      services: {},
      resumeWorkflow: async ({ runId }) => {
        resumeCalls += 1;
        assert.equal(runId, "claimed-run");
        return { ...getRun(runsRoot, runId), state: RUN_STATES.RETROSPECTIVE };
      },
      notifier: async () => ({ created: false, notification: null }),
    });
    assert.equal(resumeCalls, 1);
    assert.equal(resumed.job.state, JOB_STATES.REVIEW);
  } finally {
    fs.rmSync(restartRoot, { recursive: true, force: true });
  }

  console.log("durability.test.mjs: All tests passed!");
}

const workerArgument = process.argv.find((item) => item.startsWith("--worker="));
if (workerArgument) {
  await workerMain(workerArgument.slice("--worker=".length), decodePayload(process.argv.at(-1)));
} else {
  await testMain();
}
