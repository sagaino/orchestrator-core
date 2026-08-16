import { JOB_STATES, listJobs } from "./job-queue.mjs";
import { listRuns, RUN_STATES } from "./run-manager.mjs";
import { buildTelemetry, collectRunTelemetry, compactTelemetry } from "./telemetry.mjs";

const ACCEPTABLE_STATES = new Set([
  RUN_STATES.REVIEW,
  RUN_STATES.RETROSPECTIVE,
  RUN_STATES.KNOWLEDGE_APPROVAL,
  RUN_STATES.WIKI_SYNCED,
  RUN_STATES.DONE,
]);

function newest(items) {
  return [...items].sort((left, right) => (
    String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt))
  ))[0] ?? null;
}

function matchesProject(item, projectId) {
  if (!projectId) return true;
  return item.project?.id === projectId || item.projectId === projectId;
}

export function resolveRunSelector({ runsRoot, selector = null, projectId = null, actionable = false }) {
  const normalized = selector ? String(selector).trim().toLowerCase() : null;
  let candidates = listRuns(runsRoot).filter((run) => matchesProject(run, projectId));
  if (actionable) candidates = candidates.filter((run) => ACCEPTABLE_STATES.has(run.state));
  if (normalized) {
    const exact = candidates.find((run) => String(run.runId).toLowerCase() === normalized);
    if (exact) return exact;
    candidates = candidates.filter((run) => (
      String(run.task?.id ?? "").toLowerCase() === normalized
      || String(run.task?.path ?? "").toLowerCase().includes(normalized)
    ));
  }
  const selected = newest(candidates);
  if (!selected) {
    const target = selector ? ` untuk ${selector}` : "";
    throw new Error(`Run${target} tidak ditemukan${projectId ? ` pada project ${projectId}` : ""}.`);
  }
  return selected;
}

function nextAction(run) {
  if (run.state === RUN_STATES.VERIFYING && run.execution?.automaticRecovery?.status === "RUNNING") {
    return "Automatic recovery sedang mencoba deterministic retry atau bounded AI repair di isolated worktree.";
  }
  if (run.state === RUN_STATES.FAILED && run.execution?.automaticRecovery?.status === "EXHAUSTED") {
    return "Automatic recovery sudah mencapai batas; gunakan recover setelah perbaikan eksternal atau retry --force untuk mengulang coding agent.";
  }
  const actions = {
    [RUN_STATES.PENDING_APPROVAL]: "Run menunggu approval execution pada advanced flow.",
    [RUN_STATES.APPROVED]: "Run menunggu atomic claim.",
    [RUN_STATES.CLAIMED]: "Run menunggu executor.",
    [RUN_STATES.RUNNING]: "Coding agent sedang bekerja.",
    [RUN_STATES.CHANGES_REQUESTED]: "Feedback review diterima; agent akan melanjutkan revisi di isolated worktree.",
    [RUN_STATES.VERIFYING]: "Orchestrator sedang menjalankan verification dan Graphify.",
    [RUN_STATES.REVIEW]: "Retrospective sedang disiapkan; setelah tersedia, terima atau tolak hasil.",
    [RUN_STATES.RETROSPECTIVE]: "Review perubahan dan proposal knowledge, lalu gunakan accept atau reject.",
    [RUN_STATES.KNOWLEDGE_APPROVAL]: "Wiki Sync dapat dilanjutkan oleh accept.",
    [RUN_STATES.WIKI_SYNCED]: "Completion dapat dilanjutkan oleh accept.",
    [RUN_STATES.DONE]: "Task selesai.",
    [RUN_STATES.FAILED]: "Gunakan recover untuk kegagalan dependency/verification/Graphify; gunakan retry jika coding agent perlu mengulang implementasi.",
  };
  return actions[run.state] ?? `State ${run.state}.`;
}

export function reviewBundle(run, { runsRoot = null } = {}) {
  return {
    schemaVersion: 1,
    mode: "user-facing-review",
    task: {
      id: run.task?.id ?? null,
      title: run.task?.title ?? null,
      status: run.task?.status ?? null,
      path: run.task?.path ?? null,
    },
    project: run.project?.id ?? null,
    state: run.state,
    progress: {
      changedPaths: run.execution?.scopeAudit?.changedPaths ?? [],
      outOfScopePaths: run.execution?.scopeAudit?.outOfScopePaths ?? [],
      verification: run.execution?.verification ?? [],
      dependencyReconciliation: run.execution?.dependencyReconciliation ?? null,
      automaticRecovery: run.execution?.automaticRecovery ?? null,
      recovery: run.execution?.recovery ?? null,
      graphify: run.execution?.graphify ?? null,
      error: run.execution?.result?.error ?? null,
    },
    workspace: run.execution?.workspace
      ? {
          isolated: true,
          mode: run.execution.workspace.mode,
          state: run.execution.workspace.state,
          path: run.execution.workspace.path ?? null,
          sourceDirty: run.execution.workspace.sourceDirty,
          appliedPaths: run.execution.workspace.appliedPaths ?? [],
          artifactPath: run.execution.workspace.artifactPath ?? null,
        }
      : null,
    reviewChanges: run.execution?.reviewChanges ?? [],
    knowledgeProposal: run.knowledge?.proposal ?? null,
    knowledgeApproval: run.knowledge?.approval ?? null,
    telemetry: compactTelemetry(
      runsRoot ? collectRunTelemetry({ runsRoot, run }) : run.execution?.telemetry ?? null,
    ),
    nextAction: nextAction(run),
    audit: { runId: run.runId, updatedAt: run.updatedAt },
  };
}

export function interactionStatus({ runsRoot, selector = null, projectId = null }) {
  const normalized = selector ? String(selector).trim().toLowerCase() : null;
  const jobs = listJobs(runsRoot).filter((job) => (
    matchesProject(job, projectId)
    && (!normalized || String(job.taskId).toLowerCase() === normalized || String(job.jobId).toLowerCase() === normalized)
  ));
  const job = newest(jobs);
  const runs = listRuns(runsRoot).filter((run) => (
    matchesProject(run, projectId)
    && (!normalized
      || String(run.task?.id ?? "").toLowerCase() === normalized
      || String(run.runId).toLowerCase() === normalized)
  ));
  const run = newest(runs);
  if (!job && !run) throw new Error("Belum ada task job atau run yang cocok.");
  if (!run || (job && !job.runId && [JOB_STATES.QUEUED, JOB_STATES.RUNNING].includes(job.state))) {
    const jobActions = {
      [JOB_STATES.QUEUED]: "Task sudah masuk antrean dan akan dijalankan daemon.",
      [JOB_STATES.RUNNING]: "Orchestrator sedang menjalankan task di background.",
      [JOB_STATES.REVIEW]: "Hasil task siap direview.",
      [JOB_STATES.DONE]: "Task selesai.",
      [JOB_STATES.FAILED]: "Background job gagal; lihat error dan minta orchestrator melakukan recovery.",
    };
    return {
      schemaVersion: 1,
      mode: "user-facing-status",
      task: { id: job.taskId, path: job.taskPath, project: job.projectId },
      state: job.state,
      error: job.error ?? null,
      telemetry: job.intakeTelemetry ? compactTelemetry(buildTelemetry([job.intakeTelemetry])) : null,
      nextAction: jobActions[job.state] ?? `Job berada pada state ${job.state}.`,
      audit: { jobId: job.jobId, runId: job.runId, updatedAt: job.updatedAt },
    };
  }
  return { ...reviewBundle(run, { runsRoot }), job: job ? { jobId: job.jobId, state: job.state } : null };
}
