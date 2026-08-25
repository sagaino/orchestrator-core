import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { listProjects } from "./core.mjs";
import { createObjective, getObjective, listObjectives } from "./objective-store.mjs";
import { withDurableLease } from "./durable-runtime.mjs";

const OBJECTIVE_MODES = new Set(["FRESH_PROJECT", "EXISTING_PROJECT", "CROSS_PROJECT_INCIDENT"]);
const BLUEPRINTS = new Set(["frontend-vite"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ObjectiveIntakeError extends Error {
  constructor(message, { statusCode = 400, code = "OBJECTIVE_INVALID", details = null } = {}) {
    super(message);
    this.name = "ObjectiveIntakeError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!ID_PATTERN.test(normalized)) throw new ObjectiveIntakeError(`${label} tidak valid.`, { details: { code: "INVALID_IDENTIFIER", field: label } });
  return normalized;
}

function enabledValue(raw) {
  const normalized = String(raw ?? "0").trim().toLowerCase();
  return ["1", "true", "on"].includes(normalized);
}

export function objectivesEnabled(env = process.env) {
  return enabledValue(env.ORCHESTRATOR_OBJECTIVES_ENABLED);
}

export function crossProjectEnabled(env = process.env) {
  return enabledValue(env.ORCHESTRATOR_CROSS_PROJECT);
}

function safeTargetDirectory(value) {
  if (!nonEmpty(value) || !path.isAbsolute(value) || /[\r\n|`]/.test(value)) return false;
  const resolved = path.resolve(value);
  return resolved !== path.parse(resolved).root && resolved !== os.homedir();
}

function normalizeBudget(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ObjectiveIntakeError("budget harus berupa object.", { details: { code: "INVALID_BUDGET" } });
  }
  const budget = {
    maxSubtasks: input.maxSubtasks ?? 8,
    maxParallelAgents: input.maxParallelAgents ?? 3,
    maxRetriesPerNode: input.maxRetriesPerNode ?? 2,
    maxRepairCycles: input.maxRepairCycles ?? 1,
    maxTotalTokens: input.maxTotalTokens ?? null,
    deadlineAt: input.deadlineAt ?? null,
  };
  for (const field of ["maxSubtasks", "maxParallelAgents", "maxRetriesPerNode", "maxRepairCycles"]) {
    if (!positiveInteger(budget[field])) throw new ObjectiveIntakeError(`budget.${field} harus positive integer.`, { details: { code: "INVALID_BUDGET", field } });
  }
  if (budget.maxSubtasks > 100 || budget.maxParallelAgents > 16 || budget.maxRetriesPerNode > 10 || budget.maxRepairCycles > 5) {
    throw new ObjectiveIntakeError("budget melebihi ceiling v2 awal.", { statusCode: 422, code: "BUDGET_EXCEEDED", details: { code: "BUDGET_EXCEEDED" } });
  }
  if (budget.maxTotalTokens !== null && !positiveInteger(budget.maxTotalTokens)) {
    throw new ObjectiveIntakeError("budget.maxTotalTokens harus null atau positive integer.", { details: { code: "INVALID_BUDGET", field: "maxTotalTokens" } });
  }
  if (budget.deadlineAt !== null && (!nonEmpty(budget.deadlineAt) || !Number.isFinite(Date.parse(budget.deadlineAt)))) {
    throw new ObjectiveIntakeError("budget.deadlineAt harus null atau ISO timestamp.", { details: { code: "INVALID_BUDGET", field: "deadlineAt" } });
  }
  return budget;
}

function normalizeProjectIds(body, mode) {
  const supplied = body.projectIds ?? (body.projectId ? [body.projectId] : (body.freshProject?.projectId ? [body.freshProject.projectId] : []));
  if (!Array.isArray(supplied) || supplied.length === 0) {
    throw new ObjectiveIntakeError("projectIds wajib diisi.", { details: { code: "INVALID_PROJECT_IDS" } });
  }
  const projectIds = supplied.map((projectId) => stableId(projectId, "projectId"));
  if (new Set(projectIds).size !== projectIds.length) throw new ObjectiveIntakeError("projectIds tidak boleh duplikat.", { details: { code: "INVALID_PROJECT_IDS" } });
  if (mode === "EXISTING_PROJECT" && projectIds.length !== 1) {
    throw new ObjectiveIntakeError("EXISTING_PROJECT hanya menerima satu project sampai linked-project phase aktif.", { statusCode: 422, code: "FEATURE_DISABLED", details: { code: "FEATURE_DISABLED", feature: "LINKED_PROJECTS" } });
  }
  if (mode === "FRESH_PROJECT" && projectIds.length !== 1) {
    throw new ObjectiveIntakeError("FRESH_PROJECT hanya menerima satu project proposal.", { statusCode: 422, code: "INVALID_PROJECT_IDS", details: { code: "INVALID_PROJECT_IDS" } });
  }
  return projectIds;
}

function freshProjectProposal(body, projectIds, { checkTarget = true } = {}) {
  const fresh = body.freshProject && typeof body.freshProject === "object" && !Array.isArray(body.freshProject) ? body.freshProject : body;
  const projectId = stableId(fresh.projectId ?? projectIds[0], "freshProject.projectId");
  const targetDirectory = String(fresh.targetDirectory ?? fresh.targetPath ?? "").trim();
  if (!safeTargetDirectory(targetDirectory)) throw new ObjectiveIntakeError("freshProject.targetDirectory harus absolute dan aman.", { details: { code: "INVALID_TARGET_DIRECTORY" } });
  const blueprint = String(fresh.blueprint ?? "frontend-vite").trim();
  if (!BLUEPRINTS.has(blueprint)) throw new ObjectiveIntakeError(`Blueprint belum didukung: ${blueprint}`, { statusCode: 422, code: "UNSUPPORTED_BLUEPRINT", details: { code: "UNSUPPORTED_BLUEPRINT", supported: [...BLUEPRINTS] } });
  if (checkTarget && fs.existsSync(targetDirectory)) throw new ObjectiveIntakeError(`Target Fresh Project sudah ada: ${targetDirectory}`, { statusCode: 409, code: "TARGET_ALREADY_EXISTS", details: { code: "TARGET_ALREADY_EXISTS" } });
  return {
    proposalId: `genesis-${projectId}-${blueprint}`,
    action: "ONBOARD_WITH_EXISTING_BLUEPRINT",
    projectId,
    targetDirectory: path.resolve(targetDirectory),
    blueprint,
    request: body.request.trim(),
  };
}

function canonicalRequest(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function canonicalIntake({ mode, request, projectIds, freshProject, attachments, budget }) {
  return {
    mode,
    request: canonicalRequest(request),
    projectIds: [...projectIds],
    freshProject: freshProject ? {
      action: freshProject.action,
      blueprint: freshProject.blueprint,
      projectId: freshProject.projectId,
      targetDirectory: freshProject.targetDirectory,
    } : null,
    attachments: (attachments ?? []).map((attachment) => ({
      type: attachment.type,
      fileName: attachment.fileName,
      relativeVaultPath: attachment.relativeVaultPath ?? null,
      relativeProjectPath: attachment.relativeProjectPath ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
    })),
    budget: {
      maxSubtasks: budget.maxSubtasks,
      maxParallelAgents: budget.maxParallelAgents,
      maxRetriesPerNode: budget.maxRetriesPerNode,
      maxRepairCycles: budget.maxRepairCycles,
      maxTotalTokens: budget.maxTotalTokens,
      deadlineAt: budget.deadlineAt,
    },
  };
}

export function objectiveIntakeFingerprint(input) {
  return createHash("sha256").update(JSON.stringify(canonicalIntake(input))).digest("hex");
}

function fingerprintForObjective(objective) {
  return objective?.intakeFingerprint ?? objectiveIntakeFingerprint({
    mode: objective.mode,
    request: objective.request,
    projectIds: objective.projectIds,
    freshProject: objective.freshProject,
    attachments: objective.attachments ?? [],
    budget: objective.budget,
  });
}

function reusableObjective({ runsRoot, intakeFingerprint }) {
  return listObjectives(runsRoot).find((objective) => (
    !["DONE", "CANCELLED"].includes(objective.state)
    && fingerprintForObjective(objective) === intakeFingerprint
  )) ?? null;
}

function objectiveSummary(objective) {
  return {
    objectiveId: objective.objectiveId,
    mode: objective.mode,
    state: objective.state,
    request: objective.request,
    projectIds: objective.projectIds,
    activePlanId: objective.activePlanId,
    activeOrchestrationId: objective.activeOrchestrationId,
    budget: objective.budget,
    createdAt: objective.createdAt,
    updatedAt: objective.updatedAt,
  };
}

function normalizeAttachments(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 20) throw new ObjectiveIntakeError("attachments harus berupa array maksimal 20 item.", { details: { code: "INVALID_ATTACHMENTS" } });
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ObjectiveIntakeError(`attachments[${index}] tidak valid.`, { details: { code: "INVALID_ATTACHMENTS", index } });
    const type = String(item.type ?? "").trim();
    const fileName = String(item.fileName ?? "").trim();
    if (!["MOCKUP", "PROJECT_ASSET"].includes(type) || !fileName || fileName.length > 255) throw new ObjectiveIntakeError(`attachments[${index}] tidak valid.`, { details: { code: "INVALID_ATTACHMENTS", index } });
    const relativeVaultPath = item.relativeVaultPath ? String(item.relativeVaultPath).trim() : null;
    const relativeProjectPath = item.relativeProjectPath ? String(item.relativeProjectPath).trim() : null;
    if (!relativeVaultPath && !relativeProjectPath) throw new ObjectiveIntakeError(`attachments[${index}] tidak memiliki durable reference.`, { details: { code: "INVALID_ATTACHMENTS", index } });
    return { type, fileName, relativeVaultPath, relativeProjectPath, sizeBytes: Number.isInteger(item.sizeBytes) && item.sizeBytes >= 0 ? item.sizeBytes : null };
  });
}

export function createObjectiveIntake({ vaultRoot, runsRoot, body, requestedBy = "user", now = new Date(), isCrossProjectEnabled = crossProjectEnabled } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ObjectiveIntakeError("Objective body harus berupa object.");
  const request = String(body.request ?? "").trim();
  if (!request) throw new ObjectiveIntakeError("request wajib diisi.", { details: { code: "INVALID_REQUEST" } });
  if (request.length > 20_000) throw new ObjectiveIntakeError("request terlalu panjang.", { statusCode: 413, code: "PAYLOAD_TOO_LARGE", details: { code: "PAYLOAD_TOO_LARGE" } });
  const mode = String(body.mode ?? "EXISTING_PROJECT").trim().toUpperCase();
  if (!OBJECTIVE_MODES.has(mode)) throw new ObjectiveIntakeError(`mode tidak didukung: ${mode}`, { details: { code: "INVALID_MODE", allowed: [...OBJECTIVE_MODES] } });
  if (mode === "CROSS_PROJECT_INCIDENT" && !isCrossProjectEnabled()) {
    throw new ObjectiveIntakeError("Cross-project orchestration belum diaktifkan.", { statusCode: 409, code: "FEATURE_DISABLED", details: { code: "FEATURE_DISABLED", feature: "CROSS_PROJECT_ORCHESTRATION" } });
  }
  const projectIds = normalizeProjectIds(body, mode);
  const registry = listProjects(vaultRoot);
  const registeredIds = new Set(registry.projects.map((project) => project.id));
  if (mode === "EXISTING_PROJECT" || mode === "CROSS_PROJECT_INCIDENT") {
    const missing = projectIds.filter((projectId) => !registeredIds.has(projectId));
    if (missing.length > 0) throw new ObjectiveIntakeError(`Project tidak ditemukan di registry: ${missing.join(", ")}`, { statusCode: 404, code: "PROJECT_NOT_FOUND", details: { code: "PROJECT_NOT_FOUND", missing } });
  }
  const budget = normalizeBudget(body.budget);
  const attachments = normalizeAttachments(body.attachments ?? body.attachedAssets);
  const freshProject = mode === "FRESH_PROJECT" ? freshProjectProposal(body, projectIds, { checkTarget: false }) : null;
  const effectiveProjectIds = freshProject ? [freshProject.projectId] : projectIds;
  const intakeFingerprint = objectiveIntakeFingerprint({ mode, request, projectIds: effectiveProjectIds, freshProject, attachments, budget });
  const objectiveId = `obj-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const record = {
    schemaVersion: 1,
    revision: 0,
    objectiveId,
    mode,
    state: mode === "FRESH_PROJECT" ? "GENESIS_REVIEW" : "PLANNING",
    request,
    requestedBy: String(requestedBy || "user"),
    projectIds: effectiveProjectIds,
    freshProject,
    attachments,
    activePlanId: null,
    activeOrchestrationId: null,
    budget,
    intakeFingerprint,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return withDurableLease({
    runsRoot,
    namespace: "objective-intake",
    key: intakeFingerprint,
    purpose: "deduplicate objective intake",
    ttlMs: 60_000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 2_000,
  }, () => {
    const existing = reusableObjective({ runsRoot, intakeFingerprint });
    if (existing) {
      return {
        objective: existing,
        summary: objectiveSummary(existing),
        alreadyExisting: true,
        intakeFingerprint,
        planning: { started: false, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
      };
    }
    if (freshProject && fs.existsSync(freshProject.targetDirectory)) {
      throw new ObjectiveIntakeError(`Target Fresh Project sudah ada: ${freshProject.targetDirectory}`, { statusCode: 409, code: "TARGET_ALREADY_EXISTS", details: { code: "TARGET_ALREADY_EXISTS" } });
    }
    const persisted = createObjective({ runsRoot, record });
    return {
      objective: persisted,
      summary: objectiveSummary(persisted),
      planning: { started: false, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
    };
  });
}

export function getObjectiveIntake({ runsRoot, objectiveId } = {}) {
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) throw new ObjectiveIntakeError(`Objective tidak ditemukan: ${objectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId } });
  return objective;
}

export function listObjectiveIntake({ runsRoot } = {}) {
  return listObjectives(runsRoot)
    .sort((left, right) => (
      String(right?.createdAt ?? right?.objectiveId ?? "").localeCompare(String(left?.createdAt ?? left?.objectiveId ?? ""))
      || String(right?.objectiveId ?? "").localeCompare(String(left?.objectiveId ?? ""))
    ))
    .map(objectiveSummary);
}
