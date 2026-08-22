import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactSensitive } from "./redaction.mjs";
import { injectFault } from "./fault-injection.mjs";

const PROCESS_INSTANCE_ID = randomUUID();

export class DurableLeaseError extends Error {
  constructor(message, current = null) {
    super(message);
    this.name = "DurableLeaseError";
    this.code = "DURABLE_LEASE_HELD";
    this.current = current;
  }
}

function safeName(value) {
  const raw = String(value ?? "");
  const readable = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "lease";
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    injectFault("durable.write.before-temp", { filePath });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(redactSensitive(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    injectFault("durable.write.before-rename", { filePath, temporaryPath });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runtimeOwner() {
  return {
    instanceId: PROCESS_INSTANCE_ID,
    pid: process.pid,
    hostname: os.hostname(),
  };
}

export function runtimeOwnerAlive(owner) {
  if (!owner || owner.hostname !== os.hostname()) return false;
  return processAlive(owner.pid);
}

export function durableLeasePath(runsRoot, namespace, key) {
  return path.join(runsRoot, "runtime", "leases", safeName(namespace), `${safeName(key)}.json`);
}

export function readDurableLease(runsRoot, namespace, key) {
  const filePath = durableLeasePath(runsRoot, namespace, key);
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function defaultLeaseIsStale(record, now) {
  if (!record?.leaseId || !record?.owner) return true;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) return true;
  return record.owner.hostname === os.hostname() && !processAlive(record.owner.pid);
}

export function acquireDurableLease({
  runsRoot,
  namespace,
  key,
  purpose,
  metadata = {},
  ttlMs = 24 * 60 * 60 * 1000,
  reclaimDeadOwner = true,
  isStale = null,
  waitTimeoutMs = 0,
}) {
  const filePath = durableLeasePath(runsRoot, namespace, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const waitUntil = Date.now() + Math.max(0, Number(waitTimeoutMs) || 0);
  const waitSignal = new Int32Array(new SharedArrayBuffer(4));

  for (let attempt = 0; attempt < 256; attempt += 1) {
    const now = new Date();
    const record = {
      schemaVersion: 1,
      leaseId: randomUUID(),
      namespace,
      key: String(key),
      purpose: String(purpose || namespace),
      acquiredAt: now.toISOString(),
      expiresAt: ttlMs ? new Date(now.getTime() + ttlMs).toISOString() : null,
      owner: runtimeOwner(),
      metadata,
    };
    let descriptor;
    try {
      descriptor = fs.openSync(filePath, "wx", 0o600);
      injectFault("lease.after-create", { filePath, namespace, key: String(key) });
      fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return { filePath, record };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (error.code !== "EEXIST") throw error;

      const current = readJson(filePath);
      if (!current?.leaseId) {
        if (Date.now() < waitUntil) {
          Atomics.wait(waitSignal, 0, 0, Math.min(20, waitUntil - Date.now()));
          continue;
        }
        const corrupt = new DurableLeaseError(`${purpose || namespace} memiliki lease yang belum lengkap atau korup; fail-closed.`, current);
        corrupt.code = "DURABLE_LEASE_CORRUPT";
        throw corrupt;
      }
      const stale = typeof isStale === "function"
        ? Boolean(isStale(current, now))
        : reclaimDeadOwner && defaultLeaseIsStale(current, now);
      if (!stale) {
        if (Date.now() < waitUntil) {
          Atomics.wait(waitSignal, 0, 0, Math.min(20, waitUntil - Date.now()));
          continue;
        }
        throw new DurableLeaseError(`${purpose || namespace} sedang dimiliki proses lain.`, current);
      }

      const latest = readJson(filePath);
      if (latest?.leaseId !== current.leaseId) continue;
      injectFault("lease.before-stale-reclaim", { filePath, namespace, key: String(key), leaseId: current.leaseId });
      try { fs.unlinkSync(filePath); } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new DurableLeaseError(`${purpose || namespace} tidak dapat memperoleh lease atomik.`);
}

export function releaseDurableLease(lease) {
  if (!lease?.filePath || !lease?.record?.leaseId) return false;
  const current = readJson(lease.filePath);
  if (current?.leaseId !== lease.record.leaseId) return false;
  try {
    fs.unlinkSync(lease.filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function releaseDurableLeaseByOwner({ runsRoot, namespace, key, predicate }) {
  const filePath = durableLeasePath(runsRoot, namespace, key);
  const current = readJson(filePath);
  if (!current || (predicate && !predicate(current))) return false;
  const latest = readJson(filePath);
  if (latest?.leaseId !== current.leaseId) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function withDurableLease(options, callback) {
  const lease = acquireDurableLease(options);
  try {
    const result = callback(lease);
    if (result && typeof result.then === "function") {
      return result.finally(() => releaseDurableLease(lease));
    }
    releaseDurableLease(lease);
    return result;
  } catch (error) {
    releaseDurableLease(lease);
    throw error;
  }
}

function invocationPath(runsRoot, invocationId) {
  return path.join(runsRoot, "runtime", "invocations", `${safeName(invocationId)}.json`);
}

function compactInvocationResult(result) {
  if (!result || typeof result !== "object") return result ?? null;
  let finalResult = result.finalResult ?? null;
  try { finalResult = JSON.parse(JSON.stringify(finalResult)); }
  catch { finalResult = String(finalResult); }
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    stdoutTail: String(result.stdoutTail ?? "").slice(-50_000),
    stderrTail: String(result.stderrTail ?? "").slice(-50_000),
    finalResult,
  };
}

export function beginInvocation({ runsRoot, invocationId, runId, stage, metadata = {} }) {
  const filePath = invocationPath(runsRoot, invocationId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 1,
    invocationId,
    runId,
    stage,
    status: "RUNNING",
    startedAt: now,
    updatedAt: now,
    owner: runtimeOwner(),
    metadata,
    result: null,
    error: null,
  };
  try {
    const descriptor = fs.openSync(filePath, "wx", 0o600);
    try { fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8"); }
    finally { fs.closeSync(descriptor); }
    return { started: true, filePath, record };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readJson(filePath);
    if (existing?.status === "RUNNING" && existing.owner?.hostname === os.hostname() && !processAlive(existing.owner?.pid)) {
      const interrupted = {
        ...existing,
        status: "INTERRUPTED",
        updatedAt: now,
        finishedAt: now,
        error: "Owner process berhenti sebelum invocation mencatat hasil akhir.",
      };
      writeJsonAtomic(filePath, interrupted);
      return { started: false, filePath, record: interrupted };
    }
    return { started: false, filePath, record: existing };
  }
}

export function finishInvocation(handle, { status, result = null, error = null }) {
  const current = readJson(handle.filePath);
  if (!current || current.invocationId !== handle.record.invocationId) {
    throw new Error(`Invocation ledger hilang atau berubah: ${handle.record.invocationId}`);
  }
  if (current.status !== "RUNNING") return current;
  const now = new Date().toISOString();
  const updated = {
    ...current,
    status,
    updatedAt: now,
    finishedAt: now,
    result: compactInvocationResult(result),
    error: error ? String(error.message ?? error) : null,
  };
  writeJsonAtomic(handle.filePath, updated);
  return updated;
}

export async function runDurableInvocation({
  runsRoot,
  invocationId,
  runId,
  stage,
  metadata = {},
  execute,
}) {
  const handle = beginInvocation({ runsRoot, invocationId, runId, stage, metadata });
  if (!handle.started) {
    if (handle.record?.status === "SUCCEEDED" && handle.record.result) {
      return { ...handle.record.result, durableReplay: true };
    }
    const error = new DurableLeaseError(
      `Invocation ${invocationId} tidak dijalankan ulang karena status durable ${handle.record?.status ?? "UNKNOWN"}.`,
      handle.record,
    );
    error.code = "DURABLE_INVOCATION_BLOCKED";
    throw error;
  }
  try {
    const result = await execute();
    finishInvocation(handle, { status: "SUCCEEDED", result });
    return result;
  } catch (error) {
    finishInvocation(handle, { status: "FAILED", error });
    throw error;
  }
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".json") ? [absolute] : [];
  });
}

export function durableRuntimeStatus(runsRoot) {
  const runtimeRoot = path.join(runsRoot, "runtime");
  const leasesRoot = path.join(runtimeRoot, "leases");
  const invocationsRoot = path.join(runtimeRoot, "invocations");
  const invocations = jsonFiles(invocationsRoot).map(readJson).filter(Boolean);
  const invocationCounts = {};
  for (const invocation of invocations) {
    const status = String(invocation.status ?? "UNKNOWN");
    invocationCounts[status] = (invocationCounts[status] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    strategy: "ATOMIC_FILE_LEASES_AND_REVISION_GUARDS",
    sourceOfTruth: "JSON_MANIFESTS_WITH_DURABLE_RUNTIME_INDEX",
    activeLeaseCount: jsonFiles(leasesRoot).length,
    invocationCount: invocations.length,
    invocationCounts,
    guarantees: {
      atomicJobAdmission: true,
      projectExclusiveClaim: true,
      manifestRevisionGuard: true,
      stableInvocationIdentity: true,
      uncertainInvocationNeverAutoReplayed: true,
      incompleteLeaseFailClosed: true,
      processTreeDeadline: true,
      deterministicFaultInjectionVerified: true,
    },
  };
}

export function listDurableInvocations(runsRoot) {
  const invocationsRoot = path.join(runsRoot, "runtime", "invocations");
  return jsonFiles(invocationsRoot).map(readJson).filter(Boolean);
}
