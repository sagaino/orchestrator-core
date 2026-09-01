import assert from "node:assert/strict";
import { createAiOsE2eHarness } from "./helpers/ai-os-e2e-fixture.mjs";
import { planObjective } from "../src/objective-planning.mjs";
import { approvePlan } from "../src/plan-lifecycle.mjs";
import { getObjective } from "../src/objective-store.mjs";
import { getPlan } from "../src/plan-store.mjs";
import { schedulerTick } from "../src/orchestration-scheduler.mjs";

console.log("Running ai-os-objective-lifecycle-e2e.test.mjs...");

const harness = await createAiOsE2eHarness();

try {
  // === Scenario 1: Happy Path through Complete Lifecycle ===
  console.log("  Scenario 1: Happy path objective lifecycle...");
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
  assert.equal(tick.queued[0].taskId, "TASK-001");

  // === Scenario 2: Cancellation at Plan Review ===
  console.log("  Scenario 2: Cancellation at plan review...");
  const cancelIntake = await harness.requestJson("/api/objectives", {
    method: "POST",
    headers: { "idempotency-key": "e2e-cancel-1" },
    body: {
      projectId: "frontend-app",
      request: "Instruksi yang akan dibatalkan di plan review.",
    },
  });
  const cancelObjId = cancelIntake.data.data.objective.objectiveId;

  const cancelRes = await harness.requestJson(`/api/objectives/${cancelObjId}/cancel`, {
    method: "POST",
    headers: { "idempotency-key": "cancel-key-1" },
  });
  assert.equal(cancelRes.status, 201);
  const cancelledObj = getObjective(harness.runsRoot, cancelObjId);
  assert.equal(cancelledObj.state, "CANCELLED");

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

  console.log("ai-os-objective-lifecycle-e2e.test.mjs: All lifecycle E2E scenarios passed!");
} finally {
  await harness.cleanup();
}
