import http from "node:http";
import path from "node:path";
import { DEFAULT_VAULT, listProjects, buildContext, buildPlan, readMarkdown, loadRegistry } from "./core.mjs";
import { validateTaskReadiness } from "./task-readiness.mjs";
import { requestTask } from "./task-intake.mjs";
import { startTaskRun, recoverTaskRun, requestChangesTaskRun, rejectTaskRun, retryTaskRun } from "./task-workflow.mjs";
import { previewReviewWorkspace, formatReviewRevisionFeedback } from "./review-workflow.mjs";
import { listRuns, getRun, RUN_STATES } from "./run-manager.mjs";
import { listJobs, getJob, updateJobForRun, reconcileJobs, JOB_STATES } from "./job-queue.mjs";
import { listKnowledgeCandidates, promoteKnowledgeCandidate, rejectKnowledgeCandidate, acceptRun } from "./knowledge-workflow.mjs";
import { knowledgeHealth } from "./knowledge-quality.mjs";
import { listNotifications, acknowledgeNotifications, emitTestNotification } from "./notification-service.mjs";
import { telemetryReport } from "./telemetry.mjs";
import { daemonStatus } from "./daemon.mjs";
import { ensureApiToken, authenticateRequest, validateOrigin, IdempotencyStore } from "./api/auth.mjs";
import { createEventHub } from "./api/events.mjs";
import { Router, sendJson, sendError, parseJsonBody } from "./api/router.mjs";
import { getRunDiff, globalDevServerManager } from "./dev-server-manager.mjs";
import { collectRtkAnalytics } from "./rtk-analytics.mjs";
import { onboardExistingProject, onboardNewProject } from "./project-onboarding.mjs";
import { ingestRawKnowledge } from "./knowledge-ingest.mjs";
import { harvestRepositoryKnowledge, listHarvestRuns } from "./knowledge-harvester.mjs";

export function createRouter({ vaultRoot, runsRoot, eventHub, services }) {
  const router = new Router();

  // --- 1. System & Health ---
  router.get("/api/health", async (req, res) => {
    sendJson(res, 200, {
      success: true,
      data: {
        status: "healthy",
        service: "personal-ai-orchestrator-api",
        version: "0.1.0",
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

  // --- 2. Projects ---
  router.get("/api/projects", async (req, res) => {
    const data = listProjects(vaultRoot);
    sendJson(res, 200, { success: true, data });
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

  // --- 3. Tasks & Intake ---
  router.post("/api/tasks/request", async (req, res) => {
    const body = await parseJsonBody(req);
    const { project: projectId, request, requestedBy = "user", autoStart = true } = body;
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
    const { requestedBy = "user", reason, feedback, inlineComments } = body || {};
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
    const { approvedBy = "user", decision = null, destination = null, targetPath = null } = body;

    const manifest = await acceptRun({
      vaultRoot,
      runsRoot,
      runId: params.id,
      approvedBy,
      decision,
      destination,
      targetPath,
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

  router.get("/api/knowledge/health", async (req, res) => {
    const health = knowledgeHealth({ vaultRoot, fixSafe: false });
    sendJson(res, 200, { success: true, data: health });
  });

  router.post("/api/knowledge/health/fix-safe", async (req, res) => {
    const body = await parseJsonBody(req);
    const { fixedBy = "user" } = body || {};
    const health = knowledgeHealth({ vaultRoot, fixSafe: true, fixedBy });
    eventHub.broadcast("KNOWLEDGE_HEALTH_UPDATED", health);
    sendJson(res, 200, { success: true, data: health });
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
  services: customServices = {},
} = {}) {
  const token = apiToken || ensureApiToken(runsRoot);
  const hub = eventHub || createEventHub();
  const idempotency = new IdempotencyStore(runsRoot);

  const services = {
    readMarkdown,
    validateTaskReadiness,
    buildContext,
    buildPlan,
    onboardExistingProject,
    onboardNewProject,
    ingestRawKnowledge,
    harvestRepositoryKnowledge,
    ...customServices,
  };

  const router = createRouter({ vaultRoot, runsRoot, eventHub: hub, services });

  const requestListener = async (req, res) => {
    // 1. CORS Preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-token, Idempotency-Key",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // 2. Origin Validation
    const originCheck = validateOrigin(req);
    if (!originCheck.valid) {
      sendError(res, 403, originCheck.reason);
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

    // 5. Match Route
    const match = router.match(req.method, pathname);
    if (!match) {
      sendError(res, 404, `Route not found: ${req.method} ${pathname}`);
      return;
    }

    // 6. Idempotency Check for Mutations
    const idempotencyKey = req.headers["idempotency-key"];
    if (req.method === "POST" && idempotencyKey && typeof idempotencyKey === "string") {
      const cached = idempotency.get(idempotencyKey.trim());
      if (cached) {
        sendJson(res, cached.statusCode, cached.body, { "X-Cache": "IDEMPOTENT_HIT" });
        return;
      }
    }

    // 7. Execute Handler with Error Handling & Idempotency Storage
    try {
      if (req.method === "POST" && idempotencyKey) {
        // Intercept response to store in idempotency cache
        const originalSendJson = sendJson;
        let responseCaptured = null;
        const proxyRes = {
          ...res,
          writeHead: (status, headers) => res.writeHead(status, headers),
          end: (payload) => {
            try {
              responseCaptured = JSON.parse(payload);
              idempotency.set(idempotencyKey.trim(), { statusCode: res.statusCode || 200, body: responseCaptured });
            } catch {}
            res.end(payload);
          },
        };
        await match.handler(req, proxyRes, { params: match.params });
      } else {
        await match.handler(req, res, { params: match.params });
      }
    } catch (err) {
      sendError(res, err.statusCode || 500, err.message, err.details ?? err.stack);
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
    start,
    stop,
  };
}
