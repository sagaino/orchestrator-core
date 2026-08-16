const VALID_EFFORTS = new Set(["low", "medium", "high"]);

export const DEFAULT_AGY_MODEL = "gemini-3.7-flash-high";
export const DEFAULT_AGY_EFFORT = "high";

export function resolveAgyConfig(env = process.env) {
  const model = String(env.ORCHESTRATOR_AGY_MODEL ?? DEFAULT_AGY_MODEL).trim();
  const effort = String(env.ORCHESTRATOR_AGY_EFFORT ?? DEFAULT_AGY_EFFORT).trim().toLowerCase();
  if (!model) throw new Error("ORCHESTRATOR_AGY_MODEL tidak boleh kosong.");
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`ORCHESTRATOR_AGY_EFFORT tidak valid: ${effort}. Gunakan low, medium, atau high.`);
  }
  return { model, effort };
}

export function agyConfigArgs(config = resolveAgyConfig()) {
  return ["--model", config.model, "--effort", config.effort];
}
