import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_VAULT, listProjects, buildContext, buildPlan, readMarkdown, loadRegistry } from "./core.mjs";
import { validateTaskReadiness } from "./task-readiness.mjs";
import { requestTask } from "./task-intake.mjs";
import { startTaskRun, recoverTaskRun, requestChangesTaskRun, rejectTaskRun, retryTaskRun } from "./task-workflow.mjs";
import { previewReviewWorkspace, formatReviewRevisionFeedback } from "./review-workflow.mjs";
import { listRuns, getRun, RUN_STATES } from "./run-manager.mjs";
import { enqueueTaskJob, listJobs, getJob, updateJobForRun, reconcileJobs, JOB_STATES } from "./job-queue.mjs";
import { listKnowledgeCandidates, promoteKnowledgeCandidate, rejectKnowledgeCandidate, acceptRun } from "./knowledge-workflow.mjs";
import { knowledgeHealth } from "./knowledge-quality.mjs";
import { listKnowledgeMaintenance, previewKnowledgeMerge, applyKnowledgeMerge, revertKnowledgeMerge } from "./knowledge-maintenance.mjs";
import { previewKnowledgeProvenanceMigration, applyKnowledgeProvenanceMigration, rollbackKnowledgeProvenanceMigration } from "./knowledge-provenance-migration.mjs";
import { listNotifications, acknowledgeNotifications, emitTestNotification } from "./notification-service.mjs";
import { telemetryReport } from "./telemetry.mjs";
import { daemonStatus } from "./daemon.mjs";
import { ensureApiToken, readExistingApiToken, authenticateRequest, validateOrigin, IdempotencyStore } from "./api/auth.mjs";
import { createEventHub } from "./api/events.mjs";
import { Router, sendJson, sendError, parseJsonBody } from "./api/router.mjs";
import { getRunDiff, globalDevServerManager } from "./dev-server-manager.mjs";
import { collectRtkAnalytics } from "./rtk-analytics.mjs";
import { onboardExistingProject, onboardNewProject, removeProject, purgeProjectArchive } from "./project-onboarding.mjs";
import { ingestRawKnowledge } from "./knowledge-ingest.mjs";
import { harvestRepositoryKnowledge, listHarvestRuns } from "./knowledge-harvester.mjs";
import { saveUploadedAsset, deleteUploadedAsset, resolveMockupAssetPath } from "./asset-manager.mjs";
import { buildRunEvidence } from "./interaction.mjs";
import { createAggregatePreviewEvidence, createVisualEvidence, getVisualEvidence, listAggregatePreviewEvidence, listVisualEvidence, persistAggregatePreviewEvidence, persistVisualEvidence } from "./visual-evidence.mjs";
import { auditVisualEvidence, captureVisualEvidence, comparePersistedVisualEvidence, listCaptureReports } from "./visual-qa.mjs";
import { completeVisualRevision, getVisualRevision, listVisualRevisions } from "./visual-revision.mjs";
import { createVisualQACertification, getVisualQACertification } from "./visual-certification.mjs";
import { readRecoveryMode } from "./recovery-mode.mjs";
import { OperatorSessionStore } from "./api/operator-session.mjs";
import { appendAuditEntry, verifyAuditChain } from "./audit-chain.mjs";
import { RequestRateLimiter, operationsReadiness, previewRetention, applyRetentionPlan, listRetentionTrash, restoreRetentionTrash, acknowledgeOperationsAlert, listOperationsAlertAcknowledgements, listOperationsAlertResolutions, resolveOperationsAlert } from "./operations-governance.mjs";
import { backupRecoveryStatus, previewBackupSchedule, previewBackupRotation, verifyRegisteredBackup, recordRecoveryDrill } from "./backup-operations.mjs";
import { getReleaseOperations } from "./release-operations.mjs";
import { createObjectiveIntake, getObjectiveIntake, listObjectiveIntake, objectivesEnabled, crossProjectEnabled } from "./objective-intake.mjs";
import { approveFreshProjectGenesis, auditGenesisApproval } from "./fresh-project-genesis.mjs";
import { getObjective } from "./objective-store.mjs";
import { buildObjectiveGraph } from "./objective-graph.mjs";
import { listDecisions, listDecisionInbox } from "./decision-store.mjs";
import { listPlans } from "./plan-store.mjs";
import { approvePlan, assignPlanSkills, cancelObjective, clarifyPlan, createPlanRevision, getObjectiveLifecycle, planRevision, requestPlanChanges, requestScopeExpansion } from "./plan-lifecycle.mjs";
import { defaultSkillRegistryPath, listInstalledSkills, updateSkillEnabled } from "./skill-registry.mjs";
import { projectSignalsForProjects } from "./skill-assignment.mjs";
import { materializeApprovedPlan } from "./task-materializer.mjs";
import { cancelOrchestration, requestNodeRetry, resolveDecision } from "./orchestration-scheduler.mjs";
import { getIntegrationEvidence, recoverIntegration, startIntegration } from "./integration-manager.mjs";
import { acceptObjective, buildObjectiveEvidence } from "./objective-evidence.mjs";
import { buildObjectiveVisualEvidence } from "./objective-visual-evidence.mjs";
import { acceptDeliveryCertification, createDeliveryCertification, getDeliveryCertification, listDeliveryCertifications } from "./delivery-certification.mjs";
import { getProjectRelationships, replaceProjectRelationships } from "./project-relations.mjs";

const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "DELETE"]);
const RUNTIME_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return "unknown"; }
})();

function validateRouteIdentifiers(params) {
  for (const name of ["id", "projectId", "evidenceId", "skillId"]) {
    if (!Object.hasOwn(params, name)) continue;
    const value = String(params[name] ?? "");
    if (!value || !/^[A-Za-z0-9._-]+$/.test(value) || [".", ".."].includes(value)) {
      const error = new Error(`${name} tidak valid.`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function integrationEvidenceDto(evidence) {
  if (!evidence) return null;
  return {
    ...evidence,
    projectBaselines: evidence.projectBaselines ?? {},
    services: Array.isArray(evidence.services) ? evidence.services : [],
    repositoryAcceptance: Array.isArray(evidence.repositoryAcceptance) ? evidence.repositoryAcceptance : [],
    crossProjectVerification: evidence.crossProjectVerification ?? { required: false, status: "NOT_REQUIRED", results: [] },
  };
}

function skillUsage({ runsRoot, skills }) {
  const usage = Object.fromEntries(skills.map((skill) => [`${skill.skillId}@${skill.version}`, {
    planAssignments: 0,
    runAssignments: 0,
    lastSeenAt: null,
  }]));
  const touch = (assignment, field, timestamp) => {
    const key = `${assignment?.skillId ?? ""}@${assignment?.version ?? ""}`;
    if (!usage[key]) return;
    usage[key][field] += 1;
    if (timestamp && (!usage[key].lastSeenAt || timestamp > usage[key].lastSeenAt)) usage[key].lastSeenAt = timestamp;
  };
  for (const plan of listPlans(runsRoot)) {
    for (const node of plan.nodes ?? []) for (const assignment of node.skills ?? []) touch(assignment, "planAssignments", plan.updatedAt ?? plan.createdAt);
  }
  for (const run of listRuns(runsRoot)) {
    for (const assignment of run.task?.skills ?? []) touch(assignment, "runAssignments", run.updatedAt ?? run.createdAt);
  }
  return usage;
}

export function idempotencyScopeKey({ key, method, requestTarget, rawBody = "" }) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey || normalizedKey.length > 200) {
    throw new Error("Idempotency-Key harus berisi 1-200 karakter.");
  }
  return createHash("sha256")
    .update(`${String(method).toUpperCase()}\n${requestTarget}\n${normalizedKey}\n${rawBody}`)
    .digest("hex");
}

export function createRouter({ vaultRoot, runsRoot, eventHub, services, sourceRoot = process.cwd(), releaseCandidateRoot = process.env.ORCHESTRATOR_RELEASE_CANDIDATE_ROOT ?? null, env = process.env }) {
  const router = new Router();

  // --- 1. System & Health ---
  router.get("/api/health", async (req, res) => {
    sendJson(res, 200, {
      success: true,
      data: {
        status: "healthy",
        service: "personal-ai-orchestrator-api",
        version: RUNTIME_VERSION,
        timestamp: new Date().toISOString(),
      },
    });
  });

  router.get("/api/daemon/status", async (req, res) => {
    const status = daemonStatus({ runsRoot });
    sendJson(res, 200, { success: true, data: status });
  });

  router.get("/api/events", async (req, res) => {
    eventHub.addClient(req, res);
  });

  router.get("/api/operations/readiness", async (req, res) => {
    const readiness = operationsReadiness({ runsRoot });
    sendJson(res, 200, { success: readiness.admission.allowed, data: readiness });
  });

  router.get("/api/operations/backups/status", async (req, res) => {
    try {
      sendJson(res, 200, { success: true, data: backupRecoveryStatus({ runsRoot, vaultRoot }) });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.post("/api/operations/backups/schedule/preview", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const preview = previewBackupSchedule({ runsRoot, vaultRoot, backupRoot: body?.backupRoot, intervalHours: body?.intervalHours ?? 24 });
      sendJson(res, 200, { success: true, data: preview });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.post("/api/operations/backups/rotation/preview", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const preview = previewBackupRotation({ backupRoot: body?.backupRoot, sourceRoots: [vaultRoot, runsRoot], olderThanDays: body?.olderThanDays ?? 30, keepLatest: body?.keepLatest ?? 2 });
      sendJson(res, 200, { success: true, data: preview });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.post("/api/operations/backups/verify", async (req, res) => {
    try {
      const result = verifyRegisteredBackup({ runsRoot });
      eventHub.broadcast("BACKUP_VERIFIED", { backupId: result.status.backupId });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.post("/api/operations/recovery-drill/record", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = recordRecoveryDrill({ runsRoot, performedBy: req.operatorIdentity ?? body?.performedBy, evidence: body?.evidence, result: body?.result ?? "PASS", rtoMinutes: body?.rtoMinutes });
      eventHub.broadcast("RECOVERY_DRILL_RECORDED", { drillId: result.drillId, result: result.result });
      sendJson(res, 201, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.get("/api/operations/release", async (req, res) => {
    try {
      const readReleaseOperations = services?.getReleaseOperations ?? getReleaseOperations;
      const release = readReleaseOperations({ sourceRoot, releaseCandidateRoot, runsRoot });
      sendJson(res, 200, { success: true, data: release });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message);
    }
  });

  router.get("/api/operations/alerts/acknowledgements", async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    sendJson(res, 200, { success: true, data: listOperationsAlertAcknowledgements({ runsRoot, alertId: parsedUrl.searchParams.get("alertId") }) });
  });

  router.post("/api/operations/alerts/acknowledge", async (req, res) => {
    const body = await parseJsonBody(req);
    const result = acknowledgeOperationsAlert({ runsRoot, alertId: body.alertId, acknowledgedBy: body.acknowledgedBy ?? body.readBy, owner: body.owner, dedupeKey: body.dedupeKey, note: body.note, snoozeUntil: body.snoozeUntil, snoozeMinutes: body.snoozeMinutes });
    sendJson(res, 200, { success: true, data: result });
  });

  router.get("/api/operations/alerts/resolutions", async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    sendJson(res, 200, { success: true, data: listOperationsAlertResolutions({ runsRoot, alertId: parsedUrl.searchParams.get("alertId") }) });
  });

  router.post("/api/operations/alerts/resolve", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = resolveOperationsAlert({ runsRoot, alertId: body.alertId, resolvedBy: body.resolvedBy ?? body.acknowledgedBy, evidence: body.evidence, note: body.note });
      eventHub.broadcast("OPERATIONS_ALERT_RESOLVED", { alertId: result.alertId, resolvedBy: result.resolvedBy });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message); }
  });

  router.post("/api/operations/retention/preview", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const plan = previewRetention({ runsRoot, olderThanDays: body?.olderThanDays ?? 30 });
      eventHub.broadcast("RETENTION_PREVIEWED", { planId: plan.planId, candidateCount: plan.summary.candidateCount });
      sendJson(res, 201, { success: true, data: plan });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.post("/api/operations/retention/purge", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = applyRetentionPlan({ runsRoot, planId: body?.planId, confirmed: body?.confirm === true, confirmedBy: body?.confirmedBy });
      eventHub.broadcast("RETENTION_MOVED_TO_TRASH", { planId: result.planId, moved: result.moved.length });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.get("/api/operations/retention/trash", async (req, res) => {
    sendJson(res, 200, { success: true, data: listRetentionTrash({ runsRoot }) });
  });

  router.post("/api/operations/retention/restore", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = restoreRetentionTrash({ runsRoot, trashId: body?.trashId, confirmed: body?.confirm === true, confirmedBy: body?.confirmedBy });
      eventHub.broadcast("RETENTION_RESTORED", { planId: result.planId, restored: result.restored.length });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  // --- 2. Projects ---
  router.get("/api/projects", async (req, res) => {
    const data = listProjects(vaultRoot);
    sendJson(res, 200, { success: true, data });
  });

  // --- v2.0 Objective Intake (planning/read-only only) ---
  router.post("/api/objectives", async (req, res) => {
    try {
      const enabled = services?.objectivesEnabled ?? objectivesEnabled;
      if (!enabled()) return sendError(res, 409, "Objective orchestration belum diaktifkan.", { code: "FEATURE_DISABLED", feature: "OBJECTIVES" });
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk objective intake.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const intake = services?.createObjectiveIntake ?? createObjectiveIntake;
      let result = intake({
        vaultRoot,
        runsRoot,
        body,
        requestedBy: req.operatorIdentity ?? body?.requestedBy ?? "user",
        isCrossProjectEnabled: services?.crossProjectEnabled ?? crossProjectEnabled,
      });
      if (body?.plan && result.objective.state === "PLANNING") {
        const planner = services?.createPlanRevision ?? createPlanRevision;
        const revision = planner({ runsRoot, objectiveId: result.objective.objectiveId, candidate: body.plan });
        result = {
          ...result,
          objective: revision.objective,
          plan: revision.plan,
          planning: { ...result.planning, started: true, planRevision: planRevision(revision.plan) },
        };
        appendAuditEntry(runsRoot, {
          event: "PLAN_REVISION_CREATED",
          actor: req.operatorIdentity ?? "local:unknown",
          objectiveId: revision.objective.objectiveId,
          planId: revision.plan.planId,
          revision: planRevision(revision.plan),
          planFingerprint: revision.plan.planFingerprint,
          state: revision.objective.state,
        });
        eventHub.broadcast("PLAN_REVISION_CREATED", {
          objectiveId: revision.objective.objectiveId,
          planId: revision.plan.planId,
          revision: planRevision(revision.plan),
          planFingerprint: revision.plan.planFingerprint,
          state: revision.objective.state,
        });
      }
      appendAuditEntry(runsRoot, {
        event: "OBJECTIVE_CREATED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        mode: result.objective.mode,
        state: result.objective.state,
      });
      eventHub.broadcast("OBJECTIVE_CREATED", {
        objectiveId: result.objective.objectiveId,
        mode: result.objective.mode,
        state: result.objective.state,
      });
      sendJson(res, 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.get("/api/objectives", async (req, res) => {
    try {
      const reader = services?.listObjectiveIntake ?? listObjectiveIntake;
      sendJson(res, 200, { success: true, data: reader({ runsRoot }) });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message, error.details);
    }
  });

  router.get("/api/objectives/:id", async (req, res, { params }) => {
    try {
      const reader = services?.getObjectiveLifecycle ?? getObjectiveLifecycle;
      sendJson(res, 200, { success: true, data: reader({ runsRoot, objectiveId: params.id }) });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details);
    }
  });

  router.get("/api/objectives/:id/integration", async (req, res, { params }) => {
    try {
      const objective = getObjective(runsRoot, params.id);
      const orchestrationId = objective?.activeOrchestrationId;
      sendJson(res, 200, { success: true, data: orchestrationId ? integrationEvidenceDto(getIntegrationEvidence({ runsRoot, orchestrationId })) : null });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details);
    }
  });

  router.get("/api/objectives/:id/graph", async (req, res, { params }) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      sendJson(res, 200, { success: true, data: buildObjectiveGraph({ runsRoot, objectiveId: params.id, page: parsedUrl.searchParams.get("page"), pageSize: parsedUrl.searchParams.get("pageSize") }) });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.get("/api/objectives/:id/evidence", async (req, res, { params }) => {
    try {
      sendJson(res, 200, { success: true, data: buildObjectiveEvidence({ runsRoot, objectiveId: params.id }) });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details);
    }
  });

  router.post("/api/objectives/:id/preview", async (req, res, { params }) => {
    try {
      const body = await parseJsonBody(req);
      const evidence = buildObjectiveEvidence({ runsRoot, objectiveId: params.id });
      const nodesByProject = new Map();
      for (const node of evidence.nodes) {
        if (node.state === "DONE" && node.runId && node.projectId) nodesByProject.set(node.projectId, node);
      }
      const planApproved = evidence.plan?.state === "APPROVED";
      const candidates = (evidence.objective.projectIds ?? []).map((projectId) => {
        const node = nodesByProject.get(projectId);
        return {
          projectId,
          runId: node?.runId ?? null,
          unavailableReason: planApproved ? (node ? null : "NO_COMPLETED_RUN_EVIDENCE") : "PLAN_NOT_APPROVED",
          unavailableMessage: planApproved ? (node ? null : "Tidak ada run DONE dengan evidence untuk project ini.") : "Preview hanya tersedia setelah plan objective di-approve.",
        };
      });
      const result = await globalDevServerManager.startAggregateProjectPreview({
        runsRoot,
        objectiveId: params.id,
        candidates,
        maxProjects: body?.maxProjects ?? 4,
        maxServers: body?.maxServers ?? 4,
        maxDurationMs: body?.maxDurationMs ?? undefined,
      });
      const evidenceRecord = persistAggregatePreviewEvidence({
        runsRoot,
        evidence: createAggregatePreviewEvidence({ objectiveId: params.id, preview: result }),
      });
      eventHub.broadcast("AGGREGATE_PREVIEW_STARTED", { objectiveId: params.id, sessionId: result.sessionId, status: result.status, previews: result.previews.length, unavailable: result.unavailable.length });
      sendJson(res, 200, { success: true, data: { ...result, evidence: evidenceRecord, approval: { planState: evidence.plan?.state ?? null, loopbackOnly: true } } });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details);
    }
  });

  router.post("/api/objectives/:id/preview/stop", async (req, res, { params }) => {
    try {
      const body = await parseJsonBody(req);
      if (!body?.sessionId) return sendError(res, 400, "sessionId wajib diisi.", { code: "SESSION_ID_REQUIRED" });
      const result = globalDevServerManager.stopAggregatePreview(body.sessionId, params.id);
      if (result.reason && result.stopped === false) return sendError(res, 404, result.reason, { code: "PREVIEW_SESSION_NOT_FOUND" });
      if (result.objectiveId) {
        persistAggregatePreviewEvidence({
          runsRoot,
          evidence: createAggregatePreviewEvidence({ objectiveId: result.objectiveId, preview: result }),
        });
      }
      eventHub.broadcast("AGGREGATE_PREVIEW_STOPPED", { objectiveId: params.id, sessionId: body.sessionId, status: result.cleanup?.status ?? null });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details);
    }
  });

  router.get("/api/objectives/:id/preview/status", async (req, res, { params }) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const sessionId = parsedUrl.searchParams.get("sessionId");
      if (!sessionId) return sendError(res, 400, "sessionId wajib diisi.", { code: "SESSION_ID_REQUIRED" });
      const result = globalDevServerManager.getAggregatePreviewStatus(sessionId);
      if (result.objectiveId && result.objectiveId !== params.id) return sendError(res, 404, "Aggregate preview session bukan milik objective ini.", { code: "PREVIEW_SESSION_NOT_FOUND" });
      sendJson(res, result.status === "NOT_FOUND" ? 404 : 200, { success: result.status !== "NOT_FOUND", data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details);
    }
  });

  router.get("/api/objectives/:id/preview/evidence", async (req, res, { params }) => {
    try {
      getObjective(runsRoot, params.id);
      sendJson(res, 200, { success: true, data: listAggregatePreviewEvidence({ runsRoot, objectiveId: params.id }) });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details);
    }
  });

  router.get("/api/objectives/:id/visual-evidence", async (req, res, { params }) => {
    try {
      const evidence = buildObjectiveEvidence({ runsRoot, objectiveId: params.id });
      sendJson(res, 200, { success: true, data: evidence.visualEvidence ?? buildObjectiveVisualEvidence({ runsRoot, objective: evidence.objective, nodes: evidence.nodes }) });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details);
    }
  });

  router.post("/api/objectives/:id/visual-evidence/request-changes", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const nodeId = typeof body?.nodeId === "string" ? body.nodeId : null;
    const requestedBy = typeof body?.requestedBy === "string" && body.requestedBy.trim() ? body.requestedBy.trim() : (req.operatorIdentity ?? "user");
    const rawReason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    if (!nodeId) return sendError(res, 400, "Missing required field: nodeId", { code: "OBJECTIVE_NODE_REQUIRED" });
    if (!rawReason) return sendError(res, 400, "Missing required field: reason", { code: "REASON_REQUIRED" });
    if (body?.inlineComments !== undefined && body.inlineComments !== null && !Array.isArray(body.inlineComments)) return sendError(res, 400, "Invalid field: inlineComments must be an array");
    if (body?.visualAnnotations !== undefined && body.visualAnnotations !== null && !Array.isArray(body.visualAnnotations)) return sendError(res, 400, "Invalid field: visualAnnotations must be an array");

    let evidence;
    try {
      evidence = buildObjectiveEvidence({ runsRoot, objectiveId: params.id });
    } catch (error) {
      return sendError(res, error.statusCode || 404, error.message, error.details);
    }
    const visualNode = evidence.visualEvidence?.nodes?.find((item) => item.nodeId === nodeId);
    if (!visualNode?.runId) return sendError(res, 409, `Node ${nodeId} belum memiliki run visual evidence.`, { code: "VISUAL_RUN_NOT_FOUND", nodeId });

    let run;
    try { run = getRun(runsRoot, visualNode.runId); } catch (error) { return sendError(res, 404, error.message); }
    if (![RUN_STATES.REVIEW, RUN_STATES.RETROSPECTIVE].includes(run.state)) return sendError(res, 409, `Request changes requires run in REVIEW or RETROSPECTIVE; current state: ${run.state}`, { code: "RUN_NOT_REVIEWABLE", runId: run.runId, nodeId });

    const inlineComments = Array.isArray(body?.inlineComments) ? body.inlineComments : [];
    const visualAnnotations = Array.isArray(body?.visualAnnotations) ? body.visualAnnotations : [];
    const effectiveReason = formatReviewRevisionFeedback({ reason: rawReason, inlineComments });
    const revisionIteration = (run.execution?.reviewChanges?.length ?? 0) + 1;
    const visualFeedback = {
      iteration: revisionIteration,
      inlineComments,
      visualAnnotations,
      beforeEvidenceIds: visualNode.evidenceRefs.map((item) => item.evidenceId),
    };
    const repairPath = {
      schemaVersion: 1,
      mode: "objective-visual-repair",
      status: "APPROVED_FOR_REPAIR",
      objectiveId: params.id,
      nodeId,
      projectId: visualNode.projectId,
      runId: visualNode.runId,
      revisionIteration,
      requestedBy,
      sourceEvidenceIds: visualFeedback.beforeEvidenceIds,
      requestChangesHref: `/api/objectives/${encodeURIComponent(params.id)}/visual-evidence/request-changes`,
      approval: { status: "APPROVED_FOR_REPAIR", source: "HUMAN_VISUAL_REVIEW", approvedBy: requestedBy, approvedAt: new Date().toISOString() },
      nextAction: "Repair revision sudah diotorisasi dan sedang diproses melalui run lifecycle.",
    };
    eventHub.broadcast("OBJECTIVE_VISUAL_REPAIR_REQUESTED", { objectiveId: params.id, nodeId, runId: visualNode.runId, revisionIteration, requestedBy });
    sendJson(res, 202, { success: true, data: repairPath });

    (async () => {
      try {
        const manifest = await requestChangesTaskRun({
          vaultRoot,
          runsRoot,
          runId: visualNode.runId,
          requestedBy,
          reason: effectiveReason,
          visualFeedback,
          onProgress: (m) => eventHub.broadcast("RUN_PROGRESS", { runId: m.runId, state: m.state }),
        });
        updateJobForRun(runsRoot, manifest.runId, { state: manifest.state === RUN_STATES.REVIEW ? JOB_STATES.REVIEW : JOB_STATES.RUNNING, runState: manifest.state });
        eventHub.broadcast("RUN_PROGRESS", { runId: manifest.runId, state: manifest.state });
      } catch (error) {
        eventHub.broadcast("RUN_FAILED", { runId: visualNode.runId, error: error.message, objectiveId: params.id, nodeId });
      }
    })();
  });

  router.get("/api/objectives/:id/delivery-certification", async (req, res, { params }) => {
    try {
      getObjective(runsRoot, params.id);
      const history = listDeliveryCertifications({ runsRoot, objectiveId: params.id });
      sendJson(res, 200, { success: true, data: { latest: history[0] ?? null, history } });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details);
    }
  });

  router.post("/api/objectives/:id/delivery-certification", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk delivery certification.", { code: "IDEMPOTENCY_REQUIRED" });
      const result = createDeliveryCertification({ runsRoot, objectiveId: params.id });
      appendAuditEntry(runsRoot, { event: "DELIVERY_CERTIFICATION_CREATED", actor: req.operatorIdentity ?? "local:unknown", objectiveId: params.id, certificationId: result.certificationId, status: result.status, blockers: result.blockers });
      eventHub.broadcast("DELIVERY_CERTIFICATION_CREATED", { objectiveId: params.id, certificationId: result.certificationId, status: result.status, blockers: result.blockers });
      sendJson(res, result.status === "HUMAN_GATE_REQUIRED" ? 201 : 409, { success: result.status === "HUMAN_GATE_REQUIRED", data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details);
    }
  });

  router.post("/api/objectives/:id/delivery-certification/accept", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk delivery certification acceptance.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const history = listDeliveryCertifications({ runsRoot, objectiveId: params.id });
      const selected = body?.certificationId ? getDeliveryCertification({ runsRoot, objectiveId: params.id, certificationId: body.certificationId }) : history[0] ? getDeliveryCertification({ runsRoot, objectiveId: params.id, certificationId: history[0].certificationId }) : null;
      if (!selected) return sendError(res, 404, "Delivery certification bundle tidak ditemukan.", { code: "DELIVERY_CERTIFICATION_NOT_FOUND" });
      const result = acceptDeliveryCertification({ bundlePath: selected.bundlePath, approvedBy: req.operatorIdentity });
      eventHub.broadcast("DELIVERY_CERTIFICATION_ACCEPTED", { objectiveId: params.id, certificationId: result.certificationId, approvedBy: result.humanGate.approvedBy });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 409, error.message, error.details);
    }
  });

  router.post("/api/objectives/:id/final-acceptance", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk final acceptance objective.", { code: "IDEMPOTENCY_REQUIRED" });
      const accept = services?.acceptObjective ?? acceptObjective;
      const result = accept({ runsRoot, objectiveId: params.id, acceptedBy: req.operatorIdentity });
      appendAuditEntry(runsRoot, {
        event: result.alreadyAccepted ? "OBJECTIVE_ACCEPTANCE_IDEMPOTENT" : "OBJECTIVE_ACCEPTED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: params.id,
        orchestrationId: result.evidence?.orchestration?.orchestrationId ?? null,
        decisionId: result.decision?.decisionId ?? result.evidence?.finalAcceptance?.decisionId ?? null,
      });
      eventHub.broadcast(result.alreadyAccepted ? "OBJECTIVE_ACCEPTANCE_IDEMPOTENT" : "OBJECTIVE_ACCEPTED", {
        objectiveId: params.id,
        orchestrationId: result.evidence?.orchestration?.orchestrationId ?? null,
        decisionId: result.decision?.decisionId ?? result.evidence?.finalAcceptance?.decisionId ?? null,
        state: result.objective?.state ?? result.evidence?.objective?.state ?? null,
      });
      sendJson(res, result.alreadyAccepted ? 200 : 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 409, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/integration", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk memulai integration.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const integrator = services?.startIntegration ?? startIntegration;
      const result = await integrator({
        vaultRoot,
        runsRoot,
        objectiveId: params.id,
        orchestrationId: body?.orchestrationId ?? null,
        integrationNodeId: body?.integrationNodeId ?? null,
        verificationRunner: services?.integrationVerificationRunner ?? services?.processRunner ?? null,
      });
      appendAuditEntry(runsRoot, {
        event: result.action,
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: params.id,
        orchestrationId: result.orchestration?.orchestrationId ?? result.evidence?.orchestrationId ?? body?.orchestrationId ?? null,
        decisionId: result.decision?.decisionId ?? null,
        evidencePath: result.evidence?.artifactPath ?? null,
      });
      eventHub.broadcast(result.action, {
        objectiveId: params.id,
        orchestrationId: result.orchestration?.orchestrationId ?? result.evidence?.orchestrationId ?? body?.orchestrationId ?? null,
        decisionId: result.decision?.decisionId ?? null,
        status: result.evidence?.status ?? result.integration?.state ?? null,
      });
      const status = result.action === "INTEGRATION_BLOCKED" ? 409 : result.action === "INTEGRATION_IN_PROGRESS" ? 202 : result.action === "INTEGRATION_NOT_REQUIRED" || result.action === "INTEGRATION_ALREADY_COMPLETED" ? 200 : 201;
      sendJson(res, status, { success: status < 400, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/integration/recovery", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk integration recovery.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const recoverer = services?.recoverIntegration ?? recoverIntegration;
      const result = recoverer({
        vaultRoot,
        runsRoot,
        objectiveId: params.id,
        orchestrationId: body?.orchestrationId ?? null,
      });
      appendAuditEntry(runsRoot, {
        event: result.action,
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: params.id,
        orchestrationId: result.evidence?.orchestrationId ?? body?.orchestrationId ?? null,
        planId: result.plan?.planId ?? null,
        decisionId: result.decision?.decisionId ?? null,
        classification: result.classification?.classification ?? null,
      });
      eventHub.broadcast(result.action, {
        objectiveId: params.id,
        orchestrationId: result.evidence?.orchestrationId ?? body?.orchestrationId ?? null,
        planId: result.plan?.planId ?? null,
        decisionId: result.decision?.decisionId ?? null,
        classification: result.classification?.classification ?? null,
      });
      sendJson(res, result.action === "INTEGRATION_REPAIR_PROPOSED" ? 201 : 200, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.get("/api/decisions", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const objectiveId = parsedUrl.searchParams.get("objectiveId");
      const state = parsedUrl.searchParams.get("state");
      const decisions = (services?.listDecisions ?? listDecisions)(runsRoot)
        .filter((decision) => !objectiveId || decision.objectiveId === objectiveId)
        .filter((decision) => !state || decision.state === state);
      sendJson(res, 200, { success: true, data: decisions });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message, error.details);
    }
  });

  router.get("/api/decisions/inbox", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const objectiveId = parsedUrl.searchParams.get("objectiveId");
      const state = parsedUrl.searchParams.get("state") || "OPEN";
      const limit = parsedUrl.searchParams.get("limit") || "100";
      const inbox = (services?.listDecisionInbox ?? listDecisionInbox)(runsRoot, { objectiveId, state, limit });
      sendJson(res, 200, { success: true, data: inbox });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message, error.details);
    }
  });

  router.post("/api/objectives/:id/plan", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk membuat plan revision.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      if (!body?.plan || typeof body.plan !== "object" || Array.isArray(body.plan)) return sendError(res, 400, "Field plan wajib berupa object.", { code: "INVALID_PLAN" });
      const planner = services?.createPlanRevision ?? createPlanRevision;
      const result = planner({ runsRoot, objectiveId: params.id, candidate: body.plan });
      appendAuditEntry(runsRoot, {
        event: "PLAN_REVISION_CREATED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
        state: result.objective.state,
      });
      eventHub.broadcast("PLAN_REVISION_CREATED", {
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
        state: result.objective.state,
      });
      sendJson(res, 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.get("/api/skills", async (_req, res) => {
    try {
      const skills = listInstalledSkills({ registryPath: defaultSkillRegistryPath(runsRoot), includeDisabled: true });
      const usage = skillUsage({ runsRoot, skills });
      sendJson(res, 200, {
        success: true,
        data: {
          schemaVersion: 1,
          mode: "read-only-skill-catalog",
          registryState: "AVAILABLE",
          skills: skills.map((skill) => ({
            skillId: skill.skillId,
            version: skill.version,
            purpose: skill.purpose,
            supportedRoles: skill.supportedRoles,
            supportedTaskTypes: skill.supportedTaskTypes,
            requiredContextTypes: skill.requiredContextTypes,
            requiredCapabilities: skill.requiredCapabilities,
            compatibleProjectSignals: skill.compatibleProjectSignals,
            riskLevel: skill.riskLevel,
            instructionChecksum: skill.instructions.sha256,
            verificationRequirements: skill.verificationRequirements,
            enabled: skill.enabled,
            provenance: skill.provenance,
            usage: usage[`${skill.skillId}@${skill.version}`] ?? { planAssignments: 0, runAssignments: 0, lastSeenAt: null },
          })),
        },
      });
    } catch (error) {
      if (error.code === "SKILL_REGISTRY_NOT_FOUND") return sendJson(res, 200, { success: true, data: { schemaVersion: 1, mode: "read-only-skill-catalog", registryState: "EMPTY", skills: [] } });
      sendError(res, error.statusCode || 422, error.message, error.details);
    }
  });

  router.put("/api/skills/:skillId", async (req, res, { params }) => {
    try {
      const body = await parseJsonBody(req);
      const result = updateSkillEnabled({
        registryPath: defaultSkillRegistryPath(runsRoot),
        skillId: params.skillId,
        version: body?.version ?? null,
        enabled: body?.enabled,
        changedBy: req.operatorIdentity,
      });
      appendAuditEntry(runsRoot, {
        event: result.changed ? (result.skill.enabled ? "SKILL_ENABLED" : "SKILL_DISABLED") : "SKILL_ENABLEMENT_UNCHANGED",
        actor: req.operatorIdentity ?? "local:unknown",
        skillId: result.skill.skillId,
        version: result.skill.version,
        enabled: result.skill.enabled,
        previousEnabled: result.previousEnabled,
        registryRevision: result.registry.revision,
      });
      eventHub.broadcast("SKILL_REGISTRY_UPDATED", {
        skillId: result.skill.skillId,
        version: result.skill.version,
        enabled: result.skill.enabled,
        registryRevision: result.registry.revision,
      });
      sendJson(res, result.changed ? 200 : 200, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || (error.code === "SKILL_REGISTRY_NOT_FOUND" ? 404 : 422), error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/plan/skills", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk skill assignment.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const result = assignPlanSkills({
        runsRoot,
        objectiveId: params.id,
        assignments: body?.assignments,
        assignedBy: req.operatorIdentity,
        registryPath: defaultSkillRegistryPath(runsRoot),
        projectSignalsByProject: projectSignalsForProjects(listProjects(vaultRoot)),
        env,
      });
      appendAuditEntry(runsRoot, {
        event: "PLAN_SKILLS_ASSIGNED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
        skillAssignments: result.skillAssignments,
        registryRevision: result.registryRevision,
      });
      eventHub.broadcast("PLAN_SKILLS_ASSIGNED", {
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
        skillAssignments: result.skillAssignments,
      });
      sendJson(res, 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || (error.code === "SKILL_REGISTRY_NOT_FOUND" ? 404 : 422), error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/clarify", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk clarification.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const clarifier = services?.clarifyPlan ?? clarifyPlan;
      const result = clarifier({
        runsRoot,
        objectiveId: params.id,
        answer: body?.answer ?? body?.clarification,
        candidate: body?.plan ?? null,
        clarifiedBy: req.operatorIdentity,
      });
      appendAuditEntry(runsRoot, {
        event: "PLAN_CLARIFIED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
      });
      eventHub.broadcast("PLAN_CLARIFIED", { objectiveId: result.objective.objectiveId, planId: result.plan.planId, revision: planRevision(result.plan), planFingerprint: result.plan.planFingerprint });
      sendJson(res, 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/approve-plan", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk approval plan.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const approver = services?.approvePlan ?? approvePlan;
      const result = approver({
        runsRoot,
        objectiveId: params.id,
        planId: body?.planId ?? null,
        expectedFingerprint: body?.planFingerprint ?? null,
        approvedBy: req.operatorIdentity,
      });
      appendAuditEntry(runsRoot, {
        event: result.alreadyApproved ? "PLAN_APPROVAL_IDEMPOTENT" : "PLAN_APPROVED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.planFingerprint,
        decisionId: result.decision?.decisionId ?? null,
        projects: result.plan.projects,
        risk: result.plan.risk,
        budget: result.objective.budget,
      });
      eventHub.broadcast(result.alreadyApproved ? "PLAN_APPROVAL_IDEMPOTENT" : "PLAN_APPROVED", {
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.planFingerprint,
        decisionId: result.decision?.decisionId ?? null,
        alreadyApproved: result.alreadyApproved,
      });
      sendJson(res, result.alreadyApproved ? 200 : 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/request-plan-changes", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk request plan changes.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const requester = services?.requestPlanChanges ?? requestPlanChanges;
      const result = requester({
        runsRoot,
        objectiveId: params.id,
        reason: body?.reason ?? body?.feedback,
        candidate: body?.plan ?? null,
        requestedBy: req.operatorIdentity,
      });
      appendAuditEntry(runsRoot, {
        event: "PLAN_CHANGES_REQUESTED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
        previousPlanId: result.previousPlan?.planId ?? null,
      });
      eventHub.broadcast("PLAN_CHANGES_REQUESTED", { objectiveId: result.objective.objectiveId, planId: result.plan.planId, revision: planRevision(result.plan), planFingerprint: result.plan.planFingerprint, previousPlanId: result.previousPlan?.planId ?? null });
      sendJson(res, 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/scope-expansion", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk scope expansion.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const requester = services?.requestScopeExpansion ?? requestScopeExpansion;
      const result = requester({
        runsRoot,
        objectiveId: params.id,
        reason: body?.reason ?? body?.feedback,
        candidate: body?.plan ?? null,
        requestedBy: req.operatorIdentity,
      });
      appendAuditEntry(runsRoot, {
        event: "SCOPE_EXPANSION_REQUESTED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
        previousPlanId: result.previousPlan?.planId ?? null,
      });
      eventHub.broadcast("SCOPE_EXPANSION_REQUESTED", {
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        revision: planRevision(result.plan),
        planFingerprint: result.plan.planFingerprint,
        previousPlanId: result.previousPlan?.planId ?? null,
      });
      sendJson(res, 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/retry-node", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk request retry node.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const requester = services?.requestNodeRetry ?? requestNodeRetry;
      const result = requester({
        runsRoot,
        objectiveId: params.id,
        orchestrationId: body?.orchestrationId ?? null,
        nodeId: body?.nodeId,
        reason: body?.reason ?? body?.feedback,
        requestedBy: req.operatorIdentity,
      });
      appendAuditEntry(runsRoot, {
        event: result.alreadyRequested ? "NODE_RETRY_DECISION_IDEMPOTENT" : "NODE_RETRY_DECISION_REQUESTED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: params.id,
        orchestrationId: result.orchestration?.orchestrationId ?? null,
        nodeId: result.decision?.nodeId ?? body?.nodeId ?? null,
        decisionId: result.decision?.decisionId ?? null,
        outcome: "DECISION_REQUIRED",
      });
      eventHub.broadcast(result.alreadyRequested ? "NODE_RETRY_DECISION_IDEMPOTENT" : "NODE_RETRY_DECISION_REQUESTED", {
        objectiveId: params.id,
        orchestrationId: result.orchestration?.orchestrationId ?? null,
        nodeId: result.decision?.nodeId ?? body?.nodeId ?? null,
        decisionId: result.decision?.decisionId ?? null,
        alreadyRequested: result.alreadyRequested,
      });
      sendJson(res, result.alreadyRequested ? 200 : 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/decisions/:id/resolve", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk resolve decision.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const resolver = services?.resolveDecision ?? resolveDecision;
      const result = resolver({
        runsRoot,
        decisionId: params.id,
        action: body?.action,
        budget: body?.budget,
        resolvedBy: req.operatorIdentity,
      });
      appendAuditEntry(runsRoot, {
        event: result.alreadyResolved ? "DECISION_RESOLUTION_IDEMPOTENT" : "DECISION_RESOLVED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.decision?.objectiveId ?? null,
        nodeId: result.decision?.nodeId ?? null,
        decisionId: result.decision?.decisionId ?? params.id,
        action: result.decision?.resolution?.action ?? body?.action ?? null,
        budget: result.decision?.resolution?.budget ?? null,
      });
      eventHub.broadcast(result.alreadyResolved ? "DECISION_RESOLUTION_IDEMPOTENT" : "DECISION_RESOLVED", {
        decisionId: result.decision?.decisionId ?? params.id,
        objectiveId: result.decision?.objectiveId ?? null,
        action: result.decision?.resolution?.action ?? body?.action ?? null,
        alreadyResolved: result.alreadyResolved,
      });
      sendJson(res, result.alreadyResolved ? 200 : 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/materialize", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk materialization task.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const materializer = services?.materializeApprovedPlan ?? materializeApprovedPlan;
      const result = materializer({
        vaultRoot,
        runsRoot,
        objectiveId: params.id,
        planId: body?.planId ?? null,
        expectedFingerprint: body?.planFingerprint ?? null,
        orchestrationId: body?.orchestrationId ?? null,
      });
      appendAuditEntry(runsRoot, {
        event: result.alreadyMaterialized ? "TASK_MATERIALIZATION_IDEMPOTENT" : "TASKS_MATERIALIZED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        orchestrationId: result.orchestration.orchestrationId,
        planFingerprint: result.planFingerprint,
        taskCount: result.tasks.length,
      });
      eventHub.broadcast(result.alreadyMaterialized ? "TASK_MATERIALIZATION_IDEMPOTENT" : "TASKS_MATERIALIZED", {
        objectiveId: result.objective.objectiveId,
        planId: result.plan.planId,
        orchestrationId: result.orchestration.orchestrationId,
        taskCount: result.tasks.length,
        alreadyMaterialized: result.alreadyMaterialized,
      });
      sendJson(res, result.alreadyMaterialized ? 200 : 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/cancel", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk cancel objective.", { code: "IDEMPOTENCY_REQUIRED" });
      const currentObjective = getObjective(runsRoot, params.id);
      const orchestrationCanceller = services?.cancelOrchestration ?? cancelOrchestration;
      const orchestrationResult = currentObjective?.activeOrchestrationId
        ? orchestrationCanceller({ runsRoot, objectiveId: params.id, orchestrationId: currentObjective.activeOrchestrationId, cancelledBy: req.operatorIdentity })
        : null;
      const canceller = services?.cancelObjective ?? cancelObjective;
      const result = canceller({ runsRoot, objectiveId: params.id, cancelledBy: req.operatorIdentity });
      result.orchestration = orchestrationResult?.orchestration ?? null;
      appendAuditEntry(runsRoot, {
        event: result.alreadyCancelled ? "OBJECTIVE_CANCEL_IDEMPOTENT" : "OBJECTIVE_CANCELLED",
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        planId: result.plan?.planId ?? null,
        orchestrationId: result.orchestration?.orchestrationId ?? null,
        outcome: result.alreadyCancelled ? "ALREADY_CANCELLED" : "CANCELLED",
      });
      eventHub.broadcast(result.alreadyCancelled ? "OBJECTIVE_CANCEL_IDEMPOTENT" : "OBJECTIVE_CANCELLED", {
        objectiveId: result.objective.objectiveId,
        planId: result.plan?.planId ?? null,
        orchestrationId: result.orchestration?.orchestrationId ?? null,
        alreadyCancelled: result.alreadyCancelled,
      });
      sendJson(res, result.alreadyCancelled ? 200 : 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/objectives/:id/approve-genesis", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk approval Fresh Project.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      const approver = services?.approveFreshProjectGenesis ?? approveFreshProjectGenesis;
      const result = await approver({
        vaultRoot,
        runsRoot,
        objectiveId: params.id,
        approvedBy: req.operatorIdentity ?? body?.approvedBy ?? "user",
        onboardNewProject: services?.onboardNewProject ?? undefined,
      });
      auditGenesisApproval(runsRoot, {
        actor: req.operatorIdentity ?? "local:unknown",
        objectiveId: result.objective.objectiveId,
        state: result.objective.state,
        decisionId: result.decision?.decisionId ?? null,
        outcome: result.alreadyCompleted ? "ALREADY_COMPLETED" : result.reconciled ? "RECONCILED" : "APPROVED_AND_ONBOARDED",
      });
      eventHub.broadcast("FRESH_PROJECT_CREATION", {
        objectiveId: result.objective.objectiveId,
        state: result.objective.state,
        decisionId: result.decision?.decisionId ?? null,
        outcome: result.alreadyCompleted ? "ALREADY_COMPLETED" : result.reconciled ? "RECONCILED" : "APPROVED_AND_ONBOARDED",
      });
      sendJson(res, result.alreadyCompleted || result.reconciled ? 200 : 201, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 500, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.post("/api/projects/onboard/existing", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const { repositoryPath, projectId = null } = body || {};
      if (!repositoryPath || typeof repositoryPath !== "string" || !repositoryPath.trim()) {
        return sendError(res, 400, "Missing required field: repositoryPath");
      }

      const onboardExisting = services?.onboardExistingProject ?? onboardExistingProject;
      const result = await onboardExisting({
        vaultRoot,
        runsRoot,
        repositoryPath: repositoryPath.trim(),
        projectId: projectId && typeof projectId === "string" ? projectId.trim() : null,
      });

      const effectiveProjectId = result?.project?.id || (projectId && typeof projectId === "string" ? projectId.trim() : null);
      eventHub.broadcast("PROJECT_ONBOARDED", {
        projectId: effectiveProjectId,
        mode: "existing",
      });

      sendJson(res, 201, { success: true, data: result });
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message);
    }
  });

  router.post("/api/projects/onboard/new", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const { projectId, projectName, targetDirectory, targetPath, blueprint = "frontend-vite" } = body || {};
      const resolvedProjectId = projectId || projectName;
      const resolvedTarget = targetDirectory || targetPath;

      if (!resolvedProjectId || typeof resolvedProjectId !== "string" || !resolvedProjectId.trim()) {
        return sendError(res, 400, "Missing required field: projectId");
      }
      if (!resolvedTarget || typeof resolvedTarget !== "string" || !resolvedTarget.trim()) {
        return sendError(res, 400, "Missing required field: targetDirectory");
      }

      const onboardNew = services?.onboardNewProject ?? onboardNewProject;
      const result = await onboardNew({
        vaultRoot,
        runsRoot,
        projectId: resolvedProjectId.trim(),
        projectName: resolvedProjectId.trim(),
        targetDirectory: resolvedTarget.trim(),
        targetPath: resolvedTarget.trim(),
        blueprint: blueprint || "frontend-vite",
      });

      const effectiveProjectId = result?.project?.id || resolvedProjectId.trim();
      eventHub.broadcast("PROJECT_ONBOARDED", {
        projectId: effectiveProjectId,
        mode: "new",
      });

      sendJson(res, 201, { success: true, data: result });
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message);
    }
  });

  router.get("/api/projects/:id", async (req, res, { params }) => {
    const registry = listProjects(vaultRoot);
    const project = registry.projects.find((p) => p.id === params.id);
    if (!project) {
      return sendError(res, 404, `Project not found: ${params.id}`);
    }
    sendJson(res, 200, { success: true, data: project });
  });

  router.get("/api/projects/:id/relationships", async (req, res, { params }) => {
    try {
      const reader = services?.getProjectRelationships ?? getProjectRelationships;
      const result = reader({ vaultRoot, projectId: params.id });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 404, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.put("/api/projects/:id/relationships", async (req, res, { params }) => {
    try {
      if (!req.headers["idempotency-key"]) return sendError(res, 400, "Idempotency-Key wajib untuk mengubah project relationships.", { code: "IDEMPOTENCY_REQUIRED" });
      const body = await parseJsonBody(req);
      if (!Array.isArray(body?.relationships)) return sendError(res, 400, "Field relationships wajib berupa array.", { code: "INVALID_RELATIONSHIPS" });
      if (body?.confirmed !== true && body?.confirm !== true) return sendError(res, 409, "Perubahan relationship membutuhkan konfirmasi human operator.", { code: "HUMAN_CONFIRMATION_REQUIRED" });
      const writer = services?.replaceProjectRelationships ?? replaceProjectRelationships;
      const result = writer({
        vaultRoot,
        runsRoot,
        projectId: params.id,
        relationships: body.relationships,
        confirmed: true,
        confirmedBy: req.operatorIdentity,
      });
      eventHub.broadcast(result.action, {
        projectId: params.id,
        relationshipCount: result.relationships.length,
        changed: result.changed,
      });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message, error.details ?? (error.code ? { code: error.code } : null));
    }
  });

  router.delete("/api/projects/:id", async (req, res, { params }) => {
    try {
      const projectId = params.id;
      if (!projectId) return sendError(res, 400, "Missing projectId");

      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch {
        body = {};
      }
      const purge = Boolean(body?.purge || req.url?.includes("purge=true"));

      const remover = services?.removeProject ?? removeProject;
      const removeResult = await remover({
        vaultRoot,
        runsRoot,
        projectId,
        removedBy: body?.removedBy || "dashboard-user",
      });

      let purgeResult = null;
      if (purge) {
        const purger = services?.purgeProjectArchive ?? purgeProjectArchive;
        purgeResult = await purger({
          vaultRoot,
          runsRoot,
          projectId,
          confirmed: true,
          purgedBy: body?.removedBy || "dashboard-user",
        });
      }

      eventHub.broadcast("PROJECT_REMOVED", {
        projectId,
        purged: purge,
      });

      sendJson(res, 200, {
        success: true,
        data: {
          projectId,
          purged: purge,
          removeResult,
          purgeResult,
        },
      });
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message, err.details);
    }
  });

  router.get("/api/projects-archive", async (req, res) => {
    try {
      const archiveBase = path.join(vaultRoot, "03-Sources", "other", "removed-projects");
      if (!fs.existsSync(archiveBase)) {
        return sendJson(res, 200, { success: true, data: { archivedProjects: [] } });
      }
      const entries = fs.readdirSync(archiveBase, { withFileTypes: true });
      const archivedProjects = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectId = entry.name;
        const projectDir = path.join(archiveBase, projectId);
        const versions = fs.readdirSync(projectDir, { withFileTypes: true })
          .filter((v) => v.isDirectory())
          .map((v) => v.name)
          .sort()
          .reverse();

        let latestManifest = null;
        const latestVersion = versions[0] || null;
        if (latestVersion) {
          const manifestPath = path.join(projectDir, latestVersion, "removal-manifest.json");
          if (fs.existsSync(manifestPath)) {
            try {
              latestManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            } catch {}
          }
        }
        archivedProjects.push({
          projectId,
          title: latestManifest?.project?.title || projectId,
          repository: latestManifest?.project?.repository || null,
          removedAt: latestManifest?.removedAt || null,
          removedBy: latestManifest?.removedBy || null,
          versionCount: versions.length,
          versions,
        });
      }
      sendJson(res, 200, { success: true, data: { archivedProjects } });
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message);
    }
  });

  router.delete("/api/projects-archive/:id", async (req, res, { params }) => {
    try {
      const projectId = params.id;
      if (!projectId) return sendError(res, 400, "Missing projectId");

      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch {
        body = {};
      }

      const purger = services?.purgeProjectArchive ?? purgeProjectArchive;
      const purgeResult = await purger({
        vaultRoot,
        runsRoot,
        projectId,
        confirmed: true,
        purgedBy: body?.purgedBy || "dashboard-user",
      });

      eventHub.broadcast("PROJECT_ARCHIVE_PURGED", {
        projectId,
      });

      sendJson(res, 200, {
        success: true,
        data: {
          projectId,
          purgeResult,
        },
      });
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message, err.details);
    }
  });

  router.post("/api/projects-archive/:id/restore", async (req, res, { params }) => {
    try {
      const projectId = params.id;
      if (!projectId) return sendError(res, 400, "Missing projectId");

      const archiveBase = path.join(vaultRoot, "03-Sources", "other", "removed-projects", projectId);
      if (!fs.existsSync(archiveBase)) {
        return sendError(res, 404, `Archive project tidak ditemukan untuk ${projectId}`);
      }

      const versions = fs.readdirSync(archiveBase, { withFileTypes: true })
        .filter((v) => v.isDirectory())
        .map((v) => v.name)
        .sort()
        .reverse();

      const latestVersion = versions[0];
      if (!latestVersion) {
        return sendError(res, 404, `Tidak ada snapshot arsip untuk project ${projectId}`);
      }

      const manifestPath = path.join(archiveBase, latestVersion, "removal-manifest.json");
      let repository = null;
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          repository = manifest?.project?.repository;
        } catch {}
      }

      if (!repository || !fs.existsSync(repository)) {
        return sendError(res, 400, `Repository path (${repository || "tidak diketahui"}) tidak ditemukan di filesystem lokal.`);
      }

      // Re-onboard project as existing
      const onboardExisting = services?.onboardExistingProject ?? onboardExistingProject;
      const result = await onboardExisting({
        vaultRoot,
        runsRoot,
        repositoryPath: repository,
        projectId,
      });

      eventHub.broadcast("PROJECT_ONBOARDED", {
        projectId,
        mode: "restore",
      });

      sendJson(res, 200, {
        success: true,
        data: {
          projectId,
          result,
        },
      });
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message, err.details);
    }
  });

  // --- 3. Tasks & Intake ---
  router.post("/api/tasks/request", async (req, res) => {
    const body = await parseJsonBody(req);
    const { project: projectId, request, requestedBy = "user", autoStart = false, attachedAssets = [] } = body;
    if (!projectId || !request) {
      return sendError(res, 400, "Missing required fields: project and request");
    }

    const registry = listProjects(vaultRoot);
    const project = registry.projects.find((p) => p.id === projectId);
    if (!project) {
      return sendError(res, 404, `Project not found: ${projectId}`);
    }

    const result = await requestTask({
      vaultRoot,
      runsRoot,
      project,
      request,
      requestedBy,
      autoStart,
      attachedAssets,
      readMarkdown: services.readMarkdown,
      validateTask: (resolvedProjectId, taskPath) => validateTaskReadiness(
        buildContext(vaultRoot, resolvedProjectId, taskPath),
        { readMarkdown: services.readMarkdown },
      ),
    });

    eventHub.broadcast("TASK_REQUESTED", {
      projectId,
      taskId: result.task?.id ?? null,
      autoStart,
    });

    sendJson(res, 201, { success: true, data: result });
  });

  router.post("/api/tasks/:projectId/:taskInput/cancel", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { closeBacklogTask } = await import("./task-lifecycle.mjs");
    const result = closeBacklogTask({
      vaultRoot,
      runsRoot,
      projectId: params.projectId,
      taskInput: params.taskInput,
      action: "CANCELLED",
      reason: body?.reason,
      requestedBy: body?.requestedBy ?? "user",
    });
    eventHub.broadcast("TASK_CANCELLED", { projectId: params.projectId, taskId: result.task.id });
    sendJson(res, 200, { success: true, data: result });
  });

  router.post("/api/tasks/:projectId/:taskInput/supersede", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { closeBacklogTask } = await import("./task-lifecycle.mjs");
    const result = closeBacklogTask({
      vaultRoot,
      runsRoot,
      projectId: params.projectId,
      taskInput: params.taskInput,
      action: "SUPERSEDED",
      reason: body?.reason,
      requestedBy: body?.requestedBy ?? "user",
    });
    eventHub.broadcast("TASK_SUPERSEDED", { projectId: params.projectId, taskId: result.task.id });
    sendJson(res, 200, { success: true, data: result });
  });

  router.post("/api/tasks/:projectId/:taskInput/queue", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const approvedBy = String(body?.approvedBy ?? "user").trim() || "user";
    const context = buildContext(vaultRoot, params.projectId, params.taskInput);
    if (context.task?.metadata?.orchestration_managed === true) {
      return sendError(
        res,
        409,
        "Task orchestration-managed hanya boleh diantrekan oleh sequential orchestration scheduler.",
        {
          code: "ORCHESTRATION_MANAGED_TASK",
          objectiveId: context.task.metadata.objective_id ?? null,
          orchestrationId: context.task.metadata.orchestration_id ?? null,
          nodeId: context.task.metadata.node_id ?? null,
        },
      );
    }
    const taskStatus = String(context.task?.metadata?.status ?? "").toUpperCase();
    if (!["BACKLOG", "READY"].includes(taskStatus)) {
      return sendError(res, 409, `Task harus BACKLOG atau READY sebelum diantrekan; status saat ini ${taskStatus || "UNKNOWN"}.`);
    }
    const readiness = validateTaskReadiness(context, { readMarkdown: services.readMarkdown });
    if (!readiness.ready) {
      return sendError(
        res,
        409,
        "Task tidak lolos readiness gate.",
        { readiness },
      );
    }
    const taskId = String(context.task.metadata.task_id ?? params.taskInput);
    const queued = enqueueTaskJob({
      runsRoot,
      projectId: params.projectId,
      taskId,
      taskPath: context.task.path,
      requestedBy: approvedBy,
    });
    eventHub.broadcast("TASK_QUEUED_AFTER_CONFIRMATION", {
      projectId: params.projectId,
      taskId,
      jobId: queued.job.jobId,
      approvedBy,
    });
    sendJson(res, queued.created ? 201 : 200, {
      success: true,
      data: {
        schemaVersion: 1,
        action: queued.created ? "TASK_CONFIRMED_AND_QUEUED" : "TASK_ALREADY_QUEUED",
        approvedBy,
        readiness: {
          verdict: readiness.verdict,
          ready: readiness.ready,
          summary: readiness.summary,
          checks: readiness.checks ?? [],
          nextActions: readiness.nextActions ?? [],
        },
        job: queued.job,
        nextAction: "Task sudah diantrekan dan akan dijalankan di isolated workspace.",
      },
    });
  });

  router.get("/api/tasks/:projectId/:taskInput/context", async (req, res, { params }) => {
    const { projectId, taskInput } = params;
    const context = buildContext(vaultRoot, projectId, taskInput);
    sendJson(res, 200, { success: true, data: context });
  });

  router.get("/api/tasks/:projectId/:taskInput/plan", async (req, res, { params }) => {
    const { projectId, taskInput } = params;
    const context = buildContext(vaultRoot, projectId, taskInput);
    const plan = buildPlan(context);
    sendJson(res, 200, { success: true, data: plan });
  });

  // --- 4. Runs & Review Lifecycle ---
  router.get("/api/runs", async (req, res) => {
    const runs = listRuns(runsRoot);
    sendJson(res, 200, { success: true, data: runs });
  });

  router.get("/api/runs/:id", async (req, res, { params }) => {
    try {
      const run = getRun(runsRoot, params.id);
      sendJson(res, 200, { success: true, data: run });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.get("/api/runs/:id/evidence", async (req, res, { params }) => {
    try {
      const run = getRun(runsRoot, params.id);
      sendJson(res, 200, { success: true, data: buildRunEvidence(run, { runsRoot }) });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.get("/api/runs/:id/visual-evidence", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      sendJson(res, 200, { success: true, data: listVisualEvidence({ runsRoot, runId: params.id }) });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.get("/api/runs/:id/visual-evidence/captures", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      sendJson(res, 200, { success: true, data: listCaptureReports({ runsRoot, runId: params.id }) });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.get("/api/runs/:id/visual-revisions", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      sendJson(res, 200, { success: true, data: listVisualRevisions({ runsRoot, runId: params.id }) });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.get("/api/runs/:id/visual-revisions/:iteration", async (req, res, { params }) => {
    try {
      const revision = getVisualRevision({ runsRoot, runId: params.id, iteration: Number(params.iteration) });
      sendJson(res, 200, { success: true, data: revision });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.post("/api/runs/:id/visual-revisions/:iteration/complete", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      const body = await parseJsonBody(req);
      const completed = completeVisualRevision({ runsRoot, runId: params.id, iteration: Number(params.iteration), afterEvidenceIds: body?.afterEvidenceIds ?? [] });
      eventHub.broadcast("VISUAL_REVISION_COMPLETED", { runId: params.id, iteration: completed.iteration, status: completed.status, afterEvidenceIds: completed.afterEvidenceIds });
      sendJson(res, 200, { success: true, data: completed });
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message, err.details);
    }
  });

  router.get("/api/runs/:id/visual-certification", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      sendJson(res, 200, { success: true, data: getVisualQACertification({ runsRoot, runId: params.id }) });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.post("/api/runs/:id/visual-certification", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      const body = await parseJsonBody(req);
      const result = createVisualQACertification({
        runsRoot,
        runId: params.id,
        baselineCaptureId: body?.baselineCaptureId,
        postChangeCaptureId: body?.postChangeCaptureId,
        revisionIteration: Number(body?.revisionIteration),
        restartReconstruction: body?.restartReconstruction ?? {},
        humanGate: body?.humanGate ?? {},
      });
      eventHub.broadcast("VISUAL_QA_CERTIFIED", { runId: params.id, certificationId: result.certificationId, status: result.status, blockers: result.blockers });
      sendJson(res, 201, { success: result.status === "CERTIFIED", data: result });
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message, err.details);
    }
  });

  router.get("/api/runs/:id/visual-evidence/:evidenceId", async (req, res, { params }) => {
    try {
      const evidence = getVisualEvidence({ runsRoot, runId: params.id, evidenceId: params.evidenceId });
      sendJson(res, 200, { success: true, data: evidence });
    } catch (err) {
      sendError(res, 404, err.message);
    }
  });

  router.post("/api/runs/:id/visual-evidence", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      const body = await parseJsonBody(req);
      const evidence = createVisualEvidence({ ...body, runId: params.id });
      const persisted = persistVisualEvidence({ runsRoot, evidence });
      eventHub.broadcast("VISUAL_EVIDENCE_RECORDED", { runId: params.id, evidenceId: evidence.evidenceId, comparison: evidence.comparison.status });
      sendJson(res, 201, { success: true, data: persisted });
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message, err.details);
    }
  });

  router.post("/api/runs/:id/visual-evidence/capture", async (req, res, { params }) => {
    try {
      getRun(runsRoot, params.id);
      const body = await parseJsonBody(req);
      const capture = services?.captureVisualEvidence ?? captureVisualEvidence;
      const devServer = globalDevServerManager.getDevServerStatus(params.id);
      const captureInput = {
        ...body,
        runsRoot,
        runId: params.id,
        baseUrl: body?.baseUrl ?? devServer.url,
        route: body?.route ?? "/",
      };
      if (!captureInput.baseUrl) throw new Error("Dev server untuk run ini belum aktif.");
      const report = await capture(captureInput);
      eventHub.broadcast("VISUAL_CAPTURE_COMPLETED", { runId: params.id, captureId: report.captureId, status: report.status });
      sendJson(res, 201, { success: true, data: report });
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message, err.details);
    }
  });

  router.post("/api/runs/:id/visual-evidence/:evidenceId/compare", async (req, res, { params }) => {
    try {
      const evidence = getVisualEvidence({ runsRoot, runId: params.id, evidenceId: params.evidenceId });
      const body = await parseJsonBody(req);
      const compared = comparePersistedVisualEvidence({ runsRoot, evidence, reference: body?.reference ?? evidence.reference, pixelThreshold: body?.pixelThreshold ?? 16, maxMismatchRatio: body?.maxMismatchRatio ?? 0.01 });
      eventHub.broadcast("VISUAL_COMPARISON_COMPLETED", { runId: params.id, evidenceId: params.evidenceId, status: compared.comparison.status });
      sendJson(res, 200, { success: true, data: compared });
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message, err.details);
    }
  });

  router.post("/api/runs/:id/visual-evidence/:evidenceId/accessibility", async (req, res, { params }) => {
    try {
      const evidence = getVisualEvidence({ runsRoot, runId: params.id, evidenceId: params.evidenceId });
      const body = await parseJsonBody(req);
      const audit = services?.auditVisualEvidence ?? auditVisualEvidence;
      const updated = await audit({ runsRoot, evidence, baseUrl: body?.baseUrl, route: body?.route ?? evidence.route, viewport: body?.viewport ?? evidence.viewport, timeoutMs: body?.timeoutMs ?? 30_000 });
      eventHub.broadcast("VISUAL_ACCESSIBILITY_COMPLETED", { runId: params.id, evidenceId: params.evidenceId, status: updated.accessibility.status });
      sendJson(res, 200, { success: true, data: updated });
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message, err.details);
    }
  });

  router.get("/api/jobs", async (req, res) => {
    const jobs = listJobs(runsRoot);
    sendJson(res, 200, { success: true, data: jobs });
  });

  router.post("/api/runs/:id/preview", async (req, res, { params }) => {
    const result = await previewReviewWorkspace({ runsRoot, runId: params.id });
    eventHub.broadcast("PREVIEW_OPENED", { runId: params.id, ...result });
    sendJson(res, 200, { success: true, data: result });
  });

  router.post("/api/runs/:id/start", async (req, res, { params }) => {
    const readiness = operationsReadiness({ runsRoot });
    if (process.env.ORCHESTRATOR_ENFORCE_OPERATIONS_GUARD === "1" && !readiness.admission.allowed) {
      return sendError(res, 503, "Eksekusi diblokir oleh Operations Center.", readiness);
    }
    const body = await parseJsonBody(req);
    const { approvedBy = "user" } = body;

    let run = null;
    try {
      run = getRun(runsRoot, params.id);
    } catch (err) {
      return sendError(res, 404, err.message);
    }

    eventHub.broadcast("RUN_STARTED", { runId: run.runId, state: RUN_STATES.RUNNING });
    sendJson(res, 202, {
      success: true,
      data: {
        runId: run.runId,
        status: "running",
        state: RUN_STATES.RUNNING,
      },
    });

    (async () => {
      try {
        const manifest = await startTaskRun({
          vaultRoot,
          runsRoot,
          projectId: run.project?.id,
          taskInput: run.task?.id || run.task?.path,
          approvedBy,
          services,
          onProgress: (m) => eventHub.broadcast("RUN_PROGRESS", { runId: m.runId, state: m.state }),
        });
        eventHub.broadcast("RUN_PROGRESS", { runId: manifest.runId, state: manifest.state });
      } catch (err) {
        eventHub.broadcast("RUN_FAILED", { runId: run.runId, error: err.message });
      }
    })();
  });

  router.post("/api/runs/:id/request-changes", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { requestedBy = "user", reason, feedback, inlineComments, visualAnnotations } = body || {};
    const rawReason = (reason && typeof reason === "string" && reason.trim())
      ? reason
      : (feedback && typeof feedback === "string" && feedback.trim())
        ? feedback
        : null;
    if (!rawReason) {
      return sendError(res, 400, "Missing required field: reason");
    }

    if (inlineComments !== undefined && inlineComments !== null && !Array.isArray(inlineComments)) {
      return sendError(res, 400, "Invalid field: inlineComments must be an array");
    }
    if (visualAnnotations !== undefined && visualAnnotations !== null && !Array.isArray(visualAnnotations)) {
      return sendError(res, 400, "Invalid field: visualAnnotations must be an array");
    }

    let run = null;
    try {
      run = getRun(runsRoot, params.id);
      if (![RUN_STATES.REVIEW, RUN_STATES.RETROSPECTIVE].includes(run.state)) {
        return sendError(res, 400, `Request changes requires run in REVIEW or RETROSPECTIVE; current state: ${run.state}`);
      }
    } catch (err) {
      return sendError(res, 404, err.message);
    }

    const effectiveReason = formatReviewRevisionFeedback({
      reason: rawReason.trim(),
      inlineComments: Array.isArray(inlineComments) ? inlineComments : [],
    });
    const visualFeedback = {
      iteration: (run.execution?.reviewChanges?.length ?? 0) + 1,
      inlineComments: Array.isArray(inlineComments) ? inlineComments : [],
      visualAnnotations: Array.isArray(visualAnnotations) ? visualAnnotations : [],
      beforeEvidenceIds: listVisualEvidence({ runsRoot, runId: params.id }).map((evidence) => evidence.evidenceId),
    };

    eventHub.broadcast("RUN_CHANGES_REQUESTED", { runId: params.id, state: RUN_STATES.CHANGES_REQUESTED });
    sendJson(res, 202, {
      success: true,
      data: {
        runId: params.id,
        status: "running",
        state: RUN_STATES.CHANGES_REQUESTED,
      },
    });

    (async () => {
      try {
        const manifest = await requestChangesTaskRun({
          vaultRoot,
          runsRoot,
          runId: params.id,
          requestedBy,
          reason: effectiveReason,
          visualFeedback,
          onProgress: (m) => eventHub.broadcast("RUN_PROGRESS", { runId: m.runId, state: m.state }),
        });

        updateJobForRun(runsRoot, manifest.runId, {
          state: manifest.state === "REVIEW" ? JOB_STATES.REVIEW : JOB_STATES.RUNNING,
          runState: manifest.state,
        });

        eventHub.broadcast("RUN_PROGRESS", { runId: manifest.runId, state: manifest.state });
      } catch (err) {
        eventHub.broadcast("RUN_FAILED", { runId: params.id, error: err.message });
      }
    })();
  });

  router.post("/api/runs/:id/accept", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const {
      approvedBy = "user",
      decision = null,
      destination = null,
      targetPath = null,
      autoCommit = true,
      commitMessage = null,
    } = body || {};

    const manifest = await acceptRun({
      vaultRoot,
      runsRoot,
      runId: params.id,
      approvedBy,
      decision,
      destination,
      targetPath,
      autoCommit: Boolean(autoCommit),
      commitMessage,
    });

    updateJobForRun(runsRoot, manifest.runId, {
      state: JOB_STATES.DONE,
      runState: manifest.state,
      finishedAt: new Date().toISOString(),
    });

    eventHub.broadcast("RUN_ACCEPTED", { runId: manifest.runId, state: manifest.state });
    sendJson(res, 200, { success: true, data: manifest });
  });

  router.post("/api/runs/:id/reject", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { rejectedBy = "user", reason = "Rejected via API" } = body;

    const manifest = await rejectTaskRun({
      vaultRoot,
      runsRoot,
      runId: params.id,
      rejectedBy,
      reason,
    });

    updateJobForRun(runsRoot, manifest.runId, {
      state: JOB_STATES.FAILED,
      runState: manifest.state,
      error: reason,
      finishedAt: new Date().toISOString(),
    });

    eventHub.broadcast("RUN_REJECTED", { runId: manifest.runId, state: manifest.state });
    sendJson(res, 200, { success: true, data: manifest });
  });

  router.post("/api/runs/:id/recover", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { recoveredBy = "user", force = false } = body;

    let run = null;
    try {
      run = getRun(runsRoot, params.id);
      if (run.state !== RUN_STATES.FAILED && !force) {
        return sendError(res, 400, `Recover requires run in FAILED; current state: ${run.state}`);
      }
    } catch (err) {
      return sendError(res, 404, err.message);
    }

    eventHub.broadcast("RUN_PROGRESS", { runId: params.id, state: RUN_STATES.VERIFYING });
    sendJson(res, 202, {
      success: true,
      data: {
        runId: params.id,
        status: "running",
        state: RUN_STATES.VERIFYING,
      },
    });

    (async () => {
      try {
        const manifest = await recoverTaskRun({
          vaultRoot,
          runsRoot,
          runId: params.id,
          recoveredBy,
          force,
          onProgress: (m) => eventHub.broadcast("RUN_PROGRESS", { runId: m.runId, state: m.state }),
        });

        eventHub.broadcast("RUN_RECOVERED", { runId: manifest.runId, state: manifest.state });
      } catch (err) {
        eventHub.broadcast("RUN_FAILED", { runId: params.id, error: err.message });
      }
    })();
  });

  router.post("/api/runs/:id/retry", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { requestedBy = "user", force = false } = body;

    const result = await retryTaskRun({
      vaultRoot,
      runsRoot,
      runId: params.id,
      requestedBy,
      force,
    });

    eventHub.broadcast("RUN_RETRIED", { runId: params.id, newJobId: result.job?.jobId });
    sendJson(res, 200, { success: true, data: result });
  });

  router.get("/api/runs/:id/diff", async (req, res, { params }) => {
    try {
      const diffData = await getRunDiff({ runsRoot, runId: params.id });
      sendJson(res, 200, { success: true, data: diffData });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  router.get("/api/runs/:id/logs", async (req, res, { params }) => {
    try {
      const logFile = path.join(runsRoot, "events", `${params.id}.jsonl`);
      if (!fs.existsSync(logFile)) {
        return sendJson(res, 200, { success: true, data: { lines: [], exists: false } });
      }

      const content = fs.readFileSync(logFile, "utf8");
      const lines = content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        });

      sendJson(res, 200, { success: true, data: { lines, exists: true } });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  router.post("/api/runs/:id/dev-server/start", async (req, res, { params }) => {
    try {
      const serverInfo = await globalDevServerManager.startDevServer({ runsRoot, runId: params.id });
      eventHub.broadcast("DEV_SERVER_STARTED", { runId: params.id, ...serverInfo });
      sendJson(res, 200, { success: true, data: serverInfo });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  router.post("/api/runs/:id/dev-server/stop", async (req, res, { params }) => {
    try {
      const result = globalDevServerManager.stopDevServer(params.id);
      eventHub.broadcast("DEV_SERVER_STOPPED", { runId: params.id, ...result });
      sendJson(res, 200, { success: true, data: result });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  router.get("/api/runs/:id/dev-server/status", async (req, res, { params }) => {
    try {
      const status = globalDevServerManager.getDevServerStatus(params.id);
      sendJson(res, 200, { success: true, data: status });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  // --- 5. Knowledge ---
  router.get("/api/knowledge/candidates", async (req, res) => {
    const candidates = listKnowledgeCandidates({ vaultRoot });
    sendJson(res, 200, { success: true, data: candidates });
  });

  router.post("/api/knowledge/promote", async (req, res) => {
    const body = await parseJsonBody(req);
    const selector = body?.selector || body?.candidateId || body?.id || body?.candidatePath || body?.path || body?.targetPath;
    const { approvedBy = "user", targetPath = null } = body || {};
    if (!selector) {
      return sendError(res, 400, "Missing required field: selector");
    }

    const result = promoteKnowledgeCandidate({
      vaultRoot,
      selector,
      approvedBy,
      targetPath,
    });

    eventHub.broadcast("KNOWLEDGE_PROMOTED", { selector, target: result.promotedTarget });
    sendJson(res, 200, { success: true, data: result });
  });

  router.post("/api/knowledge/reject", async (req, res) => {
    const body = await parseJsonBody(req);
    const { selector, rejectedBy = "user", reason = "Rejected via API" } = body;
    if (!selector) {
      return sendError(res, 400, "Missing required field: selector");
    }

    const result = rejectKnowledgeCandidate({
      vaultRoot,
      selector,
      rejectedBy,
      reason,
    });

    eventHub.broadcast("KNOWLEDGE_REJECTED", { selector });
    sendJson(res, 200, { success: true, data: result });
  });

  function formatHealthResponse(report) {
    const findings = report.findings || [];
    const errors = findings
      .filter((f) => f.severity === "ERROR")
      .map((f) => ({ code: f.check || "ERROR", message: f.message, file: f.path }));
    const warnings = findings
      .filter((f) => f.severity === "WARNING")
      .map((f) => ({ code: f.check || "WARNING", message: f.message, file: f.path }));

    const brokenLinksCount = findings.filter((f) => f.check === "BROKEN_WIKILINK").length;
    const unindexedCount = findings.filter((f) => f.check === "UNINDEXED_KNOWLEDGE" || f.check === "UNINDEXED_CANDIDATE").length;
    const orphanCandidatesCount = findings.filter((f) => f.check === "ORPHAN_CANDIDATE").length;

    return {
      ...report,
      healthy: (report.summary?.errors || 0) === 0,
      errors,
      warnings,
      brokenLinksCount,
      unindexedCount,
      orphanCandidatesCount,
      timestamp: report.generatedAt,
    };
  }

  router.get("/api/knowledge/health", async (req, res) => {
    const rawReport = knowledgeHealth({ vaultRoot, fixSafe: false });
    const health = formatHealthResponse(rawReport);
    sendJson(res, 200, { success: true, data: health });
  });

  router.post("/api/knowledge/health/fix-safe", async (req, res) => {
    const body = await parseJsonBody(req);
    const { fixedBy = "user" } = body || {};
    const rawReport = knowledgeHealth({ vaultRoot, fixSafe: true, fixedBy });
    const health = formatHealthResponse(rawReport);
    eventHub.broadcast("KNOWLEDGE_HEALTH_UPDATED", health);
    sendJson(res, 200, { success: true, data: health });
  });

  router.get("/api/knowledge/maintenance", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const dueSoonDays = Number(parsedUrl.searchParams.get("dueSoonDays") ?? 30);
      const report = listKnowledgeMaintenance({ vaultRoot, dueSoonDays: Number.isFinite(dueSoonDays) ? dueSoonDays : 30 });
      sendJson(res, 200, { success: true, data: report });
    } catch (error) { sendError(res, error.statusCode || 400, error.message); }
  });

  router.get("/api/knowledge/duplicates", async (req, res) => {
    try {
      const report = listKnowledgeMaintenance({ vaultRoot });
      sendJson(res, 200, { success: true, data: { schemaVersion: report.schemaVersion, action: "KNOWLEDGE_DUPLICATES", generatedAt: report.generatedAt, duplicates: report.duplicates, summary: report.summary } });
    } catch (error) { sendError(res, error.statusCode || 400, error.message); }
  });

  router.get("/api/knowledge/stale", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const dueSoonDays = Number(parsedUrl.searchParams.get("dueSoonDays") ?? 30);
      const report = listKnowledgeMaintenance({ vaultRoot, dueSoonDays: Number.isFinite(dueSoonDays) ? dueSoonDays : 30 });
      sendJson(res, 200, { success: true, data: { schemaVersion: report.schemaVersion, action: "KNOWLEDGE_STALE_QUEUE", generatedAt: report.generatedAt, stale: report.stale, summary: report.summary } });
    } catch (error) { sendError(res, error.statusCode || 400, error.message); }
  });

  router.post("/api/knowledge/provenance/migration/preview", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const preview = previewKnowledgeProvenanceMigration({ vaultRoot, reviewDays: body?.reviewDays, now: body?.now ? new Date(body.now) : new Date() });
      eventHub.broadcast("KNOWLEDGE_PROVENANCE_MIGRATION_PREVIEWED", { planId: preview.planId, summary: preview.summary });
      sendJson(res, 201, { success: true, data: preview });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.post("/api/knowledge/provenance/migration/apply", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = applyKnowledgeProvenanceMigration({
        vaultRoot,
        selector: body?.planId ?? body?.selector,
        approvedBy: req.operatorIdentity ?? body?.approvedBy,
        confirmed: body?.confirmed === true || body?.confirm === true,
      });
      eventHub.broadcast("KNOWLEDGE_PROVENANCE_MIGRATION_APPLIED", { planId: result.planId, summary: result.summary });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.post("/api/knowledge/provenance/migration/rollback", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = rollbackKnowledgeProvenanceMigration({
        vaultRoot,
        selector: body?.planId ?? body?.selector,
        revertedBy: req.operatorIdentity ?? body?.revertedBy ?? body?.approvedBy,
        confirmed: body?.confirmed === true || body?.confirm === true,
      });
      eventHub.broadcast("KNOWLEDGE_PROVENANCE_MIGRATION_ROLLED_BACK", { planId: result.planId });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message, error.details); }
  });

  router.get("/api/knowledge/merge/preview", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const preview = previewKnowledgeMerge({ vaultRoot, sourcePath: parsedUrl.searchParams.get("source"), targetPath: parsedUrl.searchParams.get("target") });
      sendJson(res, 200, { success: true, data: preview });
    } catch (error) { sendError(res, error.statusCode || 400, error.message); }
  });

  router.post("/api/knowledge/merge/apply", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = applyKnowledgeMerge({
        vaultRoot,
        sourcePath: body?.sourcePath,
        targetPath: body?.targetPath,
        approvedBy: body?.approvedBy,
        expectedSourceChecksum: body?.expectedSourceChecksum,
        expectedTargetChecksum: body?.expectedTargetChecksum,
        confirmed: body?.confirmed === true || body?.confirm === true,
      });
      eventHub.broadcast("KNOWLEDGE_MERGED", { planId: result.planId, source: result.source.path, target: result.target.path });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message); }
  });

  router.post("/api/knowledge/merge/revert", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const result = revertKnowledgeMerge({ vaultRoot, selector: body?.planId ?? body?.selector, revertedBy: body?.revertedBy ?? body?.approvedBy, confirmed: body?.confirmed === true || body?.confirm === true });
      eventHub.broadcast("KNOWLEDGE_MERGE_REVERTED", { planId: result.planId });
      sendJson(res, 200, { success: true, data: result });
    } catch (error) { sendError(res, error.statusCode || 400, error.message); }
  });

  router.post("/api/knowledge/ingest", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const { content, rawContent, title = null, domain, type, destination = "WIKI" } = body || {};
      const rawText = content || rawContent;
      if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
        return sendError(res, 400, "Missing required field: content");
      }
      if (!domain || typeof domain !== "string" || !domain.trim()) {
        return sendError(res, 400, "Missing required field: domain");
      }
      if (!type || typeof type !== "string" || !type.trim()) {
        return sendError(res, 400, "Missing required field: type");
      }

      const ingestKnowledge = services?.ingestRawKnowledge ?? ingestRawKnowledge;
      const result = await ingestKnowledge({
        vaultRoot,
        runsRoot,
        rawContent: rawText.trim(),
        title: title && typeof title === "string" ? title.trim() : null,
        domain: domain.trim(),
        type: type.trim(),
        destination: destination ? String(destination).trim() : "WIKI",
        processRunner: services?.processRunner,
      });

      eventHub.broadcast("KNOWLEDGE_INGESTED", {
        ingestId: result.ingestId,
        destination: result.destination,
        target: result.target,
      });

      sendJson(res, 201, { success: true, data: result });
    } catch (err) {
      sendError(res, err.statusCode || (err.message?.includes("tidak valid") ? 400 : 500), err.message);
    }
  });

  router.post("/api/knowledge/harvest", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const { repositoryPath, domain = "backend", mode = "normal", async: isAsync = false } = body || {};
      if (!repositoryPath || typeof repositoryPath !== "string" || !repositoryPath.trim()) {
        return sendError(res, 400, "Missing required field: repositoryPath");
      }

      const cleanRepoPath = path.resolve(repositoryPath.trim());
      const cleanDomain = String(domain || "backend").toLowerCase().trim();
      const cleanMode = mode ? String(mode).trim() : "normal";
      const harvestKnowledge = services?.harvestRepositoryKnowledge ?? harvestRepositoryKnowledge;

      // If user explicitly asks for async background processing:
      if (isAsync) {
        const harvestId = `harvest-${Date.now()}-${randomUUID().slice(0, 8)}`;
        eventHub.broadcast("KNOWLEDGE_HARVEST_STARTED", {
          harvestId,
          repositoryPath: cleanRepoPath,
          domain: cleanDomain,
          mode: cleanMode,
          startedAt: new Date().toISOString(),
        });

        // Background execution
        (async () => {
          try {
            const result = await harvestKnowledge({
              vaultRoot,
              runsRoot,
              repositoryPath: cleanRepoPath,
              domain: cleanDomain,
              mode: cleanMode,
              requestedBy: "user",
              processRunner: services?.processRunner,
              onProgress: (prog) => {
                eventHub.broadcast("KNOWLEDGE_HARVEST_PROGRESS", {
                  harvestId,
                  repositoryPath: cleanRepoPath,
                  domain: cleanDomain,
                  mode: cleanMode,
                  ...prog,
                });
              },
            });

            eventHub.broadcast("KNOWLEDGE_HARVESTED", {
              harvestId: result.harvestId || harvestId,
              repositoryPath: result.repositoryPath,
              domain: result.domain,
              mode: result.mode || cleanMode,
              count: result.count,
              harvested: result.harvested,
            });
          } catch (bgErr) {
            console.error("Background harvest error:", bgErr);
            eventHub.broadcast("KNOWLEDGE_HARVEST_FAILED", {
              harvestId,
              repositoryPath: cleanRepoPath,
              domain: cleanDomain,
              mode: cleanMode,
              error: bgErr.message || "Pemindaian arsitektur gagal.",
            });
          }
        })();

        return sendJson(res, 202, {
          success: true,
          status: "ACCEPTED",
          message: "Pemindaian arsitektur telah dimulai di background.",
          data: {
            harvestId,
            repositoryPath: cleanRepoPath,
            domain: cleanDomain,
            mode: cleanMode,
          },
        });
      }

      // Synchronous execution (default for tests / sync clients)
      const result = await harvestKnowledge({
        vaultRoot,
        runsRoot,
        repositoryPath: cleanRepoPath,
        domain: cleanDomain,
        mode: cleanMode,
        requestedBy: "user",
        processRunner: services?.processRunner,
      });

      eventHub.broadcast("KNOWLEDGE_HARVESTED", {
        harvestId: result.harvestId,
        repositoryPath: result.repositoryPath,
        domain: result.domain,
        mode: result.mode || cleanMode,
        count: result.count,
        harvested: result.harvested,
      });

      sendJson(res, 201, { success: true, data: result });
    } catch (err) {
      sendError(res, err.statusCode || (err.message?.includes("tidak valid") || err.message?.includes("tidak ditemukan") ? 400 : 500), err.message);
    }
  });

  router.get("/api/knowledge/harvests", async (req, res) => {
    try {
      const getHarvests = services?.listHarvestRuns ?? listHarvestRuns;
      const data = getHarvests({ vaultRoot });
      sendJson(res, 200, { success: true, data });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  // --- 5B. Asset Upload & Serving ---
  router.post("/api/assets/upload", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const { fileName, base64Data, type = "MOCKUP", projectId, targetSubDir } = body || {};

      let projectRepo = null;
      if (type === "PROJECT_ASSET") {
        const registry = loadRegistry(vaultRoot);
        const project = registry.projects.find((p) => p.id === projectId);
        if (!project) return sendError(res, 404, `Project not found: ${projectId}`);
        projectRepo = project.repository;
      }

      const result = await saveUploadedAsset({
        vaultRoot,
        projectRepository: projectRepo,
        type,
        fileName,
        base64Data,
        targetSubDir,
      });

      sendJson(res, 201, { success: true, data: result });
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  router.post("/api/assets/delete", async (req, res) => {
    try {
      const body = await parseJsonBody(req);
      const { type = "MOCKUP", relativeVaultPath, relativeProjectPath, projectId } = body || {};

      let projectRepo = null;
      if (type === "PROJECT_ASSET") {
        const registry = loadRegistry(vaultRoot);
        const project = registry.projects.find((p) => p.id === projectId);
        if (project) projectRepo = project.repository;
      }

      const result = await deleteUploadedAsset({
        vaultRoot,
        projectRepository: projectRepo,
        type,
        relativeVaultPath,
        relativeProjectPath,
      });

      sendJson(res, 200, { success: true, data: result });
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  router.get("/api/assets/raw", async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const relativePath = parsedUrl.searchParams.get("path");
      if (!relativePath) return sendError(res, 400, "Missing required query param: path");

      const fullPath = resolveMockupAssetPath(vaultRoot, relativePath, { mustExist: true });

      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return sendError(res, 404, "Asset file not found");
      }

      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
      };
      const contentType = mimeTypes[ext];
      if (!contentType) return sendError(res, 415, "Asset format is not allowed");

      const fileBuffer = fs.readFileSync(fullPath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": fileBuffer.length,
        "Cache-Control": "public, max-age=86400",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(fileBuffer);
    } catch (err) {
      sendError(res, err.statusCode || 400, err.message);
    }
  });

  // --- 6. Notifications & Telemetry ---
  router.get("/api/notifications", async (req, res) => {
    const notifications = listNotifications({ runsRoot });
    sendJson(res, 200, { success: true, data: notifications });
  });

  router.post("/api/notifications/read", async (req, res) => {
    const body = await parseJsonBody(req);
    const { selector = null, readBy = "user" } = body;
    const result = acknowledgeNotifications({ runsRoot, selector, readBy });
    sendJson(res, 200, { success: true, data: result });
  });

  router.post("/api/notifications/test", async (req, res) => {
    const result = await emitTestNotification({ runsRoot });
    sendJson(res, 200, { success: true, data: result });
  });

  router.get("/api/telemetry", async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const selector = parsedUrl.searchParams.get("selector");
    const projectId = parsedUrl.searchParams.get("projectId");
    const report = telemetryReport({ runsRoot, selector, projectId });
    sendJson(res, 200, { success: true, data: report });
  });

  router.get("/api/telemetry/rtk", async (req, res) => {
    try {
      const rtkStats = await collectRtkAnalytics();
      sendJson(res, 200, { success: true, data: rtkStats });
    } catch (err) {
      sendError(res, 500, err.message);
    }
  });

  return router;
}

export function createOrchestratorServer({
  vaultRoot = DEFAULT_VAULT,
  runsRoot,
  port = Number(process.env.ORCHESTRATOR_API_PORT || 3721),
  host = "127.0.0.1",
  eventHub = null,
  apiToken = null,
  rateLimiter = null,
  sourceRoot = process.cwd(),
  releaseCandidateRoot = process.env.ORCHESTRATOR_RELEASE_CANDIDATE_ROOT ?? null,
  env = process.env,
  services: customServices = {},
} = {}) {
  const recoveryAtStart = readRecoveryMode(runsRoot);
  const token = apiToken || (recoveryAtStart ? readExistingApiToken(runsRoot) : ensureApiToken(runsRoot));
  if (!token) {
    throw new Error("Recovery quarantine tidak memiliki API token valid; inspection server ditolak tanpa memodifikasi backup.");
  }
  const hub = eventHub || createEventHub();
  const idempotency = new IdempotencyStore(runsRoot);
  const operatorSessions = new OperatorSessionStore();
  const requestRateLimiter = rateLimiter || new RequestRateLimiter();

  const services = {
    readMarkdown,
    validateTaskReadiness,
    buildContext,
    buildPlan,
    onboardExistingProject,
    onboardNewProject,
    ingestRawKnowledge,
    harvestRepositoryKnowledge,
    objectivesEnabled,
    crossProjectEnabled,
    createObjectiveIntake,
    getObjectiveIntake,
    listObjectiveIntake,
    getObjectiveLifecycle,
    createPlanRevision,
    clarifyPlan,
    approvePlan,
    requestPlanChanges,
    requestScopeExpansion,
    materializeApprovedPlan,
    requestNodeRetry,
    resolveDecision,
    cancelOrchestration,
    listDecisions,
    listDecisionInbox,
    startIntegration,
    getIntegrationEvidence,
    recoverIntegration,
    cancelObjective,
    approveFreshProjectGenesis,
    ...customServices,
  };

  const router = createRouter({ vaultRoot, runsRoot, eventHub: hub, services, sourceRoot, releaseCandidateRoot, env });

  const requestListener = async (req, res) => {
    // 1. Origin validation applies to preflight and regular requests.
    const originCheck = validateOrigin(req);
    if (!originCheck.valid) {
      sendError(res, 403, originCheck.reason);
      return;
    }

    // 2. Local dashboard preflight. Normal dashboard traffic uses the same-origin proxy.
    if (req.method === "OPTIONS") {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
      res.writeHead(204, {
        ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-token, Idempotency-Key, X-Operator-Session, X-Action-Nonce",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${host}:${port}`);
    const pathname = parsedUrl.pathname;

    // 3. Skip Auth for Health Probe
    if (pathname === "/api/health" && req.method === "GET") {
      const match = router.match("GET", pathname);
      return match.handler(req, res, { params: match.params });
    }

    // 4. Authenticate Request
    const authResult = authenticateRequest(req, token);
    if (!authResult.authenticated) {
      sendError(res, 401, authResult.reason || "Unauthorized");
      return;
    }

    const limiterResult = requestRateLimiter.check({
      key: `${req.socket.remoteAddress || "unknown"}:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`,
      mutation: IDEMPOTENT_METHODS.has(req.method),
    });
    if (!limiterResult.allowed) {
      sendError(res, 429, "Batas request operasi tercapai. Coba lagi nanti.", { limit: limiterResult.limit }, { "Retry-After": String(limiterResult.retryAfterSeconds) });
      return;
    }

    if (pathname === "/api/auth/session" && req.method === "GET") {
      const session = operatorSessions.issue(req.headers["x-operator-session"]);
      sendJson(res, 200, { success: true, data: session });
      return;
    }

    if (pathname === "/api/audit/verify" && req.method === "GET") {
      const audit = verifyAuditChain(runsRoot);
      sendJson(res, audit.valid ? 200 : 409, { success: audit.valid, data: audit });
      return;
    }

    // Restored datasets remain inspectable through authenticated GET routes,
    // while every mutation stays fail-closed until explicit promotion removes
    // the recovery marker through an offline runbook.
    const recoveryMode = readRecoveryMode(runsRoot);
    if (recoveryMode && IDEMPOTENT_METHODS.has(req.method)) {
      sendError(res, 423, "Runtime berada dalam RECOVERY_QUARANTINE; mutasi diblokir.", { recoveryMode });
      return;
    }

    if (IDEMPOTENT_METHODS.has(req.method)) {
      const authorization = operatorSessions.authorize(req.headers["x-operator-session"], req.headers["x-action-nonce"]);
      if (!authorization.authorized) {
        sendError(res, 403, authorization.reason);
        return;
      }
      req.operatorIdentity = authorization.actor;
      req.operatorSessionId = authorization.sessionId;
      res.setHeader("X-Action-Nonce", authorization.nextNonce);
      try {
        await parseJsonBody(req);
        appendAuditEntry(runsRoot, {
          event: "OPERATOR_MUTATION_AUTHORIZED",
          actor: authorization.actor,
          sessionId: authorization.sessionId,
          nonceHash: authorization.usedNonceHash,
          method: req.method,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          requestHash: createHash("sha256").update(req.orchestratorRawJsonBody ?? "").digest("hex"),
        });
      } catch (error) {
        sendError(res, error.statusCode || 400, error.message);
        return;
      }
    }

    // 5. Match Route
    const match = router.match(req.method, pathname);
    if (!match) {
      sendError(res, 404, `Route not found: ${req.method} ${pathname}`);
      return;
    }
    try {
      validateRouteIdentifiers(match.params);
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message);
      return;
    }

    // 6. Idempotency check is scoped by method, target, user key, and request payload.
    const idempotencyKey = req.headers["idempotency-key"];
    let scopedIdempotencyKey = null;
    if (IDEMPOTENT_METHODS.has(req.method) && idempotencyKey && typeof idempotencyKey === "string") {
      try {
        await parseJsonBody(req);
        scopedIdempotencyKey = idempotencyScopeKey({
          key: idempotencyKey,
          method: req.method,
          requestTarget: `${parsedUrl.pathname}${parsedUrl.search}`,
          rawBody: req.orchestratorRawJsonBody ?? "",
        });
        const cached = idempotency.get(scopedIdempotencyKey);
        if (cached) {
          sendJson(res, cached.statusCode, cached.body, { "X-Cache": "IDEMPOTENT_HIT" });
          return;
        }
      } catch (error) {
        sendError(res, error.statusCode || 400, error.message);
        return;
      }
    }

    // 7. Execute Handler with Error Handling & Idempotency Storage
    try {
      if (scopedIdempotencyKey) {
        // Intercept response to store in idempotency cache
        let capturedStatus = 200;
        const proxyRes = {
          ...res,
          writeHead: (status, headers) => {
            capturedStatus = status;
            return res.writeHead(status, headers);
          },
          end: (payload) => {
            try {
              const responseCaptured = JSON.parse(payload);
              idempotency.set(scopedIdempotencyKey, { statusCode: capturedStatus, body: responseCaptured });
            } catch {}
            res.end(payload);
          },
        };
        await match.handler(req, proxyRes, { params: match.params });
      } else {
        await match.handler(req, res, { params: match.params });
      }
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message, err.details ?? null);
    }
  };

  const server = http.createServer(requestListener);

  const start = () => new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      resolve({ port, host, token });
    });
    server.on("error", reject);
  });

  const stop = () => new Promise((resolve) => {
    hub.close();
    server.close(() => resolve());
  });

  return {
    server,
    port,
    host,
    token,
    eventHub: hub,
    idempotencyStore: idempotency,
    rateLimiter: requestRateLimiter,
    operatorSessions,
    start,
    stop,
  };
}
