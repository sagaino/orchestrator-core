import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadyTaskEvent, ReadyTaskDeduplicator, scanReadyTasks } from "../src/adapters/vault-task-watcher.mjs";
import { buildContext, buildPlan, parseFrontmatter, readMarkdown } from "../src/orchestrator.mjs";
import { approveRun, claimRun, listRuns, prepareRun, RUN_STATES } from "../src/run-manager.mjs";
import {
  buildAgyRecoveryInvocation,
  buildAgyInvocation,
  buildAgyRevisionInvocation,
  configuredAutomaticRecoveryAttempts,
  effectiveAllowedPaths,
  executeRun,
  reconcileProjectDependencies,
  recoverRun,
  reviseRun,
} from "../src/executor.mjs";
import {
  configuredParallelWorkers,
  createParallelJobPool,
  daemonStatus,
  handoffReadyTask,
  parallelQueueStatus,
  processNextQueuedJob,
} from "../src/daemon.mjs";
import { resolveAgyConfig } from "../src/agent-config.mjs";
import { validateTaskReadiness } from "../src/task-readiness.mjs";
import { requestChangesTaskRun, rejectTaskRun, retryTaskRun, startTaskRun } from "../src/task-workflow.mjs";
import { previewReviewWorkspace } from "../src/review-workflow.mjs";
import {
  claimNextJob,
  enqueueTaskJob,
  getJob,
  JOB_STATES,
  reconcileJobs,
  updateJob,
  updateJobForRun,
} from "../src/job-queue.mjs";
import { interactionStatus, resolveRunSelector } from "../src/interaction.mjs";
import { requestTask } from "../src/task-intake.mjs";
import {
  acknowledgeNotifications,
  configuredNotificationDelivery,
  deliverDesktopNotification,
  emitNotification,
  listNotifications,
  notificationSummary,
  notifyKnowledgeCandidateReady,
  notifyTaskOutcome,
} from "../src/notification-service.mjs";
import { macOsNotifierPaths, runMacOsNotifier } from "../src/macos-notifier.mjs";
import {
  buildTelemetry,
  compactTelemetry,
  configuredTokenWarningThreshold,
  createAgentTelemetryRecord,
  telemetryReport,
} from "../src/telemetry.mjs";
import {
  acceptRun,
  approveKnowledgeRun,
  completeRun,
  listKnowledgeCandidates,
  parseRetrospectiveOutput,
  promoteKnowledgeCandidate,
  rejectKnowledgeCandidate,
  resolveKnowledgeRouting,
  retrospectRun,
  syncWikiRun,
} from "../src/knowledge-workflow.mjs";
import {
  findSimilarKnowledge,
  knowledgeHealth,
  reviewKnowledgeCandidate,
} from "../src/knowledge-quality.mjs";
import {
  addExistingProject,
  addNewProject,
  assertSafeStagedFiles,
  configuredOnboardingAiFallback,
  purgeProjectArchive,
  removeProject,
} from "../src/project-onboarding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "orchestrator.mjs");
const taskServices = { readMarkdown, buildContext, buildPlan, validateTaskReadiness };

assert.equal(configuredOnboardingAiFallback({}), true);
assert.equal(configuredOnboardingAiFallback({ ORCHESTRATOR_ONBOARDING_AI_FALLBACK: "off" }), false);
assert.throws(
  () => configuredOnboardingAiFallback({ ORCHESTRATOR_ONBOARDING_AI_FALLBACK: "sometimes" }),
  /harus true\/false/,
);

function writeOnboardingVaultFixture(vault) {
  fs.mkdirSync(path.join(vault, "01-Knowledge", "patterns", "frontend"), { recursive: true });
  fs.mkdirSync(path.join(vault, "02-Projects"), { recursive: true });
  fs.writeFileSync(path.join(vault, "project-registry.md"), [
    "---",
    "title: Project Registry",
    "type: registry",
    "tags: [registry]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    "sources: []",
    "---",
    "",
    "| project_id | project page | repository | agent | graphify | graphify output |",
    "|---|---|---|---|---|---|",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(vault, "index.md"), "# Fixture Index\n");
  fs.writeFileSync(path.join(vault, "wiki-log.md"), "# Fixture Wiki Log\n");
  fs.writeFileSync(
    path.join(vault, "01-Knowledge", "patterns", "frontend", "project-skeleton-template.md"),
    "---\ntitle: Fixture Blueprint\ntype: pattern\ntags: [fixture]\ncreated: 2026-08-15\nupdated: 2026-08-15\nsources: []\n---\n\n# Fixture Blueprint\n",
  );
}

const onboardingFixture = fs.mkdtempSync(path.join(os.tmpdir(), "personal-ai-onboarding-"));
try {
  const onboardingVault = path.join(onboardingFixture, "vault");
  const onboardingRuns = path.join(onboardingFixture, "runs");
  writeOnboardingVaultFixture(onboardingVault);

  const existingRepository = path.join(onboardingFixture, "existing-app");
  fs.mkdirSync(path.join(existingRepository, ".git"), { recursive: true });
  fs.writeFileSync(path.join(existingRepository, "package.json"), JSON.stringify({
    name: "existing-app",
    scripts: { typecheck: "tsc --noEmit", build: "vite build" },
    dependencies: { react: "latest" },
    devDependencies: { vite: "latest" },
  }, null, 2));
  const existingRunner = async (invocation) => {
    if (invocation.stage === "project-onboarding:graphify-update") {
      const output = path.join(invocation.cwd, "graphify-out", "graph.json");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, "{\"nodes\":[],\"links\":[]}\n");
    }
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  };
  const existingOnboarding = await addExistingProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    repositoryPath: existingRepository,
    registeredBy: "smoke-test",
    processRunner: existingRunner,
  });
  assert.equal(existingOnboarding.action, "EXISTING_PROJECT_ADDED");
  assert.equal(existingOnboarding.graphify.action, "BOOTSTRAPPED");
  assert.deepEqual(existingOnboarding.project.verificationDefaults, ["typecheck", "build"]);
  assert.ok(fs.existsSync(path.join(existingRepository, "graphify-out", "graph.json")));
  assert.ok(fs.existsSync(path.join(onboardingVault, "02-Projects", "existing-app", "tasks")));
  assert.match(fs.readFileSync(path.join(onboardingVault, "project-registry.md"), "utf8"), /`existing-app`/);

  const existingOnboardingAgain = await addExistingProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    repositoryPath: existingRepository,
    registeredBy: "smoke-test",
    processRunner: existingRunner,
  });
  assert.equal(existingOnboardingAgain.action, "EXISTING_PROJECT_UPDATED");
  assert.equal(existingOnboardingAgain.graphify.action, "REFRESHED");
  const registryAfterRerun = fs.readFileSync(path.join(onboardingVault, "project-registry.md"), "utf8");
  assert.equal((registryAfterRerun.match(/`existing-app`/g) ?? []).length, 1);
  const indexAfterRerun = fs.readFileSync(path.join(onboardingVault, "index.md"), "utf8");
  assert.equal((indexAfterRerun.match(/02-Projects\/existing-app\/project/g) ?? []).length, 1);

  const newParent = path.join(onboardingFixture, "new-projects");
  const newTarget = path.join(newParent, "dashboard-repository");
  fs.mkdirSync(newParent, { recursive: true });
  const newInvocations = [];
  const onboardingProgress = [];
  let dependencyPreflightAttempts = 0;
  const newRunner = async (invocation) => {
    newInvocations.push(invocation);
    if (invocation.stage === "project-onboarding:shadcn-init") {
      const generated = path.join(invocation.cwd, "new-dashboard");
      fs.mkdirSync(generated, { recursive: true });
      fs.writeFileSync(path.join(generated, "package.json"), JSON.stringify({
        name: "new-dashboard",
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          build: "vite build",
          test: "vitest run",
        },
        dependencies: {
          react: "latest",
          "react-i18next": "^15.4.1",
          typescript: "~6",
        },
        devDependencies: { vite: "latest" },
      }, null, 2));
      fs.writeFileSync(path.join(generated, ".gitignore"), "node_modules\n");
    } else if (invocation.stage === "project-onboarding:shadcn-add-all") {
      const uiPath = path.join(invocation.cwd, "src", "components", "ui");
      fs.mkdirSync(uiPath, { recursive: true });
      fs.writeFileSync(path.join(uiPath, "button.tsx"), "export const Button = () => null;\n");
    } else if (invocation.stage === "project-onboarding:dependency-preflight") {
      dependencyPreflightAttempts += 1;
      return {
        exitCode: 1,
        stdoutTail: "",
        stderrTail: "npm ERR! ERESOLVE unable to resolve dependency tree",
      };
    } else if (invocation.stage === "project-onboarding:dependency-preflight-retry") {
      dependencyPreflightAttempts += 1;
    } else if (invocation.stage === "project-onboarding:security-staged-files") {
      return { exitCode: 0, stdoutTail: ".env.example\npackage.json\n", stderrTail: "" };
    } else if (invocation.stage === "project-onboarding:git-init") {
      fs.mkdirSync(path.join(invocation.cwd, ".git"), { recursive: true });
    } else if (invocation.stage === "project-onboarding:graphify-update") {
      const output = path.join(invocation.cwd, "graphify-out", "graph.json");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, "{\"nodes\":[],\"links\":[]}\n");
    }
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  };
  const newOnboarding = await addNewProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectName: "New Dashboard",
    targetPath: newTarget,
    registeredBy: "smoke-test",
    processRunner: newRunner,
    onProgress: (event) => onboardingProgress.push(event),
  });
  assert.equal(newOnboarding.action, "NEW_PROJECT_CREATED");
  assert.equal(newOnboarding.project.shadcn.allComponents, true);
  assert.equal(newOnboarding.project.scaffoldMode, "DETERMINISTIC_TEMPLATE");
  assert.deepEqual(newOnboarding.project.verificationDefaults, ["typecheck", "lint", "build", "test"]);
  const shadcnAllInvocation = newInvocations.find((item) => item.stage === "project-onboarding:shadcn-add-all");
  assert.deepEqual(shadcnAllInvocation.args, ["-y", "shadcn@4.18.0", "add", "--all", "-y"]);
  assert.equal(newInvocations.some((item) => item.stage === "project-onboarding:blueprint-agent"), false);
  assert.equal(newOnboarding.agentFallback.used, false);
  assert.equal(newOnboarding.template.templateVersion, 2);
  assert.equal(newOnboarding.template.policyVersion, 3);
  const normalizedPackage = JSON.parse(fs.readFileSync(path.join(newTarget, "package.json"), "utf8"));
  assert.equal(normalizedPackage.dependencies["@hookform/resolvers"], "^5.7.1");
  assert.equal(normalizedPackage.dependencies["react-hook-form"], "^7.84.0");
  assert.equal(normalizedPackage.dependencies.sweetalert2, "^11.26.25");
  assert.equal(normalizedPackage.devDependencies.typescript, "~5.9.3");
  assert.equal(normalizedPackage.dependencies.typescript, undefined);
  assert.equal(newOnboarding.dependency.policy.corrected, true);
  assert.equal(newOnboarding.dependency.preflight.recovered, true);
  assert.equal(dependencyPreflightAttempts, 2);
  assert.ok(fs.existsSync(path.join(newTarget, ".git")));
  assert.equal(fs.existsSync(path.join(newTarget, ".env")), false);
  assert.ok(fs.existsSync(path.join(newTarget, ".env.example")));
  assert.ok(fs.existsSync(path.join(newTarget, "graphify-out", "graph.json")));
  assert.ok(fs.existsSync(path.join(newTarget, "src", "pages", "ProjectReady", "index.tsx")));
  assert.doesNotMatch(fs.readFileSync(path.join(newTarget, "src", "services", "auth.ts"), "utf8"), /dummy-token/);
  assert.doesNotMatch(fs.readFileSync(path.join(newTarget, "src", "lib", "axios.ts"), "utf8"), /localhost:3000/);
  assert.match(fs.readFileSync(path.join(newTarget, "tsconfig.app.json"), "utf8"), /"noUnusedLocals": false/);
  assert.match(fs.readFileSync(path.join(newTarget, ".gitignore"), "utf8"), /^graphify-out$/m);
  assert.match(fs.readFileSync(path.join(newTarget, ".gitignore"), "utf8"), /^\.env$/m);
  assert.match(fs.readFileSync(path.join(newTarget, ".gitignore"), "utf8"), /^\.env\.\*$/m);
  assert.match(fs.readFileSync(path.join(newTarget, ".gitignore"), "utf8"), /^!\.env\.example$/m);
  assert.equal(newOnboarding.security.stagedFilesChecked, 2);
  assert.ok(onboardingProgress.some((event) => event.state === "STARTED" && event.stage === "project-onboarding:shadcn-init"));
  assert.ok(onboardingProgress.some((event) => event.state === "COMPLETED" && event.stage === "project-onboarding:wiki-registration"));
  const newProjectPage = fs.readFileSync(path.join(onboardingVault, "02-Projects", "new-dashboard", "project.md"), "utf8");
  assert.match(newProjectPage, /blueprint: frontend-vite/);
  assert.match(newProjectPage, /template_version: 2/);
  assert.match(newProjectPage, /blueprint_policy_version: 3/);
  assert.match(newProjectPage, /scaffold_mode: DETERMINISTIC_TEMPLATE/);
  assert.equal(newOnboarding.telemetry, null);
  assert.ok(fs.existsSync(path.join(onboardingRuns, newOnboarding.auditPath)));
  assert.deepEqual(assertSafeStagedFiles([".env.example", "src/main.tsx"]).forbiddenFiles, []);
  assert.throws(() => assertSafeStagedFiles([".env", ".env.production"]), /Sensitive environment file/);

  const fallbackTarget = path.join(newParent, "fallback-dashboard-repository");
  const fallbackInvocations = [];
  let fallbackLintAttempt = 0;
  const fallbackRunner = async (invocation) => {
    fallbackInvocations.push(invocation);
    if (invocation.stage === "project-onboarding:shadcn-init") {
      const generated = path.join(invocation.cwd, "fallback-dashboard");
      fs.mkdirSync(generated, { recursive: true });
      fs.writeFileSync(path.join(generated, "package.json"), JSON.stringify({
        name: "fallback-dashboard",
        scripts: {},
        dependencies: { react: "latest" },
        devDependencies: { vite: "latest", typescript: "~6" },
      }, null, 2));
    } else if (invocation.stage === "project-onboarding:shadcn-add-all") {
      const uiPath = path.join(invocation.cwd, "src", "components", "ui");
      fs.mkdirSync(uiPath, { recursive: true });
      fs.writeFileSync(path.join(uiPath, "button.tsx"), "export const Button = () => null;\n");
    } else if (invocation.stage === "project-onboarding:verification:lint") {
      fallbackLintAttempt += 1;
      if (fallbackLintAttempt === 1) {
        return { exitCode: 1, stdoutTail: "", stderrTail: "fixture deterministic lint failure" };
      }
    } else if (invocation.stage === "project-onboarding:blueprint-agent") {
      return {
        exitCode: 0,
        stdoutTail: "",
        stderrTail: "",
        finalResult: {
          status: "SUCCESS",
          duration_seconds: 1,
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        },
      };
    } else if (invocation.stage === "project-onboarding:security-staged-files") {
      return { exitCode: 0, stdoutTail: ".env.example\npackage.json\n", stderrTail: "" };
    } else if (invocation.stage === "project-onboarding:git-init") {
      fs.mkdirSync(path.join(invocation.cwd, ".git"), { recursive: true });
    } else if (invocation.stage === "project-onboarding:graphify-update") {
      const output = path.join(invocation.cwd, "graphify-out", "graph.json");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, "{\"nodes\":[],\"links\":[]}\n");
    }
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  };
  const fallbackOnboarding = await addNewProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectName: "Fallback Dashboard",
    targetPath: fallbackTarget,
    registeredBy: "smoke-test",
    processRunner: fallbackRunner,
  });
  assert.equal(fallbackOnboarding.project.scaffoldMode, "DETERMINISTIC_WITH_AI_FALLBACK");
  assert.equal(fallbackOnboarding.agentFallback.used, true);
  assert.deepEqual(fallbackOnboarding.agentFallback.scopeAudit.outOfScope, []);
  assert.equal(fallbackOnboarding.dependency.repeatedAfterFallback, true);
  assert.equal(fallbackOnboarding.dependency.history.length, 2);
  assert.equal(fallbackOnboarding.telemetry.usage.totalTokens, 30);
  const fallbackAgentPrompt = fallbackInvocations.find((item) => item.stage === "project-onboarding:blueprint-agent").args[1];
  assert.match(fallbackAgentPrompt, /fixture deterministic lint failure/);
  assert.doesNotMatch(fallbackAgentPrompt, /<blueprint>/);

  assert.throws(() => purgeProjectArchive({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectId: "fallback-dashboard",
    purgedBy: "smoke-test",
    confirmed: true,
  }), /masih aktif/);

  const fallbackRemoval = removeProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectId: "fallback-dashboard",
    removedBy: "smoke-test",
    now: new Date("2026-08-15T01:00:00.000Z"),
  });
  assert.throws(() => purgeProjectArchive({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectId: "fallback-dashboard",
    purgedBy: "smoke-test",
  }), /--confirm/);
  const fallbackPurge = purgeProjectArchive({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectId: "fallback-dashboard",
    purgedBy: "smoke-test",
    confirmed: true,
    now: new Date("2026-08-15T01:30:00.000Z"),
  });
  assert.equal(fallbackPurge.action, "PROJECT_ARCHIVE_PURGED_FROM_VAULT");
  assert.equal(fallbackPurge.archive.fileCount, fallbackRemoval.archive.fileCount + 1);
  assert.equal(fs.existsSync(path.join(onboardingVault, "03-Sources", "other", "removed-projects", "fallback-dashboard")), false);
  assert.ok(fs.existsSync(path.join(onboardingRuns, fallbackPurge.quarantine.archivePath)));
  assert.ok(fs.existsSync(path.join(onboardingRuns, fallbackPurge.quarantine.path, "purge-manifest.json")));
  assert.ok(fs.existsSync(fallbackTarget));
  assert.ok(fs.existsSync(path.join(fallbackTarget, "graphify-out", "graph.json")));
  assert.doesNotMatch(fs.readFileSync(path.join(onboardingVault, "index.md"), "utf8"), /Fallback Dashboard Project Archive/);
  assert.match(fs.readFileSync(path.join(onboardingVault, "wiki-log.md"), "utf8"), /PROJECT_ARCHIVE_PURGED_FROM_VAULT/);
  assert.ok(fs.existsSync(path.join(onboardingRuns, fallbackPurge.auditPath)));

  const activeTaskPath = path.join(onboardingVault, "02-Projects", "new-dashboard", "tasks", "task-active.md");
  fs.writeFileSync(activeTaskPath, [
    "---",
    "title: Active removal guard",
    "type: task",
    "tags: [fixture]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    "sources: []",
    "task_id: REMOVE-GUARD",
    "project: new-dashboard",
    "status: READY",
    "dependencies: []",
    "---",
    "",
    "Related project: [[02-Projects/new-dashboard/project]].",
    "",
  ].join("\n"));
  const jobsPath = path.join(onboardingRuns, "jobs");
  fs.mkdirSync(jobsPath, { recursive: true });
  const activeJobPath = path.join(jobsPath, "remove-guard-job.json");
  fs.writeFileSync(activeJobPath, `${JSON.stringify({
    schemaVersion: 1,
    jobId: "remove-guard-job",
    projectId: "new-dashboard",
    taskId: "REMOVE-GUARD",
    state: "QUEUED",
    createdAt: "2026-08-15T00:00:00.000Z",
  }, null, 2)}\n`);
  let removalGuardError = null;
  try {
    removeProject({
      vaultRoot: onboardingVault,
      runsRoot: onboardingRuns,
      projectId: "new-dashboard",
      removedBy: "smoke-test",
    });
  } catch (error) {
    removalGuardError = error;
  }
  assert.match(removalGuardError?.message ?? "", /masih memiliki task\/job\/run aktif/);
  assert.ok(removalGuardError.details.blockers.some((item) => item.type === "TASK" && item.state === "READY"));
  assert.ok(removalGuardError.details.blockers.some((item) => item.type === "JOB" && item.state === "QUEUED"));
  fs.writeFileSync(activeTaskPath, fs.readFileSync(activeTaskPath, "utf8").replace("status: READY", "status: BACKLOG"));
  const completedJob = JSON.parse(fs.readFileSync(activeJobPath, "utf8"));
  fs.writeFileSync(activeJobPath, `${JSON.stringify({ ...completedJob, state: "DONE" }, null, 2)}\n`);

  const preservedKnowledgePath = path.join(onboardingVault, "01-Knowledge", "concepts", "new-dashboard-insight.md");
  const preservedRunSourcePath = path.join(onboardingVault, "03-Sources", "other", "orchestrator-runs", "new-dashboard-run.json");
  const immutableLegacyLinkPath = path.join(onboardingVault, "03-Sources", "other", "legacy-project-reference.md");
  fs.mkdirSync(path.dirname(preservedKnowledgePath), { recursive: true });
  fs.mkdirSync(path.dirname(preservedRunSourcePath), { recursive: true });
  fs.writeFileSync(preservedKnowledgePath, "# Preserved global knowledge\n\nSource task: [[02-Projects/new-dashboard/tasks/task-active]].\n");
  fs.writeFileSync(preservedRunSourcePath, "{\"runId\":\"new-dashboard-run\"}\n");
  fs.writeFileSync(immutableLegacyLinkPath, "# Immutable source\n\n[[02-Projects/new-dashboard/tasks/task-active]]\n");
  const removal = removeProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectId: "new-dashboard",
    removedBy: "smoke-test",
    now: new Date("2026-08-15T02:00:00.000Z"),
  });
  assert.equal(removal.action, "PROJECT_UNREGISTERED_AND_ARCHIVED");
  assert.equal(removal.project.active, false);
  assert.equal(removal.preservation.globalKnowledge, true);
  assert.equal(fs.existsSync(path.join(onboardingVault, "02-Projects", "new-dashboard")), false);
  assert.ok(fs.existsSync(path.join(onboardingVault, removal.archive.projectPage)));
  assert.ok(fs.existsSync(path.join(onboardingVault, removal.archive.manifest)));
  assert.ok(fs.existsSync(newTarget));
  assert.ok(fs.existsSync(path.join(newTarget, "graphify-out", "graph.json")));
  assert.ok(fs.existsSync(preservedKnowledgePath));
  assert.ok(fs.existsSync(preservedRunSourcePath));
  assert.match(fs.readFileSync(immutableLegacyLinkPath, "utf8"), /\[\[02-Projects\/new-dashboard\/tasks\/task-active\]\]/);
  assert.match(fs.readFileSync(preservedKnowledgePath, "utf8"), new RegExp(removal.archive.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const archivedTaskPath = path.join(onboardingVault, removal.archive.path, "tasks", "task-active.md");
  assert.doesNotMatch(fs.readFileSync(archivedTaskPath, "utf8"), /\[\[02-Projects\/new-dashboard\//);
  assert.doesNotMatch(fs.readFileSync(path.join(onboardingVault, "project-registry.md"), "utf8"), /`new-dashboard`/);
  const indexAfterRemoval = fs.readFileSync(path.join(onboardingVault, "index.md"), "utf8");
  assert.doesNotMatch(indexAfterRemoval, /\[\[02-Projects\/new-dashboard\//);
  assert.match(indexAfterRemoval, /New Dashboard Project Archive/);
  const removalManifest = JSON.parse(fs.readFileSync(path.join(onboardingVault, removal.archive.manifest), "utf8"));
  assert.ok(removalManifest.archive.inventory.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(fs.existsSync(path.join(onboardingRuns, removal.auditPath)));
  const removalHealth = knowledgeHealth({ vaultRoot: onboardingVault });
  assert.equal(removalHealth.findings.some((item) => (
    item.check === "BROKEN_WIKILINK" && item.path.endsWith("legacy-project-reference.md")
  )), false);
  let purgeBacklinkError = null;
  try {
    purgeProjectArchive({
      vaultRoot: onboardingVault,
      runsRoot: onboardingRuns,
      projectId: "new-dashboard",
      purgedBy: "smoke-test",
      confirmed: true,
    });
  } catch (error) {
    purgeBacklinkError = error;
  }
  assert.match(purgeBacklinkError?.message ?? "", /backlink/);
  assert.ok(purgeBacklinkError.details.backlinks.some((item) => item.reason === "ARCHIVE_WIKILINK"));
  assert.ok(purgeBacklinkError.details.backlinks.some((item) => item.reason === "LEGACY_PROJECT_WIKILINK"));
  assert.ok(fs.existsSync(path.join(onboardingVault, removal.archive.path)));

  const registryBeforeRemovalRollback = fs.readFileSync(path.join(onboardingVault, "project-registry.md"), "utf8");
  const indexBeforeRemovalRollback = fs.readFileSync(path.join(onboardingVault, "index.md"), "utf8");
  assert.throws(() => removeProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectId: "existing-app",
    removedBy: "smoke-test",
    now: new Date("2026-08-15T03:00:00.000Z"),
    auditWriter: () => {
      throw new Error("fixture audit failure");
    },
  }), /fixture audit failure/);
  assert.ok(fs.existsSync(path.join(onboardingVault, "02-Projects", "existing-app", "project.md")));
  assert.equal(fs.readFileSync(path.join(onboardingVault, "project-registry.md"), "utf8"), registryBeforeRemovalRollback);
  assert.equal(fs.readFileSync(path.join(onboardingVault, "index.md"), "utf8"), indexBeforeRemovalRollback);
  const existingArchiveRoot = path.join(onboardingVault, "03-Sources", "other", "removed-projects", "existing-app");
  assert.equal(fs.existsSync(existingArchiveRoot), false);

  const failedTarget = path.join(newParent, "broken-repository");
  const registryBeforeFailure = fs.readFileSync(path.join(onboardingVault, "project-registry.md"), "utf8");
  const failingRunner = async (invocation) => {
    if (invocation.stage === "project-onboarding:shadcn-init") {
      const generated = path.join(invocation.cwd, "broken-app");
      fs.mkdirSync(generated, { recursive: true });
      fs.writeFileSync(path.join(generated, "package.json"), "{\"name\":\"broken-app\"}\n");
      return { exitCode: 0, stdoutTail: "", stderrTail: "" };
    }
    if (invocation.stage === "project-onboarding:shadcn-add-all") {
      return { exitCode: 2, stdoutTail: "", stderrTail: "fixture shadcn failure" };
    }
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  };
  await assert.rejects(addNewProject({
    vaultRoot: onboardingVault,
    runsRoot: onboardingRuns,
    projectName: "Broken App",
    targetPath: failedTarget,
    registeredBy: "smoke-test",
    processRunner: failingRunner,
  }), /Shadcn add --all gagal/);
  assert.equal(fs.existsSync(failedTarget), false);
  assert.equal(fs.readFileSync(path.join(onboardingVault, "project-registry.md"), "utf8"), registryBeforeFailure);
  assert.equal(fs.readdirSync(newParent).some((name) => name.startsWith(".personal-ai-broken-app-")), false);
  const onboardingAudits = fs.readdirSync(path.join(onboardingRuns, "onboarding"))
    .filter((name) => name.startsWith("new-broken-app-") && name.endsWith(".json"));
  assert.equal(onboardingAudits.length, 1);
  assert.match(fs.readFileSync(path.join(onboardingRuns, "onboarding", onboardingAudits[0]), "utf8"), /NEW_PROJECT_FAILED/);
} finally {
  fs.rmSync(onboardingFixture, { recursive: true, force: true });
}

assert.deepEqual(parseFrontmatter([
  "---",
  "task_id: FE-014",
  "dependencies:",
  "  - FE-013",
  "verification:",
  "  - typecheck",
  "  - build",
  "---",
  "",
].join("\n")), {
  task_id: "FE-014",
  dependencies: ["FE-013"],
  verification: ["typecheck", "build"],
});

const invocationContract = buildAgyInvocation({
  runId: "contract-test",
  task: { path: "02-Projects/fixture/tasks/task-001.md", allowedPaths: ["README.md"] },
  project: { repository: "/tmp/fixture", agent: "agy" },
  retrieval: { knowledge: [] },
}, "/tmp/vault", { graphifyContext: "NODE README.md" });
const invocationPrompt = invocationContract.args[1];
assert.match(invocationPrompt, /NODE README\.md/);
assert.match(invocationPrompt, /Jangan gunakan terminal\/run_command/);
assert.doesNotMatch(invocationPrompt, /Query Graphify secara targeted sebelum mengedit/);
assert.ok(effectiveAllowedPaths(["package.json"]).includes("package-lock.json"));
assert.equal(invocationContract.args[invocationContract.args.indexOf("--model") + 1], "gemini-3.7-flash-high");
assert.equal(invocationContract.args[invocationContract.args.indexOf("--effort") + 1], "high");
const recoveryInvocationContract = buildAgyRecoveryInvocation({
  runId: "recovery-contract-test",
  task: { path: "02-Projects/fixture/tasks/task-001.md", allowedPaths: ["README.md"] },
  project: { repository: "/tmp/fixture", agent: "agy" },
  retrieval: { knowledge: [] },
  execution: { scopeAudit: { changedPaths: ["README.md"] } },
}, "/tmp/vault", {
  repository: "/tmp/worktree",
  graphifyContext: "NODE README.md",
  failure: "Verification gagal: npm run test",
  attempt: 1,
});
assert.match(recoveryInvocationContract.args[1], /Verification gagal: npm run test/);
assert.match(recoveryInvocationContract.args[1], /Allowed paths: README\.md/);
assert.match(recoveryInvocationContract.args[1], /jangan mengulang task dari awal/i);
assert.match(recoveryInvocationContract.args[1], /Jangan menggunakan terminal\/run_command/);
assert.equal(configuredAutomaticRecoveryAttempts({}), 2);
assert.equal(configuredAutomaticRecoveryAttempts({ ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS: "0" }), 0);
assert.throws(
  () => configuredAutomaticRecoveryAttempts({ ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS: "4" }),
  /integer antara 0 dan 3/,
);
assert.deepEqual(resolveAgyConfig({
  ORCHESTRATOR_AGY_MODEL: "gemini-3.7-flash-medium",
  ORCHESTRATOR_AGY_EFFORT: "medium",
}), { model: "gemini-3.7-flash-medium", effort: "medium" });
assert.throws(() => resolveAgyConfig({ ORCHESTRATOR_AGY_EFFORT: "maximum" }), /tidak valid/);
assert.equal(configuredNotificationDelivery({}), "inbox");
assert.equal(configuredNotificationDelivery({ ORCHESTRATOR_NOTIFICATION_DELIVERY: "auto" }), "auto");
assert.equal(configuredNotificationDelivery({ ORCHESTRATOR_NOTIFICATION_DELIVERY: "inbox" }), "inbox");
assert.throws(
  () => configuredNotificationDelivery({ ORCHESTRATOR_NOTIFICATION_DELIVERY: "email" }),
  /auto, desktop, atau inbox/,
);
let desktopInvocation = null;
const desktopDelivery = await deliverDesktopNotification({
  notificationId: "desktop-contract-test",
  title: "Task \"quoted\"",
  subtitle: "fixture-app",
  message: "Ready\nfor review",
}, {
  platform: "darwin",
  env: { ORCHESTRATOR_NOTIFICATION_DELIVERY: "desktop" },
  runsRoot: "/tmp/orchestrator-runs",
  nativeNotifier: async (...args) => {
    desktopInvocation = args;
    return { status: "ACCEPTED" };
  },
});
assert.equal(desktopDelivery.status, "ACCEPTED_BY_MACOS");
assert.equal(desktopDelivery.app, "Personal AI Orchestrator");
assert.equal(desktopInvocation[0].title, 'Task "quoted"');
assert.equal(desktopInvocation[0].message, "Ready for review");
assert.equal(desktopInvocation[1].runsRoot, "/tmp/orchestrator-runs");
const notifierPaths = macOsNotifierPaths("/tmp/orchestrator-runs");
assert.match(notifierPaths.appPath, /Personal AI Orchestrator\.app$/);
const notifierCalls = [];
const nativeResult = await runMacOsNotifier({
  notificationId: "native-contract-test",
  title: "Ready",
  subtitle: "fixture-app",
  message: "Review task",
}, {
  runsRoot: "/tmp/orchestrator-runs",
  appBuilder: async () => ({
    appPath: "/tmp/Personal AI Orchestrator.app",
    executablePath: "/tmp/Personal AI Orchestrator.app/Contents/MacOS/notifier",
    built: true,
  }),
  runner: async (command, args) => {
    notifierCalls.push({ command, args });
    return command === "open"
      ? { stdout: "", stderr: "" }
      : { stdout: '{"status":"ACCEPTED"}\n', stderr: "" };
  },
});
assert.equal(nativeResult.status, "ACCEPTED");
assert.equal(notifierCalls[0].command, "open");
assert.ok(notifierCalls[0].args.includes("--register-only"));
assert.match(notifierCalls[1].command, /notifier$/);
assert.equal(configuredTokenWarningThreshold({}), 250_000);
assert.equal(configuredTokenWarningThreshold({ ORCHESTRATOR_TOKEN_WARNING_THRESHOLD: "0" }), 0);
assert.throws(
  () => configuredTokenWarningThreshold({ ORCHESTRATOR_TOKEN_WARNING_THRESHOLD: "invalid" }),
  /harus integer/,
);
assert.equal(configuredParallelWorkers({}), 2);
assert.equal(configuredParallelWorkers({ ORCHESTRATOR_MAX_PARALLEL_JOBS: "4" }), 4);
assert.throws(
  () => configuredParallelWorkers({ ORCHESTRATOR_MAX_PARALLEL_JOBS: "9" }),
  /integer antara 1 dan 8/,
);
const telemetryContractRecord = createAgentTelemetryRecord({
  stage: "coding-agent",
  result: {
    exitCode: 0,
    finalResult: {
      conversation_id: "telemetry-contract",
      status: "SUCCESS",
      duration_seconds: 1.25,
      usage: {
        input_tokens: 90,
        output_tokens: 20,
        thinking_tokens: 5,
        cache_read_tokens: 40,
        total_tokens: 110,
      },
    },
  },
  agentConfig: { model: "fixture-model", effort: "low" },
});
assert.equal(telemetryContractRecord.stage, "IMPLEMENTATION");
assert.equal(telemetryContractRecord.usage.contextTokens, 130);
const telemetryContract = buildTelemetry([telemetryContractRecord], { threshold: 100 });
assert.equal(telemetryContract.summary.usage.totalTokens, 110);
assert.equal(telemetryContract.summary.usageCoveragePercent, 100);
assert.equal(telemetryContract.budget.exceeded, true);
assert.equal(compactTelemetry(telemetryContract).records, undefined);

function run(...args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" }));
}

const projects = run("projects");
assert.equal(projects.mode, "read-only");
assert.ok(projects.projects.length >= 2);
const starter = projects.projects.find((project) => project.id === "starter-app");
assert.ok(starter);
assert.equal(starter.repositoryExists, true);
assert.equal(starter.graphOutputExists, true);

const context = run("context", "starter-app", "task-011");
assert.equal(context.project.id, "starter-app");
assert.equal(context.task.metadata.task_id, "FE-011");
assert.ok(context.project.graphSummary.nodes > 0);
assert.ok(context.wiki.relevantKnowledge.some((item) => item.path.includes("react-use-local-storage")));

const planned = run("plan", "starter-app", "FE-011");
assert.equal(planned.plan.mode, "read-only");
assert.equal(planned.plan.approvalRequired, false);
assert.deepEqual(planned.plan.proposedWrites, []);
assert.ok(planned.plan.verificationCommands.includes("npm run build"));
assert.ok(planned.plan.steps.some((step) => step.includes("retrospective") || step.includes("Review log")));
assert.ok(planned.plan.note.includes("read-only"));
assert.ok(!planned.plan.note.includes("belum diaktifkan"));

const wrappedRetrospective = {
  classification: "PROJECT_ONLY",
  confidence: 1,
  title: "Project workflow",
  type: "decision",
  summary: "Project-specific documentation.",
  rationale: "The global rule already exists.",
  considerations: [],
  relatedKnowledge: [],
};
assert.deepEqual(parseRetrospectiveOutput({
  finalResult: { status: "SUCCESS", structured_output: wrappedRetrospective },
  stdoutTail: "",
}), wrappedRetrospective);
assert.deepEqual(parseRetrospectiveOutput({
  finalResult: { status: "SUCCESS", response: JSON.stringify(wrappedRetrospective) },
  stdoutTail: "",
}), wrappedRetrospective);

const parallelFixture = fs.mkdtempSync(path.join(os.tmpdir(), "personal-ai-parallel-"));
try {
  const queueRoot = path.join(parallelFixture, "queue-contract");
  const firstProjectA = enqueueTaskJob({
    runsRoot: queueRoot,
    projectId: "project-a",
    taskId: "A-001",
    taskPath: "02-Projects/project-a/tasks/task-001.md",
  }).job;
  const secondProjectA = enqueueTaskJob({
    runsRoot: queueRoot,
    projectId: "project-a",
    taskId: "A-002",
    taskPath: "02-Projects/project-a/tasks/task-002.md",
  }).job;
  const firstProjectB = enqueueTaskJob({
    runsRoot: queueRoot,
    projectId: "project-b",
    taskId: "B-001",
    taskPath: "02-Projects/project-b/tasks/task-001.md",
  }).job;
  updateJob(queueRoot, firstProjectA.jobId, { createdAt: "2026-08-15T00:00:01.000Z" });
  updateJob(queueRoot, secondProjectA.jobId, { createdAt: "2026-08-15T00:00:02.000Z" });
  updateJob(queueRoot, firstProjectB.jobId, { createdAt: "2026-08-15T00:00:03.000Z" });

  const claimedA = claimNextJob(queueRoot);
  const claimedB = claimNextJob(queueRoot);
  assert.equal(claimedA.taskId, "A-001");
  assert.equal(claimedB.taskId, "B-001");
  assert.equal(claimNextJob(queueRoot), null);
  const reservedStatus = parallelQueueStatus(
    [getJob(queueRoot, claimedA.jobId), getJob(queueRoot, claimedB.jobId), getJob(queueRoot, secondProjectA.jobId)],
    2,
  );
  assert.equal(reservedStatus.activeWorkers, 2);
  assert.equal(reservedStatus.blockedQueuedJobCount, 1);
  assert.equal(reservedStatus.blockedQueuedJobs[0].taskId, "A-002");

  updateJob(queueRoot, claimedA.jobId, { state: JOB_STATES.REVIEW });
  updateJob(queueRoot, claimedB.jobId, { state: JOB_STATES.FAILED });
  assert.equal(claimNextJob(queueRoot), null);
  updateJob(queueRoot, claimedA.jobId, { state: JOB_STATES.DONE });
  assert.equal(claimNextJob(queueRoot).taskId, "A-002");

  const restartRoot = path.join(parallelFixture, "restart-contract");
  const restartA = enqueueTaskJob({
    runsRoot: restartRoot,
    projectId: "project-a",
    taskId: "RESTART-A",
    taskPath: "02-Projects/project-a/tasks/restart-a.md",
  }).job;
  const restartB = enqueueTaskJob({
    runsRoot: restartRoot,
    projectId: "project-b",
    taskId: "RESTART-B",
    taskPath: "02-Projects/project-b/tasks/restart-b.md",
  }).job;
  updateJob(restartRoot, restartA.jobId, { createdAt: "2026-08-15T00:00:01.000Z" });
  updateJob(restartRoot, restartB.jobId, { createdAt: "2026-08-15T00:00:02.000Z" });
  assert.equal(claimNextJob(restartRoot).taskId, "RESTART-A");
  assert.equal(claimNextJob(restartRoot).taskId, "RESTART-B");
  const restartRecovery = reconcileJobs(restartRoot, []);
  assert.equal(restartRecovery.length, 2);
  assert.equal(getJob(restartRoot, restartA.jobId).state, JOB_STATES.QUEUED);
  assert.equal(getJob(restartRoot, restartB.jobId).state, JOB_STATES.QUEUED);
  assert.equal(
    enqueueTaskJob({
      runsRoot: restartRoot,
      projectId: "project-a",
      taskId: "RESTART-A",
      taskPath: "02-Projects/project-a/tasks/restart-a.md",
    }).created,
    false,
  );

  const poolRoot = path.join(parallelFixture, "pool-contract");
  const poolA1 = enqueueTaskJob({
    runsRoot: poolRoot,
    projectId: "project-a",
    taskId: "POOL-A1",
    taskPath: "02-Projects/project-a/tasks/pool-a1.md",
  }).job;
  const poolA2 = enqueueTaskJob({
    runsRoot: poolRoot,
    projectId: "project-a",
    taskId: "POOL-A2",
    taskPath: "02-Projects/project-a/tasks/pool-a2.md",
  }).job;
  const poolB1 = enqueueTaskJob({
    runsRoot: poolRoot,
    projectId: "project-b",
    taskId: "POOL-B1",
    taskPath: "02-Projects/project-b/tasks/pool-b1.md",
  }).job;
  updateJob(poolRoot, poolA1.jobId, { createdAt: "2026-08-15T00:00:01.000Z" });
  updateJob(poolRoot, poolA2.jobId, { createdAt: "2026-08-15T00:00:02.000Z" });
  updateJob(poolRoot, poolB1.jobId, { createdAt: "2026-08-15T00:00:03.000Z" });

  const releases = new Map();
  const starts = [];
  const poolEvents = [];
  let activeWorkflows = 0;
  let peakWorkflows = 0;
  const pool = createParallelJobPool({
    vaultRoot: path.join(parallelFixture, "vault"),
    runsRoot: poolRoot,
    services: {},
    maxWorkers: 2,
    workflow: async ({ projectId, taskInput }) => {
      starts.push({ projectId, taskInput });
      activeWorkflows += 1;
      peakWorkflows = Math.max(peakWorkflows, activeWorkflows);
      await new Promise((resolve) => releases.set(taskInput, resolve));
      activeWorkflows -= 1;
      if (taskInput === "POOL-B1") throw new Error("isolated fixture failure");
      return { state: RUN_STATES.RETROSPECTIVE, runId: `run-${taskInput.toLowerCase()}` };
    },
    notifier: async () => ({ created: false, notification: null }),
    onEvent: (event) => poolEvents.push(event),
  });
  const initialPool = pool.fill();
  assert.equal(initialPool.activeWorkers, 2);
  assert.deepEqual(starts.map((item) => item.taskInput), ["POOL-A1", "POOL-B1"]);
  assert.equal(peakWorkflows, 2);
  releases.get("POOL-A1")();
  releases.get("POOL-B1")();
  await pool.waitForIdle();
  assert.equal(getJob(poolRoot, poolA1.jobId).state, JOB_STATES.REVIEW);
  assert.equal(getJob(poolRoot, poolB1.jobId).state, JOB_STATES.FAILED);
  assert.equal(getJob(poolRoot, poolA2.jobId).state, JOB_STATES.QUEUED);
  assert.ok(poolEvents.some((event) => event.event === "JOB_REVIEW_READY"));
  assert.ok(poolEvents.some((event) => event.event === "JOB_FAILED"));

  updateJob(poolRoot, poolA1.jobId, { state: JOB_STATES.DONE });
  pool.fill();
  assert.equal(pool.snapshot().activeWorkers, 1);
  assert.equal(starts.at(-1).taskInput, "POOL-A2");
  releases.get("POOL-A2")();
  await pool.waitForIdle();
  assert.equal(getJob(poolRoot, poolA2.jobId).state, JOB_STATES.REVIEW);
  pool.stop();
} finally {
  fs.rmSync(parallelFixture, { recursive: true, force: true });
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "personal-ai-orchestrator-"));
try {
  const vault = path.join(fixture, "vault");
  const repository = path.join(fixture, "project");
  const graphOutput = path.join(repository, "graphify-out", "graph.json");
  const taskDirectory = path.join(vault, "02-Projects", "fixture-app", "tasks");

  fs.mkdirSync(path.dirname(graphOutput), { recursive: true });
  fs.mkdirSync(taskDirectory, { recursive: true });
  fs.mkdirSync(path.join(vault, "01-Knowledge", "patterns"), { recursive: true });
  fs.writeFileSync(path.join(vault, "index.md"), "# Wiki Index\n");
  fs.writeFileSync(path.join(vault, "wiki-log.md"), "# Wiki Log\n");

  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const dependencyCalls = [];
  const dependencyProbe = await reconcileProjectDependencies({
    repository,
    changedPaths: ["package.json"],
    eventLogPath: path.join(fixture, "dependency-probe.jsonl"),
    processRunner: async (invocation) => {
      dependencyCalls.push(invocation);
      return { exitCode: 0, stdoutTail: "", stderrTail: "" };
    },
  });
  assert.equal(dependencyProbe.manager, "npm");
  assert.equal(dependencyProbe.ignoreScripts, true);
  assert.deepEqual(dependencyCalls[0].args, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  fs.writeFileSync(graphOutput, JSON.stringify({ nodes: [{ id: "a" }], links: [], built_at_commit: "fixture" }));
  fs.writeFileSync(path.join(vault, "project-registry.md"), [
    "| project_id | project page | repository | agent | graphify | graphify output |",
    "|---|---|---|---|---|---|",
    `| \`fixture-app\` | [[02-Projects/fixture-app/project]] | \`${repository}\` | \`agy\` | \`false\` | \`${graphOutput}\` |`,
  ].join("\n"));
  fs.writeFileSync(path.join(vault, "02-Projects", "fixture-app", "project.md"), [
    "---",
    "title: Fixture App",
    "type: project",
    "project_id: fixture-app",
    `repository: ${repository}`,
    "graphify: false",
    "tags: [project]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "sources: []",
    "---",
    "# Fixture App",
  ].join("\n"));
  fs.writeFileSync(path.join(vault, "01-Knowledge", "patterns", "persistent-filter.md"), [
    "---",
    "title: Browser Storage Primer",
    "type: pattern",
    "tags: [filter]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "sources: []",
    "---",
    "# Browser Storage Primer",
    "Persist product filters in local storage.",
  ].join("\n"));
  fs.writeFileSync(path.join(taskDirectory, "task-001.md"), [
    "---",
    "title: Persist Product Filter",
    "type: task",
    "task_id: FIX-001",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "verification: [test]",
    "sources: []",
    "---",
    "# Persist Product Filter",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Persist product filters in local storage so the selection survives a reload.",
    "",
    "## Hasil Yang Diharapkan (Expected Result)",
    "The selected product filter is restored after the page reloads and the test command passes.",
  ].join("\n"));

  const scan = scanReadyTasks(vault, taskServices);
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.events.length, 1);
  assert.equal(scan.events[0].event, "TASK_READY");
  assert.equal(scan.events[0].mode, "observe-only");
  assert.equal(scan.events[0].task.id, "FIX-001");
  assert.equal(scan.events[0].plan.approvalRequired, true);
  assert.equal(scan.events[0].readiness.verdict, "PASS");
  assert.ok(scan.events[0].retrieval.knowledge.some((item) => item.path.includes("persistent-filter")));

  const validReadiness = validateTaskReadiness(buildContext(vault, "fixture-app", "FIX-001"), { readMarkdown });
  assert.equal(validReadiness.ready, true);
  assert.equal(validReadiness.summary.blockers, 0);

  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src", "LoginForm.tsx"), "export const LoginForm = () => null;\n");
  execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "orchestrator-smoke@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Orchestrator Smoke Test"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-m", "fixture baseline"], { cwd: repository, stdio: "ignore" });
  const validBugPath = path.join(taskDirectory, "task-bug-valid.md");
  fs.writeFileSync(validBugPath, [
    "---",
    "title: Bug Fix - Numeric Login Input",
    "type: task",
    "task_id: FIX-BUG-VALID",
    "project: fixture-app",
    "status: BACKLOG",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "verification: [test]",
    "sources: []",
    "---",
    "# Bug Fix - Numeric Login Input",
    "## Tujuan Utama",
    "Prevent alphabetic characters from being entered in the phone field.",
    "## Detail Bug",
    "- **Gejala Bug:** The phone field currently accepts alphabetic characters.",
    "- **Perilaku Yang Diharapkan:** The phone field accepts digits and an optional leading plus sign.",
    "- **Target Files:** `src/LoginForm.tsx`",
    "## Acceptance Criteria",
    "The behavior is fixed in `LoginForm.tsx` and the automated test command passes.",
  ].join("\n"));
  const validBugReadiness = validateTaskReadiness(buildContext(vault, "fixture-app", "FIX-BUG-VALID"), { readMarkdown });
  assert.equal(validBugReadiness.ready, true);
  assert.equal(validBugReadiness.summary.blockers, 0);

  const invalidReadinessPath = path.join(taskDirectory, "task-readiness-invalid.md");
  fs.writeFileSync(invalidReadinessPath, [
    "---",
    "title: Bug Fix - Input Type",
    "type: task",
    "task_id: FIX-READINESS",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "sources: []",
    "---",
    "# Bug Fix - Input Type",
    "## Tujuan Utama",
    "Fix the incorrect input type in the login form.",
    "## Detail Bug",
    "- **Gejala Bug:** *(Jelaskan perilaku yang salah).*",
    "- **Perilaku Yang Diharapkan:** *(Jelaskan hasil yang benar).*",
  ].join("\n"));
  const invalidReadiness = validateTaskReadiness(buildContext(vault, "fixture-app", "FIX-READINESS"), { readMarkdown });
  assert.equal(invalidReadiness.ready, false);
  assert.equal(invalidReadiness.verdict, "BLOCKED");
  assert.ok(invalidReadiness.blockers.some((item) => item.id === "PLACEHOLDERS"));
  assert.ok(invalidReadiness.blockers.some((item) => item.id === "BUG_SYMPTOM"));
  assert.ok(invalidReadiness.blockers.some((item) => item.id === "EXPECTED_BEHAVIOR"));
  assert.ok(invalidReadiness.blockers.some((item) => item.id === "ACCEPTANCE_CRITERIA"));
  assert.ok(invalidReadiness.blockers.some((item) => item.id === "VERIFICATION"));
  assert.throws(
    () => createReadyTaskEvent(vault, invalidReadinessPath, taskServices),
    /gagal readiness gate/,
  );

  const deduplicator = new ReadyTaskDeduplicator();
  assert.equal(deduplicator.accept(scan.events[0]), true);
  assert.equal(deduplicator.accept(scan.events[0]), false);

  const runsRoot = path.join(fixture, "runs");
  const notificationDeliveries = [];
  const fixtureDeliverer = async (notification) => {
    notificationDeliveries.push(notification.notificationId);
    return { channel: "fixture", status: "DELIVERED", attemptedAt: new Date().toISOString() };
  };
  const firstNotification = await emitNotification({
    runsRoot,
    dedupeKey: "fixture:review:1",
    type: "TASK_REVIEW_READY",
    severity: "SUCCESS",
    title: "FIX-NOTIFY siap direview",
    message: "Fixture notification is ready.",
    source: { taskId: "FIX-NOTIFY", projectId: "fixture-app", runId: "fixture-notification-run" },
    action: { command: "npm run review -- FIX-NOTIFY" },
    deliverer: fixtureDeliverer,
  });
  const duplicateNotification = await emitNotification({
    runsRoot,
    dedupeKey: "fixture:review:1",
    type: "TASK_REVIEW_READY",
    severity: "SUCCESS",
    title: "Duplicate",
    message: "This duplicate must not be delivered.",
    source: { taskId: "FIX-NOTIFY" },
    deliverer: fixtureDeliverer,
  });
  assert.equal(firstNotification.created, true);
  assert.equal(firstNotification.notification.delivery.status, "DELIVERED");
  assert.equal(duplicateNotification.created, false);
  assert.equal(notificationDeliveries.length, 1);
  assert.equal(listNotifications({ runsRoot }).unreadCount, 1);
  const acknowledged = acknowledgeNotifications({ runsRoot, selector: "FIX-NOTIFY", readBy: "smoke-test" });
  assert.equal(acknowledged.count, 1);
  assert.equal(acknowledged.unreadCount, 0);

  const recoveredNotification = await notifyTaskOutcome({
    runsRoot,
    job: { jobId: "fixture-recovered-job", state: "REVIEW", taskId: "FIX-RECOVERED", projectId: "fixture-app" },
    manifest: {
      runId: "fixture-recovered-run",
      state: "RETROSPECTIVE",
      task: { id: "FIX-RECOVERED" },
      project: { id: "fixture-app" },
      execution: {
        automaticRecovery: { status: "SUCCESS", strategy: "AI_REPAIR", successfulAttempt: 1 },
      },
    },
    deliverer: fixtureDeliverer,
  });
  assert.equal(recoveredNotification.notification.type, "AUTOMATIC_RECOVERY_SUCCEEDED");
  const exhaustedNotification = await notifyTaskOutcome({
    runsRoot,
    job: { jobId: "fixture-exhausted-job", state: "FAILED", taskId: "FIX-EXHAUSTED", projectId: "fixture-app" },
    manifest: {
      runId: "fixture-exhausted-run",
      state: "FAILED",
      task: { id: "FIX-EXHAUSTED" },
      project: { id: "fixture-app" },
      execution: {
        automaticRecovery: { status: "EXHAUSTED", finalError: "Build remains broken." },
        result: { error: "Build remains broken." },
      },
    },
    deliverer: fixtureDeliverer,
  });
  assert.equal(exhaustedNotification.notification.type, "AUTOMATIC_RECOVERY_EXHAUSTED");
  const candidateNotification = await notifyKnowledgeCandidateReady({
    runsRoot,
    manifest: {
      runId: "fixture-candidate-run",
      task: { id: "FIX-CANDIDATE-NOTIFY" },
      project: { id: "fixture-app" },
      knowledge: {
        proposal: { title: "Fixture Candidate" },
        sync: { targetPath: "05-Knowledge-Candidates/fixture-candidate.md" },
      },
    },
    deliverer: fixtureDeliverer,
  });
  assert.equal(candidateNotification.notification.type, "KNOWLEDGE_CANDIDATE_READY");
  assert.equal(notificationSummary(runsRoot).unreadCount, 3);

  const autoPrepared = handoffReadyTask({ runsRoot, event: scan.events[0] });
  assert.equal(autoPrepared.created, true);
  assert.equal(autoPrepared.manifest.state, RUN_STATES.PENDING_APPROVAL);
  assert.equal(autoPrepared.manifest.preparation.origin, "watcher-daemon");
  const autoDuplicate = handoffReadyTask({ runsRoot, event: scan.events[0] });
  assert.equal(autoDuplicate.created, false);
  assert.equal(autoDuplicate.manifest.runId, autoPrepared.manifest.runId);

  fs.appendFileSync(path.join(taskDirectory, "task-001.md"), "\nClarification added before approval.\n");
  const changedEvent = createReadyTaskEvent(vault, path.join(taskDirectory, "task-001.md"), taskServices);
  const replacement = handoffReadyTask({ runsRoot, event: changedEvent });
  assert.equal(replacement.created, true);
  assert.deepEqual(replacement.manifest.preparation.supersededRunIds, [autoPrepared.manifest.runId]);
  assert.equal(listRuns(runsRoot).find((run) => run.runId === autoPrepared.manifest.runId).state, RUN_STATES.SUPERSEDED);

  const prepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "task-001",
    services: taskServices,
  });
  assert.equal(prepared.runId, replacement.manifest.runId);
  assert.equal(prepared.state, RUN_STATES.PENDING_APPROVAL);
  assert.equal(prepared.taskFingerprint, changedEvent.fingerprint);
  assert.equal(prepared.approval, null);
  assert.equal(listRuns(runsRoot).length, 2);
  const stoppedDaemon = daemonStatus({ runsRoot });
  assert.equal(stoppedDaemon.running, false);
  assert.equal(stoppedDaemon.queue.pendingApprovalCount, 1);
  assert.equal(stoppedDaemon.notifications.total, 4);
  assert.equal(stoppedDaemon.notifications.unreadCount, 3);

  const approved = approveRun({ runsRoot, runId: prepared.runId, approvedBy: "smoke-test" });
  assert.equal(approved.state, RUN_STATES.APPROVED);
  assert.equal(approved.approval.approvedBy, "smoke-test");
  assert.equal(approved.approval.scope, "EXECUTE_TASK");
  assert.equal(approved.history.at(-1).event, "RUN_APPROVED");

  const claimed = claimRun({
    vaultRoot: vault,
    runsRoot,
    runId: prepared.runId,
    services: taskServices,
  });
  assert.equal(claimed.state, RUN_STATES.CLAIMED);
  assert.equal(claimed.task.status, "IN_PROGRESS");
  assert.equal(claimed.history.at(-1).event, "TASK_CLAIMED");
  assert.ok(fs.existsSync(path.join(runsRoot, claimed.execution.lock)));
  const claimedTask = readMarkdown(path.join(taskDirectory, "task-001.md"), vault);
  assert.equal(claimedTask.metadata.status, "IN_PROGRESS");
  assert.ok(claimedTask.body.includes("Orchestrator Run Log"));
  assert.equal(claimRun({
    vaultRoot: vault,
    runsRoot,
    runId: prepared.runId,
    services: taskServices,
  }).state, RUN_STATES.CLAIMED);

  const reviewed = await executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: prepared.runId,
    agentInvocationBuilder: () => ({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({event:'result',result:{status:'ok'}}))"],
    }),
  });
  assert.equal(reviewed.state, RUN_STATES.REVIEW);
  assert.equal(reviewed.task.status, "REVIEW");
  assert.equal(reviewed.execution.result.status, "SUCCESS");
  assert.equal(reviewed.execution.verification[0].command, "npm run test");
  assert.equal(readMarkdown(path.join(taskDirectory, "task-001.md"), vault).metadata.status, "REVIEW");
  assert.equal(fs.existsSync(path.join(runsRoot, claimed.execution.lock)), false);
  assert.ok(fs.existsSync(path.join(runsRoot, reviewed.execution.eventLog)));

  const retrospective = await retrospectRun({
    vaultRoot: vault,
    runsRoot,
    runId: prepared.runId,
    proposalGenerator: async () => ({
      classification: "NEW",
      confidence: 0.9,
      title: "Persistent Product Filter",
      type: "pattern",
      targetPath: null,
      summary: "Persist reusable product-filter state in local storage.",
      rationale: "The implementation can be reused across frontend projects.",
      considerations: ["Use versioned storage keys."],
      relatedKnowledge: ["01-Knowledge/patterns/persistent-filter"],
    }),
  });
  assert.equal(retrospective.state, RUN_STATES.RETROSPECTIVE);
  assert.equal(retrospective.knowledge.proposal.classification, "NEW");

  const knowledgeApproved = approveKnowledgeRun({
    vaultRoot: vault,
    runsRoot,
    runId: prepared.runId,
    approvedBy: "smoke-test",
  });
  assert.equal(knowledgeApproved.state, RUN_STATES.KNOWLEDGE_APPROVAL);
  assert.equal(knowledgeApproved.knowledge.approval.destination, "WIKI");
  assert.equal(knowledgeApproved.knowledge.approval.routing.automatic, true);
  assert.equal(knowledgeApproved.knowledge.approval.routing.checks.confidencePassed, true);

  const synced = syncWikiRun({ vaultRoot: vault, runsRoot, runId: prepared.runId });
  assert.equal(synced.state, RUN_STATES.WIKI_SYNCED);
  const promotedPath = path.join(vault, "01-Knowledge", "patterns", "persistent-product-filter.md");
  assert.ok(fs.existsSync(promotedPath));
  assert.ok(fs.readFileSync(promotedPath, "utf8").includes("orchestrator_run:"));
  const lowConfidenceRouting = resolveKnowledgeRouting({
    vaultRoot: vault,
    manifest: {
      ...retrospective,
      knowledge: {
        ...retrospective.knowledge,
        proposal: { ...retrospective.knowledge.proposal, title: "Low Confidence Pattern", confidence: 0.6 },
      },
    },
  });
  assert.equal(lowConfidenceRouting.destination, "CANDIDATE");
  assert.equal(lowConfidenceRouting.checks.confidencePassed, false);
  const duplicateRouting = resolveKnowledgeRouting({ vaultRoot: vault, manifest: retrospective });
  assert.equal(duplicateRouting.classification, "UPDATE");
  assert.equal(duplicateRouting.destination, "WIKI");
  assert.equal(duplicateRouting.targetPath, "01-Knowledge/patterns/persistent-product-filter.md");
  const nearDuplicateRouting = resolveKnowledgeRouting({
    vaultRoot: vault,
    manifest: {
      ...retrospective,
      knowledge: {
        ...retrospective.knowledge,
        proposal: {
          ...retrospective.knowledge.proposal,
          title: "Persistent Product Filters",
          confidence: 0.95,
        },
      },
    },
  });
  assert.equal(nearDuplicateRouting.destination, "CANDIDATE");
  assert.equal(nearDuplicateRouting.checks.similarKnowledge[0].path, "01-Knowledge/patterns/persistent-product-filter.md");
  assert.ok(fs.existsSync(path.join(vault, synced.knowledge.sync.sourcePath)));
  assert.ok(fs.readFileSync(path.join(vault, "index.md"), "utf8").includes("persistent-product-filter"));
  assert.ok(fs.readFileSync(path.join(vault, "wiki-log.md"), "utf8").includes(prepared.runId));
  assert.match(
    fs.readFileSync(path.join(taskDirectory, "task-001.md"), "utf8"),
    /## Knowledge Decision\n\n- Classification: `NEW`\n- Destination: `WIKI`/,
  );

  const completed = await completeRun({
    vaultRoot: vault,
    runsRoot,
    runId: prepared.runId,
    completedBy: "smoke-test",
  });
  assert.equal(completed.state, RUN_STATES.DONE);
  assert.equal(completed.task.status, "DONE");
  assert.equal(completed.execution.result.knowledgeDecision, "NEW");
  assert.equal(completed.completion.humanApproved, true);
  const completedTaskContent = fs.readFileSync(path.join(taskDirectory, "task-001.md"), "utf8");
  assert.equal(readMarkdown(path.join(taskDirectory, "task-001.md"), vault).metadata.status, "DONE");
  assert.match(completedTaskContent, /^## Log Perubahan\n🚀 \[VERIFIED_BY_LLM_WIKI_SCHEMA\]/m);

  const candidateRoot = path.join(vault, "05-Knowledge-Candidates");
  const candidateSourceRoot = path.join(vault, "03-Sources", "other", "orchestrator-runs");
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.mkdirSync(candidateSourceRoot, { recursive: true });
  const candidateSourcePath = path.join(candidateSourceRoot, "candidate-fixture.json");
  fs.writeFileSync(candidateSourcePath, JSON.stringify({
    runId: "candidate-fixture",
    task: { id: "FIX-CANDIDATE", title: "Manual Candidate Promotion" },
    proposal: {
      classification: "NEW",
      confidence: 0.7,
      title: "Manual Candidate Pattern",
      type: "pattern",
      targetPath: "01-Knowledge/patterns/manual-candidate-pattern.md",
      summary: "A reusable candidate pattern that requires explicit human approval.",
      rationale: "The candidate workflow must preserve audit history before global promotion.",
      considerations: ["Promote only after review."],
      relatedKnowledge: [],
    },
  }, null, 2));
  const manualCandidatePath = path.join(candidateRoot, "manual-candidate-pattern.md");
  fs.writeFileSync(manualCandidatePath, [
    "---",
    "title: \"Manual Candidate Pattern\"",
    "type: candidate",
    "tags: [candidate]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "orchestrator_run: candidate-fixture",
    "sources: [\"[[03-Sources/other/orchestrator-runs/candidate-fixture.json]]\"]",
    "---",
    "# Manual Candidate Pattern",
  ].join("\n"));
  fs.appendFileSync(path.join(vault, "index.md"), "\n- [[05-Knowledge-Candidates/manual-candidate-pattern|Manual Candidate Pattern]]\n");
  assert.equal(listKnowledgeCandidates({ vaultRoot: vault }).count, 1);
  const candidatePromotion = promoteKnowledgeCandidate({
    vaultRoot: vault,
    selector: "manual-candidate-pattern",
    approvedBy: "smoke-test",
  });
  assert.equal(candidatePromotion.action, "KNOWLEDGE_PROMOTED");
  assert.equal(candidatePromotion.target.path, "01-Knowledge/patterns/manual-candidate-pattern.md");
  assert.equal(fs.existsSync(manualCandidatePath), false);
  assert.ok(fs.existsSync(path.join(vault, candidatePromotion.target.path)));
  assert.ok(fs.existsSync(path.join(vault, candidatePromotion.auditPath)));
  assert.doesNotMatch(fs.readFileSync(path.join(vault, "index.md"), "utf8"), /05-Knowledge-Candidates\/manual-candidate-pattern/);

  const rejectedCandidatePath = path.join(candidateRoot, "rejected-pattern.md");
  fs.writeFileSync(rejectedCandidatePath, [
    "---",
    "title: \"Rejected Pattern\"",
    "type: candidate",
    "tags: [candidate]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "sources: []",
    "---",
    "# Rejected Pattern",
  ].join("\n"));
  const rejectedCandidate = rejectKnowledgeCandidate({
    vaultRoot: vault,
    selector: "rejected-pattern",
    rejectedBy: "smoke-test",
    reason: "Not reusable across projects.",
  });
  assert.equal(rejectedCandidate.action, "KNOWLEDGE_REJECTED");
  assert.equal(fs.existsSync(rejectedCandidatePath), false);
  assert.ok(fs.existsSync(path.join(vault, rejectedCandidate.archivePath)));
  assert.ok(fs.existsSync(path.join(vault, rejectedCandidate.auditPath)));

  const similarSourcePath = path.join(candidateSourceRoot, "similar-candidate-fixture.json");
  fs.writeFileSync(similarSourcePath, JSON.stringify({
    runId: "similar-candidate-fixture",
    task: { id: "FIX-SIMILAR", title: "Near Duplicate Candidate" },
    proposal: {
      classification: "NEW",
      confidence: 0.88,
      title: "Persistent Product Filters",
      type: "pattern",
      targetPath: "01-Knowledge/patterns/persistent-product-filters.md",
      summary: "Persist reusable product-filter state in local storage.",
      rationale: "This is very similar to the existing persistent product filter pattern.",
      considerations: ["Use versioned storage keys."],
      relatedKnowledge: [],
    },
  }, null, 2));
  const similarCandidatePath = path.join(candidateRoot, "persistent-product-filters.md");
  fs.writeFileSync(similarCandidatePath, [
    "---",
    "title: \"Persistent Product Filters\"",
    "type: candidate",
    "tags: [candidate]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    "orchestrator_run: similar-candidate-fixture",
    "sources: [\"[[03-Sources/other/orchestrator-runs/similar-candidate-fixture.json]]\"]",
    "---",
    "# Persistent Product Filters",
    "Persist reusable product-filter state in local storage.",
  ].join("\n"));
  const similarReview = reviewKnowledgeCandidate({ vaultRoot: vault, selector: "persistent-product-filters" });
  assert.equal(similarReview.verdict, "NEEDS_TARGET");
  assert.equal(similarReview.similarKnowledge[0].path, "01-Knowledge/patterns/persistent-product-filter.md");
  assert.throws(
    () => promoteKnowledgeCandidate({
      vaultRoot: vault,
      selector: "persistent-product-filters",
      approvedBy: "smoke-test",
    }),
    /Review lebih dulu.*--target/s,
  );
  const similarPromotion = promoteKnowledgeCandidate({
    vaultRoot: vault,
    selector: "persistent-product-filters",
    approvedBy: "smoke-test",
    targetPath: "01-Knowledge/patterns/persistent-product-filter.md",
  });
  assert.equal(similarPromotion.target.mode, "UPDATE");
  assert.equal(similarPromotion.quality.explicitExistingTarget, true);

  const qualityPagePath = path.join(vault, "01-Knowledge", "patterns", "quality-fixture.md");
  fs.writeFileSync(qualityPagePath, [
    "---",
    "title: Quality Fixture",
    "type: pattern",
    "tags: [quality]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    "sources: []",
    "---",
    "# Quality Fixture",
    "See [[missing-quality-target]].",
  ].join("\n"));
  const missingMetadataPath = path.join(vault, "01-Knowledge", "patterns", "missing-metadata.md");
  fs.writeFileSync(missingMetadataPath, "# Missing Metadata\n\nThis page must not be rewritten by safe fix.\n");
  const indexBeforeHealth = fs.readFileSync(path.join(vault, "index.md"), "utf8");
  const readOnlyHealth = knowledgeHealth({ vaultRoot: vault });
  assert.equal(readOnlyHealth.mode, "read-only");
  assert.equal(readOnlyHealth.verdict, "FAIL");
  assert.ok(readOnlyHealth.findings.some((item) => item.check === "BROKEN_WIKILINK" && item.path.endsWith("quality-fixture.md")));
  assert.ok(readOnlyHealth.findings.some((item) => item.check === "FRONTMATTER" && item.path.endsWith("missing-metadata.md")));
  assert.ok(readOnlyHealth.findings.some((item) => item.check === "UNINDEXED_PAGE" && item.path.endsWith("quality-fixture.md")));
  assert.equal(fs.readFileSync(path.join(vault, "index.md"), "utf8"), indexBeforeHealth);
  const fixedHealth = knowledgeHealth({ vaultRoot: vault, fixSafe: true, fixedBy: "smoke-test" });
  assert.ok(fixedHealth.fixes.some((item) => item.path.endsWith("quality-fixture.md")));
  assert.match(fs.readFileSync(path.join(vault, "index.md"), "utf8"), /quality-fixture/);
  assert.equal(fs.readFileSync(missingMetadataPath, "utf8"), "# Missing Metadata\n\nThis page must not be rewritten by safe fix.\n");
  assert.match(fs.readFileSync(path.join(vault, "wiki-log.md"), "utf8"), /lint \| Knowledge Quality/);
  assert.equal(
    findSimilarKnowledge({ vaultRoot: vault, title: "Persistent Product Filters" })[0].path,
    "01-Knowledge/patterns/persistent-product-filter.md",
  );

  fs.writeFileSync(path.join(repository, "README.md"), "# Fixture\n");
  const intake = await requestTask({
    vaultRoot: vault,
    runsRoot,
    project: {
      id: "fixture-app",
      repository,
      graphify: false,
      projectPagePath: "02-Projects/fixture-app/project.md",
    },
    request: "Append a simplified-flow note to README and execute it.",
    requestedBy: "smoke-test",
    autoStart: true,
    readMarkdown,
    validateTask: (projectId, taskPath) => validateTaskReadiness(
      buildContext(vault, projectId, taskPath),
      { readMarkdown },
    ),
    planner: async () => ({
      draft: {
        title: "Simplified Flow",
        purpose: "Append a simplified-flow note to README.",
        expectedResult: "README contains the note and automated verification passes.",
        acceptanceCriteria: ["README contains the simplified-flow note."],
        dependencies: [],
        verification: ["test"],
        allowedPaths: ["README.md"],
        requiresChanges: true,
        risk: "LOW",
        clarificationNeeded: false,
        clarificationQuestion: null,
      },
      agentConfig: { model: "fixture", effort: "low" },
      intakeId: "fixture-intake",
      telemetry: createAgentTelemetryRecord({
        stage: "TASK_INTAKE",
        result: {
          exitCode: 0,
          finalResult: {
            conversation_id: "fixture-intake-conversation",
            status: "SUCCESS",
            duration_seconds: 2,
            usage: {
              input_tokens: 100,
              output_tokens: 25,
              thinking_tokens: 10,
              cache_read_tokens: 50,
              total_tokens: 125,
            },
          },
        },
        agentConfig: { model: "fixture", effort: "low" },
        invocationId: "fixture-intake",
        metadata: { intakeId: "fixture-intake", projectId: "fixture-app" },
      }),
    }),
  });
  assert.equal(intake.action, "TASK_CREATED_AND_QUEUED");
  assert.equal(intake.job.state, JOB_STATES.QUEUED);
  assert.equal(intake.job.intakeTelemetry.stage, "TASK_INTAKE");
  const simplifiedTaskPath = path.join(vault, intake.task.path);
  assert.equal(readMarkdown(simplifiedTaskPath, vault).metadata.status, "BACKLOG");
  assert.ok(fs.readFileSync(path.join(vault, "index.md"), "utf8").includes(intake.task.id));
  assert.equal(interactionStatus({ runsRoot, selector: intake.task.id }).state, JOB_STATES.QUEUED);

  const taskFilesBeforeBlockedIntake = fs.readdirSync(taskDirectory).filter((name) => name.endsWith(".md")).length;
  const blockedIntake = await requestTask({
    vaultRoot: vault,
    runsRoot,
    project: {
      id: "fixture-app",
      repository,
      graphify: false,
      projectPagePath: "02-Projects/fixture-app/project.md",
    },
    request: "Create a task with an unresolved dependency.",
    requestedBy: "smoke-test",
    readMarkdown,
    validateTask: (projectId, taskPath) => validateTaskReadiness(
      buildContext(vault, projectId, taskPath),
      { readMarkdown },
    ),
    planner: async () => ({
      draft: {
        title: "Blocked Intake",
        purpose: "Exercise intake readiness rejection.",
        expectedResult: "The invalid draft is rejected before Wiki creation.",
        acceptanceCriteria: ["No managed task is created."],
        dependencies: ["FIX-MISSING"],
        verification: ["test"],
        allowedPaths: ["README.md"],
        requiresChanges: true,
        risk: "LOW",
        clarificationNeeded: false,
        clarificationQuestion: null,
      },
    }),
  });
  assert.equal(blockedIntake.action, "NEEDS_CLARIFICATION");
  assert.equal(blockedIntake.readiness.verdict, "BLOCKED");
  assert.equal(fs.readdirSync(taskDirectory).filter((name) => name.endsWith(".md")).length, taskFilesBeforeBlockedIntake);

  const processedJobNotifications = [];
  const processedJobEvents = [];
  const processedJob = await processNextQueuedJob({
    vaultRoot: vault,
    runsRoot,
    services: taskServices,
    workflow: (options) => startTaskRun({
      ...options,
      executor: (executorOptions) => executeRun({
        ...executorOptions,
        agentInvocationBuilder: () => ({
          command: process.execPath,
          args: ["-e", "require('fs').appendFileSync('README.md','\\nSimplified flow.\\n'); console.log(JSON.stringify({event:'result',result:{status:'ok'}}))"],
        }),
      }),
      retrospective: (retrospectiveOptions) => retrospectRun({
        ...retrospectiveOptions,
        proposalGenerator: async () => ({
          classification: "PROJECT_ONLY",
          confidence: 0.95,
          title: "Simplified project flow",
          type: "decision",
          summary: "The simplified workflow was verified in the fixture project.",
          rationale: "This result is specific to the fixture project.",
          considerations: [],
          relatedKnowledge: [],
        }),
      }),
    }),
    notifier: async (notificationInput) => {
      processedJobNotifications.push(notificationInput);
      throw new Error("fixture delivery failure");
    },
    onEvent: (event) => processedJobEvents.push(event),
  });
  assert.equal(processedJob.job.state, JOB_STATES.REVIEW);
  assert.equal(processedJobNotifications.length, 1);
  assert.equal(processedJobNotifications[0].manifest.state, RUN_STATES.RETROSPECTIVE);
  assert.equal(processedJob.notification, null);
  assert.ok(processedJobEvents.some((event) => event.event === "NOTIFICATION_FAILED"));
  const simplified = processedJob.manifest;
  assert.equal(simplified.state, RUN_STATES.RETROSPECTIVE);
  assert.equal(simplified.task.status, "REVIEW");
  assert.equal(simplified.approval.approvedBy, "smoke-test");
  assert.equal(simplified.knowledge.proposal.classification, "PROJECT_ONLY");
  assert.match(fs.readFileSync(simplifiedTaskPath, "utf8"), /approval execution melalui `start-task`/);
  const reviewByTaskId = interactionStatus({ runsRoot, selector: intake.task.id });
  assert.equal(reviewByTaskId.state, RUN_STATES.RETROSPECTIVE);
  assert.deepEqual(reviewByTaskId.progress.changedPaths, ["README.md"]);
  assert.equal(reviewByTaskId.telemetry.summary.calls, 2);
  assert.equal(reviewByTaskId.telemetry.summary.byStage.TASK_INTAKE.usage.totalTokens, 125);
  assert.equal(reviewByTaskId.telemetry.records, undefined);
  const simplifiedTelemetry = telemetryReport({ runsRoot, selector: intake.task.id });
  assert.equal(simplifiedTelemetry.telemetry.summary.calls, 2);
  assert.equal(simplifiedTelemetry.telemetry.summary.measuredCalls, 1);
  assert.equal(resolveRunSelector({ runsRoot, selector: intake.task.id, actionable: true }).runId, simplified.runId);
  assert.doesNotMatch(fs.readFileSync(path.join(repository, "README.md"), "utf8"), /Simplified flow/);
  assert.match(fs.readFileSync(path.join(simplified.execution.workspace.path, "README.md"), "utf8"), /Simplified flow/);

  const simplifiedAccepted = await acceptRun({
    vaultRoot: vault,
    runsRoot,
    runId: simplified.runId,
    approvedBy: "smoke-test",
  });
  assert.equal(simplifiedAccepted.state, RUN_STATES.DONE);
  assert.equal(simplifiedAccepted.knowledge.approval.classification, "PROJECT_ONLY");
  assert.equal(simplifiedAccepted.knowledge.approval.destination, "PROJECT");
  assert.equal(simplifiedAccepted.execution.workspace.state, "CLEANED");
  assert.equal(fs.existsSync(simplifiedAccepted.execution.workspace.path), false);
  assert.match(fs.readFileSync(path.join(repository, "README.md"), "utf8"), /Simplified flow/);
  updateJobForRun(runsRoot, simplified.runId, { state: JOB_STATES.RUNNING, runState: simplifiedAccepted.state });
  const reconciledJobs = reconcileJobs(runsRoot, listRuns(runsRoot));
  assert.equal(reconciledJobs.find((job) => job.runId === simplified.runId).state, JOB_STATES.DONE);
  assert.equal(interactionStatus({ runsRoot, selector: intake.task.id }).state, RUN_STATES.DONE);
  assert.equal(readMarkdown(simplifiedTaskPath, vault).metadata.status, "DONE");
  assert.match(fs.readFileSync(simplifiedTaskPath, "utf8"), /## Knowledge Retrospective/);
  assert.match(fs.readFileSync(simplifiedTaskPath, "utf8"), /^## Log Perubahan\n🚀 \[VERIFIED_BY_LLM_WIKI_SCHEMA\]/m);

  fs.writeFileSync(path.join(repository, "README.md"), "# Fixture\n");
  const reviewTaskPath = path.join(taskDirectory, "task-review-rejection.md");
  fs.writeFileSync(reviewTaskPath, [
    "---",
    "title: Review Rejection",
    "type: task",
    "task_id: FIX-REVIEW",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "verification: [test]",
    "allowed_paths: [README.md]",
    "requires_changes: true",
    "sources: []",
    "---",
    "# Review Rejection",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Append a verified integration note to `README.md`.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "README contains the integration note and automated verification passes.",
  ].join("\n"));
  const reviewPrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "FIX-REVIEW",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: reviewPrepared.runId, approvedBy: "smoke-test" });
  claimRun({ vaultRoot: vault, runsRoot, runId: reviewPrepared.runId, services: taskServices });
  const reviewRun = await executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: reviewPrepared.runId,
    agentInvocationBuilder: () => ({
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('README.md','\\nIntegration note.\\n'); console.log(JSON.stringify({event:'result',result:{status:'ok',conversation_id:'review-conversation'}}))"],
    }),
  });
  assert.equal(reviewRun.state, RUN_STATES.REVIEW);
  assert.deepEqual(reviewRun.execution.scopeAudit.changedPaths, ["README.md"]);
  assert.doesNotMatch(fs.readFileSync(path.join(repository, "README.md"), "utf8"), /Integration note/);
  const reviewRetrospective = await retrospectRun({
    vaultRoot: vault,
    runsRoot,
    runId: reviewPrepared.runId,
    proposalGenerator: async () => ({
      classification: "PROJECT_ONLY",
      confidence: 0.9,
      title: "Rejected project note",
      type: "decision",
      summary: "The reviewed note was rejected.",
      rationale: "The result is project-specific.",
      considerations: [],
      relatedKnowledge: [],
    }),
  });
  assert.equal(reviewRetrospective.state, RUN_STATES.RETROSPECTIVE);
  let previewOpenedPath = null;
  const previewResult = await previewReviewWorkspace({
    runsRoot,
    runId: reviewPrepared.runId,
    opener: async (workspacePath) => {
      previewOpenedPath = workspacePath;
      return { command: "fixture-code", args: [workspacePath] };
    },
  });
  assert.equal(previewResult.action, "REVIEW_WORKSPACE_OPENED");
  assert.equal(previewResult.repositoryMainUnchanged, true);
  assert.equal(previewOpenedPath, reviewRetrospective.execution.workspace.path);
  assert.equal(previewResult.instructions.startDevelopmentServer, "npm run dev");

  const revisedReview = await requestChangesTaskRun({
    vaultRoot: vault,
    runsRoot,
    runId: reviewPrepared.runId,
    requestedBy: "smoke-reviewer",
    reason: "Make the integration note explicit after visual and code review.",
    revisionExecutor: (revisionOptions) => reviseRun({
      ...revisionOptions,
      revisionInvocationBuilder: (manifest, revisionVaultRoot, revisionContext) => {
        const agyInvocation = buildAgyRevisionInvocation(manifest, revisionVaultRoot, revisionContext);
        assert.ok(agyInvocation.args.includes("--conversation"));
        assert.ok(agyInvocation.args.includes("review-conversation"));
        assert.match(agyInvocation.args.join(" "), /Make the integration note explicit/);
        return {
          command: process.execPath,
          args: ["-e", "require('fs').appendFileSync('README.md','Revised after human review.\\n'); console.log(JSON.stringify({event:'result',result:{status:'ok',conversation_id:'review-conversation'}}))"],
          agentConfig: { model: "fixture", effort: "low" },
          conversationId: "review-conversation",
        };
      },
    }),
    retrospective: (retrospectiveOptions) => retrospectRun({
      ...retrospectiveOptions,
      proposalGenerator: async () => ({
        classification: "PROJECT_ONLY",
        confidence: 0.95,
        title: "Revised project note",
        type: "decision",
        summary: "The note was revised from human review feedback.",
        rationale: "The result remains project-specific.",
        considerations: [],
        relatedKnowledge: [],
      }),
    }),
  });
  assert.equal(revisedReview.state, RUN_STATES.RETROSPECTIVE);
  assert.equal(revisedReview.task.status, "REVIEW");
  assert.equal(revisedReview.execution.reviewChanges.length, 1);
  assert.equal(revisedReview.execution.reviewChanges[0].iteration, 1);
  assert.equal(revisedReview.execution.reviewChanges[0].status, "VERIFIED");
  assert.deepEqual(revisedReview.execution.scopeAudit.changedPaths, ["README.md"]);
  assert.deepEqual(revisedReview.execution.scopeAudit.revisionChangedPaths, ["README.md"]);
  assert.match(
    fs.readFileSync(path.join(revisedReview.execution.workspace.path, "README.md"), "utf8"),
    /Revised after human review/,
  );
  assert.doesNotMatch(fs.readFileSync(path.join(repository, "README.md"), "utf8"), /Revised after human review/);
  assert.match(fs.readFileSync(reviewTaskPath, "utf8"), /smoke-reviewer.*meminta revisi/);
  assert.match(fs.readFileSync(path.join(vault, "wiki-log.md"), "utf8"), /task-request-changes/);

  const rejectedReview = await rejectTaskRun({
    vaultRoot: vault,
    runsRoot,
    runId: reviewPrepared.runId,
    rejectedBy: "smoke-test",
    reason: "Acceptance text needs revision.",
  });
  assert.equal(rejectedReview.state, RUN_STATES.FAILED);
  assert.equal(rejectedReview.task.status, "FAILED");
  assert.equal(rejectedReview.execution.review.rejectedBy, "smoke-test");
  assert.equal(rejectedReview.execution.workspace.state, "DISCARDED");
  assert.equal(fs.existsSync(rejectedReview.execution.workspace.path), false);
  assert.doesNotMatch(fs.readFileSync(path.join(repository, "README.md"), "utf8"), /Integration note/);
  assert.equal(readMarkdown(reviewTaskPath, vault).metadata.status, "FAILED");

  fs.writeFileSync(path.join(repository, "README.md"), "# Conflict baseline\n");
  const conflictTaskPath = path.join(taskDirectory, "task-workspace-conflict.md");
  fs.writeFileSync(conflictTaskPath, [
    "---",
    "title: Workspace Conflict Guard",
    "type: task",
    "task_id: FIX-CONFLICT",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    "dependencies: []",
    "verification: [test]",
    "allowed_paths: [README.md]",
    "requires_changes: true",
    "sources: []",
    "---",
    "# Workspace Conflict Guard",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Append an isolated task note to `README.md`.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "The task note can only be applied if the source baseline is unchanged.",
  ].join("\n"));
  const conflictPrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "FIX-CONFLICT",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: conflictPrepared.runId, approvedBy: "smoke-test" });
  claimRun({ vaultRoot: vault, runsRoot, runId: conflictPrepared.runId, services: taskServices });
  await executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: conflictPrepared.runId,
    agentInvocationBuilder: () => ({
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('README.md','\\nIsolated conflict note.\\n'); console.log(JSON.stringify({event:'result',result:{status:'ok'}}))"],
    }),
  });
  await retrospectRun({
    vaultRoot: vault,
    runsRoot,
    runId: conflictPrepared.runId,
    proposalGenerator: async () => ({
      classification: "IGNORE",
      confidence: 1,
      title: "Conflict fixture",
      type: "debugging",
      summary: "This fixture only verifies the isolated workspace conflict guard.",
      rationale: "The generated note is not durable reusable knowledge.",
      considerations: [],
      relatedKnowledge: [],
    }),
  });
  fs.writeFileSync(path.join(repository, "README.md"), "# External user edit\n");
  await assert.rejects(() => acceptRun({
    vaultRoot: vault,
    runsRoot,
    runId: conflictPrepared.runId,
    approvedBy: "smoke-test",
  }), /Workspace apply conflict/);
  const conflictFailed = listRuns(runsRoot).find((run) => run.runId === conflictPrepared.runId);
  assert.equal(conflictFailed.state, RUN_STATES.FAILED);
  assert.equal(conflictFailed.execution.workspace.state, "APPLY_FAILED");
  assert.equal(fs.readFileSync(path.join(repository, "README.md"), "utf8"), "# External user edit\n");

  const scopeTaskPath = path.join(taskDirectory, "task-scope-guard.md");
  fs.writeFileSync(scopeTaskPath, [
    "---",
    "title: Scope Guard",
    "type: task",
    "task_id: FIX-SCOPE",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "verification: [test]",
    "allowed_paths: [README.md]",
    "requires_changes: true",
    "sources: []",
    "---",
    "# Scope Guard",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Update only `README.md` with a scoped note.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "Only README changes and automated verification passes.",
  ].join("\n"));
  const scopePrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "FIX-SCOPE",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: scopePrepared.runId, approvedBy: "smoke-test" });
  claimRun({ vaultRoot: vault, runsRoot, runId: scopePrepared.runId, services: taskServices });
  await assert.rejects(() => executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: scopePrepared.runId,
    agentInvocationBuilder: () => ({
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('forbidden.txt','out of scope'); console.log(JSON.stringify({event:'result',result:{status:'ok'}}))"],
    }),
  }), /Scope guard menolak perubahan/);
  assert.equal(listRuns(runsRoot).find((run) => run.runId === scopePrepared.runId).state, RUN_STATES.FAILED);
  assert.equal(listRuns(runsRoot).find((run) => run.runId === scopePrepared.runId).execution.automaticRecovery, undefined);
  assert.equal(readMarkdown(scopeTaskPath, vault).metadata.status, "FAILED");

  fs.writeFileSync(path.join(repository, "README.md"), "# Automatic recovery baseline\n");
  const automaticRecoveryTaskPath = path.join(taskDirectory, "task-automatic-recovery.md");
  fs.writeFileSync(automaticRecoveryTaskPath, [
    "---",
    "title: Automatic Recovery",
    "type: task",
    "task_id: FIX-AUTO-RECOVERY",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    "dependencies: []",
    "verification: [test]",
    "allowed_paths: [README.md]",
    "requires_changes: true",
    "sources: []",
    "---",
    "# Automatic Recovery",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Append a verified automatic-recovery note to `README.md`.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "A failed verification is repaired automatically inside the isolated worktree.",
  ].join("\n"));
  const automaticRecoveryPrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "FIX-AUTO-RECOVERY",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: automaticRecoveryPrepared.runId, approvedBy: "smoke-test" });
  claimRun({ vaultRoot: vault, runsRoot, runId: automaticRecoveryPrepared.runId, services: taskServices });
  let automaticVerificationCalls = 0;
  const automaticallyRecovered = await executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: automaticRecoveryPrepared.runId,
    agentInvocationBuilder: () => ({ command: "fixture-agent", args: [] }),
    recoveryInvocationBuilder: () => ({
      command: "fixture-recovery-agent",
      args: [],
      agentConfig: { model: "fixture", effort: "low" },
    }),
    processRunner: async ({ stage, cwd }) => {
      if (stage === "coding-agent") {
        fs.appendFileSync(path.join(cwd, "README.md"), "\nBroken automatic recovery note.\n");
        return {
          exitCode: 0,
          stdoutTail: "",
          stderrTail: "",
          finalResult: {
            conversation_id: "fixture-auto-implementation",
            status: "SUCCESS",
            duration_seconds: 1,
            usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 120 },
          },
        };
      }
      if (stage === "verification:npm run test") {
        automaticVerificationCalls += 1;
        const content = fs.readFileSync(path.join(cwd, "README.md"), "utf8");
        return content.includes("Broken automatic recovery note")
          ? { exitCode: 2, stdoutTail: "", stderrTail: "Expected recovered note", finalResult: null }
          : { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: null };
      }
      if (stage === "automatic-recovery-agent:1") {
        const readmePath = path.join(cwd, "README.md");
        fs.writeFileSync(
          readmePath,
          fs.readFileSync(readmePath, "utf8").replace("Broken automatic recovery note", "Recovered automatic recovery note"),
        );
        return {
          exitCode: 0,
          stdoutTail: "",
          stderrTail: "",
          finalResult: {
            conversation_id: "fixture-auto-recovery",
            status: "SUCCESS",
            rootCause: "invalid fixture note",
            duration_seconds: 0.5,
            usage: { input_tokens: 60, output_tokens: 15, thinking_tokens: 3, cache_read_tokens: 20, total_tokens: 75 },
          },
        };
      }
      throw new Error(`Unexpected automatic-recovery stage: ${stage}`);
    },
  });
  assert.equal(automaticallyRecovered.state, RUN_STATES.REVIEW);
  assert.equal(automaticVerificationCalls, 3);
  assert.equal(automaticallyRecovered.execution.automaticRecovery.status, "SUCCESS");
  assert.equal(automaticallyRecovered.execution.automaticRecovery.strategy, "AI_REPAIR");
  assert.equal(automaticallyRecovered.execution.automaticRecovery.successfulAttempt, 1);
  assert.equal(automaticallyRecovered.execution.automaticRecovery.deterministicRetry.outcome, "FAILED");
  assert.equal(automaticallyRecovered.execution.automaticRecovery.attempts.length, 1);
  assert.equal(automaticallyRecovered.execution.telemetry.summary.calls, 2);
  assert.equal(automaticallyRecovered.execution.telemetry.summary.usage.totalTokens, 195);
  assert.equal(automaticallyRecovered.execution.telemetry.summary.byStage.AUTOMATIC_RECOVERY.calls, 1);
  assert.match(
    fs.readFileSync(path.join(automaticallyRecovered.execution.workspace.path, "README.md"), "utf8"),
    /Recovered automatic recovery note/,
  );
  assert.doesNotMatch(fs.readFileSync(path.join(repository, "README.md"), "utf8"), /Recovered automatic recovery note/);
  assert.equal(
    interactionStatus({ runsRoot, selector: "FIX-AUTO-RECOVERY" }).progress.automaticRecovery.status,
    "SUCCESS",
  );
  await retrospectRun({
    vaultRoot: vault,
    runsRoot,
    runId: automaticRecoveryPrepared.runId,
    proposalGenerator: async () => ({
      classification: "IGNORE",
      confidence: 1,
      title: "Automatic recovery fixture",
      type: "debugging",
      summary: "The fixture verifies bounded automatic recovery behavior.",
      rationale: "The fixture output is not reusable product knowledge.",
      considerations: [],
      relatedKnowledge: [],
    }),
  });
  const automaticRecoveryRejected = await rejectTaskRun({
    vaultRoot: vault,
    runsRoot,
    runId: automaticRecoveryPrepared.runId,
    rejectedBy: "smoke-test",
    reason: "Fixture cleanup.",
  });
  assert.equal(automaticRecoveryRejected.execution.workspace.state, "DISCARDED");
  assert.doesNotMatch(fs.readFileSync(path.join(repository, "README.md"), "utf8"), /Recovered automatic recovery note/);

  const deterministicTaskPath = path.join(taskDirectory, "task-deterministic-retry.md");
  fs.writeFileSync(deterministicTaskPath, [
    "---",
    "title: Deterministic Recovery Retry",
    "type: task",
    "task_id: FIX-AUTO-RETRY",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-15",
    "updated: 2026-08-15",
    "dependencies: []",
    "verification: [test]",
    "allowed_paths: [README.md]",
    "requires_changes: true",
    "sources: []",
    "---",
    "# Deterministic Recovery Retry",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Append a transient-retry note to `README.md`.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "A transient verification failure recovers without invoking an AI repair agent.",
  ].join("\n"));
  const deterministicPrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "FIX-AUTO-RETRY",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: deterministicPrepared.runId, approvedBy: "smoke-test" });
  claimRun({ vaultRoot: vault, runsRoot, runId: deterministicPrepared.runId, services: taskServices });
  let deterministicVerificationCalls = 0;
  const deterministicallyRecovered = await executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: deterministicPrepared.runId,
    agentInvocationBuilder: () => ({ command: "fixture-agent", args: [] }),
    recoveryInvocationBuilder: () => {
      throw new Error("AI repair must not run for deterministic recovery success.");
    },
    processRunner: async ({ stage, cwd }) => {
      if (stage === "coding-agent") {
        fs.appendFileSync(path.join(cwd, "README.md"), "\nTransient retry note.\n");
        return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: { status: "SUCCESS" } };
      }
      if (stage === "verification:npm run test") {
        deterministicVerificationCalls += 1;
        return deterministicVerificationCalls === 1
          ? { exitCode: 2, stdoutTail: "", stderrTail: "Transient test failure", finalResult: null }
          : { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: null };
      }
      throw new Error(`Unexpected deterministic-retry stage: ${stage}`);
    },
  });
  assert.equal(deterministicallyRecovered.state, RUN_STATES.REVIEW);
  assert.equal(deterministicVerificationCalls, 2);
  assert.equal(deterministicallyRecovered.execution.automaticRecovery.status, "SUCCESS");
  assert.equal(deterministicallyRecovered.execution.automaticRecovery.strategy, "DETERMINISTIC_RETRY");
  assert.equal(deterministicallyRecovered.execution.automaticRecovery.attempts.length, 0);
  await retrospectRun({
    vaultRoot: vault,
    runsRoot,
    runId: deterministicPrepared.runId,
    proposalGenerator: async () => ({
      classification: "IGNORE",
      confidence: 1,
      title: "Deterministic recovery fixture",
      type: "debugging",
      summary: "The fixture verifies a token-free deterministic verification retry.",
      rationale: "Transient fixture behavior is not durable product knowledge.",
      considerations: [],
      relatedKnowledge: [],
    }),
  });
  await rejectTaskRun({
    vaultRoot: vault,
    runsRoot,
    runId: deterministicPrepared.runId,
    rejectedBy: "smoke-test",
    reason: "Fixture cleanup.",
  });

  const staleTaskPath = path.join(taskDirectory, "task-stale.md");
  fs.writeFileSync(staleTaskPath, [
    "---",
    "title: Stale Fingerprint",
    "type: task",
    "task_id: FIX-002",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "verification: [test]",
    "sources: []",
    "---",
    "# Stale Fingerprint",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Exercise fingerprint validation after a prepared task is changed.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "Claim rejects the task when its approved fingerprint is no longer current.",
  ].join("\n"));
  const stalePrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "task-stale",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: stalePrepared.runId, approvedBy: "smoke-test" });
  fs.appendFileSync(staleTaskPath, "\nInstruction changed after approval.\n");
  assert.throws(() => claimRun({
    vaultRoot: vault,
    runsRoot,
    runId: stalePrepared.runId,
    services: taskServices,
  }), /Fingerprint task berubah/);
  assert.equal(readMarkdown(staleTaskPath, vault).metadata.status, "READY");

  const recoveryTaskPath = path.join(taskDirectory, "task-recovery.md");
  fs.writeFileSync(recoveryTaskPath, [
    "---",
    "title: Verification Recovery",
    "type: task",
    "task_id: FIX-RECOVERY",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "verification: [test]",
    "allowed_paths: [README.md]",
    "requires_changes: true",
    "sources: []",
    "---",
    "# Verification Recovery",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Append a recovery note to `README.md`.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "README contains the note and verification recovery passes.",
  ].join("\n"));
  const recoveryPrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "FIX-RECOVERY",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: recoveryPrepared.runId, approvedBy: "smoke-test" });
  claimRun({ vaultRoot: vault, runsRoot, runId: recoveryPrepared.runId, services: taskServices });
  await assert.rejects(() => executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: recoveryPrepared.runId,
    maxAutomaticRecoveryAttempts: 1,
    processRunner: async ({ stage, cwd }) => {
      if (stage === "coding-agent") {
        fs.appendFileSync(path.join(cwd, "README.md"), "\nRecovery note.\n");
        return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: { status: "SUCCESS" } };
      }
      if (stage === "verification:npm run test") {
        return { exitCode: 2, stdoutTail: "", stderrTail: "", finalResult: null };
      }
      if (stage === "automatic-recovery-agent:1") {
        return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: { status: "NO_SAFE_FIX" } };
      }
      throw new Error(`Unexpected smoke-test stage: ${stage}`);
    },
  }), /Verification gagal/);
  const failedVerification = listRuns(runsRoot).find((run) => run.runId === recoveryPrepared.runId);
  assert.equal(failedVerification.state, RUN_STATES.FAILED);
  assert.deepEqual(failedVerification.execution.verification, [{ command: "npm run test", exitCode: 2 }]);
  assert.equal(failedVerification.execution.automaticRecovery.status, "EXHAUSTED");
  assert.equal(failedVerification.execution.automaticRecovery.deterministicRetry.outcome, "FAILED");
  assert.equal(failedVerification.execution.automaticRecovery.attempts.length, 1);
  const recovered = await recoverRun({
    vaultRoot: vault,
    runsRoot,
    runId: recoveryPrepared.runId,
    recoveredBy: "smoke-test",
    force: true,
    processRunner: async ({ stage }) => {
      assert.equal(stage, "verification:npm run test");
      return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: null };
    },
  });
  assert.equal(recovered.state, RUN_STATES.REVIEW);
  assert.equal(recovered.execution.recovery.status, "SUCCESS");
  assert.deepEqual(recovered.execution.verification, [{ command: "npm run test", exitCode: 0 }]);
  assert.equal(readMarkdown(recoveryTaskPath, vault).metadata.status, "REVIEW");

  const failingTaskPath = path.join(taskDirectory, "task-003.md");
  fs.writeFileSync(failingTaskPath, [
    "---",
    "title: Failing Executor",
    "type: task",
    "task_id: FIX-003",
    "project: fixture-app",
    "status: READY",
    "tags: [task]",
    "created: 2026-08-14",
    "updated: 2026-08-14",
    "dependencies: []",
    "verification: [test]",
    "sources: []",
    "---",
    "# Failing Executor",
    "## Apa Yang Ingin Dikerjakan (Instruksi)",
    "Exercise the failure path when the coding agent exits unsuccessfully.",
    "## Hasil Yang Diharapkan (Expected Result)",
    "The task and run become FAILED and the exclusive claim lock is released.",
  ].join("\n"));
  const failingPrepared = prepareRun({
    vaultRoot: vault,
    runsRoot,
    projectId: "fixture-app",
    taskInput: "task-003",
    services: taskServices,
  });
  approveRun({ runsRoot, runId: failingPrepared.runId, approvedBy: "smoke-test" });
  const failingClaimed = claimRun({
    vaultRoot: vault,
    runsRoot,
    runId: failingPrepared.runId,
    services: taskServices,
  });
  await assert.rejects(() => executeRun({
    vaultRoot: vault,
    runsRoot,
    runId: failingPrepared.runId,
    agentInvocationBuilder: () => ({
      command: process.execPath,
      args: ["-e", "process.stderr.write('fixture failure'); process.exit(2)"],
    }),
  }), /Coding agent gagal/);
  const failed = listRuns(runsRoot).find((run) => run.runId === failingPrepared.runId);
  assert.equal(failed.state, RUN_STATES.FAILED);
  assert.equal(readMarkdown(failingTaskPath, vault).metadata.status, "FAILED");
  assert.equal(fs.existsSync(path.join(runsRoot, failingClaimed.execution.lock)), false);
  await assert.rejects(() => retryTaskRun({
    vaultRoot: vault,
    runsRoot,
    runId: failingPrepared.runId,
    requestedBy: "smoke-test",
  }), /--force/);
  const forcedRetry = await retryTaskRun({
    vaultRoot: vault,
    runsRoot,
    runId: failingPrepared.runId,
    requestedBy: "smoke-test",
    force: true,
  });
  assert.equal(forcedRetry.action, "TASK_REQUEUED");
  assert.equal(forcedRetry.job.state, JOB_STATES.QUEUED);
  assert.equal(readMarkdown(failingTaskPath, vault).metadata.status, "BACKLOG");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("orchestrator smoke test passed");
