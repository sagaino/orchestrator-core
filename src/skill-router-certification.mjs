import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readSkillRegistry } from "./skill-registry.mjs";
import { loadAssignedSkillInstructions, routePlanSkills, routeSkillCandidates } from "./skill-router.mjs";

export const SKILL_ROUTER_CERTIFICATION_SCHEMA_VERSION = 1;
export const SKILL_ROUTER_CERTIFICATION_KIND = "skill-router-certification";

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

function result(id, passed, message, evidence = {}) {
  return { id, status: passed ? "PASS" : "FAIL", passed, message, evidence };
}

function writeBundle(filePath, bundle) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256(text);
  fs.writeFileSync(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, checksum };
}

function withoutSkills(node) {
  const copy = structuredClone(node);
  delete copy.skills;
  return copy;
}

function identity(skill) { return `${skill?.skillId ?? ""}@${skill?.version ?? ""}`; }

function selectedCompatibilityViolations(routes, registry) {
  return routes.flatMap((route) => (route.selectedSkills ?? []).map((selected) => {
    const candidate = (route.candidates ?? []).find((item) => identity(item) === identity(selected));
    const installed = registry.skills.find((item) => identity(item) === identity(selected));
    return candidate && installed ? null : { nodeId: route.nodeId, skill: identity(selected) };
  }).filter(Boolean));
}

export function buildSkillRouterCertificationEvidence({
  registryPath,
  runsRoot,
  pilotPlan,
  expectedSkillByNode = {},
  projectSignalsByProject = {},
  allowedCapabilitiesByNode = {},
  noMatchPolicy = "GENERAL_ROLE_AGENT",
  env = process.env,
  now = new Date(),
} = {}) {
  if (!registryPath || !runsRoot || !pilotPlan || !Array.isArray(pilotPlan.nodes)) throw new Error("Skill Router certification membutuhkan registryPath, runsRoot, dan pilotPlan.");
  const registry = readSkillRegistry({ registryPath, registryRoot: path.dirname(registryPath), checkInstructions: true });
  const expectedEntries = Object.entries(expectedSkillByNode);
  const sourceNodes = pilotPlan.nodes.filter((node) => Object.hasOwn(expectedSkillByNode, node.nodeId));
  const routed = routePlanSkills({
    plan: { ...structuredClone(pilotPlan), nodes: sourceNodes.map((node) => structuredClone(node)) },
    runsRoot,
    registryPath,
    projectSignalsByProject,
    allowedCapabilitiesByNode,
    noMatchPolicy,
    env,
  });
  const routes = routed.routes;
  const routeByNode = new Map(routes.map((route) => [route.nodeId, route]));
  const expectedSelections = expectedEntries.map(([nodeId, skillId]) => ({
    nodeId,
    expected: skillId,
    selected: routeByNode.get(nodeId)?.selectedSkills?.[0]?.skillId ?? null,
    status: routeByNode.get(nodeId)?.status ?? "MISSING",
  }));
  const pilotSelectionPass = expectedSelections.length === 4
    && expectedSelections.every((item) => item.status === "ROUTED" && item.selected === item.expected);
  const incompatibleSelections = selectedCompatibilityViolations(routes, registry);
  const fallbackNode = {
    nodeId: "pilot-fallback",
    projectId: "pilot-project",
    role: "SECURITY",
    type: "SECURITY_REVIEW",
    risk: "LOW",
    allowedPaths: ["security.md"],
    verification: ["test"],
    skills: [],
  };
  const fallback = routeSkillCandidates({
    node: fallbackNode,
    projectSignals: ["security"],
    installedSkills: registry.skills,
    allowedCapabilities: ["context.read"],
    registryRoot: registry.registryRoot,
    checkInstructions: true,
    noMatchPolicy,
  });
  const checksumSource = routes.flatMap((route) => route.selectedSkills ?? [])[0] ?? null;
  let checksumRejection = { rejected: false, code: null };
  if (checksumSource) {
    try {
      loadAssignedSkillInstructions({
        runsRoot,
        registryPath,
        assignments: [{ ...checksumSource, checksum: "0".repeat(64) }],
      });
    } catch (error) {
      checksumRejection = { rejected: error.code === "SKILL_ROUTER_ASSIGNED_SKILL_INVALID", code: error.code ?? null };
    }
  }
  const sourceById = new Map(sourceNodes.map((node) => [node.nodeId, node]));
  const routedById = new Map(routed.plan.nodes.map((node) => [node.nodeId, node]));
  const scopeChanges = sourceNodes.flatMap((node) => {
    const routedNode = routedById.get(node.nodeId);
    return JSON.stringify(withoutSkills(node)) === JSON.stringify(withoutSkills(routedNode ?? {})) ? [] : [{ nodeId: node.nodeId }];
  });
  const checks = [
    result("PILOT_COHORT_SELECTION", pilotSelectionPass, "FE, BE, diagnostic, and integration nodes select their expected compatible skills.", { expectedSelections, registryRevision: registry.revision }),
    result("NO_INCOMPATIBLE_SELECTION", incompatibleSelections.length === 0, "Every selected skill is an eligible installed candidate.", { incompatibleSelections }),
    result("GENERAL_AGENT_FALLBACK", fallback.status === "NO_COMPATIBLE_SKILL" && fallback.fallback === "GENERAL_ROLE_AGENT", "No compatible skill preserves the existing general role agent fallback.", { status: fallback.status, fallback: fallback.fallback, rejected: fallback.rejected }),
    result("CHECKSUM_REJECTION", checksumRejection.rejected, "A stale or altered assignment checksum is rejected fail-closed.", checksumRejection),
    result("SCOPE_PRESERVED", scopeChanges.length === 0 && sourceById.size === routedById.size, "Routing changes only skill assignments and does not broaden node scope or verification.", { scopeChanges, nodeCount: sourceById.size }),
  ];
  const blockers = checks.filter((check) => check.status !== "PASS").map((check) => check.id);
  return {
    schemaVersion: SKILL_ROUTER_CERTIFICATION_SCHEMA_VERSION,
    kind: SKILL_ROUTER_CERTIFICATION_KIND,
    createdAt: now.toISOString(),
    status: blockers.length ? "BLOCKED" : "HUMAN_GATE_REQUIRED",
    humanGate: { required: true, confirmed: false, approvedBy: null, approvedAt: null },
    checks,
    blockers,
    evidence: {
      registry: { path: path.resolve(registryPath), revision: registry.revision, skillCount: registry.skills.length },
      pilotNodeIds: sourceNodes.map((node) => node.nodeId),
      routes,
      fallback,
    },
    nextAction: blockers.length ? "Resolve skill router certification blockers, then rerun certification." : "Human gate must explicitly accept this Skill Router certification.",
  };
}

export function createSkillRouterCertification(options = {}) {
  const evidence = buildSkillRouterCertificationEvidence(options);
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const certificationId = `v2-104-skill-router-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const bundle = { ...evidence, certificationId };
  const bundlePath = path.join(options.runsRoot, "runtime", "certifications", `${certificationId}.json`);
  const persisted = writeBundle(bundlePath, bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.checksum };
}

export function verifySkillRouterCertification({ bundlePath } = {}) {
  if (!bundlePath || !fs.existsSync(bundlePath)) throw new Error("Skill Router certification bundle tidak ditemukan.");
  const text = fs.readFileSync(bundlePath, "utf8");
  let bundle = null;
  try { bundle = JSON.parse(text); } catch { return { valid: false, checksumValid: false, checksPass: false, status: null, bundle: null }; }
  const recorded = fs.existsSync(`${bundlePath}.sha256`) ? fs.readFileSync(`${bundlePath}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
  const checksumValid = recorded === sha256(text);
  const checksPass = Array.isArray(bundle.checks) && bundle.checks.length === 5 && bundle.checks.every((check) => check.status === "PASS");
  const valid = checksumValid && bundle.schemaVersion === SKILL_ROUTER_CERTIFICATION_SCHEMA_VERSION && bundle.kind === SKILL_ROUTER_CERTIFICATION_KIND && checksPass && ["HUMAN_GATE_REQUIRED", "CERTIFIED"].includes(bundle.status);
  return { valid, checksumValid, checksPass, status: bundle.status ?? null, certificationId: bundle.certificationId ?? null, bundle };
}

export function acceptSkillRouterCertification({ bundlePath, approvedBy, now = new Date() } = {}) {
  if (!String(approvedBy ?? "").trim()) throw new Error("Skill Router certification membutuhkan identitas operator.");
  const verification = verifySkillRouterCertification({ bundlePath });
  if (!verification.valid || verification.status !== "HUMAN_GATE_REQUIRED") throw new Error("Skill Router certification belum memenuhi seluruh machine gate atau sudah diproses.");
  const accepted = { ...verification.bundle, status: "CERTIFIED", humanGate: { ...verification.bundle.humanGate, confirmed: true, approvedBy: String(approvedBy).trim(), approvedAt: now.toISOString() }, nextAction: "Skill Router certification accepted; production activation remains a separate explicit operation." };
  const persisted = writeBundle(bundlePath, accepted);
  return { ...accepted, bundlePath: persisted.filePath, checksum: persisted.checksum };
}
