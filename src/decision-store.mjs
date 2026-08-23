import { validateDecisionRecord } from "./orchestration-schema.mjs";
import { createDurableRecordStore } from "./orchestration-store.mjs";

export const decisionStore = createDurableRecordStore({ collection: "decisions", idField: "decisionId", validate: validateDecisionRecord });
export const createDecision = decisionStore.create;
export const getDecision = decisionStore.get;
export const listDecisions = decisionStore.list;

const RISK_SCORES = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 });
const TYPE_RISK = Object.freeze({
  INTEGRATION_CONFLICT: "HIGH",
  SCOPE_EXPANSION: "HIGH",
  FRESH_PROJECT_CREATION: "HIGH",
  NODE_RETRY: "MEDIUM",
  PLAN_CLARIFICATION: "MEDIUM",
  PLAN_APPROVAL: "MEDIUM",
  OBJECTIVE_ACCEPTANCE: "LOW",
});

function riskLevel(decision) {
  const evidence = decision?.evidence && typeof decision.evidence === "object" && !Array.isArray(decision.evidence)
    ? decision.evidence
    : {};
  const candidate = decision?.risk ?? evidence.risk ?? evidence.planRisk ?? evidence.nodeRisk ?? TYPE_RISK[decision?.type] ?? "UNKNOWN";
  const normalized = String(candidate).trim().toUpperCase();
  return Object.hasOwn(RISK_SCORES, normalized) ? normalized : "UNKNOWN";
}

export function listDecisionInbox(runsRoot, { objectiveId = null, state = "OPEN", limit = 100, now = new Date() } = {}) {
  const boundedLimit = Math.min(100, Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 100));
  const nowMs = new Date(now).getTime();
  return listDecisions(runsRoot)
    .filter((decision) => !state || decision.state === state)
    .filter((decision) => !objectiveId || decision.objectiveId === objectiveId)
    .map((decision) => {
      const risk = riskLevel(decision);
      const createdMs = new Date(decision.createdAt).getTime();
      return {
        ...decision,
        risk,
        riskScore: RISK_SCORES[risk],
        ageMs: Number.isFinite(createdMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - createdMs) : null,
      };
    })
    .sort((left, right) => right.riskScore - left.riskScore || left.createdAt.localeCompare(right.createdAt) || left.decisionId.localeCompare(right.decisionId))
    .slice(0, boundedLimit);
}

export function updateDecision(options = {}) {
  return decisionStore.update({ ...options, id: options.id ?? options.decisionId });
}
export const decisionPath = decisionStore.pathFor;
