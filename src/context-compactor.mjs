/**
 * Deterministic Context Compactor Engine
 * Compacts multi-turn conversational request-changes cycles into concise, high-signal context
 * to prevent context explosion and reduce token usage.
 */

import fs from "node:fs";
import path from "node:path";
import { formatInlineComments } from "./review-workflow.mjs";

export function retrieveRelevantPastExperience({
  task = {},
  project = {},
  vaultRoot = null,
  maxItems = 3,
} = {}) {
  if (!vaultRoot || typeof vaultRoot !== "string") return [];
  if (!fs.existsSync(vaultRoot)) return [];

  const candidateFolders = [
    path.join(vaultRoot, "01-Knowledge", "debugging"),
    path.join(vaultRoot, "01-Knowledge", "decisions"),
    path.join(vaultRoot, "01-Knowledge", "patterns"),
  ];

  const searchWords = new Set(
    [
      ...(task.title || "").toLowerCase().split(/[^a-z0-9_-]+/),
      ...(task.body || task.description || "").toLowerCase().split(/[^a-z0-9_-]+/),
      ...(task.allowedPaths || []).map((p) => path.basename(p).toLowerCase().replace(/\.[a-z0-9]+$/, "")),
      (project.id || "").toLowerCase(),
      (project.toolchain || "").toLowerCase(),
    ].filter((w) => w && w.length >= 3 && !["the", "and", "for", "with", "this", "from", "task"].includes(w))
  );

  const matched = [];

  for (const folder of candidateFolders) {
    if (!fs.existsSync(folder)) continue;
    let files = [];
    try {
      files = fs.readdirSync(folder, { recursive: true }).filter((f) => String(f).endsWith(".md"));
    } catch {
      continue;
    }

    for (const relFile of files) {
      const fullPath = path.join(folder, relFile);
      let content = "";
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const lower = content.toLowerCase();
      let score = 0;

      // Check project match in decisions
      if (project.id && lower.includes(project.id.toLowerCase())) {
        score += 3;
      }

      // Check search words match
      for (const word of searchWords) {
        if (lower.includes(word)) {
          score += 1;
        }
      }

      // Check allowed paths file match
      for (const targetPath of (task.allowedPaths || [])) {
        const base = path.basename(targetPath).toLowerCase();
        if (lower.includes(base)) {
          score += 4;
        }
      }

      if (score > 0) {
        const titleMatch = content.match(/^title:\s*["']?([^"'\n\r]+)["']?/m);
        const title = titleMatch ? titleMatch[1].trim() : path.basename(relFile, ".md");
        const typeMatch = content.match(/^type:\s*["']?([^"'\n\r]+)["']?/m);
        const type = typeMatch ? typeMatch[1].trim() : "debugging";

        let lesson = "";
        const fixMatch = content.match(/## (?:4\.\s*)?Solusi Terverifikasi[^\n]*\n+([\s\S]*?)(?=\n##|$)/i)
          || content.match(/## (?:2\.\s*)?Aturan & Batasan Wajib[^\n]*\n+([\s\S]*?)(?=\n##|$)/i)
          || content.match(/## Observation[^\n]*\n+([\s\S]*?)(?=\n##|$)/i);

        if (fixMatch) {
          lesson = fixMatch[1].trim().replace(/\s+/g, " ").slice(0, 300);
        } else {
          const cleanBody = content.replace(/^---[\s\S]*?---/, "").trim();
          lesson = cleanBody.slice(0, 200).replace(/\s+/g, " ");
        }

        matched.push({
          score,
          title,
          type,
          path: path.relative(vaultRoot, fullPath).split(path.sep).join("/"),
          lesson,
        });
      }
    }
  }

  matched.sort((a, b) => b.score - a.score);
  return matched.slice(0, maxItems);
}

export const STAGE_CONTEXT_BUDGETS = Object.freeze({
  intake: 1200,
  "cross-project-diagnostic": 2200,
  "project-decomposition": 2800,
  implementation: 6000,
  recovery: 4000,
  revision: 5000,
  retrospective: 1800,
  "knowledge-classification": 1800,
});

const DEFAULT_CONTEXT_BUDGET = 4000;

export const APPROVED_ROLE_RESPONSIBILITIES = Object.freeze({
  PLANNER: "Menjaga pemecahan pekerjaan, dependency, dan acceptance criteria tetap eksplisit.",
  DIAGNOSTIC: "Menelusuri gejala, dependency, dan root cause tanpa memperluas scope perubahan.",
  FRONTEND: "Memusatkan perhatian pada struktur UI, accessibility, state client, dan perilaku browser yang relevan.",
  BACKEND: "Memusatkan perhatian pada kontrak service, business logic, error handling, dan boundary API yang relevan.",
  DATABASE: "Memusatkan perhatian pada model data, query, migration safety, dan integritas persistence yang relevan.",
  INTEGRATION: "Memusatkan perhatian pada kontrak antar-komponen, wiring, dependency, dan hasil integrasi yang relevan.",
  TESTING: "Memusatkan perhatian pada coverage acceptance criteria, regression risk, dan kualitas verification.",
  REVIEW: "Memusatkan perhatian pada kesesuaian implementasi terhadap feedback, scope, dan acceptance criteria.",
  GENERAL: "Menyelesaikan acceptance criteria secara terarah dengan mengikuti scope dan guardrail yang telah disetujui.",
});

export function approvedRoleProfile(role) {
  const normalized = String(role ?? "GENERAL").trim().toUpperCase();
  const approvedRole = Object.hasOwn(APPROVED_ROLE_RESPONSIBILITIES, normalized) ? normalized : "GENERAL";
  return {
    role: approvedRole,
    responsibility: APPROVED_ROLE_RESPONSIBILITIES[approvedRole],
    lifetime: "RUN_SCOPED",
    temporary: true,
  };
}

export function roleAssignmentForTask(task = {}) {
  return approvedRoleProfile(task.role ?? task.metadata?.role ?? "GENERAL");
}

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
  project = {},
  acceptanceCriteria = [],
  latestFeedback = "",
  latestDiff = "",
  revisionState = {},
  allowedPaths = [],
  graphifyContext = "",
  knowledge = [],
  role = null,
  budgets = {},
  vaultRoot = null,
} = {}) {
  const budgetTokens = contextBudget(stage, budgets);
  const budgetCharacters = budgetTokens * 4;
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [acceptanceCriteria];
  const boundedKnowledge = selectBoundedKnowledge(knowledge);
  const roleProfile = approvedRoleProfile(role);
  const pastLessons = retrieveRelevantPastExperience({ task, project, vaultRoot });
  const pastLessonsText = pastLessons.length > 0
    ? pastLessons.map((item) => `- [${item.title}] (${item.type}): ${item.lesson}`).join("\n")
    : "";

  const sections = [
    ["ACCEPTANCE CRITERIA", criteria.filter(Boolean).map((item) => `- ${clean(item)}`).join("\n")],
    ["LATEST HUMAN FEEDBACK", latestFeedback],
    ...(role === null || role === undefined ? [] : [["APPROVED ROLE RESPONSIBILITY", [
      `Role: ${roleProfile.role}`,
      `Responsibility: ${roleProfile.responsibility}`,
      "Role ini advisory dan tidak dapat memperluas allowed paths, tools, capability tier, approval, atau lifecycle authority.",
    ].join("\n")]]),
    ["ALLOWED PATHS", allowedPaths.filter(Boolean).join(", ")],
    ...(pastLessonsText ? [["VERIFIED LESSONS & PAST DEBUGGING", pastLessonsText]] : []),
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
    role: roleProfile.role,
    roleResponsibility: roleProfile.responsibility,
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
