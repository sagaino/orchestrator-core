import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevServerManager, isPortAvailable } from "../src/dev-server-manager.mjs";
import { createAggregatePreviewEvidence, listAggregatePreviewEvidence, persistAggregatePreviewEvidence } from "../src/visual-evidence.mjs";

console.log("Running aggregate-project-preview.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-project-preview-"));
const runsRoot = path.join(root, "runs");
const goodProject = path.join(root, "good-project");
const unavailableProject = path.join(root, "unavailable-project");
fs.mkdirSync(runsRoot, { recursive: true });

function writeProject(directory, scripts, server = false) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: path.basename(directory), scripts }));
  if (server) fs.writeFileSync(path.join(directory, "server.mjs"), [
    "import http from 'node:http';",
    "const args = process.argv.slice(2);",
    "const port = Number(args[args.indexOf('--port') + 1]);",
    "const host = args[args.indexOf('--host') + 1] || '127.0.0.1';",
    "http.createServer((_req, res) => { res.end('preview fixture'); }).listen(port, host);",
  ].join("\n"));
}

writeProject(goodProject, { dev: "node server.mjs" }, true);
writeProject(unavailableProject, { dev: "node -e \"process.exit(1)\"" });

const manager = new DevServerManager();
try {
  const preview = await manager.startAggregateProjectPreview({
    runsRoot,
    objectiveId: "objective-preview-fixture",
    candidates: [
      { projectId: "good-project", runId: "run-good", repository: goodProject },
      { projectId: "unavailable-project", runId: "run-unavailable", repository: unavailableProject },
      { projectId: "good-project", runId: "run-duplicate", repository: goodProject },
    ],
    maxProjects: 4,
    maxServers: 4,
    maxDurationMs: 5_000,
  });

  assert.equal(preview.status, "PARTIAL");
  assert.equal(preview.previews.length, 1);
  assert.equal(preview.previews[0].projectId, "good-project");
  assert.match(preview.previews[0].url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(preview.unavailable.length, 1);
  assert.equal(preview.unavailable[0].reason, "DEV_SERVER_UNAVAILABLE");
  assert.equal(preview.unavailable[0].verification.status, "NOT_EVALUATED");
  assert.equal(preview.unavailable[0].verification.failed, false);
  assert.equal(manager.getDevServerStatus("run-good").status, "RUNNING");

  const reused = await manager.startAggregateProjectPreview({ runsRoot, objectiveId: "objective-preview-fixture", candidates: [] });
  assert.equal(reused.reused, true);
  assert.equal(reused.sessionId, preview.sessionId);

  const persisted = persistAggregatePreviewEvidence({ runsRoot, evidence: createAggregatePreviewEvidence({ objectiveId: "objective-preview-fixture", preview }) });
  assert.equal(persisted.verification.status, "NOT_EVALUATED");
  assert.equal(listAggregatePreviewEvidence({ runsRoot, objectiveId: "objective-preview-fixture" }).length, 1);

  const stopped = manager.stopAggregatePreview(preview.sessionId, "objective-preview-fixture");
  assert.equal(stopped.cleanup.status, "CLEANED");
  assert.deepEqual(stopped.cleanup.stoppedRunIds, ["run-good"]);
  assert.equal(manager.getDevServerStatus("run-good").status, "STOPPED");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await isPortAvailable(preview.previews[0].port), true);
} finally {
  manager.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("aggregate-project-preview.test.mjs: All tests passed!");
