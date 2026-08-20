import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  beginFailedRunRecovery,
  getRun,
  RUN_STATES,
  transitionRun,
  updateRunExecution,
} from "./run-manager.mjs";
import { agyConfigArgs, resolveAgyConfig } from "./agent-config.mjs";
import {
  activateWorkspace,
  changedPaths,
  prepareIsolatedWorkspace,
  repositorySnapshot,
  snapshotFromObject,
} from "./workspace-manager.mjs";
import { appendRunTelemetry, createAgentTelemetryRecord } from "./telemetry.mjs";
import { isDeniedPath } from "./security.mjs";
import { formatReviewRevisionFeedback, formatInlineComments } from "./review-workflow.mjs";

function appendEvent(eventLogPath, event) {
  if (!eventLogPath || typeof eventLogPath !== "string") return;
  fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
  fs.appendFileSync(eventLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function compactLine(line) {
  return line.length > 50_000 ? `${line.slice(0, 50_000)}…[truncated]` : line;
}

function pathAllowed(filePath, allowedPaths) {
  return allowedPaths.some((allowedPath) => {
    const normalized = String(allowedPath).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return filePath === normalized || filePath.startsWith(`${normalized}/`);
  });
}

const PACKAGE_MANAGER_PATHS = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const DEFAULT_AUTOMATIC_RECOVERY_ATTEMPTS = 2;

export function configuredAutomaticRecoveryAttempts(env = process.env) {
  const raw = env.ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS;
  if (raw === undefined || raw === "") return DEFAULT_AUTOMATIC_RECOVERY_ATTEMPTS;
  const attempts = Number(raw);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 3) {
    throw new Error("ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS harus integer antara 0 dan 3.");
  }
  return attempts;
}

function diagnosticTail(result, maximumLength = 6_000) {
  const value = String(result?.stderrTail || result?.stdoutTail || "").trim();
  return value ? value.slice(-maximumLength) : "";
}

export function effectiveAllowedPaths(allowedPaths = []) {
  const normalized = [...new Set(allowedPaths.map((item) => String(item).replaceAll("\\", "/")))];
  if (normalized.some((item) => pathAllowed("package.json", [item]))) {
    for (const lockfile of PACKAGE_MANAGER_PATHS) {
      if (!normalized.includes(lockfile)) normalized.push(lockfile);
    }
  }
  return normalized;
}

function detectPackageManager(repository) {
  const packagePath = path.join(repository, "package.json");
  const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const declared = String(packageDocument.packageManager ?? "").split("@")[0].trim();
  if (declared) return declared;
  if (fs.existsSync(path.join(repository, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repository, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repository, "bun.lock")) || fs.existsSync(path.join(repository, "bun.lockb"))) return "bun";
  return "npm";
}

function packageInstallInvocation(manager) {
  const invocations = {
    npm: { command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] },
    pnpm: { command: "pnpm", args: ["install", "--ignore-scripts", "--no-frozen-lockfile"] },
    yarn: { command: "yarn", args: ["install", "--ignore-scripts"] },
    bun: { command: "bun", args: ["install", "--ignore-scripts"] },
  };
  const invocation = invocations[manager];
  if (!invocation) throw new Error(`Package manager belum didukung untuk dependency reconciliation: ${manager}.`);
  return invocation;
}

export async function reconcileProjectDependencies({
  repository,
  changedPaths: taskChangedPaths,
  processRunner = runProcess,
  eventLogPath,
  force = false,
}) {
  const packageChanged = taskChangedPaths.includes("package.json");
  if (!packageChanged && !force) {
    return { skipped: true, reason: "package.json tidak berubah." };
  }
  if (!fs.existsSync(path.join(repository, "package.json"))) {
    throw new Error("Dependency reconciliation membutuhkan package.json.");
  }

  const manager = detectPackageManager(repository);
  const invocation = packageInstallInvocation(manager);
  const result = await processRunner({
    ...invocation,
    cwd: repository,
    stage: `dependency-install:${manager}`,
    eventLogPath,
  });
  return {
    skipped: false,
    manager,
    command: [invocation.command, ...invocation.args].join(" "),
    ignoreScripts: true,
    exitCode: result.exitCode,
    ...(result.exitCode !== 0 && diagnosticTail(result) ? { diagnostic: diagnosticTail(result) } : {}),
  };
}

export function runProcess({ command, args, cwd, stage, eventLogPath, env = process.env }) {
  appendEvent(eventLogPath, { event: "PROCESS_STARTED", stage, command, args, cwd });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let stdoutTail = "";
    let stderrTail = "";
    let finalResult = null;

    const consume = (stream, chunk) => {
      const current = stream === "stdout" ? stdoutBuffer : stderrBuffer;
      const lines = `${current}${chunk.toString()}`.split("\n");
      const remainder = lines.pop() ?? "";
      if (stream === "stdout") stdoutBuffer = remainder;
      else stderrBuffer = remainder;

      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;
        let payload = null;
        try {
          payload = JSON.parse(rawLine);
          if (payload.event === "result") finalResult = payload.result ?? payload;
          else if (payload.structured_output || payload.patterns || payload.response) finalResult = payload;
        } catch {
          payload = null;
        }
        const line = compactLine(rawLine);
        appendEvent(eventLogPath, {
          event: "PROCESS_OUTPUT",
          stage,
          stream,
          ...(payload ? { payload } : { line }),
        });
        if (stream === "stdout") stdoutTail = `${stdoutTail}\n${line}`.slice(-50_000);
        else stderrTail = `${stderrTail}\n${line}`.slice(-50_000);
      }
    };

    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.once("error", (error) => {
      appendEvent(eventLogPath, { event: "PROCESS_ERROR", stage, error: error.message });
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (stdoutBuffer.trim()) consume("stdout", "\n");
      if (stderrBuffer.trim()) consume("stderr", "\n");
      const result = { exitCode, signal, stdoutTail, stderrTail, finalResult };
      appendEvent(eventLogPath, { event: "PROCESS_FINISHED", stage, exitCode, signal });
      resolve(result);
    });
  });
}

function buildGraphifyQuestion(manifest) {
  const allowedPaths = Array.isArray(manifest.task.allowedPaths) ? manifest.task.allowedPaths : [];
  return [manifest.task.title, ...allowedPaths].filter(Boolean).join(" ");
}

export function pruneGraphifyContext(rawContext, maxCharacters = 2500) {
  if (!rawContext || typeof rawContext !== "string") return "";
  const lines = rawContext.split(/\r?\n/);
  const pruned = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip verbose community detection boilerplate or verbose statistics
    if (trimmed.startsWith("Graph statistics:") || trimmed.startsWith("Community detection:")) continue;
    pruned.push(trimmed);
    if (pruned.join("\n").length >= maxCharacters) break;
  }

  const result = pruned.join("\n");
  return result.length > maxCharacters ? `${result.slice(0, maxCharacters)}…` : result;
}

export function buildAgyInvocation(
  manifest,
  vaultRoot,
  { graphifyContext = "", repository = manifest.project.repository } = {},
) {
  if (manifest.project.agent !== "agy") {
    throw new Error(`Agent ${manifest.project.agent} belum memiliki executor adapter.`);
  }

  const knowledge = manifest.retrieval.knowledge
    .map((item) => `- ${path.join(vaultRoot, item.path)}`)
    .join("\n");
  const agentConfig = resolveAgyConfig(process.env, "implementation", {
    request: manifest.task?.title || "",
    allowedPaths: manifest.task?.allowedPaths || [],
  });
  const prompt = [
    "=== KONTRAK EKSEKUSI CODING AGENT ===",
    "1. Baca task, project metadata, dan hanya knowledge/source yang relevan.",
    "2. Gunakan konteks Graphify targeted di bawah; jangan query atau bulk-load graph.json sendiri.",
    "3. Implementasikan perubahan hanya di repository project.",
    "4. Jangan mengubah status task, run manifest, index Wiki, atau wiki-log; orchestrator memiliki lifecycle tersebut.",
    "5. Jangan menandai task DONE.",
    "6. Laporkan file berubah, verification yang disarankan, dan retrospective knowledge: NEW, UPDATE, PROJECT_ONLY, atau IGNORE.",
    "7. Jangan gunakan terminal/run_command, termasuk git, Graphify, test, lint, atau build; orchestrator menangani query, audit, dan verification.",
    "8. Jangan berhenti setelah inspeksi. Selesaikan edit yang diminta dan pastikan acceptance criteria task terpenuhi.",
    "",
    "=== RETRIEVED KNOWLEDGE ===",
    knowledge || "- Tidak ada knowledge match yang cukup relevan.",
    "",
    "=== GRAPHIFY TARGETED CONTEXT ===",
    graphifyContext || "- Graphify tidak aktif atau tidak menemukan node yang relevan.",
    "",
    "=== TARGET EXECUTION METADATA ===",
    `Project repository: ${repository}`,
    `Task file: ${path.join(vaultRoot, manifest.task.path)}`,
    `Run ID: ${manifest.runId}`,
  ].join("\n");

  return {
    command: "agy",
    args: [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      ...agyConfigArgs(agentConfig),
      "--mode",
      "accept-edits",
      "--print-timeout",
      "30m",
    ],
    agentConfig,
  };
}

export function buildAgyRecoveryInvocation(
  manifest,
  vaultRoot,
  {
    repository = manifest.execution?.workspace?.path ?? manifest.project.repository,
    graphifyContext = "",
    failure,
    attempt,
  } = {},
) {
  if (manifest.project.agent !== "agy") {
    throw new Error(`Agent ${manifest.project.agent} belum memiliki automatic recovery adapter.`);
  }
  const allowedPaths = Array.isArray(manifest.task.allowedPaths) ? manifest.task.allowedPaths : [];
  const changedPathsList = manifest.execution?.scopeAudit?.changedPaths ?? [];
  const knowledge = manifest.retrieval.knowledge
    .map((item) => `- ${path.join(vaultRoot, item.path)}`)
    .join("\n");
  const agentConfig = resolveAgyConfig(process.env, "recovery");
  const failureDetail = typeof failure === "string"
    ? failure
    : (diagnosticTail(failure?.result) || String(failure ?? "Unknown failure"));
  const prompt = [
    "=== KONTRAK AUTOMATIC RECOVERY AGENT ===",
    "1. Cari root cause dari error dan perbaiki implementasi yang sudah ada; jangan mengulang task dari awal.",
    "2. Pertahankan perubahan valid dari coding agent dan edit hanya allowed paths.",
    "3. Jangan mengubah task Wiki, run manifest, index, wiki-log, atau repository utama.",
    "4. Jangan menggunakan terminal/run_command, git, package install, Graphify, test, lint, atau build; orchestrator menjalankannya.",
    "5. Jika kegagalan tampak eksternal/transient dan code sudah benar, jangan membuat perubahan spekulatif.",
    "6. Laporkan root cause dan file yang diperbaiki secara ringkas.",
    "",
    `Allowed paths: ${allowedPaths.length ? allowedPaths.join(", ") : "seluruh repository sesuai task"}`,
    `Current audited changes: ${changedPathsList.length ? changedPathsList.join(", ") : "none"}`,
    "",
    "=== RETRIEVED KNOWLEDGE ===",
    knowledge || "- Tidak ada knowledge match yang cukup relevan.",
    "",
    "=== GRAPHIFY TARGETED CONTEXT ===",
    graphifyContext || "- Tidak tersedia.",
    "",
    "=== RECOVERY FAILURE DETAILS ===",
    `Kegagalan yang harus didiagnosis: ${failureDetail}`,
    `Tahap kegagalan: ${failure?.stage ?? "verification"} (Attempt ${attempt ?? 1})`,
    `Project workspace: ${repository}`,
    `Task file: ${path.join(vaultRoot, manifest.task.path)}`,
    `Run ID: ${manifest.runId}`,
  ].join("\n");

  return {
    command: "agy",
    args: [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      ...agyConfigArgs(agentConfig),
      "--mode",
      "accept-edits",
      "--print-timeout",
      "20m",
    ],
    agentConfig,
  };
}

export function buildAgyRevisionInvocation(
  manifest,
  vaultRoot,
  {
    repository = manifest.execution?.workspace?.path ?? manifest.project.repository,
    graphifyContext = "",
    inlineComments = null,
  } = {},
) {
  if (manifest.project.agent !== "agy") {
    throw new Error(`Agent ${manifest.project.agent} belum memiliki review revision adapter.`);
  }
  const reviewChanges = Array.isArray(manifest.execution?.reviewChanges)
    ? manifest.execution.reviewChanges
    : [];
  const revision = reviewChanges.at(-1);
  if (!revision) throw new Error("Review revision tidak memiliki feedback user.");
  const previousRevisions = Array.isArray(manifest.execution?.revisions)
    ? manifest.execution.revisions
    : [];
  const conversationId = previousRevisions.at(-1)?.agent?.finalResult?.conversation_id
    ?? manifest.execution?.agent?.finalResult?.conversation_id
    ?? null;
  const knowledge = manifest.retrieval.knowledge
    .map((item) => `- ${path.join(vaultRoot, item.path)}`)
    .join("\n");
  const agentConfig = resolveAgyConfig(process.env, "implementation");

  const effectiveInlineComments = inlineComments ?? revision.inlineComments ?? [];
  let feedbackText = revision.reason;
  if (
    Array.isArray(effectiveInlineComments)
    && effectiveInlineComments.length > 0
    && !feedbackText.includes("=== INLINE CODE COMMENTS DARI REVIEWER ===")
  ) {
    feedbackText = formatReviewRevisionFeedback({
      reason: feedbackText,
      inlineComments: effectiveInlineComments,
    });
  }

  const prompt = [
    `Lanjutkan revisi review iteration ${revision.iteration} untuk task: ${path.join(vaultRoot, manifest.task.path)}`,
    `Project workspace: ${repository}`,
    `Run ID: ${manifest.runId}`,
    "",
    "Feedback human reviewer:",
    feedbackText,
    "",
    `Current audited changes: ${(manifest.execution?.scopeAudit?.changedPaths ?? []).join(", ") || "none"}`,
    `Allowed paths: ${(manifest.task.allowedPaths ?? []).join(", ") || "sesuai task"}`,
    "",
    "Knowledge relevan:",
    knowledge || "- Tidak ada knowledge match yang cukup relevan.",
    "",
    "Konteks Graphify targeted:",
    graphifyContext || "- Tidak tersedia.",
    "",
    "Kontrak revisi:",
    "1. Pertahankan implementasi yang sudah benar dan lakukan hanya perubahan yang diminta reviewer.",
    "2. Prioritaskan perbaikan pada baris-baris spesifik yang diberi catatan oleh reviewer (inline code comments).",
    "3. Edit hanya allowed_paths di isolated worktree ini; jangan menyentuh repository utama.",
    "4. Jangan mengubah task Wiki, run manifest, index, wiki-log, atau status lifecycle.",
    "5. Jangan menggunakan terminal/run_command, git, package install, Graphify, test, lint, atau build; orchestrator menjalankannya.",
    "6. Jangan berhenti setelah inspeksi. Selesaikan revisi dan laporkan file yang diubah secara ringkas.",
  ].join("\n");

  return {
    command: "agy",
    args: [
      ...(conversationId ? ["--conversation", conversationId] : []),
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      ...agyConfigArgs(agentConfig),
      "--mode",
      "accept-edits",
      "--print-timeout",
      "30m",
    ],
    agentConfig,
    conversationId,
  };
}

function parseVerificationCommand(command) {
  const match = command.match(/^npm run ([A-Za-z0-9:_-]+)$/);
  if (!match) throw new Error(`Verification command tidak didukung: ${command}`);
  return { command: "npm", args: ["run", match[1]] };
}

function createScopeAudit({ beforeSnapshot, afterSnapshot, allowedPaths, requiresChanges, agentChangedPaths = null }) {
  const changed = changedPaths(beforeSnapshot, afterSnapshot);
  const effectivePaths = effectiveAllowedPaths(allowedPaths);
  const deniedPaths = changed.filter((filePath) => isDeniedPath(filePath).denied);
  const outOfScope = allowedPaths.length
    ? changed.filter((filePath) => !pathAllowed(filePath, effectivePaths))
    : [];
  return {
    changedPaths: changed,
    ...(agentChangedPaths ? { agentChangedPaths } : {}),
    allowedPaths,
    automaticAllowedPaths: effectivePaths.filter((item) => !allowedPaths.includes(item)),
    effectiveAllowedPaths: effectivePaths,
    outOfScopePaths: [...new Set([...outOfScope, ...deniedPaths])],
    deniedPaths,
    requiresChanges,
  };
}

export function assertVerificationScriptsUnmodified(repository, frozenScripts) {
  if (!frozenScripts || Object.keys(frozenScripts).length === 0) return;
  const packagePath = path.join(repository, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error("package.json tidak ditemukan saat validasi verification script.");
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Gagal membaca package.json untuk validasi script: ${error.message}`);
  }
  const currentScripts = pkg.scripts || {};
  for (const [name, expectedCommand] of Object.entries(frozenScripts)) {
    const actualCommand = currentScripts[name];
    if (actualCommand !== expectedCommand) {
      throw new Error(
        `Verification script "${name}" berubah setelah claim (sebelumnya: "${expectedCommand}", sekarang: "${actualCommand ?? "dihapus"}"). Perubahan pada verification script membutuhkan otorisasi eksplisit.`
      );
    }
  }
}

async function verifyAndRefresh({
  vaultRoot,
  runsRoot,
  manifest,
  processRunner,
  eventLogPath,
  repository,
  recovery = false,
}) {
  let current = manifest;
  assertVerificationScriptsUnmodified(repository, current.execution?.frozenVerificationScripts);
  const verification = [];
  for (const verificationCommand of current.plan.verificationCommands) {
    const parsed = parseVerificationCommand(verificationCommand);
    const result = await processRunner({
      ...parsed,
      cwd: repository,
      stage: `verification:${verificationCommand}`,
      eventLogPath,
    });
    const diagnostic = diagnosticTail(result);
    verification.push({
      command: verificationCommand,
      exitCode: result.exitCode,
      ...(result.exitCode !== 0 && diagnostic ? { diagnostic } : {}),
    });
    current = updateRunExecution({
      runsRoot,
      runId: current.runId,
      executionPatch: { verification },
      event: "VERIFICATION_RESULT",
      message: `${verificationCommand} selesai dengan exit code ${result.exitCode}.`,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Verification gagal: ${verificationCommand} (exit code ${result.exitCode}).${diagnostic ? `\n${diagnostic}` : ""}`,
      );
    }
  }

  let graphify = { skipped: true, reason: "Graphify disabled for project." };
  if (current.project.graphify) {
    const result = await processRunner({
      command: "graphify",
      args: ["update", "."],
      cwd: repository,
      stage: "graphify-update",
      eventLogPath,
    });
    graphify = { skipped: false, exitCode: result.exitCode };
    current = updateRunExecution({
      runsRoot,
      runId: current.runId,
      executionPatch: { graphify },
      event: "GRAPHIFY_UPDATE_RESULT",
      message: `Graphify update selesai dengan exit code ${result.exitCode}.`,
    });
    if (result.exitCode !== 0) {
      const diagnostic = diagnosticTail(result);
      throw new Error(`Graphify update gagal dengan exit code ${result.exitCode}.${diagnostic ? `\n${diagnostic}` : ""}`);
    }
  }

  const recoveryState = recovery
    ? {
        ...current.execution.recovery,
        status: "SUCCESS",
        finishedAt: new Date().toISOString(),
      }
    : current.execution.recovery;
  return transitionRun({
    vaultRoot,
    runsRoot,
    runId: current.runId,
    toState: RUN_STATES.REVIEW,
    executionPatch: {
      verification,
      graphify,
      ...(current.execution.workspace
        ? {
            workspace: {
              ...current.execution.workspace,
              state: "VERIFIED",
              verifiedAt: new Date().toISOString(),
            },
          }
        : {}),
      ...(recoveryState ? { recovery: recoveryState } : {}),
      result: { status: "SUCCESS", knowledgeDecision: "PENDING_RETROSPECTIVE" },
    },
    message: recovery
      ? "dependency recovery, verification, dan Graphify selesai; menunggu human review."
      : "coding agent, verification, dan Graphify selesai; menunggu human review.",
  });
}

function updateAutomaticRecovery({ runsRoot, runId, patch, event, message = null }) {
  const manifest = getRun(runsRoot, runId);
  return updateRunExecution({
    runsRoot,
    runId,
    executionPatch: {
      automaticRecovery: {
        ...(manifest.execution?.automaticRecovery ?? {}),
        ...patch,
      },
    },
    event,
    message,
  });
}

function canAutomaticallyRecover(manifest, error) {
  return manifest.state === RUN_STATES.VERIFYING
    && Boolean(manifest.execution?.workspace?.path)
    && !manifest.execution?.scopeAudit?.outOfScopePaths?.length
    && /^(Dependency reconciliation gagal|Verification gagal|Graphify update gagal)/i.test(error.message);
}

async function rerunRecoveryChecks({
  vaultRoot,
  runsRoot,
  runId,
  repository,
  beforeSnapshot,
  processRunner,
  dependencyReconciler,
  eventLogPath,
}) {
  let manifest = getRun(runsRoot, runId);
  const allowedPaths = Array.isArray(manifest.task.allowedPaths) ? manifest.task.allowedPaths : [];
  const beforeDependencySnapshot = repositorySnapshot(repository);
  const preDependencyScope = createScopeAudit({
    beforeSnapshot,
    afterSnapshot: beforeDependencySnapshot,
    allowedPaths,
    requiresChanges: manifest.task.requiresChanges === true,
    agentChangedPaths: manifest.execution?.scopeAudit?.agentChangedPaths ?? null,
  });
  manifest = updateRunExecution({
    runsRoot,
    runId,
    executionPatch: { scopeAudit: preDependencyScope },
    event: "AUTOMATIC_RECOVERY_SCOPE_AUDIT",
  });
  appendEvent(eventLogPath, { event: "AUTOMATIC_RECOVERY_SCOPE_AUDIT", ...preDependencyScope });
  if (preDependencyScope.outOfScopePaths.length) {
    throw new Error(
      `Scope guard menolak automatic recovery di luar allowed_paths: ${preDependencyScope.outOfScopePaths.join(", ")}.`,
    );
  }

  const dependencyReconciliation = await dependencyReconciler({
    repository,
    changedPaths: preDependencyScope.changedPaths,
    processRunner,
    eventLogPath,
  });
  manifest = updateRunExecution({
    runsRoot,
    runId,
    executionPatch: { dependencyReconciliation },
    event: "AUTOMATIC_RECOVERY_DEPENDENCY_RESULT",
    message: dependencyReconciliation.skipped
      ? dependencyReconciliation.reason
      : `${dependencyReconciliation.command} selesai dengan exit code ${dependencyReconciliation.exitCode}.`,
  });
  if (!dependencyReconciliation.skipped && dependencyReconciliation.exitCode !== 0) {
    throw new Error(
      `Dependency reconciliation gagal dengan exit code ${dependencyReconciliation.exitCode}.`
      + (dependencyReconciliation.diagnostic ? `\n${dependencyReconciliation.diagnostic}` : ""),
    );
  }

  const afterDependencySnapshot = repositorySnapshot(repository);
  const scopeAudit = createScopeAudit({
    beforeSnapshot,
    afterSnapshot: afterDependencySnapshot,
    allowedPaths,
    requiresChanges: manifest.task.requiresChanges === true,
    agentChangedPaths: manifest.execution?.scopeAudit?.agentChangedPaths ?? null,
  });
  manifest = updateRunExecution({
    runsRoot,
    runId,
    executionPatch: { scopeAudit },
    event: "AUTOMATIC_RECOVERY_SCOPE_AUDIT_COMPLETED",
  });
  appendEvent(eventLogPath, { event: "AUTOMATIC_RECOVERY_SCOPE_AUDIT_COMPLETED", ...scopeAudit });
  if (scopeAudit.outOfScopePaths.length) {
    throw new Error(`Scope guard menolak automatic recovery di luar allowed_paths: ${scopeAudit.outOfScopePaths.join(", ")}.`);
  }

  return verifyAndRefresh({
    vaultRoot,
    runsRoot,
    manifest,
    processRunner,
    eventLogPath,
    repository,
  });
}

async function attemptAutomaticRecovery({
  vaultRoot,
  runsRoot,
  runId,
  initialError,
  repository,
  beforeSnapshot,
  graphifyContext,
  processRunner,
  dependencyReconciler,
  recoveryInvocationBuilder,
  maxAgentAttempts,
  eventLogPath,
}) {
  const startedAt = new Date().toISOString();
  updateAutomaticRecovery({
    runsRoot,
    runId,
    patch: {
      enabled: true,
      status: "RUNNING",
      startedAt,
      finishedAt: null,
      maxAgentAttempts,
      trigger: initialError.message,
      deterministicRetry: null,
      attempts: [],
    },
    event: "AUTOMATIC_RECOVERY_STARTED",
    message: "Automatic recovery dimulai dengan deterministic retry.",
  });
  appendEvent(eventLogPath, {
    event: "AUTOMATIC_RECOVERY_STARTED",
    trigger: initialError.message,
    maxAgentAttempts,
  });

  let latestError = initialError;
  const deterministicStartedAt = new Date().toISOString();
  try {
    await rerunRecoveryChecks({
      vaultRoot,
      runsRoot,
      runId,
      repository,
      beforeSnapshot,
      processRunner,
      dependencyReconciler,
      eventLogPath,
    });
    return updateAutomaticRecovery({
      runsRoot,
      runId,
      patch: {
        status: "SUCCESS",
        strategy: "DETERMINISTIC_RETRY",
        finishedAt: new Date().toISOString(),
        deterministicRetry: {
          startedAt: deterministicStartedAt,
          finishedAt: new Date().toISOString(),
          outcome: "SUCCESS",
        },
      },
      event: "AUTOMATIC_RECOVERY_SUCCEEDED",
      message: "Verification pulih melalui deterministic retry tanpa AI repair.",
    });
  } catch (error) {
    latestError = error;
    updateAutomaticRecovery({
      runsRoot,
      runId,
      patch: {
        deterministicRetry: {
          startedAt: deterministicStartedAt,
          finishedAt: new Date().toISOString(),
          outcome: "FAILED",
          error: error.message,
        },
      },
      event: "AUTOMATIC_RECOVERY_RETRY_FAILED",
      message: error.message,
    });
  }

  for (let attempt = 1; attempt <= maxAgentAttempts; attempt += 1) {
    const attemptRecord = {
      attempt,
      startedAt: new Date().toISOString(),
      trigger: latestError.message,
    };
    try {
      const manifest = getRun(runsRoot, runId);
      const beforeRepairSnapshot = repositorySnapshot(repository);
      const invocation = recoveryInvocationBuilder(manifest, vaultRoot, {
        repository,
        graphifyContext,
        failure: latestError.message,
        attempt,
      });
      const agent = await processRunner({
        ...invocation,
        cwd: repository,
        stage: `automatic-recovery-agent:${attempt}`,
        eventLogPath,
      });
      const recoveryTelemetry = createAgentTelemetryRecord({
        stage: "AUTOMATIC_RECOVERY",
        result: agent,
        agentConfig: invocation.agentConfig ?? null,
        invocationId: `${runId}:automatic-recovery:${attempt}`,
        metadata: {
          runId,
          taskId: manifest.task?.id ?? null,
          projectId: manifest.project?.id ?? null,
          attempt,
        },
      });
      appendRunTelemetry({ runsRoot, runId, record: recoveryTelemetry });
      attemptRecord.telemetryRecordId = recoveryTelemetry.recordId;
      const afterRepairSnapshot = repositorySnapshot(repository);
      attemptRecord.changedPaths = changedPaths(beforeRepairSnapshot, afterRepairSnapshot);
      attemptRecord.agent = {
        exitCode: agent.exitCode,
        finalResult: agent.finalResult ?? null,
        configuration: invocation.agentConfig ?? null,
      };
      if (agent.exitCode !== 0) {
        throw new Error(
          `Automatic recovery agent gagal dengan exit code ${agent.exitCode}.`
          + (diagnosticTail(agent) ? `\n${diagnosticTail(agent)}` : ""),
        );
      }
      if (/no output produced|auto-denied|denied permission|permission.*required/i.test(String(agent.stderrTail ?? ""))) {
        throw new Error(`Automatic recovery agent terhenti karena permission headless: ${diagnosticTail(agent)}`);
      }

      await rerunRecoveryChecks({
        vaultRoot,
        runsRoot,
        runId,
        repository,
        beforeSnapshot,
        processRunner,
        dependencyReconciler,
        eventLogPath,
      });
      attemptRecord.finishedAt = new Date().toISOString();
      attemptRecord.outcome = "SUCCESS";
      const current = getRun(runsRoot, runId);
      return updateAutomaticRecovery({
        runsRoot,
        runId,
        patch: {
          status: "SUCCESS",
          strategy: "AI_REPAIR",
          successfulAttempt: attempt,
          finishedAt: new Date().toISOString(),
          attempts: [...(current.execution.automaticRecovery?.attempts ?? []), attemptRecord],
        },
        event: "AUTOMATIC_RECOVERY_SUCCEEDED",
        message: `Automatic recovery agent berhasil pada attempt ${attempt}.`,
      });
    } catch (error) {
      latestError = error;
      attemptRecord.finishedAt = new Date().toISOString();
      attemptRecord.outcome = "FAILED";
      attemptRecord.error = error.message;
      const current = getRun(runsRoot, runId);
      updateAutomaticRecovery({
        runsRoot,
        runId,
        patch: {
          attempts: [...(current.execution.automaticRecovery?.attempts ?? []), attemptRecord],
        },
        event: "AUTOMATIC_RECOVERY_ATTEMPT_FAILED",
        message: `Attempt ${attempt} gagal: ${error.message}`,
      });
    }
  }

  updateAutomaticRecovery({
    runsRoot,
    runId,
    patch: {
      status: "EXHAUSTED",
      finishedAt: new Date().toISOString(),
      finalError: latestError.message,
    },
    event: "AUTOMATIC_RECOVERY_EXHAUSTED",
    message: `Automatic recovery berhenti setelah ${maxAgentAttempts} AI repair attempt.`,
  });
  throw new Error(
    `${initialError.message}\nAutomatic recovery gagal setelah deterministic retry dan ${maxAgentAttempts} AI repair attempt. Error terakhir: ${latestError.message}`,
  );
}

function failExecution({ vaultRoot, runsRoot, runId, eventLogPath, error, recovery = false }) {
  appendEvent(eventLogPath, { event: recovery ? "RECOVERY_ERROR" : "RUN_ERROR", error: error.message });
  const current = getRun(runsRoot, runId);
  if (![RUN_STATES.CLAIMED, RUN_STATES.RUNNING, RUN_STATES.VERIFYING].includes(current.state)) return current;
  const recoveryState = recovery
    ? {
        ...current.execution.recovery,
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        error: error.message,
      }
    : current.execution.recovery;
  return transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.FAILED,
    executionPatch: {
      ...(recoveryState ? { recovery: recoveryState } : {}),
      result: { status: "FAILED", error: error.message },
    },
    message: `${recovery ? "recovery" : "execution"} gagal: ${error.message}`,
  });
}

export async function executeRun({
  vaultRoot,
  runsRoot,
  runId,
  agentInvocationBuilder = buildAgyInvocation,
  processRunner = runProcess,
  dependencyReconciler = reconcileProjectDependencies,
  workspaceProcessRunner = runProcess,
  recoveryInvocationBuilder = buildAgyRecoveryInvocation,
  maxAutomaticRecoveryAttempts = configuredAutomaticRecoveryAttempts(),
}) {
  let manifest = getRun(runsRoot, runId);
  if ([RUN_STATES.REVIEW, RUN_STATES.FAILED].includes(manifest.state)) return manifest;
  if (manifest.state !== RUN_STATES.CLAIMED) {
    throw new Error(`Run ${runId} harus CLAIMED sebelum execute; state saat ini ${manifest.state}.`);
  }

  const eventLogPath = path.join(runsRoot, "events", `${runId}.jsonl`);
  const relativeEventLog = path.relative(runsRoot, eventLogPath);
  manifest = transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.RUNNING,
    executionPatch: { eventLog: relativeEventLog },
  });

  let repository = null;
  let beforeSnapshot = null;
  let graphifyContext = "";

  try {
    let workspace = await prepareIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: workspaceProcessRunner,
    });
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: { workspace },
      event: "WORKSPACE_PREPARED",
      message: `Isolated Git worktree dibuat dari ${workspace.baseCommit}.`,
    });

    let workspaceDependency = { skipped: true, reason: "Project tidak membutuhkan dependency bootstrap." };
    const packagePath = path.join(workspace.path, "package.json");
    if (fs.existsSync(packagePath)) {
      const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      const hasDependencies = Object.keys(packageDocument.dependencies ?? {}).length > 0
        || Object.keys(packageDocument.devDependencies ?? {}).length > 0
        || Object.keys(packageDocument.optionalDependencies ?? {}).length > 0;
      if (hasDependencies) {
        workspaceDependency = await dependencyReconciler({
          repository: workspace.path,
          changedPaths: [],
          processRunner,
          eventLogPath,
          force: true,
        });
        if (!workspaceDependency.skipped && workspaceDependency.exitCode !== 0) {
          throw new Error(`Workspace dependency bootstrap gagal dengan exit code ${workspaceDependency.exitCode}.`);
        }
      }
    }

    let workspaceGraphify = { skipped: true, reason: "Graphify disabled for project." };
    if (manifest.project.graphify) {
      const result = await processRunner({
        command: "graphify",
        args: ["update", "."],
        cwd: workspace.path,
        stage: "workspace:graphify-bootstrap",
        eventLogPath,
      });
      workspaceGraphify = { skipped: false, exitCode: result.exitCode };
      if (result.exitCode !== 0) {
        throw new Error(`Workspace Graphify bootstrap gagal dengan exit code ${result.exitCode}.`);
      }
    }

    workspace = activateWorkspace(workspace);
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: {
        workspace,
        workspaceBootstrap: {
          dependency: workspaceDependency,
          graphify: workspaceGraphify,
        },
      },
      event: "WORKSPACE_ACTIVATED",
      message: "Coding agent diarahkan ke isolated Git worktree.",
    });
    repository = workspace.path;
    beforeSnapshot = snapshotFromObject(workspace.baseline);
    let graphifyQuery = { skipped: true, reason: "Graphify disabled for project." };
    if (manifest.project.graphify) {
      const question = buildGraphifyQuestion(manifest);
      const result = await processRunner({
        command: "graphify",
        args: ["query", question, "--budget", "1200"],
        cwd: repository,
        stage: "graphify-query",
        eventLogPath,
      });
      graphifyQuery = { question, exitCode: result.exitCode };
      if (result.exitCode !== 0) {
        throw new Error(`Graphify query gagal dengan exit code ${result.exitCode}: ${result.stderrTail.trim()}`);
      }
      graphifyContext = pruneGraphifyContext(result.stdoutTail.trim());
    }

    const invocation = agentInvocationBuilder(manifest, vaultRoot, { graphifyContext, repository });
    const agent = await processRunner({
      ...invocation,
      cwd: repository,
      stage: "coding-agent",
      eventLogPath,
    });
    const implementationTelemetry = createAgentTelemetryRecord({
      stage: "IMPLEMENTATION",
      result: agent,
      agentConfig: invocation.agentConfig ?? null,
      invocationId: `${runId}:implementation`,
      metadata: {
        runId,
        taskId: manifest.task?.id ?? null,
        projectId: manifest.project?.id ?? null,
      },
    });
    manifest = appendRunTelemetry({ runsRoot, runId, record: implementationTelemetry });
    if (agent.exitCode !== 0) {
      throw new Error(`Coding agent gagal dengan exit code ${agent.exitCode}: ${agent.stderrTail.trim()}`);
    }
    if (/no output produced|auto-denied|denied permission|permission.*required/i.test(agent.stderrTail)) {
      throw new Error(`Coding agent tidak menyelesaikan eksekusi karena permission headless: ${agent.stderrTail.trim()}`);
    }

    const afterAgentSnapshot = repositorySnapshot(repository);
    const agentChangedPaths = changedPaths(beforeSnapshot, afterAgentSnapshot);
    const allowedPaths = Array.isArray(manifest.task.allowedPaths) ? manifest.task.allowedPaths : [];
    const preliminaryScopeAudit = createScopeAudit({
      beforeSnapshot,
      afterSnapshot: afterAgentSnapshot,
      allowedPaths,
      requiresChanges: manifest.task.requiresChanges === true,
      agentChangedPaths,
    });
    appendEvent(eventLogPath, { event: "AGENT_SCOPE_AUDIT", ...preliminaryScopeAudit });
    if (preliminaryScopeAudit.outOfScopePaths.length) {
      throw new Error(`Scope guard menolak perubahan di luar allowed_paths: ${preliminaryScopeAudit.outOfScopePaths.join(", ")}.`);
    }
    if (manifest.task.requiresChanges === true && agentChangedPaths.length === 0) {
      throw new Error("Scope guard menolak eksekusi: task mewajibkan perubahan tetapi agent tidak menghasilkan diff.");
    }

    manifest = transitionRun({
      vaultRoot,
      runsRoot,
      runId,
      toState: RUN_STATES.VERIFYING,
      executionPatch: {
        agent: {
          exitCode: agent.exitCode,
          finalResult: agent.finalResult,
          configuration: invocation.agentConfig ?? null,
        },
        graphifyQuery,
        scopeAudit: preliminaryScopeAudit,
      },
    });

    const dependencyReconciliation = await dependencyReconciler({
      repository,
      changedPaths: agentChangedPaths,
      processRunner,
      eventLogPath,
    });
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: { dependencyReconciliation },
      event: "DEPENDENCY_RECONCILIATION_RESULT",
      message: dependencyReconciliation.skipped
        ? dependencyReconciliation.reason
        : `${dependencyReconciliation.command} selesai dengan exit code ${dependencyReconciliation.exitCode}.`,
    });
    if (!dependencyReconciliation.skipped && dependencyReconciliation.exitCode !== 0) {
      throw new Error(
        `Dependency reconciliation gagal dengan exit code ${dependencyReconciliation.exitCode}.`
        + (dependencyReconciliation.diagnostic ? `\n${dependencyReconciliation.diagnostic}` : ""),
      );
    }

    const afterDependencySnapshot = repositorySnapshot(repository);
    const scopeAudit = createScopeAudit({
      beforeSnapshot,
      afterSnapshot: afterDependencySnapshot,
      allowedPaths,
      requiresChanges: manifest.task.requiresChanges === true,
      agentChangedPaths,
    });
    appendEvent(eventLogPath, { event: "SCOPE_AUDIT", ...scopeAudit });
    if (scopeAudit.outOfScopePaths.length) {
      throw new Error(`Scope guard menolak perubahan di luar allowed_paths: ${scopeAudit.outOfScopePaths.join(", ")}.`);
    }
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: { scopeAudit },
      event: "SCOPE_AUDIT_COMPLETED",
    });

    return await verifyAndRefresh({
      vaultRoot,
      runsRoot,
      manifest,
      processRunner,
      eventLogPath,
      repository,
    });
  } catch (error) {
    const current = getRun(runsRoot, runId);
    if (
      maxAutomaticRecoveryAttempts > 0
      && repository
      && beforeSnapshot
      && canAutomaticallyRecover(current, error)
    ) {
      try {
        return await attemptAutomaticRecovery({
          vaultRoot,
          runsRoot,
          runId,
          initialError: error,
          repository,
          beforeSnapshot,
          graphifyContext,
          processRunner,
          dependencyReconciler,
          recoveryInvocationBuilder,
          maxAgentAttempts: maxAutomaticRecoveryAttempts,
          eventLogPath,
        });
      } catch (recoveryError) {
        failExecution({ vaultRoot, runsRoot, runId, eventLogPath, error: recoveryError });
        throw recoveryError;
      }
    }
    failExecution({ vaultRoot, runsRoot, runId, eventLogPath, error });
    throw error;
  }
}

function updateReviewRevisionRecord({ runsRoot, runId, status, patch = {}, event, message }) {
  const manifest = getRun(runsRoot, runId);
  const reviewChanges = Array.isArray(manifest.execution?.reviewChanges)
    ? manifest.execution.reviewChanges
    : [];
  if (!reviewChanges.length) return manifest;
  const updated = reviewChanges.map((item, index) => (
    index === reviewChanges.length - 1
      ? { ...item, ...patch, status }
      : item
  ));
  return updateRunExecution({
    runsRoot,
    runId,
    executionPatch: { reviewChanges: updated },
    event,
    message,
  });
}

export async function reviseRun({
  vaultRoot,
  runsRoot,
  runId,
  revisionInvocationBuilder = buildAgyRevisionInvocation,
  processRunner = runProcess,
  dependencyReconciler = reconcileProjectDependencies,
  recoveryInvocationBuilder = buildAgyRecoveryInvocation,
  maxAutomaticRecoveryAttempts = configuredAutomaticRecoveryAttempts(),
}) {
  let manifest = getRun(runsRoot, runId);
  if (manifest.state !== RUN_STATES.CHANGES_REQUESTED) {
    throw new Error(`Run ${runId} harus CHANGES_REQUESTED sebelum revisi; state ${manifest.state}.`);
  }
  const repository = manifest.execution?.workspace?.path;
  if (!repository || !fs.existsSync(repository)) {
    throw new Error("Review revision membutuhkan isolated worktree yang masih aktif.");
  }
  const eventLogPath = path.join(runsRoot, "events", `${runId}.jsonl`);
  const workspaceBaseline = snapshotFromObject(manifest.execution.workspace.baseline);
  const beforeRevisionSnapshot = repositorySnapshot(repository);
  let graphifyContext = "";
  const reviewChange = manifest.execution.reviewChanges.at(-1);

  manifest = transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.RUNNING,
    executionPatch: {
      result: { status: "REVISING", iteration: reviewChange.iteration },
      workspace: { ...manifest.execution.workspace, state: "ACTIVE" },
    },
    message: `review revision iteration ${reviewChange.iteration} dimulai.`,
  });

  try {
    let graphifyQuery = { skipped: true, reason: "Graphify disabled for project." };
    if (manifest.project.graphify) {
      const question = [buildGraphifyQuestion(manifest), reviewChange.reason].filter(Boolean).join(" ");
      const result = await processRunner({
        command: "graphify",
        args: ["query", question, "--budget", "1200"],
        cwd: repository,
        stage: `review-revision-graphify-query:${reviewChange.iteration}`,
        eventLogPath,
      });
      graphifyQuery = { question, exitCode: result.exitCode };
      if (result.exitCode !== 0) {
        throw new Error(`Graphify query gagal dengan exit code ${result.exitCode}: ${result.stderrTail.trim()}`);
      }
      graphifyContext = pruneGraphifyContext(result.stdoutTail.trim());
    }

    const invocation = revisionInvocationBuilder(manifest, vaultRoot, { repository, graphifyContext });
    const agent = await processRunner({
      ...invocation,
      cwd: repository,
      stage: `review-revision-agent:${reviewChange.iteration}`,
      eventLogPath,
    });
    const telemetry = createAgentTelemetryRecord({
      stage: "REVIEW_REVISION",
      result: agent,
      agentConfig: invocation.agentConfig ?? null,
      invocationId: `${runId}:review-revision:${reviewChange.iteration}`,
      metadata: {
        runId,
        taskId: manifest.task?.id ?? null,
        projectId: manifest.project?.id ?? null,
        iteration: reviewChange.iteration,
      },
    });
    manifest = appendRunTelemetry({ runsRoot, runId, record: telemetry });
    if (agent.exitCode !== 0) {
      throw new Error(`Review revision agent gagal dengan exit code ${agent.exitCode}: ${agent.stderrTail.trim()}`);
    }
    if (/no output produced|auto-denied|denied permission|permission.*required/i.test(agent.stderrTail)) {
      throw new Error(`Review revision agent terhenti karena permission headless: ${agent.stderrTail.trim()}`);
    }

    const afterAgentSnapshot = repositorySnapshot(repository);
    const revisionChangedPaths = changedPaths(beforeRevisionSnapshot, afterAgentSnapshot);
    if (!revisionChangedPaths.length) {
      throw new Error("Request changes tidak menghasilkan perubahan baru pada isolated worktree.");
    }
    const allowedPaths = Array.isArray(manifest.task.allowedPaths) ? manifest.task.allowedPaths : [];
    const preliminaryScopeAudit = createScopeAudit({
      beforeSnapshot: workspaceBaseline,
      afterSnapshot: afterAgentSnapshot,
      allowedPaths,
      requiresChanges: manifest.task.requiresChanges === true,
      agentChangedPaths: revisionChangedPaths,
    });
    appendEvent(eventLogPath, {
      event: "REVIEW_REVISION_SCOPE_AUDIT",
      iteration: reviewChange.iteration,
      revisionChangedPaths,
      ...preliminaryScopeAudit,
    });
    if (preliminaryScopeAudit.outOfScopePaths.length) {
      throw new Error(`Scope guard menolak revisi di luar allowed_paths: ${preliminaryScopeAudit.outOfScopePaths.join(", ")}.`);
    }

    const revisions = Array.isArray(manifest.execution?.revisions) ? manifest.execution.revisions : [];
    manifest = transitionRun({
      vaultRoot,
      runsRoot,
      runId,
      toState: RUN_STATES.VERIFYING,
      executionPatch: {
        graphifyQuery,
        scopeAudit: { ...preliminaryScopeAudit, revisionChangedPaths },
        revisions: [
          ...revisions,
          {
            iteration: reviewChange.iteration,
            feedback: reviewChange.reason,
            changedPaths: revisionChangedPaths,
            agent: {
              exitCode: agent.exitCode,
              finalResult: agent.finalResult ?? null,
              configuration: invocation.agentConfig ?? null,
              resumedConversationId: invocation.conversationId ?? null,
            },
            telemetryRecordId: telemetry.recordId,
          },
        ],
      },
      message: `review revision iteration ${reviewChange.iteration} selesai; verifikasi dimulai.`,
    });

    const dependencyReconciliation = await dependencyReconciler({
      repository,
      changedPaths: revisionChangedPaths,
      processRunner,
      eventLogPath,
    });
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: { dependencyReconciliation },
      event: "REVIEW_REVISION_DEPENDENCY_RESULT",
      message: dependencyReconciliation.skipped
        ? dependencyReconciliation.reason
        : `${dependencyReconciliation.command} selesai dengan exit code ${dependencyReconciliation.exitCode}.`,
    });
    if (!dependencyReconciliation.skipped && dependencyReconciliation.exitCode !== 0) {
      throw new Error(
        `Dependency reconciliation gagal dengan exit code ${dependencyReconciliation.exitCode}.`
        + (dependencyReconciliation.diagnostic ? `\n${dependencyReconciliation.diagnostic}` : ""),
      );
    }

    const scopeAudit = createScopeAudit({
      beforeSnapshot: workspaceBaseline,
      afterSnapshot: repositorySnapshot(repository),
      allowedPaths,
      requiresChanges: manifest.task.requiresChanges === true,
      agentChangedPaths: revisionChangedPaths,
    });
    scopeAudit.revisionChangedPaths = revisionChangedPaths;
    appendEvent(eventLogPath, { event: "REVIEW_REVISION_SCOPE_AUDIT_COMPLETED", ...scopeAudit });
    if (scopeAudit.outOfScopePaths.length) {
      throw new Error(`Scope guard menolak revisi di luar allowed_paths: ${scopeAudit.outOfScopePaths.join(", ")}.`);
    }
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: { scopeAudit },
      event: "REVIEW_REVISION_SCOPE_AUDIT_COMPLETED",
    });

    manifest = await verifyAndRefresh({
      vaultRoot,
      runsRoot,
      manifest,
      processRunner,
      eventLogPath,
      repository,
    });
    return updateReviewRevisionRecord({
      runsRoot,
      runId,
      status: "VERIFIED",
      patch: { finishedAt: new Date().toISOString(), changedPaths: revisionChangedPaths },
      event: "REVIEW_REVISION_VERIFIED",
      message: `review revision iteration ${reviewChange.iteration} siap direview ulang.`,
    });
  } catch (error) {
    const current = getRun(runsRoot, runId);
    if (
      maxAutomaticRecoveryAttempts > 0
      && canAutomaticallyRecover(current, error)
    ) {
      try {
        await attemptAutomaticRecovery({
          vaultRoot,
          runsRoot,
          runId,
          initialError: error,
          repository,
          beforeSnapshot: workspaceBaseline,
          graphifyContext,
          processRunner,
          dependencyReconciler,
          recoveryInvocationBuilder,
          maxAgentAttempts: maxAutomaticRecoveryAttempts,
          eventLogPath,
        });
        return updateReviewRevisionRecord({
          runsRoot,
          runId,
          status: "VERIFIED",
          patch: { finishedAt: new Date().toISOString(), recovered: true },
          event: "REVIEW_REVISION_VERIFIED",
          message: `review revision iteration ${reviewChange.iteration} pulih dan siap direview ulang.`,
        });
      } catch (recoveryError) {
        failExecution({ vaultRoot, runsRoot, runId, eventLogPath, error: recoveryError });
        updateReviewRevisionRecord({
          runsRoot,
          runId,
          status: "FAILED",
          patch: { finishedAt: new Date().toISOString(), error: recoveryError.message },
          event: "REVIEW_REVISION_FAILED",
          message: recoveryError.message,
        });
        throw recoveryError;
      }
    }
    failExecution({ vaultRoot, runsRoot, runId, eventLogPath, error });
    updateReviewRevisionRecord({
      runsRoot,
      runId,
      status: "FAILED",
      patch: { finishedAt: new Date().toISOString(), error: error.message },
      event: "REVIEW_REVISION_FAILED",
      message: error.message,
    });
    throw error;
  }
}

export async function recoverRun({
  vaultRoot,
  runsRoot,
  runId,
  recoveredBy = "user",
  force = false,
  processRunner = runProcess,
  dependencyReconciler = reconcileProjectDependencies,
}) {
  const failed = getRun(runsRoot, runId);
  if (failed.state !== RUN_STATES.FAILED) {
    throw new Error(`Recovery membutuhkan run FAILED; state ${failed.state}.`);
  }
  const previousError = String(failed.execution?.result?.error ?? "Unknown failure");
  const previousScope = failed.execution?.scopeAudit;
  if (!failed.execution?.agent || !previousScope) {
    throw new Error("Recovery verification tidak aman karena coding agent atau scope audit belum selesai; gunakan retry.");
  }
  if (previousScope.outOfScopePaths?.length) {
    throw new Error("Recovery ditolak karena run sebelumnya memiliki perubahan di luar scope.");
  }
  const recoverableStage = /^(Verification gagal|Graphify update gagal|Dependency reconciliation gagal)/i.test(previousError);
  if (!recoverableStage) {
    throw new Error("Failure bukan berasal dari dependency, verification, atau Graphify; gunakan retry untuk mengulang coding agent.");
  }
  const baseChangedPaths = Array.isArray(previousScope.changedPaths) ? previousScope.changedPaths : [];
  const dependencyRecovery = baseChangedPaths.includes("package.json");
  if (!dependencyRecovery && !/Graphify update gagal/i.test(previousError) && !force) {
    throw new Error("Verification recovery memerlukan perbaikan eksternal yang sudah direview; gunakan --force.");
  }

  let manifest = beginFailedRunRecovery({ vaultRoot, runsRoot, runId, recoveredBy });
  const eventLogPath = path.join(runsRoot, "events", `${runId}.jsonl`);
  appendEvent(eventLogPath, {
    event: "RECOVERY_RESUMED",
    previousError,
    skipCodingAgent: true,
  });

  try {
    const repository = manifest.execution?.workspace?.path ?? manifest.project.repository;
    if (!fs.existsSync(repository)) {
      throw new Error("Isolated workspace recovery tidak tersedia; gunakan retry untuk membuat workspace baru.");
    }
    const beforeDependencySnapshot = repositorySnapshot(repository);
    const dependencyReconciliation = await dependencyReconciler({
      repository,
      changedPaths: baseChangedPaths,
      processRunner,
      eventLogPath,
      force: dependencyRecovery,
    });
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: { dependencyReconciliation },
      event: "DEPENDENCY_RECOVERY_RESULT",
      message: dependencyReconciliation.skipped
        ? dependencyReconciliation.reason
        : `${dependencyReconciliation.command} selesai dengan exit code ${dependencyReconciliation.exitCode}.`,
    });
    if (!dependencyReconciliation.skipped && dependencyReconciliation.exitCode !== 0) {
      throw new Error(`Dependency reconciliation gagal dengan exit code ${dependencyReconciliation.exitCode}.`);
    }

    const afterDependencySnapshot = repositorySnapshot(repository);
    const dependencyChangedPaths = changedPaths(beforeDependencySnapshot, afterDependencySnapshot);
    const allowedPaths = Array.isArray(manifest.task.allowedPaths) ? manifest.task.allowedPaths : [];
    const effectivePaths = effectiveAllowedPaths(allowedPaths);
    const combinedChangedPaths = [...new Set([...baseChangedPaths, ...dependencyChangedPaths])].sort();
    const outOfScopePaths = allowedPaths.length
      ? combinedChangedPaths.filter((filePath) => !pathAllowed(filePath, effectivePaths))
      : [];
    const scopeAudit = {
      ...previousScope,
      changedPaths: combinedChangedPaths,
      dependencyChangedPaths,
      automaticAllowedPaths: effectivePaths.filter((item) => !allowedPaths.includes(item)),
      effectiveAllowedPaths: effectivePaths,
      outOfScopePaths,
    };
    appendEvent(eventLogPath, { event: "RECOVERY_SCOPE_AUDIT", ...scopeAudit });
    if (outOfScopePaths.length) {
      throw new Error(`Scope guard menolak perubahan recovery di luar allowed_paths: ${outOfScopePaths.join(", ")}.`);
    }
    manifest = updateRunExecution({
      runsRoot,
      runId,
      executionPatch: { scopeAudit },
      event: "RECOVERY_SCOPE_AUDIT_COMPLETED",
    });

    return await verifyAndRefresh({
      vaultRoot,
      runsRoot,
      manifest,
      processRunner,
      eventLogPath,
      repository,
      recovery: true,
    });
  } catch (error) {
    failExecution({ vaultRoot, runsRoot, runId, eventLogPath, error, recovery: true });
    throw error;
  }
}
