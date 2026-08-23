import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { getRun } from "./run-manager.mjs";

const execFileAsync = promisify(execFile);

export function findWorkspacePath(runsRoot, runId) {
  // Primary: resolve from manifest.execution.workspace.path
  try {
    const manifest = getRun(runsRoot, runId);
    const wsPath = manifest?.execution?.workspace?.path;
    const wsState = manifest?.execution?.workspace?.state;
    if (wsPath && fs.existsSync(wsPath) && !["CLEANED", "DISCARDED", "APPLIED"].includes(wsState)) {
      return wsPath;
    }
  } catch {}

  // Fallback: check legacy hardcoded paths
  const runDir = path.join(runsRoot, runId);
  const possiblePaths = [
    path.join(runDir, "workspace"),
    path.join(runDir, "worktree"),
    path.join(runDir, "review-workspace"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function allocateFreePort(startPort = 5200, maxAttempts = 50) {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Tidak menemukan port kosong antara ${startPort} dan ${startPort + maxAttempts}`);
}

export function parseGitDiff(rawDiff) {
  if (!rawDiff || typeof rawDiff !== "string") return [];
  const files = [];
  const fileChunks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split("\n");
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    const fileName = headerMatch ? headerMatch[2] : "unknown";

    let additions = 0;
    let deletions = 0;
    let status = "modified";

    for (const line of lines) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    files.push({
      file: fileName,
      status,
      additions,
      deletions,
      patch: `diff --git ${chunk}`,
    });
  }

  return files;
}

export async function getRunDiff({ runsRoot, runId }) {
  let run = null;
  try {
    run = getRun(runsRoot, runId);
  } catch {}

  const workspacePath = findWorkspacePath(runsRoot, runId);
  if (!workspacePath) {
    // Try loading archived diff for DONE/CLEANED runs
    try {
      const artifactRelPath = run?.execution?.workspace?.artifactPath
        ?? run?.execution?.workspace?.cleanup?.artifactPath;
      if (artifactRelPath) {
        const artifactDir = path.join(runsRoot, artifactRelPath);
        const diffFile = path.join(artifactDir, "changes.patch");
        if (fs.existsSync(diffFile)) {
          const rawDiff = fs.readFileSync(diffFile, "utf8");
          const files = parseGitDiff(rawDiff);
          return {
            runId,
            workspaceExists: false,
            archived: true,
            rawDiff,
            filesCount: files.length,
            files,
            message: "Diff diambil dari arsip workspace (worktree telah dibersihkan).",
          };
        }
      }
    } catch {}

    return {
      runId,
      workspaceExists: false,
      rawDiff: "",
      files: [],
      message: "Isolated worktree tidak aktif atau telah dibersihkan setelah accept/reject.",
    };
  }

  try {
    // Diff from the immutable workspace baseline, constrained to paths that the
    // scope audit attributes to this run. Using HEAD~1 leaks the previous source
    // commit into the review whenever the workspace itself has no new commit.
    const baseCommit = run?.execution?.workspace?.baseCommit;
    const changed = run?.execution?.scopeAudit?.changedPaths;
    const pathspec = Array.isArray(changed) && changed.length > 0 ? ["--", ...changed] : [];
    const primaryArgs = baseCommit
      ? ["diff", baseCommit, ...pathspec]
      : ["diff", "HEAD", ...pathspec];
    const { stdout: diffStdout } = await execFileAsync("git", primaryArgs, {
      cwd: workspacePath,
      encoding: "utf8",
    }).catch(async () => execFileAsync("git", ["diff", ...pathspec], {
      cwd: workspacePath,
      encoding: "utf8",
    }));

    const files = parseGitDiff(diffStdout);
    return {
      runId,
      workspaceExists: true,
      workspacePath,
      rawDiff: diffStdout,
      filesCount: files.length,
      files,
    };
  } catch (err) {
    return {
      runId,
      workspaceExists: true,
      workspacePath,
      rawDiff: "",
      files: [],
      error: err.message,
    };
  }
}

export class DevServerManager {
  constructor() {
    this.servers = new Map();
    this.aggregateSessions = new Map();
    this.aggregateSessionByObjective = new Map();
  }

  async startDevServer({ runsRoot, runId, repository = null, projectId = null, host = "127.0.0.1" }) {
    const existing = this.servers.get(runId);
    if (existing && existing.status === "RUNNING") {
      return {
        runId,
        port: existing.port,
        url: existing.url,
        status: existing.status,
        startedAt: existing.startedAt,
      };
    }

    if (host !== "127.0.0.1") throw new Error("Dev server hanya boleh bind ke loopback 127.0.0.1.");
    const workspacePath = repository || findWorkspacePath(runsRoot, runId);
    if (!workspacePath) {
      throw new Error(`Isolated workspace untuk run ${runId} tidak ditemukan.`);
    }

    const port = await allocateFreePort(5200);
    const logTail = [];
    const pushLog = (line) => {
      logTail.push(`[${new Date().toLocaleTimeString()}] ${line}`);
      if (logTail.length > 100) logTail.shift();
    };

    pushLog(`Memulai dev server pada port ${port}...`);

    const child = spawn("npm", ["run", "dev", "--", "--port", String(port), "--host", host], {
      cwd: workspacePath,
      env: {
        ...process.env,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const serverEntry = {
      runId,
      process: child,
      port,
      projectId,
      host,
      url: `http://${host}:${port}`,
      status: "STARTING",
      startedAt: new Date().toISOString(),
      logTail,
      workspacePath,
    };

    this.servers.set(runId, serverEntry);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n").filter(Boolean)) pushLog(line);
      if (serverEntry.status === "STARTING" && (text.includes("ready") || text.includes("Local:") || text.includes("http"))) {
        serverEntry.status = "RUNNING";
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n").filter(Boolean)) pushLog(`[ERR] ${line}`);
    });

    child.on("exit", (code) => {
      serverEntry.status = "STOPPED";
      pushLog(`Dev server berhenti dengan exit code ${code}`);
      this.servers.delete(runId);
    });

    // Wait a brief moment to confirm it boots
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!this.servers.has(runId)) throw new Error(`Dev server untuk ${projectId ?? runId} berhenti saat startup.`);
    serverEntry.status = "RUNNING";

    return {
      runId,
      projectId: serverEntry.projectId,
      host: serverEntry.host,
      port: serverEntry.port,
      url: serverEntry.url,
      status: serverEntry.status,
      startedAt: serverEntry.startedAt,
    };
  }

  stopDevServer(runId) {
    const server = this.servers.get(runId);
    if (!server) return { stopped: false, reason: "Server tidak sedang berjalan" };

    try {
      server.process.kill("SIGTERM");
    } catch {}
    this.servers.delete(runId);
    return { stopped: true, runId, port: server.port };
  }

  getDevServerStatus(runId) {
    const server = this.servers.get(runId);
    if (!server) {
      return {
        runId,
        running: false,
        port: null,
        url: null,
        status: "STOPPED",
        logTail: [],
      };
    }
    return {
      runId,
      running: server.status === "RUNNING" || server.status === "STARTING",
      port: server.port,
      url: server.url,
      status: server.status,
      startedAt: server.startedAt,
      logTail: server.logTail,
    };
  }

  async startAggregateProjectPreview({
    runsRoot,
    objectiveId,
    candidates = [],
    maxProjects = 4,
    maxServers = 4,
    maxDurationMs = 15 * 60 * 1000,
    host = "127.0.0.1",
  } = {}) {
    if (!objectiveId || typeof objectiveId !== "string") throw new Error("objectiveId wajib diisi.");
    if (host !== "127.0.0.1") throw new Error("Aggregate preview hanya boleh bind ke loopback 127.0.0.1.");
    if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 16) throw new Error("maxProjects harus integer antara 1 dan 16.");
    if (!Number.isInteger(maxServers) || maxServers < 1 || maxServers > maxProjects) throw new Error("maxServers harus integer antara 1 dan maxProjects.");
    if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1_000 || maxDurationMs > 60 * 60 * 1000) throw new Error("maxDurationMs harus antara 1000 dan 3600000.");

    const existingSessionId = this.aggregateSessionByObjective.get(objectiveId);
    if (existingSessionId) {
      const existing = this.aggregateSessions.get(existingSessionId);
      if (existing?.cleanup?.status !== "CLEANED") return { ...this.getAggregatePreviewStatus(existingSessionId), reused: true };
      this.aggregateSessionByObjective.delete(objectiveId);
    }

    const sessionId = `aggregate-preview-${randomUUID()}`;
    const session = {
      schemaVersion: 1,
      action: "AGGREGATE_PROJECT_PREVIEW",
      sessionId,
      objectiveId,
      host,
      maxProjects,
      maxServers,
      maxDurationMs,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + maxDurationMs).toISOString(),
      previews: [],
      unavailable: [],
      cleanup: { status: "ACTIVE", stoppedAt: null, stoppedRunIds: [], errors: [] },
    };
    this.aggregateSessions.set(sessionId, session);
    this.aggregateSessionByObjective.set(objectiveId, sessionId);

    const uniqueCandidates = [];
    const seenProjects = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const projectId = typeof candidate?.projectId === "string" ? candidate.projectId : null;
      if (!projectId || seenProjects.has(projectId)) continue;
      seenProjects.add(projectId);
      uniqueCandidates.push({ ...candidate, projectId });
    }

    for (const candidate of uniqueCandidates.slice(0, maxProjects)) {
      if (candidate.unavailableReason) {
        session.unavailable.push(this.unavailablePreview(candidate, candidate.unavailableReason, candidate.unavailableMessage));
        continue;
      }
      if (session.previews.length >= maxServers) {
        session.unavailable.push(this.unavailablePreview(candidate, "SERVER_LIMIT_REACHED"));
        continue;
      }
      try {
        const serverInfo = await this.startDevServer({
          runsRoot,
          runId: candidate.runId,
          repository: candidate.repository ?? null,
          projectId: candidate.projectId,
          host,
        });
        session.previews.push({
          projectId: candidate.projectId,
          runId: candidate.runId,
          url: serverInfo.url,
          host: serverInfo.host,
          port: serverInfo.port,
          status: serverInfo.status,
          startedAt: serverInfo.startedAt,
        });
      } catch (error) {
        session.unavailable.push(this.unavailablePreview(candidate, "DEV_SERVER_UNAVAILABLE", error?.message));
      }
    }
    for (const candidate of uniqueCandidates.slice(maxProjects)) {
      session.unavailable.push(this.unavailablePreview(candidate, "PROJECT_LIMIT_REACHED"));
    }

    session.status = session.previews.length === 0 ? "UNAVAILABLE" : session.unavailable.length ? "PARTIAL" : "READY";
    session.timer = setTimeout(() => this.stopAggregatePreview(sessionId), maxDurationMs);
    session.timer.unref?.();
    return this.getAggregatePreviewStatus(sessionId);
  }

  unavailablePreview(candidate, reason, message = null) {
    return {
      projectId: candidate?.projectId ?? null,
      runId: candidate?.runId ?? null,
      status: "UNAVAILABLE",
      reason,
      message: message ?? null,
      verification: { status: "NOT_EVALUATED", failed: false, impact: "NO_VERIFICATION_FAILURE" },
    };
  }

  stopAggregatePreview(sessionId, objectiveId = null) {
    const session = this.aggregateSessions.get(sessionId);
    if (!session) return { sessionId, stopped: false, reason: "Aggregate preview session tidak ditemukan." };
    if (objectiveId && session.objectiveId !== objectiveId) return { sessionId, stopped: false, reason: "Aggregate preview session bukan milik objective ini." };
    if (session.cleanup.status === "CLEANED") return this.getAggregatePreviewStatus(sessionId);
    const stoppedRunIds = [];
    const errors = [];
    for (const preview of session.previews) {
      try {
        const result = this.stopDevServer(preview.runId);
        if (result.stopped) stoppedRunIds.push(preview.runId);
      } catch (error) {
        errors.push({ runId: preview.runId, message: error?.message ?? String(error) });
      }
    }
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.cleanup = { status: "CLEANED", stoppedAt: new Date().toISOString(), stoppedRunIds, errors };
    if (this.aggregateSessionByObjective.get(session.objectiveId) === sessionId) this.aggregateSessionByObjective.delete(session.objectiveId);
    return this.getAggregatePreviewStatus(sessionId);
  }

  getAggregatePreviewStatus(sessionId) {
    const session = this.aggregateSessions.get(sessionId);
    if (!session) return { sessionId, status: "NOT_FOUND", previews: [], unavailable: [], cleanup: { status: "UNKNOWN" } };
    const { timer, ...status } = session;
    return {
      ...status,
      previews: status.previews.map((preview) => ({ ...preview, status: this.getDevServerStatus(preview.runId).status })),
      cleanup: { ...status.cleanup },
    };
  }

  stopAll() {
    for (const sessionId of this.aggregateSessions.keys()) {
      this.stopAggregatePreview(sessionId);
    }
    for (const [runId] of this.servers) {
      this.stopDevServer(runId);
    }
  }
}

export const globalDevServerManager = new DevServerManager();
