const enabled = (value) => ["1", "true", "on"].includes(String(value ?? "0").trim().toLowerCase());

function boundedInteger(value, fallback, maximum = 8) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
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
  };
}
