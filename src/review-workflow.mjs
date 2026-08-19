import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRun, RUN_STATES } from "./run-manager.mjs";

const execFileAsync = promisify(execFile);

async function openWithVsCode(workspacePath) {
  try {
    await execFileAsync("code", [workspacePath], { encoding: "utf8", timeout: 30_000 });
    return { command: "code", args: [workspacePath] };
  } catch (error) {
    if (process.platform !== "darwin" || error.code !== "ENOENT") throw error;
    await execFileAsync("open", ["-a", "Visual Studio Code", workspacePath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return { command: "open", args: ["-a", "Visual Studio Code", workspacePath] };
  }
}

export async function previewReviewWorkspace({
  runsRoot,
  runId,
  opener = openWithVsCode,
}) {
  const manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.DONE) {
    const repoPath = manifest.project?.repository;
    if (repoPath && fs.existsSync(repoPath)) {
      const openedWith = await opener(repoPath);
      return {
        schemaVersion: 1,
        action: "PROJECT_REPOSITORY_OPENED",
        taskId: manifest.task?.id ?? null,
        runId: manifest.runId,
        projectId: manifest.project?.id ?? null,
        workspacePath: repoPath,
        workspaceState: "APPLIED_IN_MAIN",
        repositoryMainUnchanged: false,
        openedWith,
      };
    }
  }

  if (![RUN_STATES.REVIEW, RUN_STATES.RETROSPECTIVE].includes(manifest.state)) {
    throw new Error(`Preview hanya tersedia saat run menunggu review atau DONE; state saat ini ${manifest.state}.`);
  }
  const workspace = manifest.execution?.workspace;
  if (!workspace?.path || !fs.existsSync(workspace.path)) {
    throw new Error("Isolated review workspace sudah tidak tersedia.");
  }
  if (["CLEANED", "DISCARDED", "APPLIED"].includes(workspace.state)) {
    throw new Error(`Preview tidak tersedia untuk workspace state ${workspace.state}.`);
  }

  const openedWith = await opener(workspace.path);
  return {
    schemaVersion: 1,
    action: "REVIEW_WORKSPACE_OPENED",
    taskId: manifest.task?.id ?? null,
    runId: manifest.runId,
    projectId: manifest.project?.id ?? null,
    workspacePath: workspace.path,
    workspaceState: workspace.state,
    repositoryMainUnchanged: true,
    openedWith,
    instructions: {
      startDevelopmentServer: "npm run dev",
      accept: `npm run accept -- ${manifest.task?.id} --by user`,
      requestChanges: `npm run request-changes -- ${manifest.task?.id} --reason \"Jelaskan revisi\" --by user`,
      reject: `npm run reject -- ${manifest.task?.id} --reason \"Jelaskan alasan\" --by user`,
    },
  };
}

export function formatInlineComments(inlineComments = []) {
  if (!Array.isArray(inlineComments) || inlineComments.length === 0) return "";
  const formattedLines = inlineComments
    .filter((c) => c && (c.file || c.path) && c.line !== undefined && (c.comment || c.text || c.message))
    .map((c) => {
      const file = c.file || c.path;
      const line = c.line;
      const comment = c.comment || c.text || c.message;
      return `File: ${file} (Line ${line}): "${comment}"`;
    });
  if (formattedLines.length === 0) return "";
  return [
    "=== INLINE CODE COMMENTS DARI REVIEWER ===",
    ...formattedLines,
  ].join("\n");
}

export function formatReviewRevisionFeedback({ reason = "", feedback = "", inlineComments = [] } = {}) {
  const text = String(reason || feedback || "").trim();
  const commentsBlock = formatInlineComments(inlineComments);
  if (!commentsBlock) return text;
  const instruction = "Instruksi: Prioritaskan perbaikan pada baris-baris spesifik yang diberi catatan oleh reviewer di atas.";
  if (!text) {
    return [commentsBlock, "", instruction].join("\n");
  }
  return [text, "", commentsBlock, "", instruction].join("\n");
}

