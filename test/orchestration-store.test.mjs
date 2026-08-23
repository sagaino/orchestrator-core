import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { clearFaultInjection, configureFaultInjection } from "../src/fault-injection.mjs";
import { objectivePath, createObjective, getObjective, listObjectives, updateObjective } from "../src/objective-store.mjs";
import { createPlan, getPlan } from "../src/plan-store.mjs";
import { createOrchestration, getOrchestration } from "../src/orchestration-store.mjs";
import { createDecision, getDecision } from "../src/decision-store.mjs";
import { DurableStoreCorruptionError, DurableStoreExistsError, DurableStoreRevisionError } from "../src/orchestration-store.mjs";

const execFileAsync = promisify(execFile);
const selfPath = fileURLToPath(import.meta.url);
const timestamp = "2026-08-22T00:00:00.000Z";

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function workerMain(payload) {
  while (!fs.existsSync(payload.gatePath)) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const result = updateObjective({
      runsRoot: payload.runsRoot,
      objectiveId: payload.objectiveId,
      expectedRevision: 0,
      patch: { [payload.marker]: true },
    });
    process.stdout.write(JSON.stringify({ ok: true, revision: result.revision, marker: payload.marker }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message }));
  }
}

async function runConcurrentUpdates(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const workers = ["workerA", "workerB"].map((marker) => execFileAsync(process.execPath, [selfPath, `--worker=${marker}`, encoded]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(payload.gatePath, "go\n", "utf8");
  const settled = await Promise.all(workers);
  return settled.map((item) => JSON.parse(item.stdout));
}

function objective() {
  return {
    schemaVersion: 1,
    revision: 0,
    objectiveId: "obj-store",
    mode: "EXISTING_PROJECT",
    state: "PLANNING",
    request: "Validate durable objective persistence.",
    requestedBy: "user",
    projectIds: ["store-project"],
    freshProject: null,
    activePlanId: null,
    activeOrchestrationId: null,
    budget: { maxSubtasks: 2, maxParallelAgents: 1, maxRetriesPerNode: 1, maxTotalTokens: null, deadlineAt: null },
    createdAt: timestamp,
    updatedAt: timestamp,
    token: "secret-value-that-must-not-persist",
  };
}

function plan() {
  return {
    schemaVersion: 1,
    planId: "plan-store-r1",
    objectiveId: "obj-store",
    revision: 1,
    state: "PENDING_APPROVAL",
    summary: "Store plan.",
    architectureDecisions: [],
    assumptions: [],
    clarificationNeeded: false,
    clarificationQuestion: null,
    projects: ["store-project"],
    nodes: [{
      nodeId: "N01",
      title: "Inspect store",
      purpose: "Verify durable storage.",
      projectId: "store-project",
      role: "DIAGNOSTIC",
      type: "DIAGNOSTIC",
      dependsOn: [],
      acceptanceCriteria: ["Storage is verified."],
      allowedPaths: [],
      verification: ["test"],
      risk: "LOW",
      complexity: "LOW",
      requiresChanges: false,
      canRunInParallel: false,
      writeConflictGroup: null,
      contextFrom: [],
      skills: [],
    }],
    integration: { required: false, projectVerification: [], crossProjectVerification: [], previewRequired: false },
    risk: "LOW",
    complexity: "LOW",
    approvedBy: null,
    approvedAt: null,
    createdAt: timestamp,
  };
}

function orchestration() {
  return {
    schemaVersion: 1,
    revision: 0,
    orchestrationId: "orch-store",
    objectiveId: "obj-store",
    planId: "plan-store-r1",
    state: "RUNNING",
    planFingerprint: "b".repeat(64),
    nodes: { N01: { state: "QUEUED", taskId: "STORE-001", jobId: "job-store", runId: null, attempt: 1, blockedBy: [], lastError: null } },
    integration: { state: "NOT_READY", projectBaselines: {}, artifacts: [], verification: [], rollback: null },
    usage: { totalTokens: 0, agentInvocations: 0, retries: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function decision() {
  return {
    schemaVersion: 1,
    revision: 0,
    decisionId: "decision-store",
    objectiveId: "obj-store",
    nodeId: null,
    runId: null,
    type: "PLAN_CLARIFICATION",
    state: "OPEN",
    evidence: { source: "test" },
    requestedAction: "Clarify the plan",
    allowedChoices: ["CLARIFY", "CANCEL"],
    creator: "SYSTEM",
    createdAt: timestamp,
    resolution: null,
  };
}

async function testMain() {
  console.log("Running orchestration-store.test.mjs...");
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-store-"));
  try {
    const created = createObjective({ runsRoot, record: objective() });
    assert.equal(created.revision, 0);
    assert.equal(created.token, "[REDACTED]");
    assert.throws(() => createObjective({ runsRoot, record: objective() }), (error) => error instanceof DurableStoreExistsError && error.code === "DURABLE_STORE_EXISTS");

    const filePath = objectivePath(runsRoot, "obj-store");
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
    assert.equal(getObjective(runsRoot, "obj-store").token, "[REDACTED]");

    const updated = updateObjective({ runsRoot, objectiveId: "obj-store", expectedRevision: 0, patch: { state: "PLAN_REVIEW" } });
    assert.equal(updated.revision, 1);
    assert.equal(updated.state, "PLAN_REVIEW");
    assert.throws(
      () => updateObjective({ runsRoot, objectiveId: "obj-store", expectedRevision: 0, patch: { state: "RUNNING" } }),
      (error) => error instanceof DurableStoreRevisionError && error.code === "DURABLE_STORE_STALE_REVISION",
    );

    configureFaultInjection({ "orchestration.store.before-rename": 1 });
    try {
      assert.throws(() => updateObjective({ runsRoot, objectiveId: "obj-store", expectedRevision: 1, patch: { state: "FAILED" } }));
    } finally {
      clearFaultInjection();
    }
    const afterInterruptedWrite = getObjective(runsRoot, "obj-store");
    assert.equal(afterInterruptedWrite.revision, 1);
    assert.equal(afterInterruptedWrite.state, "PLAN_REVIEW");
    assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith(".tmp")), false);

    const corruptionPath = objectivePath(runsRoot, "obj-corrupt");
    fs.writeFileSync(corruptionPath, "{not-json", { encoding: "utf8", mode: 0o600 });
    assert.throws(() => getObjective(runsRoot, "obj-corrupt"), (error) => error instanceof DurableStoreCorruptionError && error.code === "DURABLE_STORE_CORRUPT");
    assert.throws(() => listObjectives(runsRoot), (error) => error.code === "DURABLE_STORE_CORRUPT");

    assert.equal(createPlan({ runsRoot, record: plan(), validationOptions: { knownProjectIds: ["store-project"], projectVerificationScripts: { "store-project": ["test"] } } }).planId, "plan-store-r1");
    assert.equal(getPlan(runsRoot, "plan-store-r1").revision, 1);
    assert.equal(createOrchestration({ runsRoot, record: orchestration() }).orchestrationId, "orch-store");
    assert.equal(getOrchestration(runsRoot, "orch-store").state, "RUNNING");
    assert.equal(createDecision({ runsRoot, record: decision() }).decisionId, "decision-store");
    assert.equal(getDecision(runsRoot, "decision-store").creator, "SYSTEM");

    const concurrencyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-store-concurrency-"));
    try {
      createObjective({ runsRoot: concurrencyRoot, record: objective() });
      const gatePath = path.join(concurrencyRoot, "gate");
      const results = await runConcurrentUpdates({ runsRoot: concurrencyRoot, objectiveId: "obj-store", gatePath });
      assert.equal(results.filter((item) => item.ok).length, 1);
      assert.equal(results.filter((item) => item.code === "DURABLE_STORE_STALE_REVISION").length, 1);
      const final = getObjective(concurrencyRoot, "obj-store");
      assert.equal(final.revision, 1);
      assert.equal(Boolean(final.workerA) !== Boolean(final.workerB), true);
    } finally {
      fs.rmSync(concurrencyRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
    clearFaultInjection();
  }
  console.log("orchestration-store.test.mjs: All tests passed!");
}

const workerMode = process.argv.find((argument) => argument.startsWith("--worker="));
if (workerMode) await workerMain({ ...decode(process.argv.at(-1)), marker: workerMode.slice("--worker=".length) });
else await testMain();
