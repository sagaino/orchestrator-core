import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTaskReadiness } from "./task-readiness.mjs";
import {
  DEFAULT_VAULT,
  ORCHESTRATOR_ROOT,
  STOP_WORDS,
  buildContext,
  buildPlan,
  chooseVerificationCommands,
  cleanCell,
  exists,
  fail,
  findRelevantKnowledge,
  getPackageScripts,
  listProjects,
  loadRegistry,
  parseFrontmatter,
  parseProjectRegistry,
  parseScalar,
  projectPageExists,
  projectPagePath,
  readGraphSummary,
  readMarkdown,
  readText,
  resolveTaskFile,
  splitTableRow,
  tokenize,
  validateProject,
  walkMarkdown,
} from "./core.mjs";

const ORCHESTRATOR_CLI = fileURLToPath(import.meta.url);

export {
  DEFAULT_VAULT,
  ORCHESTRATOR_ROOT,
  STOP_WORDS,
  buildContext,
  buildPlan,
  chooseVerificationCommands,
  cleanCell,
  exists,
  fail,
  findRelevantKnowledge,
  getPackageScripts,
  listProjects,
  loadRegistry,
  parseFrontmatter,
  parseProjectRegistry,
  parseScalar,
  projectPageExists,
  projectPagePath,
  readGraphSummary,
  readMarkdown,
  readText,
  resolveTaskFile,
  splitTableRow,
  tokenize,
  validateProject,
  walkMarkdown,
};

function parseArguments(args) {
  const options = {
    vault: process.env.ORCHESTRATOR_VAULT ?? DEFAULT_VAULT,
    runs: process.env.ORCHESTRATOR_RUNS ?? path.join(ORCHESTRATOR_ROOT, "runs"),
    approvedBy: "user",
    decision: null,
    destination: null,
    targetPath: null,
    repositoryPath: null,
    blueprint: "frontend-vite",
    projectIdOverride: null,
    reason: null,
    projectId: null,
    autoStart: false,
    force: false,
    confirm: false,
    fixSafe: false,
    once: false,
    positional: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--vault") {
      options.vault = path.resolve(args[index + 1]);
      index += 1;
    } else if (args[index] === "--runs") {
      options.runs = path.resolve(args[index + 1]);
      index += 1;
    } else if (args[index] === "--by") {
      options.approvedBy = args[index + 1];
      index += 1;
    } else if (args[index] === "--decision") {
      options.decision = args[index + 1];
      index += 1;
    } else if (args[index] === "--destination") {
      options.destination = args[index + 1];
      index += 1;
    } else if (args[index] === "--target") {
      options.targetPath = args[index + 1];
      index += 1;
    } else if (args[index] === "--path") {
      options.repositoryPath = path.resolve(args[index + 1]);
      index += 1;
    } else if (args[index] === "--blueprint") {
      options.blueprint = args[index + 1];
      index += 1;
    } else if (args[index] === "--id") {
      options.projectIdOverride = args[index + 1];
      index += 1;
    } else if (args[index] === "--reason") {
      options.reason = args[index + 1];
      index += 1;
    } else if (args[index] === "--project") {
      options.projectId = args[index + 1];
      index += 1;
    } else if (args[index] === "--start") {
      options.autoStart = true;
    } else if (args[index] === "--force") {
      options.force = true;
    } else if (args[index] === "--confirm") {
      options.confirm = true;
    } else if (args[index] === "--fix-safe") {
      options.fixSafe = true;
    } else if (args[index] === "--once") {
      options.once = true;
    } else {
      options.positional.push(args[index]);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Personal AI Orchestrator MVP

Project onboarding:
  add-project existing <absolute-repository-path> [--id <project-id>] [--by <name>]
  add-project new <project-name> --path <absolute-target-path> [--blueprint frontend-vite] [--by <name>]
  remove-project <project-id> [--by <name>]
  purge-project-archive <project-id> --confirm [--by <name>]

Conversational flow:
  request-task <project-id> <request> [--start] [--by <name>]
  status [task-id] [--project <project-id>]
  review [task-id] [--project <project-id>]
  preview <task-id> [--project <project-id>]
  request-changes <task-id> --reason <text> [--by <name>]
  accept [run-id-or-task-id] [--decision <value>] [--destination <value>] [--target <path>] [--by <name>]
  reject [run-id-or-task-id] [--reason <text>] [--by <name>]
  notifications
  notification-read <notification-id|task-id|all> [--by <name>]
  notification-test
  telemetry [run-id-or-task-id] [--project <project-id>]
  knowledge-health [--fix-safe] [--by <name>]
  knowledge-candidates
  knowledge-review <candidate-id>
  promote-knowledge <candidate-id> [--target <path>] [--by <name>]
  reject-knowledge <candidate-id> [--reason <text>] [--by <name>]
  recover <run-id-or-task-id> [--by <name>] [--force]
  retry <run-id-or-task-id> [--by <name>] [--force]

Direct flow:
  start-task <project-id> <task-id-or-path> [--by <name>]

Read-only commands:
  projects
  context <project-id> <task-id-or-path>
  plan <project-id> <task-id-or-path>
  validate-task <project-id> <task-id-or-path>
  knowledge-health
  knowledge-review <candidate-id>
  runs

Advanced lifecycle commands:
  prepare <project-id> <task-id-or-path>
  approve <run-id> [--by <name>]
  claim <run-id>
  execute <run-id>
  reject-review <run-id> [--reason <text>] [--by <name>]
  retrospect <run-id>
  approve-knowledge <run-id> [options]
  sync-wiki <run-id>
  complete <run-id> [--by <name>]
  watch [--once]
  daemon <install|start|status|stop|uninstall>

Options:
  --vault <path>        Override Obsidian Vault path
  --runs <path>         Override run manifest directory
  --path <path>         Absolute target path untuk project baru
  --id <project-id>     Override ID saat mendaftarkan existing project
  --blueprint <name>    Blueprint project baru; default frontend-vite
  --project <id>        Narrow status/review/telemetry to one project
  --start               Queue a conversational task for background execution
  --force               Izinkan recovery/retry setelah review worktree
  --confirm             Konfirmasi eksplisit purge archive dari Vault
  --fix-safe            Perbaiki index saja dan catat lint; tidak mengubah isi knowledge
  --by <name>           Record requester atau approver identity
  --reason <text>       Record rejection atau request-changes feedback
  --decision <value>    NEW | UPDATE | PROJECT_ONLY | IGNORE
  --destination <value> WIKI | CANDIDATE | PROJECT | NONE
  --target <path>       Approved Wiki target path
  --once                Scan task READY sekali lalu berhenti
`);
}

function reportOnboardingProgress(event) {
  const symbols = {
    STARTED: "→",
    RUNNING: "…",
    COMPLETED: "✓",
    FAILED: "✗",
  };
  const elapsed = event.elapsedSeconds > 0 ? ` (${event.elapsedSeconds}s)` : "";
  console.error(`[onboarding] ${symbols[event.state] ?? "•"} ${event.label}${elapsed}`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  try {
    const options = parseArguments(rest);
    let result;
    if (command === "purge-project-archive") {
      const [projectId] = options.positional;
      if (!projectId) fail("Command purge-project-archive membutuhkan <project-id>");
      const { purgeProjectArchive } = await import("./project-onboarding.mjs");
      result = purgeProjectArchive({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        projectId,
        purgedBy: options.approvedBy,
        confirmed: options.confirm,
      });
    } else if (command === "remove-project") {
      const [projectId] = options.positional;
      if (!projectId) fail("Command remove-project membutuhkan <project-id>");
      const { removeProject } = await import("./project-onboarding.mjs");
      result = removeProject({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        projectId,
        removedBy: options.approvedBy,
      });
    } else if (command === "add-project") {
      const [mode, subject] = options.positional;
      const { addExistingProject, addNewProject } = await import("./project-onboarding.mjs");
      if (mode === "existing") {
        if (!subject) fail("Command add-project existing membutuhkan <absolute-repository-path>");
        result = await addExistingProject({
          vaultRoot: options.vault,
          runsRoot: options.runs,
          repositoryPath: subject,
          projectId: options.projectIdOverride,
          registeredBy: options.approvedBy,
          onProgress: reportOnboardingProgress,
        });
      } else if (mode === "new") {
        if (!subject || !options.repositoryPath) {
          fail("Command add-project new membutuhkan <project-name> dan --path <absolute-target-path>");
        }
        result = await addNewProject({
          vaultRoot: options.vault,
          runsRoot: options.runs,
          projectName: subject,
          targetPath: options.repositoryPath,
          blueprint: options.blueprint,
          registeredBy: options.approvedBy,
          onProgress: reportOnboardingProgress,
        });
      } else {
        fail("Mode add-project harus existing atau new");
      }
    } else if (command === "projects") {
      result = listProjects(options.vault);
    } else if (command === "context" || command === "plan") {
      const [projectId, taskInput] = options.positional;
      if (!projectId || !taskInput) fail(`Command ${command} membutuhkan <project-id> dan <task-id-or-path>`);
      const context = buildContext(options.vault, projectId, taskInput);
      result = command === "context" ? context : { context, plan: buildPlan(context) };
    } else if (command === "validate-task") {
      const [projectId, taskInput] = options.positional;
      if (!projectId || !taskInput) fail("Command validate-task membutuhkan <project-id> dan <task-id-or-path>");
      const context = buildContext(options.vault, projectId, taskInput);
      result = validateTaskReadiness(context, { readMarkdown });
    } else if (command === "request-task") {
      const [projectId, ...requestParts] = options.positional;
      const request = requestParts.join(" ").trim();
      if (!projectId || !request) fail("Command request-task membutuhkan <project-id> dan <request>");
      const project = listProjects(options.vault).projects.find((item) => item.id === projectId);
      if (!project) fail("Project tidak ditemukan di registry", { projectId });
      const { requestTask } = await import("./task-intake.mjs");
      result = await requestTask({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        project,
        request,
        requestedBy: options.approvedBy,
        autoStart: options.autoStart,
        readMarkdown,
        validateTask: (resolvedProjectId, taskPath) => validateTaskReadiness(
          buildContext(options.vault, resolvedProjectId, taskPath),
          { readMarkdown },
        ),
      });
    } else if (command === "status" || command === "review") {
      const [selector] = options.positional;
      const { interactionStatus } = await import("./interaction.mjs");
      result = interactionStatus({ runsRoot: options.runs, selector, projectId: options.projectId });
    } else if (command === "preview") {
      const [selector] = options.positional;
      if (!selector) fail("Command preview membutuhkan task ID atau run ID");
      const { resolveRunSelector } = await import("./interaction.mjs");
      const runId = resolveRunSelector({
        runsRoot: options.runs,
        selector,
        projectId: options.projectId,
      }).runId;
      const { previewReviewWorkspace } = await import("./review-workflow.mjs");
      result = await previewReviewWorkspace({ runsRoot: options.runs, runId });
    } else if (command === "request-changes") {
      const [selector] = options.positional;
      if (!selector) fail("Command request-changes membutuhkan task ID atau run ID");
      if (!String(options.reason ?? "").trim()) fail("Command request-changes membutuhkan --reason <feedback>");
      const { resolveRunSelector } = await import("./interaction.mjs");
      const runId = resolveRunSelector({
        runsRoot: options.runs,
        selector,
        projectId: options.projectId,
        actionable: true,
      }).runId;
      const { requestChangesTaskRun } = await import("./task-workflow.mjs");
      result = await requestChangesTaskRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        requestedBy: options.approvedBy,
        reason: options.reason,
      });
    } else if (command === "notifications") {
      const { listNotifications } = await import("./notification-service.mjs");
      result = listNotifications({ runsRoot: options.runs });
    } else if (command === "notification-read") {
      const [selector = "all"] = options.positional;
      const { acknowledgeNotifications } = await import("./notification-service.mjs");
      result = acknowledgeNotifications({
        runsRoot: options.runs,
        selector,
        readBy: options.approvedBy,
      });
    } else if (command === "notification-test") {
      const { emitTestNotification } = await import("./notification-service.mjs");
      result = await emitTestNotification({ runsRoot: options.runs });
    } else if (command === "telemetry") {
      const [selector] = options.positional;
      const { telemetryReport } = await import("./telemetry.mjs");
      result = telemetryReport({
        runsRoot: options.runs,
        selector,
        projectId: options.projectId,
      });
    } else if (command === "knowledge-health") {
      const { knowledgeHealth } = await import("./knowledge-quality.mjs");
      result = knowledgeHealth({
        vaultRoot: options.vault,
        fixSafe: options.fixSafe,
        fixedBy: options.approvedBy,
      });
    } else if (command === "knowledge-candidates") {
      const { listKnowledgeCandidates } = await import("./knowledge-workflow.mjs");
      result = listKnowledgeCandidates({ vaultRoot: options.vault });
    } else if (command === "knowledge-review") {
      const [selector] = options.positional;
      if (!selector) fail("Command knowledge-review membutuhkan candidate ID atau path");
      const { reviewKnowledgeCandidate } = await import("./knowledge-quality.mjs");
      result = reviewKnowledgeCandidate({ vaultRoot: options.vault, selector });
    } else if (command === "promote-knowledge") {
      const [selector] = options.positional;
      if (!selector) fail("Command promote-knowledge membutuhkan candidate ID atau path");
      const { promoteKnowledgeCandidate } = await import("./knowledge-workflow.mjs");
      result = promoteKnowledgeCandidate({
        vaultRoot: options.vault,
        selector,
        approvedBy: options.approvedBy,
        targetPath: options.targetPath,
      });
    } else if (command === "reject-knowledge") {
      const [selector] = options.positional;
      if (!selector) fail("Command reject-knowledge membutuhkan candidate ID atau path");
      const { rejectKnowledgeCandidate } = await import("./knowledge-workflow.mjs");
      result = rejectKnowledgeCandidate({
        vaultRoot: options.vault,
        selector,
        rejectedBy: options.approvedBy,
        reason: options.reason,
      });
    } else if (command === "recover") {
      const [selector] = options.positional;
      if (!selector) fail("Command recover membutuhkan run ID atau task ID");
      const { resolveRunSelector } = await import("./interaction.mjs");
      const runId = resolveRunSelector({
        runsRoot: options.runs,
        selector,
        projectId: options.projectId,
      }).runId;
      const { recoverTaskRun } = await import("./task-workflow.mjs");
      result = await recoverTaskRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        recoveredBy: options.approvedBy,
        force: options.force,
      });
      const { JOB_STATES, updateJobForRun } = await import("./job-queue.mjs");
      updateJobForRun(options.runs, runId, {
        state: result.state === "FAILED" ? JOB_STATES.FAILED : JOB_STATES.REVIEW,
        runState: result.state,
        error: result.execution?.result?.error ?? null,
      });
    } else if (command === "retry") {
      const [selector] = options.positional;
      if (!selector) fail("Command retry membutuhkan run ID atau task ID");
      const { resolveRunSelector } = await import("./interaction.mjs");
      const runId = resolveRunSelector({
        runsRoot: options.runs,
        selector,
        projectId: options.projectId,
      }).runId;
      const { retryTaskRun } = await import("./task-workflow.mjs");
      result = await retryTaskRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        requestedBy: options.approvedBy,
        force: options.force,
      });
    } else if (command === "start-task") {
      const [projectId, taskInput] = options.positional;
      if (!projectId || !taskInput) fail("Command start-task membutuhkan <project-id> dan <task-id-or-path>");
      const { startTaskRun } = await import("./task-workflow.mjs");
      result = await startTaskRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        projectId,
        taskInput,
        approvedBy: options.approvedBy,
        services: { readMarkdown, buildContext, buildPlan, validateTaskReadiness },
      });
    } else if (command === "prepare") {
      const [projectId, taskInput] = options.positional;
      if (!projectId || !taskInput) fail("Command prepare membutuhkan <project-id> dan <task-id-or-path>");
      const { prepareRun } = await import("./run-manager.mjs");
      result = prepareRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        projectId,
        taskInput,
        services: { readMarkdown, buildContext, buildPlan, validateTaskReadiness },
      });
    } else if (command === "approve") {
      const [runId] = options.positional;
      if (!runId) fail("Command approve membutuhkan <run-id>");
      const { approveRun } = await import("./run-manager.mjs");
      result = approveRun({ runsRoot: options.runs, runId, approvedBy: options.approvedBy });
    } else if (command === "claim") {
      const [runId] = options.positional;
      if (!runId) fail("Command claim membutuhkan <run-id>");
      const { claimRun } = await import("./run-manager.mjs");
      result = claimRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        services: { readMarkdown, buildContext, buildPlan, validateTaskReadiness },
      });
    } else if (command === "execute") {
      const [runId] = options.positional;
      if (!runId) fail("Command execute membutuhkan <run-id>");
      const { executeRun } = await import("./executor.mjs");
      result = await executeRun({ vaultRoot: options.vault, runsRoot: options.runs, runId });
    } else if (command === "reject-review" || command === "reject") {
      const [selector] = options.positional;
      let runId = selector;
      if (command === "reject") {
        const { resolveRunSelector } = await import("./interaction.mjs");
        runId = resolveRunSelector({
          runsRoot: options.runs,
          selector,
          projectId: options.projectId,
          actionable: true,
        }).runId;
      }
      if (!runId) fail(`Command ${command} membutuhkan run yang dapat direview`);
      const { rejectTaskRun } = await import("./task-workflow.mjs");
      result = await rejectTaskRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        rejectedBy: options.approvedBy,
        reason: options.reason,
      });
      if (command === "reject") {
        const { JOB_STATES, updateJobForRun } = await import("./job-queue.mjs");
        updateJobForRun(options.runs, runId, { state: JOB_STATES.FAILED, runState: result.state });
      }
    } else if (command === "retrospect") {
      const [runId] = options.positional;
      if (!runId) fail("Command retrospect membutuhkan <run-id>");
      const { retrospectRun } = await import("./knowledge-workflow.mjs");
      result = await retrospectRun({ vaultRoot: options.vault, runsRoot: options.runs, runId });
    } else if (command === "approve-knowledge") {
      const [runId] = options.positional;
      if (!runId) fail("Command approve-knowledge membutuhkan <run-id>");
      const { approveKnowledgeRun } = await import("./knowledge-workflow.mjs");
      result = approveKnowledgeRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        approvedBy: options.approvedBy,
        decision: options.decision,
        destination: options.destination,
        targetPath: options.targetPath,
      });
    } else if (command === "sync-wiki") {
      const [runId] = options.positional;
      if (!runId) fail("Command sync-wiki membutuhkan <run-id>");
      const { syncWikiRun } = await import("./knowledge-workflow.mjs");
      result = syncWikiRun({ vaultRoot: options.vault, runsRoot: options.runs, runId });
    } else if (command === "complete") {
      const [runId] = options.positional;
      if (!runId) fail("Command complete membutuhkan <run-id>");
      const { completeRun } = await import("./knowledge-workflow.mjs");
      result = await completeRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        completedBy: options.approvedBy,
      });
    } else if (command === "accept") {
      const [selector] = options.positional;
      const { resolveRunSelector } = await import("./interaction.mjs");
      const runId = resolveRunSelector({
        runsRoot: options.runs,
        selector,
        projectId: options.projectId,
        actionable: true,
      }).runId;
      const { acceptRun } = await import("./knowledge-workflow.mjs");
      result = await acceptRun({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        runId,
        approvedBy: options.approvedBy,
        decision: options.decision,
        destination: options.destination,
        targetPath: options.targetPath,
      });
      const { JOB_STATES, updateJobForRun } = await import("./job-queue.mjs");
      updateJobForRun(options.runs, runId, { state: JOB_STATES.DONE, runState: result.state });
    } else if (command === "runs") {
      const { listRuns } = await import("./run-manager.mjs");
      result = {
        schemaVersion: 1,
        runsRoot: options.runs,
        runs: listRuns(options.runs),
      };
    } else if (command === "daemon") {
      const [action = "status"] = options.positional;
      const {
        daemonStatus,
        installDaemonService,
        startDaemon,
        stopDaemon,
        uninstallDaemonService,
      } = await import("./daemon.mjs");
      if (action === "install") {
        result = await installDaemonService({
          vaultRoot: options.vault,
          runsRoot: options.runs,
          cliPath: ORCHESTRATOR_CLI,
        });
      } else if (action === "start") {
        result = await startDaemon({
          vaultRoot: options.vault,
          runsRoot: options.runs,
          cliPath: ORCHESTRATOR_CLI,
        });
      } else if (action === "status") {
        result = daemonStatus({ runsRoot: options.runs });
      } else if (action === "stop") {
        result = await stopDaemon({ runsRoot: options.runs });
      } else if (action === "uninstall") {
        result = await uninstallDaemonService({ runsRoot: options.runs });
      } else {
        fail(`Daemon action tidak dikenal: ${action}`);
      }
    } else if (command === "daemon-worker") {
      const { runDaemonWorker } = await import("./daemon.mjs");
      await runDaemonWorker({
        vaultRoot: options.vault,
        runsRoot: options.runs,
        services: { readMarkdown, buildContext, buildPlan, validateTaskReadiness },
      });
      return;
    } else if (command === "watch") {
      const { scanReadyTasks, watchReadyTasks } = await import("./adapters/vault-task-watcher.mjs");
      const services = { readMarkdown, buildContext, buildPlan, validateTaskReadiness };
      if (options.once) {
        const scan = scanReadyTasks(options.vault, services);
        result = {
          schemaVersion: 1,
          mode: "observe-only",
          event: "TASK_READY_SCAN_COMPLETED",
          scannedAt: new Date().toISOString(),
          eventCount: scan.events.length,
          errorCount: scan.errors.length,
          ...scan,
        };
      } else {
        console.log(JSON.stringify({
          schemaVersion: 1,
          event: "WATCHER_STARTED",
          mode: "observe-only",
          vault: options.vault,
          warning: "Observe-only: event TASK_READY tidak otomatis melakukan prepare, approve, claim, atau execute.",
        }));
        const watcher = watchReadyTasks({
          vaultRoot: options.vault,
          services,
          onEvent: (event) => console.log(JSON.stringify(event)),
          onError: (error) => console.error(JSON.stringify({ event: "WATCHER_ERROR", ...error })),
        });
        const shutdown = async (signal) => {
          await watcher.close();
          console.log(JSON.stringify({ event: "WATCHER_STOPPED", signal }));
        };
        process.once("SIGINT", () => void shutdown("SIGINT"));
        process.once("SIGTERM", () => void shutdown("SIGTERM"));
        return;
      }
    } else {
      fail(`Command tidak dikenal: ${command}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, details: error.details ?? {} }, null, 2));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
