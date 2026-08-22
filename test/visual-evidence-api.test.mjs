import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";

console.log("Running visual-evidence-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-evidence-api-"));
const runsRoot = path.join(root, "runs");
const vaultRoot = path.join(root, "vault");
const artifactPath = path.join(root, "capture.png");
fs.mkdirSync(runsRoot, { recursive: true });
fs.mkdirSync(vaultRoot, { recursive: true });
fs.writeFileSync(artifactPath, "api-capture-fixture");
const runId = "visual-api-run";
fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
  schemaVersion: 1,
  runId,
  state: "REVIEW",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
  project: { id: "visual-project", repository: root },
  task: { path: "tasks/visual.md", id: "VISUAL-001", title: "Visual evidence" },
  history: [],
}, null, 2));

let server;
try {
  server = createOrchestratorServer({ vaultRoot, runsRoot, port: 0, host: "127.0.0.1", apiToken: "v".repeat(64) });
  await server.start();
  const port = server.server.address().port;
  const auth = { Authorization: `Bearer ${"v".repeat(64)}` };
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: auth });
  const session = (await sessionResponse.json()).data;
  const body = {
    evidenceId: "visual-api-1",
    route: "/operations",
    viewport: { name: "tablet", width: 1024, height: 768 },
    reference: { kind: "NONE" },
    actual: { status: "CAPTURED" },
    comparison: { status: "UNKNOWN", method: "fixture" },
    accessibility: { status: "UNKNOWN", findings: [] },
    revision: { number: 1 },
    artifactPath,
  };
  const post = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Operator-Session": session.sessionId, "X-Action-Nonce": session.actionNonce }, body: JSON.stringify(body) });
  assert.equal(post.status, 201);
  const posted = (await post.json()).data;
  assert.equal(posted.evidenceId, "visual-api-1");
  assert.equal(posted.artifact.exists, true);
  const list = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence`, { headers: auth });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data.length, 1);
  const detail = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence/visual-api-1`, { headers: auth });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.route, "/operations");
} finally {
  if (server) await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("visual-evidence-api.test.mjs: All tests passed!");

