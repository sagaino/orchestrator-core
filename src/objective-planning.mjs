import path from "node:path";
import { findRelevantKnowledge, getPackageScripts, listProjects, projectPagePath, readGraphSummary, readMarkdown } from "./core.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { getObjective, updateObjective } from "./objective-store.mjs";
import { createPlanRevision } from "./plan-lifecycle.mjs";
import { getPlan } from "./plan-store.mjs";
import { decomposeProject } from "./project-decomposer.mjs";
import { resolveProjectBlueprint } from "./project-blueprint.mjs";
import { extractVerificationIntent, resolveVerificationIntent } from "./verification-intent.mjs";

export class ObjectivePlanningError extends Error {
  constructor(message, { statusCode = 400, code = "OBJECTIVE_PLANNING_INVALID", details = null } = {}) {
    super(message);
    this.name = "ObjectivePlanningError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new ObjectivePlanningError(message, options);
}

function bounded(value, limit) {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function buildObjectiveKnowledge(vaultRoot, objective) {
  const knowledgeMap = new Map();
  if (!vaultRoot) return [];

  // 1. Resolve explicitly linked sources from each project.md
  try {
    const registry = listProjects(vaultRoot).projects;
    for (const projectId of (objective.projectIds ?? [])) {
      const project = registry.find((candidate) => candidate.id === projectId);
      if (!project) continue;
      const document = readMarkdown(projectPagePath(vaultRoot, project.projectPage), vaultRoot);
      const sources = Array.isArray(document?.metadata?.sources) ? document.metadata.sources : [];
      for (const source of sources) {
        const cleanPath = String(source).replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
        const relativePath = cleanPath.endsWith(".md") ? cleanPath : `${cleanPath}.md`;
        const fullPath = path.join(vaultRoot, relativePath);
        const doc = readMarkdown(fullPath, vaultRoot);
        if (doc && !knowledgeMap.has(doc.path)) {
          knowledgeMap.set(doc.path, {
            path: doc.path,
            title: doc.title || path.basename(doc.path, ".md"),
            summary: doc.body.slice(0, 1000),
            score: 10,
          });
        }
      }
    }
  } catch {}

  // 2. Also retrieve relevant knowledge based on objective request text
  try {
    const matched = findRelevantKnowledge(vaultRoot, { title: objective.request.slice(0, 100), body: objective.request });
    for (const item of matched) {
      if (!knowledgeMap.has(item.path)) {
        knowledgeMap.set(item.path, item);
      }
    }
  } catch {}

  return Array.from(knowledgeMap.values());
}

function buildProjectContexts(vaultRoot, objective) {
  const registry = listProjects(vaultRoot).projects;
  return objective.projectIds.map((projectId) => {
    const project = registry.find((candidate) => candidate.id === projectId);
    if (!project || !project.valid) {
      fail(`Project belum siap untuk planning: ${projectId}`, {
        statusCode: 422,
        code: "PROJECT_NOT_READY",
        details: { code: "PROJECT_NOT_READY", projectId },
      });
    }
    const packageScripts = getPackageScripts(project.repository);
    const availableScripts = Object.keys(packageScripts);
    const configuredDefaults = Array.isArray(project.verificationDefaults) && project.verificationDefaults.length > 0
      ? project.verificationDefaults
      : [];
    const verification = configuredDefaults.length > 0
      ? configuredDefaults
      : availableScripts;
    if (!verification.length) {
      fail(`Project tidak memiliki verification script yang dapat digunakan: ${projectId}`, {
        statusCode: 422,
        code: "PROJECT_VERIFICATION_UNAVAILABLE",
        details: { code: "PROJECT_VERIFICATION_UNAVAILABLE", projectId },
      });
    }
    const document = readMarkdown(projectPagePath(vaultRoot, project.projectPage), vaultRoot);
    const blueprint = resolveProjectBlueprint({
      projectMetadata: document?.metadata || {},
      registryMetadata: project,
      repositoryPath: project.repository,
      vaultRoot,
    });
    if (!blueprint.valid) {
      fail(`Project blueprint gagal ditentukan untuk project ${projectId}: ${blueprint.error}`, {
        statusCode: 422,
        code: "PROJECT_BLUEPRINT_UNRESOLVED",
        details: { code: "PROJECT_BLUEPRINT_UNRESOLVED", projectId, error: blueprint.error },
      });
    }
    return {
      projectId,
      repository: project.repository,
      summary: bounded(document?.body, 4_000),
      blueprint,
      verification,
      verificationScripts: availableScripts.length > 0 ? availableScripts : verification,
      activeTasks: [],
      graph: readGraphSummary(project.graphifyOutput),
    };
  });
}

function effectiveObjective(objective, clarification) {
  const answer = String(clarification ?? "").trim();
  if (!answer) return objective;
  return { ...objective, request: `${objective.request}\n\n[Human clarification]\n${answer}` };
}

function currentPlan(runsRoot, objective) {
  if (!objective.activePlanId) return null;
  return getPlan(runsRoot, objective.activePlanId, { knownProjectIds: objective.projectIds, budget: objective.budget });
}

export async function planObjective({
  vaultRoot,
  runsRoot,
  objectiveId,
  clarification = null,
  requestedBy = "user",
  now = new Date(),
  env = process.env,
  decomposer = decomposeProject,
} = {}) {
  return withDurableLease({
    runsRoot,
    namespace: "objective-planning",
    key: objectiveId,
    purpose: `objective planning ${objectiveId}`,
    ttlMs: 15 * 60 * 1000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 2_000,
  }, async () => {
    const objective = getObjective(runsRoot, objectiveId);
    if (!objective) fail(`Objective tidak ditemukan: ${objectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId } });
    if (!["EXISTING_PROJECT", "CROSS_PROJECT_INCIDENT"].includes(objective.mode)) {
      fail(`Mode ${objective.mode} tidak menggunakan project decomposition.`, { statusCode: 409, code: "OBJECTIVE_MODE_NOT_PLANNABLE", details: { code: "OBJECTIVE_MODE_NOT_PLANNABLE", mode: objective.mode } });
    }
    if (objective.state === "CANCELLED") {
      fail("Objective sudah dibatalkan. Buat Objective baru untuk menjalankan instruksi ini kembali.", {
        statusCode: 409,
        code: "OBJECTIVE_CANCELLED_RECREATE_REQUIRED",
        details: { code: "OBJECTIVE_CANCELLED_RECREATE_REQUIRED", objectiveId: objective.objectiveId },
      });
    }
    if (!["PLANNING", "NEEDS_CLARIFICATION"].includes(objective.state)) {
      fail(`Objective state tidak dapat diproses oleh planner: ${objective.state}`, { statusCode: 409, code: "OBJECTIVE_STATE_INVALID", details: { code: "OBJECTIVE_STATE_INVALID", state: objective.state } });
    }
    const existingPlan = currentPlan(runsRoot, objective);
    if (existingPlan && !clarification) {
      return { objective, plan: existingPlan, status: objective.state, alreadyPlanned: true, planning: { started: true, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 } };
    }
    if (objective.state === "NEEDS_CLARIFICATION" && !String(clarification ?? "").trim()) {
      fail("Jawaban klarifikasi wajib diisi.", { code: "CLARIFICATION_REQUIRED", details: { code: "CLARIFICATION_REQUIRED" } });
    }

    const contexts = buildProjectContexts(vaultRoot, objective);
    const knowledge = buildObjectiveKnowledge(vaultRoot, objective);
    const effectiveObj = effectiveObjective(objective, clarification);
    const verificationIntent = objective.verificationIntent?.contractVersion === 2
      && ["RESOLVED", "RESOLVED_WITH_WAIVERS"].includes(objective.verificationIntent.status)
      ? resolveVerificationIntent({ intent: objective.verificationIntent, projectContexts: contexts })
      : extractVerificationIntent({
          request: effectiveObj.request,
          structuredIntent: objective.structuredVerificationIntent || null,
          projectContexts: contexts,
        });

    if (verificationIntent.status === "NEEDS_CLARIFICATION") {
      const missingList = verificationIntent.missing.map((m) => `${m.capability} (${m.reason})`).join(", ");
      const question = `Verifikasi berikut diminta oleh user/policy tetapi tidak tersedia script yang disetujui di project: ${missingList}. Apakah Anda ingin melanjutkan tanpa verifikasi ini atau menentukan script lain?`;
      const updated = updateObjective({
        runsRoot,
        objectiveId,
        expectedRevision: objective.revision,
        now,
        update: (record) => ({
          ...record,
          state: "NEEDS_CLARIFICATION",
          verificationIntent,
          planning: {
            status: "NEEDS_CLARIFICATION",
            clarificationQuestion: question,
            requestedAt: now.toISOString(),
            requestedBy: String(requestedBy || "user"),
          },
        }),
      });
      return {
        status: "NEEDS_CLARIFICATION",
        clarificationNeeded: true,
        clarificationQuestion: question,
        verificationIntent,
        objective: updated,
        plan: null,
        alreadyPlanned: false,
      };
    }

    const result = await decomposer({
      objective: effectiveObj,
      projectContexts: contexts,
      knowledge,
      graphifyContext: bounded(JSON.stringify(contexts.map((project) => ({ projectId: project.projectId, graph: project.graph }))), 3_000),
      verificationIntent,
      runsRoot,
      vaultRoot,
      now,
      env,
    });

    if (result.status === "NEEDS_CLARIFICATION") {
      const updated = updateObjective({
        runsRoot,
        objectiveId,
        expectedRevision: objective.revision,
        now,
        update: (record) => ({
          ...record,
          state: "NEEDS_CLARIFICATION",
          verificationIntent,
          planning: {
            status: "NEEDS_CLARIFICATION",
            clarificationQuestion: bounded(result.clarificationQuestion, 2_000),
            requestedAt: now.toISOString(),
            requestedBy: String(requestedBy || "user"),
          },
        }),
      });
      return { ...result, verificationIntent, objective: updated, plan: null, alreadyPlanned: false };
    }
    if (!result.plan) fail("Planner tidak menghasilkan plan atau clarification.", { statusCode: 502, code: "PLANNER_EMPTY_RESULT", details: { code: "PLANNER_EMPTY_RESULT" } });

    const candidatePlanWithIntent = {
      ...result.plan,
      verificationIntent,
      blueprints: Object.fromEntries(contexts.map((ctx) => [ctx.projectId, ctx.blueprint])),
    };

    const revision = createPlanRevision({ runsRoot, objectiveId, candidate: candidatePlanWithIntent, now });
    const plannedObjective = revision.objective.planning
      ? updateObjective({
        runsRoot,
        objectiveId,
        expectedRevision: revision.objective.revision,
        now,
        update: (record) => {
          const { planning: _planning, ...withoutPlanning } = record;
          return withoutPlanning;
        },
      })
      : revision.objective;
    return { ...result, verificationIntent, objective: plannedObjective, plan: revision.plan, previousPlan: revision.previousPlan, revision: revision.revision, alreadyPlanned: false };
  });
}
