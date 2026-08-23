import assert from "node:assert/strict";
import {
  CROSS_PROJECT_DIAGNOSTIC_OUTCOMES,
  crossProjectDiagnosticSchema,
  diagnoseCrossProject,
  validateCrossProjectDiagnostic,
  validateCrossProjectPlan,
} from "../src/cross-project-diagnostics.mjs";
import { decomposeProject } from "../src/project-decomposer.mjs";

console.log("Running cross-project-diagnostics.test.mjs...");

const timestamp = "2026-08-23T00:00:00.000Z";
const objective = {
  objectiveId: "obj-linked-incident",
  mode: "CROSS_PROJECT_INCIDENT",
  request: "Diagnose the checkout incident across the frontend and backend.",
  projectIds: ["frontend", "backend"],
  budget: { maxSubtasks: 5, maxParallelAgents: 3, maxRetriesPerNode: 2, maxTotalTokens: 50_000, deadlineAt: null },
};

const projectContexts = [
  { projectId: "frontend", role: "FRONTEND", repository: "/tmp/frontend", summary: "Browser application.", verificationScripts: ["test:frontend"] },
  { projectId: "backend", role: "BACKEND", repository: "/tmp/backend", summary: "API service.", verificationScripts: ["test:backend", "test:contract"] },
];

function evidence(projectId, source = "fixture") {
  return {
    evidenceId: `E-${projectId}`,
    projectId,
    source,
    reproduction: `Run ${source} fixture for ${projectId} and observe the deterministic failure.`,
    observation: `${projectId} reports a reproducible failure marker.`,
    expected: "The request completes successfully.",
    actual: "The request fails with the fixture marker.",
  };
}

function diagnosis(outcome, implicatedProjects, clarification = null) {
  return {
    schemaVersion: 1,
    diagnosticId: "diagnostic-obj-linked-incident-r1",
    objectiveId: objective.objectiveId,
    outcome,
    summary: `${outcome} fixture diagnosis with reproducible evidence.`,
    evidence: implicatedProjects.length ? implicatedProjects.map((projectId) => evidence(projectId, `mock-${outcome.toLowerCase()}`)) : [evidence("frontend", `mock-${outcome.toLowerCase()}`)],
    implicatedProjects,
    confidence: outcome === "UNDETERMINED" ? "LOW" : "HIGH",
    clarificationNeeded: outcome === "UNDETERMINED",
    clarificationQuestion: clarification,
    readOnly: true,
  };
}

assert.deepEqual(crossProjectDiagnosticSchema().properties.outcome.enum, CROSS_PROJECT_DIAGNOSTIC_OUTCOMES);

for (const [outcome, implicated] of [
  ["FRONTEND", ["frontend"]],
  ["BACKEND", ["backend"]],
  ["BOTH", ["frontend", "backend"]],
  ["CONTRACT", ["frontend", "backend"]],
  ["INFRASTRUCTURE", ["backend"]],
]) {
  const parsed = diagnosis(outcome, implicated);
  assert.deepEqual(validateCrossProjectDiagnostic(parsed, objective), [], `${outcome} fixture should validate`);
  const result = await diagnoseCrossProject({
    objective,
    projectContexts,
    processRunner: async (input) => {
      assert.equal(input.stage, "cross-project-diagnostic");
      assert.equal(input.readOnly, true);
      assert.equal(input.args[input.args.indexOf("--mode") + 1], "plan");
      return { exitCode: 0, stdoutTail: JSON.stringify(parsed), finalResult: parsed };
    },
  });
  assert.equal(result.status, "DIAGNOSIS_READY");
  assert.equal(result.readOnly, true);
  assert.equal(result.diagnosis.outcome, outcome);
  assert.equal(result.planning.jobsCreated, 0);
}

const unknown = diagnosis("UNDETERMINED", [], "Capture the failing request and identify whether the first divergent signal is in FE or BE.");
const unknownResult = await diagnoseCrossProject({
  objective,
  projectContexts,
  processRunner: async () => ({ exitCode: 0, stdoutTail: JSON.stringify(unknown) }),
});
assert.equal(unknownResult.status, "NEEDS_CLARIFICATION");
assert.equal(unknownResult.objectiveState, "NEEDS_CLARIFICATION");
assert.equal(unknownResult.clarificationNeeded, true);
assert.equal(unknownResult.planning.tasksCreated, 0);

const invalidEvidence = { ...diagnosis("FRONTEND", ["frontend"]), evidence: [{ ...evidence("frontend"), reproduction: "" }] };
assert.ok(validateCrossProjectDiagnostic(invalidEvidence, objective).some((message) => message.includes("reproduction")));

const contractPlan = {
  schemaVersion: 1,
  planId: "plan-obj-linked-incident-r1",
  objectiveId: objective.objectiveId,
  revision: 1,
  state: "PENDING_APPROVAL",
  summary: "Coordinate the frontend and backend contract repair.",
  architectureDecisions: ["Keep diagnosis read-only before implementation."],
  assumptions: [],
  clarificationNeeded: false,
  clarificationQuestion: null,
  projects: ["backend", "frontend"],
  nodes: [
    {
      nodeId: "N01",
      title: "Repair frontend contract consumer",
      purpose: "Update the frontend request handling implicated by the reproduced contract failure.",
      projectId: "frontend",
      role: "FRONTEND",
      type: "IMPLEMENTATION",
      dependsOn: [],
      acceptanceCriteria: ["Frontend consumes the agreed response contract."],
      allowedPaths: ["src/api/**"],
      verification: ["test:frontend"],
      risk: "MEDIUM",
      complexity: "MEDIUM",
      requiresChanges: true,
      canRunInParallel: true,
      writeConflictGroup: "frontend-contract",
      contextFrom: [],
      skills: [],
    },
    {
      nodeId: "N02",
      title: "Repair backend contract provider",
      purpose: "Update the backend response boundary implicated by the reproduced contract failure.",
      projectId: "backend",
      role: "BACKEND",
      type: "IMPLEMENTATION",
      dependsOn: [],
      acceptanceCriteria: ["Backend exposes the agreed response contract."],
      allowedPaths: ["src/api/**"],
      verification: ["test:backend"],
      risk: "MEDIUM",
      complexity: "MEDIUM",
      requiresChanges: true,
      canRunInParallel: true,
      writeConflictGroup: "backend-contract",
      contextFrom: [],
      skills: [],
    },
    {
      nodeId: "N03",
      title: "Verify contract compatibility",
      purpose: "Run the reproducible contract verification after both implicated repairs.",
      projectId: "backend",
      role: "INTEGRATION",
      type: "VERIFICATION",
      dependsOn: ["N01", "N02"],
      acceptanceCriteria: ["Contract verification passes for the frontend/backend boundary."],
      allowedPaths: [],
      verification: ["test:contract"],
      risk: "MEDIUM",
      complexity: "MEDIUM",
      requiresChanges: false,
      canRunInParallel: false,
      writeConflictGroup: null,
      contextFrom: ["N01", "N02"],
      skills: [],
    },
  ],
  integration: { required: true, projectVerification: ["test:frontend", "test:backend"], crossProjectVerification: ["test:contract"], previewRequired: true },
  risk: "MEDIUM",
  complexity: "HIGH",
  approvedBy: null,
  approvedAt: null,
  createdAt: timestamp,
};

assert.deepEqual(validateCrossProjectPlan(contractPlan, diagnosis("CONTRACT", ["frontend", "backend"]), objective), []);
assert.ok(validateCrossProjectPlan({ ...contractPlan, nodes: contractPlan.nodes.filter((node) => node.nodeId !== "N02") }, diagnosis("CONTRACT", ["frontend", "backend"]), objective).some((message) => message.includes("BACKEND")));

const calls = [];
const decomposed = await decomposeProject({
  objective,
  projectContexts,
  processRunner: async (input) => {
    calls.push(input);
    if (input.stage === "cross-project-diagnostic") return { exitCode: 0, stdoutTail: JSON.stringify(diagnosis("CONTRACT", ["frontend", "backend"])) };
    return { exitCode: 0, stdoutTail: JSON.stringify(contractPlan) };
  },
});
assert.equal(calls.map((call) => call.stage).join(","), "cross-project-diagnostic,project-decomposition");
assert.equal(decomposed.status, "PLAN_REVIEW");
assert.equal(decomposed.diagnostic.outcome, "CONTRACT");
assert.equal(decomposed.plan.nodes.filter((node) => node.type === "IMPLEMENTATION").length, 2);
assert.equal(decomposed.planning.jobsCreated, 0);

const unknownCalls = [];
const blocked = await decomposeProject({
  objective,
  projectContexts,
  processRunner: async (input) => {
    unknownCalls.push(input.stage);
    return { exitCode: 0, stdoutTail: JSON.stringify(unknown) };
  },
});
assert.equal(blocked.status, "NEEDS_CLARIFICATION");
assert.deepEqual(unknownCalls, ["cross-project-diagnostic"]);

console.log("cross-project-diagnostics.test.mjs: All tests passed!");
