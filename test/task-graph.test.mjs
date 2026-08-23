import assert from "node:assert/strict";
import {
  TaskGraphError,
  descendantsOf,
  detectWriteConflicts,
  eligibleNodes,
  topologicalOrder,
  validateTaskGraph,
} from "../src/task-graph.mjs";

console.log("Running task-graph.test.mjs...");

const nodes = [
  { nodeId: "N03", dependsOn: ["N01"], projectId: "shop", canRunInParallel: false, allowedPaths: ["src/api/**"] },
  { nodeId: "N01", dependsOn: [], projectId: "shop", canRunInParallel: true, allowedPaths: ["src/diagnostics/**"] },
  { nodeId: "N02", dependsOn: [], projectId: "shop", canRunInParallel: true, allowedPaths: ["src/ui/**"] },
  { nodeId: "N04", dependsOn: ["N02", "N03"], projectId: "shop", canRunInParallel: false, allowedPaths: ["test/**"] },
];

assert.equal(validateTaskGraph(nodes).valid, true);
assert.deepEqual(topologicalOrder(nodes), ["N01", "N02", "N03", "N04"]);
assert.deepEqual(eligibleNodes(nodes, {}), ["N01", "N02"]);
assert.deepEqual(eligibleNodes(nodes, { N01: "DONE" }), ["N02", "N03"]);
assert.deepEqual(eligibleNodes(nodes, { N01: "DONE", N02: "DONE", N03: "DONE" }), ["N04"]);
assert.deepEqual(descendantsOf("N01", nodes), ["N03", "N04"]);
assert.deepEqual(descendantsOf(nodes, "N02"), ["N04"]);
assert.deepEqual(descendantsOf("N01", [
  { nodeId: "N03", dependsOn: ["N02"] },
  { nodeId: "N02", dependsOn: ["N01"] },
  { nodeId: "N01", dependsOn: [] },
]), ["N02", "N03"]);

const invalidCases = [
  {
    label: "missing dependency",
    graph: [{ nodeId: "N01", dependsOn: ["N99"] }],
    message: "missing dependency: N01 -> N99",
  },
  {
    label: "self dependency",
    graph: [{ nodeId: "N01", dependsOn: ["N01"] }],
    message: "self dependency: N01 -> N01",
  },
  {
    label: "duplicate node ID",
    graph: [{ nodeId: "N01", dependsOn: [] }, { nodeId: "N01", dependsOn: [] }],
    message: "duplicate node IDs: N01",
  },
];
for (const testCase of invalidCases) {
  const validation = validateTaskGraph(testCase.graph);
  assert.equal(validation.valid, false, `${testCase.label} should be rejected`);
  assert.ok(validation.errors.includes(testCase.message), `${testCase.label} error should be explicit`);
}

const cycle = validateTaskGraph([
  { nodeId: "N01", dependsOn: ["N02"] },
  { nodeId: "N02", dependsOn: ["N03"] },
  { nodeId: "N03", dependsOn: ["N01"] },
]);
assert.equal(cycle.valid, false);
assert.deepEqual(cycle.cycle, ["N01", "N02", "N03", "N01"]);
assert.throws(() => topologicalOrder([
  { nodeId: "N01", dependsOn: ["N02"] },
  { nodeId: "N02", dependsOn: ["N01"] },
]), (error) => error instanceof TaskGraphError && error.validation.cycle.join(" -> ") === "N01 -> N02 -> N01");

const overlapping = [
  { nodeId: "N01", dependsOn: [], projectId: "shop", canRunInParallel: true, allowedPaths: ["src/checkout/**"] },
  { nodeId: "N02", dependsOn: [], projectId: "shop", canRunInParallel: true, allowedPaths: ["src/checkout/payment.ts"] },
];
const pathConflicts = detectWriteConflicts(overlapping);
assert.equal(pathConflicts.length, 1);
assert.deepEqual(pathConflicts[0].nodeIds, ["N01", "N02"]);
assert.ok(pathConflicts[0].reasons.includes("OVERLAPPING_PATHS"));
assert.equal(validateTaskGraph(overlapping).valid, false);

const grouped = [
  { nodeId: "N01", dependsOn: [], projectId: "shop", canRunInParallel: true, allowedPaths: ["src/one.ts"], writeConflictGroup: "shop:shared" },
  { nodeId: "N02", dependsOn: [], projectId: "shop", canRunInParallel: true, allowedPaths: ["src/two.ts"], writeConflictGroup: "shop:shared" },
];
assert.equal(detectWriteConflicts(grouped)[0].reasons.includes("WRITE_CONFLICT_GROUP"), true);
assert.equal(detectWriteConflicts([
  { ...overlapping[0], projectId: "frontend" },
  { ...overlapping[1], projectId: "backend" },
]).length, 0);
assert.equal(detectWriteConflicts([
  { ...overlapping[0], dependsOn: ["N02"] },
  overlapping[1],
]).length, 0);

console.log("task-graph.test.mjs: All tests passed!");
