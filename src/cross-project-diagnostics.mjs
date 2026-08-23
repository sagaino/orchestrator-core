import path from "node:path";
import { agyConfigArgs, resolveAgyConfig } from "./agent-config.mjs";
import { resolveAgentRoute } from "./agent-routing.mjs";
import { buildStageContext } from "./context-compactor.mjs";
import { runProcess } from "./executor.mjs";

export const CROSS_PROJECT_DIAGNOSTIC_STAGE = "cross-project-diagnostic";
export const CROSS_PROJECT_DIAGNOSTIC_REVISION = 1;
export const CROSS_PROJECT_DIAGNOSTIC_OUTCOMES = Object.freeze([
  "FRONTEND",
  "BACKEND",
  "BOTH",
  "CONTRACT",
  "INFRASTRUCTURE",
  "COMPATIBLE",
  "UNDETERMINED",
]);

const CONFIDENCES = new Set(["LOW", "MEDIUM", "HIGH"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clean(value, maxCharacters = 1200) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.slice(0, maxCharacters);
}

function uniqueStrings(value) {
  return Array.isArray(value)
    && value.every((item) => nonEmpty(item))
    && new Set(value).size === value.length;
}

function errorWithCode(message, code, details = {}) {
  const error = new Error(message);
  error.name = "CrossProjectDiagnosticError";
  error.code = code;
  error.details = { code, ...details };
  return error;
}

function unexpectedKeys(record, allowed, label) {
  if (!isRecord(record)) return [];
  return Object.keys(record).filter((key) => !allowed.has(key)).map((key) => `${label} contains unsupported field: ${key}`);
}

function sortedProjectIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))].sort();
}

export function crossProjectDiagnosticSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion", "diagnosticId", "objectiveId", "outcome", "summary", "evidence",
      "implicatedProjects", "confidence", "clarificationNeeded", "clarificationQuestion", "readOnly",
    ],
    properties: {
      schemaVersion: { const: 1 },
      diagnosticId: { type: "string", minLength: 1 },
      objectiveId: { type: "string", minLength: 1 },
      outcome: { enum: CROSS_PROJECT_DIAGNOSTIC_OUTCOMES },
      summary: { type: "string", minLength: 1 },
      evidence: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["evidenceId", "projectId", "source", "reproduction", "observation", "expected", "actual"],
          properties: {
            evidenceId: { type: "string", minLength: 1 },
            projectId: { type: "string", minLength: 1 },
            source: { type: "string", minLength: 1 },
            reproduction: { type: "string", minLength: 1 },
            observation: { type: "string", minLength: 1 },
            expected: { type: "string", minLength: 1 },
            actual: { type: "string", minLength: 1 },
          },
        },
      },
      implicatedProjects: { type: "array", minItems: 0, uniqueItems: true, items: { type: "string", minLength: 1 } },
      confidence: { enum: [...CONFIDENCES] },
      clarificationNeeded: { type: "boolean" },
      clarificationQuestion: { type: ["string", "null"] },
      readOnly: { const: true },
    },
  };
}

function unwrapProviderEnvelope(value) {
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (isRecord(value.structured_output)) return value.structured_output;
  if (keys.length === 2 && value.event === "result" && isRecord(value.result)) return value.result;
  if (Object.hasOwn(value, "response")) {
    if (String(value.status ?? "").toUpperCase() === "ERROR" || value.error) {
      throw errorWithCode(`Cross-project diagnostic provider melaporkan error: ${clean(value.error ?? value.status, 600)}`, "PROVIDER_FAILED");
    }
    if (isRecord(value.response)) return value.response;
    if (typeof value.response === "string") {
      try {
        const response = JSON.parse(value.response.trim());
        if (isRecord(response)) return response;
      } catch {
        throw errorWithCode("Cross-project diagnostic provider response harus satu dokumen JSON tanpa prose.", "INVALID_CROSS_PROJECT_DIAGNOSTIC");
      }
    }
  }
  return value;
}

export function parseCrossProjectDiagnosticResult(result) {
  const stdout = typeof result?.stdoutTail === "string" ? result.stdoutTail.trim() : "";
  let payload = result?.finalResult;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw errorWithCode("Cross-project diagnostic provider output harus satu dokumen JSON tanpa prose.", "INVALID_CROSS_PROJECT_DIAGNOSTIC");
    }
  }
  payload = unwrapProviderEnvelope(payload);
  if (!isRecord(payload)) throw errorWithCode("Cross-project diagnostic provider tidak menghasilkan object JSON.", "INVALID_CROSS_PROJECT_DIAGNOSTIC");
  return payload;
}

export function validateCrossProjectDiagnostic(diagnostic, objective) {
  const errors = [];
  const projectIds = new Set(sortedProjectIds(objective?.projectIds));
  errors.push(...unexpectedKeys(diagnostic, new Set([
    "schemaVersion", "diagnosticId", "objectiveId", "outcome", "summary", "evidence",
    "implicatedProjects", "confidence", "clarificationNeeded", "clarificationQuestion", "readOnly",
  ]), "diagnostic"));
  if (!isRecord(diagnostic)) return [...new Set(["diagnostic must be an object", ...errors])];
  if (diagnostic.schemaVersion !== 1) errors.push("diagnostic.schemaVersion harus 1");
  const expectedObjectiveId = String(objective?.objectiveId ?? "").trim();
  if (diagnostic.diagnosticId !== `diagnostic-${expectedObjectiveId}-r${CROSS_PROJECT_DIAGNOSTIC_REVISION}`) errors.push("diagnostic.diagnosticId tidak sesuai dengan objective revision 1");
  if (diagnostic.objectiveId !== expectedObjectiveId) errors.push("diagnostic.objectiveId tidak sesuai dengan objective");
  if (!CROSS_PROJECT_DIAGNOSTIC_OUTCOMES.includes(diagnostic.outcome)) errors.push(`diagnostic.outcome unsupported: ${diagnostic.outcome}`);
  if (!nonEmpty(diagnostic.summary)) errors.push("diagnostic.summary wajib diisi");
  if (!Array.isArray(diagnostic.evidence) || diagnostic.evidence.length === 0) {
    errors.push("diagnostic.evidence wajib memuat bukti reproduktif");
  } else {
    const evidenceIds = new Set();
    for (const [index, evidence] of diagnostic.evidence.entries()) {
      const label = `diagnostic.evidence[${index}]`;
      errors.push(...unexpectedKeys(evidence, new Set(["evidenceId", "projectId", "source", "reproduction", "observation", "expected", "actual"]), label));
      if (!isRecord(evidence)) {
        errors.push(`${label} harus berupa object`);
        continue;
      }
      for (const field of ["evidenceId", "projectId", "source", "reproduction", "observation", "expected", "actual"]) {
        if (!nonEmpty(evidence[field])) errors.push(`${label}.${field} wajib diisi`);
      }
      if (evidenceIds.has(evidence.evidenceId)) errors.push(`${label}.evidenceId duplikat`);
      evidenceIds.add(evidence.evidenceId);
      if (nonEmpty(evidence.projectId) && !projectIds.has(evidence.projectId)) errors.push(`${label}.projectId tidak terdaftar: ${evidence.projectId}`);
    }
  }
  if (!uniqueStrings(diagnostic.implicatedProjects)) errors.push("diagnostic.implicatedProjects harus unique string array");
  for (const projectId of diagnostic.implicatedProjects ?? []) {
    if (!projectIds.has(projectId)) errors.push(`diagnostic.implicatedProjects tidak terdaftar: ${projectId}`);
  }
  if (!CONFIDENCES.has(diagnostic.confidence)) errors.push(`diagnostic.confidence unsupported: ${diagnostic.confidence}`);
  if (diagnostic.readOnly !== true) errors.push("diagnostic.readOnly harus true");
  if (diagnostic.outcome === "UNDETERMINED") {
    if (diagnostic.clarificationNeeded !== true) errors.push("UNDETERMINED wajib meminta clarification/investigation");
    if (!nonEmpty(diagnostic.clarificationQuestion)) errors.push("UNDETERMINED wajib memiliki clarificationQuestion");
    if ((diagnostic.implicatedProjects ?? []).length > 0) errors.push("UNDETERMINED tidak boleh membuat project terimplikasi");
  } else if (diagnostic.outcome === "COMPATIBLE") {
    if (diagnostic.clarificationNeeded !== false) errors.push("COMPATIBLE tidak boleh meminta clarification");
    if (diagnostic.clarificationQuestion !== null) errors.push("clarificationQuestion harus null untuk COMPATIBLE");
    if ((diagnostic.implicatedProjects ?? []).length > 0) errors.push("COMPATIBLE tidak boleh membuat project terimplikasi");
  } else {
    if (diagnostic.clarificationNeeded !== false) errors.push("diagnosis terdeterminasi tidak boleh meminta clarification");
    if (diagnostic.clarificationQuestion !== null) errors.push("clarificationQuestion harus null untuk diagnosis terdeterminasi");
    if ((diagnostic.implicatedProjects ?? []).length === 0) errors.push("diagnosis terdeterminasi wajib memiliki implicatedProjects");
  }
  return [...new Set(errors)];
}

function boundedProjectContexts(projectContexts = []) {
  return (Array.isArray(projectContexts) ? projectContexts : []).slice(0, 8).map((project) => ({
    projectId: clean(project?.projectId ?? project?.id, 160),
    role: clean(project?.role ?? project?.type, 80),
    repository: clean(project?.repository, 240),
    summary: clean(project?.summary ?? project?.context ?? project?.architecture, 1400),
    verification: (Array.isArray(project?.verification) ? project.verification : Array.isArray(project?.verificationScripts) ? project.verificationScripts : [])
      .map((item) => clean(item, 120)).filter(Boolean).slice(0, 12),
  }));
}

export function buildCrossProjectDiagnosticContext({ objective, projectContexts = [], relationshipContext = "", graphifyContext = "", knowledge = [], budgets = {} } = {}) {
  return buildStageContext({
    stage: CROSS_PROJECT_DIAGNOSTIC_STAGE,
    acceptanceCriteria: [
      "Classify the result as FRONTEND, BACKEND, BOTH, CONTRACT, INFRASTRUCTURE, COMPATIBLE, or UNDETERMINED.",
      "Every diagnosis must cite evidence that another operator can reproduce without editing either repository.",
      "Keep implicatedProjects limited to repositories supported by the evidence.",
    ],
    latestFeedback: clean(objective?.request, 5000),
    revisionState: {
      objective: JSON.stringify({ objectiveId: objective?.objectiveId ?? null, mode: objective?.mode ?? null, projectIds: objective?.projectIds ?? [] }),
      projects: JSON.stringify(boundedProjectContexts(projectContexts)),
      relationships: clean(relationshipContext, 1600),
      graphify: clean(graphifyContext, 1200),
    },
    knowledge,
    budgets,
  });
}

/**
 * Run a bounded, read-only cross-project diagnosis. Repository paths are only
 * supplied as provider cwd; this phase never grants write tools or mutates a
 * repository. Runtime event evidence may be written outside the repositories.
 */
export async function diagnoseCrossProject({
  objective,
  projectContexts = [],
  relationshipContext = "",
  graphifyContext = "",
  knowledge = [],
  runsRoot = null,
  processRunner = runProcess,
  now = new Date(),
  env = process.env,
  contextBudgets = {},
} = {}) {
  if (!isRecord(objective) || !nonEmpty(objective.objectiveId) || !nonEmpty(objective.request)) {
    throw errorWithCode("Cross-project diagnostic membutuhkan objectiveId dan request.", "INVALID_OBJECTIVE");
  }
  if (String(objective.mode ?? "").toUpperCase() !== "CROSS_PROJECT_INCIDENT") {
    throw errorWithCode("Cross-project diagnostic hanya tersedia untuk CROSS_PROJECT_INCIDENT.", "INVALID_DIAGNOSTIC_MODE");
  }
  const complexity = String(objective.complexity ?? "MEDIUM").toUpperCase();
  const risk = String(objective.risk ?? "MEDIUM").toUpperCase();
  const route = resolveAgentRoute({ stage: CROSS_PROJECT_DIAGNOSTIC_STAGE, risk, complexity });
  const agentConfig = resolveAgyConfig(env, CROSS_PROJECT_DIAGNOSTIC_STAGE, { risk, complexity });
  const context = buildCrossProjectDiagnosticContext({ objective, projectContexts, relationshipContext, graphifyContext, knowledge, budgets: contextBudgets });
  const invocationId = `diagnostic-${objective.objectiveId}-r${CROSS_PROJECT_DIAGNOSTIC_REVISION}`;
  const diagnosticId = invocationId;
  const eventLogPath = runsRoot ? path.join(runsRoot, "events", `${invocationId}.jsonl`) : undefined;
  const prompt = [
    "=== READ-ONLY CROSS-PROJECT DIAGNOSTIC ===",
    "You are a diagnostic-only provider. Do not edit files, run mutating commands, create tasks, enqueue jobs, execute agents, approve a plan, or invent human identities.",
    "Tool use is forbidden in this phase, including file search, repository inspection, and shell commands. Use only the bounded context below.",
    "Do not execute verification scripts; only record configured verification names supplied in context. If endpoint-level evidence is absent, return UNDETERMINED and request the smallest concrete evidence needed.",
    "Use only reproducible observations from the bounded context. Return exactly one JSON object matching the supplied schema, without Markdown or prose.",
    `The diagnosticId must be ${diagnosticId}; objectiveId must be ${objective.objectiveId}; readOnly must be true.`,
    "Evidence.reproduction must describe a repeatable command or observable sequence and evidence.actual must be concrete.",
    "Use UNDETERMINED when evidence does not distinguish the implicated layer; set clarificationNeeded=true and ask for the smallest useful investigation.",
    "For UNDETERMINED, implicatedProjects must be an empty array. Do not implicate a project without evidence that distinguishes its layer.",
    "Use COMPATIBLE only when reproducible evidence shows the compared contract assumptions align and no repair is required. For COMPATIBLE, implicatedProjects must be [], clarificationNeeded must be false, and clarificationQuestion must be null.",
    `The only allowed project IDs are: ${JSON.stringify(sortedProjectIds(objective.projectIds))}.`,
    "",
    "=== BOUNDED DIAGNOSTIC CONTEXT ===",
    context.text,
    "",
    "=== OUTPUT SCHEMA ===",
    JSON.stringify(crossProjectDiagnosticSchema()),
  ].join("\n");
  const repository = projectContexts.find((project) => nonEmpty(project?.repository))?.repository || process.cwd();
  const result = await processRunner({
    command: "agy",
    args: [
      "-p", prompt,
      "--output-format", "json",
      "--json-schema", JSON.stringify(crossProjectDiagnosticSchema()),
      ...agyConfigArgs(agentConfig),
      "--mode", "plan",
      "--print-timeout", "10m",
    ],
    cwd: repository,
    stage: CROSS_PROJECT_DIAGNOSTIC_STAGE,
    capabilityProfile: "diagnostic",
    writableRoots: [],
    readableRoots: projectContexts.map((project) => project?.repository).filter(nonEmpty),
    eventLogPath,
    readOnly: true,
    now,
  });
  if (result?.exitCode !== 0) throw errorWithCode(`Cross-project diagnostic provider gagal dengan exit code ${result?.exitCode ?? "unknown"}.`, "PROVIDER_FAILED");
  const parsed = parseCrossProjectDiagnosticResult(result);
  const errors = validateCrossProjectDiagnostic(parsed, objective);
  if (errors.length) throw errorWithCode(`Cross-project diagnostic invalid: ${errors.join("; ")}`, "INVALID_CROSS_PROJECT_DIAGNOSTIC", { validation: errors });
  const metadata = {
    agentConfig,
    route,
    invocationId,
    context: { stage: context.stage, budgetTokens: context.budgetTokens, estimatedTokens: context.estimatedTokens },
  };
  if (parsed.outcome === "UNDETERMINED") {
    return {
      status: "NEEDS_CLARIFICATION",
      objectiveState: "NEEDS_CLARIFICATION",
      diagnosis: parsed,
      clarificationNeeded: true,
      clarificationQuestion: parsed.clarificationQuestion,
      readOnly: true,
      planning: { started: true, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
      ...metadata,
    };
  }
  return {
    status: "DIAGNOSIS_READY",
    objectiveState: "PLANNING",
    diagnosis: parsed,
    clarificationNeeded: false,
    clarificationQuestion: null,
    readOnly: true,
    planning: { started: true, readOnly: true, tasksCreated: 0, jobsCreated: 0, runsCreated: 0 },
    ...metadata,
  };
}

function nodeText(node) {
  return [node?.title, node?.purpose, ...(Array.isArray(node?.acceptanceCriteria) ? node.acceptanceCriteria : []), ...(Array.isArray(node?.verification) ? node.verification : [])]
    .map((value) => String(value ?? "").toLowerCase()).join(" ");
}

/** Validate that a model plan respects the diagnosis-to-project boundary. */
export function validateCrossProjectPlan(plan, diagnosis, objective) {
  const errors = [];
  if (!diagnosis || String(objective?.mode ?? "").toUpperCase() !== "CROSS_PROJECT_INCIDENT") return errors;
  const implicated = new Set(diagnosis.implicatedProjects ?? []);
  const implementationNodes = (plan?.nodes ?? []).filter((node) => node?.type === "IMPLEMENTATION");
  for (const node of implementationNodes) {
    if (!implicated.has(node.projectId)) errors.push(`implementation node ${node.nodeId} targets project outside diagnosis: ${node.projectId}`);
  }
  if (diagnosis.outcome === "BOTH" && implicated.size >= 2) {
    for (const projectId of implicated) {
      if (!implementationNodes.some((node) => node.projectId === projectId)) errors.push(`BOTH diagnosis requires an implementation node for ${projectId}`);
    }
  }
  if (diagnosis.outcome === "CONTRACT") {
    if (implicated.size < 2) errors.push("CONTRACT diagnosis requires at least two implicated projects");
    if (!implementationNodes.some((node) => node.role === "FRONTEND" && implicated.has(node.projectId))) errors.push("CONTRACT diagnosis requires a coordinated FRONTEND implementation node");
    if (!implementationNodes.some((node) => node.role === "BACKEND" && implicated.has(node.projectId))) errors.push("CONTRACT diagnosis requires a coordinated BACKEND implementation node");
    if (!(plan?.nodes ?? []).some((node) => node.type === "VERIFICATION" && (node.role === "INTEGRATION" || node.role === "TESTING") && /contract/.test(nodeText(node)))) {
      errors.push("CONTRACT diagnosis requires a contract verification node");
    }
  }
  if (diagnosis.outcome === "COMPATIBLE") {
    if (implementationNodes.length > 0) errors.push("COMPATIBLE diagnosis cannot create implementation nodes");
    for (const node of plan?.nodes ?? []) {
      if (node.requiresChanges !== false) errors.push(`COMPATIBLE node ${node.nodeId} must be read-only`);
      if ((node.allowedPaths ?? []).length > 0) errors.push(`COMPATIBLE node ${node.nodeId} cannot declare write paths`);
    }
    if (!(plan?.nodes ?? []).some((node) => node.type === "VERIFICATION" || node.type === "DIAGNOSTIC")) {
      errors.push("COMPATIBLE diagnosis requires at least one read-only diagnostic or verification node");
    }
  }
  return [...new Set(errors)];
}
