import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevServerManager, devServerEnvironment } from "../src/dev-server-manager.mjs";

console.log("Running dev-server-manager.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-server-manager-"));
const runsRoot = path.join(root, "runs");
const failedRepository = path.join(root, "failed-repository");
const healthyRepository = path.join(root, "healthy-repository");
fs.mkdirSync(failedRepository, { recursive: true });
fs.mkdirSync(healthyRepository, { recursive: true });
fs.writeFileSync(path.join(failedRepository, "package.json"), JSON.stringify({ scripts: { dev: "node -e \"console.error('missing module fixture'); process.exit(1)\"" } }));
fs.writeFileSync(path.join(healthyRepository, "package.json"), JSON.stringify({ scripts: { dev: "node -e \"require('http').createServer((_, res) => res.end('ok')).listen(process.env.PORT, '127.0.0.1')\" --" } }));

const manager = new DevServerManager();
assert.equal(devServerEnvironment(runsRoot, { ORCHESTRATOR_RUNS: "/tmp/incorrect-runs" }).ORCHESTRATOR_RUNS, path.resolve(runsRoot));
try {
  await assert.rejects(
    () => manager.startDevServer({ runsRoot, runId: "failed-run", projectId: "fixture-app", repository: failedRepository }),
    (error) => {
      assert.equal(error.code, "DEV_SERVER_STARTUP_FAILED");
      assert.equal(error.details.category, "APPLICATION_STARTUP_ERROR");
      assert.equal(error.details.runId, "failed-run");
      assert.match(error.details.logTail, /missing module fixture/);
      assert.match(error.details.command, /npm run dev/);
      return true;
    },
  );
  assert.equal(manager.servers.size, 0);
  const failedStatus = manager.getDevServerStatus("failed-run");
  assert.equal(failedStatus.status, "STOPPED");
  assert.equal(failedStatus.lastFailure.category, "APPLICATION_STARTUP_ERROR");

  await assert.rejects(() => manager.startDevServer({ runsRoot, runId: "failed-run", projectId: "fixture-app", repository: failedRepository }), /missing module fixture|berhenti saat startup/);
  assert.equal(manager.servers.size, 0);

  const started = await manager.startDevServer({ runsRoot, runId: "healthy-run", projectId: "fixture-app", repository: healthyRepository });
  assert.equal(started.status, "RUNNING");
  const reused = await manager.startDevServer({ runsRoot, runId: "healthy-run", projectId: "fixture-app", repository: healthyRepository });
  assert.equal(reused.port, started.port);
  assert.equal(manager.getDevServerStatus("healthy-run").running, true);
  manager.stopDevServer("healthy-run");
} finally {
  manager.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("dev-server-manager.test.mjs: All tests passed!");
