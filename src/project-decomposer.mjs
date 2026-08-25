import path from "node:path";
import { detectTaskComplexity, resolveAgyConfig, agyConfigArgs } from "./agent-config.mjs";
import { resolveAgentRoute } from "./agent-routing.mjs";
import { buildStageContext, estimateTokenCount } from "./context-compactor.mjs";
import { validatePlanRecord } from "./orchestration-schema.mjs";
import { validateTaskGraph } from "./task-graph.mjs";
import { runProcess } from "./executor.mjs";
import { diagnoseCrossProject, validateCrossProjectPlan } from "./cross-project-diagnostics.mjs";
import { projectSignalsForProjects } from "./skill-assignment.mjs";
import { routePlanSkills, routingEvidence } from "./skill-router.mjs";

export const PROJECT_DECOMPOSITION_STAGE = "project-decomposition";
export const PROJECT_DECOMPOSITION_REVISION = 1;

const PLAN_STATE = "PENDING_APPROVAL";
const DEFAULT_BUDGET = Object.freeze({
  maxSubtasks: 8,
  maxParallelAgents: 3,
  maxRetriesPerNode: 2,
  maxRepairCycles: 1,
  maxTotalTokens: null,
  deadlineAt: null,
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedText(value, maxCharacters) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length <= maxCharacters ? text : `${text.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function errorWithCode(message, code, details = {}) {
  const error = new Error(message);
  error.name = "ProjectDecomposerError";
  error.code = code;
  error.details = { code, ...details };
  return error;
}

export function decompositionPlanSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion", "planId", "objectiveId", "revision", "state", "summary",
      "architectureDecisions", "assumptions", "clarificationNeeded", "clarificationQuestion",
      "projects", "nodes", "integration", "risk", "complexity", "approvedBy", "approvedAt", "createdAt",
    ],
    properties: {
      schemaVersion: { const: 1 },
      planId: { type: "string", minLength: 1 },
      objectiveId: { type: "string", minLength: 1 },
      revision: { const: PROJECT_DECOMPOSITION_REVISION },
      state: { const: PLAN_STATE },
      summary: { type: "string", minLength: 1 },
      architectureDecisions: { type: "array" },
      assumptions: { type: "array" },
      clarificationNeeded: { type: "boolean" },
      clarificationQuestion: { type: ["string", "null"] },
      projects: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
      nodes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "nodeId", "title", "purpose", "projectId", "role", "type", "dependsOn",
            "acceptanceCriteria", "allowedPaths", "verification", "risk", "complexity",
            "requiresChanges", "canRunInParallel", "writeConflictGroup", "contextFrom", "skills",
          ],
          properties: {
            nodeId: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            purpose: { type: "string", minLength: 1 },
            projectId: { type: "string", minLength: 1 },
            role: { enum: ["PLANNER", "DIAGNOSTIC", "FRONTEND", "BACKEND", "DATABASE", "INTEGRATION", "TESTING", "REVIEW", "GENERAL"] },
            type: { enum: ["DIAGNOSTIC", "IMPLEMENTATION", "INTEGRATION", "VERIFICATION"] },
            dependsOn: { type: "array", items: { type: "string" } },
            acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
            allowedPaths: { type: "array", items: { type: "string", description: "Repository-relative POSIX path only; never absolute and never use . or .. segments." } },
            verification: { type: "array", minItems: 1, items: { type: "string" } },
            risk: { type: "string" },
            complexity: { type: "string" },
            requiresChanges: { type: "boolean" },
            canRunInParallel: { type: "boolean" },
            writeConflictGroup: { type: ["string", "null"] },
            contextFrom: { type: "array", items: { type: "string" } },
            skills: { type: "array", maxItems: 0 },
          },
        },
      },
      integration: {
        type: "object",
        required: ["required", "projectVerification", "crossProjectVerification", "previewRequired"],
        additionalProperties: false,
        properties: {
          required: { type: "boolean" },
          projectVerification: { type: "array", items: { type: "string", minLength: 1 } },
          crossProjectVerification: { type: "array", items: { type: "string", minLength: 1 } },
          previewRequired: { type: "boolean" },
        },
      },
      risk: { enum: ["LOW", "MEDIUM", "HIGH"] },
      complexity: { enum: ["LOW", "MEDIUM", "HIGH"] },
      approvedBy: { type: ["string", "null"] },
      approvedAt: { type: ["string", "null"] },
      createdAt: { type: "string", minLength: 1 },
      estimatedTokens: { type: "integer", minimum: 0 },
      toolAction: { type: "string" },
      toolSummary: { type: "string" },
    },
  };
}

export function decompositionOutputSchema() {
  return {
    oneOf: [
      decompositionPlanSchema(),
      {
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "clarificationNeeded", "clarificationQuestion"],
        properties: {
          schemaVersion: { const: 1 },
          clarificationNeeded: { const: true },
          clarificationQuestion: { type: "string", minLength: 1 },
          toolAction: { type: "string" },
          toolSummary: { type: "string" },
        },
      },
    ],
  };
}

function unwrapProviderEnvelope(value) {
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (isRecord(value.structured_output)) return value.structured_output;
  if (keys.length === 2 && value.event === "result" && isRecord(value.result)) return value.result;
  if (Object.hasOwn(value, "response")) {
    if (String(value.status ?? "").toUpperCase() === "ERROR" || value.error) {
      throw errorWithCode(`Decomposition provider melaporkan error: ${boundedText(value.error ?? value.status, 600)}`, "PROVIDER_FAILED");
    }
    if (isRecord(value.response)) return value.response;
    if (typeof value.response === "string") {
      try {
        const response = JSON.parse(value.response.trim());
        if (isRecord(response)) return response;
      } catch {
        throw errorWithCode("Decomposition provider response harus satu dokumen JSON tanpa prose.", "INVALID_DECOMPOSITION_OUTPUT");
      }
    }
  }
  return value;
}

/** Parse one complete JSON document; prose and concatenated JSON are rejected. */
export function parseDecompositionResult(result) {
  const stdout = typeof result?.stdoutTail === "string" ? result.stdoutTail.trim() : "";
  let payload = result?.finalResult;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw errorWithCode("Decomposition provider output harus satu dokumen JSON tanpa prose.", "INVALID_DECOMPOSITION_OUTPUT");
    }
  }
  payload = unwrapProviderEnvelope(payload);
  if (!isRecord(payload)) throw errorWithCode("Decomposition provider tidak menghasilkan object JSON.", "INVALID_DECOMPOSITION_OUTPUT");
  const { toolAction: _toolAction, toolSummary: _toolSummary, ...contractPayload } = payload;
  return contractPayload;
}

function normalizedBudget(budget = {}) {
  const output = { ...DEFAULT_BUDGET, ...(isRecord(budget) ? budget : {}) };
  for (const field of ["maxSubtasks", "maxParallelAgents", "maxRetriesPerNode", "maxRepairCycles"]) {
    if (!Number.isInteger(output[field]) || output[field] <= 0) throw errorWithCode(`budget.${field} tidak valid.`, "INVALID_BUDGET", { field });
  }
  if (output.maxTotalTokens !== null && (!Number.isInteger(output.maxTotalTokens) || output.maxTotalTokens <= 0)) {
    throw errorWithCode("budget.maxTotalTokens tidak valid.", "INVALID_BUDGET", { field: "maxTotalTokens" });
  }
  return output;
}

function boundedProjectContexts(projectContexts = []) {
  return (Array.isArray(projectContexts) ? projectContexts : []).slice(0, 8).map((project) => ({
    projectId: boundedText(project?.projectId ?? project?.id, 160),
    summary: boundedText(project?.summary ?? project?.context ?? project?.architecture, 1800),
    verification: (Array.isArray(project?.verification) ? project.verification : Array.isArray(project?.verificationScripts) ? project.verificationScripts : [])
      .map((item) => boundedText(item, 120)).filter(Boolean).slice(0, 16),
    activeTasks: (Array.isArray(project?.activeTasks) ? project.activeTasks : []).slice(0, 8).map((task) => ({
      id: boundedText(task?.id, 100),
      title: boundedText(task?.title, 240),
      status: boundedText(task?.status, 40),
    })),
  }));
}

export function buildDecompositionContext({ objective, projectContexts = [], knowledge = [], graphifyContext = "", crossProjectDiagnosis = null, budgets = {} } = {}) {
  const boundedProjects = boundedProjectContexts(projectContexts);
  const budget = normalizedBudget(objective?.budget);
  return buildStageContext({
    stage: PROJECT_DECOMPOSITION_STAGE,
    acceptanceCriteria: [
      "Return a validated dependency-aware plan with the smallest safe subtask set.",
      `Respect maxSubtasks=${budget.maxSubtasks} and maxParallelAgents=${budget.maxParallelAgents}.`,
    ],
    latestFeedback: boundedText(objective?.request, 5000),
    graphifyContext: boundedText(graphifyContext, 1800),
    revisionState: {
      objective: JSON.stringify({
        objectiveId: objective?.objectiveId ?? null,
        mode: objective?.mode ?? null,
        projectIds: objective?.projectIds ?? [],
        budget,
        attachments: (objective?.attachments ?? []).slice(0, 20).map((attachment) => ({
          type: attachment.type,
          fileName: boundedText(attachment.fileName, 255),
          relativeVaultPath: boundedText(attachment.relativeVaultPath, 500) || null,
          relativeProjectPath: boundedText(attachment.relativeProjectPath, 500) || null,
        })),
      }),
      projects: JSON.stringify(boundedProjects),
      crossProjectDiagnosis: crossProjectDiagnosis ? JSON.stringify({
        outcome: crossProjectDiagnosis.outcome,
        summary: crossProjectDiagnosis.summary,
        evidence: crossProjectDiagnosis.evidence,
        implicatedProjects: crossProjectDiagnosis.implicatedProjects,
      }) : "",
    },
    knowledge,
    budgets,
  });
}

function sortedProjectIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))].sort();
}

function normalizeAllowedPath(value, repository) {
  const candidate = String(value ?? "").trim();
  if (!candidate || !repository || (!path.isAbsolute(candidate) && !/^[A-Za-z]:[\\/]/.test(candidate))) return value;

  const root = path.resolve(String(repository));
  const absolute = path.resolve(candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return value;
  return relative.split(path.sep).join("/");
}

export function normalizePlanAllowedPaths(plan, projectContexts = []) {
  if (!isRecord(plan) || !Array.isArray(plan.nodes)) return plan;
  const repositories = new Map((Array.isArray(projectContexts) ? projectContexts : []).map((project) => [
    String(project?.projectId ?? project?.id ?? ""),
    project?.repository,
  ]));
  return {
    ...plan,
    nodes: plan.nodes.map((node) => {
      if (!isRecord(node) || !Array.isArray(node.allowedPaths)) return node;
      const repository = repositories.get(String(node.projectId ?? ""));
      return {
        ...node,
        allowedPaths: node.allowedPaths.map((allowedPath) => normalizeAllowedPath(allowedPath, repository)),
      };
    }),
  };
}

function unexpectedKeys(record, allowed, label) {
  if (!isRecord(record)) return [];
  return Object.keys(record).filter((key) => !allowed.has(key)).map((key) => `${label} contains unsupported field: ${key}`);
}

function validateParsedPlan(plan, objective, budget, projectContexts = []) {
  const expectedObjectiveId = String(objective.objectiveId ?? "").trim();
  const expectedProjects = sortedProjectIds(objective.projectIds);
  const errors = [];
  errors.push(...unexpectedKeys(plan, new Set([
    "schemaVersion", "planId", "objectiveId", "revision", "state", "summary", "architectureDecisions", "assumptions",
    "clarificationNeeded", "clarificationQuestion", "projects", "nodes", "integration", "risk", "complexity", "approvedBy", "approvedAt", "createdAt", "estimatedTokens",
  ]), "plan"));
  for (const [index, node] of (Array.isArray(plan.nodes) ? plan.nodes : []).entries()) {
    errors.push(...unexpectedKeys(node, new Set([
      "nodeId", "title", "purpose", "projectId", "role", "type", "dependsOn", "acceptanceCriteria", "allowedPaths", "verification",
      "risk", "complexity", "requiresChanges", "canRunInParallel", "writeConflictGroup", "contextFrom", "skills",
    ]), `plan.nodes[${index}]`));
  }
  errors.push(...unexpectedKeys(plan.integration, new Set(["required", "projectVerification", "crossProjectVerification", "previewRequired"]), "plan.integration"));
  if (plan.schemaVersion !== 1) errors.push("plan.schemaVersion harus 1");
  if (plan.planId !== `plan-${expectedObjectiveId}-r${PROJECT_DECOMPOSITION_REVISION}`) errors.push("plan.planId tidak sesuai dengan objective revision 1");
  if (plan.objectiveId !== expectedObjectiveId) errors.push("plan.objectiveId tidak sesuai dengan objective");
  if (plan.revision !== PROJECT_DECOMPOSITION_REVISION) errors.push("plan.revision harus 1");
  if (plan.state !== PLAN_STATE) errors.push("plan.state harus PENDING_APPROVAL");
  if (plan.approvedBy !== null || plan.approvedAt !== null) errors.push("model tidak boleh mengisi approval fields");
  const expectedProjectSet = new Set(expectedProjects);
  const planProjects = sortedProjectIds(plan.projects);
  const unknownProjects = planProjects.filter((id) => !expectedProjectSet.has(id));
  if (unknownProjects.length > 0) {
    errors.push(`plan.projects memuat project tidak dikenal: ${unknownProjects.join(", ")}`);
  }
  if (planProjects.length === 0) {
    errors.push("plan.projects tidak boleh kosong");
  }

  const schemaValidation = validatePlanRecord({ ...plan, nodes: Array.isArray(plan.nodes) ? plan.nodes : [] }, {
    knownProjectIds: expectedProjects,
    projectVerificationScripts: Object.fromEntries(projectContexts.map((project) => [project.projectId ?? project.id, project.verificationScripts ?? project.verification ?? []])),
    maxSubtasks: budget.maxSubtasks,
    maxParallelAgents: budget.maxParallelAgents,
    maxTotalTokens: budget.maxTotalTokens ?? undefined,
  });
  const graphValidation = validateTaskGraph(plan.nodes);
  errors.push(...schemaValidation.errors, ...graphValidation.errors.map((message) => `graph: ${message}`));

  const scriptsByProject = new Map(projectContexts.map((project) => [
    String(project.projectId ?? project.id),
    new Set((project.verificationScripts ?? project.verification ?? []).map(String)),
  ]));
  const validateIntegrationScripts = (field, { requireEveryProject = false, requireAtLeastOne = false } = {}) => {
    const values = plan.integration?.[field];
    if (!Array.isArray(values)) return;
    if (requireAtLeastOne && values.length === 0) errors.push(`plan.integration.${field} wajib memuat approved scoped script`);
    const covered = new Set();
    for (const [index, value] of values.entries()) {
      if (typeof value !== "string" || !value.trim()) {
        errors.push(`plan.integration.${field}[${index}] harus string projectId:script`);
        continue;
      }
      const match = expectedProjects.find((projectId) => value.startsWith(`${projectId}:`));
      if (!match || !expectedProjectSet.has(match)) {
        errors.push(`plan.integration.${field}[${index}] harus scoped sebagai projectId:script`);
        continue;
      }
      const script = value.slice(match.length + 1).trim();
      if (!script || !scriptsByProject.get(match)?.has(script)) errors.push(`plan.integration.${field}[${index}] menggunakan verification script tidak terdaftar: ${value}`);
      covered.add(match);
    }
    if (requireEveryProject) {
      for (const projectId of expectedProjects) if (!covered.has(projectId)) errors.push(`plan.integration.${field} belum mencakup project ${projectId}`);
    }
  };
  if (plan.integration?.required === true) {
    validateIntegrationScripts("projectVerification", { requireEveryProject: expectedProjects.length > 1, requireAtLeastOne: true });
    validateIntegrationScripts("crossProjectVerification", { requireAtLeastOne: String(objective.mode).toUpperCase() === "CROSS_PROJECT_INCIDENT" });
  }

  const estimatedTokens = Number.isInteger(plan.estimatedTokens) ? plan.estimatedTokens : estimateTokenCount(JSON.stringify(plan));
  if (budget.maxTotalTokens !== null && estimatedTokens > budget.maxTotalTokens) {
    errors.push(`plan estimated tokens exceed budget: ${estimatedTokens} > ${budget.maxTotalTokens}`);
  }
  return { errors: [...new Set(errors)], schemaValidation, graphValidation, estimatedTokens };
}

function clarificationResult(raw, metadata) {
  const question = String(raw.clarificationQuestion ?? "").trim();
  const unsupportedFields = unexpectedKeys(raw, new Set(["schemaVersion", "clarificationNeeded", "clarificationQuestion"]), "clarification");
  if (!raw.schemaVersion || raw.schemaVersion !== 1 || raw.clarificationNeeded !== true || !question || unsupportedFields.length) {
    throw errorWithCode("Clarification output tidak memenuhi strict JSON contract.", "INVALID_DECOMPOSITION_OUTPUT");
  }
  return {
    status: "NEEDS_CLARIFICATION",
    objectiveState: "NEEDS_CLARIFICATION",
    clarificationNeeded: true,
    clarificationQuestion: question,
    plan: null,
    readOnly: true,
    planning: { started: true, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
    ...metadata,
  };
}

/**
 * Ask the provider for a bounded, read-only decomposition. This function does
 * not persist a plan and never creates tasks, jobs, or runs.
 */
export async function decomposeProject({
  objective,
  projectContexts = [],
  knowledge = [],
  graphifyContext = "",
  runsRoot = null,
  processRunner = runProcess,
  now = new Date(),
  env = process.env,
  contextBudgets = {},
} = {}) {
  if (!isRecord(objective) || !nonEmpty(objective.objectiveId) || !nonEmpty(objective.request)) {
    throw errorWithCode("Objective decomposition membutuhkan objectiveId dan request.", "INVALID_OBJECTIVE");
  }
  const budget = normalizedBudget(objective.budget);
  const complexity = String(objective.complexity ?? detectTaskComplexity(objective.request)).toUpperCase();
  const risk = String(objective.risk ?? "UNKNOWN").toUpperCase();
  const route = resolveAgentRoute({ stage: PROJECT_DECOMPOSITION_STAGE, risk, complexity });
  const agentConfig = resolveAgyConfig(env, PROJECT_DECOMPOSITION_STAGE, { risk, complexity });
  let crossProjectDiagnosis = null;
  let diagnosticMetadata = null;
  if (String(objective.mode ?? "").toUpperCase() === "CROSS_PROJECT_INCIDENT") {
    const diagnostic = await diagnoseCrossProject({
      objective,
      projectContexts,
      relationshipContext: objective.relationshipContext ?? "",
      graphifyContext,
      knowledge,
      runsRoot,
      processRunner,
      now,
      env,
      contextBudgets,
    });
    crossProjectDiagnosis = diagnostic.diagnosis;
    diagnosticMetadata = {
      status: diagnostic.status,
      invocationId: diagnostic.invocationId,
      route: diagnostic.route,
      context: diagnostic.context,
    };
    if (diagnostic.status === "NEEDS_CLARIFICATION") {
      return {
        ...diagnostic,
        diagnostic: diagnostic.diagnosis,
        decomposition: diagnosticMetadata,
      };
    }
  }
  const context = buildDecompositionContext({ objective, projectContexts, knowledge, graphifyContext, crossProjectDiagnosis, budgets: contextBudgets });
  const invocationId = `decomposition-${objective.objectiveId}-r${PROJECT_DECOMPOSITION_REVISION}`;
  const eventLogPath = runsRoot ? path.join(runsRoot, "events", `${invocationId}.jsonl`) : undefined;
  const planId = `plan-${objective.objectiveId}-r${PROJECT_DECOMPOSITION_REVISION}`;
  const prompt = [
    "=== READ-ONLY PROJECT DECOMPOSITION ===",
    "You are a planning-only provider. Do not edit files, run commands, create tasks, enqueue jobs, execute agents, approve a plan, or invent human identities.",
    "All repository evidence required for this decision is already supplied below. Do not inspect files or invoke tools.",
    "Return exactly one JSON object matching the supplied schema. Do not wrap it in Markdown or explanatory prose.",
    `The planId must be ${planId}; objectiveId must be ${objective.objectiveId}; revision must be 1; state must be PENDING_APPROVAL.`,
    "approvedBy and approvedAt must remain null. skills must remain an empty array.",
    `The only allowed project IDs are: ${JSON.stringify(sortedProjectIds(objective.projectIds))}.`,
    `Budget ceilings: ${JSON.stringify(budget)}. Never exceed them silently.`,
    "Every node.allowedPaths entry must be a repository-relative POSIX path such as src/components/Button.tsx or src/features/**. Never emit an absolute path, repository root path, drive-letter path, backslash path, or . / .. traversal segment. Never copy the repository path from context into allowedPaths. DIAGNOSTIC and VERIFICATION nodes must use allowedPaths=[] and requiresChanges=false.",
    "If a safe decomposition is impossible without a human answer, return only the clarification JSON shape with clarificationNeeded=true and a precise clarificationQuestion.",
    "integration.projectVerification and integration.crossProjectVerification may contain only approved scoped strings in the exact form projectId:script; never use objects, prose, acceptance criteria, or shell commands. For multi-project integration include at least one projectVerification entry per project and at least one crossProjectVerification entry.",
    ...(crossProjectDiagnosis ? [
      "The cross-project diagnostic is authoritative for implicated-project boundaries.",
      `Do not create implementation nodes outside these implicated projects: ${JSON.stringify(crossProjectDiagnosis.implicatedProjects)}.`,
      `Diagnostic outcome: ${crossProjectDiagnosis.outcome}. Evidence must remain reflected in node purposes or acceptance criteria.`,
      ...(crossProjectDiagnosis.outcome === "COMPATIBLE" ? [
        "COMPATIBLE requires a verification-only plan: do not create IMPLEMENTATION nodes, set requiresChanges=false, and keep allowedPaths=[] for every node.",
      ] : []),
    ] : []),
    "",
    "=== BOUNDED OBJECTIVE CONTEXT ===",
    context.text,
    "",
    "=== OUTPUT SCHEMA ===",
    JSON.stringify(decompositionOutputSchema()),
  ].join("\n");
  const repository = projectContexts.find((project) => nonEmpty(project?.repository))?.repository || process.cwd();
  const result = await processRunner({
    command: "agy",
    args: [
      "-p", prompt,
      "--output-format", "json",
      "--json-schema", JSON.stringify(decompositionOutputSchema()),
      ...agyConfigArgs(agentConfig),
      "--mode", "plan",
      "--print-timeout", "10m",
    ],
    cwd: repository,
    stage: PROJECT_DECOMPOSITION_STAGE,
    eventLogPath,
  });
  if (result?.exitCode !== 0) {
    throw errorWithCode(`Project decomposition provider gagal dengan exit code ${result?.exitCode ?? "unknown"}.`, "PROVIDER_FAILED");
  }
  const parsed = parseDecompositionResult(result);
  const metadata = {
    agentConfig,
    route,
    invocationId,
    context: { stage: context.stage, budgetTokens: context.budgetTokens, estimatedTokens: context.estimatedTokens },
  };
  if (parsed.clarificationNeeded === true) return clarificationResult(parsed, metadata);

  const normalizedPlan = normalizePlanAllowedPaths(parsed, projectContexts);
  const validation = validateParsedPlan(normalizedPlan, objective, budget, projectContexts);
  if (!validation.errors.length && crossProjectDiagnosis) {
    validation.errors.push(...validateCrossProjectPlan(normalizedPlan, crossProjectDiagnosis, objective));
  }
  if (validation.errors.length) {
    throw errorWithCode(`Decomposition plan invalid: ${validation.errors.join("; ")}`, "INVALID_PLAN", {
      validation: validation.errors,
      cycle: validation.graphValidation.cycle,
      estimatedTokens: validation.estimatedTokens,
    });
  }
  const skillRouting = runsRoot
    ? routePlanSkills({
      plan: normalizedPlan,
      runsRoot,
      projectSignalsByProject: projectSignalsForProjects(projectContexts),
      env,
    })
    : { plan: parsed, registryState: "UNAVAILABLE", registryRevision: null, routes: [] };
  return {
    status: "PLAN_REVIEW",
    objectiveState: "PLAN_REVIEW",
    clarificationNeeded: false,
    clarificationQuestion: null,
    plan: skillRouting.plan,
    skillRouting: routingEvidence(skillRouting.routes),
    skillRegistry: { state: skillRouting.registryState, revision: skillRouting.registryRevision },
    diagnostic: crossProjectDiagnosis,
    decomposition: diagnosticMetadata,
    readOnly: true,
    planning: { started: true, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
    ...metadata,
  };
}

export const planProjectDecomposition = decomposeProject;
