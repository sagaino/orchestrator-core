const CURRENT_SCHEMA_VERSION = 1;

const OBJECTIVE_MODES = new Set(["FRESH_PROJECT", "EXISTING_PROJECT", "CROSS_PROJECT_INCIDENT"]);
const OBJECTIVE_STATES = new Set([
  "DRAFT", "GENESIS_REVIEW", "ONBOARDING", "PLANNING", "NEEDS_CLARIFICATION",
  "PLAN_REVIEW", "APPROVED", "MATERIALIZING", "RUNNING", "INTEGRATING",
  "BLOCKED", "RESULT_REVIEW", "DONE", "FAILED", "CANCELLED",
]);
const PLAN_STATES = new Set(["PENDING_APPROVAL", "APPROVED", "SUPERSEDED", "CANCELLED"]);
const ORCHESTRATION_STATES = new Set(["CREATED", "RUNNING", "INTEGRATING", "BLOCKED", "DONE", "FAILED", "CANCELLED"]);
const NODE_STATES = new Set(["BLOCKED", "READY", "QUEUED", "RUNNING", "REVIEW", "DONE", "FAILED", "CANCELLED"]);
const ROLES = new Set(["PLANNER", "DIAGNOSTIC", "FRONTEND", "BACKEND", "DATABASE", "INTEGRATION", "TESTING", "REVIEW", "GENERAL"]);
const NODE_TYPES = new Set(["DIAGNOSTIC", "IMPLEMENTATION", "INTEGRATION", "VERIFICATION"]);
const RISKS = new Set(["LOW", "MEDIUM", "HIGH"]);
const COMPLEXITIES = new Set(["LOW", "MEDIUM", "HIGH"]);
const DECISION_TYPES = new Set([
  "FRESH_PROJECT_CREATION", "PLAN_APPROVAL", "PLAN_CLARIFICATION", "NODE_RETRY",
  "SCOPE_EXPANSION", "INTEGRATION_CONFLICT", "HIGH_RISK_CHANGE", "OBJECTIVE_ACCEPTANCE",
  "BUDGET_EXCEEDED", "SKILL_ASSIGNMENT",
]);
const DECISION_STATES = new Set(["OPEN", "RESOLVED", "CANCELLED"]);
const RISK_ORDER = new Map([["LOW", 1], ["MEDIUM", 2], ["HIGH", 3]]);

function result(errors) {
  const normalized = [...new Set(errors.map(String))];
  return {
    valid: normalized.length === 0,
    errors: normalized,
    issues: normalized.map((message) => ({ message })),
  };
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function identifier(value) {
  return nonEmptyString(value) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isoDate(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function uniqueStrings(value) {
  return Array.isArray(value)
    && value.every((item) => nonEmptyString(item))
    && new Set(value).size === value.length;
}

function validateVersion(record, label, errors) {
  add(errors, isRecord(record), `${label} must be a non-null object`);
  if (!isRecord(record)) return;
  add(errors, record.schemaVersion === CURRENT_SCHEMA_VERSION, `${label}.schemaVersion must be ${CURRENT_SCHEMA_VERSION}`);
  add(errors, nonNegativeInteger(record.revision), `${label}.revision must be a non-negative integer`);
}

function validateCommonIdentity(record, label, errors) {
  add(errors, identifier(record[`${label}Id`]), `${label}.${label}Id must be a stable identifier`);
}

function validateTimestamps(record, label, errors) {
  add(errors, isoDate(record.createdAt), `${label}.createdAt must be an ISO timestamp`);
  add(errors, isoDate(record.updatedAt ?? record.createdAt), `${label}.updatedAt must be an ISO timestamp`);
}

function validateBudget(budget, label, errors) {
  add(errors, isRecord(budget), `${label} must be an object`);
  if (!isRecord(budget)) return;
  for (const field of ["maxSubtasks", "maxParallelAgents", "maxRetriesPerNode"]) {
    add(errors, positiveInteger(budget[field]), `${label}.${field} must be a positive integer`);
  }
  if (budget.maxRepairCycles !== undefined) {
    add(errors, positiveInteger(budget.maxRepairCycles), `${label}.maxRepairCycles must be a positive integer`);
  }
  if (budget.maxTotalTokens !== null && budget.maxTotalTokens !== undefined) {
    add(errors, positiveInteger(budget.maxTotalTokens), `${label}.maxTotalTokens must be null or a positive integer`);
  }
  if (budget.deadlineAt !== null && budget.deadlineAt !== undefined) {
    add(errors, isoDate(budget.deadlineAt), `${label}.deadlineAt must be null or an ISO timestamp`);
  }
}

export function validateObjectiveRecord(objective) {
  const errors = [];
  validateVersion(objective, "objective", errors);
  if (!isRecord(objective)) return result(errors);

  add(errors, identifier(objective.objectiveId), "objective.objectiveId must be a stable identifier");
  add(errors, OBJECTIVE_MODES.has(objective.mode), `objective.mode is unsupported: ${objective.mode}`);
  add(errors, OBJECTIVE_STATES.has(objective.state), `objective.state is unsupported: ${objective.state}`);
  add(errors, nonEmptyString(objective.request), "objective.request must be a non-empty string");
  add(errors, nonEmptyString(objective.requestedBy), "objective.requestedBy must be a non-empty string");
  add(errors, uniqueStrings(objective.projectIds) && objective.projectIds.length > 0, "objective.projectIds must be a non-empty unique string array");
  add(errors, objective.freshProject === null || isRecord(objective.freshProject), "objective.freshProject must be null or an object");
  if (isRecord(objective.freshProject)) {
    add(errors, identifier(objective.freshProject.projectId), "objective.freshProject.projectId must be a stable identifier");
    add(errors, typeof objective.freshProject.targetDirectory === "string" && objective.freshProject.targetDirectory.length > 0, "objective.freshProject.targetDirectory must be non-empty");
    add(errors, objective.freshProject.blueprint === "frontend-vite", "objective.freshProject.blueprint is unsupported");
  }
  add(errors, objective.attachments === undefined || Array.isArray(objective.attachments), "objective.attachments must be an array");
  for (const [index, attachment] of (objective.attachments ?? []).entries()) {
    add(errors, isRecord(attachment), `objective.attachments[${index}] must be an object`);
    if (!isRecord(attachment)) continue;
    add(errors, ["MOCKUP", "PROJECT_ASSET"].includes(attachment.type), `objective.attachments[${index}].type is unsupported`);
    add(errors, nonEmptyString(attachment.fileName), `objective.attachments[${index}].fileName must be non-empty`);
    add(errors, attachment.relativeVaultPath === null || attachment.relativeVaultPath === undefined || nonEmptyString(attachment.relativeVaultPath), `objective.attachments[${index}].relativeVaultPath must be null or non-empty`);
    add(errors, attachment.relativeProjectPath === null || attachment.relativeProjectPath === undefined || nonEmptyString(attachment.relativeProjectPath), `objective.attachments[${index}].relativeProjectPath must be null or non-empty`);
    add(errors, attachment.sizeBytes === null || attachment.sizeBytes === undefined || nonNegativeInteger(attachment.sizeBytes), `objective.attachments[${index}].sizeBytes must be null or non-negative`);
  }
  if (objective.planning !== undefined) {
    add(errors, isRecord(objective.planning), "objective.planning must be an object");
    if (isRecord(objective.planning)) {
      add(errors, objective.planning.status === "NEEDS_CLARIFICATION", "objective.planning.status is unsupported");
      add(errors, nonEmptyString(objective.planning.clarificationQuestion), "objective.planning.clarificationQuestion must be non-empty");
      add(errors, isoDate(objective.planning.requestedAt), "objective.planning.requestedAt must be an ISO timestamp");
    }
  }
  add(errors, objective.activePlanId === null || identifier(objective.activePlanId), "objective.activePlanId must be null or a stable identifier");
  add(errors, objective.activeOrchestrationId === null || identifier(objective.activeOrchestrationId), "objective.activeOrchestrationId must be null or a stable identifier");
  if (objective.intakeFingerprint !== undefined) {
    add(errors, typeof objective.intakeFingerprint === "string" && /^[a-f0-9]{64}$/.test(objective.intakeFingerprint), "objective.intakeFingerprint must be a SHA-256 hex string");
  }
  validateBudget(objective.budget, "objective.budget", errors);
  add(errors, isoDate(objective.createdAt), "objective.createdAt must be an ISO timestamp");
  add(errors, isoDate(objective.updatedAt), "objective.updatedAt must be an ISO timestamp");
  return result(errors);
}

function safeRelativePath(value) {
  if (!nonEmptyString(value) || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function pathBase(value) {
  const wildcardIndex = value.search(/[?*[]/);
  const base = wildcardIndex === -1 ? value : value.slice(0, wildcardIndex);
  return base.replace(/\/+$/, "");
}

function pathsOverlap(left, right) {
  const a = pathBase(left);
  const b = pathBase(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function verificationScriptsFor(options, projectId) {
  const source = options.projectVerificationScripts ?? options.verificationScripts;
  if (!source || source[projectId] === undefined) return null;
  const scripts = source[projectId];
  if (Array.isArray(scripts)) return new Set(scripts.map(String));
  if (scripts instanceof Set) return new Set([...scripts].map(String));
  if (isRecord(scripts)) return new Set(Object.entries(scripts).filter(([, enabled]) => enabled).map(([name]) => name));
  return new Set();
}

function knownProjectsFor(options) {
  const source = options.knownProjectIds ?? options.projectIds ?? options.projects;
  if (!source) return null;
  if (Array.isArray(source)) return new Set(source.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean));
  if (source instanceof Set) return new Set(source);
  if (isRecord(source)) return new Set(Object.keys(source));
  return new Set();
}

function validateNode(node, index, plan, options, errors) {
  const label = `plan.nodes[${index}]`;
  add(errors, isRecord(node), `${label} must be an object`);
  if (!isRecord(node)) return;
  add(errors, identifier(node.nodeId), `${label}.nodeId must be a stable identifier`);
  add(errors, nonEmptyString(node.title), `${label}.title must be non-empty`);
  add(errors, nonEmptyString(node.purpose), `${label}.purpose must be non-empty`);
  add(errors, identifier(node.projectId), `${label}.projectId must be a stable identifier`);
  add(errors, ROLES.has(node.role), `${label}.role is unsupported: ${node.role}`);
  add(errors, NODE_TYPES.has(node.type), `${label}.type is unsupported: ${node.type}`);
  add(errors, Array.isArray(node.dependsOn) && node.dependsOn.every(identifier), `${label}.dependsOn must be an array of stable identifiers`);
  add(errors, uniqueStrings(node.acceptanceCriteria) && node.acceptanceCriteria.length > 0, `${label}.acceptanceCriteria must be a non-empty unique string array`);
  add(errors, Array.isArray(node.allowedPaths) && node.allowedPaths.every(safeRelativePath), `${label}.allowedPaths contains an unsafe relative path`);
  add(errors, Array.isArray(node.verification) && node.verification.every(nonEmptyString) && node.verification.length > 0, `${label}.verification must be a non-empty string array`);
  add(errors, RISKS.has(node.risk), `${label}.risk is unsupported: ${node.risk}`);
  add(errors, COMPLEXITIES.has(node.complexity), `${label}.complexity is unsupported: ${node.complexity}`);
  add(errors, typeof node.requiresChanges === "boolean", `${label}.requiresChanges must be boolean`);
  add(errors, typeof node.canRunInParallel === "boolean", `${label}.canRunInParallel must be boolean`);
  add(errors, node.writeConflictGroup === null || node.writeConflictGroup === undefined || nonEmptyString(node.writeConflictGroup), `${label}.writeConflictGroup must be null or non-empty`);
  add(errors, Array.isArray(node.contextFrom) && node.contextFrom.every(identifier), `${label}.contextFrom must be an array of stable identifiers`);
  add(errors, Array.isArray(node.skills), `${label}.skills must be an array`);
  if (Array.isArray(node.skills)) {
    const skillIdentities = new Set();
    for (const assignment of node.skills) {
      add(errors, isRecord(assignment), `${label}.skills entries must be objects`);
      if (!isRecord(assignment)) continue;
      add(errors, nonEmptyString(assignment.skillId) && /^[a-z0-9][a-z0-9._-]{1,127}$/.test(assignment.skillId), `${label}.skills.skillId must be a stable lowercase identifier`);
      add(errors, nonEmptyString(assignment.version) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(assignment.version), `${label}.skills.version must be valid semver`);
      add(errors, typeof assignment.checksum === "string" && /^[a-f0-9]{64}$/.test(assignment.checksum), `${label}.skills.checksum must be a lowercase SHA-256 checksum`);
      const identity = `${assignment.skillId ?? ""}@${assignment.version ?? ""}`;
      if (skillIdentities.has(identity)) errors.push(`${label}.skills contains duplicate assignment: ${identity}`);
      skillIdentities.add(identity);
    }
  }

  const knownProjects = knownProjectsFor(options);
  if (knownProjects && !knownProjects.has(node.projectId)) errors.push(`${label}.projectId is unknown: ${node.projectId}`);
  if (Array.isArray(plan.projects) && !plan.projects.includes(node.projectId)) errors.push(`${label}.projectId is not listed in plan.projects`);
  if (Array.isArray(node.allowedPaths) && node.allowedPaths.some((value) => !safeRelativePath(value))) errors.push(`${label}.allowedPaths must not be absolute or traversal paths`);
  if (node.type === "DIAGNOSTIC" && (node.requiresChanges || node.allowedPaths.length > 0)) errors.push(`${label}: diagnostic nodes cannot request writes`);
  if (node.type === "VERIFICATION" && (node.requiresChanges || node.allowedPaths.length > 0)) errors.push(`${label}: verification nodes cannot request product-code writes`);
  if (node.type === "IMPLEMENTATION" && node.allowedPaths.length === 0) errors.push(`${label}: implementation nodes require allowedPaths`);
  if (node.type === "IMPLEMENTATION" && node.requiresChanges !== true) errors.push(`${label}: implementation nodes must require changes`);

  const scripts = verificationScriptsFor(options, node.projectId);
  if (scripts) {
    for (const script of node.verification) {
      if (!scripts.has(script)) errors.push(`${label}.verification references unsupported script: ${script}`);
    }
  }
  const maxRisk = options.maxRisk ?? options.riskCeiling;
  if (maxRisk && RISK_ORDER.get(node.risk) > RISK_ORDER.get(maxRisk)) errors.push(`${label}.risk exceeds approved ceiling: ${node.risk} > ${maxRisk}`);
}

export function validatePlanRecord(plan, options = {}) {
  const errors = [];
  validateVersion(plan, "plan", errors);
  if (!isRecord(plan)) return result(errors);

  add(errors, identifier(plan.planId), "plan.planId must be a stable identifier");
  add(errors, identifier(plan.objectiveId), "plan.objectiveId must be a stable identifier");
  add(errors, nonNegativeInteger(plan.revision) && plan.revision > 0, "plan.revision must be a positive integer");
  add(errors, PLAN_STATES.has(plan.state), `plan.state is unsupported: ${plan.state}`);
  add(errors, nonEmptyString(plan.summary), "plan.summary must be non-empty");
  add(errors, Array.isArray(plan.architectureDecisions), "plan.architectureDecisions must be an array");
  add(errors, Array.isArray(plan.assumptions), "plan.assumptions must be an array");
  add(errors, typeof plan.clarificationNeeded === "boolean", "plan.clarificationNeeded must be boolean");
  add(errors, plan.clarificationQuestion === null || nonEmptyString(plan.clarificationQuestion), "plan.clarificationQuestion must be null or non-empty");
  if (plan.clarificationNeeded) add(errors, nonEmptyString(plan.clarificationQuestion), "plan.clarificationQuestion is required when clarificationNeeded is true");
  add(errors, uniqueStrings(plan.projects) && plan.projects.length > 0, "plan.projects must be a non-empty unique string array");
  add(errors, Array.isArray(plan.nodes) && plan.nodes.length > 0, "plan.nodes must be a non-empty array");
  add(errors, isRecord(plan.integration), "plan.integration must be an object");
  if (isRecord(plan.integration)) {
    add(errors, typeof plan.integration.required === "boolean", "plan.integration.required must be boolean");
    add(errors, Array.isArray(plan.integration.projectVerification), "plan.integration.projectVerification must be an array");
    add(errors, Array.isArray(plan.integration.crossProjectVerification), "plan.integration.crossProjectVerification must be an array");
    add(errors, typeof plan.integration.previewRequired === "boolean", "plan.integration.previewRequired must be boolean");
  }
  add(errors, RISKS.has(plan.risk), `plan.risk is unsupported: ${plan.risk}`);
  add(errors, COMPLEXITIES.has(plan.complexity), `plan.complexity is unsupported: ${plan.complexity}`);
  add(errors, plan.approvedBy === null || nonEmptyString(plan.approvedBy), "plan.approvedBy must be null or non-empty");
  add(errors, plan.approvedAt === null || isoDate(plan.approvedAt), "plan.approvedAt must be null or an ISO timestamp");
  add(errors, isoDate(plan.createdAt), "plan.createdAt must be an ISO timestamp");

  const knownProjects = knownProjectsFor(options);
  if (knownProjects) for (const projectId of plan.projects ?? []) {
    if (!knownProjects.has(projectId)) errors.push(`plan.projects contains unknown project: ${projectId}`);
  }
  const nodeIds = new Set();
  for (const [index, node] of (Array.isArray(plan.nodes) ? plan.nodes : []).entries()) {
    validateNode(node, index, plan, options, errors);
    if (isRecord(node)) {
      if (nodeIds.has(node.nodeId)) errors.push(`plan.nodes contains duplicate nodeId: ${node.nodeId}`);
      nodeIds.add(node.nodeId);
    }
  }
  for (const [index, node] of (Array.isArray(plan.nodes) ? plan.nodes : []).entries()) {
    if (!isRecord(node) || !Array.isArray(node.dependsOn)) continue;
    for (const dependency of node.dependsOn) {
      if (!nodeIds.has(dependency)) errors.push(`plan.nodes[${index}].dependsOn references unknown node: ${dependency}`);
      if (dependency === node.nodeId) errors.push(`plan.nodes[${index}].dependsOn cannot reference itself: ${dependency}`);
    }
    for (const contextNode of node.contextFrom ?? []) {
      if (!nodeIds.has(contextNode)) errors.push(`plan.nodes[${index}].contextFrom references unknown node: ${contextNode}`);
    }
  }

  const nodes = (plan.nodes ?? []).filter((node) => isRecord(node) && identifier(node.nodeId) && Array.isArray(node.dependsOn) && node.dependsOn.every((dependency) => nodeIds.has(dependency)));
  const visiting = new Set();
  const visited = new Set();
  const cycle = [];
  const visit = (node) => {
    if (visiting.has(node.nodeId)) {
      cycle.push(node.nodeId);
      return true;
    }
    if (visited.has(node.nodeId)) return false;
    visiting.add(node.nodeId);
    for (const dependency of node.dependsOn) {
      const dependencyNode = nodeIds.has(dependency) ? nodes.find((candidate) => candidate.nodeId === dependency) : null;
      if (dependencyNode && visit(dependencyNode)) {
        if (cycle[0] !== node.nodeId) cycle.push(node.nodeId);
        return true;
      }
    }
    visiting.delete(node.nodeId);
    visited.add(node.nodeId);
    return false;
  };
  for (const node of nodes) if (visit(node)) break;
  if (cycle.length) errors.push(`plan.nodes contains a dependency cycle: ${cycle.reverse().join(" -> ")}`);

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (!left.canRunInParallel || !right.canRunInParallel || left.projectId !== right.projectId) continue;
      const sameConflictGroup = left.writeConflictGroup && right.writeConflictGroup && left.writeConflictGroup === right.writeConflictGroup;
      const overlappingPaths = left.allowedPaths.some((leftPath) => right.allowedPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)));
      if (sameConflictGroup || overlappingPaths) errors.push(`parallel nodes ${left.nodeId} and ${right.nodeId} have a write conflict`);
    }
  }

  const maxSubtasks = options.maxSubtasks ?? options.budget?.maxSubtasks;
  if (maxSubtasks !== undefined && Array.isArray(plan.nodes) && plan.nodes.length > maxSubtasks) errors.push(`plan.nodes exceeds maxSubtasks: ${plan.nodes.length} > ${maxSubtasks}`);
  // maxParallelAgents is an execution ceiling, not a DAG shape limit. A plan
  // may contain more independent nodes than available workers; the scheduler
  // batches eligible nodes and keeps the remainder queued.
  const maxRisk = options.maxRisk ?? options.riskCeiling;
  if (maxRisk && RISK_ORDER.get(plan.risk) > RISK_ORDER.get(maxRisk)) errors.push(`plan.risk exceeds approved ceiling: ${plan.risk} > ${maxRisk}`);
  if (plan.estimatedTokens !== undefined) {
    add(errors, Number.isInteger(plan.estimatedTokens) && plan.estimatedTokens >= 0, "plan.estimatedTokens must be a non-negative integer");
    const maxTotalTokens = options.maxTotalTokens ?? options.budget?.maxTotalTokens;
    if (maxTotalTokens !== undefined && plan.estimatedTokens > maxTotalTokens) errors.push(`plan.estimatedTokens exceeds maxTotalTokens: ${plan.estimatedTokens} > ${maxTotalTokens}`);
  }
  return result(errors);
}

function validateNodeRuntime(node, nodeId, errors) {
  const label = `orchestration.nodes.${nodeId}`;
  add(errors, isRecord(node), `${label} must be an object`);
  if (!isRecord(node)) return;
  add(errors, NODE_STATES.has(node.state), `${label}.state is unsupported: ${node.state}`);
  add(errors, node.taskId === null || identifier(node.taskId), `${label}.taskId must be null or a stable identifier`);
  add(errors, node.jobId === null || identifier(node.jobId), `${label}.jobId must be null or a stable identifier`);
  add(errors, node.runId === null || identifier(node.runId), `${label}.runId must be null or a stable identifier`);
  add(errors, positiveInteger(node.attempt), `${label}.attempt must be a positive integer`);
  add(errors, Array.isArray(node.blockedBy) && node.blockedBy.every(identifier), `${label}.blockedBy must be an array of stable identifiers`);
  add(errors, node.lastError === null || typeof node.lastError === "string" || isRecord(node.lastError), `${label}.lastError must be null, a string, or an object`);
}

export function validateOrchestrationRecord(orchestration, options = {}) {
  const errors = [];
  validateVersion(orchestration, "orchestration", errors);
  if (!isRecord(orchestration)) return result(errors);
  add(errors, identifier(orchestration.orchestrationId), "orchestration.orchestrationId must be a stable identifier");
  add(errors, identifier(orchestration.objectiveId), "orchestration.objectiveId must be a stable identifier");
  add(errors, identifier(orchestration.planId), "orchestration.planId must be a stable identifier");
  add(errors, ORCHESTRATION_STATES.has(orchestration.state), `orchestration.state is unsupported: ${orchestration.state}`);
  add(errors, nonEmptyString(orchestration.planFingerprint) && /^[a-f0-9]{64}$/i.test(orchestration.planFingerprint), "orchestration.planFingerprint must be a SHA-256 fingerprint");
  add(errors, isRecord(orchestration.nodes) && Object.keys(orchestration.nodes).length > 0, "orchestration.nodes must be a non-empty object");
  if (isRecord(orchestration.nodes)) for (const [nodeId, node] of Object.entries(orchestration.nodes)) {
    add(errors, identifier(nodeId), `orchestration.nodes key is not a stable identifier: ${nodeId}`);
    validateNodeRuntime(node, nodeId, errors);
  }
  add(errors, isRecord(orchestration.integration), "orchestration.integration must be an object");
  if (isRecord(orchestration.integration)) {
    add(errors, nonEmptyString(orchestration.integration.state), "orchestration.integration.state must be non-empty");
    add(errors, isRecord(orchestration.integration.projectBaselines), "orchestration.integration.projectBaselines must be an object");
    add(errors, Array.isArray(orchestration.integration.artifacts), "orchestration.integration.artifacts must be an array");
    add(errors, Array.isArray(orchestration.integration.verification), "orchestration.integration.verification must be an array");
    add(errors, orchestration.integration.rollback === null || isRecord(orchestration.integration.rollback), "orchestration.integration.rollback must be null or an object");
  }
  add(errors, isRecord(orchestration.usage), "orchestration.usage must be an object");
  if (isRecord(orchestration.usage)) {
    for (const field of ["totalTokens", "agentInvocations", "retries"]) add(errors, nonNegativeInteger(orchestration.usage[field]), `orchestration.usage.${field} must be a non-negative integer`);
  }
  add(errors, isoDate(orchestration.createdAt), "orchestration.createdAt must be an ISO timestamp");
  add(errors, isoDate(orchestration.updatedAt), "orchestration.updatedAt must be an ISO timestamp");
  if (options.plan?.nodes) {
    const plannedIds = new Set(options.plan.nodes.map((node) => node.nodeId));
    const runtimeIds = new Set(Object.keys(orchestration.nodes ?? {}));
    for (const nodeId of plannedIds) if (!runtimeIds.has(nodeId)) errors.push(`orchestration.nodes is missing plan node: ${nodeId}`);
    for (const nodeId of runtimeIds) if (!plannedIds.has(nodeId)) errors.push(`orchestration.nodes contains unknown plan node: ${nodeId}`);
  }
  return result(errors);
}

export function validateDecisionRecord(decision) {
  const errors = [];
  validateVersion(decision, "decision", errors);
  if (!isRecord(decision)) return result(errors);
  add(errors, identifier(decision.decisionId), "decision.decisionId must be a stable identifier");
  add(errors, identifier(decision.objectiveId), "decision.objectiveId must be a stable identifier");
  add(errors, decision.nodeId === null || decision.nodeId === undefined || identifier(decision.nodeId), "decision.nodeId must be null or a stable identifier");
  add(errors, decision.runId === null || decision.runId === undefined || identifier(decision.runId), "decision.runId must be null or a stable identifier");
  add(errors, DECISION_TYPES.has(decision.type), `decision.type is unsupported: ${decision.type}`);
  add(errors, DECISION_STATES.has(decision.state), `decision.state is unsupported: ${decision.state}`);
  add(errors, isRecord(decision.evidence) || Array.isArray(decision.evidence), "decision.evidence must be an object or array");
  add(errors, nonEmptyString(decision.requestedAction), "decision.requestedAction must be non-empty");
  add(errors, uniqueStrings(decision.allowedChoices) && decision.allowedChoices.length > 0, "decision.allowedChoices must be a non-empty unique string array");
  add(errors, decision.creator === "SYSTEM" || (isRecord(decision.creator) && decision.creator.type === "SYSTEM"), "decision.creator must be SYSTEM");
  add(errors, isoDate(decision.createdAt), "decision.createdAt must be an ISO timestamp");
  add(errors, decision.resolution === null || isRecord(decision.resolution), "decision.resolution must be null or an object");
  if (decision.state === "RESOLVED") {
    add(errors, isRecord(decision.resolution), "decision.resolution is required for RESOLVED decisions");
    if (isRecord(decision.resolution)) {
      add(errors, nonEmptyString(decision.resolution.action) && decision.allowedChoices.includes(decision.resolution.action), "decision.resolution.action must be one of allowedChoices");
      add(errors, nonEmptyString(decision.resolution.resolvedBy), "decision.resolution.resolvedBy must be a human identity");
      add(errors, isoDate(decision.resolution.resolvedAt), "decision.resolution.resolvedAt must be an ISO timestamp");
    }
  } else {
    add(errors, decision.resolution === null || decision.resolution === undefined, "open decision cannot contain a resolution");
  }
  return result(errors);
}

export const validateObjective = validateObjectiveRecord;
export const validatePlan = validatePlanRecord;
export const validateOrchestration = validateOrchestrationRecord;
export const validateDecision = validateDecisionRecord;
export const ORCHESTRATION_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
