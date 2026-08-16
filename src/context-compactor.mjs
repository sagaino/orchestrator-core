/**
 * Deterministic Context Compactor Engine
 * Compacts multi-turn conversational request-changes cycles into concise, high-signal context
 * to prevent context explosion and reduce token usage.
 */

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

  const prompt = `Anda sedang melanjutkan pengerjaan Task ${task?.id || "TASK"} pada project ${projectId || "PROJECT"}.

## Permintaan Perubahan (Human Review Feedback):
> ${reason.trim()}
${historySection}${diffSection}
## Batasan Wajib:
- Edit HANYA file di dalam allowed_paths: [${(allowedPaths || []).join(", ")}]
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
