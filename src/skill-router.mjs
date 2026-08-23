import fs from "node:fs";
import path from "node:path";
import {
  defaultSkillRegistryPath,
  readSkillRegistry,
  validateSkill,
} from "./skill-registry.mjs";
import { skillAutoRoutingEnabled, skillsEnabled as skillsFeatureEnabled } from "./rollout-flags.mjs";

const RISK_RANK = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2, UNKNOWN: 3 });
const NO_MATCH = "NO_COMPATIBLE_SKILL";

function routerError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalized(value, fallback = "UNKNOWN") {
  const text = String(value ?? "").trim().toUpperCase();
  return text || fallback;
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function semverParts(version) {
  return String(version ?? "0.0.0").split(/[.+-]/).slice(0, 3).map((item) => Number(item) || 0);
}

function compareVersions(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return String(right).localeCompare(String(left));
}

function allowedCapabilitySet(value) {
  return new Set(list(value));
}

function capabilityMatch(skill, allowedCapabilities) {
  const required = list(skill?.requiredCapabilities);
  if (!allowedCapabilities) return { valid: true, missing: [] };
  const missing = required.filter((capability) => !allowedCapabilities.has(capability));
  return { valid: missing.length === 0, missing };
}

function riskMatch(skill, node) {
  const nodeRisk = normalized(node?.risk, "UNKNOWN");
  const skillRisk = normalized(skill?.riskLevel, "UNKNOWN");
  if (!Object.hasOwn(RISK_RANK, nodeRisk) || !Object.hasOwn(RISK_RANK, skillRisk)) return { valid: false, reason: "unknown-risk" };
  if (skillRisk === "UNKNOWN") return { valid: false, reason: "skill-risk-unknown" };
  if (nodeRisk !== "UNKNOWN" && RISK_RANK[skillRisk] > RISK_RANK[nodeRisk]) return { valid: false, reason: "skill-risk-exceeds-node-risk" };
  return { valid: true, reason: null };
}

function roleScore(skill, node) {
  const roles = list(skill?.supportedRoles);
  if (roles.includes(node?.role)) return 3;
  if (roles.includes("GENERAL")) return 1;
  return 0;
}

function typeScore(skill, node) {
  const types = list(skill?.supportedTaskTypes);
  if (types.includes(node?.type) || types.includes(node?.taskType)) return 3;
  if (types.includes("ANY")) return 1;
  return 0;
}

function signalScore(skill, projectSignals) {
  const compatible = list(skill?.compatibleProjectSignals);
  if (!compatible.length) return 1;
  const signals = list(projectSignals);
  return compatible.some((signal) => signals.includes(signal)) ? 2 : 0;
}

function candidateReason(candidate) {
  const reasons = [
    candidate.roleScore === 3 ? "exact-role" : "general-role",
    candidate.typeScore === 3 ? "exact-task-type" : "any-task-type",
    candidate.signalScore === 2 ? "project-signal-match" : "signal-neutral",
    "checksum-valid",
    "enabled",
  ];
  return reasons.join(",");
}

function eligibleCandidate({ skill, node, projectSignals, allowedCapabilities, registryRoot, checkInstructions }) {
  const errors = [];
  const validation = validateSkill(skill, { registryRoot, checkInstructions });
  if (!validation.valid) errors.push(...validation.errors);
  if (!skill?.enabled) errors.push("skill is disabled");
  if (!list(skill?.supportedRoles).includes(node?.role) && !list(skill?.supportedRoles).includes("GENERAL")) errors.push(`role ${node?.role} is not supported`);
  if (!list(skill?.supportedTaskTypes).includes(node?.type) && !list(skill?.supportedTaskTypes).includes(node?.taskType) && !list(skill?.supportedTaskTypes).includes("ANY")) errors.push(`task type ${node?.type} is not supported`);
  const compatibleSignals = list(skill?.compatibleProjectSignals);
  if (compatibleSignals.length && !compatibleSignals.some((signal) => list(projectSignals).includes(signal))) errors.push("project signals are not compatible");
  const risk = riskMatch(skill, node);
  if (!risk.valid) errors.push(risk.reason);
  const capabilities = capabilityMatch(skill, allowedCapabilities);
  if (!capabilities.valid) errors.push(`required capabilities unavailable: ${capabilities.missing.join(", ")}`);
  return {
    valid: errors.length === 0,
    errors,
    candidate: errors.length === 0 ? {
      skillId: skill.skillId,
      version: skill.version,
      checksum: skill.instructions.sha256,
      roleScore: roleScore(skill, node),
      typeScore: typeScore(skill, node),
      signalScore: signalScore(skill, projectSignals),
      riskScore: RISK_RANK[normalized(skill.riskLevel)],
      reason: null,
    } : null,
  };
}

export function routeSkillCandidates({ node, projectSignals = [], installedSkills = [], allowedCapabilities = null, allowedTools = null, registryRoot = null, checkInstructions = false, noMatchPolicy = "GENERAL_ROLE_AGENT" } = {}) {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw routerError("Skill router membutuhkan approved node.", "SKILL_ROUTER_NODE_REQUIRED");
  const capabilityInput = allowedCapabilities ?? allowedTools;
  const capabilities = capabilityInput === null || capabilityInput === undefined ? null : allowedCapabilitySet(capabilityInput);
  const eligible = [];
  const rejected = [];
  for (const skill of Array.isArray(installedSkills) ? installedSkills : []) {
    const result = eligibleCandidate({ skill, node, projectSignals, allowedCapabilities: capabilities, registryRoot, checkInstructions });
    if (result.valid) {
      result.candidate.reason = candidateReason(result.candidate);
      eligible.push(result.candidate);
    } else {
      rejected.push({ skillId: skill?.skillId ?? null, version: skill?.version ?? null, reasons: result.errors });
    }
  }
  eligible.sort((left, right) => (
    right.roleScore - left.roleScore
    || right.typeScore - left.typeScore
    || right.signalScore - left.signalScore
    || left.riskScore - right.riskScore
    || compareVersions(left.version, right.version)
    || left.skillId.localeCompare(right.skillId)
  ));
  if (!eligible.length) {
    const fallback = noMatchPolicy === "HUMAN_DECISION" ? "HUMAN_DECISION" : "GENERAL_ROLE_AGENT";
    return {
      status: NO_MATCH,
      deterministic: true,
      fallback,
      selectedSkills: [],
      candidates: [],
      rejected,
      reason: fallback === "HUMAN_DECISION" ? "No compatible installed skill; human decision required." : "No compatible installed skill; preserve the existing general role agent.",
    };
  }
  return {
    status: "ROUTED",
    deterministic: true,
    fallback: null,
    selectedSkills: eligible.map(({ skillId, version, checksum, reason }) => ({ skillId, version, checksum, reason })),
    candidates: eligible,
    rejected,
    reason: "Deterministic compatibility rules selected the ordered skill candidates.",
  };
}

export function routeInstalledSkill({ node, registryPath, projectSignals = [], allowedCapabilities = null, allowedTools = null, noMatchPolicy = "GENERAL_ROLE_AGENT" } = {}) {
  if (!registryPath) throw routerError("Skill registry path wajib diisi.", "SKILL_ROUTER_REGISTRY_PATH_REQUIRED");
  const registry = readSkillRegistry({ registryPath, registryRoot: path.dirname(registryPath), checkInstructions: true });
  return {
    ...routeSkillCandidates({
      node,
      projectSignals,
      installedSkills: registry.skills,
      allowedCapabilities,
      allowedTools,
      registryRoot: registry.registryRoot,
      checkInstructions: true,
      noMatchPolicy,
    }),
    registryRevision: registry.revision,
  };
}

export function routePlanSkills({ plan, runsRoot, registryPath = defaultSkillRegistryPath(runsRoot), projectSignalsByProject = {}, allowedCapabilitiesByNode = {}, allowedToolsByNode = {}, noMatchPolicy = "GENERAL_ROLE_AGENT", env = process.env } = {}) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.nodes)) throw routerError("Skill router membutuhkan plan dengan nodes.", "SKILL_ROUTER_PLAN_REQUIRED");
  if (!skillsFeatureEnabled(env)) {
    return {
      plan: structuredClone(plan),
      registryState: "DISABLED",
      registryRevision: null,
      routes: plan.nodes.map((node) => ({ nodeId: node.nodeId, status: "SKILLS_DISABLED", deterministic: true, fallback: noMatchPolicy === "HUMAN_DECISION" ? "HUMAN_DECISION" : "GENERAL_ROLE_AGENT", selectedSkills: [], reason: "Skill orchestration disabled by rollout flag." })),
    };
  }
  if (!skillAutoRoutingEnabled(env)) {
    return {
      plan: structuredClone(plan),
      registryState: fs.existsSync(registryPath) ? "AVAILABLE" : "EMPTY",
      registryRevision: null,
      routes: plan.nodes.map((node) => ({ nodeId: node.nodeId, status: "AUTO_ROUTING_DISABLED", deterministic: true, fallback: node.skills?.length ? null : (noMatchPolicy === "HUMAN_DECISION" ? "HUMAN_DECISION" : "GENERAL_ROLE_AGENT"), selectedSkills: node.skills ?? [], reason: node.skills?.length ? "Preserve the human-approved skill assignment." : "Automatic skill routing disabled by rollout flag." })),
    };
  }
  if (!registryPath || !fs.existsSync(registryPath)) {
    return {
      plan: structuredClone(plan),
      registryState: "EMPTY",
      registryRevision: null,
      routes: plan.nodes.map((node) => ({ nodeId: node.nodeId, status: NO_MATCH, deterministic: true, fallback: noMatchPolicy === "HUMAN_DECISION" ? "HUMAN_DECISION" : "GENERAL_ROLE_AGENT", selectedSkills: [], reason: "Skill registry kosong." })),
    };
  }
  const registry = readSkillRegistry({ registryPath, registryRoot: path.dirname(registryPath), checkInstructions: true });
  const routes = [];
  const routedPlan = structuredClone(plan);
  for (const node of routedPlan.nodes) {
    if (Array.isArray(node.skills) && node.skills.length) {
      routes.push({ nodeId: node.nodeId, status: "MANUAL_ASSIGNMENT", deterministic: true, fallback: null, selectedSkills: node.skills, reason: "Preserve the human-approved skill assignment." });
      continue;
    }
    const route = routeSkillCandidates({
      node,
      projectSignals: projectSignalsByProject[node.projectId] ?? [],
      installedSkills: registry.skills,
      allowedCapabilities: allowedCapabilitiesByNode[node.nodeId] ?? node.allowedCapabilities ?? null,
      allowedTools: allowedToolsByNode[node.nodeId] ?? node.allowedTools ?? null,
      registryRoot: registry.registryRoot,
      checkInstructions: true,
      noMatchPolicy,
    });
    if (route.status === "ROUTED") node.skills = route.selectedSkills.slice(0, 1).map(({ skillId, version, checksum }) => ({ skillId, version, checksum }));
    routes.push({ nodeId: node.nodeId, ...route });
  }
  return { plan: routedPlan, registryState: "AVAILABLE", registryRevision: registry.revision, routes };
}

export function routingEvidence(routes = []) {
  return routes.map((route) => ({
    nodeId: route.nodeId,
    status: route.status,
    fallback: route.fallback ?? null,
    selectedSkills: (route.selectedSkills ?? []).map(({ skillId, version, checksum, reason }) => ({ skillId, version, checksum, reason: reason ?? null })),
    reason: route.reason ?? null,
  }));
}

export function loadAssignedSkillInstructions({ assignments = [], runsRoot, registryPath = defaultSkillRegistryPath(runsRoot) } = {}) {
  if (!Array.isArray(assignments) || assignments.length === 0) return [];
  const registry = readSkillRegistry({ registryPath, registryRoot: path.dirname(registryPath), checkInstructions: true });
  return assignments.map((assignment) => {
    const skill = registry.skills.find((candidate) => candidate.skillId === assignment.skillId && candidate.version === assignment.version);
    if (!skill || !skill.enabled || skill.instructions.sha256 !== assignment.checksum) throw routerError(`Assigned skill tidak lagi valid: ${assignment.skillId}@${assignment.version}`, "SKILL_ROUTER_ASSIGNED_SKILL_INVALID");
    const validation = validateSkill(skill, { registryRoot: registry.registryRoot, checkInstructions: true });
    if (!validation.valid) throw routerError(`Assigned skill ditolak: ${validation.errors.join("; ")}`, "SKILL_ROUTER_ASSIGNED_SKILL_INVALID");
    return {
      skillId: skill.skillId,
      version: skill.version,
      checksum: skill.instructions.sha256,
      instructions: fs.readFileSync(path.join(registry.registryRoot, skill.instructions.resourcePath), "utf8"),
    };
  });
}

export { NO_MATCH };
