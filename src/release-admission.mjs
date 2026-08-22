import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeOwner } from "./durable-runtime.mjs";

export const RELEASE_ADMISSION_FREEZE_SCHEMA_VERSION = 1;

export function releaseAdmissionFreezePath(runsRoot) {
  return path.join(runsRoot, "runtime", "release-admission-freeze.json");
}

export function readReleaseAdmissionFreeze(runsRoot) {
  const filePath = releaseAdmissionFreezePath(runsRoot);
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) {
    const corrupt = new Error(`Release admission freeze corrupt: ${error.message}`);
    corrupt.code = "RELEASE_ADMISSION_FREEZE_CORRUPT";
    throw corrupt;
  }
}

export function assertReleaseAdmissionOpen(runsRoot) {
  const freeze = readReleaseAdmissionFreeze(runsRoot);
  if (!freeze) return true;
  const error = new Error(`Release admission dibekukan oleh supervisor ${freeze.supervisorId ?? "unknown"}.`);
  error.code = "RELEASE_ADMISSION_FROZEN";
  error.freeze = freeze;
  throw error;
}

export function createReleaseAdmissionFreeze({ runsRoot, supervisorId, operatorIdentity, now = new Date() } = {}) {
  const filePath = releaseAdmissionFreezePath(runsRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: RELEASE_ADMISSION_FREEZE_SCHEMA_VERSION,
    kind: "personal-ai-os-release-admission-freeze",
    freezeId: randomUUID(),
    supervisorId: String(supervisorId || "").trim() || randomUUID(),
    operatorIdentity: String(operatorIdentity || "").trim() || null,
    status: "FROZEN",
    createdAt: now.toISOString(),
    owner: runtimeOwner(),
  };
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8"); }
  finally { fs.closeSync(descriptor); }
  return { filePath, record };
}

export function releaseReleaseAdmissionFreeze({ runsRoot, freezeId, supervisorId } = {}) {
  const filePath = releaseAdmissionFreezePath(runsRoot);
  const current = readReleaseAdmissionFreeze(runsRoot);
  if (!current) return false;
  if (freezeId && current.freezeId !== freezeId) return false;
  if (supervisorId && current.supervisorId !== supervisorId) return false;
  fs.unlinkSync(filePath);
  return true;
}
