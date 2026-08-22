import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProductionCertification, verifyProductionCertification } from "../src/production-certification.mjs";

console.log("Running production-certification.test.mjs...");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-certification-"));
try {
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(path.join(runsRoot, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, "runtime", "operator-audit.jsonl"), "");
  const pilot = (runId, projectId) => ({
    schemaVersion: 1, revision: 1, runId, state: "DONE", project: { id: projectId, repository: root }, task: { id: runId, path: "task.md", allowedPaths: ["README.md"] },
    execution: { scopeAudit: { passed: true, changedPaths: ["README.md"], outOfScopePaths: [], deniedPaths: [] }, verification: [{ command: "test", exitCode: 0 }], result: {}, workspace: { state: "CLEANED", appliedAt: "2026-08-22T00:00:00.000Z", appliedPaths: ["README.md"], postApplyVerification: [{ command: "test", exitCode: 0 }] } },
    completion: { completedAt: "2026-08-22T00:00:00.000Z", completedBy: "operator", humanApproved: true }, history: [],
  });
  fs.writeFileSync(path.join(runsRoot, "pilot-a.json"), JSON.stringify(pilot("pilot-a", "one")));
  fs.writeFileSync(path.join(runsRoot, "pilot-b.json"), JSON.stringify(pilot("pilot-b", "two")));
  const result = createProductionCertification({ runsRoot, pilotRunIds: ["pilot-a", "pilot-b"], verification: { backend: "PASS", dashboard: "PASS" }, drills: { backupRestore: "PASS", crashRecovery: "PASS" }, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(result.status, "CONDITIONAL"); // no fresh DR backup status in isolated fixture
  assert.equal(result.pilots.length, 2);
  const verified = verifyProductionCertification({ bundleFilePath: result.bundlePath });
  assert.equal(verified.valid, true);
  fs.appendFileSync(result.bundlePath, "tamper");
  assert.equal(verifyProductionCertification({ bundleFilePath: result.bundlePath }).valid, false);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("production-certification.test.mjs passed");
