import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { acquireDurableLease, durableLeasePath, beginInvocation, runDurableInvocation } from "../src/durable-runtime.mjs";
import { enqueueTaskJob, getJob, JOB_STATES, listJobs, updateJob } from "../src/job-queue.mjs";
import { clearFaultInjection, configureFaultInjection } from "../src/fault-injection.mjs";
import { getRun, RUN_STATES, updateRunExecution } from "../src/run-manager.mjs";
import { runProcess } from "../src/executor.mjs";

const execFileAsync = promisify(execFile);
const selfPath = fileURLToPath(import.meta.url);
const rounds = Math.max(1, Number(process.env.RELIABILITY_STRESS_ROUNDS || 5));

async function waitForGate(gatePath) {
  while (!fs.existsSync(gatePath)) await new Promise((resolve) => setTimeout(resolve, 2));
}

async function worker(mode, payload) {
  if (mode === "hold-invocation") {
    const handle = beginInvocation({
      runsRoot: payload.runsRoot,
      invocationId: payload.invocationId,
      runId: payload.runId,
      stage: "IMPLEMENTATION",
    });
    fs.writeFileSync(payload.readyPath, JSON.stringify({ started: handle.started }), "utf8");
    setInterval(() => {}, 1_000);
    return;
  }
  await waitForGate(payload.gatePath);
  if (mode === "enqueue") {
    const result = enqueueTaskJob({ runsRoot: payload.runsRoot, ...payload.job });
    process.stdout.write(JSON.stringify({ created: result.created, jobId: result.job.jobId }));
    return;
  }
  if (mode === "manifest") {
    const result = updateRunExecution({
      runsRoot: payload.runsRoot,
      runId: payload.runId,
      executionPatch: { [payload.field]: true },
      event: payload.event,
    });
    process.stdout.write(JSON.stringify({ revision: result.revision }));
    return;
  }
  throw new Error(`Unknown reliability worker: ${mode}`);
}

async function race(mode, payloads, gatePath) {
  const processes = payloads.map((payload) => execFileAsync(process.execPath, [
    selfPath,
    `--worker=${mode}`,
    Buffer.from(JSON.stringify({ ...payload, gatePath })).toString("base64url"),
  ]));
  await new Promise((resolve) => setTimeout(resolve, 40));
  fs.writeFileSync(gatePath, "go\n", "utf8");
  const results = await Promise.all(processes);
  return results.map((result) => JSON.parse(result.stdout));
}

function writeRun(runsRoot, runId) {
  const manifest = {
    schemaVersion: 1,
    revision: 0,
    runId,
    state: RUN_STATES.REVIEW,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    project: { id: "reliability-project", repository: runsRoot },
    task: { id: "REL-001", path: "tasks/rel-001.md", status: "REVIEW" },
    execution: {},
    history: [],
  };
  fs.writeFileSync(path.join(runsRoot, `${runId}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function main() {
  console.log(`Running reliability-faults.test.mjs (${rounds} stress rounds)...`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reliability-faults-"));
  try {
    // An existing-but-incomplete lease is never reclaimed as stale. This closes
    // the admission split caused by the create/write visibility window.
    const corruptRoot = path.join(root, "corrupt-lease");
    const corruptPath = durableLeasePath(corruptRoot, "job-admission", "project:task");
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, "", { mode: 0o600 });
    assert.throws(() => acquireDurableLease({
      runsRoot: corruptRoot,
      namespace: "job-admission",
      key: "project:task",
      purpose: "corrupt fixture",
      waitTimeoutMs: 0,
    }), (error) => error.code === "DURABLE_LEASE_CORRUPT");
    assert.equal(fs.existsSync(corruptPath), true);

    // Repeated eight-process admission and manifest races.
    for (let round = 0; round < rounds; round += 1) {
      const runsRoot = path.join(root, `race-${round}`);
      fs.mkdirSync(runsRoot, { recursive: true });
      const admissionResults = await race("enqueue", Array.from({ length: 8 }, () => ({
        runsRoot,
        job: {
          projectId: "race-project",
          taskId: "RACE-001",
          taskPath: "tasks/race-001.md",
          requestedBy: "reliability-test",
        },
      })), path.join(runsRoot, "admission-gate"));
      assert.equal(new Set(admissionResults.map((item) => item.jobId)).size, 1);
      assert.equal(admissionResults.filter((item) => item.created).length, 1);
      assert.equal(listJobs(runsRoot).length, 1);

      writeRun(runsRoot, "race-run");
      await race("manifest", [
        { runsRoot, runId: "race-run", field: "workerA", event: "WORKER_A" },
        { runsRoot, runId: "race-run", field: "workerB", event: "WORKER_B" },
      ], path.join(runsRoot, "manifest-gate"));
      const manifest = getRun(runsRoot, "race-run");
      assert.equal(manifest.execution.workerA, true);
      assert.equal(manifest.execution.workerB, true);
      assert.equal(manifest.history.filter((item) => ["WORKER_A", "WORKER_B"].includes(item.event)).length, 2);
    }

    // Queue disk-full before create leaves no partial job and releases admission.
    const queueRoot = path.join(root, "queue-fault");
    configureFaultInjection({ "queue.admission.before-create": { code: "ENOSPC" } });
    assert.throws(() => enqueueTaskJob({
      runsRoot: queueRoot, projectId: "fault-project", taskId: "FAULT-001", taskPath: "tasks/fault.md",
    }), (error) => error.injected && error.code === "ENOSPC");
    assert.equal(listJobs(queueRoot).length, 0);
    clearFaultInjection();
    const queued = enqueueTaskJob({
      runsRoot: queueRoot, projectId: "fault-project", taskId: "FAULT-001", taskPath: "tasks/fault.md",
    }).job;

    // Permission loss before queue rename preserves the prior durable record.
    configureFaultInjection({ "queue.write.before-rename": { code: "EACCES" } });
    assert.throws(() => updateJob(queueRoot, queued.jobId, { state: JOB_STATES.RUNNING }), (error) => error.code === "EACCES");
    assert.equal(getJob(queueRoot, queued.jobId).state, JOB_STATES.QUEUED);
    assert.equal(fs.readdirSync(path.join(queueRoot, "jobs")).some((name) => name.endsWith(".tmp")), false);
    clearFaultInjection();

    // Manifest rename failure preserves the old revision and is retryable.
    const manifestRoot = path.join(root, "manifest-fault");
    fs.mkdirSync(manifestRoot, { recursive: true });
    writeRun(manifestRoot, "fault-run");
    configureFaultInjection({ "manifest.write.before-rename": { code: "ENOSPC" } });
    assert.throws(() => updateRunExecution({
      runsRoot: manifestRoot, runId: "fault-run", executionPatch: { unsafe: true }, event: "FAULTED_WRITE",
    }), (error) => error.code === "ENOSPC");
    assert.equal(getRun(manifestRoot, "fault-run").revision, 0);
    assert.equal(getRun(manifestRoot, "fault-run").execution.unsafe, undefined);
    assert.equal(fs.readdirSync(manifestRoot).some((name) => name.endsWith(".tmp")), false);
    clearFaultInjection();
    assert.equal(updateRunExecution({
      runsRoot: manifestRoot, runId: "fault-run", executionPatch: { recovered: true }, event: "WRITE_RECOVERED",
    }).execution.recovered, true);

    // A ledger failure after a side effect records FAILED and blocks replay.
    const invocationRoot = path.join(root, "invocation-fault");
    let sideEffects = 0;
    configureFaultInjection({ "durable.write.before-rename": { code: "EIO" } });
    await assert.rejects(runDurableInvocation({
      runsRoot: invocationRoot,
      invocationId: "fault-run:implementation",
      runId: "fault-run",
      stage: "IMPLEMENTATION",
      execute: async () => { sideEffects += 1; return { exitCode: 0 }; },
    }), (error) => error.code === "EIO");
    clearFaultInjection();
    await assert.rejects(runDurableInvocation({
      runsRoot: invocationRoot,
      invocationId: "fault-run:implementation",
      runId: "fault-run",
      stage: "IMPLEMENTATION",
      execute: async () => { sideEffects += 1; return { exitCode: 0 }; },
    }), /tidak dijalankan ulang/);
    assert.equal(sideEffects, 1);
    const ledger = beginInvocation({ runsRoot: invocationRoot, invocationId: "fault-run:implementation", runId: "fault-run", stage: "IMPLEMENTATION" });
    assert.equal(ledger.record.status, "FAILED");

    // A real SIGKILL leaves an uncertain invocation that restart reconciliation
    // marks INTERRUPTED and never replays automatically.
    const killedRoot = path.join(root, "killed-invocation");
    const readyPath = path.join(killedRoot, "ready.json");
    fs.mkdirSync(killedRoot, { recursive: true });
    const killedPayload = Buffer.from(JSON.stringify({
      runsRoot: killedRoot,
      invocationId: "killed-run:implementation",
      runId: "killed-run",
      readyPath,
      gatePath: path.join(killedRoot, "unused-gate"),
    })).toString("base64url");
    const killedWorker = spawn(process.execPath, [selfPath, "--worker=hold-invocation", killedPayload], { stdio: "ignore" });
    while (!fs.existsSync(readyPath)) await new Promise((resolve) => setTimeout(resolve, 5));
    killedWorker.kill("SIGKILL");
    await new Promise((resolve) => killedWorker.once("close", resolve));
    let killedSideEffects = 0;
    await assert.rejects(runDurableInvocation({
      runsRoot: killedRoot,
      invocationId: "killed-run:implementation",
      runId: "killed-run",
      stage: "IMPLEMENTATION",
      execute: async () => { killedSideEffects += 1; return { exitCode: 0 }; },
    }), /tidak dijalankan ulang/);
    assert.equal(killedSideEffects, 0);
    assert.equal(beginInvocation({
      runsRoot: killedRoot,
      invocationId: "killed-run:implementation",
      runId: "killed-run",
      stage: "IMPLEMENTATION",
    }).record.status, "INTERRUPTED");

    // Deadline termination kills the normal descendant process group.
    const processRoot = path.join(root, "process-timeout");
    fs.mkdirSync(processRoot, { recursive: true });
    const lateWrite = path.join(processRoot, "late-write.txt");
    const childScript = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(lateWrite)},'escaped'),500);setInterval(()=>{},1000)`;
    const parentScript = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const timeoutResult = await runProcess({
      command: process.execPath,
      args: ["-e", parentScript],
      cwd: processRoot,
      stage: "verification:timeout-fixture",
      deadlineMs: 120,
      maxOutputBytes: 10_000,
    });
    assert.equal(timeoutResult.terminatedReason, "deadline");
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(fs.existsSync(lateWrite), false);

    // Output flood is bounded and terminates with an explicit reason.
    const outputResult = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>process.stdout.write('x'.repeat(4096)+'\\n'),1)"],
      cwd: processRoot,
      stage: "verification:output-fixture",
      deadlineMs: 5_000,
      maxOutputBytes: 16_384,
    });
    assert.equal(outputResult.terminatedReason, "output_limit");
    assert.ok(outputResult.stdoutTail.length <= 50_000);
  } finally {
    clearFaultInjection();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`reliability-faults.test.mjs: PASS (${rounds} rounds, zero duplicate admission)`);
}

const workerArgument = process.argv.find((argument) => argument.startsWith("--worker="));
if (workerArgument) {
  await worker(workerArgument.slice("--worker=".length), JSON.parse(Buffer.from(process.argv.at(-1), "base64url").toString("utf8")));
} else {
  await main();
}
