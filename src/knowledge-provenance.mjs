/** P8.0 provenance contract for durable global knowledge. */

export const KNOWLEDGE_PROVENANCE_SCHEMA_VERSION = 1;
export const KNOWLEDGE_PROVENANCE_OWNER = "knowledge-curator";
export const KNOWLEDGE_REVIEW_WINDOW_DAYS = 180;
export const KNOWLEDGE_SUPERSESSION_STATES = Object.freeze(["ACTIVE", "SUPERSEDED", "RETIRED"]);

function dateOnly(value) {
  return String(value ?? "").trim();
}

export function isKnowledgeDate(value) {
  const normalized = dateOnly(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

export function reviewDateFrom({ now = new Date(), days = KNOWLEDGE_REVIEW_WINDOW_DAYS } = {}) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + Math.max(1, Number(days) || KNOWLEDGE_REVIEW_WINDOW_DAYS));
  return date.toISOString().slice(0, 10);
}

export function buildKnowledgeProvenance({
  orchestratorRun,
  sources = [],
  confidence,
  owner = KNOWLEDGE_PROVENANCE_OWNER,
  reviewBy,
  supersession = "ACTIVE",
  now = new Date(),
} = {}) {
  const numericConfidence = Number(confidence);
  return {
    schemaVersion: KNOWLEDGE_PROVENANCE_SCHEMA_VERSION,
    orchestrator_run: String(orchestratorRun ?? "").trim(),
    sources: Array.isArray(sources) ? sources.map((source) => String(source).trim()).filter(Boolean) : [],
    confidence: Number.isFinite(numericConfidence) ? Math.max(0, Math.min(1, numericConfidence)) : null,
    owner: String(owner ?? KNOWLEDGE_PROVENANCE_OWNER).trim() || KNOWLEDGE_PROVENANCE_OWNER,
    review_by: isKnowledgeDate(reviewBy) ? dateOnly(reviewBy) : reviewDateFrom({ now }),
    supersession: KNOWLEDGE_SUPERSESSION_STATES.includes(String(supersession).toUpperCase()) ? String(supersession).toUpperCase() : "ACTIVE",
  };
}

export function validateKnowledgeProvenance(metadata = {}, { scope = "GLOBAL" } = {}) {
  if (String(scope).toUpperCase() === "PROJECT_ONLY") return { valid: true, missing: [], invalid: [], scope: "PROJECT_ONLY" };
  const missing = [];
  const invalid = [];
  if (metadata.provenance_schema !== undefined && Number(metadata.provenance_schema) !== KNOWLEDGE_PROVENANCE_SCHEMA_VERSION) invalid.push("provenance_schema");
  if (typeof metadata.orchestrator_run !== "string" || !metadata.orchestrator_run.trim()) missing.push("orchestrator_run");
  if (!Array.isArray(metadata.sources) || metadata.sources.length === 0 || metadata.sources.some((source) => typeof source !== "string" || !source.trim())) missing.push("sources");
  const confidence = Number(metadata.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) invalid.push("confidence");
  if (typeof metadata.owner !== "string" || !metadata.owner.trim()) missing.push("owner");
  if (!isKnowledgeDate(metadata.review_by)) invalid.push("review_by");
  if (!KNOWLEDGE_SUPERSESSION_STATES.includes(String(metadata.supersession ?? "").toUpperCase())) invalid.push("supersession");
  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid, scope: String(scope).toUpperCase() };
}
