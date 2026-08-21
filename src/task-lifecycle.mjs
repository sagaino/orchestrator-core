import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveTaskFile } from "./core.mjs";
import { listJobs } from "./job-queue.mjs";
import { listRuns } from "./run-manager.mjs";
import { withDurableLease } from "./durable-runtime.mjs";

const TERMINAL_ACTIONS = new Set(["CANCELLED", "SUPERSEDED"]);

function frontmatterValue(content, field) {
  return content.match(new RegExp(`^${field}:\\s*([^\\s#]+)`, "m"))?.[1]?.trim() ?? null;
}

function replaceFrontmatterField(content, field, value) {
  const pattern = new RegExp(`^${field}:\\s*.*$`, "m");
  if (!pattern.test(content)) throw new Error(`Task tidak memiliki frontmatter ${field}.`);
  return content.replace(pattern, `${field}: ${value}`);
}

export function closeBacklogTask({
  vaultRoot,
  runsRoot,
  projectId,
  taskInput,
  action = "CANCELLED",
  reason,
  requestedBy = "user",
}) {
  const terminalStatus = String(action).toUpperCase();
  if (!TERMINAL_ACTIONS.has(terminalStatus)) throw new Error(`Lifecycle action tidak valid: ${action}.`);
  const explanation = String(reason ?? "").trim();
  if (!explanation) throw new Error(`${terminalStatus} membutuhkan reason yang eksplisit.`);
  const taskPath = resolveTaskFile(vaultRoot, projectId, String(taskInput));

  return withDurableLease({
    runsRoot,
    namespace: "task-lifecycle",
    key: `${projectId}:${path.basename(taskPath)}`,
    purpose: `${terminalStatus.toLowerCase()} backlog task`,
    ttlMs: 60_000,
    waitTimeoutMs: 2_000,
  }, () => {
    let content = fs.readFileSync(taskPath, "utf8");
    const taskId = frontmatterValue(content, "task_id");
    const status = frontmatterValue(content, "status")?.toUpperCase();
    if (status !== "BACKLOG") {
      throw new Error(`${terminalStatus} hanya menerima task BACKLOG; status saat ini ${status ?? "UNKNOWN"}.`);
    }
    const vaultRelativePath = path.relative(vaultRoot, taskPath).split(path.sep).join("/");
    const relatedRuns = listRuns(runsRoot).filter((run) => (
      run.project?.id === projectId
      && (run.task?.id === taskId || run.task?.path === vaultRelativePath)
    ));
    const relatedJobs = listJobs(runsRoot).filter((job) => (
      job.projectId === projectId
      && (job.taskId === taskId || job.taskPath === vaultRelativePath)
    ));
    if (relatedRuns.length || relatedJobs.length) {
      throw new Error(`Task ${taskId ?? taskInput} sudah memiliki job atau run; gunakan lifecycle run, bukan ${terminalStatus.toLowerCase()} BACKLOG.`);
    }

    const at = new Date().toISOString();
    const actor = String(requestedBy).trim() || "user";
    content = replaceFrontmatterField(content, "status", terminalStatus);
    content = replaceFrontmatterField(content, "updated", at.slice(0, 10));
    const marker = "## Orchestrator Run Log";
    const entry = `- [${at}] Human \`${actor}\` menetapkan task \`${taskId ?? taskInput}\` sebagai \`${terminalStatus}\`: ${explanation}`;
    content = content.includes(marker)
      ? `${content.trimEnd()}\n${entry}\n`
      : `${content.trimEnd()}\n\n---\n\n${marker}\n${entry}\n`;
    const temporaryPath = `${taskPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, taskPath);
    return {
      schemaVersion: 1,
      action: `TASK_${terminalStatus}`,
      task: { id: taskId, projectId, path: vaultRelativePath, status: terminalStatus },
      reason: explanation,
      requestedBy: actor,
      updatedAt: at,
    };
  });
}
