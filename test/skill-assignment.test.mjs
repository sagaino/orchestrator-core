import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createObjective } from "../src/objective-store.mjs";
import { createPlan, getPlan } from "../src/plan-store.mjs";
import { assignPlanSkills, approvePlan } from "../src/plan-lifecycle.mjs";

console.log("Running skill-assignment.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-assignment-"));
const runsRoot = path.join(root, "runs");
const skillRoot = path.join(runsRoot, "runtime", "skills");
const registryPath = path.join(skillRoot, "registry.json");
const instructionPath = path.join(skillRoot, "backend-review.md");
const instructionText = "Review the backend implementation within the approved node scope.\n";
const checksum = createHash("sha256").update(instructionText).digest("hex");
const timestamp = "2026-08-23T00:00:00.000Z";
const objectiveId = "objective-skill-assignment";
const planId = "plan-objective-skill-assignment-r1";
const budget = { maxSubtasks: 2, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: 1000, deadlineAt: null };
const node = { nodeId: "N01", title: "Implement backend", purpose: "Implement the bounded backend change.", projectId: "skill-project", role: "BACKEND", type: "IMPLEMENTATION", dependsOn: [], acceptanceCriteria: ["Backend change is verified."], allowedPaths: ["src/feature.js"], verification: ["test"], risk: "LOW", complexity: "LOW", requiresChanges: true, canRunInParallel: false, writeConflictGroup: "backend", contextFrom: [], skills: [] };

fs.mkdirSync(skillRoot, { recursive: true });
fs.writeFileSync(instructionPath, instructionText);
fs.writeFileSync(registryPath, JSON.stringify({
  schemaVersion: 1,
  kind: "ai-os-skill-registry",
  revision: 3,
  updatedAt: timestamp,
  agentWritable: false,
  skills: [{
    schemaVersion: 1,
    kind: "ai-os-skill",
    skillId: "backend-review",
    version: "1.0.0",
    purpose: "Review bounded backend changes.",
    supportedRoles: ["BACKEND"],
    supportedTaskTypes: ["IMPLEMENTATION"],
    requiredContextTypes: ["PLAN"],
    requiredCapabilities: ["context.read", "repository.read"],
    compatibleProjectSignals: ["backend"],
    riskLevel: "LOW",
    instructions: { resourcePath: "backend-review.md", sha256: checksum },
    verificationRequirements: ["test"],
    enabled: true,
    provenance: { source: "LOCAL_HUMAN", humanInstaller: "local:skill-admin", installedAt: timestamp, sourceRef: "git:backend-review@1.0.0" },
  }],
}, null, 2));

try {
  createObjective({ runsRoot, record: { schemaVersion: 1, revision: 0, objectiveId, mode: "EXISTING_PROJECT", state: "PLAN_REVIEW", request: "Assign a bounded backend skill.", requestedBy: "local:operator", projectIds: ["skill-project"], freshProject: null, activePlanId: planId, activeOrchestrationId: null, budget, createdAt: timestamp, updatedAt: timestamp } });
  createPlan({ runsRoot, record: { schemaVersion: 1, revision: 1, planId, objectiveId, state: "PENDING_APPROVAL", summary: "Skill assignment fixture.", architectureDecisions: [], assumptions: [], clarificationNeeded: false, clarificationQuestion: null, projects: ["skill-project"], nodes: [node], integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false }, risk: "LOW", complexity: "LOW", approvedBy: null, approvedAt: null, createdAt: timestamp, updatedAt: timestamp }, validationOptions: { knownProjectIds: ["skill-project"], budget } });

  const assigned = assignPlanSkills({ runsRoot, objectiveId, assignments: [{ nodeId: "N01", skillId: "backend-review", version: "1.0.0" }], assignedBy: "local:operator", registryPath, projectSignalsByProject: { "skill-project": ["backend"] }, now: new Date("2026-08-23T01:00:00.000Z") });
  assert.equal(assigned.plan.revision, 2);
  assert.equal(assigned.plan.nodes[0].skills[0].skillId, "backend-review");
  assert.equal(assigned.plan.nodes[0].skills[0].checksum, checksum);
  assert.deepEqual(assigned.plan.nodes[0].allowedPaths, node.allowedPaths, "skill assignment must not broaden node write scope");
  assert.deepEqual(assigned.plan.nodes[0].verification, node.verification, "skill assignment must not change node verification scope");
  assert.equal(assigned.decision.type, "SKILL_ASSIGNMENT");
  assert.equal(getPlan(runsRoot, planId, { knownProjectIds: ["skill-project"], budget }).state, "SUPERSEDED");

  const approved = approvePlan({ runsRoot, objectiveId, planId: assigned.plan.planId, expectedFingerprint: assigned.plan.planFingerprint, approvedBy: "local:operator" });
  assert.equal(approved.plan.state, "APPROVED");

  assert.throws(
    () => assignPlanSkills({ runsRoot, objectiveId, assignments: [{ nodeId: "N01", skillId: "backend-review", version: "1.0.0", checksum: "0".repeat(64) }], assignedBy: "local:operator", registryPath, projectSignalsByProject: { "skill-project": ["backend"] } }),
    (error) => error.code === "SKILL_ASSIGNMENT_PLAN_NOT_EDITABLE",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("skill-assignment.test.mjs: All tests passed!");
