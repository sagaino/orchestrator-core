/** P7.4 durable visual feedback and before/after revision linkage. */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { listVisualEvidence } from "./visual-evidence.mjs";

export const VISUAL_REVISION_SCHEMA_VERSION = 1;
export const VISUAL_REVISION_MODE = "visual-revision";
const SAFE_ID = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_ITEMS = 100;
const MAX_TEXT = 4000;

function revisionDirectory(runsRoot, runId) {
  return path.join(runsRoot, "runtime", "visual-evidence", runId, "revisions");
}

function revisionPath(runsRoot, runId, iteration) {
  return path.join(revisionDirectory(runsRoot, runId), `revision-${iteration}.json`);
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const digest = checksum(text);
  const checksumPath = `${filePath}.sha256`;
  fs.writeFileSync(checksumPath, `${digest}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { path: filePath, checksum: digest, checksumPath };
}

function readJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const sidecar = fs.readFileSync(`${filePath}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (sidecar !== checksum(text)) return null;
    return JSON.parse(text);
  } catch { return null; }
}

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim().slice(0, MAX_TEXT);
}

function cleanAnnotations(annotations) {
  if (!Array.isArray(annotations)) return [];
  return annotations.slice(0, MAX_ITEMS).map((annotation, index) => ({
    id: cleanText(annotation?.id, `visual-${index + 1}`).slice(0, 160),
    x: Number.isFinite(annotation?.x) ? Math.max(0, Math.min(100, Number(annotation.x))) : 0,
    y: Number.isFinite(annotation?.y) ? Math.max(0, Math.min(100, Number(annotation.y))) : 0,
    width: Number.isFinite(annotation?.width) ? Math.max(0, Math.min(100, Number(annotation.width))) : null,
    height: Number.isFinite(annotation?.height) ? Math.max(0, Math.min(100, Number(annotation.height))) : null,
    comment: cleanText(annotation?.comment),
    createdAt: cleanText(annotation?.createdAt, new Date().toISOString()),
  }));
}

function cleanInlineComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments.slice(0, MAX_ITEMS).map((comment) => ({
    file: cleanText(comment?.file, "unknown").slice(0, 500),
    line: Number.isInteger(comment?.line) ? Math.max(1, comment.line) : null,
    comment: cleanText(comment?.comment),
  }));
}

function cleanEvidenceIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => typeof id === "string" && SAFE_ID.test(id)).slice(0, MAX_ITEMS))];
}

export function normalizeVisualFeedback({ inlineComments = [], visualAnnotations = [], beforeEvidenceIds = [], iteration = null } = {}) {
  return {
    iteration,
    inlineComments: cleanInlineComments(inlineComments),
    visualAnnotations: cleanAnnotations(visualAnnotations),
    beforeEvidenceIds: cleanEvidenceIds(beforeEvidenceIds),
  };
}

function validateRecord(record) {
  if (!record || record.schemaVersion !== VISUAL_REVISION_SCHEMA_VERSION || record.mode !== VISUAL_REVISION_MODE) throw new Error("Visual revision record tidak valid.");
  if (!SAFE_ID.test(record.runId) || !Number.isInteger(record.iteration) || record.iteration < 1) throw new Error("Visual revision identifier tidak valid.");
  return record;
}

export function createVisualRevisionRecord({ runsRoot, runId, iteration, requestedBy = "user", reason, inlineComments = [], visualAnnotations = [], beforeEvidenceIds = [], now = new Date() } = {}) {
  if (!runsRoot || !SAFE_ID.test(runId) || !Number.isInteger(iteration) || iteration < 1) throw new Error("Visual revision input tidak valid.");
  const requestedAt = now.toISOString();
  const availableEvidence = new Set(listVisualEvidence({ runsRoot, runId }).map((evidence) => evidence.evidenceId));
  const record = {
    schemaVersion: VISUAL_REVISION_SCHEMA_VERSION,
    mode: VISUAL_REVISION_MODE,
    revisionId: `revision-${runId}-${iteration}`,
    runId,
    iteration,
    status: "AWAITING_AFTER_EVIDENCE",
    requestedAt,
    requestedBy: cleanText(requestedBy, "user").slice(0, 160),
    reason: cleanText(reason),
    inlineComments: cleanInlineComments(inlineComments),
    visualAnnotations: cleanAnnotations(visualAnnotations),
    beforeEvidenceIds: cleanEvidenceIds(beforeEvidenceIds).filter((id) => availableEvidence.has(id)),
    afterEvidenceIds: [],
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
  const existingPath = revisionPath(runsRoot, runId, iteration);
  const existing = readJson(existingPath);
  if (existing) return { ...validateRecord(existing), persistence: { path: existingPath, checksumPath: `${existingPath}.sha256` } };
  const persistence = writeJson(existingPath, record);
  return { ...record, persistence };
}

export function completeVisualRevision({ runsRoot, runId, iteration, afterEvidenceIds = [], status = "COMPLETED", now = new Date() } = {}) {
  const record = getVisualRevision({ runsRoot, runId, iteration });
  const available = new Set(listVisualEvidence({ runsRoot, runId }).map((evidence) => evidence.evidenceId));
  const accepted = cleanEvidenceIds(afterEvidenceIds).filter((id) => available.has(id));
  const mergedAfter = [...new Set([...(record.afterEvidenceIds ?? []), ...accepted])];
  const updated = { ...record, status: mergedAfter.length > 0 ? status : "AWAITING_AFTER_EVIDENCE", afterEvidenceIds: mergedAfter, updatedAt: now.toISOString() };
  const persistence = writeJson(revisionPath(runsRoot, runId, iteration), updated);
  return { ...updated, persistence };
}

export function getVisualRevision({ runsRoot, runId, iteration } = {}) {
  if (!runsRoot || !SAFE_ID.test(runId) || !Number.isInteger(Number(iteration))) throw new Error("Visual revision identifier tidak valid.");
  const filePath = revisionPath(runsRoot, runId, Number(iteration));
  const record = readJson(filePath);
  if (!record) throw new Error("Visual revision tidak ditemukan.");
  return validateRecord(record);
}

export function listVisualRevisions({ runsRoot, runId } = {}) {
  if (!runsRoot || !SAFE_ID.test(runId)) return [];
  const directory = revisionDirectory(runsRoot, runId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(directory, entry.name)))
    .filter((record) => {
      try { validateRecord(record); return true; } catch { return false; }
    })
    .sort((left, right) => left.iteration - right.iteration);
}
