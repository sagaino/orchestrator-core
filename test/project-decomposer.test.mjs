import assert from "node:assert/strict";
import {
  decompositionOutputSchema,
  decomposeProject,
  normalizePlanAllowedPaths,
  parseDecompositionResult,
} from "../src/project-decomposer.mjs";
import { resolveAgentRoute } from "../src/agent-routing.mjs";
import { contextBudget } from "../src/context-compactor.mjs";

console.log("Running project-decomposer.test.mjs...");

const timestamp = "2026-08-22T00:00:00.000Z";
const objective = {
  objectiveId: "obj-shop",
  mode: "EXISTING_PROJECT",
  request: "Diagnose checkout and repair the affected project safely.",
  projectIds: ["shop"],
  budget: { maxSubtasks: 4, maxParallelAgents: 2, maxRetriesPerNode: 2, maxTotalTokens: 20_000, deadlineAt: null },
};

const plan = {
  schemaVersion: 2,
  planId: "plan-obj-shop-r1",
  objectiveId: "obj-shop",
  revision: 1,
  state: "PENDING_APPROVAL",
  summary: "Diagnose checkout and repair the affected project.",
  architectureDecisions: [],
  assumptions: [],
  clarificationNeeded: false,
  clarificationQuestion: null,
  projects: ["shop"],
  nodes: [{
    nodeId: "N01",
    title: "Diagnose checkout",
    purpose: "Identify the verified checkout root cause.",
    projectId: "shop",
    role: "DIAGNOSTIC",
    type: "DIAGNOSTIC",
    dependsOn: [],
    acceptanceCriteria: ["Root cause is recorded."],
    allowedPaths: [],
    verification: ["test"],
    risk: "LOW",
    complexity: "MEDIUM",
    requiresChanges: false,
    canRunInParallel: false,
    writeConflictGroup: null,
    contextFrom: [],
    skills: [],
  }],
  integration: { required: true, projectVerification: ["shop:test"], crossProjectVerification: [], previewRequired: true },
  risk: "MEDIUM",
  complexity: "MEDIUM",
  approvedBy: null,
  approvedAt: null,
  createdAt: timestamp,
};

assert.equal(decompositionOutputSchema().oneOf.length, 2);
assert.deepEqual(parseDecompositionResult({ stdoutTail: JSON.stringify(plan) }), plan);
assert.deepEqual(parseDecompositionResult({ stdoutTail: JSON.stringify({ conversation_id: "fixture", status: "SUCCESS", response: JSON.stringify(plan), error: null }) }), plan);
assert.deepEqual(parseDecompositionResult({ stdoutTail: JSON.stringify({ conversation_id: "fixture", status: "SUCCESS", response: JSON.stringify({ ...plan, toolAction: "Complete planning", toolSummary: "Finish task" }), error: null }) }), plan);
assert.deepEqual(parseDecompositionResult({ stdoutTail: JSON.stringify({ conversation_id: "fixture", status: "ERROR", response: "invalid intermediate output", error: "schema retry failed", structured_output: plan }) }), plan);
assert.throws(() => parseDecompositionResult({ stdoutTail: JSON.stringify({ conversation_id: "fixture", status: "ERROR", response: JSON.stringify(plan), error: "provider tool failed" }) }), (error) => error.code === "PROVIDER_FAILED");
assert.throws(() => parseDecompositionResult({ stdoutTail: JSON.stringify({ conversation_id: "fixture", status: "SUCCESS", response: `${JSON.stringify(plan)}\n${JSON.stringify(plan)}`, error: null }) }), (error) => error.code === "INVALID_DECOMPOSITION_OUTPUT");
assert.throws(() => parseDecompositionResult({ stdoutTail: `Here is the plan:\n${JSON.stringify(plan)}` }), (error) => error.code === "INVALID_DECOMPOSITION_OUTPUT");
assert.throws(() => parseDecompositionResult({ stdoutTail: `${JSON.stringify(plan)}\n${JSON.stringify(plan)}` }), (error) => error.code === "INVALID_DECOMPOSITION_OUTPUT");

const absolutePathPlan = {
  ...plan,
  nodes: [{
    ...plan.nodes[0],
    type: "IMPLEMENTATION",
    requiresChanges: true,
    writeConflictGroup: "checkout",
    allowedPaths: ["/tmp/shop/src/fixture.js"],
  }],
};
assert.deepEqual(
  normalizePlanAllowedPaths(absolutePathPlan, [{ projectId: "shop", repository: "/tmp/shop" }]).nodes[0].allowedPaths,
  ["src/fixture.js"],
);
assert.deepEqual(
  normalizePlanAllowedPaths({ ...absolutePathPlan, nodes: [{ ...absolutePathPlan.nodes[0], allowedPaths: ["/tmp/other/src/fixture.js"] }] }, [{ projectId: "shop", repository: "/tmp/shop" }]).nodes[0].allowedPaths,
  ["/tmp/other/src/fixture.js"],
);

const calls = [];
const success = await decomposeProject({
  objective,
  projectContexts: [{ projectId: "shop", repository: "/tmp/shop", summary: "CONTEXT-MARKER ".repeat(5000), verificationScripts: ["test"] }],
  knowledge: [{ path: "knowledge.md", summary: "Use the stable checkout adapter." }],
  now: new Date(timestamp),
  processRunner: async (input) => {
    calls.push(input);
    return { exitCode: 0, stdoutTail: JSON.stringify(plan), finalResult: plan };
  },
});
assert.equal(success.status, "PLAN_REVIEW");
assert.equal(success.readOnly, true);
assert.equal(success.planning.tasksCreated, 0);
assert.equal(success.planning.jobsCreated, 0);
assert.equal(success.planning.runsCreated, 0);
assert.equal(success.plan.planId, "plan-obj-shop-r1");
assert.equal(calls.length, 1);
assert.equal(calls[0].stage, "project-decomposition");
assert.equal(calls[0].args.includes("--mode") && calls[0].args[calls[0].args.indexOf("--mode") + 1] === "plan", true);
assert.equal(calls[0].args.includes("--json-schema"), true);
assert.equal(success.context.estimatedTokens <= contextBudget("project-decomposition"), true);
assert.ok((calls[0].args[1].match(/CONTEXT-MARKER/g) || []).length < 500, "project context must be bounded before provider invocation");

const clarification = await decomposeProject({
  objective,
  processRunner: async () => ({ exitCode: 0, stdoutTail: JSON.stringify({ schemaVersion: 2, clarificationNeeded: true, clarificationQuestion: "Project mana yang menjadi source of truth?" }) }),
});
assert.equal(clarification.status, "NEEDS_CLARIFICATION");
assert.equal(clarification.objectiveState, "NEEDS_CLARIFICATION");
assert.equal(clarification.plan, null);
assert.equal(clarification.planning.jobsCreated, 0);

await assert.rejects(
  decomposeProject({
    objective,
    processRunner: async () => ({ exitCode: 0, stdoutTail: JSON.stringify({ ...plan, approvedBy: "human" }) }),
  }),
  (error) => error.code === "INVALID_PLAN" && /approval fields/.test(error.message),
);

await assert.rejects(
  decomposeProject({
    objective: { ...objective, budget: { ...objective.budget, maxSubtasks: 0 } },
    processRunner: async () => ({ exitCode: 0, stdoutTail: JSON.stringify(plan) }),
  }),
  (error) => error.code === "INVALID_BUDGET",
);

await assert.rejects(
  decomposeProject({
    objective: { ...objective, budget: { ...objective.budget, maxTotalTokens: 10 } },
    processRunner: async () => ({ exitCode: 0, stdoutTail: JSON.stringify(plan) }),
  }),
  (error) => error.code === "INVALID_PLAN" && /estimated tokens exceed budget/.test(error.message),
);

assert.equal(resolveAgentRoute({ stage: "project-decomposition", risk: "LOW", complexity: "MEDIUM" }).tier, "ECONOMY");
assert.equal(resolveAgentRoute({ stage: "project-decomposition", risk: "LOW", complexity: "HIGH" }).tier, "STRONG_REVIEW");
assert.equal(resolveAgentRoute({ stage: "project-decomposition", risk: "LOW", complexity: "UNKNOWN" }).tier, "STRONG_REVIEW");

console.log("project-decomposer.test.mjs: All tests passed!");
