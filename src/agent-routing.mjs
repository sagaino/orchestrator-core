/**
 * Frozen routing policy for agent work.  The policy is deliberately pure so
 * callers can test routing without invoking a provider.
 */
export const ROUTING_TIERS = Object.freeze({ ECONOMY: "ECONOMY", STRONG_REVIEW: "STRONG_REVIEW" });
export const ROUTING_STAGES = Object.freeze([
  "task-intake",
  "project-decomposition",
  "retrospective",
  "knowledge-classification",
  "implementation",
  "recovery",
]);

const STAGE_ALIASES = Object.freeze({
  TASK_INTAKE: "task-intake",
  PROJECT_DECOMPOSITION: "project-decomposition",
  RETROSPECTIVE: "retrospective",
  KNOWLEDGE: "knowledge-classification",
  KNOWLEDGE_CLASSIFICATION: "knowledge-classification",
  AUTOMATIC_RECOVERY: "recovery",
});

const TIER_RANK = Object.freeze({ ECONOMY: 0, STRONG_REVIEW: 1 });
const HIGH_VALUES = new Set(["HIGH", "UNKNOWN"]);
const ECONOMY_TIER_LABELS = new Set(["ECONOMY", "LOW", "MEDIUM"]);
const STRONG_TIER_LABELS = new Set(["STRONG", "STRONG_REVIEW", "HIGH"]);

function normalized(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return text || "UNKNOWN";
}

const KNOWN_VALUES = new Set(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]);

function canonicalStage(stage) {
  const value = normalized(stage).toLowerCase();
  return STAGE_ALIASES[normalized(stage)] ?? value;
}

function canonicalTier(value) {
  if (value === undefined || value === null || String(value).trim() === "") return ROUTING_TIERS.ECONOMY;
  const text = normalized(value).replace(/[\s-]+/g, "_");
  if (STRONG_TIER_LABELS.has(text)) return ROUTING_TIERS.STRONG_REVIEW;
  return ROUTING_TIERS.ECONOMY;
}

/**
 * Resolve the minimum permitted tier. Unknown stage/risk/complexity is
 * intentionally fail-safe and selects strong review.
 */
export function resolveAgentRoute({ stage, risk, complexity, requestedTier, requestedLabel } = {}) {
  const canonical = canonicalStage(stage);
  const normalizedRisk = normalized(risk);
  const normalizedComplexity = normalized(complexity);
  const requestedInput = requestedTier ?? requestedLabel;
  const requested = canonicalTier(requestedInput);
  const reasons = [];

  let tier = canonical === "recovery" ? ROUTING_TIERS.STRONG_REVIEW : ROUTING_TIERS.ECONOMY;
  if (!KNOWN_VALUES.has(normalizedRisk)) {
    tier = ROUTING_TIERS.STRONG_REVIEW;
    reasons.push("unrecognized-risk");
  }
  if (!KNOWN_VALUES.has(normalizedComplexity)) {
    tier = ROUTING_TIERS.STRONG_REVIEW;
    reasons.push("unrecognized-complexity");
  }
  if (!ROUTING_STAGES.includes(canonical)) {
    tier = ROUTING_TIERS.STRONG_REVIEW;
    reasons.push("unknown-stage");
  }
  if (canonical === "recovery") reasons.push("recovery-requires-review");
  if (HIGH_VALUES.has(normalizedRisk)) {
    tier = ROUTING_TIERS.STRONG_REVIEW;
    reasons.push(`${normalizedRisk.toLowerCase()}-risk`);
  }
  if (HIGH_VALUES.has(normalizedComplexity)) {
    tier = ROUTING_TIERS.STRONG_REVIEW;
    reasons.push(`${normalizedComplexity.toLowerCase()}-complexity`);
  }
  if (
    requestedInput !== undefined
    && requestedInput !== null
    && String(requestedInput).trim() !== ""
    && !ECONOMY_TIER_LABELS.has(normalized(requestedInput).replace(/[\s-]+/g, "_"))
    && !STRONG_TIER_LABELS.has(normalized(requestedInput).replace(/[\s-]+/g, "_"))
  ) {
    tier = ROUTING_TIERS.STRONG_REVIEW;
    reasons.push("unrecognized-requested-tier");
  }
  if (requested === ROUTING_TIERS.STRONG_REVIEW) {
    tier = ROUTING_TIERS.STRONG_REVIEW;
    reasons.push("requested-strong-review");
  }

  return Object.freeze({
    stage: canonical,
    risk: normalizedRisk,
    complexity: normalizedComplexity,
    requestedTier: requested,
    tier,
    strongerTierRequired: TIER_RANK[tier] > TIER_RANK[requested],
    reasons: Object.freeze(reasons),
  });
}

export function tierRequiresStrongReview(tier) {
  return canonicalTier(tier) === ROUTING_TIERS.STRONG_REVIEW;
}
