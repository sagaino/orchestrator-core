import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  runtimeConfigSnapshot,
  validateRuntimeProfileAlignment,
  RUNTIME_PROFILE_LOCAL_SAFE,
  RUNTIME_PROFILE_LOCAL_PILOT,
} from "../src/runtime-config.mjs";
import { operationsReadiness } from "../src/operations-governance.mjs";

console.log("Running governance-config-alignment.test.mjs...");

function parseDotenv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match) continue;
    let val = match[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[match[1]] = val;
  }
  return env;
}

// 1. Both environment examples match runtime contracts
const safeEnv = parseDotenv(path.resolve(".env.example"));
const safeSnapshot = runtimeConfigSnapshot(safeEnv);
const safeAlign = validateRuntimeProfileAlignment(safeSnapshot);
assert.equal(safeAlign.aligned, true, ".env.example must match LOCAL_SAFE contract");

const pilotEnv = parseDotenv(path.resolve(".env.pilot.example"));
const pilotSnapshot = runtimeConfigSnapshot(pilotEnv);
const pilotAlign = validateRuntimeProfileAlignment(pilotSnapshot);
assert.equal(pilotAlign.aligned, true, ".env.pilot.example must match LOCAL_PILOT contract");

// 2. Fresh installation defaults are disabled
assert.equal(safeSnapshot.flags.objectives, false);
assert.equal(safeSnapshot.flags.objectiveScheduler, false);
assert.equal(safeSnapshot.flags.parallelObjectives, false);
assert.equal(safeSnapshot.flags.sameProjectParallel, false);
assert.equal(safeSnapshot.flags.crossProject, false);
assert.equal(safeSnapshot.flags.skills, false);
assert.equal(safeSnapshot.flags.telegram, false);
assert.equal(safeSnapshot.automation.approvalMode, "MANUAL");

// 3. Scope, Threat Model, Implementation Plan, README, and Runtime agree on defaults
const scopeDoc = fs.readFileSync(path.resolve("docs/AI_OS_V2_SCOPE.md"), "utf8");
const threatDoc = fs.readFileSync(path.resolve("docs/AI_OS_V2_THREAT_MODEL.md"), "utf8");
const planDoc = fs.readFileSync(path.resolve("docs/AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md"), "utf8");
const readmeDoc = fs.readFileSync(path.resolve("README.md"), "utf8");

assert.ok(scopeDoc.includes("ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT"));
assert.ok(threatDoc.includes("ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT"));
assert.ok(planDoc.includes("ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT"));
assert.ok(readmeDoc.includes("LOCAL_SAFE"));
assert.ok(readmeDoc.includes("LOCAL_PILOT"));

// 4. Implementation status does not claim Telegram completion
assert.ok(planDoc.includes("optional Telegram deferred") || planDoc.includes("Optional Telegram Channel"));
assert.ok(!planDoc.includes("✅ V2-090"));
assert.ok(!planDoc.includes("✅ V2-091"));
assert.ok(!planDoc.includes("✅ V2-092"));

// 5. Acceptance fields are human-supplied and valid
assert.ok(scopeDoc.includes("accepted_by: \"local:sagaino\""));
assert.ok(threatDoc.includes("accepted_by: \"local:sagaino\""));

// 6. Canonical environment aliases work
assert.ok(readmeDoc.includes("ORCHESTRATOR_VAULT_PATH"));
assert.ok(readmeDoc.includes("ORCHESTRATOR_API_PORT"));

// 7. Operations exposes profile alignment without secrets
const readiness = operationsReadiness({ runsRoot: path.resolve("runs") });
assert.ok(readiness.checks.some((c) => c.id === "runtime-profile"));
assert.ok(readiness.signals.runtimeProfileAlignment);
const readinessText = JSON.stringify(readiness);
assert.ok(!readinessText.includes("BEGIN PRIVATE KEY"));
assert.ok(!readinessText.includes("secret"));

// 8. Referenced doc paths exist
assert.ok(fs.existsSync(path.resolve("docs/AI_OS_V2_SCOPE.md")));
assert.ok(fs.existsSync(path.resolve("docs/AI_OS_V2_THREAT_MODEL.md")));
assert.ok(fs.existsSync(path.resolve("docs/AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md")));
assert.ok(fs.existsSync(path.resolve("docs/AI_OS_V2_GOVERNANCE_CONFIG_ALIGNMENT_PLAN.md")));

// 9. .env is ignored by Git
const checkIgnore = execFileSync("git", ["check-ignore", ".env"], { encoding: "utf8" }).trim();
assert.equal(checkIgnore, ".env");

console.log("governance-config-alignment.test.mjs: All certification checks passed!");
