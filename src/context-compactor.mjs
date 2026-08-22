/**
 * Deterministic Context Compactor Engine
 * Compacts multi-turn conversational request-changes cycles into concise, high-signal context
 * to prevent context explosion and reduce token usage.
 */

import { formatInlineComments } from "./review-workflow.mjs";

export const STAGE_CONTEXT_BUDGETS = Object.freeze({
  intake: 1200,
  implementation: 6000,
  recovery: 4000,
  revision: 5000,
  retrospective: 1800,
  "knowledge-classification": 1800,
});

const DEFAULT_CONTEXT_BUDGET = 4000;

export function contextBudget(stage, overrides = {}) {
  const value = overrides?.[stage] ?? STAGE_CONTEXT_BUDGETS[stage] ?? DEFAULT_CONTEXT_BUDGET;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONTEXT_BUDGET;
}

function clean(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function selectBoundedKnowledge(knowledge = [], maxItems = 3, maxCharacters = 2400) {
  if (!Array.isArray(knowledge) || maxItems <= 0 || maxCharacters <= 0) return [];
  let used = 0;
  const selected = [];
  const ranked = [...knowledge].sort((left, right) => (Number(right?.score ?? 0) - Number(left?.score ?? 0)) || String(left?.path ?? "").localeCompare(String(right?.path ?? "")));
  for (const item of ranked) {
    if (!item || typeof item !== "object") continue;
    const summary = clean(item.summary || item.title || item.path);
    const candidate = { ...item, summary: summary.slice(0, 700) };
    const size = JSON.stringify(candidate).length;
    if (selected.length >= maxItems) break;
    if (used + size > maxCharacters) continue;
    selected.push(candidate);
    used += size;
  }
  return selected;
}

function bounded(value, maxCharacters) {
  const text = clean(value);
  return text.length <= maxCharacters ? text : `${text.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

/** Build a deterministic, priority-ordered context pack for an execution stage. */
export function buildStageContext({
  stage = "implementation",
  task = {},
  acceptanceCriteria = [],
  latestFeedback = "",
  latestDiff = "",
  revisionState = {},
  allowedPaths = [],
  graphifyContext = "",
  knowledge = [],
  budgets = {},
} = {}) {
  const budgetTokens = contextBudget(stage, budgets);
  const budgetCharacters = budgetTokens * 4;
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [acceptanceCriteria];
  const boundedKnowledge = selectBoundedKnowledge(knowledge);
  const sections = [
    ["ACCEPTANCE CRITERIA", criteria.filter(Boolean).map((item) => `- ${clean(item)}`).join("\n")],
    ["LATEST HUMAN FEEDBACK", latestFeedback],
    ["ALLOWED PATHS", allowedPaths.filter(Boolean).join(", ")],
    ["LATEST DIFF", latestDiff],
    ["COMPACT REVISION STATE", Object.entries(revisionState || {}).map(([key, value]) => `${key}: ${clean(value)}`).join("\n")],
    ["GRAPHIFY DELTA", graphifyContext],
    ["BOUNDED KNOWLEDGE", boundedKnowledge.slice(0, 1).map((item) => `- ${item.path || item.title}: ${item.summary}`).join("\n")],
  ];
  let remaining = budgetCharacters;
  const output = [];
  const priority = new Map([["ACCEPTANCE CRITERIA", Math.floor(budgetCharacters * 0.22)], ["LATEST HUMAN FEEDBACK", Math.floor(budgetCharacters * 0.22)]]);
  for (const [label, value] of sections.filter(([name]) => priority.has(name))) {
    if (!value || remaining <= 0) continue;
    const prefix = `=== ${label} ===\n`;
    const room = Math.min(remaining - prefix.length, priority.get(label) ?? remaining - prefix.length);
    if (room <= 0) break;
    const body = bounded(value, room);
    output.push(`${prefix}${body}`);
    remaining -= prefix.length + body.length + 1;
  }
  for (const [label, value] of sections.filter(([name]) => !priority.has(name))) {
    if (!value || remaining <= 0) continue;
    const prefix = `=== ${label} ===\n`;
    const room = remaining - prefix.length;
    if (room <= 0) break;
    const body = bounded(value, room);
    output.push(`${prefix}${body}`);
    remaining -= prefix.length + body.length + 1;
  }
  return {
    stage,
    budgetTokens,
    estimatedTokens: estimateTokenCount(output.join("\n")),
    text: output.join("\n"),
    selectedKnowledge: boundedKnowledge,
  };
}

export function estimateTokenCount(text = "") {
  if (!text || typeof text !== "string") return 0;
  // Standard approximation: ~4 characters per token for typical code + english text
  return Math.ceil(text.length / 4);
}

export function compactRevisionHistory(revisions = []) {
  if (!Array.isArray(revisions) || revisions.length === 0) return [];

  return revisions.map((rev, index) => {
    const round = index + 1;
    const reason = typeof rev === "string" ? rev : rev.reason || rev.feedback || "";
    // Clean up reason: trim redundant whitespace, limit to 500 chars
    const condensedReason = reason.trim().replace(/\s+/g, " ").slice(0, 500);

    return {
      round,
      requestedAt: rev.requestedAt || null,
      reason: condensedReason,
    };
  });
}

export function buildCompactedRevisionPrompt({
  task,
  projectId,
  reason,
  previousRevisions = [],
  latestDiff = "",
  allowedPaths = [],
  inlineComments = [],
}) {
  const compactedHistory = compactRevisionHistory(previousRevisions);
  
  let historySection = "";
  if (compactedHistory.length > 0) {
    historySection = `\n## Ringkasan Riwayat Revisi Sebelumnya:\n` +
      compactedHistory
        .map((h) => `- **Putaran ${h.round}**: ${h.reason}`)
        .join("\n") + "\n";
  }

  let diffSection = "";
  if (latestDiff && latestDiff.trim()) {
    // Truncate very long diffs to keep prompt lean (max 4000 chars)
    const truncatedDiff = latestDiff.length > 4000
      ? latestDiff.slice(0, 4000) + "\n... [diff truncated for brevity]"
      : latestDiff;
    diffSection = `\n## Diff Kode Saat Ini di Workspace:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
  }

  let inlineCommentsSection = "";
  if (Array.isArray(inlineComments) && inlineComments.length > 0) {
    const formatted = formatInlineComments(inlineComments);
    if (formatted) {
      inlineCommentsSection = `\n${formatted}\n\nInstruksi: Prioritaskan perbaikan pada baris-baris spesifik yang diberi catatan oleh reviewer di atas.\n`;
    }
  }

  const prompt = `Anda sedang melanjutkan pengerjaan Task ${task?.id || "TASK"} pada project ${projectId || "PROJECT"}.

## Permintaan Perubahan (Human Review Feedback):
> ${reason.trim()}
${inlineCommentsSection}${historySection}${diffSection}
## Batasan Wajib:
- Edit HANYA file di dalam allowed_paths: [${(allowedPaths || []).join(", ")}]
- Prioritaskan perbaikan pada baris-baris spesifik yang diberi catatan oleh reviewer jika terdapat inline code comments.
- Perbaiki poin-poin yang diminta di atas hingga seluruh verifikasi lolos.
`;

  // Raw uncompacted calculation comparison
  const rawEstimatedTokens = estimateTokenCount(
    (task?.body || "") +
    previousRevisions.map((r) => JSON.stringify(r)).join("\n") +
    latestDiff +
    reason
  );
  const compactedTokens = estimateTokenCount(prompt);
  const tokensSaved = Math.max(0, rawEstimatedTokens - compactedTokens);
  const savingsRatio = rawEstimatedTokens > 0 ? tokensSaved / rawEstimatedTokens : 0;

  return {
    prompt,
    stats: {
      rawEstimatedTokens,
      compactedTokens,
      tokensSaved,
      savingsRatio: Number(savingsRatio.toFixed(2)),
    },
  };
}
