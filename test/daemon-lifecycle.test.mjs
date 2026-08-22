import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { daemonStatus } from "../src/daemon.mjs";

console.log("Running daemon-lifecycle.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-daemon-lifecycle-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const cliPath = path.resolve("src/orchestrator.mjs");

function startWorker() {
  return spawn(process.execPath, [cliPath, "daemon-worker", "--vault", vaultRoot, "--runs", runsRoot], {
    cwd: path.resolve("."),
    env: { ...process.env, ORCHESTRATOR_API_PORT: "0", ORCHESTRATOR_ENFORCE_OPERATIONS_GUARD: "0", ORCHESTRATOR_SHUTDOWN_DRAIN_TIMEOUT_MS: "1000" },
    stdio: "ignore",
  });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for daemon lifecycle state.");
}

async function stopWorker(child) {
  child.kill("SIGTERM");
  const result = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 0);
}

try {
  fs.mkdirSync(path.join(vaultRoot, "02-Projects"), { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });

  const first = startWorker();
  await waitFor(() => daemonStatus({ runsRoot }).running === true);
  assert.equal(daemonStatus({ runsRoot }).restartReconciliation?.status, "COMPLETE");
  await stopWorker(first);
  const firstLog = fs.readFileSync(path.join(runsRoot, "daemon", "daemon.jsonl"), "utf8");
  assert.match(firstLog, /SHUTDOWN_DRAINED/);

  const second = startWorker();
  await waitFor(() => daemonStatus({ runsRoot }).running === true);
  const restarted = daemonStatus({ runsRoot });
  assert.equal(restarted.restartReconciliation?.status, "COMPLETE");
  assert.equal(restarted.restartReconciliation?.runs, 0);
  assert.equal(restarted.restartReconciliation?.jobs, 0);
  await stopWorker(second);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("daemon-lifecycle.test.mjs passed");
