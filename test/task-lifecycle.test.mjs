import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeBacklogTask } from "../src/task-lifecycle.mjs";
import { enqueueTaskJob } from "../src/job-queue.mjs";

console.log("Running task-lifecycle.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-lifecycle-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const taskRoot = path.join(vaultRoot, "02-Projects", "fixture", "tasks");

function writeTask(id, fileName) {
  const filePath = path.join(taskRoot, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    "---",
    `title: ${id}`,
    "type: task",
    `task_id: ${id}`,
    "project: fixture",
    "status: BACKLOG",
    "updated: 2026-08-21",
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n"), "utf8");
  return filePath;
}

try {
  const cancelledPath = writeTask("TASK-CANCEL", "task-cancel.md");
  const cancelled = closeBacklogTask({
    vaultRoot,
    runsRoot,
    projectId: "fixture",
    taskInput: "TASK-CANCEL",
    action: "CANCELLED",
    reason: "Scope dipindahkan ke project test.",
    requestedBy: "tester",
  });
  assert.equal(cancelled.task.status, "CANCELLED");
  assert.match(fs.readFileSync(cancelledPath, "utf8"), /^status: CANCELLED$/m);
  assert.match(fs.readFileSync(cancelledPath, "utf8"), /Scope dipindahkan ke project test/);
  assert.throws(() => closeBacklogTask({
    vaultRoot,
    runsRoot,
    projectId: "fixture",
    taskInput: "TASK-CANCEL",
    action: "CANCELLED",
    reason: "duplicate",
  }), /hanya menerima task BACKLOG/);

  const supersededPath = writeTask("TASK-OLD", "task-old.md");
  const superseded = closeBacklogTask({
    vaultRoot,
    runsRoot,
    projectId: "fixture",
    taskInput: "TASK-OLD",
    action: "SUPERSEDED",
    reason: "Digantikan oleh TASK-NEW.",
  });
  assert.equal(superseded.task.status, "SUPERSEDED");
  assert.match(fs.readFileSync(supersededPath, "utf8"), /^status: SUPERSEDED$/m);

  writeTask("TASK-QUEUED", "task-queued.md");
  enqueueTaskJob({
    runsRoot,
    projectId: "fixture",
    taskId: "TASK-QUEUED",
    taskPath: "02-Projects/fixture/tasks/task-queued.md",
    requestedBy: "tester",
  });
  assert.throws(() => closeBacklogTask({
    vaultRoot,
    runsRoot,
    projectId: "fixture",
    taskInput: "TASK-QUEUED",
    action: "CANCELLED",
    reason: "too late",
  }), /sudah memiliki job atau run/);
  assert.throws(() => closeBacklogTask({
    vaultRoot,
    runsRoot,
    projectId: "fixture",
    taskInput: "TASK-QUEUED",
    action: "CANCELLED",
    reason: "",
  }), /membutuhkan reason/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("task-lifecycle.test.mjs: All tests passed!");
