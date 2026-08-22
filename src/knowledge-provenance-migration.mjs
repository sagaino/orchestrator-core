import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { listKnowledgeDocuments } from "./knowledge-quality.mjs";
import {
  isKnowledgeDate,
  reviewDateFrom,
  KNOWLEDGE_PROVENANCE_OWNER,
  KNOWLEDGE_PROVENANCE_SCHEMA_VERSION,
  KNOWLEDGE_SUPERSESSION_STATES,
  validateKnowledgeProvenance,
} from "./knowledge-provenance.mjs";

const DECISIONS_DIRECTORY = path.join("03-Sources", "other", "knowledge-decisions");
const MIGRATION_PREFIX = "p8-0-provenance-";

function checksum(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function toRelative(vaultRoot, absolute) {
  return path.relative(vaultRoot, absolute).split(path.sep).join("/");
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function formatValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function setFrontmatterField(content, field, value) {
  const line = `${field}: ${formatValue(value)}`;
  const pattern = new RegExp(`^${field}:.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
  return content.replace(/^---\r?\n/, `---\n${line}\n`);
}

function normaliseSources(metadata, relativePath) {
  if (Array.isArray(metadata.sources) && metadata.sources.some((source) => String(source).trim())) {
    return metadata.sources.map((source) => String(source).trim()).filter(Boolean);
  }
  return [`legacy://knowledge/${relativePath}`];
}

function buildMigrationMetadata(metadata, relativePath, planId, now, reviewDays) {
  const confidence = Number(metadata.confidence);
  const supersession = String(metadata.supersession ?? "").toUpperCase();
  return {
    provenance_schema: Number(metadata.provenance_schema) === KNOWLEDGE_PROVENANCE_SCHEMA_VERSION
      ? KNOWLEDGE_PROVENANCE_SCHEMA_VERSION
      : KNOWLEDGE_PROVENANCE_SCHEMA_VERSION,
    orchestrator_run: typeof metadata.orchestrator_run === "string" && metadata.orchestrator_run.trim()
      ? metadata.orchestrator_run.trim()
      : `legacy-migration:${planId}`,
    sources: normaliseSources(metadata, relativePath),
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0.5,
    owner: typeof metadata.owner === "string" && metadata.owner.trim() ? metadata.owner.trim() : KNOWLEDGE_PROVENANCE_OWNER,
    review_by: isKnowledgeDate(metadata.review_by)
      ? metadata.review_by
      : reviewDateFrom({ now, days: reviewDays }),
    supersession: KNOWLEDGE_SUPERSESSION_STATES.includes(supersession) ? supersession : "ACTIVE",
  };
}

function applyMetadata(content, metadata) {
  let updated = content;
  for (const [field, value] of Object.entries(metadata)) updated = setFrontmatterField(updated, field, value);
  return updated;
}

function createPlanId(now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${MIGRATION_PREFIX}${stamp}-${randomUUID().slice(0, 8)}`;
}

function artifactAbsolutePath(vaultRoot, planId) {
  const clean = String(planId ?? "").trim();
  if (!/^p8-0-provenance-[A-Za-z0-9TZ_-]+$/.test(clean)) throw new Error("P8.0 migration plan ID tidak valid.");
  return path.join(vaultRoot, DECISIONS_DIRECTORY, `${clean}.json`);
}

function readArtifact(vaultRoot, selector) {
  const directory = path.join(vaultRoot, DECISIONS_DIRECTORY);
  if (!fs.existsSync(directory)) throw new Error(`P8.0 migration artifact tidak ditemukan: ${selector}`);
  const normalized = String(selector ?? "").trim();
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.startsWith(MIGRATION_PREFIX) && name.endsWith(".json"))
    .filter((name) => name === normalized || name === `${normalized}.json` || name.startsWith(`${normalized}-`));
  if (candidates.length !== 1) throw new Error(candidates.length === 0 ? `P8.0 migration artifact tidak ditemukan: ${selector}` : `P8.0 migration artifact ambigu: ${selector}`);
  const absolute = path.join(directory, candidates[0]);
  const artifact = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (artifact.action !== "KNOWLEDGE_PROVENANCE_MIGRATION") throw new Error(`Artifact bukan P8.0 migration plan: ${selector}`);
  return { absolute, artifact };
}

function migrationDocuments(vaultRoot) {
  return listKnowledgeDocuments({ vaultRoot }).filter((document) => document.path.startsWith("01-Knowledge/") && !document.template);
}

export function previewKnowledgeProvenanceMigration({ vaultRoot, now = new Date(), reviewDays = 180 } = {}) {
  const planId = createPlanId(now);
  const safeReviewDays = Math.max(1, Number(reviewDays) || 180);
  const files = [];
  for (const document of migrationDocuments(vaultRoot)) {
    const before = fs.readFileSync(document.absolute, "utf8");
    const metadata = buildMigrationMetadata(document.metadata, document.path, planId, now, safeReviewDays);
    const after = applyMetadata(before, metadata);
    if (after === before && validateKnowledgeProvenance(document.metadata).valid) continue;
    const changedFields = Object.keys(metadata).filter((field) => String(document.metadata[field] ?? "") !== String(metadata[field] ?? ""));
    files.push({
      path: document.path,
      title: document.title,
      before,
      after,
      beforeChecksum: checksum(before),
      afterChecksum: checksum(after),
      changedFields,
      inferredFields: changedFields.filter((field) => !["provenance_schema", "sources", "orchestrator_run"].includes(field)),
    });
  }
  const artifact = {
    schemaVersion: 1,
    immutable: true,
    action: "KNOWLEDGE_PROVENANCE_MIGRATION",
    status: "PREVIEW",
    planId,
    createdAt: new Date(now).toISOString(),
    scope: "01-Knowledge",
    reviewDays: safeReviewDays,
    files,
    summary: {
      candidateCount: files.length,
      changedFieldCount: files.reduce((total, item) => total + item.changedFields.length, 0),
      inferredFieldCount: files.reduce((total, item) => total + item.inferredFields.length, 0),
    },
    confirmation: { required: true, phrase: "MIGRATE_PROVENANCE", expectedStatus: "PREVIEW" },
    guardrail: "Preview tidak mengubah halaman. Apply memeriksa checksum sebelum menulis dan rollback memulihkan snapshot yang sama.",
  };
  const artifactPath = artifactAbsolutePath(vaultRoot, planId);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return {
    schemaVersion: artifact.schemaVersion,
    action: "KNOWLEDGE_PROVENANCE_MIGRATION_PREVIEW",
    status: artifact.status,
    planId,
    createdAt: artifact.createdAt,
    scope: artifact.scope,
    reviewDays: safeReviewDays,
    summary: artifact.summary,
    files: files.map(({ before, after, ...item }) => item),
    auditPath: toRelative(vaultRoot, artifactPath),
    confirmation: artifact.confirmation,
    guardrail: artifact.guardrail,
  };
}

export function applyKnowledgeProvenanceMigration({ vaultRoot, selector, approvedBy = "user", confirmed = false, now = new Date() } = {}) {
  if (confirmed !== true) throw new Error("P8.0 migration membutuhkan confirmation eksplisit (MIGRATE_PROVENANCE).");
  const { absolute, artifact } = readArtifact(vaultRoot, selector);
  if (artifact.status !== "PREVIEW") throw new Error(`P8.0 migration tidak dapat di-apply dari status ${artifact.status}.`);
  for (const item of artifact.files) {
    const currentPath = path.join(vaultRoot, item.path);
    if (!fs.existsSync(currentPath)) throw new Error(`File knowledge hilang setelah preview: ${item.path}`);
    const current = fs.readFileSync(currentPath, "utf8");
    if (checksum(current) !== item.beforeChecksum) throw new Error(`File berubah setelah preview; jalankan preview ulang: ${item.path}`);
  }
  const written = [];
  try {
    for (const item of artifact.files) {
      writeAtomic(path.join(vaultRoot, item.path), item.after);
      written.push(item);
    }
  } catch (error) {
    for (const item of written) writeAtomic(path.join(vaultRoot, item.path), item.before);
    throw error;
  }
  const appliedAt = new Date(now).toISOString();
  const updated = { ...artifact, status: "APPLIED", appliedAt, approvedBy: String(approvedBy).trim() || "user" };
  writeAtomic(absolute, `${JSON.stringify(updated, null, 2)}\n`);
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_PROVENANCE_MIGRATION_APPLIED",
    status: updated.status,
    planId: artifact.planId,
    appliedAt,
    approvedBy: updated.approvedBy,
    summary: artifact.summary,
    auditPath: toRelative(vaultRoot, absolute),
    rollback: { available: true, command: `knowledge-provenance-rollback ${artifact.planId} --confirm` },
  };
}

export function rollbackKnowledgeProvenanceMigration({ vaultRoot, selector, revertedBy = "user", confirmed = false, now = new Date() } = {}) {
  if (confirmed !== true) throw new Error("P8.0 migration rollback membutuhkan confirmation eksplisit.");
  const { absolute, artifact } = readArtifact(vaultRoot, selector);
  if (artifact.status !== "APPLIED") throw new Error(`P8.0 migration tidak dapat di-rollback dari status ${artifact.status}.`);
  for (const item of artifact.files) {
    const current = fs.readFileSync(path.join(vaultRoot, item.path), "utf8");
    if (checksum(current) !== item.afterChecksum) throw new Error(`File berubah setelah migration; rollback dibatalkan: ${item.path}`);
  }
  for (const item of artifact.files) writeAtomic(path.join(vaultRoot, item.path), item.before);
  const rolledBackAt = new Date(now).toISOString();
  const updated = { ...artifact, status: "ROLLED_BACK", rolledBackAt, revertedBy: String(revertedBy).trim() || "user" };
  writeAtomic(absolute, `${JSON.stringify(updated, null, 2)}\n`);
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_PROVENANCE_MIGRATION_ROLLED_BACK",
    status: updated.status,
    planId: artifact.planId,
    rolledBackAt,
    revertedBy: updated.revertedBy,
    summary: artifact.summary,
    auditPath: toRelative(vaultRoot, absolute),
  };
}
