/**
 * P7.0: versioned visual evidence contract.
 *
 * This module stores evidence metadata and checksums only. Capture, image
 * comparison, and accessibility scanners are owned by later Phase 7 packets.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const VISUAL_EVIDENCE_SCHEMA_VERSION = 1;
export const VISUAL_EVIDENCE_MODE = "visual-evidence";
export const VISUAL_EVIDENCE_ROOT = "visual-evidence";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMPARISON_STATUSES = new Set(["PASS", "FAIL", "UNKNOWN"]);

function nonEmpty(value, field, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${field} must be a non-empty string`);
}

function safeId(value, field, errors) {
  nonEmpty(value, field, errors);
  if (typeof value === "string" && !ID_PATTERN.test(value)) errors.push(`${field} contains unsafe characters`);
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function evidenceDirectory(runsRoot, runId) {
  return path.join(runsRoot, "runtime", VISUAL_EVIDENCE_ROOT, runId);
}

function evidencePath(runsRoot, runId, evidenceId) {
  return path.join(evidenceDirectory(runsRoot, runId), `${evidenceId}.json`);
}

function checksumPath(filePath) {
  return `${filePath}.sha256`;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function artifactMetadata({ artifact = {}, artifactPath = null } = {}) {
  const filePath = artifactPath ?? artifact.path ?? null;
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return {
      path: filePath,
      exists: false,
      sha256: artifact.sha256 ?? null,
      bytes: artifact.bytes ?? null,
      contentType: artifact.contentType ?? "image/png",
    };
  }
  const stat = fs.statSync(filePath);
  return {
    path: path.resolve(filePath),
    exists: true,
    sha256: sha256File(filePath),
    bytes: stat.size,
    contentType: artifact.contentType ?? "image/png",
  };
}

export function validateVisualEvidence(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return { valid: false, errors: ["Visual evidence must be a non-null object"] };
  if (evidence.schemaVersion !== VISUAL_EVIDENCE_SCHEMA_VERSION) errors.push("Unsupported visual evidence schemaVersion");
  if (evidence.mode !== VISUAL_EVIDENCE_MODE) errors.push("Invalid visual evidence mode");
  safeId(evidence.evidenceId, "evidenceId", errors);
  safeId(evidence.runId, "runId", errors);
  nonEmpty(evidence.route, "route", errors);
  if (!evidence.viewport || typeof evidence.viewport !== "object") errors.push("viewport is required");
  else {
    if (!Number.isInteger(evidence.viewport.width) || evidence.viewport.width < 1) errors.push("viewport.width must be a positive integer");
    if (!Number.isInteger(evidence.viewport.height) || evidence.viewport.height < 1) errors.push("viewport.height must be a positive integer");
    nonEmpty(evidence.viewport.name, "viewport.name", errors);
  }
  if (!evidence.reference || typeof evidence.reference !== "object") errors.push("reference is required");
  else {
    nonEmpty(evidence.reference.kind, "reference.kind", errors);
    if (evidence.reference.kind !== "NONE") nonEmpty(evidence.reference.path, "reference.path", errors);
  }
  if (!evidence.actual || typeof evidence.actual !== "object") errors.push("actual screenshot is required");
  else {
    nonEmpty(evidence.actual.status, "actual.status", errors);
    if (!["CAPTURED", "UNAVAILABLE"].includes(evidence.actual.status)) errors.push("actual.status must be CAPTURED or UNAVAILABLE");
    if (evidence.actual.status === "CAPTURED") nonEmpty(evidence.actual.path, "actual.path", errors);
  }
  if (!evidence.comparison || typeof evidence.comparison !== "object") errors.push("comparison is required");
  else {
    if (!COMPARISON_STATUSES.has(evidence.comparison.status)) errors.push("comparison.status must be PASS, FAIL, or UNKNOWN");
    nonEmpty(evidence.comparison.method, "comparison.method", errors);
  }
  if (!Array.isArray(evidence.accessibility?.findings)) errors.push("accessibility.findings must be an array");
  if (!evidence.revision || typeof evidence.revision !== "object") errors.push("revision is required");
  else if (!Number.isInteger(evidence.revision.number) || evidence.revision.number < 1) errors.push("revision.number must be a positive integer");
  if (!evidence.artifact || typeof evidence.artifact !== "object") errors.push("artifact is required");
  else {
    if (evidence.actual?.status !== "UNAVAILABLE") nonEmpty(evidence.artifact.path, "artifact.path", errors);
    if (evidence.artifact.sha256 !== null && evidence.artifact.sha256 !== undefined && !SHA256_PATTERN.test(evidence.artifact.sha256)) errors.push("artifact.sha256 must be a SHA-256 checksum");
  }
  nonEmpty(evidence.createdAt, "createdAt", errors);
  if (Number.isNaN(Date.parse(evidence.createdAt))) errors.push("createdAt must be a valid timestamp");
  return { valid: errors.length === 0, errors };
}

export function createVisualEvidence({
  runId,
  route,
  viewport,
  reference = { kind: "NONE", path: null, checksum: null },
  actual = {},
  comparison = { status: "UNKNOWN", method: "NOT_CAPTURED", score: null, mismatchPixels: null, notes: [] },
  accessibility = { status: "UNKNOWN", findings: [] },
  revision = { number: 1, requestedBy: null, reason: null },
  artifact = {},
  artifactPath = null,
  evidenceId = `visual-${randomUUID()}`,
  createdAt = new Date().toISOString(),
} = {}) {
  const resolvedArtifact = artifactMetadata({ artifact, artifactPath });
  const evidence = {
    schemaVersion: VISUAL_EVIDENCE_SCHEMA_VERSION,
    mode: VISUAL_EVIDENCE_MODE,
    evidenceId,
    runId,
    route,
    viewport: { name: viewport?.name ?? "custom", width: viewport?.width, height: viewport?.height, deviceScaleFactor: viewport?.deviceScaleFactor ?? 1 },
    reference: { kind: reference?.kind ?? "NONE", path: reference?.path ?? null, checksum: reference?.checksum ?? null },
    actual: { status: actual?.status ?? (resolvedArtifact.exists ? "CAPTURED" : "UNAVAILABLE"), path: actual?.path ?? (resolvedArtifact.exists ? resolvedArtifact.path : null), capturedAt: actual?.capturedAt ?? null, diagnostics: actual?.diagnostics ?? null },
    comparison: { status: comparison?.status ?? "UNKNOWN", method: comparison?.method ?? "NOT_CAPTURED", score: comparison?.score ?? null, mismatchPixels: comparison?.mismatchPixels ?? null, notes: Array.isArray(comparison?.notes) ? comparison.notes : [], diagnostics: comparison?.diagnostics ?? null },
    accessibility: { schemaVersion: accessibility?.schemaVersion ?? null, status: accessibility?.status ?? "UNKNOWN", findings: Array.isArray(accessibility?.findings) ? accessibility.findings : [], checks: accessibility?.checks ?? null },
    revision: { number: revision?.number ?? 1, iteration: revision?.iteration ?? null, revisionId: revision?.revisionId ?? null, requestedBy: revision?.requestedBy ?? null, reason: revision?.reason ?? null, createdAt: revision?.createdAt ?? createdAt },
    artifact: resolvedArtifact,
    createdAt,
  };
  const validation = validateVisualEvidence(evidence);
  if (!validation.valid) {
    const error = new Error(`Visual evidence tidak valid: ${validation.errors.join(", ")}`);
    error.code = "VISUAL_EVIDENCE_INVALID";
    error.details = validation;
    throw error;
  }
  return Object.freeze(evidence);
}

export function persistVisualEvidence({ runsRoot, evidence } = {}) {
  if (!runsRoot) throw new Error("runsRoot is required.");
  const validation = validateVisualEvidence(evidence);
  if (!validation.valid) throw new Error(`Visual evidence tidak valid: ${validation.errors.join(", ")}`);
  const filePath = evidencePath(runsRoot, evidence.runId, evidence.evidenceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(checksumPath(filePath), `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...evidence, persistence: { path: filePath, checksum, checksumPath: checksumPath(filePath) } };
}

export function listVisualEvidence({ runsRoot, runId } = {}) {
  if (!runsRoot || !runId || !ID_PATTERN.test(runId)) return [];
  const directory = evidenceDirectory(runsRoot, runId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(directory, entry.name)))
    .filter((item) => validateVisualEvidence(item).valid)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function getVisualEvidence({ runsRoot, runId, evidenceId } = {}) {
  if (!runsRoot || !runId || !evidenceId || !ID_PATTERN.test(runId) || !ID_PATTERN.test(evidenceId)) throw new Error("Visual evidence identifier tidak valid.");
  const filePath = evidencePath(runsRoot, runId, evidenceId);
  const evidence = readJson(filePath);
  if (!evidence || !validateVisualEvidence(evidence).valid) throw new Error("Visual evidence tidak ditemukan atau rusak.");
  return evidence;
}
