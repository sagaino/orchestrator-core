import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { listProjects, readMarkdown, projectPagePath } from "./core.mjs";
import { getDecision, listDecisions } from "./decision-store.mjs";
import { getObjective, updateObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration, createOrchestration, orchestrationPath } from "./orchestration-store.mjs";
import { planFingerprint } from "./plan-lifecycle.mjs";
import { existingTaskSummary, nextTaskIdentity, taskDocument } from "./task-intake.mjs";
import { injectFault } from "./fault-injection.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { validatePlanRecord } from "./orchestration-schema.mjs";
import { validatePlanSkillAssignments } from "./skill-assignment.mjs";
import { validateVerificationCoverage } from "./verification-intent.mjs";
import { resolveProjectBlueprint } from "./project-blueprint.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class TaskMaterializationError extends Error {
  constructor(message, { statusCode = 400, code = "TASK_MATERIALIZATION_INVALID", details = null } = {}) {
    super(message);
    this.name = "TaskMaterializationError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new TaskMaterializationError(message, options);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function stableId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!ID_PATTERN.test(normalized)) {
    fail(`${label} tidak valid.`, { code: "INVALID_IDENTIFIER", details: { code: "INVALID_IDENTIFIER", field: label } });
  }
  return normalized;
}

function planOptions(objective, projects) {
  return {
    knownProjectIds: projects.map((project) => project.id),
    projectIds: objective.projectIds,
    budget: objective.budget,
  };
}

function materializationOrchestrationId(objectiveId) {
  return `orch-${objectiveId}`;
}

function planApprovalDecision(runsRoot, plan) {
  const decisionId = `decision-plan-approval-${plan.planId}`;
  return getDecision(runsRoot, decisionId) ?? listDecisions(runsRoot).find((decision) => (
    decision.type === "PLAN_APPROVAL"
    && decision.objectiveId === plan.objectiveId
    && decision.state === "RESOLVED"
    && decision.evidence?.planId === plan.planId
  )) ?? null;
}

function assertApprovedPlan({ objective, plan, expectedPlanId, expectedFingerprint, decision }) {
  if (!plan) fail("Active plan tidak ditemukan.", { statusCode: 409, code: "PLAN_NOT_FOUND", details: { code: "PLAN_NOT_FOUND", objectiveId: objective.objectiveId } });
  if (expectedPlanId && expectedPlanId !== plan.planId) {
    fail("Materialization hanya boleh memakai active plan revision.", {
      statusCode: 409,
      code: "STALE_PLAN_REVISION",
      details: { code: "STALE_PLAN_REVISION", activePlanId: plan.planId, requestedPlanId: expectedPlanId },
    });
  }
  if (plan.objectiveId !== objective.objectiveId) {
    fail("Plan tidak cocok dengan objective.", { statusCode: 409, code: "PLAN_OBJECTIVE_MISMATCH", details: { code: "PLAN_OBJECTIVE_MISMATCH" } });
  }
  if (plan.state !== "APPROVED" || !plan.approvedBy || !plan.approvedAt) {
    fail("Materialization membutuhkan plan yang sudah di-approve oleh human.", {
      statusCode: 409,
      code: "PLAN_NOT_APPROVED",
      details: { code: "PLAN_NOT_APPROVED", planId: plan.planId, state: plan.state },
    });
  }
  const fingerprint = plan.planFingerprint ?? planFingerprint(plan);
  if (!expectedFingerprint) {
    fail("Plan fingerprint wajib disertakan untuk materialization.", { code: "PLAN_FINGERPRINT_REQUIRED", details: { code: "PLAN_FINGERPRINT_REQUIRED" } });
  }
  if (expectedFingerprint !== fingerprint) {
    fail("Plan fingerprint tidak cocok dengan plan yang di-approve.", {
      statusCode: 409,
      code: "PLAN_FINGERPRINT_MISMATCH",
      details: { code: "PLAN_FINGERPRINT_MISMATCH", expected: fingerprint, received: expectedFingerprint },
    });
  }
  if (!decision || decision.type !== "PLAN_APPROVAL" || decision.state !== "RESOLVED" || decision.evidence?.planFingerprint !== fingerprint) {
    fail("Provenance approval plan tidak ditemukan atau tidak cocok.", {
      statusCode: 409,
      code: "PLAN_APPROVAL_PROVENANCE_MISSING",
      details: { code: "PLAN_APPROVAL_PROVENANCE_MISSING", planId: plan.planId },
    });
  }
  return fingerprint;
}

function assertPlanShape({ objective, plan, projects, runsRoot }) {
  const validation = validatePlanRecord(plan, planOptions(objective, projects));
  if (!validation.valid) {
    fail("Plan approved tidak lolos validasi sebelum materialization.", {
      statusCode: 422,
      code: "INVALID_APPROVED_PLAN",
      details: { code: "INVALID_APPROVED_PLAN", errors: validation.errors },
    });
  }
  const skillValidation = validatePlanSkillAssignments({ runsRoot, plan, checkCompatibility: false });
  if (!skillValidation.valid) {
    fail("Plan approved memiliki skill assignment yang tidak valid.", {
      statusCode: 422,
      code: "INVALID_PLAN_SKILLS",
      details: { code: "INVALID_PLAN_SKILLS", errors: skillValidation.errors },
    });
  }
  const coverage = validateVerificationCoverage({
    intent: plan.verificationIntent,
    planNodes: plan.nodes,
    integrationVerification: [
      ...(Array.isArray(plan.integration?.projectVerification) ? plan.integration.projectVerification : []),
      ...(Array.isArray(plan.integration?.crossProjectVerification) ? plan.integration.crossProjectVerification : []),
    ],
  });
  if (!coverage.valid) {
    fail(`Materialization ditolak: ${coverage.error}`, {
      statusCode: 422,
      code: coverage.code || "PLAN_VERIFICATION_COVERAGE_MISSING",
      details: { code: coverage.code || "PLAN_VERIFICATION_COVERAGE_MISSING", missingCoverage: coverage.missingCoverage },
    });
  }
}

function projectMap(projects) {
  return new Map(projects.map((project) => [project.id, project]));
}

function assertProjectsAvailable(objective, plan, projects, vaultRoot = null) {
  const byId = projectMap(projects);
  const required = new Set([...(objective.projectIds ?? []), ...(plan.projects ?? []), ...(plan.nodes ?? []).map((node) => node.projectId)]);
  const missing = [...required].filter((projectId) => !byId.has(projectId));
  if (missing.length) {
    fail(`Project materialization tidak ditemukan di registry: ${missing.join(", ")}`, {
      statusCode: 404,
      code: "PROJECT_NOT_FOUND",
      details: { code: "PROJECT_NOT_FOUND", missing },
    });
  }
  const unavailable = [...required].filter((projectId) => !byId.get(projectId).repositoryExists);
  if (unavailable.length) {
    fail(`Repository project belum tersedia: ${unavailable.join(", ")}`, {
      statusCode: 409,
      code: "PROJECT_REPOSITORY_UNAVAILABLE",
      details: { code: "PROJECT_REPOSITORY_UNAVAILABLE", projects: unavailable },
    });
  }

  if (plan.blueprints && vaultRoot) {
    for (const [projectId, frozenBp] of Object.entries(plan.blueprints)) {
      const project = byId.get(projectId);
      if (project) {
        const doc = readMarkdown(projectPagePath(vaultRoot, project.projectPage), vaultRoot);
        const currentBp = resolveProjectBlueprint({
          projectMetadata: doc?.metadata || {},
          registryMetadata: project,
          repositoryPath: project.repository,
          vaultRoot,
        });
        if (
          currentBp.id !== frozenBp.id ||
          currentBp.policyVersion !== frozenBp.policyVersion ||
          (frozenBp.policyFingerprint && currentBp.policyFingerprint && currentBp.policyFingerprint !== frozenBp.policyFingerprint)
        ) {
          fail(`Blueprint drift terdeteksi untuk project ${projectId}. Expected ${frozenBp.id} (v${frozenBp.policyVersion}), current ${currentBp.id} (v${currentBp.policyVersion}). Re-planning diperlukan.`, {
            statusCode: 409,
            code: "PROJECT_BLUEPRINT_DRIFT",
            details: { code: "PROJECT_BLUEPRINT_DRIFT", projectId, frozen: frozenBp, current: currentBp },
          });
        }
      }
    }
  }

  return byId;
}

function nextIdentityByProject({ vaultRoot, plan, readDocument }) {
  const existingByProject = new Map();
  const allocatedByProject = new Map();
  const allocation = new Map();
  for (const node of plan.nodes) {
    if (!existingByProject.has(node.projectId)) existingByProject.set(node.projectId, existingTaskSummary(vaultRoot, node.projectId, readDocument));
    const existing = existingByProject.get(node.projectId);
    const allocated = allocatedByProject.get(node.projectId) ?? [];
    const identity = nextTaskIdentity([...existing, ...allocated]);
    allocated.push({ id: identity.taskId, title: node.title, status: "BACKLOG" });
    allocatedByProject.set(node.projectId, allocated);
    allocation.set(node.nodeId, {
      taskId: identity.taskId,
      fileName: identity.fileName,
      projectId: node.projectId,
      relativePath: path.join("02-Projects", node.projectId, "tasks", identity.fileName),
    });
  }
  return allocation;
}

function dependencyIds(node, nodesById, allocation) {
  const sameProject = [];
  const qualified = [];
  for (const dependencyNodeId of node.dependsOn) {
    const dependencyNode = nodesById.get(dependencyNodeId);
    const dependencyTask = allocation.get(dependencyNodeId);
    if (!dependencyNode || !dependencyTask) {
      fail(`Dependency node tidak dapat dimaterialisasi: ${dependencyNodeId}`, {
        statusCode: 422,
        code: "MATERIALIZATION_DEPENDENCY_INVALID",
        details: { code: "MATERIALIZATION_DEPENDENCY_INVALID", nodeId: node.nodeId, dependencyNodeId },
      });
    }
    const qualifiedId = `${dependencyNode.projectId}:${dependencyTask.taskId}`;
    qualified.push(qualifiedId);
    if (dependencyNode.projectId === node.projectId) sameProject.push(dependencyTask.taskId);
  }
  return { sameProject, qualified };
}

function renderTasks({ objective, plan, orchestrationId, allocation, readDocument }) {
  const nodesById = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const rendered = [];
  for (const node of plan.nodes) {
    const target = allocation.get(node.nodeId);
    const dependencies = dependencyIds(node, nodesById, allocation);
    const content = taskDocument({
      taskId: target.taskId,
      projectId: node.projectId,
      request: `${objective.request}\n\nOrchestration node: ${node.nodeId}`,
      requestedBy: "orchestrator",
      readMarkdown: readDocument,
      draft: {
        title: node.title,
        purpose: node.purpose,
        expectedResult: `Node ${node.nodeId} memenuhi seluruh acceptance criteria yang disetujui pada plan ${plan.planId}.`,
        acceptanceCriteria: node.acceptanceCriteria,
        dependencies: dependencies.sameProject,
        verification: node.verification,
        allowedPaths: node.allowedPaths,
        requiresChanges: node.requiresChanges,
        risk: node.risk,
        complexity: node.complexity,
      },
      orchestration: {
        objectiveId: objective.objectiveId,
        planId: plan.planId,
        orchestrationId,
        nodeId: node.nodeId,
        orchestrationDependencies: dependencies.qualified,
        role: node.role,
        nodeType: node.type,
        writeConflictGroup: node.writeConflictGroup ?? null,
        contextFrom: node.contextFrom ?? [],
        skills: node.skills ?? [],
      },
    });
    if (!content.includes(`task_id: ${target.taskId}`) || !content.includes("orchestration_managed: true")) {
      fail(`Dokumen task hasil render tidak valid: ${node.nodeId}`, {
        statusCode: 422,
        code: "MATERIALIZATION_DOCUMENT_INVALID",
        details: { code: "MATERIALIZATION_DOCUMENT_INVALID", nodeId: node.nodeId },
      });
    }
    rendered.push({ ...target, nodeId: node.nodeId, content, dependencies: dependencies.sameProject, orchestrationDependencies: dependencies.qualified });
  }
  return rendered;
}

function removePath(filePath) {
  try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function writeTaskTransaction({ vaultRoot, rendered }) {
  const staged = [];
  const created = [];
  try {
    for (const task of rendered) {
      const absolutePath = path.join(vaultRoot, task.relativePath);
      if (fs.existsSync(absolutePath)) {
        fail(`Task path sudah ada: ${task.relativePath}`, { statusCode: 409, code: "TASK_PATH_CONFLICT", details: { code: "TASK_PATH_CONFLICT", path: task.relativePath } });
      }
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      const temporaryPath = `${absolutePath}.materialize-${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
      injectFault("task.materializer.before-temp", { absolutePath, temporaryPath, nodeId: task.nodeId });
      staged.push({ ...task, absolutePath, temporaryPath });
      fs.writeFileSync(temporaryPath, task.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    for (const task of staged) {
      injectFault("task.materializer.before-rename", { absolutePath: task.absolutePath, temporaryPath: task.temporaryPath, nodeId: task.nodeId });
      fs.renameSync(task.temporaryPath, task.absolutePath);
      created.push(task.absolutePath);
      injectFault("task.materializer.after-rename", { absolutePath: task.absolutePath, nodeId: task.nodeId });
    }
    return {
      tasks: staged.map((task) => ({
        nodeId: task.nodeId,
        taskId: task.taskId,
        projectId: task.projectId,
        fileName: task.fileName,
        relativePath: task.relativePath,
        path: task.relativePath,
        dependencies: task.dependencies,
        orchestrationDependencies: task.orchestrationDependencies,
      })),
      createdPaths: [...created],
    };
  } catch (error) {
    for (const task of staged) removePath(task.temporaryPath);
    for (const absolutePath of created) removePath(absolutePath);
    throw error;
  }
}

function orchestrationRecord({ objective, plan, orchestrationId, materialized, now }) {
  const taskByNode = new Map(materialized.map((task) => [task.nodeId, task]));
  const nodes = Object.fromEntries(plan.nodes.map((node) => [node.nodeId, {
    state: node.dependsOn.length ? "BLOCKED" : "READY",
    taskId: taskByNode.get(node.nodeId)?.taskId ?? null,
    jobId: null,
    runId: null,
    attempt: 1,
    blockedBy: node.dependsOn.map((dependency) => taskByNode.get(dependency)?.taskId).filter(Boolean),
    lastError: null,
  }]));
  const timestamp = iso(now);
  return {
    schemaVersion: 1,
    revision: 0,
    orchestrationId,
    objectiveId: objective.objectiveId,
    planId: plan.planId,
    state: "CREATED",
    planFingerprint: plan.planFingerprint ?? planFingerprint(plan),
    nodes,
    integration: {
      state: "NOT_READY",
      projectBaselines: {},
      artifacts: [],
      verification: [],
      rollback: null,
    },
    usage: { totalTokens: 0, agentInvocations: 0, retries: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
    materialization: {
      state: "MATERIALIZED",
      materializedAt: timestamp,
      tasks: materialized.map((task) => ({
        nodeId: task.nodeId,
        projectId: task.projectId,
        taskId: task.taskId,
        path: task.relativePath,
        dependencies: task.dependencies,
        orchestrationDependencies: task.orchestrationDependencies,
      })),
    },
  };
}

function alreadyMaterialized({ existing, objective, plan, fingerprint }) {
  if (!existing) return null;
  if (existing.objectiveId !== objective.objectiveId || existing.planId !== plan.planId || existing.planFingerprint !== fingerprint) {
    fail("Orchestration materialization existing tidak cocok dengan plan yang diminta.", {
      statusCode: 409,
      code: "MATERIALIZATION_CONFLICT",
      details: { code: "MATERIALIZATION_CONFLICT", orchestrationId: existing.orchestrationId },
    });
  }
  return {
    schemaVersion: 1,
    action: "TASKS_ALREADY_MATERIALIZED",
    alreadyMaterialized: true,
    objective,
    plan,
    orchestration: existing,
    tasks: existing.materialization?.tasks ?? [],
    planFingerprint: fingerprint,
  };
}

export function materializeApprovedPlan({
  vaultRoot,
  runsRoot,
  objectiveId,
  planId = null,
  expectedFingerprint = null,
  orchestrationId = null,
  now = new Date(),
  readDocument = readMarkdown,
} = {}) {
  const normalizedObjectiveId = stableId(objectiveId, "objectiveId");
  if (!vaultRoot || !runsRoot) fail("vaultRoot dan runsRoot wajib disediakan.", { code: "MATERIALIZATION_ROOT_REQUIRED" });
  const initialObjective = getObjective(runsRoot, normalizedObjectiveId);
  if (!initialObjective) fail(`Objective tidak ditemukan: ${normalizedObjectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId: normalizedObjectiveId } });
  const lockId = orchestrationId ?? materializationOrchestrationId(normalizedObjectiveId);
  stableId(lockId, "orchestrationId");
  return withDurableLease({
    runsRoot,
    namespace: "task-materializer",
    key: normalizedObjectiveId,
    purpose: `materialize approved plan ${normalizedObjectiveId}`,
    ttlMs: 5 * 60 * 1000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 2_000,
  }, () => {
    const objective = getObjective(runsRoot, normalizedObjectiveId);
    const projects = listProjects(vaultRoot).projects;
    const requestedPlanId = planId ?? objective.activePlanId;
    const plan = requestedPlanId ? getPlan(runsRoot, requestedPlanId, planOptions(objective, projects)) : null;
    const fingerprint = assertApprovedPlan({
      objective,
      plan,
      expectedPlanId: planId,
      expectedFingerprint,
      decision: plan ? planApprovalDecision(runsRoot, plan) : null,
    });
    assertPlanShape({ objective, plan, projects, runsRoot });
    const existing = getOrchestration(runsRoot, lockId, { plan });
    const idempotent = alreadyMaterialized({ existing, objective, plan, fingerprint });
    if (idempotent) return idempotent;
    assertProjectsAvailable(objective, plan, projects, vaultRoot);
    const allocation = nextIdentityByProject({ vaultRoot, plan, readDocument });
    const rendered = renderTasks({ objective, plan, orchestrationId: lockId, allocation, readDocument });
    const transaction = writeTaskTransaction({ vaultRoot, rendered });
    const materialized = transaction.tasks;
    let orchestration = null;
    try {
      orchestration = createOrchestration({
        runsRoot,
        record: orchestrationRecord({ objective, plan, orchestrationId: lockId, materialized, now }),
        validationOptions: { plan },
      });
      const nextObjective = updateObjective({
        runsRoot,
        objectiveId: objective.objectiveId,
        expectedRevision: objective.revision,
        now,
        update: (record) => ({ ...record, state: "MATERIALIZING", activePlanId: plan.planId, activeOrchestrationId: lockId }),
      });
      return {
        schemaVersion: 1,
        action: "TASKS_MATERIALIZED",
        alreadyMaterialized: false,
        objective: nextObjective,
        plan,
        orchestration,
        tasks: materialized,
        planFingerprint: fingerprint,
      };
    } catch (error) {
      for (const absolutePath of transaction.createdPaths) removePath(absolutePath);
      if (orchestration) removePath(orchestrationPath(runsRoot, orchestration.orchestrationId));
      throw error;
    }
  });
}

export const materializePlan = materializeApprovedPlan;
