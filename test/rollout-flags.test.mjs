import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { parallelObjectivesEnabled, skillAutoRoutingEnabled, skillsEnabled } from "../src/rollout-flags.mjs";
import { objectiveSchedulingAllowed } from "../src/orchestration-scheduler.mjs";
import { routePlanSkills } from "../src/skill-router.mjs";

console.log("Running rollout-flags.test.mjs...");

assert.equal(skillsEnabled({}), false);
assert.equal(skillsEnabled({ ORCHESTRATOR_SKILLS_ENABLED: "unknown" }), false);
assert.equal(skillsEnabled({ ORCHESTRATOR_SKILLS_ENABLED: "1" }), true);
assert.equal(skillAutoRoutingEnabled({ ORCHESTRATOR_SKILL_AUTO_ROUTING: "true" }), true);
assert.equal(skillAutoRoutingEnabled({ ORCHESTRATOR_SKILL_AUTO_ROUTING: "0" }), false);
assert.equal(parallelObjectivesEnabled({ ORCHESTRATOR_PARALLEL_OBJECTIVES: "on" }), true);
assert.equal(parallelObjectivesEnabled({ ORCHESTRATOR_PARALLEL_OBJECTIVES: "invalid" }), false);

const plan = { nodes: [{ nodeId: "N01", skills: [] }] };
const disabled = routePlanSkills({
  plan,
  runsRoot: path.join(os.tmpdir(), "rollout-flags-no-registry"),
  env: {},
});
assert.equal(disabled.registryState, "DISABLED");
assert.equal(disabled.routes[0].status, "SKILLS_DISABLED");
assert.deepEqual(disabled.plan, plan);

const manualOnly = routePlanSkills({
  plan,
  runsRoot: path.join(os.tmpdir(), "rollout-flags-no-registry"),
  env: { ORCHESTRATOR_SKILLS_ENABLED: "1", ORCHESTRATOR_SKILL_AUTO_ROUTING: "0" },
});
assert.equal(manualOnly.routes[0].status, "AUTO_ROUTING_DISABLED");

const active = { objectiveId: "obj-active", nodes: { N01: { state: "QUEUED" } } };
const pending = { objectiveId: "obj-pending", nodes: { N01: { state: "READY" } } };
assert.equal(objectiveSchedulingAllowed({ orchestration: active, activeObjectiveIds: new Set(["obj-active"]), allowParallelObjectives: false }), true);
assert.equal(objectiveSchedulingAllowed({ orchestration: pending, activeObjectiveIds: new Set(["obj-active"]), allowParallelObjectives: false }), false);
assert.equal(objectiveSchedulingAllowed({ orchestration: pending, activeObjectiveIds: new Set(["obj-active"]), allowParallelObjectives: true }), true);

console.log("rollout-flags.test.mjs: All tests passed!");
