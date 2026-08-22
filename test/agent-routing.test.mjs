import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentRoute } from "../src/agent-routing.mjs";
import { resolveAgyConfig } from "../src/agent-config.mjs";
import { tryDeterministicTaskDraft } from "../src/fast-path-intake.mjs";
import { resolveTaskComplexity } from "../src/task-intake.mjs";

console.log("Running agent-routing.test.mjs...");

const stages = ["task-intake", "retrospective", "knowledge-classification", "implementation"];
for (const stage of stages) {
  assert.equal(resolveAgentRoute({ stage, risk: "LOW", complexity: "LOW" }).tier, "ECONOMY");
  assert.equal(resolveAgentRoute({ stage, risk: "MEDIUM", complexity: "MEDIUM" }).tier, "ECONOMY");
  assert.equal(resolveAgentRoute({ stage, risk: "HIGH", complexity: "LOW" }).tier, "STRONG_REVIEW");
  assert.equal(resolveAgentRoute({ stage, risk: "LOW", complexity: "HIGH" }).tier, "STRONG_REVIEW");
  assert.equal(resolveAgentRoute({ stage, risk: "UNKNOWN", complexity: "MEDIUM" }).tier, "STRONG_REVIEW");
  assert.equal(resolveAgentRoute({ stage, risk: "LOW", complexity: "UNKNOWN" }).tier, "STRONG_REVIEW");
}

assert.equal(resolveAgentRoute({ stage: "recovery", risk: "LOW", complexity: "LOW" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "future-stage", risk: "LOW", complexity: "LOW" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "implementation", risk: "HIGH", complexity: "HIGH", requestedTier: "ECONOMY" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "implementation", risk: "LOW", complexity: "LOW", requestedTier: "STRONG_REVIEW" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "implementation" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "implementation", risk: "NOT_A_RISK", complexity: "LOW" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "implementation", risk: "LOW", complexity: "NOT_COMPLEXITY" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "implementation", risk: "LOW", complexity: "LOW", requestedTier: "NOT_A_TIER" }).tier, "STRONG_REVIEW");
assert.equal(resolveTaskComplexity("LOW", "Perform OAuth migration in src/auth.js"), "HIGH");
assert.equal(resolveTaskComplexity("MEDIUM", "Change a label in src/page.js"), "MEDIUM");
assert.equal(resolveTaskComplexity("BOGUS", "Change a label in src/page.js"), "UNKNOWN");

assert.equal(resolveAgyConfig({ ORCHESTRATOR_AGY_EFFORT: "low" }, "implementation", {
  risk: "HIGH",
  complexity: "LOW",
}).effort, "high");
assert.equal(resolveAgyConfig({ ORCHESTRATOR_AGY_EFFORT: "low" }, "recovery", {
  risk: "LOW",
  complexity: "LOW",
}).effort, "high");
assert.equal(resolveAgyConfig({ ORCHESTRATOR_AGY_EFFORT: "low" }, "implementation", {
  risk: "LOW",
  complexity: "LOW",
}).effort, "low");
assert.equal(resolveAgyConfig({ ORCHESTRATOR_AGY_MODEL: "gemini-3.7-flash-low", ORCHESTRATOR_AGY_EFFORT: "low" }, "implementation", {
  risk: "HIGH", complexity: "LOW",
}).model, "gemini-3.7-flash-high");
assert.deepEqual(resolveAgyConfig({
  ORCHESTRATOR_AGY_MODEL: "gemini-3.7-flash-medium",
  ORCHESTRATOR_AGY_EFFORT: "medium",
}), { model: "gemini-3.7-flash-high", effort: "high" });
assert.deepEqual(resolveAgyConfig({
  ORCHESTRATOR_AGY_MODEL: "economy-provider-model",
  ORCHESTRATOR_AGY_EFFORT: "low",
}, "implementation", { risk: "HIGH", complexity: "LOW" }), {
  model: "gemini-3.7-flash-high",
  effort: "high",
});

const repository = fs.mkdtempSync(path.join(os.tmpdir(), "routing-test-"));
fs.mkdirSync(path.join(repository, "src"), { recursive: true });
fs.writeFileSync(path.join(repository, "src", "auth.js"), "export const auth = true;\n");
fs.writeFileSync(path.join(repository, "src", "page.js"), "export const page = true;\n");
assert.equal(tryDeterministicTaskDraft({
  project: { repository, verificationDefaults: [] },
  request: "change src/auth.js oauth label",
}), null, "security-sensitive fast-path requests require full routing");
assert.equal(tryDeterministicTaskDraft({
  project: { repository, verificationDefaults: [] },
  request: "remove authentication check in src/auth.js",
}), null, "authentication changes require strong review");
assert.equal(tryDeterministicTaskDraft({
  project: { repository, verificationDefaults: [] },
  request: "remove MFA requirement in src/auth.js",
}), null, "unclassified security work must not be guessed as low risk");
assert.equal(tryDeterministicTaskDraft({
  project: { repository, verificationDefaults: [] },
  request: "remove CSRF validation in src/auth.js",
}), null, "unclassified security work must not be guessed as low risk");
assert.equal(tryDeterministicTaskDraft({
  project: { repository, verificationDefaults: [] },
  request: "remove MFA check and change label in src/auth.js",
}), null, "mixed security and UI intent must not use fast path");
for (const request of [
  "set CORS wildcard and change color in src/page.js",
  "adjust rate limit and change label in src/page.js",
  "set admin role and change icon in src/page.js",
  "change color 删除登录验证 in src/page.js",
  "change color حذف المصادقة in src/page.js",
]) {
  assert.equal(tryDeterministicTaskDraft({ project: { repository, verificationDefaults: [] }, request }), null, "mixed intent must not use fast path");
}
const safeDraft = tryDeterministicTaskDraft({
  project: { repository, verificationDefaults: [] },
  request: "change color in src/page.js",
});
assert.equal(safeDraft.risk, "LOW");
assert.equal(safeDraft.complexity, "LOW");

console.log("agent-routing.test.mjs: All tests passed!");
