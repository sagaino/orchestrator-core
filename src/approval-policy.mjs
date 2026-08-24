export const APPROVAL_MODES = Object.freeze({
  MANUAL: "MANUAL",
  PLAN_REVIEW_THEN_AUTOPILOT: "PLAN_REVIEW_THEN_AUTOPILOT",
  FINAL_ACCEPT_ONLY: "FINAL_ACCEPT_ONLY",
});

export function approvalMode(env = process.env) {
  const value = String(env.ORCHESTRATOR_APPROVAL_MODE ?? APPROVAL_MODES.MANUAL).trim().toUpperCase();
  return Object.values(APPROVAL_MODES).includes(value) ? value : APPROVAL_MODES.MANUAL;
}

export function finalAcceptOnlyEnabled(env = process.env) {
  return approvalMode(env) === APPROVAL_MODES.FINAL_ACCEPT_ONLY;
}

export function planReviewThenAutopilotEnabled(env = process.env) {
  return approvalMode(env) === APPROVAL_MODES.PLAN_REVIEW_THEN_AUTOPILOT;
}

export function autopilotAfterPlanApprovalEnabled(env = process.env) {
  return approvalMode(env) !== APPROVAL_MODES.MANUAL;
}

export function automaticDeliveryCertificationEnabled(env = process.env) {
  return autopilotAfterPlanApprovalEnabled(env);
}

export function automaticReviewFinalizationEnabled(env = process.env) {
  const explicit = env.ORCHESTRATOR_AUTO_FINALIZE_TASKS ?? env.ORCHESTRATOR_AUTO_ACCEPT_TASKS;
  if (explicit !== undefined) {
    const normalized = String(explicit).trim().toLowerCase();
    return ["1", "true", "on"].includes(normalized);
  }
  return autopilotAfterPlanApprovalEnabled(env);
}

export function automationPolicy(env = process.env) {
  const finalOnly = finalAcceptOnlyEnabled(env);
  return {
    approvalMode: approvalMode(env),
    finalAcceptOnly: finalOnly,
    planReviewRequired: planReviewThenAutopilotEnabled(env),
    automaticPlanApproval: finalOnly,
    automaticMaterialization: autopilotAfterPlanApprovalEnabled(env),
    automaticDeliveryCertification: automaticDeliveryCertificationEnabled(env),
    automaticReviewFinalization: automaticReviewFinalizationEnabled(env),
    automaticRecovery: String(env.ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS ?? "2") !== "0",
  };
}
