import { createHash } from "node:crypto";
import path from "node:path";
import { createDecision, getDecision, listDecisions } from "./decision-store.mjs";
import { getObjective, updateObjective } from "./objective-store.mjs";
import { createPlan, getPlan, listPlans, updatePlan } from "./plan-store.mjs";
import { validatePlanRecord } from "./orchestration-schema.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { assignmentMetadata, defaultSkillRegistryPath, validateAssignedSkill, validatePlanSkillAssignments } from "./skill-assignment.mjs";
import { readSkillRegistry } from "./skill-registry.mjs";
import { skillsEnabled as skillsFeatureEnabled } from "./rollout-flags.mjs";
import { validateVerificationCoverage } from "./verification-intent.mjs";

const PLAN_STATE_PENDING = "PENDING_APPROVAL";
const PLAN_STATE_APPROVED = "APPROVED";
const PLAN_STATE_SUPERSEDED = "SUPERSEDED";
const PLAN_STATE_CANCELLED = "CANCELLED";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class PlanLifecycleError extends Error {
  constructor(message, { statusCode = 400, code = "PLAN_LIFECYCLE_INVALID", details = null } = {}) {
    super(message);
    this.name = "PlanLifecycleError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new PlanLifecycleError(message, options);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function stableId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!ID_PATTERN.test(normalized)) fail(`${label} tidak valid.`, { code: "INVALID_IDENTIFIER", details: { code: "INVALID_IDENTIFIER", field: label } });
  return normalized;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value, { omit = new Set() } = {}) {
  if (Array.isArray(value)) return value.map((item) => canonical(item, { omit }));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !omit.has(key)).map((key) => [key, canonical(value[key], { omit })]));
}

function fingerprintInput(plan) {
  return canonical({
    ...plan,
    state: PLAN_STATE_PENDING,
    approvedBy: null,
    approvedAt: null,
  }, { omit: new Set(["planFingerprint", "createdAt", "updatedAt"]) });
}

export function planFingerprint(plan) {
  return createHash("sha256").update(JSON.stringify(fingerprintInput(plan))).digest("hex");
}

function lifecycleLease(objectiveId) {
  return {
    namespace: "plan-lifecycle",
    key: objectiveId,
    purpose: `plan lifecycle ${objectiveId}`,
    ttlMs: 5 * 60 * 1000,
    reclaimDeadOwner: true,
    waitTimeoutMs: 2_000,
  };
}

function objectiveOrFail(runsRoot, objectiveId) {
  const objective = getObjective(runsRoot, stableId(objectiveId, "objectiveId"));
  if (!objective) fail(`Objective tidak ditemukan: ${objectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId } });
  return objective;
}

function planValidationOptions(objective) {
  return {
    knownProjectIds: objective.projectIds,
    budget: objective.budget,
  };
}

export function planRevision(plan) {
  const match = String(plan?.planId ?? "").match(/-r(\d+)$/);
  return match ? Number(match[1]) : Number(plan?.planRevision ?? plan?.revision ?? 0);
}

function assertModelCandidate({ objective, candidate, revision, now }) {
  if (!isObject(candidate)) fail("Plan candidate harus berupa object.", { code: "INVALID_PLAN" });
  if (candidate.state === PLAN_STATE_APPROVED || candidate.approvedBy !== null && candidate.approvedBy !== undefined || candidate.approvedAt !== null && candidate.approvedAt !== undefined || candidate.approval !== undefined) {
    fail("Model tidak boleh mengisi provenance approval plan.", { statusCode: 422, code: "MODEL_APPROVAL_FORBIDDEN", details: { code: "MODEL_APPROVAL_FORBIDDEN" } });
  }

  const expectedPlanId = `plan-${objective.objectiveId}-r${revision}`;
  const record = {
    ...structuredClone(candidate),
    schemaVersion: 1,
    revision,
    planId: expectedPlanId,
    objectiveId: objective.objectiveId,
    state: PLAN_STATE_PENDING,
    approvedBy: null,
    approvedAt: null,
    createdAt: candidate.createdAt ?? iso(now),
    updatedAt: iso(now),
  };
  const validation = validatePlanRecord(record, planValidationOptions(objective));
  if (!validation.valid) fail("Plan candidate tidak valid.", { statusCode: 422, code: "INVALID_PLAN", details: { code: "INVALID_PLAN", errors: validation.errors } });
  return { ...record, planFingerprint: planFingerprint(record) };
}

function activePlanOrFail(runsRoot, objective) {
  if (!objective.activePlanId) fail("Objective belum memiliki active plan.", { statusCode: 409, code: "PLAN_NOT_FOUND", details: { code: "PLAN_NOT_FOUND", objectiveId: objective.objectiveId } });
  const plan = getPlan(runsRoot, objective.activePlanId, planValidationOptions(objective));
  if (!plan) fail(`Plan tidak ditemukan: ${objective.activePlanId}`, { statusCode: 409, code: "PLAN_NOT_FOUND", details: { code: "PLAN_NOT_FOUND", planId: objective.activePlanId } });
  if (plan.objectiveId !== objective.objectiveId) fail("Active plan tidak cocok dengan objective.", { statusCode: 409, code: "PLAN_OBJECTIVE_MISMATCH", details: { code: "PLAN_OBJECTIVE_MISMATCH" } });
  return plan;
}

function markSuperseded({ runsRoot, objective, now }) {
  if (!objective.activePlanId) return null;
  const previous = getPlan(runsRoot, objective.activePlanId, planValidationOptions(objective));
  if (!previous || [PLAN_STATE_SUPERSEDED, PLAN_STATE_CANCELLED].includes(previous.state)) return previous;
  return updatePlan({
    runsRoot,
    planId: previous.planId,
    expectedRevision: previous.revision,
    now,
    update: (record) => ({ ...record, state: PLAN_STATE_SUPERSEDED, supersededAt: iso(now) }),
    validationOptions: planValidationOptions(objective),
  });
}

function updateObjectiveForPlan({ runsRoot, objective, plan, state, now }) {
  return updateObjective({
    runsRoot,
    objectiveId: objective.objectiveId,
    expectedRevision: objective.revision,
    now,
    update: (record) => ({ ...record, state, activePlanId: plan.planId }),
  });
}

function revisionFromPrevious(previous, { revision, now, clarificationNeeded, clarificationQuestion, note, answer }) {
  const assumptions = [...(previous.assumptions ?? [])];
  const addition = [note, answer].filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
  for (const value of addition) if (!assumptions.includes(value)) assumptions.push(value);
  return {
    ...structuredClone(previous),
    planId: `plan-${previous.objectiveId}-r${revision}`,
    revision,
    state: PLAN_STATE_PENDING,
    approvedBy: null,
    approvedAt: null,
    clarificationNeeded,
    clarificationQuestion: clarificationQuestion ?? null,
    assumptions,
    createdAt: iso(now),
    updatedAt: iso(now),
    planFingerprint: undefined,
  };
}

function createRevisionDecision({ runsRoot, objective, plan, action, resolvedBy, now, evidence }) {
  const decisionId = `decision-plan-${action.toLowerCase()}-${plan.planId}`;
  const existing = getDecision(runsRoot, decisionId);
  if (existing) return existing;
  return createDecision({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      decisionId,
      objectiveId: objective.objectiveId,
      nodeId: null,
      runId: null,
      type: action === "SCOPE_EXPANSION" ? "SCOPE_EXPANSION" : action === "ASSIGN_SKILLS" ? "SKILL_ASSIGNMENT" : "PLAN_CLARIFICATION",
      state: "RESOLVED",
      evidence,
      requestedAction: action === "ASSIGN_SKILLS"
        ? "Apply human-selected skills to a new plan revision"
        : action === "CLARIFY"
        ? "Apply user clarification to create a new plan revision"
        : action === "SCOPE_EXPANSION"
          ? "Expand objective scope through a new plan revision"
          : "Request changes to create a new plan revision",
      allowedChoices: [action, "CANCEL"],
      creator: "SYSTEM",
      createdAt: iso(now),
      resolution: { action, resolvedBy: String(resolvedBy), resolvedAt: iso(now) },
    },
  });
}

function createRevisionLocked({ runsRoot, objectiveId, candidate, state, now, resolvedBy = null, decisionAction = null, evidence = null }) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  const previous = objective.activePlanId ? activePlanOrFail(runsRoot, objective) : null;
  const revision = previous ? planRevision(previous) + 1 : 1;
  const plan = assertModelCandidate({ objective, candidate, revision, now });
  const persisted = createPlan({ runsRoot, record: plan, validationOptions: planValidationOptions(objective) });
  if (previous) markSuperseded({ runsRoot, objective, now });
  const nextObjective = updateObjectiveForPlan({ runsRoot, objective, plan: persisted, state, now });
  let decision = null;
  if (decisionAction) {
    decision = createRevisionDecision({ runsRoot, objective: nextObjective, plan: persisted, action: decisionAction, resolvedBy, now, evidence });
  }
  return { objective: nextObjective, plan: persisted, previousPlan: previous, decision, revision: planRevision(persisted) };
}

function createRevision({ runsRoot, objectiveId, candidate, state, now, resolvedBy = null, decisionAction = null, evidence = null }) {
  const initial = objectiveOrFail(runsRoot, objectiveId);
  return withDurableLease({ runsRoot, ...lifecycleLease(initial.objectiveId) }, () => createRevisionLocked({ runsRoot, objectiveId: initial.objectiveId, candidate, state, now, resolvedBy, decisionAction, evidence }));
}

export function createPlanRevision({ runsRoot, objectiveId, candidate, now = new Date() } = {}) {
  return createRevision({ runsRoot, objectiveId, candidate, state: candidate?.clarificationNeeded ? "NEEDS_CLARIFICATION" : "PLAN_REVIEW", now });
}

export function clarifyPlan({ runsRoot, objectiveId, answer, candidate = null, clarifiedBy = "user", now = new Date() } = {}) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  const previous = activePlanOrFail(runsRoot, objective);
  const text = String(answer ?? "").trim();
  if (!text) fail("Clarification answer wajib diisi.", { code: "CLARIFICATION_REQUIRED", details: { code: "CLARIFICATION_REQUIRED" } });
  const nextCandidate = candidate ?? revisionFromPrevious(previous, {
    revision: planRevision(previous) + 1,
    now,
    clarificationNeeded: false,
    clarificationQuestion: null,
    answer: `Clarification: ${text}`,
  });
  return createRevision({
    runsRoot,
    objectiveId,
    candidate: nextCandidate,
    state: "PLAN_REVIEW",
    now,
    resolvedBy: clarifiedBy,
    decisionAction: "CLARIFY",
    evidence: { answer: text, previousPlanId: previous.planId },
  });
}

export function requestPlanChanges({ runsRoot, objectiveId, reason, candidate = null, requestedBy = "user", now = new Date() } = {}) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  const previous = activePlanOrFail(runsRoot, objective);
  const text = String(reason ?? "").trim();
  if (!text) fail("Alasan perubahan plan wajib diisi.", { code: "PLAN_CHANGE_REASON_REQUIRED", details: { code: "PLAN_CHANGE_REASON_REQUIRED" } });
  const nextCandidate = candidate ?? revisionFromPrevious(previous, {
    revision: planRevision(previous) + 1,
    now,
    clarificationNeeded: false,
    clarificationQuestion: null,
    note: `Requested changes: ${text}`,
  });
  return createRevision({
    runsRoot,
    objectiveId,
    candidate: nextCandidate,
    state: "PLANNING",
    now,
    resolvedBy: requestedBy,
    decisionAction: "REQUEST_CHANGES",
    evidence: { reason: text, previousPlanId: previous.planId },
  });
}

export function requestScopeExpansion({ runsRoot, objectiveId, reason, candidate = null, requestedBy = "user", now = new Date() } = {}) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  const previous = activePlanOrFail(runsRoot, objective);
  const text = String(reason ?? "").trim();
  if (!text) fail("Alasan scope expansion wajib diisi.", { code: "SCOPE_EXPANSION_REASON_REQUIRED", details: { code: "SCOPE_EXPANSION_REASON_REQUIRED" } });
  const nextCandidate = candidate ?? revisionFromPrevious(previous, {
    revision: planRevision(previous) + 1,
    now,
    clarificationNeeded: false,
    clarificationQuestion: null,
    note: `Scope expansion: ${text}`,
  });
  return createRevision({
    runsRoot,
    objectiveId,
    candidate: nextCandidate,
    state: "PLANNING",
    now,
    resolvedBy: requestedBy,
    decisionAction: "SCOPE_EXPANSION",
    evidence: { reason: text, previousPlanId: previous.planId, previousPlanFingerprint: previous.planFingerprint },
  });
}

export function assignPlanSkills({ runsRoot, objectiveId, assignments, assignedBy, registryPath = defaultSkillRegistryPath(runsRoot), projectSignalsByProject = {}, now = new Date(), env = process.env } = {}) {
  const initial = objectiveOrFail(runsRoot, objectiveId);
  const identity = String(assignedBy ?? "").trim();
  if (!identity) fail("Skill assignment membutuhkan identitas human operator.", { statusCode: 403, code: "SKILL_ASSIGNER_REQUIRED", details: { code: "SKILL_ASSIGNER_REQUIRED" } });
  if (!Array.isArray(assignments) || assignments.length === 0) fail("Minimal satu skill assignment wajib dipilih.", { code: "SKILL_ASSIGNMENTS_REQUIRED", details: { code: "SKILL_ASSIGNMENTS_REQUIRED" } });
  if (!skillsFeatureEnabled(env)) fail("Skill orchestration belum diaktifkan.", { statusCode: 409, code: "FEATURE_DISABLED", details: { code: "FEATURE_DISABLED", feature: "SKILLS" } });
  return withDurableLease({ runsRoot, ...lifecycleLease(initial.objectiveId) }, () => {
    const objective = objectiveOrFail(runsRoot, initial.objectiveId);
    const previous = activePlanOrFail(runsRoot, objective);
    if (objective.state === "CANCELLED" || previous.state !== PLAN_STATE_PENDING) fail("Skill hanya dapat ditambahkan pada plan revision yang belum di-approve.", { statusCode: 409, code: "SKILL_ASSIGNMENT_PLAN_NOT_EDITABLE", details: { code: "SKILL_ASSIGNMENT_PLAN_NOT_EDITABLE", planId: previous.planId, state: previous.state } });
    const registry = readSkillRegistry({ registryPath, registryRoot: path.dirname(registryPath) });
    const nodes = new Map(previous.nodes.map((node) => [node.nodeId, node]));
    const seenNodes = new Set();
    const normalized = assignments.map((requested) => {
      const node = nodes.get(requested?.nodeId);
      if (!node) fail(`Node tidak ditemukan untuk skill assignment: ${requested?.nodeId}`, { statusCode: 422, code: "SKILL_ASSIGNMENT_NODE_NOT_FOUND", details: { code: "SKILL_ASSIGNMENT_NODE_NOT_FOUND", nodeId: requested?.nodeId } });
      if (seenNodes.has(node.nodeId)) fail(`Node menerima lebih dari satu skill assignment request: ${node.nodeId}`, { statusCode: 422, code: "SKILL_ASSIGNMENT_DUPLICATE_NODE", details: { code: "SKILL_ASSIGNMENT_DUPLICATE_NODE", nodeId: node.nodeId } });
      seenNodes.add(node.nodeId);
      const skill = registry.skills.find((candidate) => candidate.skillId === requested?.skillId && candidate.version === requested?.version) ?? null;
      const validation = validateAssignedSkill({ assignment: { skillId: requested?.skillId, version: requested?.version, checksum: requested?.checksum ?? skill?.instructions?.sha256 }, skill, node, projectSignals: projectSignalsByProject[node.projectId] ?? [] });
      if (!validation.valid) fail(`Skill assignment ditolak untuk ${node.nodeId}: ${validation.errors.join("; ")}`, { statusCode: 422, code: "SKILL_ASSIGNMENT_INVALID", details: { code: "SKILL_ASSIGNMENT_INVALID", nodeId: node.nodeId, errors: validation.errors } });
      return { nodeId: node.nodeId, skill: assignmentMetadata(skill) };
    });
    const candidate = {
      ...structuredClone(previous),
      nodes: previous.nodes.map((node) => {
        const selected = normalized.find((item) => item.nodeId === node.nodeId);
        return selected ? { ...node, skills: [selected.skill] } : node;
      }),
    };
    const result = createRevisionLocked({
      runsRoot,
      objectiveId: objective.objectiveId,
      candidate,
      state: "PLAN_REVIEW",
      now,
      resolvedBy: identity,
      decisionAction: "ASSIGN_SKILLS",
      evidence: { assignments: normalized, previousPlanId: previous.planId, previousPlanFingerprint: previous.planFingerprint ?? planFingerprint(previous) },
    });
    return { ...result, skillAssignments: normalized, registryRevision: registry.revision };
  });
}

export function validateApprovedPlanSkills({ runsRoot, plan, projectSignalsByProject = {}, registryPath = defaultSkillRegistryPath(runsRoot) } = {}) {
  return validatePlanSkillAssignments({ runsRoot, plan, projectSignalsByProject, registryPath });
}

export function cancelObjective({ runsRoot, objectiveId, cancelledBy = "user", now = new Date() } = {}) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  const identity = String(cancelledBy ?? "").trim();
  if (!identity) fail("Human cancellation identity wajib berasal dari operator session.", { statusCode: 403, code: "CANCELLER_REQUIRED", details: { code: "CANCELLER_REQUIRED" } });
  return withDurableLease({ runsRoot, ...lifecycleLease(objective.objectiveId) }, () => {
    const current = objectiveOrFail(runsRoot, objective.objectiveId);
    if (current.state === "CANCELLED") {
      return { objective: current, plan: current.activePlanId ? getPlan(runsRoot, current.activePlanId, planValidationOptions(current)) : null, alreadyCancelled: true, cancelledBy: identity };
    }
    const active = current.activePlanId ? getPlan(runsRoot, current.activePlanId, planValidationOptions(current)) : null;
    let plan = active;
    if (active && ![PLAN_STATE_CANCELLED, PLAN_STATE_SUPERSEDED].includes(active.state)) {
      plan = updatePlan({
        runsRoot,
        planId: active.planId,
        expectedRevision: active.revision,
        now,
        update: (record) => ({ ...record, state: PLAN_STATE_CANCELLED, cancelledBy: identity, cancelledAt: iso(now) }),
        validationOptions: planValidationOptions(current),
      });
    }
    const nextObjective = updateObjective({
      runsRoot,
      objectiveId: current.objectiveId,
      expectedRevision: current.revision,
      now,
      update: (record) => ({ ...record, state: "CANCELLED", cancellation: { cancelledBy: identity, cancelledAt: iso(now) } }),
    });
    return { objective: nextObjective, plan, alreadyCancelled: false, cancelledBy: identity };
  });
}

function approvalDecision({ runsRoot, objective, plan, approvedBy, now }) {
  const decisionId = `decision-plan-approval-${plan.planId}`;
  const existing = getDecision(runsRoot, decisionId);
  if (existing) return existing;
  return createDecision({
    runsRoot,
    record: {
      schemaVersion: 1,
      revision: 0,
      decisionId,
      objectiveId: objective.objectiveId,
      nodeId: null,
      runId: null,
      type: "PLAN_APPROVAL",
      state: "RESOLVED",
      evidence: {
        planId: plan.planId,
        revision: planRevision(plan),
        planFingerprint: plan.planFingerprint ?? planFingerprint(plan),
        projects: plan.projects,
        risk: plan.risk,
        budget: objective.budget,
      },
      requestedAction: "Approve this exact plan revision for later materialization",
      allowedChoices: ["APPROVE", "CANCEL"],
      creator: "SYSTEM",
      createdAt: iso(now),
      resolution: { action: "APPROVE", resolvedBy: String(approvedBy), resolvedAt: iso(now) },
    },
  });
}

export function approvePlan({ runsRoot, objectiveId, planId = null, expectedFingerprint = null, approvedBy, now = new Date() } = {}) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  const identity = String(approvedBy ?? "").trim();
  if (!identity) fail("Human approval identity wajib berasal dari operator session.", { statusCode: 403, code: "APPROVER_REQUIRED", details: { code: "APPROVER_REQUIRED" } });
  return withDurableLease({ runsRoot, ...lifecycleLease(objective.objectiveId) }, () => {
    const current = objectiveOrFail(runsRoot, objective.objectiveId);
    const active = activePlanOrFail(runsRoot, current);
    if (planId && planId !== active.planId) fail("Approval hanya boleh diterapkan pada active plan revision.", { statusCode: 409, code: "STALE_PLAN_REVISION", details: { code: "STALE_PLAN_REVISION", activePlanId: active.planId, requestedPlanId: planId } });
    const fingerprint = active.planFingerprint ?? planFingerprint(active);
    if (expectedFingerprint && expectedFingerprint !== fingerprint) fail("Plan fingerprint tidak cocok dengan revision aktif.", { statusCode: 409, code: "PLAN_FINGERPRINT_MISMATCH", details: { code: "PLAN_FINGERPRINT_MISMATCH", expected: fingerprint, received: expectedFingerprint } });
    const skillValidation = validatePlanSkillAssignments({ runsRoot, plan: active, checkCompatibility: false });
    if (!skillValidation.valid) fail("Plan skill assignment tidak lagi valid.", { statusCode: 422, code: "INVALID_PLAN_SKILLS", details: { code: "INVALID_PLAN_SKILLS", errors: skillValidation.errors } });
    if (active.verificationIntent) {
      const coverage = validateVerificationCoverage({
        intent: active.verificationIntent,
        planNodes: active.nodes,
        integrationVerification: [
          ...(Array.isArray(active.integration?.projectVerification) ? active.integration.projectVerification : []),
          ...(Array.isArray(active.integration?.crossProjectVerification) ? active.integration.crossProjectVerification : []),
        ],
      });
      if (!coverage.valid) {
        fail(`Approval ditolak: ${coverage.error}`, {
          statusCode: 422,
          code: "PLAN_VERIFICATION_COVERAGE_MISSING",
          details: { code: "PLAN_VERIFICATION_COVERAGE_MISSING", missingCoverage: coverage.missingCoverage },
        });
      }
    }
    if (active.state === PLAN_STATE_SUPERSEDED || active.state === PLAN_STATE_CANCELLED) fail("Plan revision sudah tidak berlaku.", { statusCode: 409, code: "STALE_PLAN_REVISION", details: { code: "STALE_PLAN_REVISION", planId: active.planId } });
    const existing = getDecision(runsRoot, `decision-plan-approval-${active.planId}`);
    if (active.state === PLAN_STATE_APPROVED && existing?.state === "RESOLVED") return { objective: current, plan: active, decision: existing, alreadyApproved: true, planFingerprint: fingerprint };
    const decision = approvalDecision({ runsRoot, objective: current, plan: { ...active, planFingerprint: fingerprint }, approvedBy: identity, now });
    const approved = active.state === PLAN_STATE_APPROVED ? active : updatePlan({
      runsRoot,
      planId: active.planId,
      expectedRevision: active.revision,
      now,
      update: (record) => ({ ...record, state: PLAN_STATE_APPROVED, approvedBy: identity, approvedAt: iso(now), planFingerprint: fingerprint }),
      validationOptions: planValidationOptions(current),
    });
    const nextObjective = current.state === "APPROVED" ? current : updateObjective({
      runsRoot,
      objectiveId: current.objectiveId,
      expectedRevision: current.revision,
      now,
      patch: { state: "APPROVED", activePlanId: approved.planId },
    });
    return { objective: nextObjective, plan: approved, decision, alreadyApproved: false, planFingerprint: fingerprint, revision: planRevision(approved) };
  });
}

export function getObjectiveLifecycle({ runsRoot, objectiveId } = {}) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  const plan = objective.activePlanId ? getPlan(runsRoot, objective.activePlanId, planValidationOptions(objective)) : null;
  const decisions = listDecisions(runsRoot).filter((decision) => decision.objectiveId === objective.objectiveId);
  return {
    ...objective,
    plan,
    orchestration: null,
    decisions,
    decisionSummary: {
      open: decisions.filter((decision) => decision.state === "OPEN"),
      recent: decisions.slice(-10),
    },
  };
}

export function listObjectivePlans({ runsRoot, objectiveId } = {}) {
  const objective = objectiveOrFail(runsRoot, objectiveId);
  return listPlans(runsRoot, planValidationOptions(objective)).filter((plan) => plan.objectiveId === objective.objectiveId).sort((left, right) => left.revision - right.revision);
}
