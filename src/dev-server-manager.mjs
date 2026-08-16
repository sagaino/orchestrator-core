import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { getRun } from "./run-manager.mjs";

const execFileAsync = promisify(execFile);

export function findWorkspacePath(runsRoot, runId) {
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
  const workspacePath = findWorkspacePath(runsRoot, runId);
  if (!workspacePath) {
    const run = getRun(runsRoot, runId);
    return {
      runId,
      workspaceExists: false,
      rawDiff: "",
      files: [],
      message: "Isolated worktree tidak aktif atau telah dibersihkan setelah accept/reject.",
    };
  }

  try {
    // Run git diff in workspace
    const { stdout: diffStdout } = await execFileAsync("git", ["diff", "HEAD~1"], {
      cwd: workspacePath,
      encoding: "utf8",
    }).catch(async () => {
      return await execFileAsync("git", ["diff", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
      }).catch(async () => {
        return await execFileAsync("git", ["diff"], {
          cwd: workspacePath,
          encoding: "utf8",
        });
      });
    });

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
  }

  async startDevServer({ runsRoot, runId }) {
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

    const workspacePath = findWorkspacePath(runsRoot, runId);
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

    const child = spawn("npm", ["run", "dev", "--", "--port", String(port), "--host", "127.0.0.1"], {
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
      url: `http://127.0.0.1:${port}`,
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
    serverEntry.status = "RUNNING";

    return {
      runId,
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

  stopAll() {
    for (const [runId] of this.servers) {
      this.stopDevServer(runId);
    }
  }
}

export const globalDevServerManager = new DevServerManager();
