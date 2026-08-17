import { executeRun, recoverRun, reviseRun, runProcess } from "./executor.mjs";
import { retrospectRun } from "./knowledge-workflow.mjs";
import {
  approveRun,
  beginReviewRevision,
  claimRun,
  getRun,
  prepareRun,
  promoteTaskToReady,
  rejectReviewRun,
  resetFailedTaskToBacklog,
  RUN_STATES,
  updateRunExecution,
} from "./run-manager.mjs";
import { enqueueTaskJob, JOB_STATES, updateJobForRun } from "./job-queue.mjs";
import fs from "node:fs";
import path from "node:path";
import { cleanupIsolatedWorkspace } from "./workspace-manager.mjs";
import { appendRunTelemetry } from "./telemetry.mjs";

export function cleanTerminalOutput(rawOutput) {
  if (!rawOutput || typeof rawOutput !== "string") return "";

  // Strip ANSI escape codes
  const cleanAnsi = rawOutput.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
  const lines = cleanAnsi.split(/\r?\n/);
  const filteredLines = [];
  let previousLine = null;
  let omittedNodeModulesCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Identify node_modules / internal runtime stack trace lines
    const isNodeModulesTrace =
      /\bat\s+.*[/\\]node_modules[/\\]/.test(line) ||
      /\bat\s+.*node:internal[/\\]/.test(line) ||
      (trimmed.startsWith("at ") && (line.includes("node_modules/") || line.includes("node_modules\\")));

    if (isNodeModulesTrace) {
      omittedNodeModulesCount++;
      continue;
    }

    if (omittedNodeModulesCount > 0) {
      filteredLines.push(`    [... ${omittedNodeModulesCount} node_modules stack trace lines omitted ...]`);
      omittedNodeModulesCount = 0;
    }

    // Deduplicate consecutive identical lines
    if (trimmed && trimmed === previousLine) {
      continue;
    }

    filteredLines.push(line);
    if (trimmed) {
      previousLine = trimmed;
    }
  }

  if (omittedNodeModulesCount > 0) {
    filteredLines.push(`    [... ${omittedNodeModulesCount} node_modules stack trace lines omitted ...]`);
  }

  return filteredLines.join("\n").trim();
}

export function cleanErrorTail(errorText, maxLength = 4000) {
  const cleaned = cleanTerminalOutput(errorText);
  return cleaned.length > maxLength ? cleaned.slice(-maxLength) : cleaned;
}

export async function startTaskRun({
  vaultRoot,
  runsRoot,
  projectId,
  taskInput,
  approvedBy = "user",
  services,
  executor = executeRun,
  retrospective = retrospectRun,
  initialTelemetry = null,
  onProgress = () => {},
}) {
  promoteTaskToReady({
    vaultRoot,
    projectId,
    taskInput,
    approvedBy,
    services,
  });

  let manifest = prepareRun({
    vaultRoot,
    runsRoot,
    projectId,
    taskInput,
    services,
  });
  if (initialTelemetry) {
    manifest = appendRunTelemetry({ runsRoot, runId: manifest.runId, record: initialTelemetry });
  }
  await onProgress(manifest);

  if (manifest.state === RUN_STATES.PENDING_APPROVAL) {
    manifest = approveRun({ runsRoot, runId: manifest.runId, approvedBy });
    await onProgress(manifest);
  }
  if (manifest.state === RUN_STATES.APPROVED) {
    manifest = claimRun({ vaultRoot, runsRoot, runId: manifest.runId, services });
    await onProgress(manifest);
  }
  if (manifest.state === RUN_STATES.CLAIMED) {
    manifest = await executor({ vaultRoot, runsRoot, runId: manifest.runId });
    await onProgress(manifest);
  }
  if (manifest.state === RUN_STATES.REVIEW) {
    manifest = await retrospective({ vaultRoot, runsRoot, runId: manifest.runId });
    await onProgress(manifest);
  }

  if (![RUN_STATES.RETROSPECTIVE, RUN_STATES.FAILED].includes(manifest.state)) {
    throw new Error(`start-task berhenti pada state yang tidak didukung: ${manifest.state}.`);
  }
  return manifest;
}

export async function recoverTaskRun({
  vaultRoot,
  runsRoot,
  runId,
  recoveredBy = "user",
  force = false,
  recoveryExecutor = recoverRun,
  retrospective = retrospectRun,
  onProgress = () => {},
}) {
  let manifest = await recoveryExecutor({
    vaultRoot,
    runsRoot,
    runId,
    recoveredBy,
    force,
  });
  await onProgress(manifest);
  if (manifest.state === RUN_STATES.REVIEW) {
    manifest = await retrospective({ vaultRoot, runsRoot, runId });
    await onProgress(manifest);
  }
  if (![RUN_STATES.RETROSPECTIVE, RUN_STATES.FAILED].includes(manifest.state)) {
    throw new Error(`recover berhenti pada state yang tidak didukung: ${manifest.state}.`);
  }
  const recovery = manifest.execution?.recovery ?? {};
  const verification = (manifest.execution?.verification ?? [])
    .map((item) => `${item.command}:${item.exitCode}`)
    .join(", ");
  const entry = [
    `## [${new Date().toISOString().slice(0, 10)}] task-recovery | ${manifest.task.id}`,
    `- Run \`${manifest.runId}\` dilanjutkan tanpa mengulang coding agent oleh \`${recovery.recoveredBy ?? recoveredBy}\`.`,
    `- Recovery status: \`${recovery.status ?? manifest.state}\`; verification: \`${verification || "none"}\`.`,
  ].join("\n");
  fs.appendFileSync(path.join(vaultRoot, "wiki-log.md"), `\n\n${entry}\n`, "utf8");
  return manifest;
}

export async function requestChangesTaskRun({
  vaultRoot,
  runsRoot,
  runId,
  requestedBy = "user",
  reason,
  revisionExecutor = reviseRun,
  retrospective = retrospectRun,
  onProgress = () => {},
}) {
  const cleanedReason = cleanTerminalOutput(reason);
  let manifest = beginReviewRevision({
    vaultRoot,
    runsRoot,
    runId,
    requestedBy,
    reason: cleanedReason || reason,
  });
  updateJobForRun(runsRoot, runId, {
    state: JOB_STATES.RUNNING,
    runState: manifest.state,
    error: null,
  });
  await onProgress(manifest);

  try {
    manifest = await revisionExecutor({ vaultRoot, runsRoot, runId });
    await onProgress(manifest);
    if (manifest.state === RUN_STATES.REVIEW) {
      manifest = await retrospective({ vaultRoot, runsRoot, runId });
      await onProgress(manifest);
    }
    if (manifest.state !== RUN_STATES.RETROSPECTIVE) {
      throw new Error(`request-changes berhenti pada state yang tidak didukung: ${manifest.state}.`);
    }
    updateJobForRun(runsRoot, runId, {
      state: JOB_STATES.REVIEW,
      runState: manifest.state,
      error: null,
    });
    const latest = manifest.execution?.reviewChanges?.at(-1);
    const entry = [
      `## [${new Date().toISOString().slice(0, 10)}] task-request-changes | ${manifest.task.id}`,
      `- Revision iteration \`${latest?.iteration ?? "unknown"}\` selesai dan kembali ke REVIEW.`,
      `- Requested by \`${String(requestedBy).trim() || "user"}\`; feedback: ${String(cleanedReason || reason).trim()}.`,
    ].join("\n");
    fs.appendFileSync(path.join(vaultRoot, "wiki-log.md"), `\n\n${entry}\n`, "utf8");
    return manifest;
  } catch (error) {
    const failed = getRun(runsRoot, runId);
    updateJobForRun(runsRoot, runId, {
      state: JOB_STATES.FAILED,
      runState: failed.state,
      error: failed.execution?.result?.error ?? error.message,
    });
    throw error;
  }
}

function appendRetryLog(vaultRoot, manifest, requestedBy, safeInfrastructureFailure) {
  const filePath = path.join(vaultRoot, "wiki-log.md");
  const entry = [
    `## [${new Date().toISOString().slice(0, 10)}] task-retry | ${manifest.task.id}`,
    `- Preserved failed run \`${manifest.runId}\` and queued a replacement job.`,
    `- Requested by \`${requestedBy}\`; safe infrastructure retry: \`${safeInfrastructureFailure}\`.`,
  ].join("\n");
  fs.appendFileSync(filePath, `\n\n${entry}\n`, "utf8");
}

async function discardWorkspace({ runsRoot, manifest }) {
  if (!manifest.execution?.workspace?.path) return manifest;
  const result = await cleanupIsolatedWorkspace({
    manifest,
    runsRoot,
    eventLogPath: path.join(runsRoot, "events", `${manifest.runId}.jsonl`),
    processRunner: runProcess,
    outcome: "DISCARDED",
  });
  if (!result.workspace) return manifest;
  return updateRunExecution({
    runsRoot,
    runId: manifest.runId,
    executionPatch: { workspace: result.workspace },
    event: "WORKSPACE_DISCARDED",
    message: "Isolated workspace dibuang tanpa menerapkan perubahan ke repository utama.",
  });
}

export async function rejectTaskRun({
  vaultRoot,
  runsRoot,
  runId,
  rejectedBy = "user",
  reason = "Acceptance criteria belum terpenuhi.",
}) {
  let manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.FAILED) return manifest;
  manifest = await discardWorkspace({ runsRoot, manifest });
  const cleanedReason = cleanTerminalOutput(reason);
  return rejectReviewRun({
    vaultRoot,
    runsRoot,
    runId,
    rejectedBy,
    reason: cleanedReason || reason,
  });
}

export async function retryTaskRun({
  vaultRoot,
  runsRoot,
  runId,
  requestedBy = "user",
  force = false,
}) {
  let manifest = getRun(runsRoot, runId);
  if (manifest.state !== RUN_STATES.FAILED) {
    throw new Error(`Retry hanya dapat dilakukan untuk run FAILED; state ${manifest.state}.`);
  }
  const rawError = String(manifest.execution?.result?.error ?? "Unknown failure");
  const error = cleanErrorTail(rawError);
  const safeInfrastructureFailure = /\bENOENT\b|executable.*not found|command not found/i.test(rawError)
    && !manifest.execution?.agent
    && !(manifest.execution?.scopeAudit?.changedPaths?.length > 0);
  if (!safeInfrastructureFailure && !force) {
    throw new Error("Retry otomatis ditolak karena failure mungkin terjadi setelah project berubah. Review worktree lalu gunakan --force jika aman.");
  }

  manifest = await discardWorkspace({ runsRoot, manifest });

  const reviewer = String(requestedBy).trim() || "user";
  const reset = resetFailedTaskToBacklog({
    vaultRoot,
    manifest,
    retriedBy: reviewer,
    reason: safeInfrastructureFailure ? `infrastructure failure diperbaiki (${error}).` : `force retry setelah human review (${error}).`,
  });
  const queued = enqueueTaskJob({
    runsRoot,
    projectId: manifest.project.id,
    taskId: manifest.task.id,
    taskPath: manifest.task.path,
    requestedBy: reviewer,
  });
  appendRetryLog(vaultRoot, manifest, reviewer, safeInfrastructureFailure);
  return {
    schemaVersion: 1,
    action: "TASK_REQUEUED",
    task: { id: manifest.task.id, path: manifest.task.path, status: reset.status },
    previousRun: { runId: manifest.runId, state: manifest.state, error },
    job: queued.job,
  };
}
