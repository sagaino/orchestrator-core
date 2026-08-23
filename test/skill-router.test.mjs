import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildAgyInvocation } from "../src/executor.mjs";
import { routeSkillCandidates, routePlanSkills, loadAssignedSkillInstructions } from "../src/skill-router.mjs";

console.log("Running skill-router.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-router-"));
const runsRoot = path.join(root, "runs");
const skillRoot = path.join(runsRoot, "runtime", "skills");
const instruction = "Use the approved backend review checklist only.\n";
const checksum = createHash("sha256").update(instruction).digest("hex");
const skill = {
  schemaVersion: 1,
  kind: "ai-os-skill",
  skillId: "backend-review",
  version: "1.0.0",
  purpose: "Review backend changes.",
  supportedRoles: ["BACKEND"],
  supportedTaskTypes: ["IMPLEMENTATION"],
  requiredContextTypes: ["PLAN"],
  requiredCapabilities: ["context.read"],
  compatibleProjectSignals: ["backend"],
  riskLevel: "LOW",
  instructions: { resourcePath: "backend-review.md", sha256: checksum },
  verificationRequirements: ["test"],
  enabled: true,
  provenance: { source: "LOCAL_HUMAN", humanInstaller: "local:router-test", installedAt: "2026-08-23T00:00:00.000Z", sourceRef: "fixture" },
};
const node = {
  nodeId: "N01",
  role: "BACKEND",
  type: "IMPLEMENTATION",
  risk: "LOW",
  allowedPaths: ["src/api.js"],
  verification: ["test"],
  skills: [],
};

fs.mkdirSync(skillRoot, { recursive: true });
fs.writeFileSync(path.join(skillRoot, "backend-review.md"), instruction);
fs.writeFileSync(path.join(skillRoot, "registry.json"), JSON.stringify({
  schemaVersion: 1,
  kind: "ai-os-skill-registry",
  revision: 4,
  updatedAt: "2026-08-23T00:00:00.000Z",
  agentWritable: false,
  skills: [skill],
}, null, 2));

try {
  const routed = routeSkillCandidates({ node, projectSignals: ["backend"], installedSkills: [skill], allowedCapabilities: ["context.read"] });
  assert.equal(routed.status, "ROUTED");
  assert.equal(routed.deterministic, true);
  assert.deepEqual(routed.selectedSkills, [{ skillId: "backend-review", version: "1.0.0", checksum, reason: "exact-role,exact-task-type,project-signal-match,checksum-valid,enabled" }]);

  const noMatch = routeSkillCandidates({ node: { ...node, role: "FRONTEND" }, projectSignals: ["frontend"], installedSkills: [skill] });
  assert.equal(noMatch.status, "NO_COMPATIBLE_SKILL");
  assert.equal(noMatch.fallback, "GENERAL_ROLE_AGENT");

  const humanDecision = routeSkillCandidates({ node: { ...node, role: "FRONTEND" }, projectSignals: ["frontend"], installedSkills: [skill], noMatchPolicy: "HUMAN_DECISION" });
  assert.equal(humanDecision.fallback, "HUMAN_DECISION");

  const routedPlan = routePlanSkills({
    plan: { ...node, nodes: [{ ...node, projectId: "app" }] },
    runsRoot,
    projectSignalsByProject: { app: ["backend"] },
  });
  assert.equal(routedPlan.registryRevision, 4);
  assert.equal(routedPlan.plan.nodes[0].skills[0].skillId, "backend-review");
  assert.deepEqual(routedPlan.plan.nodes[0].allowedPaths, node.allowedPaths);

  const assignments = [{ skillId: "backend-review", version: "1.0.0", checksum }];
  const loaded = loadAssignedSkillInstructions({ assignments, runsRoot });
  assert.equal(loaded[0].instructions, instruction);
  assert.throws(() => loadAssignedSkillInstructions({ assignments: [{ skillId: "missing", version: "1.0.0", checksum }], runsRoot }), (error) => error.code === "SKILL_ROUTER_ASSIGNED_SKILL_INVALID");

  const invocation = buildAgyInvocation({
    runId: "run-router-test",
    project: { agent: "agy", repository: root },
    task: { title: "Router test", path: "task.md", allowedPaths: ["src/api.js"], risk: "LOW", complexity: "LOW", role: "BACKEND", skills: assignments },
    retrieval: { knowledge: [] },
  }, root, { runsRoot, repository: root });
  assert.match(invocation.args[invocation.args.indexOf("-p") + 1], /Use the approved backend review checklist only/);
  assert.deepEqual(invocation.skillRouting, assignments);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("skill-router.test.mjs: All tests passed!");
