import assert from "node:assert/strict";
import {
  runtimeConfigSnapshot,
  validateRuntimeProfileAlignment,
  runtimeProfileAdmission,
  RUNTIME_PROFILE_MISMATCH_CODE,
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
assert.equal(runtimeProfileAdmission({}).allowed, true);

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
assert.equal(pilotAlignment.overrides.length, 0);

// 4. LOCAL_PILOT accepts only bounded, explicit options that are already implemented
const pilotOptInEnv = {
  ...exactPilotEnv,
  ORCHESTRATOR_APPROVAL_MODE: "FINAL_ACCEPT_ONLY",
  ORCHESTRATOR_PARALLEL_OBJECTIVES: "1",
  ORCHESTRATOR_SAME_PROJECT_PARALLEL: "1",
  ORCHESTRATOR_SKILLS_ENABLED: "1",
  ORCHESTRATOR_SKILL_AUTO_ROUTING: "1",
};
const pilotOptInAlignment = validateRuntimeProfileAlignment(runtimeConfigSnapshot(pilotOptInEnv));
assert.equal(pilotOptInAlignment.aligned, true);
assert.equal(runtimeProfileAdmission(pilotOptInEnv).allowed, true);
assert.ok(pilotOptInAlignment.overrides.some((item) => item.field === "automation.approvalMode" && item.actual === "FINAL_ACCEPT_ONLY"));
assert.ok(pilotOptInAlignment.overrides.some((item) => item.field === "flags.skills" && item.actual === true));

const invalidPilotDependency = runtimeConfigSnapshot({
  ...exactPilotEnv,
  ORCHESTRATOR_SKILLS_ENABLED: "0",
  ORCHESTRATOR_SKILL_AUTO_ROUTING: "1",
});
assert.equal(validateRuntimeProfileAlignment(invalidPilotDependency).aligned, false);
assert.ok(validateRuntimeProfileAlignment(invalidPilotDependency).mismatches.some((item) => item.field === "flags.skillAutoRouting"));

const deferredPilotCapability = runtimeConfigSnapshot({ ...exactPilotEnv, ORCHESTRATOR_TELEGRAM_ENABLED: "1" });
assert.equal(validateRuntimeProfileAlignment(deferredPilotCapability).aligned, false);
assert.ok(validateRuntimeProfileAlignment(deferredPilotCapability).mismatches.some((item) => item.field === "flags.telegram"));

const automaticReviewPilot = runtimeConfigSnapshot({ ...exactPilotEnv, ORCHESTRATOR_AUTO_FINALIZE_TASKS: "1" });
assert.equal(validateRuntimeProfileAlignment(automaticReviewPilot).aligned, false);
assert.ok(validateRuntimeProfileAlignment(automaticReviewPilot).mismatches.some((item) => item.field === "automation.automaticReviewFinalization"));

// 5. LOCAL_SAFE with any v2 flag active is rejected as a mismatch / blocker
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
const driftedAdmission = runtimeProfileAdmission(driftedSafeEnv);
assert.equal(driftedAdmission.allowed, false);
assert.equal(driftedAdmission.code, RUNTIME_PROFILE_MISMATCH_CODE);
assert.equal(driftedAdmission.profile, "LOCAL_SAFE");
assert.ok(!JSON.stringify(driftedAdmission).includes("provider-token"));

// 6. Unknown profile fails safe
const unknownProfileSnapshot = runtimeConfigSnapshot({ ORCHESTRATOR_PROFILE: "CUSTOM_UNSAFE" });
const unknownAlignment = validateRuntimeProfileAlignment(unknownProfileSnapshot);
assert.equal(unknownAlignment.aligned, false);
assert.equal(unknownAlignment.contractFound, false);
assert.equal(unknownAlignment.severity, "BLOCKER");

// 7. Invalid boolean values remain disabled
const invalidBooleanEnv = {
  ORCHESTRATOR_PROFILE: "LOCAL_SAFE",
  ORCHESTRATOR_OBJECTIVES_ENABLED: "invalid_value",
  ORCHESTRATOR_SKILLS_ENABLED: "2",
};
const invalidSnapshot = runtimeConfigSnapshot(invalidBooleanEnv);
assert.equal(invalidSnapshot.flags.objectives, false);
assert.equal(invalidSnapshot.flags.skills, false);

console.log("runtime-profile-contract.test.mjs: All tests passed!");
