import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createOrchestratorServer } from "../src/server.mjs";
import { RUN_STATES } from "../src/run-manager.mjs";
import { computeAdaptivePollInterval, ACTIVE_POLL_INTERVAL_MS, IDLE_POLL_INTERVAL_MS, parallelQueueStatus, daemonStatus } from "../src/daemon.mjs";
import { hasActiveJobs, JOB_STATES } from "../src/job-queue.mjs";
import { onboardExistingProject, onboardNewProject, addExistingProject, addNewProject } from "../src/project-onboarding.mjs";
import { ingestRawKnowledge } from "../src/knowledge-ingest.mjs";
import { harvestRepositoryKnowledge, scanRepositoryArchitecture } from "../src/knowledge-harvester.mjs";
import { formatInlineComments, formatReviewRevisionFeedback } from "../src/review-workflow.mjs";
import { buildCompactedRevisionPrompt } from "../src/context-compactor.mjs";
import { buildAgyRevisionInvocation } from "../src/executor.mjs";

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
  // Missing reason and feedback returns 400
  const reqChangesNoReason = await request({
    method: "POST",
    path: `/api/runs/${runId}/request-changes`,
    port,
    token,
    body: { reason: "" },
  });
  assert.equal(reqChangesNoReason.status, 400);

  // Invalid non-array inlineComments returns 400
  const reqChangesInvalidInline = await request({
    method: "POST",
    path: `/api/runs/${runId}/request-changes`,
    port,
    token,
    body: { reason: "Please refine", inlineComments: "not-an-array" },
  });
  assert.equal(reqChangesInvalidInline.status, 400);
  assert.match(reqChangesInvalidInline.data.error.message, /inlineComments must be an array/);

  // Valid request changes using feedback field alias on review run returns 202 Accepted
  const reqChangesFeedbackRes = await request({
    method: "POST",
    path: `/api/runs/${runId}/request-changes`,
    port,
    token,
    body: { feedback: "Please refine the navbar styling using feedback alias" },
  });
  assert.equal(reqChangesFeedbackRes.status, 202);
  assert.equal(reqChangesFeedbackRes.data.success, true);
  assert.equal(reqChangesFeedbackRes.data.data.state, RUN_STATES.CHANGES_REQUESTED);

  // Valid request changes with inlineComments on review run returns 202 Accepted
  const reqChangesWithInlineRes = await request({
    method: "POST",
    path: `/api/runs/${runId}/request-changes`,
    port,
    token,
    body: {
      reason: "Refine navbar based on code review",
      inlineComments: [
        { file: "src/Navbar.tsx", line: 24, comment: "Please use flex-col on mobile screens" },
        { file: "src/Navbar.tsx", line: 40, comment: "Add aria-label for accessibility" },
      ],
    },
  });
  assert.equal(reqChangesWithInlineRes.status, 202);
  assert.equal(reqChangesWithInlineRes.data.success, true);
  assert.equal(reqChangesWithInlineRes.data.data.runId, runId);
  assert.equal(reqChangesWithInlineRes.data.data.status, "running");
  assert.equal(reqChangesWithInlineRes.data.data.state, RUN_STATES.CHANGES_REQUESTED);

  // Test 12.1: Unit tests for inline comments formatting and revision prompt builders
  const emptyFormatted = formatInlineComments([]);
  assert.equal(emptyFormatted, "");
  const nullFormatted = formatInlineComments(null);
  assert.equal(nullFormatted, "");

  const sampleInlineComments = [
    { file: "src/Navbar.tsx", line: 12, comment: "Perbaiki typo pada prop title" },
    { file: "src/Footer.tsx", line: 45, comment: "Hapus import yang tidak digunakan" },
  ];
  const formattedComments = formatInlineComments(sampleInlineComments);
  assert.ok(formattedComments.includes("=== INLINE CODE COMMENTS DARI REVIEWER ==="));
  assert.ok(formattedComments.includes('File: src/Navbar.tsx (Line 12): "Perbaiki typo pada prop title"'));
  assert.ok(formattedComments.includes('File: src/Footer.tsx (Line 45): "Hapus import yang tidak digunakan"'));

  const fullRevisionFeedback = formatReviewRevisionFeedback({
    reason: "Perbaiki styling navbar",
    inlineComments: sampleInlineComments,
  });
  assert.ok(fullRevisionFeedback.includes("Perbaiki styling navbar"));
  assert.ok(fullRevisionFeedback.includes("=== INLINE CODE COMMENTS DARI REVIEWER ==="));
  assert.ok(fullRevisionFeedback.includes('File: src/Navbar.tsx (Line 12): "Perbaiki typo pada prop title"'));
  assert.ok(fullRevisionFeedback.includes("Instruksi: Prioritaskan perbaikan pada baris-baris spesifik yang diberi catatan oleh reviewer di atas."));

  // buildAgyRevisionInvocation format test
  const mockRevisionManifest = {
    runId: "test-rev-run-001",
    project: { agent: "agy", repository: "/tmp/mock-repo" },
    task: { path: "02-Projects/starter-app/tasks/task-001.md", allowedPaths: ["src/Navbar.tsx"] },
    retrieval: { knowledge: [] },
    execution: {
      workspace: { path: "/tmp/mock-repo" },
      reviewChanges: [
        {
          iteration: 1,
          reason: "General styling feedback",
          inlineComments: sampleInlineComments,
        },
      ],
    },
  };
  const revisionInvocation = buildAgyRevisionInvocation(mockRevisionManifest, tempVault);
  const promptText = revisionInvocation.args[revisionInvocation.args.indexOf("-p") + 1];
  assert.ok(promptText.includes("=== INLINE CODE COMMENTS DARI REVIEWER ==="));
  assert.ok(promptText.includes('File: src/Navbar.tsx (Line 12): "Perbaiki typo pada prop title"'));
  assert.ok(promptText.includes("Prioritaskan perbaikan pada baris-baris spesifik yang diberi catatan oleh reviewer"));

  // buildCompactedRevisionPrompt format test
  const compactedPrompt = buildCompactedRevisionPrompt({
    task: { id: "TASK-001" },
    projectId: "starter-app",
    reason: "Fix layout issues",
    inlineComments: sampleInlineComments,
    allowedPaths: ["src/Navbar.tsx"],
  });
  assert.ok(compactedPrompt.prompt.includes("=== INLINE CODE COMMENTS DARI REVIEWER ==="));
  assert.ok(compactedPrompt.prompt.includes('File: src/Navbar.tsx (Line 12): "Perbaiki typo pada prop title"'));
  assert.ok(compactedPrompt.prompt.includes("Prioritaskan perbaikan pada baris-baris spesifik yang diberi catatan oleh reviewer"));

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

  // Test 16: POST /api/knowledge/health/fix-safe and SSE KNOWLEDGE_HEALTH_UPDATED broadcast
  const indexFile = path.join(tempVault, "index.md");
  fs.writeFileSync(
    indexFile,
    [
      "---",
      "title: Index",
      "type: schema",
      "tags: [index]",
      "created: 2026-08-16",
      "updated: 2026-08-16",
      "sources: []",
      "---",
      "# Index",
      "",
      "## Knowledge",
      "",
    ].join("\n")
  );

  const wikiLogFile = path.join(tempVault, "wiki-log.md");
  fs.writeFileSync(
    wikiLogFile,
    [
      "---",
      "title: Wiki Log",
      "type: schema",
      "tags: [log]",
      "created: 2026-08-16",
      "updated: 2026-08-16",
      "sources: []",
      "---",
      "# Wiki Log",
      "",
    ].join("\n")
  );

  const conceptsDir = path.join(tempVault, "01-Knowledge", "concepts");
  fs.mkdirSync(conceptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(conceptsDir, "sample-concept.md"),
    [
      "---",
      "title: Sample Concept",
      "type: concept",
      "tags: [test]",
      "created: 2026-08-16",
      "updated: 2026-08-16",
      "sources: []",
      "---",
      "# Sample Concept",
      "This is a sample concept for testing health check and fix-safe.",
    ].join("\n")
  );

  // Check read-only health endpoint first
  const healthReadOnly = await request({ path: "/api/knowledge/health", port, token });
  assert.equal(healthReadOnly.status, 200);
  assert.equal(healthReadOnly.data.success, true);
  assert.equal(healthReadOnly.data.data.mode, "read-only");
  assert.equal(healthReadOnly.data.data.summary.safeFixesAvailable >= 1, true);

  // Listen to SSE events for KNOWLEDGE_HEALTH_UPDATED
  let sseEventData = null;
  const sseHealthPromise = new Promise((resolve, reject) => {
    const sseReq = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/events?token=${token}`,
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk.toString();
          if (buffer.includes("event: KNOWLEDGE_HEALTH_UPDATED")) {
            sseEventData = buffer;
            sseReq.destroy();
            resolve(true);
          }
        });
      }
    );
    sseReq.on("error", (err) => {
      if (err.code === "ECONNRESET") resolve(true);
      else reject(err);
    });
    sseReq.end();
  });

  // Short pause to ensure SSE connection is registered in eventHub
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Trigger POST /api/knowledge/health/fix-safe
  const fixSafeRes = await request({
    method: "POST",
    path: "/api/knowledge/health/fix-safe",
    port,
    token,
    body: { fixedBy: "unit-tester" },
  });

  assert.equal(fixSafeRes.status, 200);
  assert.equal(fixSafeRes.data.success, true);
  assert.equal(fixSafeRes.data.data.mode, "safe-fix");
  assert.equal(fixSafeRes.data.data.summary.safeFixesApplied >= 1, true);
  assert.equal(Array.isArray(fixSafeRes.data.data.fixes), true);
  assert.equal(
    fixSafeRes.data.data.fixes.some((f) => f.action === "ADD_TO_INDEX" && f.path.includes("sample-concept")),
    true
  );

  // Verify index.md updated
  const updatedIndex = fs.readFileSync(indexFile, "utf8");
  assert.equal(updatedIndex.includes("01-Knowledge/concepts/sample-concept"), true);

  // Verify wiki-log.md updated
  const updatedWikiLog = fs.readFileSync(wikiLogFile, "utf8");
  assert.equal(updatedWikiLog.includes("lint | Knowledge Quality"), true);
  assert.equal(updatedWikiLog.includes("unit-tester"), true);

  // Wait for SSE broadcast
  await sseHealthPromise;
  assert.ok(sseEventData);
  assert.equal(sseEventData.includes("event: KNOWLEDGE_HEALTH_UPDATED"), true);

  // Test 17: Worker slot synchronization & activeWorkers calculation in daemon status and parallelQueueStatus
  // Case A: parallelQueueStatus with job in RUNNING state
  const runningJob = {
    jobId: "job-sync-1",
    projectId: "project-sync-a",
    taskId: "TASK-SYNC-1",
    state: JOB_STATES.RUNNING,
    runId: null,
  };
  const statusJobRunning = parallelQueueStatus([runningJob], 2);
  assert.equal(statusJobRunning.activeWorkers, 1);
  assert.equal(statusJobRunning.availableWorkerSlots, 1);
  assert.deepEqual(statusJobRunning.activeProjects, ["project-sync-a"]);

  // Case B: parallelQueueStatus with run in RUNNING or EXECUTING state without matching running job
  const runningRun = {
    runId: "run-sync-1",
    state: RUN_STATES.RUNNING,
    project: { id: "project-sync-b" },
    task: { id: "TASK-SYNC-2" },
  };
  const statusRunRunning = parallelQueueStatus([], 2, [runningRun]);
  assert.equal(statusRunRunning.activeWorkers, 1);
  assert.equal(statusRunRunning.availableWorkerSlots, 1);
  assert.deepEqual(statusRunRunning.activeProjects, ["project-sync-b"]);

  // Case C: Deduplication when job and run refer to same execution
  const linkedJob = {
    jobId: "job-sync-linked",
    projectId: "project-sync-c",
    taskId: "TASK-SYNC-3",
    state: JOB_STATES.RUNNING,
    runId: "run-sync-linked",
  };
  const linkedRun = {
    runId: "run-sync-linked",
    state: RUN_STATES.RUNNING,
    project: { id: "project-sync-c" },
    task: { id: "TASK-SYNC-3" },
  };
  const statusDeduplicated = parallelQueueStatus([linkedJob], 2, [linkedRun]);
  assert.equal(statusDeduplicated.activeWorkers, 1, "Should deduplicate matching job and run");
  assert.equal(statusDeduplicated.availableWorkerSlots, 1);

  // Case D: Multiple distinct running executions across projects
  const executingRun = {
    runId: "run-sync-executing",
    state: "EXECUTING",
    project: { id: "project-sync-d" },
    task: { id: "TASK-SYNC-4" },
  };
  const statusMultiple = parallelQueueStatus([runningJob], 2, [runningRun, executingRun]);
  assert.equal(statusMultiple.activeWorkers, 3);
  assert.equal(statusMultiple.availableWorkerSlots, 0); // Math.max(0, 2 - 3) = 0
  assert.deepEqual(statusMultiple.activeProjects, ["project-sync-a", "project-sync-b", "project-sync-d"]);

  // Case E: daemonStatus live calculation & HTTP /api/daemon/status response
  const activeSyncRunId = "run-active-sync-test-99";
  const activeSyncManifest = {
    schemaVersion: 1,
    runId: activeSyncRunId,
    state: RUN_STATES.RUNNING,
    project: { id: "starter-app", repository: "/tmp/starter-app" },
    task: { id: "FE-001", path: "02-Projects/starter-app/tasks/task-001.md", status: "IN_PROGRESS" },
    history: [],
  };
  fs.writeFileSync(path.join(tempRuns, `${activeSyncRunId}.json`), JSON.stringify(activeSyncManifest, null, 2));

  // Verify daemonStatus function reflects active running run
  const liveDaemonStatus = daemonStatus({ runsRoot: tempRuns });
  assert.equal(liveDaemonStatus.parallel.activeWorkers >= 1, true, "activeWorkers must never be 0 when a run is RUNNING");
  assert.equal(liveDaemonStatus.parallel.availableWorkerSlots, Math.max(0, liveDaemonStatus.parallel.maxWorkers - liveDaemonStatus.parallel.activeWorkers));

  // Verify GET /api/daemon/status HTTP endpoint
  const daemonHttpRes = await request({ path: "/api/daemon/status", port, token });
  assert.equal(daemonHttpRes.status, 200);
  assert.equal(daemonHttpRes.data.data.parallel.activeWorkers >= 1, true);
  assert.equal(
    daemonHttpRes.data.data.parallel.availableWorkerSlots,
    Math.max(0, daemonHttpRes.data.data.parallel.maxWorkers - daemonHttpRes.data.data.parallel.activeWorkers)
  );

  // Clean up active sync run manifest
  fs.unlinkSync(path.join(tempRuns, `${activeSyncRunId}.json`));

  // Test 18: Project Onboarding Endpoints and Aliases
  // 18.1. Verify exports / aliases from project-onboarding.mjs
  assert.equal(typeof onboardExistingProject, "function");
  assert.equal(typeof onboardNewProject, "function");
  assert.equal(onboardExistingProject, addExistingProject);
  assert.equal(onboardNewProject, addNewProject);

  // 18.2. POST /api/projects/onboard/existing validation
  // Missing repositoryPath -> 400
  const onboardExistingNoPath = await request({
    method: "POST",
    path: "/api/projects/onboard/existing",
    port,
    token,
    body: {},
  });
  assert.equal(onboardExistingNoPath.status, 400);
  assert.equal(onboardExistingNoPath.data.success, false);
  assert.equal(onboardExistingNoPath.data.error.message, "Missing required field: repositoryPath");

  // Empty repositoryPath -> 400
  const onboardExistingEmptyPath = await request({
    method: "POST",
    path: "/api/projects/onboard/existing",
    port,
    token,
    body: { repositoryPath: "   " },
  });
  assert.equal(onboardExistingEmptyPath.status, 400);

  // 18.3. POST /api/projects/onboard/new validation
  // Missing projectId -> 400
  const onboardNewNoProjectId = await request({
    method: "POST",
    path: "/api/projects/onboard/new",
    port,
    token,
    body: { targetDirectory: "/tmp/some-dir" },
  });
  assert.equal(onboardNewNoProjectId.status, 400);
  assert.equal(onboardNewNoProjectId.data.success, false);
  assert.equal(onboardNewNoProjectId.data.error.message, "Missing required field: projectId");

  // Missing targetDirectory -> 400
  const onboardNewNoTarget = await request({
    method: "POST",
    path: "/api/projects/onboard/new",
    port,
    token,
    body: { projectId: "some-project" },
  });
  assert.equal(onboardNewNoTarget.status, 400);
  assert.equal(onboardNewNoTarget.data.success, false);
  assert.equal(onboardNewNoTarget.data.error.message, "Missing required field: targetDirectory");

  // 18.4. End-to-end execution & SSE broadcast with mock onboarding services
  const mockOnboardExistingCalls = [];
  const mockOnboardNewCalls = [];

  const mockOnboardServer = createOrchestratorServer({
    vaultRoot: tempVault,
    runsRoot: tempRuns,
    port: 0,
    host: "127.0.0.1",
    services: {
      onboardExistingProject: async (options) => {
        mockOnboardExistingCalls.push(options);
        if (options.repositoryPath.includes("fail-test")) {
          throw new Error("Mock existing onboarding failure");
        }
        return {
          schemaVersion: 1,
          action: "EXISTING_PROJECT_ADDED",
          onboardingId: "existing-onboard-mock-1",
          project: {
            id: options.projectId || "mock-existing-app",
            title: "Mock Existing App",
            repository: options.repositoryPath,
            valid: true,
          },
        };
      },
      onboardNewProject: async (options) => {
        mockOnboardNewCalls.push(options);
        if (options.projectId.includes("fail-test")) {
          throw new Error("Mock new onboarding failure");
        }
        return {
          schemaVersion: 1,
          action: "NEW_PROJECT_INITIALIZED",
          onboardingId: "new-onboard-mock-1",
          project: {
            id: options.projectId,
            title: options.projectName,
            repository: options.targetDirectory,
            blueprint: options.blueprint,
            valid: true,
          },
        };
      },
    },
  });

  const mockServerInfo = await mockOnboardServer.start();
  const mockPort = mockOnboardServer.server.address().port;
  const mockToken = mockServerInfo.token;

  // SSE event collector for mock server
  let sseOnboardEvents = [];
  const sseMockReq = http.request(
    {
      hostname: "127.0.0.1",
      port: mockPort,
      path: `/api/events?token=${mockToken}`,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      res.on("data", (chunk) => {
        sseOnboardEvents.push(chunk.toString());
      });
    }
  );
  sseMockReq.on("error", () => {});
  sseMockReq.end();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Test POST /api/projects/onboard/existing success
  const existingRes = await request({
    method: "POST",
    path: "/api/projects/onboard/existing",
    port: mockPort,
    token: mockToken,
    body: {
      repositoryPath: "/mock/path/existing-app",
      projectId: "existing-app-id",
    },
  });
  assert.equal(existingRes.status, 201);
  assert.equal(existingRes.data.success, true);
  assert.equal(existingRes.data.data.onboardingId, "existing-onboard-mock-1");
  assert.equal(existingRes.data.data.project.id, "existing-app-id");
  assert.equal(mockOnboardExistingCalls.length, 1);
  assert.equal(mockOnboardExistingCalls[0].repositoryPath, "/mock/path/existing-app");
  assert.equal(mockOnboardExistingCalls[0].projectId, "existing-app-id");

  // Test POST /api/projects/onboard/new success
  const newRes = await request({
    method: "POST",
    path: "/api/projects/onboard/new",
    port: mockPort,
    token: mockToken,
    body: {
      projectId: "new-frontend-app",
      targetDirectory: "/mock/path/new-frontend-app",
      blueprint: "frontend-vite",
    },
  });
  assert.equal(newRes.status, 201);
  assert.equal(newRes.data.success, true);
  assert.equal(newRes.data.data.onboardingId, "new-onboard-mock-1");
  assert.equal(newRes.data.data.project.id, "new-frontend-app");
  assert.equal(mockOnboardNewCalls.length, 1);
  assert.equal(mockOnboardNewCalls[0].projectId, "new-frontend-app");
  assert.equal(mockOnboardNewCalls[0].targetDirectory, "/mock/path/new-frontend-app");
  assert.equal(mockOnboardNewCalls[0].blueprint, "frontend-vite");

  // Wait for SSE events
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fullSseOutput = sseOnboardEvents.join("");
  assert.equal(fullSseOutput.includes("event: PROJECT_ONBOARDED"), true);
  assert.equal(fullSseOutput.includes('"mode":"existing"'), true);
  assert.equal(fullSseOutput.includes('"mode":"new"'), true);

  // 18.5. Test onboarding execution error handling (HTTP 500)
  const failExistingRes = await request({
    method: "POST",
    path: "/api/projects/onboard/existing",
    port: mockPort,
    token: mockToken,
    body: { repositoryPath: "/mock/fail-test/path" },
  });
  assert.equal(failExistingRes.status, 500);
  assert.equal(failExistingRes.data.success, false);
  assert.equal(failExistingRes.data.error.message, "Mock existing onboarding failure");

  const failNewRes = await request({
    method: "POST",
    path: "/api/projects/onboard/new",
    port: mockPort,
    token: mockToken,
    body: { projectId: "fail-test-project", targetDirectory: "/mock/target" },
  });
  assert.equal(failNewRes.status, 500);
  assert.equal(failNewRes.data.success, false);
  assert.equal(failNewRes.data.error.message, "Mock new onboarding failure");

  sseMockReq.destroy();
  await mockOnboardServer.stop();

  // Test 19: POST /api/knowledge/ingest and ingestRawKnowledge
  // 19.1. Validation tests on apiServer
  const ingestNoContent = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port,
    token,
    body: { domain: "frontend", type: "concept" },
  });
  assert.equal(ingestNoContent.status, 400);
  assert.equal(ingestNoContent.data.success, false);
  assert.equal(ingestNoContent.data.error.message, "Missing required field: content");

  const ingestEmptyContent = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port,
    token,
    body: { content: "   ", domain: "frontend", type: "concept" },
  });
  assert.equal(ingestEmptyContent.status, 400);

  const ingestNoDomain = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port,
    token,
    body: { content: "Sample raw knowledge text", type: "concept" },
  });
  assert.equal(ingestNoDomain.status, 400);
  assert.equal(ingestNoDomain.data.error.message, "Missing required field: domain");

  const ingestNoType = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port,
    token,
    body: { content: "Sample raw knowledge text", domain: "frontend" },
  });
  assert.equal(ingestNoType.status, 400);
  assert.equal(ingestNoType.data.error.message, "Missing required field: type");

  const ingestInvalidDomain = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port,
    token,
    body: { content: "Sample raw knowledge text", domain: "quantum-computing", type: "concept" },
  });
  assert.equal(ingestInvalidDomain.status, 400);
  assert.match(ingestInvalidDomain.data.error.message, /Domain tidak valid/);

  const ingestInvalidType = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port,
    token,
    body: { content: "Sample raw knowledge text", domain: "frontend", type: "opinion" },
  });
  assert.equal(ingestInvalidType.status, 400);
  assert.match(ingestInvalidType.data.error.message, /Type tidak valid/);

  const ingestInvalidDest = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port,
    token,
    body: { content: "Sample raw knowledge text", domain: "frontend", type: "concept", destination: "DATABASE" },
  });
  assert.equal(ingestInvalidDest.status, 400);
  assert.match(ingestInvalidDest.data.error.message, /Destination tidak valid/);

  // 19.2. Mock server with mock processRunner for agy synthesis
  let sseIngestEvents = [];
  const mockIngestServer = createOrchestratorServer({
    vaultRoot: tempVault,
    runsRoot: tempRuns,
    port: 0,
    host: "127.0.0.1",
    services: {
      processRunner: async (invocation) => {
        if (invocation.stage === "knowledge-ingest") {
          const prompt = invocation.args?.[1] || "";
          const titleMatch = prompt.match(/Requested Title: (.*)/);
          const title = titleMatch ? titleMatch[1].trim() : "Synthesized Knowledge";
          return {
            exitCode: 0,
            stdoutTail: JSON.stringify({
              title,
              summary: `A robust overview for ${title}.`,
              purpose: `Provide standard architecture and practices for ${title}.`,
              keyPoints: [
                "Synchronizes across distributed layers.",
                "Provides structured error handling.",
              ],
              codeSnippets: [
                {
                  language: "typescript",
                  code: "export const handler = () => null;",
                  description: "Basic usage example",
                },
              ],
              considerations: [
                "Ensure proper concurrency guards and testing.",
              ],
              tags: ["storage", "distributed"],
              relatedKnowledge: [
                "01-Knowledge/concepts/sample-concept",
              ],
            }),
            stderrTail: "",
          };
        }
        return { exitCode: 0, stdoutTail: "", stderrTail: "" };
      },
    },
  });

  const mockIngestServerInfo = await mockIngestServer.start();
  const mockIngestPort = mockIngestServer.server.address().port;
  const mockIngestToken = mockIngestServerInfo.token;

  // SSE event stream listener for ingest events
  const sseIngestReq = http.request(
    {
      hostname: "127.0.0.1",
      port: mockIngestPort,
      path: `/api/events?token=${mockIngestToken}`,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      res.on("data", (chunk) => {
        sseIngestEvents.push(chunk.toString());
      });
    }
  );
  sseIngestReq.on("error", () => {});
  sseIngestReq.end();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 19.3. Test ingestion to WIKI destination (HTTP 201)
  const ingestWikiRes = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port: mockIngestPort,
    token: mockIngestToken,
    body: {
      content: "Custom React hook useLocalStorage with AES encryption.",
      title: "React useLocalStorage Hook",
      domain: "frontend",
      type: "snippet",
      destination: "WIKI",
    },
  });

  assert.equal(ingestWikiRes.status, 201);
  assert.equal(ingestWikiRes.data.success, true);
  assert.equal(ingestWikiRes.data.data.action, "KNOWLEDGE_INGESTED");
  assert.equal(ingestWikiRes.data.data.destination, "WIKI");
  assert.equal(ingestWikiRes.data.data.target.domain, "frontend");
  assert.equal(ingestWikiRes.data.data.target.type, "snippet");
  assert.equal(ingestWikiRes.data.data.target.path, "01-Knowledge/snippets/frontend/react-uselocalstorage-hook.md");

  // Verify created file in vault
  const wikiFilePath = path.join(tempVault, "01-Knowledge", "snippets", "frontend", "react-uselocalstorage-hook.md");
  assert.ok(fs.existsSync(wikiFilePath), "Wiki file must exist");
  const wikiContent = fs.readFileSync(wikiFilePath, "utf8");
  assert.match(wikiContent, /title:\s*"React useLocalStorage Hook"/);
  assert.match(wikiContent, /type:\s*snippet/);
  assert.match(wikiContent, /orchestrator_run:\s*ingest-/);
  assert.match(wikiContent, /## Key Implementation Points/);
  assert.match(wikiContent, /## Code Examples/);
  assert.match(wikiContent, /## Considerations/);
  assert.match(wikiContent, /## Source/);

  // Verify index.md and wiki-log.md updated
  const indexAfterIngest = fs.readFileSync(indexFile, "utf8");
  assert.ok(indexAfterIngest.includes("01-Knowledge/snippets/frontend/react-uselocalstorage-hook"));

  const logAfterIngest = fs.readFileSync(wikiLogFile, "utf8");
  assert.ok(logAfterIngest.includes("ingest | React useLocalStorage Hook"));
  assert.ok(logAfterIngest.includes("Domain: `frontend`, Type: `snippet`, Destination: `WIKI`"));

  // 19.4. Test ingestion to CANDIDATE destination (HTTP 201)
  const ingestCandidateRes = await request({
    method: "POST",
    path: "/api/knowledge/ingest",
    port: mockIngestPort,
    token: mockIngestToken,
    body: {
      content: "Distributed lock algorithm using Redis multi-instance consensus.",
      title: "Redis Redlock Distributed Locking",
      domain: "backend",
      type: "pattern",
      destination: "CANDIDATE",
    },
  });

  assert.equal(ingestCandidateRes.status, 201);
  assert.equal(ingestCandidateRes.data.success, true);
  assert.equal(ingestCandidateRes.data.data.destination, "CANDIDATE");
  assert.equal(ingestCandidateRes.data.data.target.path, "05-Knowledge-Candidates/redis-redlock-distributed-locking.md");

  // Verify candidate file exists and has type: candidate
  const candidateFilePath = path.join(tempVault, "05-Knowledge-Candidates", "redis-redlock-distributed-locking.md");
  assert.ok(fs.existsSync(candidateFilePath), "Candidate file must exist");
  const candidateContent = fs.readFileSync(candidateFilePath, "utf8");
  assert.match(candidateContent, /type:\s*candidate/);
  assert.match(candidateContent, /orchestrator_run:\s*ingest-/);
  assert.match(candidateContent, /## Observation/);
  assert.match(candidateContent, /## Why It Is Not Promoted Yet/);
  assert.match(candidateContent, /## Promotion Criteria/);

  // Wait and verify SSE broadcast
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fullIngestSse = sseIngestEvents.join("");
  assert.ok(fullIngestSse.includes("event: KNOWLEDGE_INGESTED"), "SSE event KNOWLEDGE_INGESTED must be emitted");

  sseIngestReq.destroy();
  await mockIngestServer.stop();

  // 19.5. Direct ingestRawKnowledge function tests
  await assert.rejects(
    ingestRawKnowledge({ vaultRoot: null, rawContent: "test", domain: "frontend", type: "concept" }),
    /vaultRoot harus ditentukan/
  );
  await assert.rejects(
    ingestRawKnowledge({ vaultRoot: tempVault, rawContent: "", domain: "frontend", type: "concept" }),
    /rawContent tidak boleh kosong/
  );

  // Test 20: POST /api/knowledge/harvest and harvestRepositoryKnowledge
  // 20.1. Validation tests on apiServer
  const harvestNoRepo = await request({
    method: "POST",
    path: "/api/knowledge/harvest",
    port,
    token,
    body: { domain: "backend" },
  });
  assert.equal(harvestNoRepo.status, 400);
  assert.equal(harvestNoRepo.data.success, false);
  assert.equal(harvestNoRepo.data.error.message, "Missing required field: repositoryPath");

  const harvestEmptyRepo = await request({
    method: "POST",
    path: "/api/knowledge/harvest",
    port,
    token,
    body: { repositoryPath: "   ", domain: "backend" },
  });
  assert.equal(harvestEmptyRepo.status, 400);

  const harvestNonExistentRepo = await request({
    method: "POST",
    path: "/api/knowledge/harvest",
    port,
    token,
    body: { repositoryPath: "/path/that/does/not/exist/anywhere", domain: "backend" },
  });
  assert.equal(harvestNonExistentRepo.status, 400);
  assert.match(harvestNonExistentRepo.data.error.message, /Repository path tidak ditemukan/);

  const harvestInvalidDomain = await request({
    method: "POST",
    path: "/api/knowledge/harvest",
    port,
    token,
    body: { repositoryPath: tempVault, domain: "invalid-domain-xyz" },
  });
  assert.equal(harvestInvalidDomain.status, 400);
  assert.match(harvestInvalidDomain.data.error.message, /Domain tidak valid/);

  // 20.2. Setup sample mock backend repository
  const mockBackendRepo = path.join(tempVault, "mock-backend-repo");
  fs.mkdirSync(path.join(mockBackendRepo, "src", "controllers"), { recursive: true });
  fs.mkdirSync(path.join(mockBackendRepo, "src", "services"), { recursive: true });
  fs.mkdirSync(path.join(mockBackendRepo, "src", "repositories"), { recursive: true });
  fs.mkdirSync(path.join(mockBackendRepo, "src", "middlewares"), { recursive: true });
  fs.mkdirSync(path.join(mockBackendRepo, "graphify-out"), { recursive: true });

  fs.writeFileSync(path.join(mockBackendRepo, "package.json"), JSON.stringify({
    name: "mock-backend-service",
    version: "1.0.0",
    dependencies: {
      jsonwebtoken: "^9.0.0",
      bcrypt: "^5.1.0",
      prisma: "^5.0.0",
      "@prisma/client": "^5.0.0",
      zod: "^3.22.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  }, null, 2));

  fs.writeFileSync(path.join(mockBackendRepo, "graphify-out", "graph.json"), JSON.stringify({
    nodes: [{ id: "auth.ts" }, { id: "user.service.ts" }],
    links: [{ source: "auth.ts", target: "user.service.ts" }],
  }));

  fs.writeFileSync(path.join(mockBackendRepo, "src", "middlewares", "auth.middleware.ts"), "export const authGuard = () => null;");
  fs.writeFileSync(path.join(mockBackendRepo, "src", "services", "user.service.ts"), "export class UserService {}");
  fs.writeFileSync(path.join(mockBackendRepo, "src", "repositories", "user.repository.ts"), "export class UserRepository {}");

  // Verify scanRepositoryArchitecture
  const scan = scanRepositoryArchitecture(mockBackendRepo);
  assert.equal(scan.packageName, "mock-backend-service");
  assert.equal(scan.detectedPatterns.auth.detected, true);
  assert.equal(scan.detectedPatterns.database.detected, true);
  assert.equal(scan.detectedPatterns.errorHandling.detected, true);
  assert.ok(scan.graphifySummary);
  assert.equal(scan.graphifySummary.nodeCount, 2);

  // Setup template in vault
  const templatesDir = path.join(tempVault, "01-Knowledge", "_templates");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, "backend-pattern-template.md"), [
    "---",
    "title: Backend Pattern Template",
    "type: pattern",
    "tags: [template, backend]",
    "---",
    "# {{Title}}",
    "## 1. Overview & Architecture",
  ].join("\n"));

  // 20.3. Mock server with mock processRunner for agy harvest
  let sseHarvestEvents = [];
  const mockHarvestServer = createOrchestratorServer({
    vaultRoot: tempVault,
    runsRoot: tempRuns,
    port: 0,
    host: "127.0.0.1",
    services: {
      processRunner: async (invocation) => {
        if (invocation.stage === "knowledge-harvest") {
          return {
            exitCode: 0,
            stdoutTail: JSON.stringify({
              patterns: [
                {
                  title: "JWT Authentication & RBAC Guard Pattern",
                  summary: "Pola middleware autentikasi JWT terpusat dengan role-based access control.",
                  confidence: 0.95,
                  purpose: "Menstandarkan validasi token dan proteksi rute API.",
                  overview: "Menggunakan JWT token validation di middleware layer sebelum request mencapai controller.",
                  codeStructure: "src/middlewares/auth.middleware.ts -> src/controllers/*",
                  keyImplementationPoints: [
                    "Token validation dengan jsonwebtoken",
                    "User claims injection ke context request",
                    "Role-based permission check",
                  ],
                  codeSnippets: [
                    {
                      language: "typescript",
                      code: "export const authGuard = (req, res, next) => next();",
                      description: "Contoh implementasi middleware auth guard",
                    },
                  ],
                  considerations: [
                    "Pastikan refresh token disimpan dengan aman di httpOnly cookie.",
                  ],
                  tags: ["auth", "jwt", "security"],
                  relatedKnowledge: [],
                },
                {
                  title: "Prisma Transactional Unit of Work Pattern",
                  summary: "Pola isolasi transaksi database menggunakan Prisma Client $transaction API.",
                  confidence: 0.85,
                  purpose: "Menjamin integritas data atomik pada operasi multi-tabel.",
                  overview: "Membungkus rangkaian mutasi data dalam single interactive transaction block.",
                  codeStructure: "src/services/* -> Prisma.$transaction -> src/repositories/*",
                  keyImplementationPoints: [
                    "Penggunaan interactive transaction",
                    "Rollback otomatis saat terjadi unhandled exception",
                  ],
                  codeSnippets: [
                    {
                      language: "typescript",
                      code: "await prisma.$transaction(async (tx) => { ... });",
                      description: "Interactive transaction block",
                    },
                  ],
                  considerations: [
                    "Hindari operasi async I/O non-database di dalam blok transaksi.",
                  ],
                  tags: ["database", "prisma", "transactions"],
                  relatedKnowledge: [],
                },
              ],
            }),
            stderrTail: "",
          };
        }
        return { exitCode: 0, stdoutTail: "", stderrTail: "" };
      },
    },
  });

  const mockHarvestServerInfo = await mockHarvestServer.start();
  const mockHarvestPort = mockHarvestServer.server.address().port;
  const mockHarvestToken = mockHarvestServerInfo.token;

  // SSE event stream listener for harvest events
  const sseHarvestReq = http.request(
    {
      hostname: "127.0.0.1",
      port: mockHarvestPort,
      path: `/api/events?token=${mockHarvestToken}`,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      res.on("data", (chunk) => {
        sseHarvestEvents.push(chunk.toString());
      });
    }
  );
  sseHarvestReq.on("error", () => {});
  sseHarvestReq.end();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 20.4. POST /api/knowledge/harvest execution
  const harvestRes = await request({
    method: "POST",
    path: "/api/knowledge/harvest",
    port: mockHarvestPort,
    token: mockHarvestToken,
    body: {
      repositoryPath: mockBackendRepo,
      domain: "backend",
    },
  });

  assert.equal(harvestRes.status, 201);
  assert.equal(harvestRes.data.success, true);
  assert.equal(harvestRes.data.data.action, "KNOWLEDGE_HARVESTED");
  assert.equal(harvestRes.data.data.domain, "backend");
  assert.equal(harvestRes.data.data.count, 2);
  assert.equal(harvestRes.data.data.harvested.length, 2);

  // Pattern 1: confidence 0.95 -> destination WIKI
  const item1 = harvestRes.data.data.harvested[0];
  assert.equal(item1.destination, "WIKI");
  assert.equal(item1.type, "pattern");
  assert.equal(item1.path, "01-Knowledge/patterns/backend/jwt-authentication-rbac-guard-pattern.md");

  // Verify created wiki file
  const wikiPatternPath = path.join(tempVault, "01-Knowledge", "patterns", "backend", "jwt-authentication-rbac-guard-pattern.md");
  assert.ok(fs.existsSync(wikiPatternPath), "Harvested wiki pattern file must exist");
  const wikiPatternContent = fs.readFileSync(wikiPatternPath, "utf8");
  assert.match(wikiPatternContent, /type:\s*pattern/);
  assert.match(wikiPatternContent, /orchestrator_run:\s*harvest-/);
  assert.match(wikiPatternContent, /## 1\. Overview & Architecture/);
  assert.match(wikiPatternContent, /## 2\. Implementation & Code Structure/);
  assert.match(wikiPatternContent, /## 3\. Key Implementation Points/);
  assert.match(wikiPatternContent, /## 4\. Code Examples/);
  assert.match(wikiPatternContent, /## 5\. Considerations & Best Practices/);
  assert.match(wikiPatternContent, /## 7\. Source/);

  // Pattern 2: confidence 0.85 -> destination CANDIDATE
  const item2 = harvestRes.data.data.harvested[1];
  assert.equal(item2.destination, "CANDIDATE");
  assert.equal(item2.type, "candidate");
  assert.equal(item2.path, "05-Knowledge-Candidates/prisma-transactional-unit-of-work-pattern.md");

  // Verify created candidate file
  const candidatePatternPath = path.join(tempVault, "05-Knowledge-Candidates", "prisma-transactional-unit-of-work-pattern.md");
  assert.ok(fs.existsSync(candidatePatternPath), "Harvested candidate file must exist");
  const candidatePatternContent = fs.readFileSync(candidatePatternPath, "utf8");
  assert.match(candidatePatternContent, /type:\s*candidate/);
  assert.match(candidatePatternContent, /orchestrator_run:\s*harvest-/);
  assert.match(candidatePatternContent, /## Observation/);
  assert.match(candidatePatternContent, /## Purpose/);
  assert.match(candidatePatternContent, /## Why It Is Not Promoted Yet/);
  assert.match(candidatePatternContent, /## Promotion Criteria/);

  // Verify index.md and wiki-log.md updated
  const indexAfterHarvest = fs.readFileSync(indexFile, "utf8");
  assert.ok(indexAfterHarvest.includes("01-Knowledge/patterns/backend/jwt-authentication-rbac-guard-pattern"));
  assert.ok(indexAfterHarvest.includes("05-Knowledge-Candidates/prisma-transactional-unit-of-work-pattern"));

  const logAfterHarvest = fs.readFileSync(wikiLogFile, "utf8");
  assert.ok(logAfterHarvest.includes("harvest | JWT Authentication & RBAC Guard Pattern"));
  assert.ok(logAfterHarvest.includes("harvest | Prisma Transactional Unit of Work Pattern"));
  assert.ok(logAfterHarvest.includes("Domain: `backend`, Type: `pattern`, Destination: `WIKI`"));
  assert.ok(logAfterHarvest.includes("Destination: `CANDIDATE`"));

  // Verify SSE event broadcast
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fullHarvestSse = sseHarvestEvents.join("");
  assert.ok(fullHarvestSse.includes("event: KNOWLEDGE_HARVESTED"), "SSE event KNOWLEDGE_HARVESTED must be emitted");
  assert.ok(fullHarvestSse.includes("jwt-authentication-rbac-guard-pattern"));

  sseHarvestReq.destroy();
  await mockHarvestServer.stop();

  // 20.5. Direct harvestRepositoryKnowledge validation tests
  await assert.rejects(
    harvestRepositoryKnowledge({ vaultRoot: null, repositoryPath: mockBackendRepo }),
    /vaultRoot harus ditentukan/
  );
  await assert.rejects(
    harvestRepositoryKnowledge({ vaultRoot: tempVault, repositoryPath: "" }),
    /repositoryPath tidak boleh kosong/
  );
  await assert.rejects(
    harvestRepositoryKnowledge({ vaultRoot: tempVault, repositoryPath: "/not/existing" }),
    /Repository path tidak ditemukan/
  );
  await assert.rejects(
    harvestRepositoryKnowledge({ vaultRoot: tempVault, repositoryPath: mockBackendRepo, domain: "invalid-domain" }),
    /Domain tidak valid/
  );

  // Cleanup
  await apiServer.stop();
} finally {
  fs.rmSync(tempVault, { recursive: true, force: true });
  fs.rmSync(tempRuns, { recursive: true, force: true });
}

console.log("api.test.mjs: All tests passed!");
