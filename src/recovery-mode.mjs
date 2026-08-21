import fs from "node:fs";
import path from "node:path";

export function recoveryModePath(runsRoot) {
  return path.join(runsRoot, "runtime", "recovery-mode.json");
}
export function readRecoveryMode(runsRoot) {
  const filePath = recoveryModePath(runsRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return record?.executionBlocked === true ? { ...record, filePath } : null;
  } catch {
    return {
      schemaVersion: 1,
      mode: "RECOVERY_QUARANTINE_CORRUPT_MARKER",
      executionBlocked: true,
      filePath,
      error: "Recovery marker tidak dapat dibaca; fail-closed diterapkan.",
    };
  }
}

export function assertExecutionAllowed(runsRoot) {
  const recovery = readRecoveryMode(runsRoot);
  if (!recovery) return { allowed: true, recovery: null };
  const error = new Error("Runtime berada dalam RECOVERY_QUARANTINE; execution dan mutasi diblokir.");
  error.code = "RECOVERY_MODE_BLOCKED";
  error.statusCode = 423;
  error.details = { recovery };
  throw error;
}
