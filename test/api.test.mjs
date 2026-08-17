import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createOrchestratorServer } from "../src/server.mjs";
import { RUN_STATES } from "../src/run-manager.mjs";
import { computeAdaptivePollInterval, ACTIVE_POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS } from "../src/daemon.mjs";
import { hasActiveJobs, JOB_STATES } from "../src/job-queue.mjs";

console.log("Running api.test.mjs...");

const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), "api-vault-"));
const tempRuns = fs.mkdtempSync(path.join(os.tmpdir(), "api-runs-"));

// Helper for making HTTP requests
function request({ method = "GET", path: reqPath, port, token, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (token) reqHeaders["Authorization"] = `Bearer ${token}`;
    if (body) reqHeaders["Content-Type"] = "application/json";

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, data });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

try {
  // 1. Setup mock vault & project
  const registryPath = path.join(tempVault, "project-registry.md");
  fs.writeFileSync(
    registryPath,
    [
      "# Project Registry",
      "| project_id | project_page | repository | agent | graphify | graphify_output |",
      "|---|---|---|---|---|---|",
      "| starter-app | [[02-Projects/starter-app/project.md]] | /tmp/starter-app | agy | false | /tmp/starter-app/graph.json |",
    ].join("\n")
  );

  const projectDir = path.join(tempVault, "02-Projects", "starter-app");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "project.md"),
    [
      "---",
      "title: Starter App",
      "type: project",
      "tags: [starter]",
      "verification_defaults: [typecheck, build]",
      "created: 2026-08-16",
      "updated: 2026-08-16",
      "sources: []",
      "---",
      "# Starter App",
    ].join("\n")
  );

  const tasksDir = path.join(projectDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, "task-001.md"),
    [
      "---",
      "title: Implement Navbar",
      "task_id: FE-001",
      "project: starter-app",
      "status: READY",
      "dependencies: []",
      "verification: [typecheck]",
      "allowed_paths: [src/Navbar.tsx]",
      "requires_changes: true",
      "---",
      "# Implement Navbar",
      "Instruction for navbar",
    ].join("\n")
  );

  // Setup mock run
  const runId = "fe-001-20260816T030000Z-11223344";
  const manifest = {
    schemaVersion: 1,
    runId,
    state: RUN_STATES.REVIEW,
    project: { id: "starter-app", repository: "/tmp/starter-app" },
    task: { id: "FE-001", path: "02-Projects/starter-app/tasks/task-001.md", status: "REVIEW" },
    history: [],
  };
  fs.writeFileSync(path.join(tempRuns, `${runId}.json`), JSON.stringify(manifest, null, 2));

  // 2. Start API Server on a random free port
  const apiServer = createOrchestratorServer({
    vaultRoot: tempVault,
    runsRoot: tempRuns,
    port: 0, // OS assigns available port
    host: "127.0.0.1",
  });
  const serverInfo = await apiServer.start();
  const port = apiServer.server.address().port;
  const token = serverInfo.token;

  // Test 1: GET /api/health (No auth required)
  const healthRes = await request({ path: "/api/health", port });
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.data.data.status, "healthy");

  // Test 2: Unauthorized request (401)
  const unauthRes = await request({ path: "/api/projects", port, token: null });
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.data.success, false);

  // Test 3: Bad token (401)
  const badTokenRes = await request({ path: "/api/projects", port, token: "wrong-token" });
  assert.equal(badTokenRes.status, 401);

  // Test 4: Foreign origin rejection (403)
  const foreignOriginRes = await request({
    path: "/api/health",
    port,
    headers: { Origin: "http://malicious-site.com" },
  });
  assert.equal(foreignOriginRes.status, 403);

  // Test 5: GET /api/projects with valid auth
  const projectsRes = await request({ path: "/api/projects", port, token });
  assert.equal(projectsRes.status, 200);
  assert.equal(projectsRes.data.success, true);
  assert.equal(projectsRes.data.data.projects.length, 1);
  assert.equal(projectsRes.data.data.projects[0].id, "starter-app");

  // Test 6: GET /api/projects/:id
  const projectDetailRes = await request({ path: "/api/projects/starter-app", port, token });
  assert.equal(projectDetailRes.status, 200);
  assert.equal(projectDetailRes.data.data.id, "starter-app");

  // Test 7: GET /api/runs and GET /api/runs/:id
  const runsRes = await request({ path: "/api/runs", port, token });
  assert.equal(runsRes.status, 200);
  assert.equal(runsRes.data.data.length >= 1, true);

  const runDetailRes = await request({ path: `/api/runs/${runId}`, port, token });
  assert.equal(runDetailRes.status, 200);
  assert.equal(runDetailRes.data.data.runId, runId);

  // Test 8: GET /api/daemon/status
  const daemonRes = await request({ path: "/api/daemon/status", port, token });
  assert.equal(daemonRes.status, 200);
  assert.equal(typeof daemonRes.data.data.healthy, "boolean");

  // Test 9: Idempotency Key Caching
  const idempotencyKey = "test-idem-key-12345";
  // Emitting test notification via POST
  const notifRes1 = await request({
    method: "POST",
    path: "/api/notifications/test",
    port,
    token,
    headers: { "Idempotency-Key": idempotencyKey },
  });
  assert.equal(notifRes1.status, 200);

  // Second request with same idempotency key must return cached response with X-Cache header
  const notifRes2 = await request({
    method: "POST",
    path: "/api/notifications/test",
    port,
    token,
    headers: { "Idempotency-Key": idempotencyKey },
  });
  assert.equal(notifRes2.status, 200);
  assert.equal(notifRes2.headers["x-cache"], "IDEMPOTENT_HIT");

  // Test 10: SSE /api/events connection
  const ssePromise = new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/api/events?token=${token}`,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "text/event-stream");
      let received = "";
      res.on("data", (chunk) => {
        received += chunk;
        if (received.includes("event: connected")) {
          req.destroy();
          resolve(true);
        }
      });
    });
    req.on("error", (err) => {
      if (err.code === "ECONNRESET") resolve(true);
      else reject(err);
    });
    req.end();
  });

  await ssePromise;

  // Test 11: Non-blocking POST /api/runs/:id/start returns 202 Accepted
  const startRunId = "fe-002-20260816T040000Z-22334455";
  const startManifest = {
    schemaVersion: 1,
    runId: startRunId,
    state: RUN_STATES.PENDING_APPROVAL,
    project: { id: "starter-app", repository: "/tmp/starter-app" },
    task: { id: "FE-001", path: "02-Projects/starter-app/tasks/task-001.md", status: "READY" },
    history: [],
  };
  fs.writeFileSync(path.join(tempRuns, `${startRunId}.json`), JSON.stringify(startManifest, null, 2));

  const startRes = await request({
    method: "POST",
    path: `/api/runs/${startRunId}/start`,
    port,
    token,
    body: { approvedBy: "test-user" },
  });
  assert.equal(startRes.status, 202);
  assert.equal(startRes.data.success, true);
  assert.equal(startRes.data.data.runId, startRunId);
  assert.equal(startRes.data.data.status, "running");

  // Non-existent run returns 404
  const notFoundStart = await request({
    method: "POST",
    path: "/api/runs/non-existent-run/start",
    port,
    token,
  });
  assert.equal(notFoundStart.status, 404);

  // Test 12: Non-blocking POST /api/runs/:id/request-changes
  // Missing reason returns 400
  const reqChangesNoReason = await request({
    method: "POST",
    path: `/api/runs/${runId}/request-changes`,
    port,
    token,
    body: { reason: "" },
  });
  assert.equal(reqChangesNoReason.status, 400);

  // Valid request changes on review run returns 202 Accepted
  const reqChangesRes = await request({
    method: "POST",
    path: `/api/runs/${runId}/request-changes`,
    port,
    token,
    body: { reason: "Please refine the navbar styling" },
  });
  assert.equal(reqChangesRes.status, 202);
  assert.equal(reqChangesRes.data.success, true);
  assert.equal(reqChangesRes.data.data.runId, runId);
  assert.equal(reqChangesRes.data.data.status, "running");
  assert.equal(reqChangesRes.data.data.state, RUN_STATES.CHANGES_REQUESTED);

  // Test 13: Non-blocking POST /api/runs/:id/recover
  // Run not in FAILED state returns 400 without force
  const recoverNotFailed = await request({
    method: "POST",
    path: `/api/runs/${runId}/recover`,
    port,
    token,
    body: { force: false },
  });
  assert.equal(recoverNotFailed.status, 400);

  // Recover on FAILED run returns 202 Accepted
  const failedRunId = "fe-003-20260816T050000Z-33445566";
  const failedManifest = {
    schemaVersion: 1,
    runId: failedRunId,
    state: RUN_STATES.FAILED,
    project: { id: "starter-app", repository: "/tmp/starter-app" },
    task: { id: "FE-001", path: "02-Projects/starter-app/tasks/task-001.md", status: "FAILED" },
    history: [],
  };
  fs.writeFileSync(path.join(tempRuns, `${failedRunId}.json`), JSON.stringify(failedManifest, null, 2));

  const recoverRes = await request({
    method: "POST",
    path: `/api/runs/${failedRunId}/recover`,
    port,
    token,
    body: { force: true },
  });
  assert.equal(recoverRes.status, 202);
  assert.equal(recoverRes.data.success, true);
  assert.equal(recoverRes.data.data.runId, failedRunId);
  assert.equal(recoverRes.data.data.status, "running");
  assert.equal(recoverRes.data.data.state, RUN_STATES.VERIFYING);

  // Test 14: Adaptive backoff polling calculation in daemon
  assert.equal(computeAdaptivePollInterval({ activeWorkers: 0, queuedJobCount: 0, jobs: [] }), IDLE_POLL_INTERVAL_MS);
  assert.equal(computeAdaptivePollInterval({ activeWorkers: 1, queuedJobCount: 0, jobs: [] }), ACTIVE_POLL_INTERVAL_MS);
  assert.equal(computeAdaptivePollInterval({ activeWorkers: 0, queuedJobCount: 2, jobs: [] }), ACTIVE_POLL_INTERVAL_MS);
  assert.equal(computeAdaptivePollInterval({ activeWorkers: 0, queuedJobCount: 0, jobs: [{ state: JOB_STATES.QUEUED }] }), ACTIVE_POLL_INTERVAL_MS);
  assert.equal(computeAdaptivePollInterval({ activeWorkers: 0, queuedJobCount: 0, jobs: [{ state: JOB_STATES.DONE }] }), IDLE_POLL_INTERVAL_MS);

  // Test 15: hasActiveJobs helper
  assert.equal(hasActiveJobs(tempRuns), false);

  // Cleanup
  await apiServer.stop();
} finally {
  fs.rmSync(tempVault, { recursive: true, force: true });
  fs.rmSync(tempRuns, { recursive: true, force: true });
}

console.log("api.test.mjs: All tests passed!");
