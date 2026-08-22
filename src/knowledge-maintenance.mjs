import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { findKnowledgeDuplicates, findKnowledgeStale, listKnowledgeDocuments } from "./knowledge-quality.mjs";

const DECISIONS_DIRECTORY = path.join("03-Sources", "other", "knowledge-decisions");

function checksum(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function toRelative(vaultRoot, absolute) {
  return path.relative(vaultRoot, absolute).split(path.sep).join("/");
}

function ensureKnowledgePage(vaultRoot, selector) {
  let relative = String(selector ?? "").trim().replaceAll("\\", "/");
  relative = relative.replace(/^\.?\//, "").replace(/\.md$/, "");
  if (!relative.startsWith("01-Knowledge/")) throw new Error("P8.1 merge hanya menerima halaman global di 01-Knowledge.");
  const absolute = path.resolve(vaultRoot, `${relative}.md`);
  const root = path.resolve(vaultRoot, "01-Knowledge");
  const boundary = path.relative(root, absolute);
  if (boundary.startsWith("..") || path.isAbsolute(boundary)) throw new Error("Target knowledge berada di luar root yang diizinkan.");
  if (!fs.existsSync(absolute)) throw new Error(`Knowledge page tidak ditemukan: ${selector}`);
  if (path.basename(absolute).startsWith("_Template")) throw new Error("Template knowledge tidak dapat diproses.");
  return { absolute, relative: toRelative(vaultRoot, absolute) };
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function setFrontmatterField(content, field, value) {
  const line = `${field}: ${value}`;
  const pattern = new RegExp(`^${field}:.*$`, "m");
  return pattern.test(content) ? content.replace(pattern, line) : content.replace(/^---\r?\n/, `---\n${line}\n`);
}

function appendSupersession(content, sourceRelative, targetRelative, at, by) {
  let updated = setFrontmatterField(content, "supersession", "SUPERSEDED");
  updated = setFrontmatterField(updated, "superseded_by", `[[${targetRelative.replace(/\.md$/, "")}]]`);
  updated = setFrontmatterField(updated, "updated", at.slice(0, 10));
  const marker = `<!-- p8-1-merge:${targetRelative} -->`;
  if (!updated.includes(marker)) {
    updated = `${updated.trimEnd()}\n\n## Superseded by consolidated knowledge\n\n${marker}\n- Target: [[${targetRelative.replace(/\.md$/, "")}]]\n- Source retained for audit and rollback.\n- Applied at: ${at}\n- Approved by: ${by}\n`;
  }
  return updated;
}

function proposedTargetAppend(source, targetRelative, at) {
  return [
    `## Consolidated from ${source.title}`,
    "",
    `<!-- p8-1-merge:${source.path}->${targetRelative} -->`,
    `Source retained at [[${source.path.replace(/\.md$/, "")}]]; this section is an explicit, human-approved consolidation.`,
    "",
    source.body.trim(),
    "",
    `_Consolidated at ${at}; original source remains available for rollback._`,
    "",
  ].join("\n");
}

function updateIndex(indexContent, sourceRelative, targetRelative, targetTitle) {
  const sourceTarget = sourceRelative.replace(/\.md$/, "");
  const targetTarget = targetRelative.replace(/\.md$/, "");
  const lines = String(indexContent ?? "").split(/\r?\n/);
  let changed = false;
  const updated = lines.map((line) => {
    if (!line.includes(`[[${sourceTarget}`)) return line;
    changed = true;
    return `- [[${targetTarget}|${targetTitle}]]`;
  });
  return { content: updated.join("\n"), changed };
}

function artifactPath(vaultRoot, planId) {
  return path.join(vaultRoot, DECISIONS_DIRECTORY, `${planId}.json`);
}

function readMergeArtifact(vaultRoot, selector) {
  const directory = path.join(vaultRoot, DECISIONS_DIRECTORY);
  if (!fs.existsSync(directory)) throw new Error(`Merge artifact tidak ditemukan: ${selector}`);
  const normalized = String(selector ?? "").trim();
  const candidates = fs.readdirSync(directory).filter((name) => name.endsWith(".json") && (name === normalized || name === `${normalized}.json` || name.startsWith(`${normalized}-`)));
  if (candidates.length !== 1) throw new Error(candidates.length === 0 ? `Merge artifact tidak ditemukan: ${selector}` : `Merge artifact ambigu: ${selector}`);
  const absolute = path.join(directory, candidates[0]);
  const artifact = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (artifact.action !== "KNOWLEDGE_MERGE") throw new Error(`Artifact bukan P8.1 merge plan: ${selector}`);
  return { absolute, artifact };
}

export function listKnowledgeMaintenance({ vaultRoot, now = new Date(), dueSoonDays = 30 } = {}) {
  const duplicates = findKnowledgeDuplicates({ vaultRoot });
  const stale = findKnowledgeStale({ vaultRoot, now, dueSoonDays });
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_MAINTENANCE",
    mode: "read-only",
    generatedAt: new Date(now).toISOString(),
    duplicates,
    stale,
    summary: {
      duplicateCandidates: duplicates.length,
      staleReviewItems: stale.length,
      exactTitleDuplicates: duplicates.filter((item) => item.kind === "EXACT_TITLE").length,
      contradictionCandidates: duplicates.filter((item) => item.contradictionCandidate).length,
    },
    guardrail: "Tidak ada content deletion atau automatic merge. Semua merge membutuhkan preview, checksum check, dan human confirmation.",
  };
}

export function previewKnowledgeMerge({ vaultRoot, sourcePath, targetPath, now = new Date() } = {}) {
  const source = ensureKnowledgePage(vaultRoot, sourcePath);
  const target = ensureKnowledgePage(vaultRoot, targetPath);
  if (source.relative === target.relative) throw new Error("Source dan target merge harus berbeda.");
  const sourceDocument = listKnowledgeDocuments({ vaultRoot }).find((document) => document.path === source.relative);
  const targetDocument = listKnowledgeDocuments({ vaultRoot }).find((document) => document.path === target.relative);
  if (!sourceDocument || !targetDocument) throw new Error("Source atau target bukan managed knowledge page.");
  const sourceContent = fs.readFileSync(source.absolute, "utf8");
  const targetContent = fs.readFileSync(target.absolute, "utf8");
  const at = new Date(now).toISOString();
  const append = proposedTargetAppend(sourceDocument, target.relative, at);
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_MERGE_PREVIEW",
    mode: "read-only",
    source: { path: source.relative, title: sourceDocument.title, checksum: checksum(sourceContent), bytes: Buffer.byteLength(sourceContent) },
    target: { path: target.relative, title: targetDocument.title, checksum: checksum(targetContent), bytes: Buffer.byteLength(targetContent) },
    similarity: findKnowledgeDuplicates({ vaultRoot }).find((item) => (item.left.path === source.relative && item.right.path === target.relative) || (item.left.path === target.relative && item.right.path === source.relative)) ?? null,
    proposedChanges: {
      targetAppend: append,
      sourceMetadata: { supersession: "SUPERSEDED", supersededBy: `[[${target.relative.replace(/\.md$/, "")}]]` },
      sourceRetained: true,
      indexUpdate: "Replace source index link with target link when present; previous index content is stored for rollback.",
    },
    confirmation: { required: true, phrase: "MERGE_KNOWLEDGE", expectedSourceChecksum: checksum(sourceContent), expectedTargetChecksum: checksum(targetContent) },
    guardrail: "Preview tidak mengubah file. Apply tidak menghapus source; apply membuat audit snapshot dan reversible index update.",
  };
}

export function applyKnowledgeMerge({ vaultRoot, sourcePath, targetPath, approvedBy = "user", confirmed = false, expectedSourceChecksum = null, expectedTargetChecksum = null, now = new Date() } = {}) {
  if (confirmed !== true) throw new Error("Knowledge merge membutuhkan confirmation eksplisit (MERGE_KNOWLEDGE).");
  const preview = previewKnowledgeMerge({ vaultRoot, sourcePath, targetPath, now });
  const sourceContent = fs.readFileSync(path.join(vaultRoot, preview.source.path), "utf8");
  const targetContent = fs.readFileSync(path.join(vaultRoot, preview.target.path), "utf8");
  if (expectedSourceChecksum && expectedSourceChecksum !== preview.source.checksum) throw new Error("Source berubah setelah preview; jalankan preview ulang.");
  if (expectedTargetChecksum && expectedTargetChecksum !== preview.target.checksum) throw new Error("Target berubah setelah preview; jalankan preview ulang.");
  const by = String(approvedBy).trim() || "user";
  const appliedAt = new Date(now).toISOString();
  const targetUpdated = `${targetContent.trimEnd()}\n\n${proposedTargetAppend({ ...listKnowledgeDocuments({ vaultRoot }).find((document) => document.path === preview.source.path), path: preview.source.path }, preview.target.path, appliedAt)}`;
  const sourceUpdated = appendSupersession(sourceContent, preview.source.path, preview.target.path, appliedAt, by);
  const indexPath = path.join(vaultRoot, "index.md");
  const indexBefore = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : null;
  const targetDocument = listKnowledgeDocuments({ vaultRoot }).find((document) => document.path === preview.target.path);
  const indexResult = updateIndex(indexBefore, preview.source.path, preview.target.path, targetDocument.title);
  const planId = `p8-1-merge-${appliedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
  const artifact = {
    schemaVersion: 1,
    immutable: true,
    action: "KNOWLEDGE_MERGE",
    planId,
    appliedAt,
    approvedBy: by,
    source: { path: preview.source.path, before: sourceContent, after: sourceUpdated, beforeChecksum: checksum(sourceContent), afterChecksum: checksum(sourceUpdated) },
    target: { path: preview.target.path, before: targetContent, after: targetUpdated, beforeChecksum: checksum(targetContent), afterChecksum: checksum(targetUpdated) },
    index: { path: "index.md", before: indexBefore, after: indexResult.changed ? indexResult.content : indexBefore, beforeChecksum: checksum(indexBefore ?? ""), afterChecksum: checksum(indexResult.changed ? indexResult.content : indexBefore ?? "") },
    sourceRetained: true,
    indexReversible: true,
  };
  const artifactAbsolute = artifactPath(vaultRoot, planId);
  fs.mkdirSync(path.dirname(artifactAbsolute), { recursive: true });
  fs.writeFileSync(artifactAbsolute, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  writeAtomic(path.join(vaultRoot, artifact.source.path), sourceUpdated);
  writeAtomic(path.join(vaultRoot, artifact.target.path), targetUpdated);
  if (indexResult.changed) writeAtomic(indexPath, indexResult.content);
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_MERGE_APPLIED",
    planId,
    approvedBy: by,
    appliedAt,
    source: { path: artifact.source.path, retained: true, supersession: "SUPERSEDED" },
    target: { path: artifact.target.path, updated: true },
    index: { updated: indexResult.changed, reversible: true },
    auditPath: toRelative(vaultRoot, artifactAbsolute),
    rollback: { available: true, command: `knowledge-merge-revert ${planId} --confirm` },
  };
}

export function revertKnowledgeMerge({ vaultRoot, selector, revertedBy = "user", confirmed = false, now = new Date() } = {}) {
  if (confirmed !== true) throw new Error("Merge revert membutuhkan confirmation eksplisit.");
  const { absolute, artifact } = readMergeArtifact(vaultRoot, selector);
  for (const item of [artifact.source, artifact.target]) {
    const current = fs.readFileSync(path.join(vaultRoot, item.path), "utf8");
    if (checksum(current) !== item.afterChecksum) throw new Error(`File berubah setelah merge; revert dibatalkan: ${item.path}`);
  }
  const indexAbsolute = path.join(vaultRoot, artifact.index.path);
  if (artifact.index.before !== null && fs.existsSync(indexAbsolute)) {
    const currentIndex = fs.readFileSync(indexAbsolute, "utf8");
    if (checksum(currentIndex) !== artifact.index.afterChecksum) throw new Error("Index berubah setelah merge; revert dibatalkan.");
  }
  writeAtomic(path.join(vaultRoot, artifact.source.path), artifact.source.before);
  writeAtomic(path.join(vaultRoot, artifact.target.path), artifact.target.before);
  if (artifact.index.before !== null) writeAtomic(indexAbsolute, artifact.index.before);
  const revertedAt = new Date(now).toISOString();
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_MERGE_REVERTED",
    planId: artifact.planId,
    revertedAt,
    revertedBy: String(revertedBy).trim() || "user",
    sourceRetained: true,
    auditPath: toRelative(vaultRoot, absolute),
  };
}
