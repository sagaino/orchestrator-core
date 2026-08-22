import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINAL_GATE_IDS, runFinalV1Certification, verifyFinalV1Certificate } from "../src/final-v1-certification.mjs";

console.log("Running final-v1-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-p9-4-certificate-"));
try {
  const gateResults = Object.fromEntries(FINAL_GATE_IDS.map((id) => [id, { status: "PASS", exitCode: 0, outputTail: "fixture gate passed" }]));
  const report = await runFinalV1Certification({ reportRoot: root, gateResults, executeGates: false, repoRoot: process.cwd(), dashboardRoot: "/Users/sagaino/ciniru/orchestrator-dashboard", now: new Date("2026-08-22T00:00:00.000Z") });
  assert.ok(["CERTIFIED_HUMAN_GATE_REQUIRED", "CONDITIONAL"].includes(report.status));
  assert.equal(report.humanGate.required, true);
  assert.equal(report.humanGate.approved, false);
  assert.equal(report.gates.length, FINAL_GATE_IDS.length);
  assert.equal(report.checks.allRequiredGatesPass, true);
  assert.equal(report.threatModel.noCriticalHigh, true);
  assert.equal(report.threatModel.mediumControlled, true);
  assert.equal(verifyFinalV1Certificate({ reportPath: report.reportPath }).valid, true);
  fs.appendFileSync(report.reportPath, "tamper");
  assert.equal(verifyFinalV1Certificate({ reportPath: report.reportPath }).valid, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("final-v1-certification.test.mjs passed");
