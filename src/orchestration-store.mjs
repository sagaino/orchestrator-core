import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSensitive } from "./redaction.mjs";
import { injectFault } from "./fault-injection.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { validateOrchestrationRecord } from "./orchestration-schema.mjs";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class DurableStoreError extends Error {
  constructor(message, code = "DURABLE_STORE_ERROR", details = null) {
    super(message);
    this.name = "DurableStoreError";
    this.code = code;
    this.details = details;
  }
}

export class DurableStoreExistsError extends DurableStoreError {
  constructor(filePath) {
    super(`Durable record already exists: ${filePath}`, "DURABLE_STORE_EXISTS", { filePath });
  }
}

export class DurableStoreCorruptionError extends DurableStoreError {
  constructor(filePath, cause = null) {
    super(`Durable record is corrupt and cannot be ignored: ${filePath}`, "DURABLE_STORE_CORRUPT", { filePath, cause: cause?.message ?? null });
  }
}

export class DurableStoreValidationError extends DurableStoreError {
  constructor(filePath, validation) {
    super(`Durable record is invalid: ${filePath}`, "DURABLE_STORE_INVALID", { filePath, errors: validation.errors });
  }
}

export class DurableStoreRevisionError extends DurableStoreError {
  constructor(filePath, expectedRevision, currentRevision) {
    super(
      `Stale durable record revision for ${filePath}: expected ${expectedRevision}, current ${currentRevision}`,
      "DURABLE_STORE_STALE_REVISION",
      { filePath, expectedRevision, currentRevision },
    );
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new DurableStoreError(`${label} must be a stable identifier`, "DURABLE_STORE_INVALID_ID", { label, value });
  }
}

function collectionDirectory(runsRoot, collection) {
  if (!runsRoot || !path.isAbsolute(path.resolve(runsRoot))) throw new DurableStoreError("runsRoot must be provided", "DURABLE_STORE_INVALID_ROOT");
  return path.join(path.resolve(runsRoot), collection);
}

function recordPath(runsRoot, collection, id) {
  assertIdentifier(id, `${collection} id`);
  return path.join(collectionDirectory(runsRoot, collection), `${id}.json`);
}

function readRaw(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new DurableStoreCorruptionError(filePath, error);
  }
}

function validateOrThrow(filePath, value, validate, validationOptions) {
  const validation = validate(value, validationOptions);
  if (!validation?.valid) throw new DurableStoreValidationError(filePath, validation ?? { errors: ["Validator did not return a valid result"] });
  return value;
}

function writeAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    injectFault("orchestration.store.before-temp", { filePath, temporaryPath });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(redactSensitive(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(temporaryPath, 0o600); } catch {}
    try {
      const descriptor = fs.openSync(temporaryPath, "r");
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    } catch {}
    injectFault("orchestration.store.before-rename", { filePath, temporaryPath });
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function writeExclusive(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(redactSensitive(value), null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === "EEXIST") throw new DurableStoreExistsError(filePath);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function leaseOptions({ runsRoot, collection, id, waitTimeoutMs = 0 }) {
  return {
    runsRoot,
    namespace: "orchestration-store",
    key: `${collection}:${id}`,
    purpose: `mutate ${collection}/${id}`,
    ttlMs: 5 * 60 * 1000,
    reclaimDeadOwner: true,
    waitTimeoutMs,
  };
}

export function createDurableRecordStore({ collection, idField, validate }) {
  if (!IDENTIFIER_PATTERN.test(String(collection)) || !IDENTIFIER_PATTERN.test(String(idField))) throw new Error("Invalid durable store definition");
  if (typeof validate !== "function") throw new Error("Durable store validator is required");

  function pathFor(runsRoot, id) {
    return recordPath(runsRoot, collection, id);
  }

  function getRecord(runsRoot, id, validationOptions = {}) {
    const filePath = pathFor(runsRoot, id);
    const raw = readRaw(filePath);
    if (!raw) return null;
    validateOrThrow(filePath, raw.value, validate, validationOptions);
    return raw.value;
  }

  function listRecords(runsRoot, validationOptions = {}) {
    const directory = collectionDirectory(runsRoot, collection);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => getRecord(runsRoot, entry.name.slice(0, -5), validationOptions));
  }

  function createRecord({ runsRoot, record, validationOptions = {} }) {
    const id = record?.[idField];
    assertIdentifier(id, `${collection}.${idField}`);
    const filePath = pathFor(runsRoot, id);
    validateOrThrow(filePath, record, validate, validationOptions);
    return withDurableLease(leaseOptions({ runsRoot, collection, id }), () => {
      writeExclusive(filePath, record);
      return getRecord(runsRoot, id, validationOptions);
    });
  }

  function updateRecord({ runsRoot, id, expectedRevision, patch = null, update = null, now = new Date(), validationOptions = {} }) {
    assertIdentifier(id, `${collection}.${idField}`);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new DurableStoreError("expectedRevision must be a non-negative integer", "DURABLE_STORE_INVALID_REVISION");
    if (patch !== null && !isPlainObject(patch)) throw new DurableStoreError("patch must be an object or null", "DURABLE_STORE_INVALID_PATCH");
    if (update !== null && typeof update !== "function") throw new DurableStoreError("update must be a function or null", "DURABLE_STORE_INVALID_PATCH");
    if (patch === null && update === null) throw new DurableStoreError("patch or update is required", "DURABLE_STORE_INVALID_PATCH");
    const filePath = pathFor(runsRoot, id);
    return withDurableLease(leaseOptions({ runsRoot, collection, id, waitTimeoutMs: 2_000 }), () => {
      const current = getRecord(runsRoot, id, validationOptions);
      if (!current) throw new DurableStoreError(`Durable record not found: ${filePath}`, "DURABLE_STORE_NOT_FOUND", { filePath });
      if (current.revision !== expectedRevision) throw new DurableStoreRevisionError(filePath, expectedRevision, current.revision);
      const candidate = update ? update(structuredClone(current)) : { ...current, ...patch };
      if (!isPlainObject(candidate)) throw new DurableStoreError("update must return an object", "DURABLE_STORE_INVALID_PATCH");
      const next = {
        ...candidate,
        [idField]: current[idField],
        schemaVersion: current.schemaVersion,
        revision: current.revision + 1,
        ...(Object.prototype.hasOwnProperty.call(current, "updatedAt") ? { updatedAt: now.toISOString() } : {}),
      };
      validateOrThrow(filePath, next, validate, validationOptions);
      writeAtomic(filePath, next);
      return getRecord(runsRoot, id, validationOptions);
    });
  }

  return Object.freeze({ collection, idField, pathFor, get: getRecord, list: listRecords, create: createRecord, update: updateRecord });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export const orchestrationStore = createDurableRecordStore({ collection: "orchestrations", idField: "orchestrationId", validate: validateOrchestrationRecord });
export const createOrchestration = orchestrationStore.create;
export const getOrchestration = orchestrationStore.get;
export const listOrchestrations = orchestrationStore.list;
export function updateOrchestration(options = {}) {
  return orchestrationStore.update({ ...options, id: options.id ?? options.orchestrationId });
}
export const orchestrationPath = orchestrationStore.pathFor;
