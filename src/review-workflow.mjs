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
  if (![RUN_STATES.REVIEW, RUN_STATES.RETROSPECTIVE].includes(manifest.state)) {
    throw new Error(`Preview hanya tersedia saat run menunggu review; state saat ini ${manifest.state}.`);
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
