/**
 * P6.2: external supervisor for admission freeze, queue drain, and guarded
 * release activation. The candidate never supplies the human gate.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireDurableLease, releaseDurableLease } from "./durable-runtime.mjs";
import { validateJob, validateManifest } from "./schema.mjs";
import { RUN_STATES } from "./run-manager.mjs";
import { daemonStatus, startDaemon, stopDaemon } from "./daemon.mjs";
import { performGuardedUpdate, verifyHealth } from "./updater.mjs";
import { verifyReleaseCandidate } from "./release-candidate.mjs";
import { createReleaseAdmissionFreeze, releaseReleaseAdmissionFreeze } from "./release-admission.mjs";

export const RELEASE_SUPERVISOR_SCHEMA_VERSION = 1;
export const RELEASE_SUPERVISOR_NAMESPACE = "release-admission";
export const RELEASE_SUPERVISOR_KEY = "global";

const ACTIVE_RUN_STATES = new Set([
  RUN_STATES.CLAIMING,
  RUN_STATES.CLAIMED,
  RUN_STATES.RUNNING,
  RUN_STATES.VERIFYING,
  RUN_STATES.CHANGES_REQUESTED,
]);
const SAFE_INVOCATION_STATES = new Set(["SUCCEEDED", "FAILED"]);

function localOperatorIdentity() {
  return `local:${os.userInfo().username}`;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function inspectJsonDirectory(directory, validator, label) {
  if (!fs.existsSync(directory)) return { records: [], blockers: [] };
  const records = [];
  const blockers = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const absolute = path.join(directory, entry.name);
    const value = readJson(absolute);
    if (!value) {
      blockers.push({ code: "CORRUPT_LEDGER", label, path: absolute, reason: "JSON cannot be parsed." });
      continue;
    }
    const validation = validator(value);
    if (!validation.valid) {
      blockers.push({ code: "INVALID_LEDGER", label, path: absolute, reason: validation.errors.join(", ") });
      continue;
    }
    records.push(value);
  }
  return { records, blockers };
}

export function inspectReleaseDrain({ runsRoot, daemonStatusFn = daemonStatus } = {}) {
  const jobs = inspectJsonDirectory(path.join(runsRoot, "jobs"), validateJob, "job");
  const runs = inspectJsonDirectory(runsRoot, validateManifest, "run");
  const invocationLedger = inspectJsonDirectory(path.join(runsRoot, "runtime", "invocations"), () => ({ valid: true, errors: [] }), "invocation");
  const invocations = invocationLedger.records;
  const blockers = [...jobs.blockers, ...runs.blockers];
  blockers.push(...invocationLedger.blockers);

  const pending = { jobs: 0, runs: 0, invocations: 0 };

  for (const job of jobs.records) {
    if (["QUEUED", "RUNNING"].includes(job.state)) {
      pending.jobs += 1;
      blockers.push({ code: "QUEUE_NOT_DRAINED", jobId: job.jobId, state: job.state, reason: "Queued or running work must reach a safe state." });
    }
  }
  for (const run of runs.records) {
    if (ACTIVE_RUN_STATES.has(run.state)) {
      pending.runs += 1;
      blockers.push({ code: "ACTIVE_RUN", runId: run.runId, state: run.state, reason: "Active execution state must reach a safe state." });
    }
  }
  for (const invocation of invocations) {
    const status = String(invocation.status ?? "UNKNOWN").toUpperCase();
    if (!SAFE_INVOCATION_STATES.has(status)) {
      pending.invocations += 1;
      blockers.push({ code: "UNCERTAIN_INVOCATION", invocationId: invocation.invocationId ?? null, status, reason: "Invocation result is active or uncertain; activation is fail-closed." });
    }
  }
  const daemon = daemonStatusFn({ runsRoot });
  if (daemon?.running) blockers.push({ code: "DAEMON_RUNNING", pid: daemon.pid ?? null, reason: "Supervisor must stop the daemon before activation." });
  const pendingTotal = pending.jobs + pending.runs + pending.invocations;
  const daemonStopOnly = Boolean(daemon?.running) && pendingTotal === 0 && blockers.every((item) => item.code === "DAEMON_RUNNING");
  return {
    schemaVersion: RELEASE_SUPERVISOR_SCHEMA_VERSION,
    drained: blockers.length === 0,
    blockers,
    safeStates: ["DONE", "FAILED", "SUPERSEDED", "REVIEW", "RETROSPECTIVE", "KNOWLEDGE_APPROVAL", "WIKI_SYNCED"],
    daemon: { running: Boolean(daemon?.running), pid: daemon?.pid ?? null },
    counts: { jobs: jobs.records.length, runs: runs.records.length, invocations: invocations.length },
    pending: { ...pending, total: pendingTotal },
    activation: {
      state: blockers.length === 0 ? "READY" : daemonStopOnly ? "STOP_DAEMON_REQUIRED" : pendingTotal > 0 ? "PENDING_WORK" : "BLOCKED",
      daemonStopRequired: Boolean(daemon?.running),
      daemonStopOnly,
    },
  };
}

function validateHumanGate({ humanGate, operatorIdentity }) {
  const errors = [];
  if (!humanGate || humanGate.confirmed !== true) errors.push("humanGate.confirmed must be true");
  if (humanGate?.source !== "external-supervisor") errors.push("humanGate.source must be external-supervisor");
  if (String(humanGate?.approvedBy ?? "") !== operatorIdentity) errors.push("humanGate.approvedBy must match the OS-derived operator identity");
  if (!String(humanGate?.operatorSessionId ?? "").trim()) errors.push("humanGate.operatorSessionId is required");
  if (!String(humanGate?.actionNonceHash ?? "").trim()) errors.push("humanGate.actionNonceHash is required");
  if (!humanGate?.approvedAt || Number.isNaN(Date.parse(humanGate.approvedAt))) errors.push("humanGate.approvedAt must be a valid timestamp");
  if (errors.length) {
    const error = new Error(`Human gate ditolak: ${errors.join("; ")}`);
    error.code = "RELEASE_HUMAN_GATE_REQUIRED";
    throw error;
  }
  return {
    confirmed: true,
    source: "external-supervisor",
    approvedBy: operatorIdentity,
    approvedAt: new Date(humanGate.approvedAt).toISOString(),
    operatorSessionId: String(humanGate.operatorSessionId),
    actionNonceHash: String(humanGate.actionNonceHash),
  };
}

export async function superviseReleaseActivation({
  sourceRoot,
  releaseCandidateRoot,
  runsRoot,
  vaultRoot = null,
  humanGate,
  operatorIdentity = localOperatorIdentity(),
  cliPath = path.join(sourceRoot, "src", "orchestrator.mjs"),
  timeoutMs = 30_000,
  daemonOps = { startDaemon, stopDaemon, verifyHealth },
  updateFn = performGuardedUpdate,
  now = new Date(),
} = {}) {
  const sourcePath = path.resolve(sourceRoot);
  const candidatePath = path.resolve(releaseCandidateRoot);
  if (!sourceRoot || !releaseCandidateRoot || !runsRoot) throw new Error("sourceRoot, releaseCandidateRoot, and runsRoot are required.");
  if (sourcePath === candidatePath || isInside(sourcePath, candidatePath) || isInside(candidatePath, sourcePath)) throw new Error("Release candidate must remain outside the stable source root.");
  const candidate = verifyReleaseCandidate(candidatePath);
  const gate = validateHumanGate({ humanGate, operatorIdentity });
  const supervisorId = `supervisor-${randomUUID()}`;
  const lease = acquireDurableLease({
    runsRoot,
    namespace: RELEASE_SUPERVISOR_NAMESPACE,
    key: RELEASE_SUPERVISOR_KEY,
    purpose: "external release supervisor",
    metadata: { supervisorId, candidateReleaseId: candidate.manifest.releaseId },
    ttlMs: null,
    reclaimDeadOwner: false,
  });
  let freeze = null;
  try {
    freeze = createReleaseAdmissionFreeze({ runsRoot, supervisorId, operatorIdentity, now });
    const stopResult = await (daemonOps.stopDaemon ?? stopDaemon)({ runsRoot });
    const drain = inspectReleaseDrain({ runsRoot, daemonStatusFn: daemonOps.daemonStatus ?? daemonStatus });
    if (!drain.drained) {
      const error = new Error(`Release drain diblokir: ${drain.blockers.map((item) => item.code).join(", ")}`);
      error.code = "RELEASE_DRAIN_BLOCKED";
      error.details = drain;
      throw error;
    }
    const effectiveDaemonOps = {
      stopDaemon: async () => ({ action: "ALREADY_STOPPED" }),
      startDaemon: daemonOps.startDaemon ?? startDaemon,
      verifyHealth: daemonOps.verifyHealth ?? verifyHealth,
    };
    const update = await updateFn({
      sourceRoot,
      releaseCandidateRoot: candidatePath,
      runsRoot,
      vaultRoot,
      cliPath,
      timeoutMs,
      daemonOps: effectiveDaemonOps,
    });
    return {
      schemaVersion: RELEASE_SUPERVISOR_SCHEMA_VERSION,
      supervisorId,
      candidate: { releaseId: candidate.manifest.releaseId, sourceCommit: candidate.manifest.provenance?.sourceCommit ?? null },
      humanGate: gate,
      admission: { freezeId: freeze.record.freezeId, stop: stopResult, drain },
      update,
    };
  } finally {
    if (freeze) releaseReleaseAdmissionFreeze({ runsRoot, freezeId: freeze.record.freezeId, supervisorId });
    releaseDurableLease(lease);
  }
}

async function cli() {
  const args = process.argv.slice(2);
  const option = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  const sourceRoot = path.resolve(option("--source", process.cwd()));
  const candidateRoot = option("--candidate");
  const runsRoot = path.resolve(option("--runs", path.join(sourceRoot, "runs")));
  const operatorIdentity = option("--operator", localOperatorIdentity());
  const report = await superviseReleaseActivation({
    sourceRoot,
    releaseCandidateRoot: path.resolve(candidateRoot),
    runsRoot,
    vaultRoot: option("--vault", null),
    operatorIdentity,
    humanGate: {
      confirmed: args.includes("--confirm"),
      source: "external-supervisor",
      approvedBy: option("--approved-by", operatorIdentity),
      approvedAt: option("--approved-at", new Date().toISOString()),
      operatorSessionId: option("--operator-session", null),
      actionNonceHash: option("--action-nonce-hash", null),
    },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
