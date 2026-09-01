import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAiOsE2eHarness } from "./helpers/ai-os-e2e-fixture.mjs";
import { planObjective } from "../src/objective-planning.mjs";
import { getObjective } from "../src/objective-store.mjs";
import { schedulerTick } from "../src/orchestration-scheduler.mjs";
import { listJobs, claimNextJob, updateJob, JOB_STATES } from "../src/job-queue.mjs";
import { verifyAuditChain } from "../src/audit-chain.mjs";
import { buildDeliveryCertificationEvidence } from "../src/delivery-certification.mjs";
import { executeRun } from "../src/executor.mjs";
import { startTaskRun } from "../src/task-workflow.mjs";
import { processClaimedJob } from "../src/daemon.mjs";
import { acceptRun, retrospectRun } from "../src/knowledge-workflow.mjs";
import { getRun } from "../src/run-manager.mjs";
import { readMarkdown, buildContext, buildPlan } from "../src/core.mjs";
import { validateTaskReadiness } from "../src/task-readiness.mjs";

console.log("Running ai-os-objective-lifecycle-e2e.test.mjs...");

const harness = await createAiOsE2eHarness();
const taskServices = { readMarkdown, buildContext, buildPlan, validateTaskReadiness };

async function localProcessRunner(invocation) {
  try {
    const stdout = execFileSync(invocation.command, invocation.args ?? [], {
      cwd: invocation.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdoutTail: stdout ?? "", stderrTail: "", finalResult: null };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.status) ? error.status : 1,
      stdoutTail: String(error.stdout ?? ""),
      stderrTail: String(error.stderr ?? error.message ?? ""),
      finalResult: null,
    };
  }
}

function deterministicExecutor({ relativePath, regression = false }) {
  return (options) => executeRun({
    ...options,
    maxAutomaticRecoveryAttempts: 0,
    workspaceProcessRunner: localProcessRunner,
    dependencyReconciler: async () => ({ skipped: true, reason: "Fixture dependencies are frozen." }),
    agentInvocationBuilder: () => ({ command: "fixture-agent", args: [] }),
    processRunner: async (invocation) => {
      if (String(invocation.stage).includes("agent")) {
        const target = path.join(invocation.cwd, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "export const fixtureChange = true;\n");
        return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: { status: "ok" } };
      }
      if (String(invocation.stage).startsWith("baseline-verification:lint")) {
        return { exitCode: 0, stdoutTail: "[]", stderrTail: "", finalResult: null };
      }
      if (String(invocation.stage).startsWith("verification:") && String(invocation.stage).includes("lint")) {
        const findings = regression ? [{
          filePath: path.join(invocation.cwd, relativePath),
          messages: [{ ruleId: "fixture/no-regression", severity: 2, line: 1, column: 1, message: "Fixture regression" }],
        }] : [];
        return { exitCode: regression ? 1 : 0, stdoutTail: JSON.stringify(findings), stderrTail: "", finalResult: null };
      }
      return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: null };
    },
  });
}

async function runClaimedProductionJob(job, executor) {
  return processClaimedJob({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    job,
    services: taskServices,
    notifier: async () => ({ created: false, notification: null }),
    workflow: (options) => startTaskRun({
      ...options,
      executor,
      retrospective: (retrospectiveOptions) => retrospectRun({
        ...retrospectiveOptions,
        proposalGenerator: async () => ({
          classification: "PROJECT_ONLY",
          confidence: 1,
          title: "Deterministic E2E fixture",
          type: "snippet",
          targetPath: null,
          summary: "Production lifecycle E2E fixture.",
          rationale: "Test-only project-local change.",
          considerations: [],
          relatedKnowledge: [],
        }),
      }),
    }),
  });
}

try {
  // === Scenario 1: Happy Path through Complete Lifecycle ===
  console.log("  Scenario 1: Happy path objective lifecycle through final acceptance & audit chain...");
  const intakeRes = await harness.requestJson("/api/objectives", {
    method: "POST",
    headers: { "idempotency-key": "e2e-happy-path-1" },
    body: {
      projectId: "frontend-app",
      request: "Tolong tambahkan badge status dan jalankan typecheck, lint, serta build.",
    },
  });

  assert.equal(intakeRes.status, 201);
  const objectiveId = intakeRes.data.data.objective.objectiveId;
  assert.ok(objectiveId);

  // Planning with mock decomposer
  const planResult = await planObjective({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    objectiveId,
    decomposer: async ({ objective, projectContexts, verificationIntent }) => {
      assert.equal(verificationIntent.status, "RESOLVED");
      assert.equal(verificationIntent.resolved.length, 3);
      return {
        status: "PLAN_REVIEW",
        plan: {
          schemaVersion: 2,
          planId: `plan-${objective.objectiveId}-r1`,
          objectiveId: objective.objectiveId,
          revision: 1,
          state: "PENDING_APPROVAL",
          summary: "Implement status badge with verification intent coverage",
          architectureDecisions: [],
          assumptions: [],
          clarificationNeeded: false,
          clarificationQuestion: null,
          projects: ["frontend-app"],
          nodes: [{
            nodeId: "N1",
            title: "Implement status badge",
            purpose: "Create status badge component in frontend-app",
            projectId: "frontend-app",
            role: "FRONTEND",
            type: "IMPLEMENTATION",
            dependsOn: [],
            acceptanceCriteria: ["Status badge renders online/offline"],
            allowedPaths: ["src/components/StatusBadge.tsx"],
            verification: ["typecheck", "lint", "build"],
            risk: "LOW",
            complexity: "LOW",
            requiresChanges: true,
            canRunInParallel: false,
            writeConflictGroup: null,
            contextFrom: [],
            skills: [],
          }],
          integration: {
            required: false,
            projectVerification: ["frontend-app:build"],
            crossProjectVerification: [],
            previewRequired: false,
          },
          risk: "LOW",
          complexity: "LOW",
          approvedBy: null,
          approvedAt: null,
          createdAt: new Date().toISOString(),
        },
      };
    },
  });

  assert.equal(planResult.status, "PLAN_REVIEW");
  assert.ok(planResult.plan.verificationIntent);
  assert.equal(planResult.plan.verificationIntent.resolved.length, 3);

  // Assert no tasks or runs exist yet before approval
  const objectiveBeforeApprove = getObjective(harness.runsRoot, objectiveId);
  assert.equal(objectiveBeforeApprove.state, "PLAN_REVIEW");

  // Approve plan
  const approveRes = await harness.requestJson(`/api/objectives/${objectiveId}/approve-plan`, {
    method: "POST",
    headers: { "idempotency-key": "approve-happy-1" },
    body: {
      planFingerprint: planResult.plan.planFingerprint,
    },
  });
  assert.equal(approveRes.status, 201);

  // Materialize & Start Orchestration
  const matRes = await harness.requestJson(`/api/objectives/${objectiveId}/materialize`, {
    method: "POST",
    headers: { "idempotency-key": "mat-happy-1" },
    body: {
      planFingerprint: planResult.plan.planFingerprint,
    },
  });
  assert.equal(matRes.status, 201);

  // Scheduler ticks and queues job
  const tick = schedulerTick({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    enabled: true,
  });
  assert.equal(tick.queued.length, 1);
  const queuedJob = tick.queued[0];
  assert.equal(queuedJob.taskId, "TASK-001");

  // Claim job
  const claim = claimNextJob(harness.runsRoot);
  assert.ok(claim);

  const productionResult = await runClaimedProductionJob(
    claim,
    deterministicExecutor({ relativePath: "src/components/StatusBadge.tsx" }),
  );
  assert.equal(productionResult.error, undefined);
  const runId = productionResult.manifest.runId;
  const reviewRun = getRun(harness.runsRoot, runId);
  assert.equal(reviewRun.state, "RETROSPECTIVE");
  assert.equal(reviewRun.execution.baselineVerification.lint.parseResult.status, "PARSED");
  assert.equal(reviewRun.execution.verification.find((item) => item.command.includes("lint")).status, "PASS_NO_REGRESSION");

  const completedRun = await acceptRun({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    runId,
    approvedBy: "system:e2e-autopilot",
    decision: "PROJECT_ONLY",
    autoCommit: true,
  });
  assert.equal(completedRun.state, "DONE");
  assert.equal(completedRun.execution.workspace.state, "CLEANED");
  updateJob(harness.runsRoot, queuedJob.jobId, { state: JOB_STATES.DONE, runId, runState: "DONE" });
  schedulerTick({ vaultRoot: harness.vaultRoot, runsRoot: harness.runsRoot, enabled: true });

  // Delivery certification check
  const deliveryCert = buildDeliveryCertificationEvidence({
    runsRoot: harness.runsRoot,
    objectiveId,
    automatic: true,
  });
  assert.equal(deliveryCert.blockers.length, 0, `Blockers should be empty, got: ${deliveryCert.blockers.join(", ")}`);

  // Final acceptance via API
  const finalRes = await harness.requestJson(`/api/objectives/${objectiveId}/final-acceptance`, {
    method: "POST",
    headers: { "idempotency-key": "final-happy-1" },
  });
  assert.equal(finalRes.status, 201);
  assert.equal(finalRes.data.data.objective.state, "DONE");

  // Idempotent repeated final acceptance
  const repeatFinalRes = await harness.requestJson(`/api/objectives/${objectiveId}/final-acceptance`, {
    method: "POST",
    headers: { "idempotency-key": "final-happy-2" },
  });
  assert.equal(repeatFinalRes.status, 200);

  // Verify audit chain
  const auditState = verifyAuditChain(harness.runsRoot);
  assert.equal(auditState.valid, true);
  assert.ok(auditState.entries >= 4);

  // === Scenario 2: Cancellation at Actual Plan Review ===
  console.log("  Scenario 2: Cancellation at plan review with zero task/run artifacts...");
  const cancelIntake = await harness.requestJson("/api/objectives", {
    method: "POST",
    headers: { "idempotency-key": "e2e-cancel-1" },
    body: {
      projectId: "frontend-app",
      request: "Instruksi yang akan dibatalkan di plan review.",
    },
  });
  const cancelObjId = cancelIntake.data.data.objective.objectiveId;

  // Plan it so it reaches PLAN_REVIEW
  await planObjective({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    objectiveId: cancelObjId,
    decomposer: async ({ objective }) => ({
      status: "PLAN_REVIEW",
      plan: {
        schemaVersion: 1,
        planId: `plan-${objective.objectiveId}-r1`,
        objectiveId: objective.objectiveId,
        revision: 1,
        state: "PENDING_APPROVAL",
        summary: "Will be cancelled at plan review",
        architectureDecisions: [],
        assumptions: [],
        clarificationNeeded: false,
        clarificationQuestion: null,
        projects: ["frontend-app"],
        nodes: [{
          nodeId: "N1",
          title: "Cancel me",
          purpose: "Cancel test",
          projectId: "frontend-app",
          role: "FRONTEND",
          type: "IMPLEMENTATION",
          dependsOn: [],
          acceptanceCriteria: ["Must cancel safely"],
          allowedPaths: ["src/components/CancelMe.tsx"],
          verification: ["typecheck"],
          risk: "LOW",
          complexity: "LOW",
          requiresChanges: true,
          canRunInParallel: false,
          writeConflictGroup: null,
          contextFrom: [],
          skills: [],
        }],
        integration: {
          required: false,
          projectVerification: ["frontend-app:typecheck"],
          crossProjectVerification: [],
          previewRequired: false,
        },
        risk: "LOW",
        complexity: "LOW",
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date().toISOString(),
      },
    }),
  });

  const objAtPlanReview = getObjective(harness.runsRoot, cancelObjId);
  assert.equal(objAtPlanReview.state, "PLAN_REVIEW");

  const cancelRes = await harness.requestJson(`/api/objectives/${cancelObjId}/cancel`, {
    method: "POST",
    headers: { "idempotency-key": "cancel-key-1" },
  });
  assert.equal(cancelRes.status, 201);
  const cancelledObj = getObjective(harness.runsRoot, cancelObjId);
  assert.equal(cancelledObj.state, "CANCELLED");

  // Verify zero task files were written to vault for cancelObjId
  const taskDir = path.join(harness.vaultRoot, "02-Projects", "frontend-app", "tasks");
  const taskFiles = fs.readdirSync(taskDir);
  assert.equal(taskFiles.length, 1); // Only TASK-001 from Scenario 1 exists

  // === Scenario 3: Unavailable requested check produces NEEDS_CLARIFICATION ===
  console.log("  Scenario 3: Missing verification check produces clarification...");
  const missingIntake = await harness.requestJson("/api/objectives", {
    method: "POST",
    headers: { "idempotency-key": "e2e-missing-check-1" },
    body: {
      projectId: "frontend-app",
      request: "Tolong jalankan route test e2e browser cypress",
    },
  });
  const missingObjId = missingIntake.data.data.objective.objectiveId;

  const missingPlanResult = await planObjective({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    objectiveId: missingObjId,
  });

  assert.equal(missingPlanResult.status, "NEEDS_CLARIFICATION");
  assert.match(missingPlanResult.clarificationQuestion, /E2E/i);
  const clarifiedObj = getObjective(harness.runsRoot, missingObjId);
  assert.equal(clarifiedObj.state, "NEEDS_CLARIFICATION");

  // === Scenario 4: Plan Fingerprint mismatch rejected at approval ===
  console.log("  Scenario 4: Fingerprint mismatch rejected at approval...");
  const mismatchApproveRes = await harness.requestJson(`/api/objectives/${objectiveId}/approve-plan`, {
    method: "POST",
    headers: { "idempotency-key": "approve-mismatch" },
    body: {
      planFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  });
  assert.equal(mismatchApproveRes.status, 409);

  // === Scenario 5: Regression in baseline findings blocks delivery certification ===
  console.log("  Scenario 5: Regression in baseline verification findings blocks certification...");
  const regObjRes = await harness.requestJson("/api/objectives", {
    method: "POST",
    headers: { "idempotency-key": "e2e-reg-1" },
    body: {
      projectId: "frontend-app",
      request: "Fitur dengan regresi lint.",
    },
  });
  const regObjId = regObjRes.data.data.objective.objectiveId;

  const regPlanRes = await planObjective({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    objectiveId: regObjId,
    decomposer: async ({ objective }) => ({
      status: "PLAN_REVIEW",
      plan: {
        schemaVersion: 1,
        planId: `plan-${objective.objectiveId}-r1`,
        objectiveId: objective.objectiveId,
        revision: 1,
        state: "PENDING_APPROVAL",
        summary: "Regression test plan",
        architectureDecisions: [],
        assumptions: [],
        clarificationNeeded: false,
        clarificationQuestion: null,
        projects: ["frontend-app"],
        nodes: [{
          nodeId: "N1",
          title: "Regression node",
          purpose: "Regression test",
          projectId: "frontend-app",
          role: "FRONTEND",
          type: "IMPLEMENTATION",
          dependsOn: [],
          acceptanceCriteria: ["Criteria"],
          allowedPaths: ["src/components/Regression.tsx"],
          verification: ["typecheck", "lint", "build"],
          risk: "LOW",
          complexity: "LOW",
          requiresChanges: true,
          canRunInParallel: false,
          writeConflictGroup: null,
          contextFrom: [],
          skills: [],
        }],
        integration: {
          required: false,
          projectVerification: ["frontend-app:build"],
          crossProjectVerification: [],
          previewRequired: false,
        },
        risk: "LOW",
        complexity: "LOW",
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date().toISOString(),
      },
    }),
  });

  await harness.requestJson(`/api/objectives/${regObjId}/approve-plan`, {
    method: "POST",
    headers: { "idempotency-key": "approve-reg-1" },
    body: { planFingerprint: regPlanRes.plan.planFingerprint },
  });

  const regMatRes = await harness.requestJson(`/api/objectives/${regObjId}/materialize`, {
    method: "POST",
    headers: { "idempotency-key": "mat-reg-1" },
    body: { planFingerprint: regPlanRes.plan.planFingerprint },
  });
  assert.equal(regMatRes.status, 201);

  const regTick = schedulerTick({ vaultRoot: harness.vaultRoot, runsRoot: harness.runsRoot, enabled: true });
  assert.equal(regTick.queued.length, 1);
  const regClaim = claimNextJob(harness.runsRoot);
  assert.ok(regClaim);
  const regExecution = await runClaimedProductionJob(
    regClaim,
    deterministicExecutor({ relativePath: "src/components/Regression.tsx", regression: true }),
  );
  assert.match(regExecution.error.message, /FAIL_REGRESSION/);
  const failedJob = listJobs(harness.runsRoot).find((job) => job.jobId === regClaim.jobId);
  const regRunId = failedJob.runId;
  const failedRun = getRun(harness.runsRoot, regRunId);
  assert.equal(failedRun.state, "FAILED");
  assert.equal(failedRun.execution.verification.find((item) => item.command.includes("lint")).status, "FAIL_REGRESSION");
  schedulerTick({ vaultRoot: harness.vaultRoot, runsRoot: harness.runsRoot, enabled: true });

  // Assert delivery certification reports BLOCKED due to VERIFICATION_INTENT_COMPLETE
  const regCert = buildDeliveryCertificationEvidence({
    runsRoot: harness.runsRoot,
    objectiveId: regObjId,
    automatic: true,
  });
  assert.ok(regCert.blockers.includes("VERIFICATION_INTENT_COMPLETE"), "Should be blocked by VERIFICATION_INTENT_COMPLETE due to regression");

  // === Scenario 6: Structured Verification Decision Resolution (SELECT_SCRIPT / WAIVE) ===
  console.log("  Scenario 6: Structured verification decision resolution with governed plan v2...");
  const decIntake = await harness.requestJson("/api/objectives", {
    method: "POST",
    headers: { "idempotency-key": "e2e-decision-intake-1" },
    body: {
      projectId: "frontend-app",
      request: "Tolong jalankan e2e check khusus",
    },
  });
  const decObjId = decIntake.data.data.objective.objectiveId;

  const decPlanRes = await planObjective({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    objectiveId: decObjId,
    decomposer: async ({ objective }) => ({
      status: "NEEDS_CLARIFICATION",
      plan: {
        schemaVersion: 2,
        planId: `plan-${objective.objectiveId}-r1`,
        objectiveId: objective.objectiveId,
        revision: 1,
        state: "PENDING_APPROVAL",
        summary: "Plan with missing e2e verification requirement",
        architectureDecisions: [],
        assumptions: [],
        clarificationNeeded: true,
        clarificationQuestion: "Verification check e2e tidak ditemukan di package.json. Pilih script atau waive.",
        projects: ["frontend-app"],
        nodes: [{
          nodeId: "N1",
          title: "Custom node",
          purpose: "Custom purpose",
          projectId: "frontend-app",
          role: "FRONTEND",
          type: "IMPLEMENTATION",
          dependsOn: [],
          acceptanceCriteria: ["Works"],
          allowedPaths: ["src/App.tsx"],
          verification: ["typecheck"],
          risk: "LOW",
          complexity: "LOW",
          requiresChanges: true,
          canRunInParallel: false,
          writeConflictGroup: null,
          contextFrom: [],
          skills: [],
        }],
        integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
        risk: "LOW",
        complexity: "LOW",
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date().toISOString(),
      },
    }),
  });

  assert.equal(decPlanRes.verificationIntent.status, "NEEDS_CLARIFICATION");

  const packagePath = path.join(harness.frontendRepo, "package.json");
  const packageDocument = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageDocument.scripts["test:e2e"] = "node --version";
  fs.writeFileSync(packagePath, JSON.stringify(packageDocument, null, 2));
  await localProcessRunner({ command: "git", args: ["add", "package.json"], cwd: harness.frontendRepo });
  await localProcessRunner({ command: "git", args: ["commit", "-m", "test: register governed e2e runner"], cwd: harness.frontendRepo });

  // Submit structured decision to resolve via SELECT_SCRIPT
  const decRes = await harness.requestJson(`/api/objectives/${decObjId}/verification-decision`, {
    method: "POST",
    headers: { "idempotency-key": "decision-e2e-1" },
    body: {
      action: "SELECT_SCRIPT",
      projectId: "frontend-app",
      capability: "E2E",
      selectedTarget: "test:e2e",
    },
  });

  assert.equal(decRes.status, 200);
  assert.equal(decRes.data.data.verificationIntent.status, "RESOLVED");
  assert.equal(decRes.data.data.decision.type, "VERIFICATION_DECISION");

  const decidedPlan = await planObjective({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    objectiveId: decObjId,
    clarification: "Gunakan script test:e2e yang telah disetujui.",
    decomposer: async ({ objective }) => ({
      status: "PLAN_REVIEW",
      plan: {
        schemaVersion: 2,
        planId: `plan-${objective.objectiveId}-r1`, objectiveId: objective.objectiveId, revision: 1,
        state: "PENDING_APPROVAL", summary: "Run the governed E2E verification",
        architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null,
        projects: ["frontend-app"],
        nodes: [{
          nodeId: "N1", title: "Verify E2E", purpose: "Run the selected E2E check", projectId: "frontend-app",
          role: "TESTING", type: "VERIFICATION", dependsOn: [], acceptanceCriteria: ["E2E evidence is recorded"],
          allowedPaths: [], verification: ["test:e2e"], risk: "LOW", complexity: "LOW", requiresChanges: false,
          canRunInParallel: false, writeConflictGroup: null, contextFrom: [], skills: [],
        }],
        integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
        risk: "LOW", complexity: "LOW", approvedBy: null, approvedAt: null, createdAt: new Date().toISOString(),
      },
    }),
  });
  assert.equal(decidedPlan.plan.schemaVersion, 2);
  const decidedApproval = await harness.requestJson(`/api/objectives/${decObjId}/approve-plan`, {
    method: "POST", headers: { "idempotency-key": "decision-approve-e2e-1" },
    body: { planFingerprint: decidedPlan.plan.planFingerprint },
  });
  assert.equal(decidedApproval.status, 201);
  const decidedMaterialization = await harness.requestJson(`/api/objectives/${decObjId}/materialize`, {
    method: "POST", headers: { "idempotency-key": "decision-materialize-e2e-1" },
    body: { planFingerprint: decidedPlan.plan.planFingerprint },
  });
  assert.equal(decidedMaterialization.status, 201);

  console.log("ai-os-objective-lifecycle-e2e.test.mjs: All lifecycle E2E scenarios passed!");
} finally {
  await harness.cleanup();
}
