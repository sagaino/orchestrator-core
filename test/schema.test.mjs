import assert from "node:assert/strict";
import { validateManifest, validateJob } from "../src/schema.mjs";
import { RUN_STATES } from "../src/run-manager.mjs";
import { JOB_STATES } from "../src/job-queue.mjs";

console.log("Running schema.test.mjs...");

// 1. validateManifest
const validManifest = {
  schemaVersion: 1,
  runId: "fe-001-20260816T030000Z-12345678",
  state: RUN_STATES.REVIEW,
  project: {
    id: "starter-app",
    repository: "/path/to/repo",
  },
  task: {
    path: "02-Projects/starter-app/tasks/task-001.md",
  },
  history: [],
};

const validResult = validateManifest(validManifest);
assert.equal(validResult.valid, true);
assert.equal(validResult.errors.length, 0);

// Invalid cases
assert.equal(validateManifest(null).valid, false);
assert.equal(validateManifest({}).valid, false);

const invalidState = { ...validManifest, state: "NON_EXISTENT_STATE" };
const invalidStateResult = validateManifest(invalidState);
assert.equal(invalidStateResult.valid, false);
assert.match(invalidStateResult.errors[0], /Invalid manifest state/);

const missingProject = { ...validManifest, project: {} };
assert.equal(validateManifest(missingProject).valid, false);

const badHistory = { ...validManifest, history: "not-an-array" };
assert.equal(validateManifest(badHistory).valid, false);

// 2. validateJob
const validJob = {
  schemaVersion: 1,
  jobId: "fe-001-20260816T030000Z-87654321",
  projectId: "starter-app",
  taskId: "FE-001",
  taskPath: "02-Projects/starter-app/tasks/task-001.md",
  state: JOB_STATES.QUEUED,
};

const validJobResult = validateJob(validJob);
assert.equal(validJobResult.valid, true);
assert.equal(validJobResult.errors.length, 0);

// Invalid job cases
assert.equal(validateJob(null).valid, false);
assert.equal(validateJob({}).valid, false);

const invalidJobState = { ...validJob, state: "BAD_STATE" };
assert.equal(validateJob(invalidJobState).valid, false);

const missingJobId = { ...validJob, jobId: "" };
assert.equal(validateJob(missingJobId).valid, false);

console.log("schema.test.mjs: All tests passed!");
