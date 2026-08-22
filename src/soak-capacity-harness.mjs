import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEventHub } from "./api/events.mjs";
import { createOrchestratorServer } from "./server.mjs";
import { enqueueTaskJob, listJobs } from "./job-queue.mjs";

const HARNESS_SCHEMA_VERSION = 1;
const DEFAULT_MAX_STEPS = 288;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

function integerOption(value, name, { min, max }) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) throw new Error(`${name} harus integer ${min}-${max}.`);
  return normalized;
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function measureTree(root) {
  if (!fs.existsSync(root)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) { files += 1; bytes += fs.statSync(absolute).size; }
    }
  };
  walk(root);
  return { bytes, files };
}

async function readJsonResponse(response, maxResponseBytes) {
  const text = await response.text();
  if (Buffer.byteLength(text) > maxResponseBytes) throw new Error(`API response melebihi cap ${maxResponseBytes} bytes.`);
  try { return JSON.parse(text); } catch { throw new Error("API response bukan JSON valid."); }
}

async function openSseClient({ baseUrl, token, maxResponseBytes }) {
  const response = await fetch(`${baseUrl}/api/events`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) throw new Error(`SSE connection gagal dengan status ${response.status}.`);
  const reader = response.body.getReader();
  const client = { reader, bytes: 0, overflow: false, drainPromise: null };
  client.drainPromise = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        client.bytes += chunk.value.byteLength;
        if (client.bytes > maxResponseBytes) {
          client.overflow = true;
          await reader.cancel();
          break;
        }
      }
    } catch {}
  })();
  return client;
}

async function closeSseClients(clients) {
  await Promise.all(clients.map(async (client) => {
    try { await client.reader.cancel(); } catch {}
    try { await client.drainPromise; } catch {}
  }));
}

function invariant(id, passed, details) {
  return { id, passed: Boolean(passed), details };
}

/**
 * Run a bounded, deterministic virtual-time soak against an isolated runtime.
 * The harness never invokes an AI provider or executes synthetic jobs; queued
 * jobs are intentionally left queued so silent approval cannot be mistaken for
 * capacity success.
 */
export async function runSoakCapacityHarness({
  harnessRoot = null,
  vaultRoot = null,
  runsRoot = null,
  durationHours = 24,
  stepMinutes = 15,
  workers = 2,
  apiRequestsPerStep = 4,
  sseClients = 4,
  restartEverySteps = 16,
  maxSteps = DEFAULT_MAX_STEPS,
  artifactBytesPerStep = 512,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  now = new Date("2026-08-22T00:00:00.000Z"),
  persistReport = true,
  cleanupOwnedWorkspace = true,
} = {}) {
  const normalizedDurationHours = Number(durationHours);
  if (!Number.isFinite(normalizedDurationHours) || normalizedDurationHours < 1 || normalizedDurationHours > 72) throw new Error("durationHours harus berada di antara 1 dan 72.");
  const normalizedStepMinutes = integerOption(stepMinutes, "stepMinutes", { min: 1, max: 60 });
  const normalizedWorkers = integerOption(workers, "workers", { min: 1, max: 8 });
  const normalizedApiRequests = integerOption(apiRequestsPerStep, "apiRequestsPerStep", { min: 1, max: 20 });
  const normalizedSseClients = integerOption(sseClients, "sseClients", { min: 1, max: 20 });
  const normalizedRestartEvery = integerOption(restartEverySteps, "restartEverySteps", { min: 1, max: 1000 });
  const normalizedMaxSteps = integerOption(maxSteps, "maxSteps", { min: 1, max: DEFAULT_MAX_STEPS });
  const normalizedArtifactBytes = integerOption(artifactBytesPerStep, "artifactBytesPerStep", { min: 1, max: 1024 * 1024 });
  const normalizedMaxArtifactBytes = integerOption(maxArtifactBytes, "maxArtifactBytes", { min: 1024, max: 10 * 1024 * 1024 * 1024 });
  const normalizedMaxResponseBytes = integerOption(maxResponseBytes, "maxResponseBytes", { min: 1024, max: 16 * 1024 * 1024 });
  const stepCount = Math.min(Math.ceil((normalizedDurationHours * 60) / normalizedStepMinutes), normalizedMaxSteps);
  const ownsWorkspace = !vaultRoot && !runsRoot && !harnessRoot;
  const workspace = path.resolve(harnessRoot ?? (ownsWorkspace ? fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-soak-")) : path.dirname(path.resolve(runsRoot ?? vaultRoot))));
  const actualVaultRoot = path.resolve(vaultRoot ?? path.join(workspace, "vault"));
  const actualRunsRoot = path.resolve(runsRoot ?? path.join(workspace, "runs"));
  const artifactRoot = path.join(actualRunsRoot, "workspace-artifacts", "soak-harness");
  const reportPath = path.join(actualRunsRoot, "runtime", "soak", "last-report.json");
  fs.mkdirSync(path.join(actualVaultRoot, "soak"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(actualRunsRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(actualVaultRoot, "soak", "README.md"), "Deterministic soak fixture.\n", { flag: "a", mode: 0o600 });

  const startedAt = Date.now();
  const errors = [];
  const alerts = new Map();
  const expectedJobIds = new Set();
  const createdJobIds = new Set();
  const apiDurationsMs = [];
  let duplicateAdmissionAttempts = 0;
  let duplicateAdmissions = 0;
  let apiRequests = 0;
  let apiFailures = 0;
  let restartCount = 0;
  let sseRejected = 0;
  let sseBytes = 0;
  let server = null;
  let sse = [];
  let baseUrl = null;
  const token = "c".repeat(64);

  const startServer = async () => {
    const eventHub = createEventHub({ heartbeatIntervalMs: 1000, maxClients: normalizedSseClients });
    server = createOrchestratorServer({ vaultRoot: actualVaultRoot, runsRoot: actualRunsRoot, port: 0, host: "127.0.0.1", apiToken: token, eventHub, rateLimiter: { check: () => ({ allowed: true, limit: 100000, retryAfterSeconds: 0 }) } });
    await server.start();
    const address = server.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  const openSse = async () => {
    sse = [];
    for (let index = 0; index < normalizedSseClients; index += 1) {
      try { sse.push(await openSseClient({ baseUrl, token, maxResponseBytes: normalizedMaxResponseBytes })); }
      catch (error) { sseRejected += 1; errors.push(`SSE client ${index + 1}: ${error.message}`); }
    }
  };

  const inspectApi = async (step) => {
    const endpoints = ["/api/health", "/api/operations/readiness", "/api/operations/backups/status", "/api/telemetry"];
    const selected = Array.from({ length: normalizedApiRequests }, (_, index) => endpoints[(step + index) % endpoints.length]);
    await Promise.all(selected.map(async (endpoint) => {
      const requestStarted = Date.now();
      apiRequests += 1;
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await readJsonResponse(response, normalizedMaxResponseBytes);
        apiDurationsMs.push(Date.now() - requestStarted);
        if (!response.ok || body?.success === false && endpoint === "/api/health") throw new Error(`${endpoint} status ${response.status}`);
        for (const alert of body?.data?.alerts ?? []) {
          alerts.set(alert.alertId, { alertId: alert.alertId, severity: alert.severity, message: alert.message, observations: (alerts.get(alert.alertId)?.observations ?? 0) + 1 });
        }
      } catch (error) {
        apiFailures += 1;
        errors.push(`API ${endpoint}: ${error.message}`);
      }
    }));
  };

  try {
    await startServer();
    await openSse();
    for (let step = 0; step < stepCount; step += 1) {
      for (let worker = 0; worker < normalizedWorkers; worker += 1) {
        const taskId = `SOAK-${String(step).padStart(4, "0")}-${String(worker).padStart(2, "0")}`;
        const projectId = `soak-project-${worker}`;
        const first = enqueueTaskJob({ runsRoot: actualRunsRoot, projectId, taskId, taskPath: `soak/${taskId}.md`, requestedBy: "soak-harness" });
        if (first.created) { expectedJobIds.add(first.job.jobId); createdJobIds.add(first.job.jobId); }
        duplicateAdmissionAttempts += 1;
        const duplicate = enqueueTaskJob({ runsRoot: actualRunsRoot, projectId, taskId, taskPath: `soak/${taskId}.md`, requestedBy: "soak-harness" });
        if (duplicate.created) { duplicateAdmissions += 1; expectedJobIds.add(duplicate.job.jobId); createdJobIds.add(duplicate.job.jobId); }
      }
      const artifactDirectory = path.join(artifactRoot, `step-${String(step).padStart(4, "0")}`);
      fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(artifactDirectory, "bounded-output.txt"), `${"x".repeat(normalizedArtifactBytes)}\n`, { encoding: "utf8", mode: 0o600 });
      await inspectApi(step);
      if ((step + 1) % normalizedRestartEvery === 0 && step + 1 < stepCount) {
        await closeSseClients(sse);
        sseBytes += sse.reduce((sum, client) => sum + client.bytes, 0);
        await server.stop();
        const persisted = new Set(listJobs(actualRunsRoot).map((job) => job.jobId));
        const missingAtRestart = [...expectedJobIds].filter((jobId) => !persisted.has(jobId));
        if (missingAtRestart.length) errors.push(`Restart ${restartCount + 1} kehilangan ${missingAtRestart.length} job persisted.`);
        restartCount += 1;
        await startServer();
        await openSse();
      }
    }
    await closeSseClients(sse);
    sseBytes += sse.reduce((sum, client) => sum + client.bytes, 0);
    if (server) await server.stop();
  } catch (error) {
    errors.push(error.message);
    try { await closeSseClients(sse); } catch {}
    try { if (server) await server.stop(); } catch {}
  }

  const jobs = listJobs(actualRunsRoot);
  const persistedJobIds = new Set(jobs.map((job) => job.jobId));
  const missingJobIds = [...expectedJobIds].filter((jobId) => !persistedJobIds.has(jobId));
  const nonQueuedJobs = jobs.filter((job) => job.state !== "QUEUED");
  const artifacts = measureTree(path.join(actualRunsRoot, "workspace-artifacts"));
  const sseOverflow = sse.some((client) => client.overflow);
  const invariants = [
    invariant("NO_DUPLICATE_INVOCATION", duplicateAdmissions === 0, { duplicateAdmissionAttempts, duplicateAdmissions }),
    invariant("NO_LOST_UPDATE", missingJobIds.length === 0, { expected: expectedJobIds.size, persisted: persistedJobIds.size, missingJobIds }),
    invariant("NO_SILENT_APPROVAL", nonQueuedJobs.length === 0, { nonQueuedJobs: nonQueuedJobs.map((job) => ({ jobId: job.jobId, state: job.state })) }),
    invariant("BOUNDED_CLIENT_AND_OUTPUT", sseRejected === 0 && !sseOverflow && artifacts.bytes <= normalizedMaxArtifactBytes && apiFailures === 0, { sseClients: normalizedSseClients, sseRejected, sseOverflow, sseBytes, artifactBytes: artifacts.bytes, maxArtifactBytes: normalizedMaxArtifactBytes, apiFailures }),
    invariant("RECOVERABLE_STATE", errors.length === 0 && missingJobIds.length === 0, { restartCount, errors: errors.slice(0, 10) }),
  ];
  const report = {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    action: "SOAK_CAPACITY_HARNESS",
    status: invariants.every((item) => item.passed) ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    virtualWindow: { durationHours: normalizedDurationHours, stepMinutes: normalizedStepMinutes, steps: stepCount, simulatedStart: now.toISOString(), simulatedEnd: new Date(now.getTime() + normalizedDurationHours * 60 * 60 * 1000).toISOString() },
    capacity: { workers: normalizedWorkers, apiRequestsPerStep: normalizedApiRequests, sseClients: normalizedSseClients, restartEverySteps: normalizedRestartEvery, maxSteps: normalizedMaxSteps, maxResponseBytes: normalizedMaxResponseBytes, maxArtifactBytes: normalizedMaxArtifactBytes },
    workload: { createdJobs: createdJobIds.size, duplicateAdmissionAttempts, duplicateAdmissions, restarts: restartCount, apiRequests, apiFailures, maxApiDurationMs: apiDurationsMs.length ? Math.max(...apiDurationsMs) : 0, sseConnections: normalizedSseClients * (restartCount + 1), sseRejected, sseBytes, alerts: [...alerts.values()], artifacts },
    invariants,
    errors: errors.slice(0, 50),
    guardrails: { syntheticJobsExecuted: false, providerInvocations: 0, automaticApproval: false, automaticRestore: false, permanentDelete: false },
    reportPath: persistReport && !(ownsWorkspace && cleanupOwnedWorkspace) ? reportPath : null,
  };
  if (persistReport) writePrivateJson(reportPath, report);
  if (ownsWorkspace && cleanupOwnedWorkspace) {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
  }
  return report;
}

export { HARNESS_SCHEMA_VERSION };
