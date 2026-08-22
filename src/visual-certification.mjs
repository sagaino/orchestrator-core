/** P7.5 bounded visual QA certification and human gate. */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRun } from "./run-manager.mjs";
import { listCaptureReports } from "./visual-qa.mjs";
import { listVisualRevisions } from "./visual-revision.mjs";

export const VISUAL_CERTIFICATION_SCHEMA_VERSION = 1;
export const VISUAL_CERTIFICATION_MODE = "visual-qa-certification";
const SAFE_ID = /^[A-Za-z0-9._-]{1,160}$/;
const EXPECTED_VIEWPORTS = ["desktop", "tablet", "mobile"];

function certificationDirectory(runsRoot, runId) {
  return path.join(runsRoot, "runtime", "visual-evidence", runId, "certification");
}

function certificationPath(runsRoot, runId) {
  return path.join(certificationDirectory(runsRoot, runId), "p7.5.json");
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const digest = checksum(text);
  fs.writeFileSync(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { path: filePath, checksum: digest, checksumPath: `${filePath}.sha256` };
}

function readPrivateJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const recorded = fs.readFileSync(`${filePath}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (recorded !== checksum(text)) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateCertification(record) {
  if (!record || record.schemaVersion !== VISUAL_CERTIFICATION_SCHEMA_VERSION || record.mode !== VISUAL_CERTIFICATION_MODE) {
    throw new Error("Visual QA certification record tidak valid.");
  }
  if (!SAFE_ID.test(record.runId) || !["CERTIFIED", "HUMAN_GATE_REQUIRED", "BLOCKED"].includes(record.status)) {
    throw new Error("Visual QA certification identifier/status tidak valid.");
  }
  return record;
}

function statusCheck(status, details = {}) {
  return { status, ...details };
}

function captureById(captures, captureId) {
  return captures.find((capture) => capture.captureId === captureId) ?? null;
}

function inspectCapture(capture, expectedCaptureId) {
  if (!capture) return statusCheck("FAIL", { reason: "CAPTURE_NOT_FOUND", captureId: expectedCaptureId });
  const viewportNames = capture.viewports?.map((item) => item.name) ?? [];
  const allViewports = EXPECTED_VIEWPORTS.every((name) => viewportNames.includes(name));
  const allCaptured = EXPECTED_VIEWPORTS.every((name) => capture.viewports?.find((item) => item.name === name)?.status === "PASS");
  const evidence = capture.viewports?.map((item) => item.evidence).filter(Boolean) ?? [];
  const accessibilityStatuses = evidence.map((item) => item.accessibility?.status ?? "UNKNOWN");
  const accessibilityPass = evidence.length === EXPECTED_VIEWPORTS.length && accessibilityStatuses.every((status) => status === "PASS");
  const comparisonPassOrUnknown = evidence.every((item) => ["PASS", "UNKNOWN"].includes(item.comparison?.status));
  const status = allViewports && allCaptured && accessibilityPass && comparisonPassOrUnknown ? "PASS" : "FAIL";
  return statusCheck(status, {
    captureId: capture.captureId,
    viewportNames,
    expectedViewports: EXPECTED_VIEWPORTS,
    evidenceIds: capture.viewports?.map((item) => item.evidenceId) ?? [],
    accessibilityStatuses,
    comparisonStatuses: evidence.map((item) => item.comparison?.status ?? "UNKNOWN"),
    allViewports,
    allCaptured,
    accessibilityPass,
    comparisonPassOrUnknown,
  });
}

function inspectRevision(revisions, iteration, postEvidenceIds) {
  const revision = revisions.find((item) => item.iteration === iteration) ?? null;
  if (!revision) return { status: "FAIL", reason: "REVISION_NOT_FOUND", iteration };
  const afterMatches = postEvidenceIds.length > 0 && postEvidenceIds.every((id) => revision.afterEvidenceIds.includes(id));
  const status = revision.status === "COMPLETED"
    && revision.visualAnnotations.length > 0
    && revision.beforeEvidenceIds.length > 0
    && afterMatches
    ? "PASS"
    : "FAIL";
  return {
    status,
    iteration,
    revisionId: revision.revisionId,
    annotationCount: revision.visualAnnotations.length,
    inlineCommentCount: revision.inlineComments.length,
    beforeEvidenceIds: revision.beforeEvidenceIds,
    afterEvidenceIds: revision.afterEvidenceIds,
    afterMatches,
  };
}

function inspectCleanup(run, runsRoot) {
  const workspace = run.execution?.workspace ?? {};
  const workspacePath = workspace.path ? path.resolve(workspace.path) : null;
  const workspaceRemoved = Boolean(workspacePath && !fs.existsSync(workspacePath) && ["CLEANED", "DISCARDED"].includes(workspace.state));
  const artifactPath = workspace.artifactPath ? path.resolve(runsRoot, workspace.artifactPath) : null;
  const artifactInsideRuns = Boolean(artifactPath && (artifactPath === runsRoot || artifactPath.startsWith(`${path.resolve(runsRoot)}${path.sep}`)));
  const sourceRepository = run.project?.repository ? path.resolve(run.project.repository) : null;
  const sourceArtifactLeakage = Boolean(artifactPath && sourceRepository && (artifactPath === sourceRepository || artifactPath.startsWith(`${sourceRepository}${path.sep}`)));
  return {
    status: workspaceRemoved && artifactInsideRuns && !sourceArtifactLeakage ? "PASS" : "FAIL",
    workspaceState: workspace.state ?? null,
    workspaceRemoved,
    artifactPath: workspace.artifactPath ?? null,
    artifactInsideRuns,
    sourceArtifactLeakage,
  };
}

function inspectScope(run) {
  const allowedPaths = run.task?.allowedPaths ?? run.task?.policy?.allowedPaths ?? run.execution?.policy?.allowedPaths ?? [];
  const accepted = run.completion?.humanApproved === true;
  const status = run.state === "DONE" && accepted && Boolean(run.project?.id) && Boolean(run.task?.id) && Array.isArray(allowedPaths) && allowedPaths.length > 0 ? "PASS" : "FAIL";
  return { status, runState: run.state, accepted, projectId: run.project?.id ?? null, taskId: run.task?.id ?? null, allowedPaths };
}

export function createVisualQACertification({
  runsRoot,
  runId,
  baselineCaptureId,
  postChangeCaptureId,
  revisionIteration,
  restartReconstruction = {},
  humanGate = {},
  now = new Date(),
} = {}) {
  if (!runsRoot || !SAFE_ID.test(runId) || !SAFE_ID.test(baselineCaptureId) || !SAFE_ID.test(postChangeCaptureId) || !Number.isInteger(revisionIteration) || revisionIteration < 1) {
    throw new Error("Visual QA certification input tidak valid.");
  }
  const run = getRun(runsRoot, runId);
  const captures = listCaptureReports({ runsRoot, runId });
  const revisions = listVisualRevisions({ runsRoot, runId });
  const baselineCapture = captureById(captures, baselineCaptureId);
  const postChangeCapture = captureById(captures, postChangeCaptureId);
  const baseline = inspectCapture(baselineCapture, baselineCaptureId);
  const postChange = inspectCapture(postChangeCapture, postChangeCaptureId);
  const postEvidenceIds = postChange.evidenceIds ?? [];
  const revision = inspectRevision(revisions, revisionIteration, postEvidenceIds);
  const scope = inspectScope(run);
  const restart = {
    status: restartReconstruction.verified === true && restartReconstruction.revisionIteration === revisionIteration && Array.isArray(restartReconstruction.afterEvidenceIds) && postEvidenceIds.every((id) => restartReconstruction.afterEvidenceIds.includes(id)) ? "PASS" : "FAIL",
    verified: restartReconstruction.verified === true,
    revisionIteration: restartReconstruction.revisionIteration ?? null,
    afterEvidenceIds: Array.isArray(restartReconstruction.afterEvidenceIds) ? restartReconstruction.afterEvidenceIds : [],
  };
  const cleanup = inspectCleanup(run, runsRoot);
  const checks = { scope, baselineCapture: baseline, annotatedRevision: revision, postChangeCapture: postChange, restartReconstruction: restart, cleanup };
  const blockers = Object.entries(checks).filter(([, check]) => check.status !== "PASS").map(([name, check]) => `${name.toUpperCase()}_${check.reason ?? "FAILED"}`);
  const humanConfirmed = humanGate.confirmed === true && typeof humanGate.confirmedBy === "string" && humanGate.confirmedBy.trim().length > 0;
  if (!humanConfirmed && blockers.length === 0) blockers.push("HUMAN_ACCEPTANCE_REQUIRED");
  const status = blockers.length === 0 ? "CERTIFIED" : (blockers.length === 1 && blockers[0] === "HUMAN_ACCEPTANCE_REQUIRED" ? "HUMAN_GATE_REQUIRED" : "BLOCKED");
  const certification = {
    schemaVersion: VISUAL_CERTIFICATION_SCHEMA_VERSION,
    mode: VISUAL_CERTIFICATION_MODE,
    certificationId: `visual-cert-${runId}-${randomUUID().slice(0, 8)}`,
    runId,
    createdAt: now.toISOString(),
    status,
    blockers,
    humanGate: { required: true, confirmed: humanConfirmed, confirmedBy: humanGate.confirmedBy ?? null, confirmedAt: humanGate.confirmedAt ?? (humanConfirmed ? now.toISOString() : null) },
    scope: { projectId: run.project?.id ?? null, taskId: run.task?.id ?? null },
    captureIds: { baseline: baselineCaptureId, postChange: postChangeCaptureId },
    revisionIteration,
    checks,
  };
  const persistence = writePrivateJson(certificationPath(runsRoot, runId), certification);
  return { ...certification, persistence };
}

export function getVisualQACertification({ runsRoot, runId } = {}) {
  if (!runsRoot || !SAFE_ID.test(runId)) throw new Error("Visual QA certification identifier tidak valid.");
  const filePath = certificationPath(runsRoot, runId);
  const record = readPrivateJson(filePath);
  if (!record) throw new Error("Visual QA certification tidak ditemukan atau rusak.");
  return validateCertification(record);
}

export function listVisualQACertifications({ runsRoot, runId } = {}) {
  try { return [getVisualQACertification({ runsRoot, runId })]; } catch { return []; }
}
