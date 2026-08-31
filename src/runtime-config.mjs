import { automaticReviewFinalizationEnabled } from "./approval-policy.mjs";

const enabled = (value) => ["1", "true", "on"].includes(String(value ?? "0").trim().toLowerCase());
const approvalMode = (value) => {
  const normalized = String(value ?? "MANUAL").trim().toUpperCase();
  return ["MANUAL", "PLAN_REVIEW_THEN_AUTOPILOT", "FINAL_ACCEPT_ONLY"].includes(normalized) ? normalized : "MANUAL";
};

function boundedInteger(value, fallback, maximum = 8) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

export const RUNTIME_PROFILE_CONTRACTS = Object.freeze({
  LOCAL_SAFE: Object.freeze({
    profile: "LOCAL_SAFE",
    flags: Object.freeze({
      objectives: false,
      objectiveScheduler: false,
      parallelObjectives: false,
      sameProjectParallel: false,
      crossProject: false,
      skills: false,
      skillAutoRouting: false,
      telegram: false,
    }),
    capacity: Object.freeze({
      maxParallelJobs: 2,
    }),
    automation: Object.freeze({
      approvalMode: "MANUAL",
      planReviewRequired: false,
      automaticPlanApproval: false,
      automaticMaterialization: false,
      automaticDeliveryCertification: false,
      automaticReviewFinalization: false,
      automaticRecoveryAttempts: 2,
    }),
  }),
  LOCAL_PILOT: Object.freeze({
    profile: "LOCAL_PILOT",
    flags: Object.freeze({
      objectives: true,
      objectiveScheduler: true,
      parallelObjectives: false,
      sameProjectParallel: false,
      crossProject: true,
      skills: false,
      skillAutoRouting: false,
      telegram: false,
    }),
    capacity: Object.freeze({
      maxParallelJobs: 3,
    }),
    automation: Object.freeze({
      approvalMode: "PLAN_REVIEW_THEN_AUTOPILOT",
      planReviewRequired: true,
      automaticPlanApproval: false,
      automaticMaterialization: true,
      automaticDeliveryCertification: true,
      automaticReviewFinalization: false,
      automaticRecoveryAttempts: 2,
    }),
  }),
});

export const RUNTIME_PROFILE_LOCAL_SAFE = RUNTIME_PROFILE_CONTRACTS.LOCAL_SAFE;
export const RUNTIME_PROFILE_LOCAL_PILOT = RUNTIME_PROFILE_CONTRACTS.LOCAL_PILOT;

/**
 * Compares an effective runtime configuration snapshot against its declared profile contract.
 */
export function validateRuntimeProfileAlignment(snapshot) {
  const rawProfile = String(snapshot?.profile ?? "LOCAL_SAFE").trim();
  const normalizedProfile = rawProfile.toUpperCase();
  const contract = RUNTIME_PROFILE_CONTRACTS[normalizedProfile];

  if (!contract) {
    return {
      profile: rawProfile || "UNKNOWN_PROFILE",
      contractFound: false,
      aligned: false,
      severity: "BLOCKER",
      mismatches: [
        {
          field: "profile",
          expected: "LOCAL_SAFE | LOCAL_PILOT",
          actual: snapshot?.profile ?? null,
          severity: "BLOCKER",
        },
      ],
    };
  }

  const mismatches = [];

  for (const [flag, expected] of Object.entries(contract.flags)) {
    const actual = snapshot?.flags?.[flag];
    if (actual !== expected) {
      mismatches.push({
        field: `flags.${flag}`,
        expected,
        actual,
        severity: "BLOCKER",
      });
    }
  }

  if (snapshot?.capacity?.maxParallelJobs !== contract.capacity.maxParallelJobs) {
    mismatches.push({
      field: "capacity.maxParallelJobs",
      expected: contract.capacity.maxParallelJobs,
      actual: snapshot?.capacity?.maxParallelJobs,
      severity: "BLOCKER",
    });
  }

  for (const [autoKey, expected] of Object.entries(contract.automation)) {
    const actual = snapshot?.automation?.[autoKey];
    if (actual !== expected) {
      mismatches.push({
        field: `automation.${autoKey}`,
        expected,
        actual,
        severity: "BLOCKER",
      });
    }
  }

  return {
    profile: normalizedProfile,
    contractFound: true,
    aligned: mismatches.length === 0,
    severity: mismatches.length === 0 ? "INFO" : "BLOCKER",
    mismatches,
  };
}

/**
 * Returns the effective local runtime profile without exposing provider secrets.
 * The profile is descriptive; individual flags remain the source of truth.
 */
export function runtimeConfigSnapshot(env = process.env) {
  return {
    schemaVersion: 1,
    profile: String(env.ORCHESTRATOR_PROFILE ?? "LOCAL_SAFE").trim() || "LOCAL_SAFE",
    flags: {
      objectives: enabled(env.ORCHESTRATOR_OBJECTIVES_ENABLED),
      objectiveScheduler: enabled(env.ORCHESTRATOR_OBJECTIVE_SCHEDULER),
      parallelObjectives: enabled(env.ORCHESTRATOR_PARALLEL_OBJECTIVES),
      sameProjectParallel: enabled(env.ORCHESTRATOR_SAME_PROJECT_PARALLEL),
      crossProject: enabled(env.ORCHESTRATOR_CROSS_PROJECT),
      skills: enabled(env.ORCHESTRATOR_SKILLS_ENABLED),
      skillAutoRouting: enabled(env.ORCHESTRATOR_SKILL_AUTO_ROUTING),
      telegram: enabled(env.ORCHESTRATOR_TELEGRAM_ENABLED),
    },
    capacity: {
      maxParallelJobs: boundedInteger(env.ORCHESTRATOR_MAX_PARALLEL_JOBS, 2),
    },
    automation: {
      approvalMode: approvalMode(env.ORCHESTRATOR_APPROVAL_MODE),
      planReviewRequired: approvalMode(env.ORCHESTRATOR_APPROVAL_MODE) === "PLAN_REVIEW_THEN_AUTOPILOT",
      automaticPlanApproval: approvalMode(env.ORCHESTRATOR_APPROVAL_MODE) === "FINAL_ACCEPT_ONLY",
      automaticMaterialization: approvalMode(env.ORCHESTRATOR_APPROVAL_MODE) !== "MANUAL",
      automaticDeliveryCertification: approvalMode(env.ORCHESTRATOR_APPROVAL_MODE) !== "MANUAL",
      automaticReviewFinalization: automaticReviewFinalizationEnabled(env),
      automaticRecoveryAttempts: Number.isInteger(Number(env.ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS))
        ? Number(env.ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS)
        : 2,
    },
  };
}
