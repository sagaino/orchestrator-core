import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildObjectiveEvidence } from "./objective-evidence.mjs";
import { getRun } from "./run-manager.mjs";
import { listAggregatePreviewEvidence } from "./visual-evidence.mjs";

export const DELIVERY_CERTIFICATION_SCHEMA_VERSION = 1;
export const DELIVERY_CERTIFICATION_KIND = "objective-delivery-certification";
const SAFE_ID = /^[A-Za-z0-9._-]{1,160}$/;

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

function writeBundle(filePath, bundle) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256(text);
  fs.writeFileSync(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, checksum };
}

function certificationDirectory(runsRoot, objectiveId) {
  return path.join(runsRoot, "runtime", "certifications", "delivery", objectiveId);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function result(id, passed, message, evidence = {}) {
  return { id, status: passed ? "PASS" : "FAIL", passed, message, evidence };
}

function readObjectiveRun(runsRoot, runId) {
  try { return getRun(runsRoot, runId); } catch { return null; }
}

function runCleanup(run) {
  const workspace = run?.execution?.workspace ?? {};
  const state = workspace.state ?? null;
  const pathExists = Boolean(workspace.path && fs.existsSync(workspace.path));
  return {
    runId: run?.runId ?? null,
    state,
    pathExists,
    cleaned: !pathExists && ["CLEANED", "DISCARDED", "APPLIED"].includes(state),
  };
}

function knowledgeCapture(run) {
  const approval = run?.knowledge?.approval ?? null;
  const destination = approval?.destination ?? null;
  const approved = Boolean(approval?.approvedAt && approval?.approvedBy && destination);
  const synced = destination === "WIKI"
    ? Boolean(run?.knowledge?.sync?.syncedAt || run?.knowledge?.sync?.sourcePath)
    : true;
  return { runId: run?.runId ?? null, approved, synced, destination, approval, sync: run?.knowledge?.sync ?? null };
}

function latestPreview(previews) {
  return [...previews].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
}

export function buildDeliveryCertificationEvidence({ runsRoot, objectiveId, now = new Date(), automatic = false } = {}) {
  if (!runsRoot || !SAFE_ID.test(String(objectiveId ?? ""))) throw new Error("runsRoot dan objectiveId valid wajib diisi.");
  const objectiveEvidence = buildObjectiveEvidence({ runsRoot, objectiveId });
  const runIds = [...new Set(objectiveEvidence.nodes.map((node) => node.runId).filter(Boolean))];
  const runs = runIds.map((runId) => readObjectiveRun(runsRoot, runId)).filter(Boolean);
  const visual = objectiveEvidence.visualEvidence;
  const previews = listAggregatePreviewEvidence({ runsRoot, objectiveId });
  const preview = latestPreview(previews);
  const runCleanups = runs.map(runCleanup);
  const knowledge = runs.map(knowledgeCapture);
  const visualNodes = (visual?.nodes ?? []).filter((node) => node.runId && node.visualEvidenceRequired !== false);
  const nonVisualNodes = (visual?.nodes ?? []).filter((node) => node.runId && node.visualEvidenceRequired === false);
  const previewRequired = objectiveEvidence.plan?.integration?.previewRequired === true;
  // Visual capture is part of the preview delivery path. Plans that explicitly
  // opt out of aggregate preview (for example read-only API diagnostics) must
  // not be blocked by an evidence type they did not request.
  const visualEvidenceRequired = previewRequired && visualNodes.length > 0;
  const visualEvidenceComplete = !visualEvidenceRequired || visualNodes.every((node) => {
    const visualRefsPresent = node.evidenceRefs.length > 0 || node.captureRefs.length > 0;
    const checksPass = node.verificationChecks.every((check) => check.status === "PASS" || check.passed === true);
    return visualRefsPresent && checksPass;
  });
  const integrationRequired = objectiveEvidence.verification.integration.required === true;
  const integrationComplete = !integrationRequired || objectiveEvidence.verification.integration.status === "PASS";
  const previewComplete = !previewRequired || Boolean(preview && preview.status === "READY");
  const cleanupComplete = (!previewRequired || preview?.cleanup?.status === "CLEANED") && runCleanups.every((item) => item.cleaned);
  const checks = [
    result("PLAN_COMPLETE", objectiveEvidence.plan?.state === "APPROVED", "Approved objective plan is present.", { planId: objectiveEvidence.plan?.planId ?? null, state: objectiveEvidence.plan?.state ?? null }),
    result("EXECUTION_COMPLETE", objectiveEvidence.orchestration?.state === "DONE" && objectiveEvidence.nodes.length > 0 && objectiveEvidence.nodes.every((node) => node.state === "DONE"), "All objective nodes and orchestration are done.", { orchestrationState: objectiveEvidence.orchestration?.state ?? null, nodeStates: objectiveEvidence.nodes.map((node) => ({ nodeId: node.nodeId, state: node.state })) }),
    result("INTEGRATION_COMPLETE", integrationComplete, "Required integration verification is passing or not required.", { required: integrationRequired, status: objectiveEvidence.verification.integration.status }),
    result("PREVIEW_COMPLETE", previewComplete, previewRequired ? "Aggregate preview reached READY for the objective." : "Aggregate preview is not required by the approved plan.", { required: previewRequired, sessionId: preview?.sessionId ?? null, status: previewRequired ? (preview?.status ?? "MISSING") : "NOT_REQUIRED", previewCount: preview?.previews?.length ?? 0, unavailableCount: preview?.unavailable?.length ?? 0 }),
    result("VISUAL_E2E_EVIDENCE_COMPLETE", visualEvidenceComplete, visualEvidenceRequired ? "Every visual-applicable node has linked visual evidence and passing node checks." : "Visual capture is not required for the applicable nodes in the approved plan.", { required: visualEvidenceRequired, evidenceCount: visual?.summary?.evidenceCount ?? 0, captureCount: visual?.summary?.captureCount ?? 0, nodeCount: visualNodes.length, excludedNodeCount: nonVisualNodes.length, excludedNodeIds: nonVisualNodes.map((node) => node.nodeId) }),
    result("HUMAN_ACCEPTANCE_COMPLETE", automatic || objectiveEvidence.finalAcceptance.state === "ACCEPTED", automatic ? "Final acceptance is handled by the single final user gate." : "Objective final acceptance is recorded by a human gate.", { required: !automatic, state: objectiveEvidence.finalAcceptance.state, acceptedBy: objectiveEvidence.finalAcceptance.acceptedBy ?? null, acceptedAt: objectiveEvidence.finalAcceptance.acceptedAt ?? null }),
    result("CLEANUP_COMPLETE", cleanupComplete, previewRequired ? "Aggregate preview and isolated run workspaces are cleaned." : "Isolated run workspaces are cleaned; aggregate preview was not required.", { previewRequired, previewCleanup: previewRequired ? (preview?.cleanup?.status ?? "MISSING") : "NOT_REQUIRED", runCleanups }),
    result("KNOWLEDGE_CAPTURE_COMPLETE", knowledge.length > 0 && knowledge.every((item) => item.approved && item.synced), "Knowledge approval/capture is present for every source run.", { knowledge }),
  ];
  const blockers = checks.filter((check) => check.status !== "PASS").map((check) => check.id);
  const machineReady = blockers.length === 0;
  const certified = automatic && machineReady && objectiveEvidence.finalAcceptance.state === "ACCEPTED";
  return {
    schemaVersion: DELIVERY_CERTIFICATION_SCHEMA_VERSION,
    kind: DELIVERY_CERTIFICATION_KIND,
    objectiveId,
    createdAt: now.toISOString(),
    status: blockers.length ? "BLOCKED" : automatic ? (certified ? "CERTIFIED" : "READY_FOR_FINAL_ACCEPTANCE") : "HUMAN_GATE_REQUIRED",
    humanGate: { required: !automatic, confirmed: certified, approvedBy: certified ? "system:autopilot" : null, approvedAt: certified ? now.toISOString() : null },
    checks,
    blockers,
    evidence: {
      objective: { state: objectiveEvidence.objective.state, planId: objectiveEvidence.plan?.planId ?? null, orchestrationId: objectiveEvidence.orchestration?.orchestrationId ?? null },
      sourceRunIds: runIds,
      previewSessionId: preview?.sessionId ?? null,
      visualSummary: visual?.summary ?? null,
      finalAcceptance: objectiveEvidence.finalAcceptance,
    },
    nextAction: blockers.length
      ? "Orchestrator will retry safe failures and refresh this certification when the blockers are resolved."
      : automatic
        ? certified ? "Delivery certification completed automatically." : "Review the completed evidence, then use Final Accept once."
        : "Human gate must explicitly accept this delivery certification.",
  };
}

export function createDeliveryCertification({ runsRoot, objectiveId, now = new Date(), automatic = false } = {}) {
  const evidence = buildDeliveryCertificationEvidence({ runsRoot, objectiveId, now, automatic });
  const certificationId = `delivery-${objectiveId}-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const bundle = { ...evidence, certificationId };
  const persisted = writeBundle(path.join(certificationDirectory(runsRoot, objectiveId), `${certificationId}.json`), bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.checksum };
}

export function listDeliveryCertifications({ runsRoot, objectiveId } = {}) {
  if (!runsRoot || !SAFE_ID.test(String(objectiveId ?? ""))) return [];
  const directory = certificationDirectory(runsRoot, objectiveId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(directory, entry.name)))
    .filter((item) => item?.kind === DELIVERY_CERTIFICATION_KIND)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function getDeliveryCertification({ runsRoot, objectiveId, certificationId } = {}) {
  if (!SAFE_ID.test(String(certificationId ?? ""))) return null;
  const record = listDeliveryCertifications({ runsRoot, objectiveId }).find((item) => item.certificationId === certificationId);
  if (!record) return null;
  return { ...record, bundlePath: path.join(certificationDirectory(runsRoot, objectiveId), `${certificationId}.json`) };
}

export function verifyDeliveryCertification({ bundlePath } = {}) {
  if (!bundlePath || !fs.existsSync(bundlePath)) throw new Error("Delivery certification bundle tidak ditemukan.");
  const text = fs.readFileSync(bundlePath, "utf8");
  const bundle = readJson(bundlePath);
  const recorded = fs.existsSync(`${bundlePath}.sha256`) ? fs.readFileSync(`${bundlePath}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
  const checksumValid = recorded === sha256(text);
  const checksPass = Array.isArray(bundle?.checks) && bundle.checks.length > 0 && bundle.checks.every((check) => check.status === "PASS");
  const valid = Boolean(checksumValid && bundle?.schemaVersion === DELIVERY_CERTIFICATION_SCHEMA_VERSION && bundle?.kind === DELIVERY_CERTIFICATION_KIND && checksPass && ["HUMAN_GATE_REQUIRED", "READY_FOR_FINAL_ACCEPTANCE", "CERTIFIED"].includes(bundle.status));
  return { valid, checksumValid, checksPass, status: bundle?.status ?? null, certificationId: bundle?.certificationId ?? null, bundle };
}

export function acceptDeliveryCertification({ bundlePath, approvedBy, now = new Date() } = {}) {
  if (!String(approvedBy ?? "").trim()) throw new Error("Delivery certification membutuhkan identitas operator.");
  const verification = verifyDeliveryCertification({ bundlePath });
  if (!verification.valid || verification.status !== "HUMAN_GATE_REQUIRED") throw new Error("Delivery certification belum memenuhi seluruh machine gate atau sudah diproses.");
  const accepted = { ...verification.bundle, status: "CERTIFIED", humanGate: { ...verification.bundle.humanGate, confirmed: true, approvedBy: String(approvedBy).trim(), approvedAt: now.toISOString() }, nextAction: "Delivery certification accepted; delivery remains subject to the separate release/activation gate." };
  const persisted = writeBundle(bundlePath, accepted);
  return { ...accepted, bundlePath: persisted.filePath, checksum: persisted.checksum };
}
