import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginReviewRevision, beginFailedRunRecovery, RUN_STATES } from "../src/run-manager.mjs";

console.log("Running transaction.test.mjs...");

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "tx-vault-"));
const tempRuns = fs.mkdtempSync(path.join(os.tmpdir(), "tx-runs-"));
const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "tx-ws-"));

try {
  // Setup mock task file
  const taskDir = path.join(tempVault, "02-Projects", "proj1", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const taskPath = path.join(taskDir, "task-001.md");
  const initialTaskContent = [
    "---",
    "title: Sample Task",
    "task_id: T-001",
    "project: proj1",
    "status: REVIEW",
    "dependencies: []",
    "verification: [typecheck]",
    "allowed_paths: [src/app.ts]",
    "requires_changes: true",
    "---",
    "",
    "# Sample Task",
    "Instruction text",
  ].join("\n");
  fs.writeFileSync(taskPath, initialTaskContent, "utf8");

  // Setup mock run manifest
  const runId = "t-001-20260816T030000Z-11223344";
  const manifest = {
    schemaVersion: 1,
    runId,
    state: RUN_STATES.REVIEW,
    project: { id: "proj1", repository: "/tmp/repo" },
    task: { id: "T-001", path: "02-Projects/proj1/tasks/task-001.md", status: "REVIEW" },
    execution: {
      workspace: { path: tempWorkspace, state: "ACTIVE" },
      reviewChanges: [],
    },
    history: [],
  };
  fs.writeFileSync(path.join(tempRuns, `${runId}.json`), JSON.stringify(manifest, null, 2));

  // 1. Successful beginReviewRevision
  const revisionResult = beginReviewRevision({
    vaultRoot: tempVault,
    runsRoot: tempRuns,
    runId,
    requestedBy: "user",
    reason: "Fix alignment",
  });
  assert.equal(revisionResult.state, RUN_STATES.CHANGES_REQUESTED);
  assert.equal(revisionResult.task.status, "IN_PROGRESS");

  // Verify task file was updated to IN_PROGRESS
  const updatedTask = fs.readFileSync(taskPath, "utf8");
  assert.match(updatedTask, /status:\s*IN_PROGRESS/);

  // 2. Failure case: invalid reason must not modify manifest or leave dangling lock
  const runId2 = "t-002-20260816T030000Z-55667788";
  const manifest2 = {
    schemaVersion: 1,
    runId: runId2,
    state: RUN_STATES.REVIEW,
    project: { id: "proj1", repository: "/tmp/repo" },
    task: { id: "T-002", path: "02-Projects/proj1/tasks/task-001.md", status: "REVIEW" },
    execution: {
      workspace: { path: tempWorkspace, state: "ACTIVE" },
      reviewChanges: [],
    },
    history: [],
  };
  fs.writeFileSync(path.join(tempRuns, `${runId2}.json`), JSON.stringify(manifest2, null, 2));

  assert.throws(
    () => beginReviewRevision({
      vaultRoot: tempVault,
      runsRoot: tempRuns,
      runId: runId2,
      requestedBy: "user",
      reason: "", // invalid empty reason
    }),
    /Request changes membutuhkan --reason/
  );

  // Verify no lock file remains
  const locksDir = path.join(tempRuns, "locks");
  if (fs.existsSync(locksDir)) {
    const locks = fs.readdirSync(locksDir);
    assert.equal(locks.length, 1); // Only active revision lock
  }
} finally {
  fs.rmSync(tempVault, { recursive: true, force: true });
  fs.rmSync(tempRuns, { recursive: true, force: true });
  fs.rmSync(tempWorkspace, { recursive: true, force: true });
}

console.log("transaction.test.mjs: All tests passed!");
