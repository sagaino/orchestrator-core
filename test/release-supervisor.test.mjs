import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReleaseCandidate } from "../src/release-candidate.mjs";
import { enqueueTaskJob, JOB_STATES } from "../src/job-queue.mjs";
import { beginInvocation } from "../src/durable-runtime.mjs";
import { createReleaseAdmissionFreeze, releaseReleaseAdmissionFreeze } from "../src/release-admission.mjs";
import { inspectReleaseDrain, superviseReleaseActivation } from "../src/release-supervisor.mjs";

console.log("Running release-supervisor.test.mjs...");

const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p62-source-"));
const candidateBuildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p62-build-"));
const candidateRoot = path.join(candidateBuildRoot, "candidate");
const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p62-runs-"));
const operatorIdentity = "local:p62-test";
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";

function writeFixtureSource(root, value) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "schemas"), { recursive: true });
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });
  for (const file of ["start.sh", "stop.sh", "README.md", "PHASE_6_RELEASE_CONTRACT.md"]) fs.writeFileSync(path.join(root, file), `fixture:${file}\n`);
  fs.writeFileSync(path.join(root, "src", "index.mjs"), `export const value = ${JSON.stringify(value)};\n`);
  fs.writeFileSync(path.join(root, "schemas", "fixture.json"), "{}\n");
  fs.writeFileSync(path.join(root, "templates", "manifest.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3 }));
}

try {
  writeFixtureSource(sourceRoot, "stable");
  const candidateSource = fs.mkdtempSync(path.join(os.tmpdir(), "p62-candidate-source-"));
  try {
    writeFixtureSource(candidateSource, "candidate");
    buildReleaseCandidate({ sourceRoot: candidateSource, outputRoot: candidateRoot, releaseId: "candidate-p62", sourceCommit, regressionResult: { status: "PASS", command: "fixture", exitCode: 0 } });
  } finally {
    fs.rmSync(candidateSource, { recursive: true, force: true });
  }

  const empty = inspectReleaseDrain({ runsRoot, daemonStatusFn: () => ({ running: false }) });
  assert.equal(empty.drained, true);
  assert.deepEqual(empty.pending, { jobs: 0, runs: 0, invocations: 0, total: 0 });
  assert.equal(empty.activation.state, "READY");

  const daemonOnly = inspectReleaseDrain({ runsRoot, daemonStatusFn: () => ({ running: true, pid: 123 }) });
  assert.equal(daemonOnly.drained, false);
  assert.equal(daemonOnly.pending.total, 0);
  assert.equal(daemonOnly.activation.state, "STOP_DAEMON_REQUIRED");
  assert.equal(daemonOnly.activation.daemonStopOnly, true);

  const freeze = createReleaseAdmissionFreeze({ runsRoot, supervisorId: "freeze-test", operatorIdentity });
  assert.throws(() => enqueueTaskJob({ runsRoot, projectId: "p", taskId: "T-1", taskPath: "task.md" }), /dibekukan/);
  releaseReleaseAdmissionFreeze({ runsRoot, freezeId: freeze.record.freezeId, supervisorId: "freeze-test" });
  assert.equal(enqueueTaskJob({ runsRoot, projectId: "p", taskId: "T-1", taskPath: "task.md" }).created, true);

  const queued = inspectReleaseDrain({ runsRoot, daemonStatusFn: () => ({ running: false }) });
  assert.equal(queued.drained, false);
  assert.equal(queued.pending.jobs, 1);
  assert.equal(queued.activation.state, "PENDING_WORK");
  assert.ok(queued.blockers.some((item) => item.code === "QUEUE_NOT_DRAINED"));

  const queueFile = fs.readdirSync(path.join(runsRoot, "jobs")).find((entry) => entry.endsWith(".json"));
  fs.unlinkSync(path.join(runsRoot, "jobs", queueFile));
  const invocation = beginInvocation({ runsRoot, invocationId: "uncertain-1", runId: "run-1", stage: "IMPLEMENTATION" });
  assert.equal(invocation.started, true);
  const uncertain = inspectReleaseDrain({ runsRoot, daemonStatusFn: () => ({ running: false }) });
  assert.equal(uncertain.drained, false);
  assert.equal(uncertain.pending.invocations, 1);
  assert.equal(uncertain.activation.state, "PENDING_WORK");
  assert.ok(uncertain.blockers.some((item) => item.code === "UNCERTAIN_INVOCATION"));
  fs.unlinkSync(invocation.filePath);

  const daemonOps = {
    stopDaemon: async () => ({ action: "STOPPED" }),
    startDaemon: async () => ({ action: "STARTED" }),
    verifyHealth: async () => ({ healthy: true, status: { running: true, healthy: true } }),
    daemonStatus: () => ({ running: false }),
  };
  const result = await superviseReleaseActivation({
    sourceRoot,
    releaseCandidateRoot: candidateRoot,
    runsRoot,
    operatorIdentity,
    humanGate: {
      confirmed: true,
      source: "external-supervisor",
      approvedBy: operatorIdentity,
      approvedAt: "2026-08-22T00:00:00.000Z",
      operatorSessionId: "session-p62",
      actionNonceHash: "nonce-hash-p62",
    },
    daemonOps,
  });
  assert.equal(result.update.success, true);
  assert.match(fs.readFileSync(path.join(sourceRoot, "src", "index.mjs"), "utf8"), /candidate/);
  assert.equal(fs.existsSync(path.join(runsRoot, "runtime", "release-admission-freeze.json")), false);

  await assert.rejects(() => superviseReleaseActivation({
    sourceRoot,
    releaseCandidateRoot: candidateRoot,
    runsRoot,
    operatorIdentity,
    humanGate: {
      confirmed: false,
      source: "candidate",
      approvedBy: operatorIdentity,
      operatorSessionId: "forged",
      actionNonceHash: "forged",
      approvedAt: "2026-08-22T00:00:00.000Z",
    },
    daemonOps,
  }), /Human gate ditolak/);
} finally {
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  fs.rmSync(candidateBuildRoot, { recursive: true, force: true });
  fs.rmSync(runsRoot, { recursive: true, force: true });
}

console.log("release-supervisor.test.mjs: All tests passed!");
