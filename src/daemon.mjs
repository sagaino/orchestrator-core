import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { listRuns, prepareRunFromEvent, RUN_STATES } from "./run-manager.mjs";
import { scanReadyTasks, watchReadyTasks } from "./adapters/vault-task-watcher.mjs";
import { claimNextJob, JOB_STATES, listJobs, reconcileJobs, updateJob } from "./job-queue.mjs";
import { startTaskRun } from "./task-workflow.mjs";
import { notificationSummary, notifyTaskOutcome } from "./notification-service.mjs";
import { createOrchestratorServer } from "./server.mjs";

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEALTH_STALE_AFTER_MS = 45_000;
const DEFAULT_PARALLEL_WORKERS = 2;
const MAX_PARALLEL_WORKERS = 8;
const LAUNCH_AGENT_LABEL = "com.sagaino.personal-ai-orchestrator";
const execFileAsync = promisify(execFile);

export function configuredParallelWorkers(env = process.env) {
  const raw = env.ORCHESTRATOR_MAX_PARALLEL_JOBS;
  if (raw === undefined || raw === "") return DEFAULT_PARALLEL_WORKERS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PARALLEL_WORKERS) {
    throw new Error(`ORCHESTRATOR_MAX_PARALLEL_JOBS harus integer antara 1 dan ${MAX_PARALLEL_WORKERS}.`);
  }
  return value;
}

export function parallelQueueStatus(jobs, maxWorkers = DEFAULT_PARALLEL_WORKERS) {
  const running = jobs.filter((job) => job.state === JOB_STATES.RUNNING);
  const review = jobs.filter((job) => job.state === JOB_STATES.REVIEW);
  const queued = jobs.filter((job) => job.state === JOB_STATES.QUEUED);
  const reservedProjects = new Set([...running, ...review].map((job) => job.projectId));
  const blocked = queued.filter((job) => reservedProjects.has(job.projectId));
  const eligible = queued.filter((job) => !reservedProjects.has(job.projectId));
  return {
    strategy: "PARALLEL_DISTINCT_PROJECTS",
    maxWorkers,
    activeWorkers: running.length,
    availableWorkerSlots: Math.max(0, maxWorkers - running.length),
    activeProjects: [...new Set(running.map((job) => job.projectId))].sort(),
    reservedProjects: [...reservedProjects].sort(),
    eligibleQueuedJobCount: eligible.length,
    blockedQueuedJobCount: blocked.length,
    blockedQueuedJobs: blocked.map((job) => ({
      jobId: job.jobId,
      taskId: job.taskId,
      project: job.projectId,
      reason: "PROJECT_RESERVED_UNTIL_ACCEPT_OR_REJECT",
    })),
  };
}

function launchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function launchAgentOutputPath() {
  return path.join(os.homedir(), "Library", "Logs", "PersonalAIOrchestrator", "daemon-output.log");
}

function launchctlServiceTarget() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  return `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`;
}

function launchctlDomainTarget() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  return `gui/${process.getuid()}`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function daemonNodeExecutable() {
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath];
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? process.execPath;
}

function daemonExecutablePath() {
  return [...new Set([
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...String(process.env.PATH ?? "").split(":").filter(Boolean),
  ])].join(":");
}

function runtimePaths(runsRoot) {
  const root = path.join(runsRoot, "daemon");
  return {
    root,
    pid: path.join(root, "daemon.pid.json"),
    health: path.join(root, "health.json"),
    log: path.join(root, "daemon.jsonl"),
    output: path.join(root, "daemon-output.log"),
  };
}

function ensureRuntime(runsRoot) {
  const paths = runtimePaths(runsRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  return paths;
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function appendLog(logPath, event) {
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function outputTail(filePath) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  return content.slice(-4_000);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runLaunchctl(args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("launchctl", args, { encoding: "utf8" });
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    if (!allowFailure) {
      throw new Error(`launchctl ${args.join(" ")} gagal: ${error.stderr || error.message}`);
    }
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

function launchAgentPlist({ vaultRoot, runsRoot, cliPath, outputPath }) {
  const argumentsList = [
    daemonNodeExecutable(),
    cliPath,
    "daemon-worker",
    "--vault",
    vaultRoot,
    "--runs",
    runsRoot,
  ];
  const environmentVariables = [
    ["PATH", daemonExecutablePath()],
    ["ORCHESTRATOR_NOTIFICATION_DELIVERY", process.env.ORCHESTRATOR_NOTIFICATION_DELIVERY],
    ["ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS", process.env.ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS],
    ["ORCHESTRATOR_AGY_MODEL", process.env.ORCHESTRATOR_AGY_MODEL],
    ["ORCHESTRATOR_AGY_EFFORT", process.env.ORCHESTRATOR_AGY_EFFORT],
    ["ORCHESTRATOR_KNOWLEDGE_AUTO_PROMOTE_CONFIDENCE", process.env.ORCHESTRATOR_KNOWLEDGE_AUTO_PROMOTE_CONFIDENCE],
    ["ORCHESTRATOR_TOKEN_WARNING_THRESHOLD", process.env.ORCHESTRATOR_TOKEN_WARNING_THRESHOLD],
    ["ORCHESTRATOR_MAX_PARALLEL_JOBS", process.env.ORCHESTRATOR_MAX_PARALLEL_JOBS],
  ].filter(([, value]) => value !== undefined && value !== "");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(LAUNCH_AGENT_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argumentsList.map((argument) => `    <string>${xmlEscape(argument)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environmentVariables.flatMap(([key, value]) => [
      `    <key>${xmlEscape(key)}</key>`,
      `    <string>${xmlEscape(value)}</string>`,
    ]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(os.homedir())}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(outputPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(outputPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function waitForDaemon(runsRoot, expectedRunning, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(100);
    const status = daemonStatus({ runsRoot });
    if (status.running === expectedRunning && (!expectedRunning || status.heartbeatAt)) return status;
  }
  return daemonStatus({ runsRoot });
}

export function handoffReadyTask({ runsRoot, event, origin = "watcher-daemon" }) {
  return prepareRunFromEvent({ runsRoot, event, origin });
}

export async function processClaimedJob({
  vaultRoot,
  runsRoot,
  job,
  services,
  workflow = startTaskRun,
  onEvent = () => {},
  notifier = notifyTaskOutcome,
}) {
  onEvent({ event: "JOB_STARTED", jobId: job.jobId, taskId: job.taskId, project: job.projectId });
  try {
    const manifest = await workflow({
      vaultRoot,
      runsRoot,
      projectId: job.projectId,
      taskInput: job.taskId,
      approvedBy: job.requestedBy,
      services,
      initialTelemetry: job.intakeTelemetry ?? null,
      onProgress: (current) => {
        updateJob(runsRoot, job.jobId, { runId: current.runId, runState: current.state });
      },
    });
    const state = manifest.state === RUN_STATES.RETROSPECTIVE ? JOB_STATES.REVIEW : JOB_STATES.FAILED;
    const updated = updateJob(runsRoot, job.jobId, {
      state,
      runId: manifest.runId,
      runState: manifest.state,
      finishedAt: new Date().toISOString(),
    });
    onEvent({
      event: state === JOB_STATES.REVIEW ? "JOB_REVIEW_READY" : "JOB_FAILED",
      jobId: job.jobId,
      runId: manifest.runId,
    });
    let notification = null;
    try {
      notification = await notifier({ runsRoot, job: updated, manifest });
      onEvent({
        event: "NOTIFICATION_EMITTED",
        jobId: job.jobId,
        notificationId: notification?.notification?.notificationId ?? null,
        created: notification?.created ?? false,
      });
    } catch (notificationError) {
      onEvent({ event: "NOTIFICATION_FAILED", jobId: job.jobId, error: notificationError.message });
    }
    return { job: updated, manifest, notification };
  } catch (error) {
    const failed = updateJob(runsRoot, job.jobId, {
      state: JOB_STATES.FAILED,
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
    onEvent({ event: "JOB_FAILED", jobId: job.jobId, error: error.message });
    let notification = null;
    try {
      const failedManifest = failed.runId
        ? listRuns(runsRoot).find((run) => run.runId === failed.runId) ?? null
        : null;
      notification = await notifier({ runsRoot, job: failed, manifest: failedManifest, error });
      onEvent({
        event: "NOTIFICATION_EMITTED",
        jobId: job.jobId,
        notificationId: notification?.notification?.notificationId ?? null,
        created: notification?.created ?? false,
      });
    } catch (notificationError) {
      onEvent({ event: "NOTIFICATION_FAILED", jobId: job.jobId, error: notificationError.message });
    }
    return { job: failed, manifest: null, error, notification };
  }
}

export async function processNextQueuedJob(options) {
  const job = claimNextJob(options.runsRoot, {
    blockedProjectIds: options.blockedProjectIds ?? [],
  });
  if (!job) return null;
  return processClaimedJob({ ...options, job });
}

export function createParallelJobPool({
  vaultRoot,
  runsRoot,
  services,
  maxWorkers = configuredParallelWorkers(),
  workflow = startTaskRun,
  onEvent = () => {},
  notifier = notifyTaskOutcome,
}) {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > MAX_PARALLEL_WORKERS) {
    throw new Error(`maxWorkers harus integer antara 1 dan ${MAX_PARALLEL_WORKERS}.`);
  }
  const activeJobs = new Map();
  let acceptingJobs = true;

  const snapshot = () => ({
    maxWorkers,
    activeWorkers: activeJobs.size,
    activeJobs: [...activeJobs.values()].map(({ jobId, projectId }) => ({ jobId, projectId })),
  });

  const fill = () => {
    if (!acceptingJobs) return snapshot();
    while (activeJobs.size < maxWorkers) {
      const job = claimNextJob(runsRoot);
      if (!job) break;
      const promise = processClaimedJob({
        vaultRoot,
        runsRoot,
        job,
        services,
        workflow,
        onEvent,
        notifier,
      }).catch((error) => {
        const failed = updateJob(runsRoot, job.jobId, {
          state: JOB_STATES.FAILED,
          error: `Worker failure: ${error.message}`,
          finishedAt: new Date().toISOString(),
        });
        onEvent({ event: "PARALLEL_WORKER_FAILED", jobId: job.jobId, project: job.projectId, error: error.message });
        return { job: failed, manifest: null, error };
      }).finally(() => {
        activeJobs.delete(job.jobId);
        queueMicrotask(fill);
      });
      activeJobs.set(job.jobId, { jobId: job.jobId, projectId: job.projectId, promise });
    }
    return snapshot();
  };

  const waitForIdle = async () => {
    fill();
    while (activeJobs.size > 0) {
      await Promise.allSettled([...activeJobs.values()].map((item) => item.promise));
      fill();
    }
    return snapshot();
  };

  const stop = () => {
    acceptingJobs = false;
    return snapshot();
  };

  return { fill, snapshot, stop, waitForIdle };
}

export function daemonStatus({ runsRoot }) {
  const paths = runtimePaths(runsRoot);
  const agentPath = launchAgentPath();
  const pidRecord = readJson(paths.pid);
  const health = readJson(paths.health);
  const running = processAlive(pidRecord?.pid);
  const healthMatchesProcess = Boolean(pidRecord?.pid && health?.pid === pidRecord.pid);
  const heartbeatAt = healthMatchesProcess && health?.heartbeatAt ? Date.parse(health.heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Math.max(0, Date.now() - heartbeatAt) : null;
  const healthy = running && healthMatchesProcess && heartbeatAgeMs !== null && heartbeatAgeMs <= HEALTH_STALE_AFTER_MS;
  const runs = listRuns(runsRoot);
  const jobs = listJobs(runsRoot);
  const maxWorkers = healthMatchesProcess
    ? health?.parallel?.maxWorkers ?? configuredParallelWorkers()
    : configuredParallelWorkers();
  const pendingApprovals = runs
    .filter((run) => run.state === RUN_STATES.PENDING_APPROVAL)
    .map((run) => ({
      runId: run.runId,
      taskId: run.task?.id ?? null,
      project: run.project?.id ?? null,
      createdAt: run.createdAt,
    }));
  const approved = runs
    .filter((run) => run.state === RUN_STATES.APPROVED)
    .map((run) => ({ runId: run.runId, taskId: run.task?.id ?? null, project: run.project?.id ?? null }));

  return {
    schemaVersion: 1,
    service: "personal-ai-orchestrator-watcher",
    serviceManager: fs.existsSync(agentPath) ? "launchd" : "detached-process",
    installed: fs.existsSync(agentPath),
    launchAgentLabel: LAUNCH_AGENT_LABEL,
    running,
    healthy,
    pid: pidRecord?.pid ?? null,
    startedAt: pidRecord?.startedAt ?? (healthMatchesProcess ? health?.startedAt : null) ?? null,
    heartbeatAt: healthMatchesProcess ? health?.heartbeatAt ?? null : null,
    heartbeatAgeMs,
    counters: (healthMatchesProcess ? health?.counters : null) ?? {
      readyEvents: 0,
      manifestsCreated: 0,
      deduplicated: 0,
      jobsStarted: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      errors: 0,
    },
    lastEvent: healthMatchesProcess ? health?.lastEvent ?? null : null,
    parallel: parallelQueueStatus(jobs, maxWorkers),
    notifications: notificationSummary(runsRoot),
    queue: {
      queuedJobCount: jobs.filter((job) => job.state === JOB_STATES.QUEUED).length,
      runningJobCount: jobs.filter((job) => job.state === JOB_STATES.RUNNING).length,
      reviewJobCount: jobs.filter((job) => job.state === JOB_STATES.REVIEW).length,
      latestJobs: jobs.slice(0, 10).map((job) => ({
        jobId: job.jobId,
        taskId: job.taskId,
        project: job.projectId,
        state: job.state,
        runId: job.runId,
      })),
      pendingApprovalCount: pendingApprovals.length,
      pendingApprovals,
      approvedCount: approved.length,
      approved,
    },
    paths: {
      pid: paths.pid,
      health: paths.health,
      log: paths.log,
      output: paths.output,
      launchAgent: agentPath,
      launchAgentOutput: launchAgentOutputPath(),
    },
  };
}

export async function startDaemon({ vaultRoot, runsRoot, cliPath }) {
  const existing = daemonStatus({ runsRoot });
  if (existing.running) return { action: "ALREADY_RUNNING", ...existing };

  const paths = ensureRuntime(runsRoot);
  if (fs.existsSync(paths.pid)) fs.unlinkSync(paths.pid);
  const agentPath = launchAgentPath();
  if (fs.existsSync(agentPath)) {
    const domain = launchctlDomainTarget();
    const service = launchctlServiceTarget();
    if (!domain || !service) throw new Error("LaunchAgent hanya didukung pada macOS user session.");
    const bootstrapped = await runLaunchctl(["bootstrap", domain, agentPath], { allowFailure: true });
    if (!bootstrapped.ok) await runLaunchctl(["kickstart", "-k", service]);
    const status = await waitForDaemon(runsRoot, true);
    if (status.running && status.heartbeatAt) return { action: "STARTED", ...status };
    throw new Error(`LaunchAgent gagal start. Output terakhir:\n${outputTail(launchAgentOutputPath()) || "(tidak ada output)"}`);
  }

  const outputDescriptor = fs.openSync(paths.output, "a");
  let child;
  try {
    child = spawn(process.execPath, [
      cliPath,
      "daemon-worker",
      "--vault",
      vaultRoot,
      "--runs",
      runsRoot,
    ], {
      cwd: path.resolve(path.dirname(cliPath), ".."),
      detached: true,
      stdio: ["ignore", outputDescriptor, outputDescriptor],
      env: { ...process.env, PATH: daemonExecutablePath() },
    });
    child.unref();
  } finally {
    fs.closeSync(outputDescriptor);
  }

  const status = await waitForDaemon(runsRoot, true, 40);
  if (status.running && status.heartbeatAt) return { action: "STARTED", ...status };
  throw new Error(`Daemon gagal start. Output terakhir:\n${outputTail(paths.output) || "(tidak ada output)"}`);
}

export async function stopDaemon({ runsRoot }) {
  const current = daemonStatus({ runsRoot });
  if (current.installed) {
    const service = launchctlServiceTarget();
    if (!service) throw new Error("LaunchAgent hanya didukung pada macOS user session.");
    await runLaunchctl(["bootout", service], { allowFailure: true });
  } else if (!current.running) {
    return { action: "ALREADY_STOPPED", ...current };
  } else {
    process.kill(current.pid, "SIGTERM");
  }
  const status = await waitForDaemon(runsRoot, false);
  return { action: status.running ? "STOP_REQUESTED" : "STOPPED", ...status };
}

export async function installDaemonService({ vaultRoot, runsRoot, cliPath }) {
  const domain = launchctlDomainTarget();
  const service = launchctlServiceTarget();
  if (!domain || !service) throw new Error("Managed daemon installation hanya didukung pada macOS.");
  const paths = ensureRuntime(runsRoot);
  const agentPath = launchAgentPath();
  const managedOutput = launchAgentOutputPath();
  fs.mkdirSync(path.dirname(managedOutput), { recursive: true });
  const current = daemonStatus({ runsRoot });
  if (current.running) {
    if (current.installed) await runLaunchctl(["bootout", service], { allowFailure: true });
    else process.kill(current.pid, "SIGTERM");
    await waitForDaemon(runsRoot, false);
  }

  writeTextAtomic(agentPath, launchAgentPlist({ vaultRoot, runsRoot, cliPath, outputPath: managedOutput }));
  try {
    await runLaunchctl(["bootstrap", domain, agentPath]);
    const status = await waitForDaemon(runsRoot, true);
    if (!status.running || !status.heartbeatAt) {
      throw new Error(`LaunchAgent terpasang tetapi worker tidak sehat. Output terakhir:\n${outputTail(managedOutput) || "(tidak ada output)"}`);
    }
    return { action: "INSTALLED_AND_STARTED", ...status };
  } catch (error) {
    await runLaunchctl(["bootout", service], { allowFailure: true });
    if (fs.existsSync(agentPath)) fs.unlinkSync(agentPath);
    throw error;
  }
}

export async function uninstallDaemonService({ runsRoot }) {
  const service = launchctlServiceTarget();
  if (!service) throw new Error("Managed daemon removal hanya didukung pada macOS.");
  const agentPath = launchAgentPath();
  await runLaunchctl(["bootout", service], { allowFailure: true });
  await waitForDaemon(runsRoot, false);
  if (fs.existsSync(agentPath)) fs.unlinkSync(agentPath);
  return { action: "UNINSTALLED", ...daemonStatus({ runsRoot }) };
}

export async function runDaemonWorker({ vaultRoot, runsRoot, services }) {
  const paths = ensureRuntime(runsRoot);
  const existing = readJson(paths.pid);
  if (existing?.pid !== process.pid && processAlive(existing?.pid)) {
    throw new Error(`Daemon sudah berjalan dengan PID ${existing.pid}.`);
  }

  const startedAt = new Date().toISOString();
  const maxWorkers = configuredParallelWorkers();
  const pidRecord = { pid: process.pid, startedAt, vaultRoot, runsRoot, maxWorkers };
  writeJsonAtomic(paths.pid, pidRecord);

  const apiServer = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: Number(process.env.ORCHESTRATOR_API_PORT || 3721),
    host: "127.0.0.1",
  });
  await apiServer.start();

  const health = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
    vaultRoot,
    runsRoot,
    api: {
      port: apiServer.port,
      host: apiServer.host,
    },
    parallel: parallelQueueStatus(listJobs(runsRoot), maxWorkers),
    counters: {
      readyEvents: 0,
      manifestsCreated: 0,
      deduplicated: 0,
      jobsStarted: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      errors: 0,
    },
    lastEvent: { event: "DAEMON_STARTED", at: startedAt },
  };
  appendLog(paths.log, { event: "DAEMON_STARTED", pid: process.pid, vaultRoot, runsRoot });
  const persistHealth = () => {
    health.heartbeatAt = new Date().toISOString();
    health.parallel = parallelQueueStatus(listJobs(runsRoot), maxWorkers);
    writeJsonAtomic(paths.health, health);
  };
  const record = (event, patch = {}) => {
    Object.assign(health.counters, patch);
    health.lastEvent = { ...event, at: new Date().toISOString() };
    appendLog(paths.log, event);
    persistHealth();
  };
  const processEvent = (event) => {
    try {
      const result = handoffReadyTask({ runsRoot, event });
      record({
        event: result.created ? "RUN_AUTO_PREPARED" : "RUN_AUTO_DEDUPLICATED",
        eventId: event.eventId,
        taskId: event.task.id,
        project: event.project.id,
        runId: result.manifest.runId,
        state: result.manifest.state,
      }, {
        readyEvents: health.counters.readyEvents + 1,
        manifestsCreated: health.counters.manifestsCreated + (result.created ? 1 : 0),
        deduplicated: health.counters.deduplicated + (result.created ? 0 : 1),
      });
    } catch (error) {
      record({ event: "AUTO_PREPARE_ERROR", eventId: event.eventId, error: error.message }, {
        readyEvents: health.counters.readyEvents + 1,
        errors: health.counters.errors + 1,
      });
    }
  };
  const processError = (error) => record({ event: "WATCHER_ERROR", ...error }, {
    errors: health.counters.errors + 1,
  });

  const reconciledJobs = reconcileJobs(runsRoot, listRuns(runsRoot));
  if (reconciledJobs.length) {
    record({
      event: "JOBS_RECONCILED",
      count: reconciledJobs.length,
      jobs: reconciledJobs.map((job) => ({ jobId: job.jobId, state: job.state, recovery: job.recovery })),
    });
    const runsById = new Map(listRuns(runsRoot).map((run) => [run.runId, run]));
    for (const job of reconciledJobs.filter((item) => [JOB_STATES.REVIEW, JOB_STATES.FAILED].includes(item.state))) {
      try {
        const notification = await notifyTaskOutcome({
          runsRoot,
          job,
          manifest: job.runId ? runsById.get(job.runId) ?? null : null,
          error: job.error ? new Error(job.error) : null,
        });
        record({
          event: "RECONCILED_NOTIFICATION_EMITTED",
          jobId: job.jobId,
          notificationId: notification.notification?.notificationId ?? null,
          created: notification.created,
        });
      } catch (error) {
        record({ event: "RECONCILED_NOTIFICATION_FAILED", jobId: job.jobId, error: error.message }, {
          errors: health.counters.errors + 1,
        });
      }
    }
  }

  const processJobEvent = (event) => {
    const patch = event.event === "JOB_STARTED"
      ? { jobsStarted: (health.counters.jobsStarted ?? 0) + 1 }
      : event.event === "JOB_REVIEW_READY"
        ? { jobsCompleted: (health.counters.jobsCompleted ?? 0) + 1 }
        : ["JOB_FAILED", "PARALLEL_WORKER_FAILED"].includes(event.event)
          ? {
            jobsFailed: (health.counters.jobsFailed ?? 0) + 1,
            errors: health.counters.errors + 1,
          }
          : event.event === "NOTIFICATION_FAILED"
            ? { errors: health.counters.errors + 1 }
            : {};
    record(event, patch);
  };
  const workerPool = createParallelJobPool({
    vaultRoot,
    runsRoot,
    services,
    maxWorkers,
    onEvent: processJobEvent,
  });
  const fillWorkerPool = () => {
    workerPool.fill();
    persistHealth();
  };

  let watcher;
  let heartbeat;
  let jobPoller;
  try {
    watcher = watchReadyTasks({
      vaultRoot,
      services,
      ignoreInitial: true,
      onEvent: processEvent,
      onError: processError,
    });
    const initial = scanReadyTasks(vaultRoot, services);
    for (const error of initial.errors) processError(error);
    for (const event of initial.events) processEvent(event);
    persistHealth();
    heartbeat = setInterval(persistHealth, HEARTBEAT_INTERVAL_MS);
    fillWorkerPool();
    jobPoller = setInterval(fillWorkerPool, 1_000);

    await new Promise((resolve) => {
      process.once("SIGINT", () => resolve("SIGINT"));
      process.once("SIGTERM", () => resolve("SIGTERM"));
    });
  } finally {
    if (apiServer) await apiServer.stop();
    workerPool.stop();
    if (heartbeat) clearInterval(heartbeat);
    if (jobPoller) clearInterval(jobPoller);
    if (watcher) await watcher.close();
    const stoppedAt = new Date().toISOString();
    health.heartbeatAt = stoppedAt;
    health.stoppedAt = stoppedAt;
    health.lastEvent = { event: "DAEMON_STOPPED", at: stoppedAt };
    appendLog(paths.log, { event: "DAEMON_STOPPED", pid: process.pid });
    writeJsonAtomic(paths.health, health);
    const currentPid = readJson(paths.pid)?.pid;
    if (currentPid === process.pid && fs.existsSync(paths.pid)) fs.unlinkSync(paths.pid);
  }
}
