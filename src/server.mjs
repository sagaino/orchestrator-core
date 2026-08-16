import http from "node:http";
import path from "node:path";
import { DEFAULT_VAULT, listProjects, buildContext, buildPlan, readMarkdown, loadRegistry } from "./core.mjs";
import { validateTaskReadiness } from "./task-readiness.mjs";
import { requestTask } from "./task-intake.mjs";
import { startTaskRun, recoverTaskRun, requestChangesTaskRun, rejectTaskRun, retryTaskRun } from "./task-workflow.mjs";
import { previewReviewWorkspace } from "./review-workflow.mjs";
import { listRuns, getRun } from "./run-manager.mjs";
import { listJobs, getJob } from "./job-queue.mjs";
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
    const result = previewReviewWorkspace({ runsRoot, runId: params.id });
    eventHub.broadcast("PREVIEW_OPENED", { runId: params.id, ...result });
    sendJson(res, 200, { success: true, data: result });
  });

  router.post("/api/runs/:id/request-changes", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { requestedBy = "user", reason } = body;
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return sendError(res, 400, "Missing required field: reason");
    }

    const manifest = await requestChangesTaskRun({
      vaultRoot,
      runsRoot,
      runId: params.id,
      requestedBy,
      reason: reason.trim(),
      onProgress: (m) => eventHub.broadcast("RUN_PROGRESS", { runId: m.runId, state: m.state }),
    });

    eventHub.broadcast("RUN_CHANGES_REQUESTED", { runId: manifest.runId, state: manifest.state });
    sendJson(res, 200, { success: true, data: manifest });
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

    eventHub.broadcast("RUN_REJECTED", { runId: manifest.runId, state: manifest.state });
    sendJson(res, 200, { success: true, data: manifest });
  });

  router.post("/api/runs/:id/recover", async (req, res, { params }) => {
    const body = await parseJsonBody(req);
    const { recoveredBy = "user", force = false } = body;

    const manifest = await recoverTaskRun({
      vaultRoot,
      runsRoot,
      runId: params.id,
      recoveredBy,
      force,
      onProgress: (m) => eventHub.broadcast("RUN_PROGRESS", { runId: m.runId, state: m.state }),
    });

    eventHub.broadcast("RUN_RECOVERED", { runId: manifest.runId, state: manifest.state });
    sendJson(res, 200, { success: true, data: manifest });
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
    const { selector, approvedBy = "user", targetPath = null } = body;
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
} = {}) {
  const token = apiToken || ensureApiToken(runsRoot);
  const hub = eventHub || createEventHub();
  const idempotency = new IdempotencyStore(runsRoot);

  const services = {
    readMarkdown,
    validateTaskReadiness,
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
      sendError(res, 500, err.message, err.stack);
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
