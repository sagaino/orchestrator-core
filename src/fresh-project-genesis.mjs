import fs from "node:fs";
import path from "node:path";
import { appendAuditEntry } from "./audit-chain.mjs";
import { listProjects } from "./core.mjs";
import { getDecision, createDecision, updateDecision } from "./decision-store.mjs";
import { getObjective, updateObjective } from "./objective-store.mjs";
import { ObjectiveIntakeError } from "./objective-intake.mjs";
import { onboardNewProject as defaultOnboardNewProject } from "./project-onboarding.mjs";
import { withDurableLease } from "./durable-runtime.mjs";

function proposalError(message, options = {}) {
  return new ObjectiveIntakeError(message, options);
}

function samePath(left, right) {
  return Boolean(left && right) && path.resolve(left) === path.resolve(right);
}

function registeredProject(vaultRoot, projectId) {
  return listProjects(vaultRoot).projects.find((project) => project.id === projectId) ?? null;
}

function assertProposal(objective) {
  if (!objective || objective.mode !== "FRESH_PROJECT" || !objective.freshProject) {
    throw proposalError("Objective bukan Fresh Project atau proposal genesis tidak tersedia.", { statusCode: 409, code: "GENESIS_NOT_AVAILABLE", details: { code: "GENESIS_NOT_AVAILABLE" } });
  }
  const proposal = objective.freshProject;
  if (!proposal.projectId || !proposal.targetDirectory || !["frontend-vite", "backend-golang"].includes(proposal.blueprint)) {
    throw proposalError("Proposal Fresh Project tidak lengkap atau blueprint tidak didukung.", { statusCode: 409, code: "GENESIS_INVALID", details: { code: "GENESIS_INVALID" } });
  }
  return proposal;
}

function decisionRecord({ decisionId, objective, approvedBy, now, attempt }) {
  return {
    schemaVersion: 1,
    revision: 0,
    decisionId,
    objectiveId: objective.objectiveId,
    nodeId: null,
    runId: null,
    type: "FRESH_PROJECT_CREATION",
    state: "RESOLVED",
    evidence: {
      proposal: objective.freshProject,
      objectiveRequest: objective.request,
      attempt,
    },
    requestedAction: "Create the proposed Fresh Project repository",
    allowedChoices: ["APPROVE", "CANCEL"],
    creator: "SYSTEM",
    createdAt: now.toISOString(),
    resolution: {
      action: "APPROVE",
      resolvedBy: String(approvedBy || "user"),
      resolvedAt: now.toISOString(),
    },
  };
}

function completedOnboardingPatch(objective, proposal, onboarding, decisionId) {
  const project = onboarding?.project;
  if (!project?.id || !samePath(project.repository, proposal.targetDirectory)) {
    throw proposalError("Onboarding mengembalikan project yang tidak sesuai proposal genesis.", { statusCode: 502, code: "GENESIS_RESULT_MISMATCH", details: { code: "GENESIS_RESULT_MISMATCH" } });
  }
  return {
    state: "PLANNING",
    projectIds: [project.id],
    freshProject: {
      ...proposal,
      onboarding: {
        state: "COMPLETED",
        onboardingId: onboarding.onboardingId ?? null,
        action: onboarding.action ?? "NEW_PROJECT_CREATED",
        repository: project.repository,
        completedAt: new Date().toISOString(),
        decisionId,
      },
    },
  };
}

function failedOnboardingPatch(proposal, decisionId, error, attempt, cleanup) {
  return {
    state: "FAILED",
    freshProject: {
      ...proposal,
      onboarding: {
        state: "FAILED",
        attempt,
        decisionId,
        failedAt: new Date().toISOString(),
        error: String(error?.message ?? error).slice(0, 4_000),
        cleanup,
      },
    },
  };
}

function ensureNoPartialArtifacts({ vaultRoot, proposal }) {
  const registered = registeredProject(vaultRoot, proposal.projectId);
  const targetExists = fs.existsSync(proposal.targetDirectory);
  return {
    registered: Boolean(registered),
    targetExists,
    clean: !registered && !targetExists,
  };
}

function completeFromRegistered({ runsRoot, objective, proposal, registered, decisionId }) {
  if (!registered || !samePath(registered.repository, proposal.targetDirectory)) return null;
  const completedAt = new Date().toISOString();
  const updated = updateObjective({
    runsRoot,
    objectiveId: objective.objectiveId,
    expectedRevision: objective.revision,
    update: (current) => ({
      ...current,
      state: "PLANNING",
      projectIds: [proposal.projectId],
      freshProject: {
        ...current.freshProject,
        onboarding: {
          ...(current.freshProject?.onboarding ?? {}),
          state: "COMPLETED",
          repository: registered.repository,
          reconciled: true,
          completedAt,
          decisionId,
        },
      },
    }),
  });
  return {
    objective: updated,
    alreadyCompleted: true,
    reconciled: true,
    onboarding: { action: "NEW_PROJECT_RECONCILED", project: registered },
    decision: getDecision(runsRoot, decisionId),
    planning: { started: false, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
  };
}

export async function approveFreshProjectGenesis({
  vaultRoot,
  runsRoot,
  objectiveId,
  approvedBy = "user",
  now = new Date(),
  onboardNewProject = defaultOnboardNewProject,
} = {}) {
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) throw proposalError(`Objective tidak ditemukan: ${objectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId } });
  const proposal = assertProposal(objective);
  const decisionId = `decision-genesis-${objective.objectiveId}`;
  const leaseOptions = {
    runsRoot,
    namespace: "fresh-project-genesis",
    key: objective.objectiveId,
    purpose: `Fresh Project genesis ${objective.objectiveId}`,
    ttlMs: 60 * 60 * 1000,
    waitTimeoutMs: 0,
  };

  try {
    return await withDurableLease(leaseOptions, async () => {
      let current = getObjective(runsRoot, objective.objectiveId);
      const currentProposal = assertProposal(current);
      const existingDecision = getDecision(runsRoot, decisionId);
      const attempt = Number(currentProposal.onboarding?.attempt ?? 0) + 1;
      let decision = existingDecision;

      if (current.state === "PLANNING" && currentProposal.onboarding?.state === "COMPLETED") {
        return { objective: current, alreadyCompleted: true, reconciled: false, onboarding: { action: "NEW_PROJECT_ALREADY_COMPLETED", projectId: current.projectIds[0] }, decision: existingDecision, planning: { started: false, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 } };
      }
      if (!["GENESIS_REVIEW", "FAILED", "ONBOARDING"].includes(current.state)) {
        throw proposalError(`Genesis approval tidak dapat dilakukan dari state ${current.state}.`, { statusCode: 409, code: "GENESIS_INVALID_STATE", details: { code: "GENESIS_INVALID_STATE", state: current.state } });
      }

      const registered = registeredProject(vaultRoot, currentProposal.projectId);
      if (registered) {
        if (!samePath(registered.repository, currentProposal.targetDirectory)) {
          throw proposalError("Project ID Fresh Project sudah terdaftar ke repository lain.", { statusCode: 409, code: "GENESIS_REGISTRATION_CONFLICT", details: { code: "GENESIS_REGISTRATION_CONFLICT" } });
        }
        if (!decision) decision = createDecision({ runsRoot, record: decisionRecord({ decisionId, objective: current, approvedBy, now, attempt }) });
        else if (decision.state === "OPEN") {
          decision = updateDecision({
            runsRoot,
            decisionId,
            expectedRevision: decision.revision,
            update: (record) => ({
              ...record,
              state: "RESOLVED",
              resolution: { action: "APPROVE", resolvedBy: String(approvedBy || "user"), resolvedAt: now.toISOString() },
            }),
          });
        }
        const reconciled = completeFromRegistered({ runsRoot, objective: current, proposal: currentProposal, registered, decisionId });
        if (reconciled) return { ...reconciled, decision };
      }

      if (current.state === "ONBOARDING") {
        throw proposalError("Onboarding Fresh Project sebelumnya belum dapat direkonsiliasi; repository target tidak boleh diulang otomatis.", { statusCode: 409, code: "GENESIS_ONBOARDING_UNCERTAIN", details: { code: "GENESIS_ONBOARDING_UNCERTAIN" } });
      }
      if (fs.existsSync(currentProposal.targetDirectory)) {
        throw proposalError("Target Fresh Project sudah ada tetapi belum terdaftar; onboarding dihentikan fail-closed.", { statusCode: 409, code: "GENESIS_TARGET_UNCERTAIN", details: { code: "GENESIS_TARGET_UNCERTAIN" } });
      }

      if (!decision) decision = createDecision({ runsRoot, record: decisionRecord({ decisionId, objective: current, approvedBy, now, attempt }) });
      else if (decision.state === "OPEN") {
        decision = updateDecision({
          runsRoot,
          decisionId,
          expectedRevision: decision.revision,
          update: (record) => ({
            ...record,
            state: "RESOLVED",
            resolution: { action: "APPROVE", resolvedBy: String(approvedBy || "user"), resolvedAt: now.toISOString() },
          }),
        });
      }

      const started = updateObjective({
        runsRoot,
        objectiveId: current.objectiveId,
        expectedRevision: current.revision,
        update: (record) => ({
          ...record,
          state: "ONBOARDING",
          freshProject: {
            ...record.freshProject,
            onboarding: {
              ...(record.freshProject?.onboarding ?? {}),
              state: "STARTED",
              attempt,
              startedAt: now.toISOString(),
              approvedBy: String(approvedBy || "user"),
              decisionId,
            },
          },
        }),
      });

      let onboarding;
      try {
        onboarding = await onboardNewProject({
          vaultRoot,
          runsRoot,
          projectId: currentProposal.projectId,
          projectName: currentProposal.projectId,
          targetPath: currentProposal.targetDirectory,
          targetDirectory: currentProposal.targetDirectory,
          blueprint: currentProposal.blueprint,
          registeredBy: approvedBy,
        });
      } catch (error) {
        const cleanup = ensureNoPartialArtifacts({ vaultRoot, proposal: currentProposal });
        const failed = updateObjective({
          runsRoot,
          objectiveId: started.objectiveId,
          expectedRevision: started.revision,
          patch: failedOnboardingPatch(currentProposal, decisionId, error, attempt, cleanup),
        });
        throw proposalError("Fresh Project onboarding gagal dan objective masuk FAILED.", { statusCode: 502, code: "FRESH_PROJECT_ONBOARDING_FAILED", details: { code: "FRESH_PROJECT_ONBOARDING_FAILED", objectiveId: failed.objectiveId, objectiveState: failed.state, cleanup, error: String(error.message ?? error).slice(0, 4_000) } });
      }

      const completed = updateObjective({
        runsRoot,
        objectiveId: started.objectiveId,
        expectedRevision: started.revision,
        patch: completedOnboardingPatch(started, currentProposal, onboarding, decisionId),
      });
      current = completed;
      return {
        objective: current,
        alreadyCompleted: false,
        reconciled: false,
        onboarding,
        decision,
        planning: { started: false, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
      };
    });
  } catch (error) {
    if (error.code === "DURABLE_LEASE_HELD") {
      throw proposalError("Fresh Project onboarding sedang berjalan untuk objective ini.", { statusCode: 409, code: "GENESIS_ONBOARDING_IN_PROGRESS", details: { code: "GENESIS_ONBOARDING_IN_PROGRESS" } });
    }
    throw error;
  }
}

export function auditGenesisApproval(runsRoot, { actor, objectiveId, state, decisionId, outcome, details = null } = {}) {
  return appendAuditEntry(runsRoot, {
    event: "FRESH_PROJECT_CREATION",
    actor,
    objectiveId,
    state,
    decisionId,
    outcome,
    ...(details ? { details } : {}),
  });
}
