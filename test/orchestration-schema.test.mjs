import assert from "node:assert/strict";
import {
  validateDecisionRecord,
  validateObjectiveRecord,
  validateOrchestrationRecord,
  validatePlanRecord,
} from "../src/orchestration-schema.mjs";

console.log("Running orchestration-schema.test.mjs...");

const timestamp = "2026-08-22T00:00:00.000Z";
const baseObjective = {
  schemaVersion: 1,
  revision: 0,
  objectiveId: "obj-demo",
  mode: "EXISTING_PROJECT",
  state: "PLANNING",
  request: "Fix checkout and verify the affected project.",
  requestedBy: "user",
  projectIds: ["shop"],
  freshProject: null,
  activePlanId: null,
  activeOrchestrationId: null,
  budget: { maxSubtasks: 4, maxParallelAgents: 2, maxRetriesPerNode: 2, maxTotalTokens: null, deadlineAt: null },
  createdAt: timestamp,
  updatedAt: timestamp,
};

const diagnosticNode = {
  nodeId: "N01",
  title: "Diagnose checkout",
  purpose: "Identify the verified checkout root cause.",
  projectId: "shop",
  role: "DIAGNOSTIC",
  type: "DIAGNOSTIC",
  dependsOn: [],
  acceptanceCriteria: ["Root cause is reproducible and recorded."],
  allowedPaths: [],
  verification: ["test"],
  risk: "LOW",
  complexity: "LOW",
  requiresChanges: false,
  canRunInParallel: false,
  writeConflictGroup: null,
  contextFrom: [],
  skills: [],
};

const implementationNode = {
  nodeId: "N02",
  title: "Repair checkout",
  purpose: "Apply the smallest verified checkout fix.",
  projectId: "shop",
  role: "BACKEND",
  type: "IMPLEMENTATION",
  dependsOn: ["N01"],
  acceptanceCriteria: ["Regression test passes after the fix."],
  allowedPaths: ["src/checkout/**", "test/checkout/**"],
  verification: ["test", "build"],
  risk: "MEDIUM",
  complexity: "MEDIUM",
  requiresChanges: true,
  canRunInParallel: false,
  writeConflictGroup: "shop:checkout",
  contextFrom: ["N01"],
  skills: [],
};

const basePlan = {
  schemaVersion: 1,
  planId: "plan-demo-r1",
  objectiveId: "obj-demo",
  revision: 1,
  state: "PENDING_APPROVAL",
  summary: "Diagnose and repair checkout.",
  architectureDecisions: [],
  assumptions: [],
  clarificationNeeded: false,
  clarificationQuestion: null,
  projects: ["shop"],
  nodes: [diagnosticNode, implementationNode],
  integration: { required: true, projectVerification: ["test"], crossProjectVerification: [], previewRequired: true },
  risk: "MEDIUM",
  complexity: "MEDIUM",
  approvedBy: null,
  approvedAt: null,
  createdAt: timestamp,
};

const planOptions = {
  knownProjectIds: ["shop"],
  projectVerificationScripts: { shop: ["test", "build"] },
  maxSubtasks: 4,
  maxParallelAgents: 2,
  maxRisk: "HIGH",
};

const baseOrchestration = {
  schemaVersion: 1,
  revision: 0,
  orchestrationId: "orch-demo",
  objectiveId: "obj-demo",
  planId: "plan-demo-r1",
  state: "RUNNING",
  planFingerprint: "a".repeat(64),
  nodes: {
    N01: { state: "DONE", taskId: "SHOP-101", jobId: "job-1", runId: "run-1", attempt: 1, blockedBy: [], lastError: null },
    N02: { state: "QUEUED", taskId: "SHOP-102", jobId: "job-2", runId: null, attempt: 1, blockedBy: [], lastError: null },
  },
  integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null },
  usage: { totalTokens: 0, agentInvocations: 1, retries: 0 },
  createdAt: timestamp,
  updatedAt: timestamp,
};

const baseDecision = {
  schemaVersion: 1,
  revision: 0,
  decisionId: "decision-demo",
  objectiveId: "obj-demo",
  nodeId: "N02",
  runId: "run-1",
  type: "NODE_RETRY",
  state: "OPEN",
  evidence: { reason: "provider timeout" },
  requestedAction: "Retry the failed node",
  allowedChoices: ["RETRY", "CANCEL"],
  creator: "SYSTEM",
  createdAt: timestamp,
  resolution: null,
};

assert.equal(validateObjectiveRecord(baseObjective).valid, true);
assert.equal(validatePlanRecord(basePlan, planOptions).valid, true);
const governedPlanV2 = {
  ...basePlan,
  schemaVersion: 2,
  verificationIntent: {
    contractVersion: 2,
    required: [{ projectId: "shop", capability: "UNIT", requestedAs: "test", source: "PLAN" }],
    resolved: [{ projectId: "shop", capability: "UNIT", requestedAs: "test", source: "PLAN", script: "test" }],
    waived: [],
    missing: [],
    status: "RESOLVED",
  },
};
assert.equal(validatePlanRecord(governedPlanV2, planOptions).valid, true, "new plans persist and validate as contract v2");
assert.equal(validatePlanRecord({ ...governedPlanV2, verificationIntent: undefined }, planOptions).valid, false, "contract v2 fails closed without governance intent");
assert.equal(validatePlanRecord({ ...governedPlanV2, verificationIntent: { ...governedPlanV2.verificationIntent, contractVersion: 1 } }, planOptions).valid, false, "contract v2 rejects legacy verification intent");
assert.equal(validatePlanRecord(basePlan, planOptions).valid, true, "historical contract v1 remains readable");
const widerThanBudgetPlan = {
  ...basePlan,
  nodes: [
    diagnosticNode,
    ...["N02", "N03", "N04"].map((nodeId, index) => ({
      ...implementationNode,
      nodeId,
      dependsOn: [],
      allowedPaths: [`src/checkout-${index}/**`],
      writeConflictGroup: `shop:checkout-${index}`,
      contextFrom: [],
      canRunInParallel: true,
    })),
  ],
};
assert.equal(validatePlanRecord(widerThanBudgetPlan, planOptions).valid, true, "parallel width may exceed the worker ceiling and be queued by the scheduler");
assert.equal(validateOrchestrationRecord(baseOrchestration, { plan: basePlan }).valid, true);
assert.equal(validateDecisionRecord(baseDecision).valid, true);
assert.equal(validateDecisionRecord({ ...baseDecision, type: "VERIFICATION_DECISION" }).valid, true);

const invalidCases = [
  ["objective future schema", () => validateObjectiveRecord({ ...baseObjective, schemaVersion: 2 })],
  ["plan future schema", () => validatePlanRecord({ ...basePlan, schemaVersion: 3 }, planOptions)],
  ["orchestration future schema", () => validateOrchestrationRecord({ ...baseOrchestration, schemaVersion: 2 })],
  ["decision future schema", () => validateDecisionRecord({ ...baseDecision, schemaVersion: 2 })],
  ["cycle", () => validatePlanRecord({ ...basePlan, nodes: [{ ...diagnosticNode, dependsOn: ["N02"] }, implementationNode] }, planOptions)],
  ["self dependency", () => validatePlanRecord({ ...basePlan, nodes: [{ ...diagnosticNode, dependsOn: ["N01"] }, implementationNode] }, planOptions)],
  ["missing dependency reference", () => validatePlanRecord({ ...basePlan, nodes: [{ ...diagnosticNode, dependsOn: ["N99"] }, implementationNode] }, planOptions)],
  ["duplicate node id", () => validatePlanRecord({ ...basePlan, nodes: [diagnosticNode, { ...implementationNode, nodeId: "N01" }] }, planOptions)],
  ["unknown project", () => validatePlanRecord({ ...basePlan, projects: ["missing"], nodes: [{ ...diagnosticNode, projectId: "missing" }, { ...implementationNode, projectId: "missing", dependsOn: ["N01"] }] }, planOptions)],
  ["unsafe path", () => validatePlanRecord({ ...basePlan, nodes: [{ ...implementationNode, dependsOn: [], allowedPaths: ["../secrets/**"] }] }, planOptions)],
  ["missing acceptance criteria", () => validatePlanRecord({ ...basePlan, nodes: [{ ...diagnosticNode, acceptanceCriteria: [] }, implementationNode] }, planOptions)],
  ["unsupported verification script", () => validatePlanRecord({ ...basePlan, nodes: [{ ...implementationNode, dependsOn: [], verification: ["deploy"] }] }, planOptions)],
  ["diagnostic writes", () => validatePlanRecord({ ...basePlan, nodes: [{ ...diagnosticNode, allowedPaths: ["src/**"], requiresChanges: true }, implementationNode] }, planOptions)],
  ["parallel conflict group", () => validatePlanRecord({ ...basePlan, nodes: [{ ...implementationNode, nodeId: "N02", dependsOn: [], canRunInParallel: true }, { ...implementationNode, nodeId: "N03", dependsOn: [], canRunInParallel: true }] }, planOptions)],
  ["implementation without paths", () => validatePlanRecord({ ...basePlan, nodes: [{ ...implementationNode, allowedPaths: [] }] }, planOptions)],
  ["budget ceiling", () => validatePlanRecord({ ...basePlan, nodes: [diagnosticNode, implementationNode, { ...implementationNode, nodeId: "N03", dependsOn: ["N01"] }, { ...implementationNode, nodeId: "N04", dependsOn: ["N01"] }, { ...implementationNode, nodeId: "N05", dependsOn: ["N01"] }] }, { ...planOptions, maxSubtasks: 4 })],
];
for (const [label, makeInvalid] of invalidCases) assert.equal(makeInvalid().valid, false, `${label} should be rejected`);

const immutableInput = structuredClone(basePlan);
const beforeValidation = structuredClone(immutableInput);
validatePlanRecord(immutableInput, planOptions);
assert.deepEqual(immutableInput, beforeValidation, "validator must not mutate input");

const resolvedDecision = {
  ...baseDecision,
  state: "RESOLVED",
  resolution: { action: "RETRY", resolvedBy: "operator", resolvedAt: timestamp },
};
assert.equal(validateDecisionRecord(resolvedDecision).valid, true);
assert.equal(validateDecisionRecord({ ...resolvedDecision, resolution: { ...resolvedDecision.resolution, action: "NOT_ALLOWED" } }).valid, false);

console.log("orchestration-schema.test.mjs: All tests passed!");
