import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { certifyEfficiency, writeEfficiencyCertification } from "../src/efficiency-certification.mjs";

console.log("Running efficiency-certification.test.mjs...");
const baselinePath = path.resolve("runs/runtime/token-benchmarks/p5.0-2026-08-22.json");
const blocked = certifyEfficiency({ baselinePath, gateEvidence: {
  verificationPassRate: 1, baselineVerificationPassRate: 1, safetyRegressions: 0,
  knowledgeDecisionCoverage: 1, newFindings: [],
} });
assert.equal(blocked.providerCalls, 0);
assert.equal(blocked.current.medianTokens, 259);
assert.equal(blocked.current.p95Tokens, 520);
assert.ok(blocked.comparison.medianReductionPercent >= 30);
assert.equal(blocked.automatedGatesPass, true);
assert.equal(blocked.finalDecision, "HUMAN_GATE_REQUIRED");

const gatesBlocked = certifyEfficiency({ baselinePath });
assert.equal(gatesBlocked.finalDecision, "BLOCKED_AUTOMATED_GATES");

const passing = certifyEfficiency({ baselinePath, gateEvidence: {
  verificationPassRate: 1, baselineVerificationPassRate: 0.99, safetyRegressions: 0,
  knowledgeDecisionCoverage: 1, findings: [],
} });
assert.equal(passing.gates.length, 4);
assert.equal(passing.gates.every((item) => item.status === "PASS"), true);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "p54-cert-"));
const output = path.join(temporaryDirectory, "report.json");
assert.equal(writeEfficiencyCertification(blocked, output), output);
assert.equal(fs.existsSync(`${output}.sha256`), true);
console.log("efficiency-certification.test.mjs: All tests passed!");
