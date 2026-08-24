import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectAggregatePreviewCandidates } from "../src/server.mjs";

console.log("Running aggregate-preview-candidates.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-preview-candidates-"));
try {
  const evidence = {
    objective: { projectIds: ["orchestrator-dashboard"] },
    plan: { state: "APPROVED" },
    nodes: [
      { projectId: "orchestrator-dashboard", nodeId: "node-ui", type: "IMPLEMENTATION", state: "DONE", runId: "task-ui" },
      { projectId: "orchestrator-dashboard", nodeId: "node-integration", type: "VERIFICATION", state: "DONE", runId: "task-integration" },
    ],
  };

  const candidates = selectAggregatePreviewCandidates({
    evidence,
    runsRoot: root,
    projects: [{ id: "orchestrator-dashboard", repository: "/tmp/orchestrator-dashboard" }],
  });

  assert.deepEqual(candidates, [{
    projectId: "orchestrator-dashboard",
    runId: "task-ui",
    repository: "/tmp/orchestrator-dashboard",
    environment: { ORCHESTRATOR_RUNS: root },
    unavailableReason: null,
    unavailableMessage: null,
  }]);

  const unavailable = selectAggregatePreviewCandidates({
    evidence,
    runsRoot: root,
    projects: [],
  });
  assert.equal(unavailable[0].unavailableReason, "NO_RUNNABLE_PREVIEW_SOURCE");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("aggregate-preview-candidates.test.mjs: All tests passed!");
