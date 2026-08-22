import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFinalPilotCohort, verifyFinalPilotCohortReport } from "../src/final-pilot-cohort.mjs";

console.log("Running final-pilot-cohort.test.mjs...");

function acceptedRun(index) {
  const projectId = `project-${index % 3}`;
  const changedPath = `src/task-${index}.js`;
  const now = "2026-08-22T00:00:00.000Z";
  const history = [
    { event: "RUN_DONE", state: "DONE", at: now },
    { event: "KNOWLEDGE_APPROVED", state: "KNOWLEDGE_APPROVAL", at: now },
    ...(index === 1 ? [{ event: "REVIEW_CHANGES_REQUESTED", state: "CHANGES_REQUESTED", at: now }] : []),
    ...(index === 2 ? [{ event: "AUTOMATIC_RECOVERY_SUCCEEDED", state: "REVIEW", at: now }] : []),
  ];
  const verification = [{ command: "npm test", exitCode: 0 }];
  return {
    schemaVersion: 1, revision: 1, runId: `real-run-${index}`, state: "DONE", createdAt: now, updatedAt: now,
    project: { id: projectId, repository: `/tmp/${projectId}` },
    task: { id: `TASK-${index}`, title: `Real task ${index}`, path: `tasks/TASK-${index}.md`, allowedPaths: [changedPath] },
    plan: { verificationCommands: ["npm test"] }, completion: { completedAt: now, completedBy: "human", humanApproved: true },
    execution: {
      scopeAudit: { passed: true, changedPaths: [changedPath], allowedPaths: [changedPath], outOfScopePaths: [], deniedPaths: [] },
      verification,
      result: { status: "SUCCESS", gitCommit: { committed: true, commitHash: `commit-${index}`, paths: [changedPath] } },
      workspace: { state: "CLEANED", appliedAt: now, appliedPaths: [changedPath], postApplyVerification: verification },
    },
    history,
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-pilot-report-"));
try {
  for (let index = 0; index < 10; index += 1) fs.writeFileSync(path.join(root, `real-run-${index}.json`), JSON.stringify(acceptedRun(index)));
  fs.writeFileSync(path.join(root, "real-rejected.json"), JSON.stringify({ schemaVersion: 1, revision: 1, runId: "real-rejected", state: "FAILED", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z", project: { id: "project-0", repository: "/tmp/project-0" }, task: { id: "REJECTED", path: "tasks/REJECTED.md" }, execution: { workspace: { state: "DISCARDED" } }, history: [] }));
  const report = runFinalPilotCohort({ reportRoot: root, sourceRunsRoot: root, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(report.status, "PASS");
  assert.equal(report.scope.taskCount, 10);
  assert.equal(report.scope.projectCount, 3);
  assert.equal(report.checks.realPersistedRunsOnly, true);
  assert.equal(report.checks.exceptionalScenariosCovered, true);
  assert.equal(verifyFinalPilotCohortReport({ reportPath: report.reportPath }).valid, true);
  fs.appendFileSync(report.reportPath, "tamper");
  assert.equal(verifyFinalPilotCohortReport({ reportPath: report.reportPath }).valid, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("final-pilot-cohort.test.mjs passed");
