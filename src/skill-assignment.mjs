import path from "node:path";
import { defaultSkillRegistryPath, readSkillRegistry, assessSkillCompatibility } from "./skill-registry.mjs";

export { defaultSkillRegistryPath };

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;

function error(message, code, details = null) {
  const item = new Error(message);
  item.code = code;
  item.details = details;
  return item;
}

export function projectSignalsForProjects(projects = []) {
  const entries = Array.isArray(projects) ? projects : projects?.projects ?? [];
  return Object.fromEntries(entries.map((project) => {
    const projectId = project.id ?? project.projectId;
    const signals = [
      projectId,
      project.agent ? `agent:${project.agent}` : null,
      project.blueprint ? String(project.blueprint).toLowerCase() : null,
      ...(Array.isArray(project.tags) ? project.tags.map((t) => String(t).toLowerCase()) : []),
      ...(project.verificationDefaults ?? []).map((script) => `verification:${script}`),
      ...(project.verificationScripts ?? []).map((script) => `verification:${script}`),
      project.graphify ? "graphify" : "no-graphify",
    ];

    const combined = signals.filter(Boolean).join(" ").toLowerCase();
    if (combined.includes("vite") || combined.includes("react") || combined.includes("frontend") || combined.includes("typecheck") || combined.includes("lint") || combined.includes("npm")) {
      signals.push("node", "vite", "react", "frontend-vite", "frontend");
    }
    if (combined.includes("golang") || combined.includes("go") || combined.includes("be-") || combined.includes("backend") || combined.includes("go test") || combined.includes("go vet")) {
      signals.push("go", "golang", "backend-golang", "backend");
    }

    return [projectId, [...new Set(signals.filter(Boolean))]];
  }));
}

export function validateAssignedSkill({ assignment, skill, node, projectSignals = [], checkCompatibility = true } = {}) {
  const errors = [];
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) errors.push("skill assignment must be an object");
  else {
    if (typeof assignment.skillId !== "string" || !ID_PATTERN.test(assignment.skillId)) errors.push("assignment.skillId is invalid");
    if (typeof assignment.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(assignment.version)) errors.push("assignment.version is invalid");
    if (typeof assignment.checksum !== "string" || !SHA256_PATTERN.test(assignment.checksum)) errors.push("assignment.checksum must be a lowercase SHA-256 checksum");
  }
  if (!skill) errors.push("assigned skill is not installed");
  else {
    if (skill.skillId !== assignment?.skillId || skill.version !== assignment?.version) errors.push("assignment does not match installed skill version");
    if (skill.instructions.sha256 !== assignment?.checksum) errors.push("assignment checksum does not match installed skill instructions");
    if (checkCompatibility) {
      const compatibility = assessSkillCompatibility({ skill, node, projectSignals });
      errors.push(...compatibility.errors);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validatePlanSkillAssignments({ plan, runsRoot, registryPath = defaultSkillRegistryPath(runsRoot), projectSignalsByProject = {}, checkInstructions = true, checkCompatibility = true } = {}) {
  const errors = [];
  const nodes = Array.isArray(plan?.nodes) ? plan.nodes : [];
  const assignedNodes = nodes.filter((node) => Array.isArray(node.skills) && node.skills.length > 0);
  if (!assignedNodes.length) return { valid: true, errors: [], assignments: [] };
  let registry;
  try {
    registry = readSkillRegistry({ registryPath, registryRoot: path.dirname(registryPath), checkInstructions });
  } catch (cause) {
    return { valid: false, errors: [cause.message], assignments: [], code: cause.code };
  }
  const assignments = [];
  for (const node of assignedNodes) {
    const identities = new Set();
    for (const assignment of node.skills) {
      const identity = `${assignment?.skillId ?? ""}@${assignment?.version ?? ""}`;
      if (identities.has(identity)) errors.push(`${node.nodeId}: duplicate skill assignment ${identity}`);
      identities.add(identity);
      const skill = registry.skills.find((candidate) => candidate.skillId === assignment?.skillId && candidate.version === assignment?.version) ?? null;
      const validation = validateAssignedSkill({ assignment, skill, node, projectSignals: projectSignalsByProject[node.projectId] ?? [], checkCompatibility });
      errors.push(...validation.errors.map((item) => `${node.nodeId}: ${item}`));
      assignments.push({ nodeId: node.nodeId, assignment });
    }
  }
  return { valid: errors.length === 0, errors, assignments, registryRevision: registry.revision };
}

export function assignmentMetadata(skill) {
  if (!skill) throw error("Skill tidak ditemukan.", "SKILL_NOT_FOUND");
  return { skillId: skill.skillId, version: skill.version, checksum: skill.instructions.sha256 };
}
