import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadyTaskEvent } from "./adapters/vault-task-watcher.mjs";
import { runtimeOwnerAlive, withDurableLease } from "./durable-runtime.mjs";
import { redactSensitive } from "./redaction.mjs";
import { injectFault } from "./fault-injection.mjs";
import { normalizeVisualFeedback } from "./visual-revision.mjs";

export const RUN_STATES = Object.freeze({
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  CLAIMING: "CLAIMING",
  CLAIMED: "CLAIMED",
  RUNNING: "RUNNING",
  VERIFYING: "VERIFYING",
  REVIEW: "REVIEW",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  FAILED: "FAILED",
  RETROSPECTIVE: "RETROSPECTIVE",
  KNOWLEDGE_APPROVAL: "KNOWLEDGE_APPROVAL",
  WIKI_SYNCED: "WIKI_SYNCED",
  DONE: "DONE",
  SUPERSEDED: "SUPERSEDED",
});

const ACTIVE_RUN_STATES = new Set([
  RUN_STATES.PENDING_APPROVAL,
  RUN_STATES.APPROVED,
  RUN_STATES.CLAIMING,
  RUN_STATES.CLAIMED,
  RUN_STATES.RUNNING,
  RUN_STATES.VERIFYING,
  RUN_STATES.REVIEW,
  RUN_STATES.CHANGES_REQUESTED,
  RUN_STATES.RETROSPECTIVE,
  RUN_STATES.KNOWLEDGE_APPROVAL,
  RUN_STATES.WIKI_SYNCED,
]);

const SUPERSEDEABLE_RUN_STATES = new Set([
  RUN_STATES.PENDING_APPROVAL,
  RUN_STATES.APPROVED,
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  [RUN_STATES.CLAIMING]: [RUN_STATES.CLAIMED, RUN_STATES.FAILED],
  [RUN_STATES.CLAIMED]: [RUN_STATES.RUNNING, RUN_STATES.FAILED],
  [RUN_STATES.RUNNING]: [RUN_STATES.VERIFYING, RUN_STATES.FAILED],
  [RUN_STATES.VERIFYING]: [RUN_STATES.REVIEW, RUN_STATES.FAILED],
  [RUN_STATES.REVIEW]: [RUN_STATES.RETROSPECTIVE, RUN_STATES.CHANGES_REQUESTED, RUN_STATES.FAILED],
  [RUN_STATES.CHANGES_REQUESTED]: [RUN_STATES.RUNNING, RUN_STATES.FAILED],
  [RUN_STATES.RETROSPECTIVE]: [RUN_STATES.KNOWLEDGE_APPROVAL, RUN_STATES.CHANGES_REQUESTED, RUN_STATES.FAILED],
  [RUN_STATES.KNOWLEDGE_APPROVAL]: [RUN_STATES.WIKI_SYNCED],
  [RUN_STATES.WIKI_SYNCED]: [RUN_STATES.DONE],
  [RUN_STATES.FAILED]: [RUN_STATES.VERIFYING],
});

function ensureRunsRoot(runsRoot) {
  fs.mkdirSync(runsRoot, { recursive: true });
}

function safeRunId(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`Run ID tidak valid: ${runId}`);
  }
  return runId;
}

function manifestPath(runsRoot, runId) {
  return path.join(runsRoot, `${safeRunId(runId)}.json`);
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function createRunId(event, now) {
  const taskId = String(event.task.id ?? path.basename(event.task.path, ".md"))
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${taskId}-${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`;
}

import { validateManifest } from "./schema.mjs";

function writeNewManifest(filePath, manifest) {
  manifest.revision = Number(manifest.revision ?? 0);
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Manifest schema invalid: ${validation.errors.join(", ")}`);
  }
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(redactSensitive(manifest), null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeManifestAtomic(filePath, manifest) {
  return withDurableLease({
    runsRoot: path.dirname(filePath),
    namespace: "manifest-mutations",
    key: path.basename(filePath, ".json"),
    purpose: `manifest mutation ${path.basename(filePath)}`,
    ttlMs: 60_000,
    waitTimeoutMs: 2_000,
  }, () => {
    const expectedRevision = Number(manifest.revision ?? 0);
    let currentRevision = 0;
    if (fs.existsSync(filePath)) {
      try { currentRevision = Number(JSON.parse(fs.readFileSync(filePath, "utf8")).revision ?? 0); }
      catch {}
    }
    if (currentRevision !== expectedRevision) {
      const error = new Error(`Concurrent manifest update ditolak: expected revision ${expectedRevision}, current ${currentRevision}.`);
      error.code = "CONCURRENT_STATE_WRITE";
      throw error;
    }

    const next = { ...manifest, revision: expectedRevision + 1 };
    const validation = validateManifest(next);
    if (!validation.valid) {
      throw new Error(`Manifest schema invalid: ${validation.errors.join(", ")}`);
    }
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      injectFault("manifest.write.before-temp", { filePath, runId: next.runId, revision: next.revision });
      fs.writeFileSync(temporaryPath, `${JSON.stringify(redactSensitive(next), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      injectFault("manifest.write.before-rename", { filePath, runId: next.runId, revision: next.revision });
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
    try { fs.chmodSync(filePath, 0o600); } catch {}
    manifest.revision = next.revision;
    return manifest;
  });
}

export function captureVerificationScripts(repository, verificationCommands = []) {
  const packagePath = path.join(repository, "package.json");
  if (!fs.existsSync(packagePath)) return {};
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const scripts = pkg.scripts || {};
    const frozen = {};
    for (const cmd of verificationCommands) {
      const match = String(cmd).match(/^npm run ([A-Za-z0-9:_-]+)$/);
      if (match) {
        const scriptName = match[1];
        if (scripts[scriptName] !== undefined) {
          frozen[scriptName] = String(scripts[scriptName]);
        }
      }
    }
    return frozen;
  } catch {
    return {};
  }
}

function replaceFrontmatterField(content, field, value) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("Task tidak memiliki YAML frontmatter.");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) throw new Error("Frontmatter task tidak ditutup.");

  const fieldIndex = lines.findIndex(
    (line, index) => index > 0 && index < end && new RegExp(`^${field}\\s*:`).test(line),
  );
  if (fieldIndex === -1) lines.splice(end, 0, `${field}: ${value}`);
  else lines[fieldIndex] = `${field}: ${value}`;
  return lines.join("\n");
}

export function promoteTaskToReady({
  vaultRoot,
  projectId,
  taskInput,
  approvedBy = "user",
  services,
}) {
  const context = services.buildContext(vaultRoot, projectId, taskInput);
  const readiness = services.validateTaskReadiness(context, { readMarkdown: services.readMarkdown });
  if (!readiness.ready) {
    const blockers = readiness.blockers.map((item) => item.id).join(", ");
    throw new Error(`Task gagal readiness gate: ${blockers || "UNKNOWN"}. Jalankan validate-task untuk detail.`);
  }

  const currentStatus = String(context.task.metadata.status ?? "").toUpperCase();
  if (currentStatus === "READY") return context;
  if (currentStatus !== "BACKLOG") {
    throw new Error(`start-task hanya menerima task BACKLOG atau READY; status saat ini ${currentStatus || "UNKNOWN"}.`);
  }

  const reviewer = String(approvedBy).trim() || "user";
  const taskPath = path.join(vaultRoot, context.task.path);
  const at = new Date().toISOString();
  let content = fs.readFileSync(taskPath, "utf8");
  content = replaceFrontmatterField(content, "status", "READY");
  content = replaceFrontmatterField(content, "updated", at.slice(0, 10));

  const marker = "## Orchestrator Run Log";
  const entry = `- [${at}] Human \`${reviewer}\` memberi approval execution melalui \`start-task\`: \`BACKLOG → READY\`.`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;

  const temporaryPath = `${taskPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, taskPath);
  return services.buildContext(vaultRoot, projectId, taskPath);
}

export function resetFailedTaskToBacklog({ vaultRoot, manifest, retriedBy = "user", reason }) {
  if (manifest.state !== RUN_STATES.FAILED) {
    throw new Error(`Retry membutuhkan run FAILED; state saat ini ${manifest.state}.`);
  }
  const taskPath = path.join(vaultRoot, manifest.task.path);
  let content = fs.readFileSync(taskPath, "utf8");
  const currentStatus = content.match(/^status:\s*([^\s#]+)/m)?.[1]?.toUpperCase();
  if (currentStatus !== "FAILED") {
    throw new Error(`Retry membutuhkan task FAILED; status saat ini ${currentStatus ?? "UNKNOWN"}.`);
  }

  const at = new Date().toISOString();
  content = replaceFrontmatterField(content, "status", "BACKLOG");
  content = replaceFrontmatterField(content, "updated", at.slice(0, 10));
  const marker = "## Orchestrator Run Log";
  const entry = `- [${at}] Human \`${String(retriedBy).trim() || "user"}\` meminta retry setelah run \`${manifest.runId}\`: ${String(reason).trim()}`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;
  const temporaryPath = `${taskPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, taskPath);
  return { taskPath, status: "BACKLOG", updatedAt: at };
}

export function resetOrchestrationTaskToBacklog({
  vaultRoot,
  task,
  failedJobId = null,
  retriedBy = "user",
  reason,
  now = new Date(),
}) {
  if (!vaultRoot || !task?.path) {
    throw new Error("Retry orchestration membutuhkan vault root dan materialized task path.");
  }
  const taskPath = path.join(vaultRoot, task.path);
  let content = fs.readFileSync(taskPath, "utf8");
  const currentStatus = content.match(/^status:\s*([^\s#]+)/m)?.[1]?.toUpperCase();
  if (currentStatus === "BACKLOG") {
    return { taskPath, status: "BACKLOG", updatedAt: null, alreadyReset: true };
  }
  if (currentStatus !== "FAILED") {
    throw new Error(`Retry orchestration membutuhkan task FAILED; status saat ini ${currentStatus ?? "UNKNOWN"}.`);
  }

  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const actor = String(retriedBy).trim() || "user";
  const retryReason = String(reason ?? "").trim() || "Retry node orchestration setelah human review.";
  const jobReference = failedJobId ? ` setelah job \`${failedJobId}\`` : "";
  content = replaceFrontmatterField(content, "status", "BACKLOG");
  content = replaceFrontmatterField(content, "updated", at.slice(0, 10));
  const marker = "## Orchestrator Run Log";
  const entry = `- [${at}] Human \`${actor}\` meminta retry node orchestration${jobReference}: \`FAILED → BACKLOG\`. ${retryReason}`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;
  const temporaryPath = `${taskPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, taskPath);
  return { taskPath, status: "BACKLOG", updatedAt: at, alreadyReset: false };
}

function updateTaskForClaim(filePath, manifest, claimedAt) {
  let content = fs.readFileSync(filePath, "utf8");
  content = replaceFrontmatterField(content, "status", "IN_PROGRESS");
  content = replaceFrontmatterField(content, "updated", claimedAt.slice(0, 10));

  const marker = "## Orchestrator Run Log";
  const entry = `- [${claimedAt}] Run \`${manifest.runId}\` melakukan atomic claim: \`READY → IN_PROGRESS\`.`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function updateTaskForRecovery(filePath, manifest, recoveredBy, recoveredAt) {
  let content = fs.readFileSync(filePath, "utf8");
  const currentStatus = content.match(/^status:\s*([^\s#]+)/m)?.[1]?.toUpperCase();
  if (currentStatus !== "FAILED") {
    throw new Error(`Recovery membutuhkan task FAILED; status saat ini ${currentStatus ?? "UNKNOWN"}.`);
  }

  content = replaceFrontmatterField(content, "status", "IN_PROGRESS");
  content = replaceFrontmatterField(content, "updated", recoveredAt.slice(0, 10));
  const marker = "## Orchestrator Run Log";
  const entry = `- [${recoveredAt}] Human \`${recoveredBy}\` meminta recovery run \`${manifest.runId}\`: \`FAILED → IN_PROGRESS\` tanpa mengulang coding agent.`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function updateTaskForRequestedChanges(filePath, manifest, requestedBy, reason, requestedAt) {
  let content = fs.readFileSync(filePath, "utf8");
  const currentStatus = content.match(/^status:\s*([^\s#]+)/m)?.[1]?.toUpperCase();
  if (currentStatus !== "REVIEW") {
    throw new Error(`Request changes membutuhkan task REVIEW; status saat ini ${currentStatus ?? "UNKNOWN"}.`);
  }

  content = replaceFrontmatterField(content, "status", "IN_PROGRESS");
  content = replaceFrontmatterField(content, "updated", requestedAt.slice(0, 10));
  const marker = "## Orchestrator Run Log";
  const entry = `- [${requestedAt}] Human \`${requestedBy}\` meminta revisi run \`${manifest.runId}\`: ${reason}`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function updateTaskForTerminalState(filePath, manifest, status, message, at) {
  let content = fs.readFileSync(filePath, "utf8");
  const currentStatus = content.match(/^status:\s*([^\s#]+)/m)?.[1]?.toUpperCase();
  const acceptedCurrentStates = status === "FAILED" ? ["IN_PROGRESS", "REVIEW"] : ["IN_PROGRESS"];
  if (!acceptedCurrentStates.includes(currentStatus)) {
    throw new Error(`Task harus ${acceptedCurrentStates.join(" atau ")} sebelum menjadi ${status}; status saat ini ${currentStatus ?? "UNKNOWN"}.`);
  }

  content = replaceFrontmatterField(content, "status", status);
  content = replaceFrontmatterField(content, "updated", at.slice(0, 10));
  const marker = "## Orchestrator Run Log";
  const entry = `- [${at}] Run \`${manifest.runId}\`: ${message}`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function updateTaskForDone(filePath, manifest, message, at) {
  let content = fs.readFileSync(filePath, "utf8");
  const currentStatus = content.match(/^status:\s*([^\s#]+)/m)?.[1]?.toUpperCase();
  if (currentStatus !== "REVIEW") {
    throw new Error(`Task harus REVIEW sebelum menjadi DONE; status saat ini ${currentStatus ?? "UNKNOWN"}.`);
  }

  content = replaceFrontmatterField(content, "status", "DONE");
  content = replaceFrontmatterField(content, "updated", at.slice(0, 10));
  const marker = "## Orchestrator Run Log";
  const entry = `- [${at}] Run \`${manifest.runId}\`: ${message}`;
  content = content.includes(marker)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;

  const watermark = "🚀 [VERIFIED_BY_LLM_WIKI_SCHEMA]";
  const lines = content.split("\n").filter((line) => line.trim() !== watermark);
  let logHeading = lines.findIndex((line) => /^##\s+.*Log Perubahan.*$/i.test(line.trim()));
  if (logHeading === -1) {
    lines.push("", "## Log Perubahan");
    logHeading = lines.length - 1;
  }
  lines.splice(logHeading + 1, 0, watermark);
  content = lines.join("\n");

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function lockKey(manifest) {
  return `${manifest.project.id}-${manifest.task.id ?? path.basename(manifest.task.path, ".md")}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .toLowerCase();
}

function acquireClaimLock(runsRoot, manifest) {
  const locksRoot = path.join(runsRoot, "locks");
  fs.mkdirSync(locksRoot, { recursive: true });
  const filePath = path.join(locksRoot, `${lockKey(manifest)}.lock`);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      let isStale = false;
      try {
        const lockData = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (lockData?.pid) {
          try {
            process.kill(lockData.pid, 0);
          } catch {
            isStale = true;
          }
        }
      } catch {
        isStale = true;
      }

      if (isStale) {
        fs.unlinkSync(filePath);
        descriptor = fs.openSync(filePath, "wx");
      } else {
        const owner = fs.readFileSync(filePath, "utf8").trim();
        throw new Error(`Task sudah memiliki claim lock: ${owner || filePath}`);
      }
    } else {
      throw error;
    }
  }

  const lock = {
    runId: manifest.runId,
    project: manifest.project.id,
    task: manifest.task.id,
    taskPath: manifest.task.path,
    acquiredAt: new Date().toISOString(),
    pid: process.pid,
  };
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  return { filePath, lock };
}

function releaseClaimLock(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function getRun(runsRoot, runId) {
  const filePath = manifestPath(runsRoot, runId);
  if (!fs.existsSync(filePath)) throw new Error(`Run manifest tidak ditemukan: ${runId}`);
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  manifest.revision = Number(manifest.revision ?? 0);
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Corrupted run manifest ${runId}: ${validation.errors.join(", ")}`);
  }
  return manifest;
}

export function listRuns(runsRoot) {
  if (!fs.existsSync(runsRoot)) return [];
  const runs = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const run = JSON.parse(fs.readFileSync(path.join(runsRoot, entry.name), "utf8"));
      if (validateManifest(run).valid) {
        runs.push(run);
      }
    } catch {}
  }
  return runs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export function reconcileInterruptedRuns({ vaultRoot, runsRoot }) {
  const reconciled = [];
  const interruptedStates = new Set([
    RUN_STATES.CLAIMING,
    RUN_STATES.CLAIMED,
    RUN_STATES.RUNNING,
    RUN_STATES.VERIFYING,
    RUN_STATES.CHANGES_REQUESTED,
  ]);

  for (const listed of listRuns(runsRoot)) {
    if (!interruptedStates.has(listed.state)) continue;
    const owner = listed.execution?.runtimeOwner;
    if (owner && runtimeOwnerAlive(owner)) {
      reconciled.push({ runId: listed.runId, fromState: listed.state, toState: listed.state, action: "ACTIVE_OWNER_PRESERVED" });
      continue;
    }

    if (listed.state === RUN_STATES.CLAIMED) {
      const manifest = getRun(runsRoot, listed.runId);
      if (manifest.execution?.restartRecovery?.action !== "SAFE_TO_RESUME_BEFORE_AGENT") {
        const at = new Date().toISOString();
        manifest.updatedAt = at;
        manifest.execution = {
          ...manifest.execution,
          restartRecovery: {
            action: "SAFE_TO_RESUME_BEFORE_AGENT",
            recoveredAt: at,
            previousState: RUN_STATES.CLAIMED,
          },
        };
        manifest.history.push({
          at,
          event: "RESTART_SAFE_TO_RESUME",
          state: RUN_STATES.CLAIMED,
          message: "Runtime restart terjadi sebelum agent dipanggil; run aman dilanjutkan.",
        });
        writeManifestAtomic(manifestPath(runsRoot, manifest.runId), manifest);
      }
      reconciled.push({
        runId: listed.runId,
        fromState: listed.state,
        toState: listed.state,
        action: "SAFE_TO_RESUME_BEFORE_AGENT",
      });
      continue;
    }

    if (listed.state === RUN_STATES.CLAIMING) {
      const manifest = getRun(runsRoot, listed.runId);
      const taskPath = path.join(vaultRoot, manifest.task.path);
      const content = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, "utf8") : "";
      const taskStatus = content.match(/^status:\s*([^\s#]+)/m)?.[1]?.toUpperCase() ?? null;
      const at = new Date().toISOString();
      const fromState = manifest.state;
      if (taskStatus === "READY") {
        manifest.state = RUN_STATES.APPROVED;
        manifest.updatedAt = at;
        manifest.execution = {
          ...manifest.execution,
          claimedAt: null,
          restartRecovery: { action: "CLAIM_ROLLED_BACK", recoveredAt: at, previousState: fromState },
        };
        const lock = manifest.execution.lock;
        delete manifest.execution.lock;
        manifest.history.push({ at, event: "RESTART_CLAIM_ROLLED_BACK", state: RUN_STATES.APPROVED });
        writeManifestAtomic(manifestPath(runsRoot, manifest.runId), manifest);
        if (lock) releaseClaimLock(path.join(runsRoot, lock));
        reconciled.push({ runId: manifest.runId, fromState, toState: manifest.state, action: "CLAIM_ROLLED_BACK" });
        continue;
      }
      if (taskStatus === "IN_PROGRESS") {
        manifest.state = RUN_STATES.CLAIMED;
        manifest.task = { ...manifest.task, status: "IN_PROGRESS" };
        manifest.updatedAt = at;
        manifest.execution = {
          ...manifest.execution,
          restartRecovery: { action: "CLAIM_COMPLETED", recoveredAt: at, previousState: fromState },
        };
        manifest.history.push({ at, event: "RESTART_CLAIM_COMPLETED", state: RUN_STATES.CLAIMED });
        writeManifestAtomic(manifestPath(runsRoot, manifest.runId), manifest);
        reconciled.push({ runId: manifest.runId, fromState, toState: manifest.state, action: "CLAIM_COMPLETED" });
        continue;
      }
    }

    const fromState = listed.state;
    const message = `Runtime restart terdeteksi saat ${fromState}; eksekusi tidak diulang otomatis karena hasil invocation belum pasti.`;
    let failed;
    try {
      failed = transitionRun({
        vaultRoot,
        runsRoot,
        runId: listed.runId,
        toState: RUN_STATES.FAILED,
        executionPatch: {
          restartRecovery: {
            action: "MANUAL_RECOVERY_REQUIRED",
            recoveredAt: new Date().toISOString(),
            previousState: fromState,
          },
          result: { status: "FAILED", error: message },
        },
        message,
      });
    } catch (error) {
      const manifest = getRun(runsRoot, listed.runId);
      const at = new Date().toISOString();
      manifest.state = RUN_STATES.FAILED;
      manifest.updatedAt = at;
      manifest.execution = {
        ...manifest.execution,
        finishedAt: at,
        restartRecovery: {
          action: "MANUAL_RECOVERY_REQUIRED",
          recoveredAt: at,
          previousState: fromState,
          taskSyncError: error.message,
        },
        result: { status: "FAILED", error: message },
      };
      manifest.history.push({ at, event: "RESTART_INTERRUPTION_FAILED_SAFE", state: RUN_STATES.FAILED, message });
      writeManifestAtomic(manifestPath(runsRoot, manifest.runId), manifest);
      if (manifest.execution.lock) releaseClaimLock(path.join(runsRoot, manifest.execution.lock));
      failed = manifest;
    }
    reconciled.push({ runId: failed.runId, fromState, toState: failed.state, action: "MANUAL_RECOVERY_REQUIRED" });
  }
  return reconciled;
}

export function prepareRunFromEvent({ runsRoot, event, origin = "watcher-daemon" }) {
  ensureRunsRoot(runsRoot);
  if (event?.event !== "TASK_READY" || !event?.task?.path || !event?.fingerprint) {
    throw new Error("Auto-prepare membutuhkan event TASK_READY yang valid.");
  }

  const existingRuns = listRuns(runsRoot).filter((run) => (
    run.project?.id === event.project?.id
    && run.task?.path === event.task.path
    && ACTIVE_RUN_STATES.has(run.state)
  ));
  const duplicate = existingRuns.find((run) => run.taskFingerprint === event.fingerprint);
  if (duplicate) {
    return {
      created: false,
      deduplicated: true,
      reason: "ACTIVE_RUN_WITH_SAME_FINGERPRINT",
      manifest: duplicate,
    };
  }

  const blocking = existingRuns.filter((run) => !SUPERSEDEABLE_RUN_STATES.has(run.state));
  if (blocking.length) {
    throw new Error(`Task memiliki active run yang tidak dapat diganti: ${blocking.map((run) => `${run.runId}:${run.state}`).join(", ")}.`);
  }

  const supersededRunIds = [];
  for (const stale of existingRuns) {
    const at = new Date().toISOString();
    stale.state = RUN_STATES.SUPERSEDED;
    stale.updatedAt = at;
    stale.history.push({
      at,
      event: "RUN_SUPERSEDED",
      state: RUN_STATES.SUPERSEDED,
      message: `Task fingerprint berubah; digantikan event ${event.eventId}.`,
    });
    writeManifestAtomic(manifestPath(runsRoot, stale.runId), stale);
    supersededRunIds.push(stale.runId);
  }

  const now = new Date();
  const runId = createRunId(event, now);
  const manifest = {
    schemaVersion: 1,
    revision: 0,
    runId,
    state: RUN_STATES.PENDING_APPROVAL,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    approval: null,
    preparation: {
      origin,
      eventId: event.eventId,
      observedAt: event.observedAt,
      supersededRunIds,
    },
    task: event.task,
    project: event.project,
    taskFingerprint: event.fingerprint,
    graph: event.graph,
    retrieval: event.retrieval,
    plan: event.plan,
    execution: {
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      result: null,
    },
    history: [
      {
        at: now.toISOString(),
        event: "RUN_PREPARED",
        state: RUN_STATES.PENDING_APPROVAL,
      },
    ],
    guardrails: [
      "Manifest tidak memberi izin menulis ke task atau repository sebelum approval eksplisit.",
      "Task fingerprint harus divalidasi ulang sebelum atomic claim.",
      "Hanya satu executor boleh memiliki transisi READY ke IN_PROGRESS.",
    ],
  };

  writeNewManifest(manifestPath(runsRoot, runId), manifest);
  return {
    created: true,
    deduplicated: false,
    reason: null,
    manifest,
  };
}

export function prepareRun({ vaultRoot, runsRoot, projectId, taskInput, services }) {
  ensureRunsRoot(runsRoot);
  const taskPath = path.isAbsolute(taskInput)
    ? taskInput
    : path.join(vaultRoot, "02-Projects", projectId, "tasks", taskInput.endsWith(".md") ? taskInput : `${taskInput}.md`);

  let event = null;
  if (fs.existsSync(taskPath)) {
    event = createReadyTaskEvent(vaultRoot, taskPath, services);
  } else {
    const context = services.buildContext(vaultRoot, projectId, taskInput);
    event = createReadyTaskEvent(vaultRoot, path.join(vaultRoot, context.task.path), services);
  }

  if (!event) {
    throw new Error(`Run hanya dapat disiapkan untuk task berstatus READY: ${taskInput}`);
  }

  return prepareRunFromEvent({ runsRoot, event, origin: "manual-cli" }).manifest;
}

export function approveRun({ runsRoot, runId, approvedBy = "user" }) {
  const approver = String(approvedBy).trim();
  if (!approver) throw new Error("approvedBy tidak boleh kosong.");

  const filePath = manifestPath(runsRoot, runId);
  const manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.APPROVED) return manifest;
  if (manifest.state !== RUN_STATES.PENDING_APPROVAL) {
    throw new Error(`Run ${runId} tidak dapat disetujui dari state ${manifest.state}.`);
  }

  const now = new Date().toISOString();
  manifest.state = RUN_STATES.APPROVED;
  manifest.updatedAt = now;
  manifest.approval = {
    approvedAt: now,
    approvedBy: approver,
    scope: "EXECUTE_TASK",
  };
  manifest.history.push({
    at: now,
    event: "RUN_APPROVED",
    state: RUN_STATES.APPROVED,
    approvedBy: approver,
  });
  writeManifestAtomic(filePath, manifest);
  return manifest;
}

export function claimRun({ vaultRoot, runsRoot, runId, services }) {
  const filePath = manifestPath(runsRoot, runId);
  const manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.CLAIMED) return manifest;
  if (manifest.state !== RUN_STATES.APPROVED) {
    throw new Error(`Run ${runId} tidak dapat di-claim dari state ${manifest.state}.`);
  }

  const taskPath = path.join(vaultRoot, manifest.task.path);
  const validateCurrentTask = () => {
    const event = createReadyTaskEvent(vaultRoot, taskPath, services);
    if (!event) throw new Error(`Task tidak lagi berstatus READY: ${manifest.task.path}`);
    if (event.fingerprint !== manifest.taskFingerprint) {
      throw new Error(`Fingerprint task berubah setelah prepare. Buat run manifest baru untuk ${manifest.task.path}.`);
    }
    return event;
  };

  validateCurrentTask();
  const claim = acquireClaimLock(runsRoot, manifest);
  let taskUpdated = false;
  try {
    validateCurrentTask();
    const frozenVerificationScripts = captureVerificationScripts(
      manifest.project.repository,
      manifest.plan?.verificationCommands ?? [],
    );
    const claimingAt = new Date().toISOString();
    manifest.state = RUN_STATES.CLAIMING;
    manifest.updatedAt = claimingAt;
    manifest.execution.claimedAt = claimingAt;
    manifest.execution.frozenVerificationScripts = frozenVerificationScripts;
    manifest.execution.lock = path.relative(runsRoot, claim.filePath);
    manifest.history.push({
      at: claimingAt,
      event: "ATOMIC_CLAIM_STARTED",
      state: RUN_STATES.CLAIMING,
    });
    writeManifestAtomic(filePath, manifest);

    updateTaskForClaim(taskPath, manifest, claimingAt);
    taskUpdated = true;

    const claimedAt = new Date().toISOString();
    manifest.state = RUN_STATES.CLAIMED;
    manifest.task = { ...manifest.task, status: "IN_PROGRESS" };
    manifest.updatedAt = claimedAt;
    manifest.history.push({
      at: claimedAt,
      event: "TASK_CLAIMED",
      state: RUN_STATES.CLAIMED,
      taskStatus: "IN_PROGRESS",
    });
    writeManifestAtomic(filePath, manifest);

    for (const other of listRuns(runsRoot)) {
      const matchProject = other.project?.id?.toLowerCase() === manifest.project?.id?.toLowerCase();
      const matchTask = (other.task?.id && other.task.id.toLowerCase() === manifest.task?.id?.toLowerCase()) ||
        (other.task?.path && other.task.path.toLowerCase() === manifest.task?.path?.toLowerCase());
      if (
        other.runId !== manifest.runId &&
        matchProject &&
        matchTask &&
        SUPERSEDEABLE_RUN_STATES.has(other.state)
      ) {
        const at = new Date().toISOString();
        other.state = RUN_STATES.SUPERSEDED;
        other.updatedAt = at;
        other.history.push({
          at,
          event: "RUN_SUPERSEDED",
          state: RUN_STATES.SUPERSEDED,
          message: `Task telah diklaim oleh run ${manifest.runId}.`,
        });
        writeManifestAtomic(manifestPath(runsRoot, other.runId), other);
      }
    }

    return manifest;
  } catch (error) {
    if (!taskUpdated) {
      const failedAt = new Date().toISOString();
      manifest.state = RUN_STATES.APPROVED;
      manifest.updatedAt = failedAt;
      manifest.execution.claimedAt = null;
      delete manifest.execution.lock;
      manifest.history.push({
        at: failedAt,
        event: "ATOMIC_CLAIM_REJECTED",
        state: RUN_STATES.APPROVED,
        reason: error.message,
      });
      writeManifestAtomic(filePath, manifest);
      releaseClaimLock(claim.filePath);
    }
    throw error;
  }
}

export function beginFailedRunRecovery({
  vaultRoot,
  runsRoot,
  runId,
  recoveredBy = "user",
}) {
  const filePath = manifestPath(runsRoot, runId);
  const manifest = getRun(runsRoot, runId);
  if (manifest.state !== RUN_STATES.FAILED) {
    throw new Error(`Recovery hanya dapat dimulai dari run FAILED; state ${manifest.state}.`);
  }

  const reviewer = String(recoveredBy).trim() || "user";
  const previousError = String(manifest.execution?.result?.error ?? "Unknown failure");
  const manifestBackup = JSON.stringify(manifest);
  const taskFilePath = path.join(vaultRoot, manifest.task.path);
  const taskFileBackup = fs.existsSync(taskFilePath) ? fs.readFileSync(taskFilePath, "utf8") : null;
  const claim = acquireClaimLock(runsRoot, manifest);
  let taskUpdated = false;
  let manifestWritten = false;
  try {
    const recoveredAt = new Date().toISOString();
    updateTaskForRecovery(
      taskFilePath,
      manifest,
      reviewer,
      recoveredAt,
    );
    taskUpdated = true;

    const previousRecovery = manifest.execution?.recovery ?? {};
    manifest.state = RUN_STATES.VERIFYING;
    manifest.task = { ...manifest.task, status: "IN_PROGRESS" };
    manifest.updatedAt = recoveredAt;
    manifest.execution = {
      ...manifest.execution,
      finishedAt: null,
      lock: path.relative(runsRoot, claim.filePath),
      verification: [],
      graphify: null,
      result: { status: "RECOVERING", previousError },
      recovery: {
        ...previousRecovery,
        attempt: Number(previousRecovery.attempt ?? 0) + 1,
        startedAt: recoveredAt,
        recoveredBy: reviewer,
        previousError,
        status: "RUNNING",
      },
    };
    manifest.history.push({
      at: recoveredAt,
      event: "RECOVERY_STARTED",
      state: RUN_STATES.VERIFYING,
      recoveredBy: reviewer,
      previousError,
    });
    writeManifestAtomic(filePath, manifest);
    manifestWritten = true;
    return manifest;
  } catch (error) {
    if (taskUpdated && taskFileBackup !== null) {
      try { fs.writeFileSync(taskFilePath, taskFileBackup, "utf8"); } catch {}
    }
    if (manifestWritten) {
      try { fs.writeFileSync(filePath, `${manifestBackup}\n`, "utf8"); } catch {}
    }
    releaseClaimLock(claim.filePath);
    throw error;
  }
}

export function beginReviewRevision({
  vaultRoot,
  runsRoot,
  runId,
  requestedBy = "user",
  reason,
  visualFeedback = null,
}) {
  const filePath = manifestPath(runsRoot, runId);
  const manifest = getRun(runsRoot, runId);
  if (![RUN_STATES.REVIEW, RUN_STATES.RETROSPECTIVE].includes(manifest.state)) {
    throw new Error(`Request changes membutuhkan run REVIEW atau RETROSPECTIVE; state ${manifest.state}.`);
  }
  const workspace = manifest.execution?.workspace;
  if (!workspace?.path || !fs.existsSync(workspace.path) || ["CLEANED", "DISCARDED"].includes(workspace.state)) {
    throw new Error("Request changes membutuhkan isolated worktree review yang masih aktif.");
  }

  const reviewer = String(requestedBy).trim() || "user";
  const revisionReason = String(reason ?? "").trim();
  if (!revisionReason) throw new Error("Request changes membutuhkan --reason yang jelas.");
  const normalizedVisualFeedback = visualFeedback ? normalizeVisualFeedback(visualFeedback) : null;

  const manifestBackup = JSON.stringify(manifest);
  const taskFilePath = path.join(vaultRoot, manifest.task.path);
  const taskFileBackup = fs.existsSync(taskFilePath) ? fs.readFileSync(taskFilePath, "utf8") : null;
  const claim = acquireClaimLock(runsRoot, manifest);
  let taskUpdated = false;
  let manifestWritten = false;
  try {
    const requestedAt = new Date().toISOString();
    updateTaskForRequestedChanges(
      taskFilePath,
      manifest,
      reviewer,
      revisionReason,
      requestedAt,
    );
    taskUpdated = true;

    const existing = Array.isArray(manifest.execution?.reviewChanges)
      ? manifest.execution.reviewChanges
      : [];
    const iteration = existing.length + 1;
    manifest.state = RUN_STATES.CHANGES_REQUESTED;
    manifest.task = { ...manifest.task, status: "IN_PROGRESS" };
    manifest.updatedAt = requestedAt;
    manifest.execution = {
      ...manifest.execution,
      finishedAt: null,
      lock: path.relative(runsRoot, claim.filePath),
      verification: [],
      graphify: null,
      result: { status: "REVISION_REQUESTED" },
      reviewChanges: [
        ...existing,
        {
          iteration,
          requestedAt,
          requestedBy: reviewer,
          reason: revisionReason,
          visualFeedback: normalizedVisualFeedback ? {
            iteration,
            beforeEvidenceIds: normalizedVisualFeedback.beforeEvidenceIds,
            visualAnnotations: normalizedVisualFeedback.visualAnnotations,
            inlineComments: normalizedVisualFeedback.inlineComments,
          } : null,
          status: "RUNNING",
        },
      ],
    };
    manifest.knowledge = {
      ...(manifest.knowledge ?? {}),
      proposal: null,
      proposedAt: null,
      approval: null,
    };
    manifest.history.push({
      at: requestedAt,
      event: "REVIEW_CHANGES_REQUESTED",
      state: RUN_STATES.CHANGES_REQUESTED,
      requestedBy: reviewer,
      iteration,
      reason: revisionReason,
    });
    writeManifestAtomic(filePath, manifest);
    manifestWritten = true;
    return manifest;
  } catch (error) {
    if (taskUpdated && taskFileBackup !== null) {
      try { fs.writeFileSync(taskFilePath, taskFileBackup, "utf8"); } catch {}
    }
    if (manifestWritten) {
      try { fs.writeFileSync(filePath, `${manifestBackup}\n`, "utf8"); } catch {}
    }
    releaseClaimLock(claim.filePath);
    throw error;
  }
}

export function updateRunExecution({
  runsRoot,
  runId,
  executionPatch = {},
  event = "RUN_PROGRESS",
  message = null,
}) {
  const filePath = manifestPath(runsRoot, runId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const manifest = getRun(runsRoot, runId);
    const at = new Date().toISOString();
    manifest.updatedAt = at;
    manifest.execution = { ...manifest.execution, ...executionPatch };
    if (event) {
      manifest.history = Array.isArray(manifest.history) ? manifest.history : [];
      manifest.history.push({
        at,
        event,
        state: manifest.state,
        ...(message ? { message } : {}),
      });
    }
    try {
      writeManifestAtomic(filePath, manifest);
      return manifest;
    } catch (error) {
      if (error.code !== "CONCURRENT_STATE_WRITE" || attempt === 4) throw error;
    }
  }
  throw new Error(`Manifest ${runId} tidak dapat diperbarui setelah retry concurrency.`);
}

export function transitionRun({
  vaultRoot,
  runsRoot,
  runId,
  toState,
  executionPatch = {},
  knowledgePatch = {},
  completionPatch = {},
  message = null,
}) {
  const filePath = manifestPath(runsRoot, runId);
  const manifest = getRun(runsRoot, runId);
  if (manifest.state === toState) return manifest;

  const allowed = ALLOWED_TRANSITIONS[manifest.state] ?? [];
  if (!allowed.includes(toState)) {
    throw new Error(`Transisi run tidak valid: ${manifest.state} → ${toState}.`);
  }

  const at = new Date().toISOString();
  const terminalTaskStatus = toState === RUN_STATES.REVIEW
    ? "REVIEW"
    : toState === RUN_STATES.FAILED
      ? "FAILED"
      : null;

  if (toState === RUN_STATES.DONE) {
    const taskPath = path.join(vaultRoot, manifest.task.path);
    updateTaskForDone(taskPath, manifest, message ?? "human approval selesai; task ditutup sebagai DONE.", at);
  }

  if (terminalTaskStatus) {
    const taskPath = path.join(vaultRoot, manifest.task.path);
    updateTaskForTerminalState(
      taskPath,
      manifest,
      terminalTaskStatus,
      message ?? `status diubah menjadi ${terminalTaskStatus}.`,
      at,
    );
  }

  manifest.state = toState;
  if (terminalTaskStatus) manifest.task = { ...manifest.task, status: terminalTaskStatus };
  if (toState === RUN_STATES.DONE) manifest.task = { ...manifest.task, status: "DONE" };
  manifest.updatedAt = at;
  manifest.execution = { ...manifest.execution, ...executionPatch };
  manifest.knowledge = { ...(manifest.knowledge ?? {}), ...knowledgePatch };
  manifest.completion = { ...(manifest.completion ?? {}), ...completionPatch };
  if (toState === RUN_STATES.RUNNING) manifest.execution.startedAt = at;
  if (terminalTaskStatus) manifest.execution.finishedAt = at;
  const lifecycleEvent = {
    [RUN_STATES.RUNNING]: "RUN_STARTED",
    [RUN_STATES.VERIFYING]: "VERIFICATION_STARTED",
    [RUN_STATES.REVIEW]: "RUN_REVIEW",
    [RUN_STATES.CHANGES_REQUESTED]: "REVIEW_CHANGES_REQUESTED",
    [RUN_STATES.FAILED]: "RUN_FAILED",
    [RUN_STATES.RETROSPECTIVE]: "RETROSPECTIVE_PROPOSED",
    [RUN_STATES.KNOWLEDGE_APPROVAL]: "KNOWLEDGE_APPROVED",
    [RUN_STATES.WIKI_SYNCED]: "WIKI_SYNCED",
    [RUN_STATES.DONE]: "RUN_DONE",
  };
  manifest.history.push({
    at,
    event: lifecycleEvent[toState] ?? "RUN_TRANSITIONED",
    state: toState,
    ...(message ? { message } : {}),
  });
  writeManifestAtomic(filePath, manifest);

  if (terminalTaskStatus && manifest.execution.lock) {
    releaseClaimLock(path.join(runsRoot, manifest.execution.lock));
  }
  return manifest;
}

export function rejectReviewRun({
  vaultRoot,
  runsRoot,
  runId,
  rejectedBy = "user",
  reason = "Acceptance criteria belum terpenuhi.",
}) {
  const manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.FAILED) return manifest;
  if (![RUN_STATES.REVIEW, RUN_STATES.RETROSPECTIVE].includes(manifest.state)) {
    throw new Error(`Run ${runId} harus REVIEW atau RETROSPECTIVE sebelum ditolak; state ${manifest.state}.`);
  }
  const reviewer = String(rejectedBy).trim() || "user";
  const rejectionReason = String(reason).trim() || "Acceptance criteria belum terpenuhi.";
  return transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.FAILED,
    executionPatch: {
      result: { status: "FAILED", error: `Human review rejected: ${rejectionReason}` },
      review: {
        rejectedAt: new Date().toISOString(),
        rejectedBy: reviewer,
        reason: rejectionReason,
      },
    },
    message: `human review ditolak oleh ${reviewer}: ${rejectionReason}`,
  });
}
