import assert from "node:assert/strict";

import { buildRunEvidence } from "../src/interaction.mjs";
import { RUN_STATES } from "../src/run-manager.mjs";

console.log("Running evidence.test.mjs...");

const completedRun = {
  schemaVersion: 1,
  runId: "task-001-evidence",
  state: RUN_STATES.DONE,
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:10:00.000Z",
  project: { id: "test-add-project", repository: "/tmp/test-add-project" },
  task: {
    id: "TASK-001",
    title: "Evidence pilot",
    status: "DONE",
    path: "02-Projects/test-add-project/tasks/task-001.md",
    allowedPaths: ["src/pages/ProjectReady/index.tsx"],
  },
  plan: { verificationCommands: ["typecheck", "build", "test:e2e"] },
  approval: {
    approvedAt: "2026-08-22T00:01:00.000Z",
    approvedBy: "human",
    scope: "EXECUTE_TASK",
  },
  completion: {
    completedAt: "2026-08-22T00:10:00.000Z",
    completedBy: "human",
    humanApproved: true,
  },
  execution: {
    scopeAudit: {
      changedPaths: ["src/pages/ProjectReady/index.tsx"],
      allowedPaths: ["src/pages/ProjectReady/index.tsx"],
      outOfScopePaths: [],
      deniedPaths: [],
    },
    verification: [
      { command: "npm run typecheck", exitCode: 0 },
      { command: "npm run build", exitCode: 0 },
      { command: "npm run test:e2e", exitCode: 0 },
    ],
    result: {
      status: "SUCCESS",
      gitCommit: {
        committed: true,
        commitHash: "abc123",
        parentCommit: "def456",
        commitMessage: "feat(TASK-001): evidence pilot",
        paths: ["src/pages/ProjectReady/index.tsx"],
      },
    },
    workspace: {
      state: "CLEANED",
      appliedAt: "2026-08-22T00:09:00.000Z",
      appliedPaths: ["src/pages/ProjectReady/index.tsx"],
      postApplyVerification: [
        { command: "npm run typecheck", exitCode: 0 },
        { command: "npm run build", exitCode: 0 },
        { command: "npm run test:e2e", exitCode: 0 },
      ],
      postApplyGraphify: { skipped: false, exitCode: 0 },
      artifactPath: "workspace-artifacts/task-001-evidence",
    },
  },
  history: [{ event: "RUN_DONE", state: "DONE", at: "2026-08-22T00:10:00.000Z" }],
};

const evidence = buildRunEvidence(completedRun);
assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.mode, "run-evidence");
assert.equal(evidence.scope.status, "PASS");
assert.deepEqual(evidence.scope.changedPaths, ["src/pages/ProjectReady/index.tsx"]);
assert.equal(evidence.verification.status, "PASS");
assert.equal(evidence.verification.results.length, 3);
assert.equal(evidence.verification.results[2].command, "npm run test:e2e");
assert.equal(evidence.finalization.status, "APPLIED");
assert.equal(evidence.finalization.git.status, "COMMITTED");
assert.equal(evidence.finalization.git.commitHash, "abc123");
assert.equal(evidence.finalization.postApplyVerification.status, "PASS");
assert.equal(evidence.finalization.artifactPath, "workspace-artifacts/task-001-evidence");
assert.equal(evidence.integrity.status, "OK");

const failedEvidence = buildRunEvidence({
  ...completedRun,
  runId: "task-002-evidence",
  state: RUN_STATES.FAILED,
  completion: undefined,
  execution: {
    scopeAudit: {
      changedPaths: ["src/outside.ts"],
      allowedPaths: ["src/inside.ts"],
      outOfScopePaths: ["src/outside.ts"],
      deniedPaths: [],
    },
    verification: [{ command: "npm run build", exitCode: 1, stderrTail: "failed" }],
    workspace: { state: "ACTIVE" },
  },
});
assert.equal(failedEvidence.scope.status, "FAIL");
assert.equal(failedEvidence.verification.status, "FAIL");
assert.equal(failedEvidence.verification.results[0].stderrTail, "failed");
assert.equal(failedEvidence.finalization.status, "NOT_APPLIED");

const unknownEvidence = buildRunEvidence({
  runId: "task-003-evidence",
  state: RUN_STATES.RUNNING,
  project: { id: "test-add-project" },
  task: { id: "TASK-003" },
});
assert.equal(unknownEvidence.scope.status, "UNKNOWN");
assert.equal(unknownEvidence.verification.status, "UNKNOWN");
assert.equal(unknownEvidence.finalization.git.status, "NOT_APPLICABLE");

const incompleteEvidence = buildRunEvidence({
  runId: "task-004-evidence",
  state: RUN_STATES.VERIFYING,
  project: { id: "test-add-project" },
  task: { id: "TASK-004" },
  execution: {
    scopeAudit: {},
    verification: [{ command: "npm run build", exitCode: null }],
  },
});
assert.equal(incompleteEvidence.scope.status, "UNKNOWN");
assert.equal(incompleteEvidence.verification.status, "UNKNOWN");

console.log("evidence.test.mjs: All tests passed!");
