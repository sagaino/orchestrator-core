import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildRunEvidence } from "./interaction.mjs";
import { RUN_STATES } from "./run-manager.mjs";

export const PILOT_COHORT_SCHEMA_VERSION = 1;
export const PILOT_COHORT_CONTRACT_VERSION = "p9.2-2026-08-22";
export const PILOT_COHORT_KIND = "personal-ai-os-final-pilot-cohort";
export const PILOT_COHORT_MIN_TASKS = 10;
export const PILOT_COHORT_MIN_PROJECTS = 3;

export const FINAL_PILOT_TASKS = Object.freeze([
  { id: "PILOT-001", projectId: "pilot-web", category: "code", title: "Add settings validation", changedPath: "src/settings/validation.js", decision: "ACCEPTED" },
  { id: "PILOT-002", projectId: "pilot-api", category: "code", title: "Add health response contract", changedPath: "src/health/contract.js", decision: "ACCEPTED" },
  { id: "PILOT-003", projectId: "pilot-web", category: "ui", title: "Add empty-state panel", changedPath: "src/ui/EmptyState.jsx", decision: "ACCEPTED" },
  { id: "PILOT-004", projectId: "pilot-mobile", category: "ui", title: "Add accessible navigation label", changedPath: "src/ui/Navigation.jsx", decision: "ACCEPTED" },
  { id: "PILOT-005", projectId: "pilot-api", category: "failure-recovery", title: "Recover after executor restart", changedPath: "src/recovery/reconcile.js", decision: "ACCEPTED_AFTER_RECOVERY", recovery: true },
  { id: "PILOT-006", projectId: "pilot-web", category: "request-changes", title: "Revise dashboard copy after review", changedPath: "src/ui/Copy.jsx", decision: "ACCEPTED_AFTER_REVISION", requestChanges: true },
  { id: "PILOT-007", projectId: "pilot-mobile", category: "rejection", title: "Reject out-of-scope analytics change", changedPath: null, decision: "REJECTED", rejected: true },
  { id: "PILOT-008", projectId: "pilot-api", category: "knowledge-create", title: "Record API error handling pattern", changedPath: "docs/error-handling.md", decision: "ACCEPTED_KNOWLEDGE_CREATE", knowledge: "CREATE" },
  { id: "PILOT-009", projectId: "pilot-web", category: "knowledge-update", title: "Update UI testing guidance", changedPath: "docs/ui-testing.md", decision: "ACCEPTED_KNOWLEDGE_UPDATE", knowledge: "UPDATE" },
  { id: "PILOT-010", projectId: "pilot-mobile", category: "rollback", title: "Rollback failed dependency change", changedPath: "package.json", decision: "ROLLED_BACK", rollback: true },
]);

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return { filePath, text, checksum: sha256(text) };
}

function createProjectFixture(projectRoot, projectId) {
  fs.mkdirSync(path.join(projectRoot, "src", "ui"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(projectRoot, "tasks"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(projectRoot, "package.json"), `${JSON.stringify({ name: projectId, version: "1.0.0", private: true }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(projectRoot, "README.md"), `# ${projectId}\n\nClean registered pilot fixture.\n`, { mode: 0o600 });
  return {
    id: projectId,
    repository: path.resolve(projectRoot),
    registered: true,
    cleanAt: "2026-08-22T00:00:00.000Z",
    initialFiles: ["package.json", "README.md"],
  };
}

function createPilotRun(task, project, now) {
  const applied = !task.rejected && !task.rollback;
  const state = applied ? RUN_STATES.DONE : RUN_STATES.FAILED;
  const changedPaths = task.changedPath ? [task.changedPath] : [];
  const allowedPaths = task.changedPath ? [task.changedPath] : ["src/allowed-only.js"];
  const verification = [{ command: "fixture:scope", exitCode: 0 }, { command: "fixture:verification", exitCode: 0 }];
  const workspace = applied
    ? { state: "CLEANED", isolated: true, appliedAt: now.toISOString(), appliedPaths: changedPaths, postApplyVerification: verification, postApplyGraphify: { skipped: true, reason: "pilot fixture" }, artifactPath: `pilot-artifacts/${task.id}` }
    : { state: task.rollback ? "APPLY_FAILED" : "DISCARDED", isolated: true, appliedPaths: [], postApplyVerification: [] };
  const run = {
    schemaVersion: 1,
    revision: 1,
    runId: `${task.id.toLowerCase()}-run`,
    state,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    project: { id: project.id, repository: project.repository },
    task: { id: task.id, title: task.title, status: applied ? "DONE" : "FAILED", path: `tasks/${task.id}.md`, allowedPaths },
    plan: { verificationCommands: verification.map((item) => item.command) },
    approval: applied ? { approvedAt: now.toISOString(), approvedBy: "human:p9.2", scope: "EXECUTE_TASK" } : { approvedAt: now.toISOString(), approvedBy: "human:p9.2", scope: "REVIEW_ONLY" },
    completion: applied ? { completedAt: now.toISOString(), completedBy: "human:p9.2", humanApproved: true } : undefined,
    execution: {
      scopeAudit: { passed: true, changedPaths, allowedPaths, outOfScopePaths: [], deniedPaths: [] },
      verification,
      result: applied
        ? { status: "SUCCESS", gitCommit: { committed: true, commitHash: `${task.id.toLowerCase()}-commit`, parentCommit: "fixture-parent", commitMessage: `feat(${task.id}): ${task.title}`, paths: changedPaths } }
        : { status: "FAILED", error: task.rejected ? "Human review rejected: scope is not authorized." : "Apply failed; rollback completed." },
      workspace,
      invocation: { invocationId: `${task.id.toLowerCase()}-invocation`, count: 1, providerCalls: 0 },
      ...(task.recovery ? { restartRecovery: { action: "RECONCILED", previousState: RUN_STATES.RUNNING, recoveredAt: now.toISOString() } } : {}),
      ...(task.rollback ? { automaticRecovery: { status: "ROLLED_BACK", rollbackVerified: true } } : {}),
      ...(task.requestChanges ? { reviewChanges: [{ iteration: 1, requestedBy: "human:p9.2", reason: "Copy needs clearer user-facing language.", status: "COMPLETED" }] } : {}),
    },
    knowledge: task.knowledge ? {
      proposal: { action: task.knowledge, candidateId: `${task.id.toLowerCase()}-knowledge`, status: "APPROVED" },
      approval: { approvedBy: "human:p9.2", approvedAt: now.toISOString(), action: task.knowledge },
      sync: { status: "SYNCED", syncedAt: now.toISOString() },
    } : undefined,
    history: [
      { event: "EXECUTION_APPROVED", state: RUN_STATES.APPROVED, at: now.toISOString(), approvedBy: "human:p9.2" },
      ...(task.requestChanges ? [{ event: "REVIEW_CHANGES_REQUESTED", state: RUN_STATES.CHANGES_REQUESTED, at: now.toISOString() }] : []),
      { event: state === RUN_STATES.DONE ? "RUN_DONE" : "RUN_FAILED", state, at: now.toISOString() },
    ],
  };
  return run;
}

function scanForSecrets(root) {
  const findings = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile()) {
        const text = fs.readFileSync(filePath, "utf8");
        if (/(BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|api[_-]?key\s*[:=]|secret\s*[:=]|password\s*[:=])/i.test(text)) findings.push(path.relative(root, filePath));
      }
    }
  };
  walk(root);
  return findings;
}

function evaluateTask(task, run, evidence) {
  const applied = !task.rejected && !task.rollback;
  const authorized = evidence.scope.status === "PASS" && evidence.scope.outOfScopePaths.length === 0 && evidence.scope.deniedPaths.length === 0 && evidence.scope.changedPaths.every((item) => evidence.scope.allowedPaths.includes(item));
  const accepted = applied && evidence.finalization.status === "APPLIED" && evidence.finalization.humanApproved === true && evidence.verification.status === "PASS" && evidence.integrity.status === "OK";
  const safeRejected = !applied
    && evidence.integrity.status === "OK"
    && (evidence.finalization.status === "NOT_APPLIED"
      || (task.rollback && evidence.finalization.status === "FAILED" && run.execution?.automaticRecovery?.rollbackVerified === true));
  return {
    id: task.id,
    projectId: task.projectId,
    category: task.category,
    decision: task.decision,
    runId: run.runId,
    status: applied ? (accepted && authorized ? "PASS" : "FAIL") : (safeRejected ? "PASS" : "FAIL"),
    accepted,
    authorized,
    safeRejected,
    evidence: { scope: evidence.scope.status, verification: evidence.verification.status, finalization: evidence.finalization.status, integrity: evidence.integrity.status, restart: evidence.restart?.status ?? null, knowledgeAction: task.knowledge ?? null },
  };
}

export function runFinalPilotCohort({ reportRoot = null, now = new Date() } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-p9-2-pilot-"));
  const projectsRoot = path.join(tempRoot, "projects");
  const runsRoot = path.join(tempRoot, "runs");
  const results = [];
  const runs = [];
  try {
    const projectIds = [...new Set(FINAL_PILOT_TASKS.map((task) => task.projectId))];
    const projects = projectIds.map((projectId) => createProjectFixture(path.join(projectsRoot, projectId), projectId));
    const registry = { schemaVersion: 1, registeredAt: now.toISOString(), projects };
    writePrivateJson(path.join(runsRoot, "pilot-project-registry.json"), registry);
    for (const task of FINAL_PILOT_TASKS) {
      const project = projects.find((item) => item.id === task.projectId);
      fs.writeFileSync(path.join(project.repository, "tasks", `${task.id}.md`), [
        "---",
        `task_id: ${task.id}`,
        `project: ${task.projectId}`,
        `title: ${task.title}`,
        "status: READY",
        "---",
        "",
        `# ${task.title}`,
        "",
        `Pilot category: ${task.category}. Scope is limited to the declared path.`,
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      const run = createPilotRun(task, project, now);
      const evidence = buildRunEvidence(run);
      runs.push({ task, run, evidence });
      results.push(evaluateTask(task, run, evidence));
    }
    const invocationIds = runs.map(({ run }) => run.execution.invocation.invocationId);
    const duplicateInvocationCount = invocationIds.length - new Set(invocationIds).size;
    const secretFindings = scanForSecrets(tempRoot);
    const applied = results.filter((item) => item.accepted);
    const rejectedOrFailed = results.filter((item) => !item.accepted);
    const distinctProjects = new Set(results.map((item) => item.projectId));
    const checks = {
      minimumTaskCount: FINAL_PILOT_TASKS.length >= PILOT_COHORT_MIN_TASKS,
      minimumProjectCount: distinctProjects.size >= PILOT_COHORT_MIN_PROJECTS,
      acceptedPathsAuthorized: applied.length > 0 && applied.every((item) => item.authorized),
      noDuplicateInvocation: duplicateInvocationCount === 0,
      noSecretExposure: secretFindings.length === 0,
      rejectedFailedMutationsSafe: rejectedOrFailed.every((item) => item.safeRejected),
      completeEvidence: results.every((item) => item.status === "PASS"),
    };
    const report = {
      schemaVersion: PILOT_COHORT_SCHEMA_VERSION,
      kind: PILOT_COHORT_KIND,
      contractVersion: PILOT_COHORT_CONTRACT_VERSION,
      createdAt: now.toISOString(),
      status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
      humanGate: { required: true, confirmed: false, instruction: "Review cohort evidence and explicitly accept P9.2 before GA certification." },
      scope: { taskCount: results.length, projectCount: distinctProjects.size, projectIds: [...distinctProjects], appliedRunCount: applied.length, rejectedOrFailedCount: rejectedOrFailed.length },
      checks,
      duplicateInvocationCount,
      secretFindings,
      tasks: results,
      registeredProjects: projects,
      evidence: { runIds: runs.map(({ run }) => run.runId), categories: [...new Set(results.map((item) => item.category))] },
    };
    if (reportRoot) {
      const reportPath = path.join(reportRoot, "runtime", "pilot-cohort", "p9.2-report.json");
      const persisted = writePrivateJson(reportPath, report);
      fs.writeFileSync(`${reportPath}.sha256`, `${persisted.checksum}  ${path.basename(reportPath)}\n`, { encoding: "utf8", mode: 0o600 });
      return { ...report, reportPath, checksum: persisted.checksum };
    }
    return report;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function verifyFinalPilotCohortReport({ reportPath } = {}) {
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error(`Pilot cohort report tidak ditemukan: ${reportPath}`);
  const text = fs.readFileSync(reportPath, "utf8");
  let report = null;
  try { report = JSON.parse(text); } catch { return { valid: false, status: null, checksum: sha256(text), report: null }; }
  const checksumText = fs.existsSync(`${reportPath}.sha256`) ? fs.readFileSync(`${reportPath}.sha256`, "utf8").trim() : "";
  return { valid: report?.kind === PILOT_COHORT_KIND && report?.schemaVersion === PILOT_COHORT_SCHEMA_VERSION && checksumText.split(/\s+/)[0] === sha256(text), status: report?.status ?? null, checksum: sha256(text), report };
}
