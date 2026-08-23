function enabledValue(raw) {
  return ["1", "true", "on"].includes(String(raw ?? "0").trim().toLowerCase());
}

export function skillsEnabled(env = process.env) {
  return enabledValue(env.ORCHESTRATOR_SKILLS_ENABLED);
}

export function skillAutoRoutingEnabled(env = process.env) {
  return enabledValue(env.ORCHESTRATOR_SKILL_AUTO_ROUTING);
}

export function parallelObjectivesEnabled(env = process.env) {
  return enabledValue(env.ORCHESTRATOR_PARALLEL_OBJECTIVES);
}

export { enabledValue };
