const VALID_EFFORTS = new Set(["low", "medium", "high"]);

export const DEFAULT_AGY_MODEL = "gemini-3.7-flash-high";
export const DEFAULT_AGY_EFFORT = "high";

export const STAGE_DEFAULT_EFFORTS = Object.freeze({
  "task-intake": "low",
  "TASK_INTAKE": "low",
  "retrospective": "low",
  "RETROSPECTIVE": "low",
  "implementation": "high",
  "recovery": "high",
});

export function resolveAgyConfig(env = process.env, stage = "implementation") {
  const rawModel = String(env.ORCHESTRATOR_AGY_MODEL ?? DEFAULT_AGY_MODEL).trim();
  if (!rawModel) throw new Error("ORCHESTRATOR_AGY_MODEL tidak boleh kosong.");

  let defaultForStage = STAGE_DEFAULT_EFFORTS[stage] ?? DEFAULT_AGY_EFFORT;
  if ((stage === "task-intake" || stage === "TASK_INTAKE") && env.ORCHESTRATOR_INTAKE_EFFORT) {
    defaultForStage = env.ORCHESTRATOR_INTAKE_EFFORT;
  } else if ((stage === "retrospective" || stage === "RETROSPECTIVE") && env.ORCHESTRATOR_RETRO_EFFORT) {
    defaultForStage = env.ORCHESTRATOR_RETRO_EFFORT;
  }

  const effort = String(env.ORCHESTRATOR_AGY_EFFORT ?? defaultForStage).trim().toLowerCase();
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`ORCHESTRATOR_AGY_EFFORT tidak valid: ${effort}. Gunakan low, medium, atau high.`);
  }

  let model = rawModel;
  // Match model suffix with effort to prevent agy CLI conflict
  if (effort === "high") {
    if (model === "gemini-3.7-flash") model = "gemini-3.7-flash-high";
  } else if (effort === "medium") {
    if (model === "gemini-3.7-flash-high" || model === "gemini-3.7-flash-low") model = "gemini-3.7-flash-medium";
  } else if (effort === "low") {
    if (model.endsWith("-high") || model.endsWith("-medium")) {
      model = model.replace(/-(high|medium)$/, "");
    }
  }

  return { model, effort };
}

export function agyConfigArgs(config = resolveAgyConfig()) {
  return ["--model", config.model, "--effort", config.effort];
}
