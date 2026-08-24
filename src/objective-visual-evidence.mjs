import { listVisualEvidence } from "./visual-evidence.mjs";
import { listCaptureReports } from "./visual-qa.mjs";
import { getVisualQACertification } from "./visual-certification.mjs";
import { listVisualRevisions } from "./visual-revision.mjs";
import { getRun } from "./run-manager.mjs";

export const OBJECTIVE_VISUAL_EVIDENCE_SCHEMA_VERSION = 1;

const NON_VISUAL_NODE_TYPES = new Set(["VERIFICATION", "DIAGNOSTIC"]);
const NON_VISUAL_NODE_ROLES = new Set(["BACKEND", "DATABASE", "TESTING", "DIAGNOSTIC"]);

/**
 * Visual capture is meaningful for UI-facing work only. Backend/API,
 * verification, and diagnostic nodes must provide automated/API evidence
 * instead of being blocked by a screenshot gate.
 */
export function nodeRequiresVisualEvidence(node = {}) {
  const type = String(node.type ?? "").toUpperCase();
  const role = String(node.role ?? "").toUpperCase();
  return !NON_VISUAL_NODE_TYPES.has(type) && !NON_VISUAL_NODE_ROLES.has(role);
}

function runState(runsRoot, runId) {
  try { return getRun(runsRoot, runId)?.state ?? null; } catch { return null; }
}

function evidenceRef({ objectiveId, node, evidence }) {
  return {
    evidenceId: evidence.evidenceId,
    href: `/api/runs/${encodeURIComponent(evidence.runId)}/visual-evidence/${encodeURIComponent(evidence.evidenceId)}`,
    runId: evidence.runId,
    nodeId: node.nodeId,
    projectId: node.projectId,
    route: evidence.route,
    viewport: evidence.viewport,
    checks: {
      actualStatus: evidence.actual?.status ?? "UNAVAILABLE",
      comparisonStatus: evidence.comparison?.status ?? "UNKNOWN",
      accessibilityStatus: evidence.accessibility?.status ?? "UNKNOWN",
    },
    artifact: {
      exists: evidence.artifact?.exists === true,
      contentType: evidence.artifact?.contentType ?? null,
      sha256: evidence.artifact?.sha256 ?? null,
    },
    createdAt: evidence.createdAt,
    objectiveId,
  };
}

export function buildObjectiveVisualEvidence({ runsRoot, objective, nodes = [] } = {}) {
  const reportNodes = nodes.map((node) => {
    const state = node.runId ? runState(runsRoot, node.runId) : null;
    const evidence = node.runId ? listVisualEvidence({ runsRoot, runId: node.runId }) : [];
    const captures = node.runId ? listCaptureReports({ runsRoot, runId: node.runId }) : [];
    const revisions = node.runId ? listVisualRevisions({ runsRoot, runId: node.runId }) : [];
    let certification = null;
    if (node.runId) {
      try { certification = getVisualQACertification({ runsRoot, runId: node.runId }); } catch { certification = null; }
    }
    return {
      nodeId: node.nodeId,
      projectId: node.projectId,
      type: node.type ?? null,
      role: node.role ?? null,
      visualEvidenceRequired: nodeRequiresVisualEvidence(node),
      runId: node.runId,
      nodeState: node.state,
      runState: state,
      verificationChecks: Array.isArray(node.verification) ? node.verification.map((check) => ({ ...check })) : [],
      evidenceRefs: evidence.map((item) => evidenceRef({ objectiveId: objective?.objectiveId ?? null, node, evidence: item })),
      captureRefs: captures.map((capture) => ({
        captureId: capture.captureId,
        href: `/api/runs/${encodeURIComponent(node.runId)}/visual-evidence/captures`,
        route: capture.route,
        status: capture.status,
        comparisonStatus: capture.comparisonStatus,
        viewportNames: capture.viewports?.map((item) => item.name) ?? [],
        evidenceIds: capture.viewports?.map((item) => item.evidenceId).filter(Boolean) ?? [],
        completedAt: capture.completedAt,
      })),
      revisions: revisions.map((revision) => ({
        revisionId: revision.revisionId,
        href: `/api/runs/${encodeURIComponent(node.runId)}/visual-revisions/${revision.iteration}`,
        iteration: revision.iteration,
        status: revision.status,
        beforeEvidenceIds: revision.beforeEvidenceIds,
        afterEvidenceIds: revision.afterEvidenceIds,
        reason: revision.reason,
      })),
      certification: certification ? {
        certificationId: certification.certificationId,
        href: `/api/runs/${encodeURIComponent(node.runId)}/visual-certification`,
        status: certification.status,
        blockers: certification.blockers,
      } : null,
      requestChanges: {
        available: Boolean(node.runId && ["REVIEW", "RETROSPECTIVE"].includes(state)),
        href: `/api/objectives/${encodeURIComponent(objective?.objectiveId ?? "")}/visual-evidence/request-changes`,
        method: "POST",
        reasonRequired: true,
      },
    };
  });
  const evidenceRefs = reportNodes.flatMap((node) => node.evidenceRefs);
  const latestCaptureRefs = reportNodes.map((node) => node.captureRefs[0]).filter(Boolean);
  const latestEvidenceIds = new Set(latestCaptureRefs.flatMap((capture) => capture.evidenceIds ?? []));
  const latestEvidenceCount = latestCaptureRefs.length > 0 ? latestEvidenceIds.size : evidenceRefs.length;
  const projects = new Set(reportNodes.map((node) => node.projectId).filter(Boolean));
  const routes = new Set(evidenceRefs.map((item) => item.route));
  const viewports = new Set(evidenceRefs.map((item) => item.viewport?.name).filter(Boolean));
  return {
    schemaVersion: OBJECTIVE_VISUAL_EVIDENCE_SCHEMA_VERSION,
    mode: "objective-visual-evidence",
    objectiveId: objective?.objectiveId ?? null,
    nodes: reportNodes,
    summary: {
      nodeCount: reportNodes.length,
      projectCount: projects.size,
      evidenceCount: evidenceRefs.length,
      captureCount: reportNodes.reduce((count, node) => count + node.captureRefs.length, 0),
      latestEvidenceCount,
      latestCaptureCount: latestCaptureRefs.length,
      historicalEvidenceCount: evidenceRefs.length,
      historicalCaptureCount: reportNodes.reduce((count, node) => count + node.captureRefs.length, 0),
      latestCaptureAt: latestCaptureRefs.map((capture) => capture.completedAt).filter(Boolean).sort().at(-1) ?? null,
      revisionCount: reportNodes.reduce((count, node) => count + node.revisions.length, 0),
      verificationCheckCount: reportNodes.reduce((count, node) => count + node.verificationChecks.length, 0),
      certifiedNodeCount: reportNodes.filter((node) => node.certification?.status === "CERTIFIED").length,
      visualRequiredNodeCount: reportNodes.filter((node) => node.visualEvidenceRequired).length,
      nonVisualNodeCount: reportNodes.filter((node) => !node.visualEvidenceRequired).length,
      routes: [...routes],
      viewports: [...viewports],
    },
    ownership: "Each evidenceRef remains owned by its source node, project, and run; aggregate report does not duplicate screenshot artifacts.",
  };
}
