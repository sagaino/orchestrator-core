import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import chokidar from "chokidar";

function requireServices(services) {
  if (!services?.readMarkdown || !services?.buildContext || !services?.buildPlan || !services?.validateTaskReadiness) {
    throw new Error("VaultTaskWatcher membutuhkan service readMarkdown, buildContext, buildPlan, dan validateTaskReadiness.");
  }
  return services;
}

function taskRoot(vaultRoot) {
  return path.join(vaultRoot, "02-Projects");
}

function isTaskFile(vaultRoot, filePath) {
  if (!filePath.endsWith(".md")) return false;
  const relative = path.relative(taskRoot(vaultRoot), filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments.includes("tasks") && !segments.includes("_templates");
}

function walkTaskFiles(vaultRoot, directory = taskRoot(vaultRoot)) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTaskFiles(vaultRoot, fullPath));
    else if (entry.isFile() && isTaskFile(vaultRoot, fullPath)) files.push(fullPath);
  }
  return files;
}

function fingerprintTask(document) {
  return createHash("sha256")
    .update(`${document.path}\n${JSON.stringify(document.metadata)}\n${document.body}`)
    .digest("hex")
    .slice(0, 20);
}

export class ReadyTaskDeduplicator {
  #fingerprints = new Map();

  accept(event) {
    const previous = this.#fingerprints.get(event.task.path);
    if (previous === event.fingerprint) return false;
    this.#fingerprints.set(event.task.path, event.fingerprint);
    return true;
  }
}

export function createReadyTaskEvent(vaultRoot, filePath, services) {
  const { readMarkdown, buildContext, buildPlan, validateTaskReadiness } = requireServices(services);
  if (!isTaskFile(vaultRoot, filePath)) return null;
  const document = readMarkdown(filePath, vaultRoot);
  if (!document) return null;

  const status = String(document.metadata.status ?? "").toUpperCase();
  if (status !== "READY") return null;

  const projectId = String(document.metadata.project ?? "").trim();
  if (!projectId) {
    throw new Error(`Task READY tidak memiliki field project: ${document.path}`);
  }

  const context = buildContext(vaultRoot, projectId, filePath);
  const readiness = validateTaskReadiness(context, { readMarkdown });
  if (!readiness.ready) {
    const blockerIds = readiness.blockers.map((item) => item.id).join(", ");
    throw new Error(`Task READY gagal readiness gate: ${blockerIds || "UNKNOWN"}. Jalankan validate-task untuk detail.`);
  }
  const plan = buildPlan(context);
  const fingerprint = fingerprintTask(document);

  return {
    schemaVersion: 1,
    event: "TASK_READY",
    eventId: `task-ready:${document.metadata.task_id ?? path.basename(filePath, ".md")}:${fingerprint}`,
    observedAt: new Date().toISOString(),
    mode: "observe-only",
    fingerprint,
    task: {
      id: document.metadata.task_id ?? null,
      title: document.title,
      path: document.path,
      project: projectId,
      status,
      allowedPaths: Array.isArray(document.metadata.allowed_paths)
        ? document.metadata.allowed_paths.map(String)
        : [],
      requiresChanges: document.metadata.requires_changes === true,
    },
    project: {
      id: context.project.id,
      repository: context.project.repository,
      agent: context.project.agent,
      graphify: context.project.graphify,
    },
    graph: context.project.graphSummary,
    retrieval: {
      knowledge: context.wiki.relevantKnowledge.map((item) => ({
        path: item.path,
        title: item.title,
        score: item.score,
      })),
    },
    plan: {
      steps: plan.steps,
      verificationCommands: plan.verificationCommands,
      approvalRequired: plan.approvalRequired,
      proposedWrites: plan.proposedWrites,
    },
    readiness: {
      gateVersion: readiness.gateVersion,
      verdict: readiness.verdict,
      summary: readiness.summary,
    },
    guardrail: "Event ini tidak mengubah task, Wiki, Graphify, atau repository project.",
  };
}

export function scanReadyTasks(vaultRoot, services) {
  const events = [];
  const errors = [];

  for (const filePath of walkTaskFiles(vaultRoot)) {
    try {
      const event = createReadyTaskEvent(vaultRoot, filePath, services);
      if (event) events.push(event);
    } catch (error) {
      errors.push({ filePath: path.relative(vaultRoot, filePath), error: error.message });
    }
  }

  return { events, errors };
}

export function watchReadyTasks({ vaultRoot, services, onEvent, onError = () => {}, ignoreInitial = false }) {
  requireServices(services);
  const root = taskRoot(vaultRoot);
  if (!fs.existsSync(root)) throw new Error(`Task root tidak ditemukan: ${root}`);

  const deduplicator = new ReadyTaskDeduplicator();
  const watcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const handleCandidate = (filePath) => {
    if (!isTaskFile(vaultRoot, filePath)) return;
    try {
      const event = createReadyTaskEvent(vaultRoot, filePath, services);
      if (event && deduplicator.accept(event)) onEvent(event);
    } catch (error) {
      onError({ filePath: path.relative(vaultRoot, filePath), error: error.message });
    }
  };

  watcher.on("add", handleCandidate);
  watcher.on("change", handleCandidate);
  watcher.on("error", (error) => onError({ filePath: null, error: error.message }));
  return watcher;
}
