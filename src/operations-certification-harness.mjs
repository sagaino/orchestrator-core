import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDisasterRecoveryBackup, verifyDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import { acknowledgeOperationsAlert, recordRecoveryDrill, readBackupStatus } from "./operations-governance.mjs";
import { createDecision } from "./decision-store.mjs";
import { createObjective } from "./objective-store.mjs";
import { createOrchestration } from "./orchestration-store.mjs";
import { createPlan } from "./plan-store.mjs";
import { planFingerprint } from "./plan-lifecycle.mjs";
import { schedulerTick } from "./orchestration-scheduler.mjs";
import { runSoakCapacityHarness } from "./soak-capacity-harness.mjs";
import { collectOperationsExitEvidence } from "./operations-certification.mjs";

function writeFixtureObjective({ runsRoot, objectiveId, planId, orchestrationId, timestamp, maxTotalTokens, usageTokens }) {
  const projectId = "operations-certification-project";
  const nodeId = "N01";
  const taskId = `TASK-${objectiveId}`;
  const budget = { maxSubtasks: 1, maxParallelAgents: 1, maxRetriesPerNode: 1, maxRepairCycles: 1, maxTotalTokens, deadlineAt: null };
  const objective = {
    schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "RUNNING",
    request: `Operations certification objective ${objectiveId}.`, requestedBy: "operations-certification-harness",
    projectIds: [projectId], freshProject: null, activePlanId: planId, activeOrchestrationId: orchestrationId,
    budget, createdAt: timestamp, updatedAt: timestamp,
  };
  const plan = {
    schemaVersion: 1, revision: 1, planId, objectiveId, state: "APPROVED",
    summary: `Operations certification plan ${planId}.`, architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null,
    projects: [projectId], nodes: [{ nodeId, title: "Certification node", purpose: "Exercise operations exit evidence.", projectId, role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["Durable state survives restart and restore."], allowedPaths: ["src/certification-fixture.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "certification", contextFrom: [], skills: [] }],
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false }, risk: "LOW", complexity: "LOW", approvedBy: "human:operations-certification", approvedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  plan.planFingerprint = planFingerprint(plan);
  const orchestration = {
    schemaVersion: 1, revision: 0, orchestrationId, objectiveId, planId, state: "CREATED", planFingerprint: plan.planFingerprint,
    nodes: { [nodeId]: { state: "READY", taskId, jobId: null, runId: null, attempt: 1, blockedBy: [], lastError: null } },
    integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null },
    usage: { totalTokens: usageTokens, agentInvocations: usageTokens > 0 ? 1 : 0, retries: 0 }, createdAt: timestamp, updatedAt: timestamp,
    materialization: { state: "MATERIALIZED", materializedAt: timestamp, tasks: [{ nodeId, projectId, taskId, path: `02-Projects/${projectId}/tasks/${taskId}.md`, dependencies: [], orchestrationDependencies: [] }] },
  };
  createObjective({ runsRoot, record: objective });
  createPlan({ runsRoot, record: plan, validationOptions: { knownProjectIds: [projectId], budget } });
  createDecision({ runsRoot, record: { schemaVersion: 1, revision: 0, decisionId: `decision-plan-${planId}`, objectiveId, nodeId: null, runId: null, type: "PLAN_APPROVAL", state: "RESOLVED", evidence: { planId, planFingerprint: plan.planFingerprint }, requestedAction: "Approve operations certification plan.", allowedChoices: ["APPROVE", "CANCEL"], creator: "SYSTEM", createdAt: timestamp, resolution: { action: "APPROVE", resolvedBy: "human:operations-certification", resolvedAt: timestamp } } });
  createOrchestration({ runsRoot, record: orchestration, validationOptions: { plan } });
  return { objective, plan, orchestration };
}

/**
 * Execute the bounded V2.074 exit-evidence rehearsal in an isolated runtime.
 * Synthetic jobs remain queued and no provider or worktree is invoked.
 */
export async function runOperationsCertificationHarness({
  harnessRoot = null,
  durationHours = 72,
  stepMinutes = 15,
  maxSteps = 4,
  now = new Date("2026-08-23T00:00:00.000Z"),
  cleanupOwnedWorkspace = true,
} = {}) {
  const ownsWorkspace = !harnessRoot;
  const workspace = path.resolve(harnessRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-operations-certification-")));
  const vaultRoot = path.join(workspace, "vault");
  const runsRoot = path.join(workspace, "runs");
  const backupRoot = path.join(workspace, "external-backups");
  const timestamp = now.toISOString();
  let result;
  try {
    const soak = await runSoakCapacityHarness({ harnessRoot: workspace, durationHours, stepMinutes, maxSteps, workers: 2, apiRequestsPerStep: 2, sseClients: 2, restartEverySteps: 2, artifactBytesPerStep: 64, maxArtifactBytes: 100_000, persistReport: false, cleanupOwnedWorkspace: false, now });
    fs.rmSync(path.join(vaultRoot, "soak"), { recursive: true, force: true });
    fs.writeFileSync(path.join(vaultRoot, "index.md"), "# Operations certification index\n", { mode: 0o600 });
    fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), "# Project registry\n\n| project_id | project_page | repository | agent | graphify | graphify_output |\n| --- | --- | --- | --- | --- | --- |\n", { mode: 0o600 });
    const fixtures = [
      writeFixtureObjective({ runsRoot, objectiveId: "obj-operations-certification-01", planId: "plan-operations-certification-01", orchestrationId: "orch-operations-certification-01", timestamp, maxTotalTokens: 100, usageTokens: 0 }),
      writeFixtureObjective({ runsRoot, objectiveId: "obj-operations-certification-02", planId: "plan-operations-certification-02", orchestrationId: "orch-operations-certification-02", timestamp, maxTotalTokens: 10, usageTokens: 10 }),
    ];
    const scheduler = schedulerTick({ runsRoot, enabled: true, now, env: { ORCHESTRATOR_MAX_PARALLEL_JOBS: "2" } });
    const backup = createDisasterRecoveryBackup({ vaultRoot, runsRoot, backupRoot, runtime: { running: false }, now });
    const verification = verifyDisasterRecoveryBackup({ backupPath: backup.backupPath });
    recordRecoveryDrill({ runsRoot, performedBy: "human:operations-certification", evidence: { summary: "V2.074 quarantine restore rehearsal", reference: backup.backupPath }, result: "PASS", rtoMinutes: 10, now });
    acknowledgeOperationsAlert({ runsRoot, alertId: "OPS_BACKUP_SCHEDULE", acknowledgedBy: "human:operations-certification", owner: "human:operations-certification", note: "Schedule activation remains an explicit operator action.", now });
    const evidence = collectOperationsExitEvidence({ runsRoot, soak, backup: readBackupStatus(runsRoot) });
    const checks = Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, value?.passed === true]));
    result = { schemaVersion: 1, action: "OPERATIONS_CERTIFICATION_HARNESS", status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", generatedAt: new Date().toISOString(), soakReport: soak, virtualWindow: soak.virtualWindow, workload: soak.workload, objectives: fixtures.map((item) => item.objective.objectiveId), decisions: { count: evidence.decisionRecords.count, budgetStopCount: evidence.budgetStop.count, budgetCodes: evidence.budgetStop.budgetCodes }, scheduler: { queued: scheduler.queued.length, budgetBlockers: scheduler.budgetBlockers }, backup: { backupId: backup.backupId, verified: verification.status === "VERIFIED", restored: evidence.backupRestore.passed }, exitEvidence: evidence, guardrails: { providerInvocations: 0, syntheticJobsExecuted: false, automaticApproval: false, automaticRestore: false, permanentDelete: false }, workspace: ownsWorkspace && cleanupOwnedWorkspace ? null : workspace };
  } catch (error) {
    result = { schemaVersion: 1, action: "OPERATIONS_CERTIFICATION_HARNESS", status: "FAIL", generatedAt: new Date().toISOString(), error: error.message, guardrails: { providerInvocations: 0, syntheticJobsExecuted: false, automaticApproval: false, automaticRestore: false, permanentDelete: false }, workspace: ownsWorkspace && cleanupOwnedWorkspace ? null : workspace };
  } finally {
    if (ownsWorkspace && cleanupOwnedWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
  }
  return result;
}
