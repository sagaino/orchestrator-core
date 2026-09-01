import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAiOsE2eHarness } from "./helpers/ai-os-e2e-fixture.mjs";
import { planObjective } from "../src/objective-planning.mjs";
import { getObjective } from "../src/objective-store.mjs";
import { getPlan } from "../src/plan-store.mjs";
import { schedulerTick } from "../src/orchestration-scheduler.mjs";
import { listJobs, claimNextJob, updateJob, JOB_STATES } from "../src/job-queue.mjs";
import { updateOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { verifyAuditChain } from "../src/audit-chain.mjs";
import { buildDeliveryCertificationEvidence, createDeliveryCertification } from "../src/delivery-certification.mjs";

console.log("Running ai-os-objective-lifecycle-e2e.test.mjs...");

const harness = await createAiOsE2eHarness();

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
          schemaVersion: 1,
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

  // Write simulated run manifest
  const runId = `run-${objectiveId}-N1`;
  fs.writeFileSync(path.join(harness.runsRoot, `${runId}.json`), JSON.stringify({
    schemaVersion: 1,
    runId,
    taskId: queuedJob.taskId,
    projectId: "frontend-app",
    task: { id: queuedJob.taskId, title: "Implement status badge", path: `02-Projects/frontend-app/tasks/${queuedJob.taskId}.md` },
    plan: {
      id: "P1",
      verificationCommands: ["typecheck", "lint", "build"],
      allowedPaths: ["src/components/StatusBadge.tsx"],
      requiresChanges: true,
    },
    project: {
      id: "frontend-app",
      repository: harness.frontendRepo,
      verificationPolicies: {
        lint: { mode: "NO_NEW_FINDINGS", adapter: "eslint" },
      },
    },
    execution: {
      workspace: {
        path: path.join(harness.runsRoot, "workspaces", "frontend-app", runId),
        baseCommit: "abcdef123456",
        state: "CLEANED",
      },
      verification: [
        { command: "typecheck", exitCode: 0, status: "PASS", passed: true },
        { command: "lint", exitCode: 0, status: "PASS_NO_REGRESSION", passed: true, delta: { new: 0, resolved: 0, unchanged: 0 } },
        { command: "build", exitCode: 0, status: "PASS", passed: true },
      ],
    },
    knowledge: {
      approval: { approvedAt: new Date().toISOString(), approvedBy: "operator", destination: "WIKI" },
      sync: { syncedAt: new Date().toISOString(), sourcePath: "01-Knowledge/patterns/status-badge.md" },
    },
    state: "DONE",
  }, null, 2));

  // Mark job as DONE
  updateJob(harness.runsRoot, queuedJob.jobId, (j) => ({
    ...j,
    state: JOB_STATES.DONE,
    runId,
  }));

  // Update orchestration nodes
  const orchestration = getOrchestration(harness.runsRoot, matRes.data.data.orchestration.orchestrationId, { plan: planResult.plan });
  updateOrchestration({
    runsRoot: harness.runsRoot,
    orchestrationId: orchestration.orchestrationId,
    expectedRevision: orchestration.revision,
    validationOptions: { plan: planResult.plan },
    update: (record) => ({
      ...record,
      state: "DONE",
      nodes: Object.fromEntries(
        Object.entries(record.nodes || {}).map(([id, n]) => [id, { ...n, state: "DONE", runId }])
      ),
    }),
  });

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

  // Create simulated run with FAIL_REGRESSION
  const regRunId = `run-${regObjId}-N1`;
  fs.writeFileSync(path.join(harness.runsRoot, `${regRunId}.json`), JSON.stringify({
    schemaVersion: 1,
    runId: regRunId,
    taskId: "TASK-002",
    projectId: "frontend-app",
    task: { id: "TASK-002", title: "Regression node", path: "02-Projects/frontend-app/tasks/TASK-002.md" },
    plan: {
      id: "P1",
      verificationCommands: ["typecheck", "lint", "build"],
      allowedPaths: ["src/components/Regression.tsx"],
      requiresChanges: true,
    },
    project: {
      id: "frontend-app",
      repository: harness.frontendRepo,
      verificationPolicies: {
        lint: { mode: "NO_NEW_FINDINGS", adapter: "eslint" },
      },
    },
    execution: {
      workspace: {
        path: path.join(harness.runsRoot, "workspaces", "frontend-app", regRunId),
        baseCommit: "abcdef123456",
        state: "CLEANED",
      },
      verification: [
        { command: "typecheck", exitCode: 0, status: "PASS", passed: true },
        { command: "lint", exitCode: 1, status: "FAIL_REGRESSION", passed: false, delta: { new: 1, resolved: 0, unchanged: 0 } },
        { command: "build", exitCode: 0, status: "PASS", passed: true },
      ],
    },
    state: "DONE",
  }, null, 2));

  // Update orchestration nodes
  const regOrchestration = getOrchestration(harness.runsRoot, regMatRes.data.data.orchestration.orchestrationId, { plan: regPlanRes.plan });
  updateOrchestration({
    runsRoot: harness.runsRoot,
    orchestrationId: regOrchestration.orchestrationId,
    expectedRevision: regOrchestration.revision,
    validationOptions: { plan: regPlanRes.plan },
    update: (record) => ({
      ...record,
      state: "DONE",
      nodes: Object.fromEntries(
        Object.entries(record.nodes || {}).map(([id, n]) => [id, { ...n, state: "DONE", runId: regRunId }])
      ),
    }),
  });

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

  // Submit structured decision to resolve via SELECT_SCRIPT
  const decRes = await harness.requestJson(`/api/objectives/${decObjId}/verification-decision`, {
    method: "POST",
    headers: { "idempotency-key": "decision-e2e-1" },
    body: {
      action: "SELECT_SCRIPT",
      projectId: "frontend-app",
      capability: "E2E",
      selectedTarget: "typecheck",
    },
  });

  assert.equal(decRes.status, 200);
  assert.equal(decRes.data.data.verificationIntent.status, "RESOLVED");

  console.log("ai-os-objective-lifecycle-e2e.test.mjs: All lifecycle E2E scenarios passed!");
} finally {
  await harness.cleanup();
}

