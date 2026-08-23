import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const SKILL_SCHEMA_VERSION = 1;
export const SKILL_KIND = "ai-os-skill";
export const SKILL_REGISTRY_SCHEMA_VERSION = 1;
export const SKILL_REGISTRY_KIND = "ai-os-skill-registry";
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
export const SKILL_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SKILL_SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const SKILL_RISK_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]);
export const SKILL_PROVENANCE_SOURCES = Object.freeze(["BUNDLED", "LOCAL_HUMAN"]);
export const SKILL_CAPABILITIES = Object.freeze([
  "context.read",
  "repository.read",
  "repository.write",
  "verification.run",
  "preview.read",
  "browser.capture",
  "knowledge.read",
  "knowledge.propose",
]);

export function defaultSkillRegistryPath(runsRoot) {
  if (!runsRoot) throw new Error("runsRoot wajib diisi untuk skill registry.");
  return path.join(runsRoot, "runtime", "skills", "registry.json");
}

const CAPABILITY_SET = new Set(SKILL_CAPABILITIES);
const RISK_SET = new Set(SKILL_RISK_LEVELS);
const PROVENANCE_SET = new Set(SKILL_PROVENANCE_SOURCES);

function nonEmpty(value, field, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${field} must be a non-empty string`);
}

function uniqueStrings(value, field, errors, { minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  if (value.length < minItems) errors.push(`${field} must contain at least ${minItems} item(s)`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) errors.push(`${field} items must be non-empty strings`);
    else if (seen.has(item)) errors.push(`${field} must not contain duplicates`);
    else seen.add(item);
  }
}

function isDateTime(value) {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) return false;
  if (value.includes("\\")) return false;
  const segments = value.split("/");
  return !segments.includes("") && !segments.includes(".") && !segments.includes("..");
}

function isWithin(parent, candidate) {
  const canonical = (value) => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  const relative = path.relative(canonical(parent), canonical(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolvedInstructionPath(registryRoot, resourcePath) {
  if (!safeRelativePath(resourcePath)) return null;
  const candidate = path.resolve(registryRoot, resourcePath);
  if (!isWithin(registryRoot, candidate)) return null;
  return candidate;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function humanInstaller(value) {
  return typeof value === "string" && value.trim().length > 0 && !/^(agent|model|skill-router|system)(:|$)/i.test(value.trim());
}

export function verifySkillInstructions({ skill, registryRoot } = {}) {
  const errors = [];
  const instruction = skill?.instructions;
  const filePath = registryRoot ? resolvedInstructionPath(registryRoot, instruction?.resourcePath) : null;
  if (!registryRoot) errors.push("registryRoot is required to verify instructions");
  if (!filePath) errors.push("instructions.resourcePath must be a safe path inside the registry root");
  else if (!fs.existsSync(filePath)) errors.push("instruction resource does not exist");
  else {
    const realPath = fs.realpathSync(filePath);
    if (!isWithin(registryRoot, realPath)) errors.push("instruction resource symlink escapes the registry root");
    else if (!fs.statSync(realPath).isFile()) errors.push("instruction resource is not a regular file");
    else if (sha256File(realPath) !== instruction.sha256) errors.push("instruction resource checksum mismatch");
    return { valid: errors.length === 0, errors, path: realPath };
  }
  return { valid: false, errors, path: filePath };
}

export function validateSkill(skill, { registryRoot, checkInstructions = true } = {}) {
  const errors = [];
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return { valid: false, errors: ["Skill must be a non-null object"] };
  if (skill.schemaVersion !== SKILL_SCHEMA_VERSION) errors.push("Unsupported skill schemaVersion");
  if (skill.kind !== SKILL_KIND) errors.push("Invalid skill kind");
  if (typeof skill.skillId !== "string" || !SKILL_ID_PATTERN.test(skill.skillId)) errors.push("skillId must be a stable lowercase identifier");
  if (typeof skill.version !== "string" || !SKILL_SEMVER_PATTERN.test(skill.version)) errors.push("version must be valid semver");
  nonEmpty(skill.purpose, "purpose", errors);
  uniqueStrings(skill.supportedRoles, "supportedRoles", errors, { minItems: 1 });
  uniqueStrings(skill.supportedTaskTypes, "supportedTaskTypes", errors, { minItems: 1 });
  uniqueStrings(skill.requiredContextTypes, "requiredContextTypes", errors);
  uniqueStrings(skill.requiredCapabilities, "requiredCapabilities", errors);
  if (Array.isArray(skill.requiredCapabilities)) {
    for (const capability of skill.requiredCapabilities) if (!CAPABILITY_SET.has(capability)) errors.push(`unsupported required capability: ${capability}`);
  }
  uniqueStrings(skill.compatibleProjectSignals, "compatibleProjectSignals", errors);
  if (!RISK_SET.has(skill.riskLevel)) errors.push(`riskLevel must be one of ${SKILL_RISK_LEVELS.join(", ")}`);
  if (!skill.instructions || typeof skill.instructions !== "object" || Array.isArray(skill.instructions)) errors.push("instructions must be an object");
  else {
    nonEmpty(skill.instructions.resourcePath, "instructions.resourcePath", errors);
    if (!safeRelativePath(skill.instructions.resourcePath)) errors.push("instructions.resourcePath must be a safe relative path");
    if (typeof skill.instructions.sha256 !== "string" || !SKILL_SHA256_PATTERN.test(skill.instructions.sha256)) errors.push("instructions.sha256 must be a lowercase SHA-256 checksum");
    if (registryRoot && checkInstructions) {
      const instructionCheck = verifySkillInstructions({ skill, registryRoot });
      errors.push(...instructionCheck.errors);
    }
  }
  uniqueStrings(skill.verificationRequirements, "verificationRequirements", errors, { minItems: 1 });
  if (typeof skill.enabled !== "boolean") errors.push("enabled must be boolean");
  const provenance = skill.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) errors.push("provenance must be an object");
  else {
    if (!PROVENANCE_SET.has(provenance.source)) errors.push("provenance.source must be BUNDLED or LOCAL_HUMAN; Wiki knowledge is not a skill source");
    if (!humanInstaller(provenance.humanInstaller)) errors.push("provenance.humanInstaller must identify a human installer");
    if (!isDateTime(provenance.installedAt)) errors.push("provenance.installedAt must be a valid timestamp");
    nonEmpty(provenance.sourceRef, "provenance.sourceRef", errors);
  }
  if (skill.wikiKnowledge || skill.knowledgePage || skill.reclassifiedFrom) errors.push("Wiki knowledge must remain context and cannot be reclassified as a skill");
  return { valid: errors.length === 0, errors };
}

export function validateSkillRegistry(registry, { registryRoot, checkInstructions = true } = {}) {
  const errors = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return { valid: false, errors: ["Skill registry must be a non-null object"] };
  if (registry.schemaVersion !== SKILL_REGISTRY_SCHEMA_VERSION) errors.push("Unsupported skill registry schemaVersion");
  if (registry.kind !== SKILL_REGISTRY_KIND) errors.push("Invalid skill registry kind");
  if (!Number.isInteger(registry.revision) || registry.revision < 0) errors.push("revision must be a non-negative integer");
  if (registry.agentWritable !== false) errors.push("agentWritable must be false");
  if (!isDateTime(registry.updatedAt)) errors.push("updatedAt must be a valid timestamp");
  if (!Array.isArray(registry.skills)) errors.push("skills must be an array");
  const identities = new Set();
  for (const skill of registry.skills ?? []) {
    const validation = validateSkill(skill, { registryRoot, checkInstructions });
    errors.push(...validation.errors.map((error) => `${skill?.skillId ?? "unknown"}: ${error}`));
    const identity = `${skill?.skillId ?? ""}@${skill?.version ?? ""}`;
    if (identities.has(identity)) errors.push(`duplicate skill version: ${identity}`);
    identities.add(identity);
  }
  return { valid: errors.length === 0, errors };
}

function registryError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function readSkillRegistry({ registryPath, registryRoot = registryPath ? path.dirname(registryPath) : null, checkInstructions = true } = {}) {
  if (!registryPath) throw registryError("Skill registry path wajib diisi.", "SKILL_REGISTRY_PATH_REQUIRED");
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw registryError("Skill registry tidak ditemukan.", "SKILL_REGISTRY_NOT_FOUND");
    throw registryError(`Skill registry tidak dapat dibaca: ${error.message}`, "SKILL_REGISTRY_INVALID_JSON");
  }
  const validation = validateSkillRegistry(registry, { registryRoot, checkInstructions });
  if (!validation.valid) throw registryError(`Skill registry ditolak fail-closed: ${validation.errors.join("; ")}`, "SKILL_REGISTRY_INVALID", validation);
  return { ...registry, registryPath: path.resolve(registryPath), registryRoot: path.resolve(registryRoot ?? path.dirname(registryPath)) };
}

export function listInstalledSkills({ registryPath, registryRoot, includeDisabled = true, checkInstructions = true } = {}) {
  const registry = readSkillRegistry({ registryPath, registryRoot, checkInstructions });
  return registry.skills.filter((skill) => includeDisabled || skill.enabled).map((skill) => ({ ...skill }));
}

export function getInstalledSkill({ registryPath, registryRoot, skillId, version, checkInstructions = true } = {}) {
  const skills = listInstalledSkills({ registryPath, registryRoot, checkInstructions });
  return skills.find((skill) => skill.skillId === skillId && (!version || skill.version === version)) ?? null;
}

export function validateSkillRequest({ skill, requestedCapabilities = [], registryRoot, checkInstructions = true } = {}) {
  const errors = [];
  const capabilities = Array.isArray(requestedCapabilities) ? requestedCapabilities : [];
  if (!Array.isArray(requestedCapabilities)) errors.push("requestedCapabilities must be an array");
  for (const capability of capabilities) {
    if (!CAPABILITY_SET.has(capability)) errors.push(`unsupported requested capability: ${capability}`);
    else if (!skill?.requiredCapabilities?.includes(capability)) errors.push(`capability not declared by skill: ${capability}`);
  }
  if (!skill) errors.push("skill not found");
  else {
    if (!skill.enabled) errors.push("skill is disabled");
    const validation = validateSkill(skill, { registryRoot, checkInstructions });
    errors.push(...validation.errors);
  }
  return { valid: errors.length === 0, errors, code: errors.length ? "SKILL_REQUEST_REJECTED" : null };
}

export function assessSkillCompatibility({ skill, node, projectSignals = [] } = {}) {
  const errors = [];
  if (!skill) errors.push("skill not found");
  if (!node || typeof node !== "object") errors.push("node is required");
  if (skill && !skill.enabled) errors.push("skill is disabled");
  if (skill && node && !(skill.supportedRoles.includes(node.role) || skill.supportedRoles.includes("GENERAL"))) {
    errors.push(`skill does not support node role: ${node.role}`);
  }
  if (skill && node) {
    const taskTypes = [node.taskType, node.type].filter(Boolean);
    if (!taskTypes.some((type) => skill.supportedTaskTypes.includes(type) || skill.supportedTaskTypes.includes("ANY"))) {
      errors.push(`skill does not support node task type: ${node.type}`);
    }
  }
  if (skill?.compatibleProjectSignals?.length > 0) {
    const signals = Array.isArray(projectSignals) ? projectSignals : [];
    if (!signals.length) errors.push("project signals are required for this skill");
    else if (!skill.compatibleProjectSignals.some((signal) => signals.includes(signal))) errors.push("skill is incompatible with project signals");
  }
  return { compatible: errors.length === 0, errors };
}

export function resolveSkillRequest({ registryPath, registryRoot, skillId, version, requestedCapabilities = [], checkInstructions = true } = {}) {
  const registry = readSkillRegistry({ registryPath, registryRoot, checkInstructions });
  const skill = registry.skills.find((candidate) => candidate.skillId === skillId && (!version || candidate.version === version)) ?? null;
  const validation = validateSkillRequest({ skill, requestedCapabilities, registryRoot: registry.registryRoot, checkInstructions });
  if (!validation.valid) throw registryError(`Skill request ditolak fail-closed: ${validation.errors.join("; ")}`, validation.errors.some((error) => error.includes("checksum")) ? "SKILL_CHECKSUM_INVALID" : "SKILL_REQUEST_INVALID", validation);
  return { skill: { ...skill }, registryRevision: registry.revision, requestedCapabilities: [...requestedCapabilities] };
}

export function loadSkillInstructions({ registryPath, registryRoot, skillId, version } = {}) {
  const resolved = resolveSkillRequest({ registryPath, registryRoot, skillId, version });
  const filePath = fs.realpathSync(resolvedInstructionPath(registryRoot ?? path.dirname(registryPath), resolved.skill.instructions.resourcePath));
  return { ...resolved, instructionPath: filePath, instructions: fs.readFileSync(filePath, "utf8") };
}
