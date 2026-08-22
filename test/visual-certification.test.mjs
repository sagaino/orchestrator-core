import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { captureVisualEvidence } from "../src/visual-qa.mjs";
import { createVisualRevisionRecord } from "../src/visual-revision.mjs";
import { createVisualQACertification, getVisualQACertification } from "../src/visual-certification.mjs";

console.log("Running visual-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-certification-"));
const runsRoot = path.join(root, "runs");
const sourceRepository = path.join(root, "source-project");
const runId = "visual-certification-run";
fs.mkdirSync(runsRoot, { recursive: true });
fs.mkdirSync(sourceRepository, { recursive: true });
const artifactPath = path.join(runsRoot, "workspace-artifacts", runId, "manifest.json");
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, "{}\n");
fs.writeFileSync(path.join(runsRoot, `${runId}.json`), JSON.stringify({
  schemaVersion: 1,
  runId,
  state: "DONE",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
  project: { id: "visual-project", repository: sourceRepository },
  task: { path: "tasks/visual.md", id: "VISUAL-001", title: "Visual QA pilot", allowedPaths: ["src/App.tsx"] },
  completion: { humanApproved: true, completedAt: "2026-08-22T00:00:00.000Z", completedBy: "reviewer" },
  execution: { workspace: { path: path.join(runsRoot, "workspaces", runId), state: "CLEANED", artifactPath: path.relative(runsRoot, artifactPath) } },
  history: [],
}, null, 2));

const captureOptions = {
  runsRoot,
  runId,
  baseUrl: "http://127.0.0.1:4173",
  route: "/operations",
  viewportNames: ["desktop", "tablet", "mobile"],
  timeoutMs: 500,
  captureViewport: async ({ outputPath }) => {
    fs.writeFileSync(outputPath, "visual-certification-fixture");
    return {
      status: "CAPTURED",
      accessibility: { schemaVersion: 1, status: "PASS", findings: [], checks: { bounded: true } },
      processTree: { strategy: "fixture", bounded: true },
    };
  },
};

let server;
try {
  const baseline = await captureVisualEvidence(captureOptions);
  assert.equal(baseline.status, "PASS");
  createVisualRevisionRecord({
    runsRoot,
    runId,
    iteration: 1,
    requestedBy: "reviewer",
    reason: "Align the visual card.",
    visualAnnotations: [{ id: "pin-1", x: 22, y: 31, comment: "Align card" }],
    beforeEvidenceIds: baseline.viewports.map((item) => item.evidenceId),
  });
  const postChange = await captureVisualEvidence({ ...captureOptions, revision: { number: 2, iteration: 1, requestedBy: "reviewer", reason: "Align the visual card." } });
  assert.equal(postChange.status, "PASS");

  const pending = createVisualQACertification({
    runsRoot,
    runId,
    baselineCaptureId: baseline.captureId,
    postChangeCaptureId: postChange.captureId,
    revisionIteration: 1,
    restartReconstruction: { verified: true, revisionIteration: 1, afterEvidenceIds: postChange.viewports.map((item) => item.evidenceId) },
    now: new Date("2026-08-22T01:00:00.000Z"),
  });
  assert.equal(pending.status, "HUMAN_GATE_REQUIRED");
  assert.deepEqual(pending.blockers, ["HUMAN_ACCEPTANCE_REQUIRED"]);

  const certified = createVisualQACertification({
    runsRoot,
    runId,
    baselineCaptureId: baseline.captureId,
    postChangeCaptureId: postChange.captureId,
    revisionIteration: 1,
    restartReconstruction: { verified: true, revisionIteration: 1, afterEvidenceIds: postChange.viewports.map((item) => item.evidenceId) },
    humanGate: { confirmed: true, confirmedBy: "reviewer" },
    now: new Date("2026-08-22T01:01:00.000Z"),
  });
  assert.equal(certified.status, "CERTIFIED");
  assert.equal(certified.checks.cleanup.status, "PASS");
  assert.equal(getVisualQACertification({ runsRoot, runId }).status, "CERTIFIED");

  const runManifestPath = path.join(runsRoot, `${runId}.json`);
  const cleanManifest = fs.readFileSync(runManifestPath, "utf8");
  const leakedManifest = JSON.parse(cleanManifest);
  leakedManifest.execution.workspace.artifactPath = sourceRepository;
  fs.writeFileSync(runManifestPath, JSON.stringify(leakedManifest, null, 2));
  const blocked = createVisualQACertification({
    runsRoot,
    runId,
    baselineCaptureId: baseline.captureId,
    postChangeCaptureId: postChange.captureId,
    revisionIteration: 1,
    restartReconstruction: { verified: true, revisionIteration: 1, afterEvidenceIds: postChange.viewports.map((item) => item.evidenceId) },
    humanGate: { confirmed: true, confirmedBy: "reviewer" },
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.blockers.some((item) => item.startsWith("CLEANUP_")));
  fs.writeFileSync(runManifestPath, cleanManifest);

  fs.appendFileSync(certified.persistence.path, "tampered\n");
  assert.throws(() => getVisualQACertification({ runsRoot, runId }), /tidak ditemukan/);
  createVisualQACertification({
    runsRoot,
    runId,
    baselineCaptureId: baseline.captureId,
    postChangeCaptureId: postChange.captureId,
    revisionIteration: 1,
    restartReconstruction: { verified: true, revisionIteration: 1, afterEvidenceIds: postChange.viewports.map((item) => item.evidenceId) },
    humanGate: { confirmed: true, confirmedBy: "reviewer" },
    now: new Date("2026-08-22T01:02:00.000Z"),
  });
  server = createOrchestratorServer({ vaultRoot: path.join(root, "vault"), runsRoot, port: 0, host: "127.0.0.1", apiToken: "v".repeat(64) });
  await server.start();
  const port = server.server.address().port;
  const auth = { Authorization: `Bearer ${"v".repeat(64)}` };
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: auth });
  const session = (await sessionResponse.json()).data;
  const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-certification`, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "CERTIFIED");
  const post = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/visual-certification`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Operator-Session": session.sessionId, "X-Action-Nonce": session.actionNonce }, body: JSON.stringify({ baselineCaptureId: baseline.captureId, postChangeCaptureId: postChange.captureId, revisionIteration: 1, restartReconstruction: { verified: true, revisionIteration: 1, afterEvidenceIds: postChange.viewports.map((item) => item.evidenceId) }, humanGate: { confirmed: true, confirmedBy: "reviewer" } }) });
  assert.equal(post.status, 201);
  assert.equal((await post.json()).data.status, "CERTIFIED");
} finally {
  if (server) await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("visual-certification.test.mjs: All tests passed!");
