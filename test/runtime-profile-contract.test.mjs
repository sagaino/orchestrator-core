import assert from "node:assert/strict";
import {
  runtimeConfigSnapshot,
  validateRuntimeProfileAlignment,
  RUNTIME_PROFILE_LOCAL_SAFE,
  RUNTIME_PROFILE_LOCAL_PILOT,
} from "../src/runtime-config.mjs";

console.log("Running runtime-profile-contract.test.mjs...");

// 1. Empty environment resolves to aligned LOCAL_SAFE
const emptySnapshot = runtimeConfigSnapshot({});
assert.equal(emptySnapshot.profile, "LOCAL_SAFE");
assert.equal(emptySnapshot.flags.objectives, false);
assert.equal(emptySnapshot.flags.objectiveScheduler, false);
assert.equal(emptySnapshot.flags.crossProject, false);
assert.equal(emptySnapshot.automation.approvalMode, "MANUAL");
const emptyAlignment = validateRuntimeProfileAlignment(emptySnapshot);
assert.equal(emptyAlignment.aligned, true);
assert.equal(emptyAlignment.severity, "INFO");
assert.equal(emptyAlignment.mismatches.length, 0);

// 2. Exact Section 4.1 values resolve to aligned LOCAL_SAFE
const exactSafeEnv = {
  ORCHESTRATOR_PROFILE: "LOCAL_SAFE",
  ORCHESTRATOR_APPROVAL_MODE: "MANUAL",
  ORCHESTRATOR_AUTO_FINALIZE_TASKS: "0",
  ORCHESTRATOR_OBJECTIVES_ENABLED: "0",
  ORCHESTRATOR_OBJECTIVE_SCHEDULER: "0",
  ORCHESTRATOR_PARALLEL_OBJECTIVES: "0",
  ORCHESTRATOR_SAME_PROJECT_PARALLEL: "0",
  ORCHESTRATOR_CROSS_PROJECT: "0",
  ORCHESTRATOR_TELEGRAM_ENABLED: "0",
  ORCHESTRATOR_SKILLS_ENABLED: "0",
  ORCHESTRATOR_SKILL_AUTO_ROUTING: "0",
  ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS: "2",
  ORCHESTRATOR_MAX_PARALLEL_JOBS: "2",
};
const safeSnapshot = runtimeConfigSnapshot(exactSafeEnv);
assert.deepEqual(safeSnapshot.flags, RUNTIME_PROFILE_LOCAL_SAFE.flags);
assert.deepEqual(safeSnapshot.capacity, RUNTIME_PROFILE_LOCAL_SAFE.capacity);
assert.deepEqual(safeSnapshot.automation, RUNTIME_PROFILE_LOCAL_SAFE.automation);
const safeAlignment = validateRuntimeProfileAlignment(safeSnapshot);
assert.equal(safeAlignment.aligned, true);
assert.equal(safeAlignment.mismatches.length, 0);

// 3. Exact Section 4.2 values resolve to aligned LOCAL_PILOT
const exactPilotEnv = {
  ORCHESTRATOR_PROFILE: "LOCAL_PILOT",
  ORCHESTRATOR_APPROVAL_MODE: "PLAN_REVIEW_THEN_AUTOPILOT",
  ORCHESTRATOR_AUTO_FINALIZE_TASKS: "0",
  ORCHESTRATOR_OBJECTIVES_ENABLED: "1",
  ORCHESTRATOR_OBJECTIVE_SCHEDULER: "1",
  ORCHESTRATOR_PARALLEL_OBJECTIVES: "0",
  ORCHESTRATOR_SAME_PROJECT_PARALLEL: "0",
  ORCHESTRATOR_CROSS_PROJECT: "1",
  ORCHESTRATOR_TELEGRAM_ENABLED: "0",
  ORCHESTRATOR_SKILLS_ENABLED: "0",
  ORCHESTRATOR_SKILL_AUTO_ROUTING: "0",
  ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS: "2",
  ORCHESTRATOR_MAX_PARALLEL_JOBS: "3",
};
const pilotSnapshot = runtimeConfigSnapshot(exactPilotEnv);
assert.deepEqual(pilotSnapshot.flags, RUNTIME_PROFILE_LOCAL_PILOT.flags);
assert.deepEqual(pilotSnapshot.capacity, RUNTIME_PROFILE_LOCAL_PILOT.capacity);
assert.deepEqual(pilotSnapshot.automation, RUNTIME_PROFILE_LOCAL_PILOT.automation);
const pilotAlignment = validateRuntimeProfileAlignment(pilotSnapshot);
assert.equal(pilotAlignment.aligned, true);
assert.equal(pilotAlignment.mismatches.length, 0);

// 4. LOCAL_SAFE with any v2 flag active is rejected as a mismatch / blocker
const driftedSafeEnv = {
  ORCHESTRATOR_PROFILE: "LOCAL_SAFE",
  ORCHESTRATOR_OBJECTIVES_ENABLED: "1",
  ORCHESTRATOR_CROSS_PROJECT: "1",
};
const driftedSafeSnapshot = runtimeConfigSnapshot(driftedSafeEnv);
const driftedAlignment = validateRuntimeProfileAlignment(driftedSafeSnapshot);
assert.equal(driftedAlignment.aligned, false);
assert.equal(driftedAlignment.severity, "BLOCKER");
assert.ok(driftedAlignment.mismatches.some((m) => m.field === "flags.objectives" && m.expected === false && m.actual === true));
assert.ok(driftedAlignment.mismatches.some((m) => m.field === "flags.crossProject" && m.expected === false && m.actual === true));

// 5. Unknown profile fails safe
const unknownProfileSnapshot = runtimeConfigSnapshot({ ORCHESTRATOR_PROFILE: "CUSTOM_UNSAFE" });
const unknownAlignment = validateRuntimeProfileAlignment(unknownProfileSnapshot);
assert.equal(unknownAlignment.aligned, false);
assert.equal(unknownAlignment.contractFound, false);
assert.equal(unknownAlignment.severity, "BLOCKER");

// 6. Invalid boolean values remain disabled
const invalidBooleanEnv = {
  ORCHESTRATOR_PROFILE: "LOCAL_SAFE",
  ORCHESTRATOR_OBJECTIVES_ENABLED: "invalid_value",
  ORCHESTRATOR_SKILLS_ENABLED: "2",
};
const invalidSnapshot = runtimeConfigSnapshot(invalidBooleanEnv);
assert.equal(invalidSnapshot.flags.objectives, false);
assert.equal(invalidSnapshot.flags.skills, false);

console.log("runtime-profile-contract.test.mjs: All tests passed!");
