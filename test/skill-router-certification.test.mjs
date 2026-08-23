import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { acceptSkillRouterCertification, createSkillRouterCertification, verifySkillRouterCertification } from "../src/skill-router-certification.mjs";

console.log("Running skill-router-certification.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-router-certification-"));
const runsRoot = path.join(root, "runs");
const registryRoot = path.join(runsRoot, "runtime", "skills");
const registryPath = path.join(registryRoot, "registry.json");
const now = "2026-08-23T00:00:00.000Z";

function skill(skillId, role, taskType, signal) {
  const resourcePath = `${skillId}.md`;
  const instructions = `Apply the bounded ${skillId} checklist.\n`;
  fs.writeFileSync(path.join(registryRoot, resourcePath), instructions);
  return {
    schemaVersion: 1,
    kind: "ai-os-skill",
    skillId,
    version: "1.0.0",
    purpose: `Review ${role} work.`,
    supportedRoles: [role],
    supportedTaskTypes: [taskType],
    requiredContextTypes: ["PLAN"],
    requiredCapabilities: ["context.read"],
    compatibleProjectSignals: [signal],
    riskLevel: "LOW",
    instructions: { resourcePath, sha256: createHash("sha256").update(instructions).digest("hex") },
    verificationRequirements: ["test"],
    enabled: true,
    provenance: { source: "LOCAL_HUMAN", humanInstaller: "local:v2-104-certification", installedAt: now, sourceRef: "fixture" },
  };
}

fs.mkdirSync(registryRoot, { recursive: true });
const skills = [
  skill("frontend-review", "FRONTEND", "IMPLEMENTATION", "frontend"),
  skill("backend-review", "BACKEND", "IMPLEMENTATION", "backend"),
  skill("diagnostic-review", "DIAGNOSTIC", "DIAGNOSTIC", "diagnostic"),
  skill("integration-review", "INTEGRATION", "INTEGRATION", "integration"),
];
fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, kind: "ai-os-skill-registry", revision: 7, updatedAt: now, agentWritable: false, skills }, null, 2));

const node = (nodeId, role, type, projectId, allowedPath) => ({ nodeId, projectId, role, type, risk: "LOW", allowedPaths: [allowedPath], verification: ["test"], allowedCapabilities: ["context.read"], skills: [] });
const pilotPlan = {
  planId: "pilot-plan",
  nodes: [
    node("P-FE", "FRONTEND", "IMPLEMENTATION", "frontend-app", "src/ui.tsx"),
    node("P-BE", "BACKEND", "IMPLEMENTATION", "backend-api", "src/api.mjs"),
    node("P-DIAG", "DIAGNOSTIC", "DIAGNOSTIC", "diagnostic-app", "reports/diagnostic.json"),
    node("P-INT", "INTEGRATION", "INTEGRATION", "integration-app", "src/integration.mjs"),
  ],
};

try {
  const certification = createSkillRouterCertification({
    runsRoot,
    registryPath,
    pilotPlan,
    expectedSkillByNode: { "P-FE": "frontend-review", "P-BE": "backend-review", "P-DIAG": "diagnostic-review", "P-INT": "integration-review" },
    projectSignalsByProject: { "frontend-app": ["frontend"], "backend-api": ["backend"], "diagnostic-app": ["diagnostic"], "integration-app": ["integration"] },
    allowedCapabilitiesByNode: { "P-FE": ["context.read"], "P-BE": ["context.read"], "P-DIAG": ["context.read"], "P-INT": ["context.read"] },
    env: { ORCHESTRATOR_SKILLS_ENABLED: "1", ORCHESTRATOR_SKILL_AUTO_ROUTING: "1" },
    now: new Date(now),
  });
  assert.equal(certification.status, "HUMAN_GATE_REQUIRED", JSON.stringify(certification, null, 2));
  assert.deepEqual(certification.checks.map((check) => check.status), ["PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.equal(certification.evidence.routes.length, 4);
  assert.equal(verifySkillRouterCertification({ bundlePath: certification.bundlePath }).valid, true);

  const accepted = acceptSkillRouterCertification({ bundlePath: certification.bundlePath, approvedBy: "local:v2-104-operator", now: new Date("2026-08-23T01:00:00.000Z") });
  assert.equal(accepted.status, "CERTIFIED");
  assert.equal(verifySkillRouterCertification({ bundlePath: certification.bundlePath }).valid, true);

  fs.appendFileSync(certification.bundlePath, "tamper");
  assert.equal(verifySkillRouterCertification({ bundlePath: certification.bundlePath }).valid, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("skill-router-certification.test.mjs: All tests passed!");
