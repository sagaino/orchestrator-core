import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { captureVisualEvidence } from "../src/visual-qa.mjs";
import { createVisualEvidence, persistVisualEvidence } from "../src/visual-evidence.mjs";

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
  server = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: 0,
    host: "127.0.0.1",
    apiToken: "v".repeat(64),
    services: {
      captureVisualEvidence: (input) => captureVisualEvidence({
        ...input,
        baseUrl: "http://127.0.0.1:4173",
        route: "/operations",
        viewportNames: ["desktop", "tablet", "mobile"],
        timeoutMs: 500,
        captureViewport: async ({ outputPath }) => {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, "api-capture-png-fixture");
          return { status: "CAPTURED", processTree: { strategy: "fixture", bounded: true } };
        },
      }),
      auditVisualEvidence: ({ runsRoot: targetRunsRoot, evidence }) => persistVisualEvidence({
        runsRoot: targetRunsRoot,
        evidence: createVisualEvidence({ ...evidence, accessibility: { schemaVersion: 1, status: "FAIL", findings: [{ id: "FIXTURE_A11Y", severity: "ERROR", message: "Fixture accessibility finding." }], checks: { bounded: true } }, createdAt: evidence.createdAt, artifactPath: evidence.actual.path }),
      }),
    },
  });
  await server.start();
  const port = server.server.address().port;
  const auth = { Authorization: `Bearer ${"v".repeat(64)}` };
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: auth });
  const session = (await sessionResponse.json()).data;
  const capture = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence/capture`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Operator-Session": session.sessionId, "X-Action-Nonce": session.actionNonce }, body: JSON.stringify({ baseUrl: "http://127.0.0.1:4173", route: "/operations" }) });
  assert.equal(capture.status, 201);
  const captureBody = (await capture.json()).data;
  assert.equal(captureBody.status, "PASS");
  session.actionNonce = capture.headers.get("x-action-nonce");
  const captures = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence/captures`, { headers: auth });
  assert.equal(captures.status, 200);
  assert.equal((await captures.json()).data.length, 1);
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
  session.actionNonce = post.headers.get("x-action-nonce");
  const compare = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence/visual-api-1/compare`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Operator-Session": session.sessionId, "X-Action-Nonce": session.actionNonce }, body: JSON.stringify({ reference: { kind: "path", path: path.join(root, "missing-reference.png") } }) });
  assert.equal(compare.status, 200);
  assert.equal((await compare.json()).data.comparison.status, "UNKNOWN");
  session.actionNonce = compare.headers.get("x-action-nonce");
  const accessibility = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence/visual-api-1/accessibility`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Operator-Session": session.sessionId, "X-Action-Nonce": session.actionNonce }, body: JSON.stringify({ baseUrl: "http://127.0.0.1:4173" }) });
  assert.equal(accessibility.status, 200);
  assert.equal((await accessibility.json()).data.accessibility.status, "FAIL");
  const list = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence`, { headers: auth });
  assert.equal(list.status, 200);
  const visualEvidence = (await list.json()).data;
  assert.equal(visualEvidence.length, 4);
  assert.deepEqual(new Set(visualEvidence.map((item) => item.evidenceId)).size, 4);
  const detail = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-evidence/visual-api-1`, { headers: auth });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.route, "/operations");
} finally {
  if (server) await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("visual-evidence-api.test.mjs: All tests passed!");
