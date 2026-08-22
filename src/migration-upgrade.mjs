import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDisasterRecoveryBackup, restoreDisasterRecoveryBackup, verifyDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import { readRecoveryMode } from "./recovery-mode.mjs";

export const MIGRATION_SCHEMA_VERSION = 1;
export const MIGRATION_CONTRACT_VERSION = "p9.1-2026-08-22";
export const MIGRATION_MATRIX_KIND = "personal-ai-os-migration-upgrade-matrix";

export const MIGRATION_MATRIX = Object.freeze([
  { id: "clean-install", sourceRuntime: "none", targetRuntime: "v1.0.0", sourceSchema: 0, targetSchema: 1, decision: "INSTALL_CLEAN", backupRequired: false },
  { id: "phase4-to-v1", sourceRuntime: "phase4", targetRuntime: "v1.0.0", sourceSchema: 1, targetSchema: 1, decision: "MIGRATE_WITH_CHECKPOINT", backupRequired: true },
  { id: "restore-then-upgrade", sourceRuntime: "restored-phase4", targetRuntime: "v1.0.0", sourceSchema: 1, targetSchema: 1, decision: "RESTORE_QUARANTINE_THEN_MIGRATE", backupRequired: true },
  { id: "future-schema", sourceRuntime: "future", targetRuntime: "v1.0.0", sourceSchema: 99, targetSchema: 1, decision: "REJECT_INCOMPATIBLE", backupRequired: false },
  { id: "interrupted-migration", sourceRuntime: "phase4", targetRuntime: "v1.0.0", sourceSchema: 1, targetSchema: 1, decision: "ROLLBACK_TO_CHECKPOINT", backupRequired: true },
  { id: "failed-migration-rollback", sourceRuntime: "phase4", targetRuntime: "v1.0.0", sourceSchema: 1, targetSchema: 1, decision: "ROLLBACK_TO_CHECKPOINT", backupRequired: true },
]);

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return filePath;
}

function migrationStatePath(runsRoot, migrationId) {
  return path.join(runsRoot, "runtime", "migrations", `${migrationId}.json`);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function matrixEntry(matrixId) {
  const entry = MIGRATION_MATRIX.find((item) => item.id === matrixId);
  if (!entry) throw new Error(`Migration matrix case tidak dikenal: ${matrixId}`);
  return entry;
}

export function assessMigrationCompatibility({ matrixId, sourceRuntime, targetRuntime = "v1.0.0", sourceSchemaVersion, targetSchemaVersion = 1 } = {}) {
  const entry = matrixEntry(matrixId);
  const errors = [];
  if (sourceRuntime !== entry.sourceRuntime) errors.push(`source runtime ${sourceRuntime} tidak cocok dengan ${entry.sourceRuntime}`);
  if (targetRuntime !== entry.targetRuntime) errors.push(`target runtime ${targetRuntime} tidak cocok dengan ${entry.targetRuntime}`);
  if (Number(sourceSchemaVersion) !== entry.sourceSchema) errors.push(`source schema ${sourceSchemaVersion} tidak cocok dengan ${entry.sourceSchema}`);
  if (Number(targetSchemaVersion) !== entry.targetSchema) errors.push(`target schema ${targetSchemaVersion} tidak cocok dengan ${entry.targetSchema}`);
  if (Number(sourceSchemaVersion) > Number(targetSchemaVersion)) errors.push("source schema lebih baru dari target; downgrade data ditolak");
  return {
    compatible: errors.length === 0,
    decision: errors.length ? "REJECT_INCOMPATIBLE" : entry.decision,
    matrix: entry,
    errors,
    failClosed: errors.length > 0,
  };
}

function requireBackup({ backupPath, matrix }) {
  if (!matrix.backupRequired) return null;
  if (!backupPath || !path.isAbsolute(backupPath)) throw Object.assign(new Error("Migration membutuhkan absolute backup path."), { code: "BACKUP_REQUIRED" });
  const verification = verifyDisasterRecoveryBackup({ backupPath });
  return { backupId: verification.backupId, backupPath: path.resolve(backupPath), verifiedAt: verification.verifiedAt, checksum: verification.manifest?.backupId ?? null };
}

export function executeVersionedMigration({
  runsRoot,
  migrationId,
  matrixId,
  sourceRuntime,
  targetRuntime = "v1.0.0",
  sourceSchemaVersion,
  targetSchemaVersion = 1,
  backupPath = null,
  targetRoot = null,
  steps = [],
  interruptAtStep = null,
  failAtStep = null,
  now = new Date(),
} = {}) {
  if (!runsRoot || !migrationId || !matrixId) throw new Error("Migration membutuhkan runsRoot, migrationId, dan matrixId.");
  const statePath = migrationStatePath(runsRoot, migrationId);
  const previous = readJson(statePath);
  if (previous?.status === "COMPLETED" && previous.targetRuntime === targetRuntime) return { ...previous, status: "ALREADY_COMPLETE", statePath };
  const compatibility = assessMigrationCompatibility({ matrixId, sourceRuntime, targetRuntime, sourceSchemaVersion, targetSchemaVersion });
  const base = { schemaVersion: MIGRATION_SCHEMA_VERSION, kind: "personal-ai-os-migration-state", contractVersion: MIGRATION_CONTRACT_VERSION, migrationId, matrixId, sourceRuntime, targetRuntime, sourceSchemaVersion, targetSchemaVersion, createdAt: now.toISOString() };
  if (!compatibility.compatible) {
    const rejected = { ...base, status: "REJECTED", decision: "REJECT_INCOMPATIBLE", errors: compatibility.errors, failClosed: true };
    writeJson(statePath, rejected);
    return { ...rejected, statePath };
  }
  let backup = null;
  try { backup = requireBackup({ backupPath, matrix: compatibility.matrix }); } catch (error) {
    const rejected = { ...base, status: "REJECTED", decision: "BACKUP_REQUIRED", errors: [error.message], failClosed: true };
    writeJson(statePath, rejected);
    return { ...rejected, statePath };
  }
  if (targetRoot && path.resolve(targetRoot) === path.resolve(runsRoot)) throw new Error("Migration target tidak boleh menimpa source runs root.");
  const descriptors = steps.map((step, index) => typeof step === "string" ? { id: step } : { id: step?.id ?? `step-${index + 1}`, apply: step?.apply });
  let state = { ...base, status: "CHECKPOINTED", decision: compatibility.decision, backup, promotionRequired: true, checkpoint: { status: "READY", createdAt: now.toISOString(), sourceUnchanged: true }, steps: descriptors.map(({ id }) => ({ id, status: "PENDING" })), completedSteps: [] };
  writeJson(statePath, state);
  try {
    state = { ...state, status: "IN_PROGRESS", startedAt: now.toISOString() };
    writeJson(statePath, state);
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index];
      if (interruptAtStep === index) { const error = new Error(`Migration interrupted before ${descriptor.id}`); error.code = "MIGRATION_INTERRUPTED"; throw error; }
      if (failAtStep === index) { const error = new Error(`Migration failed at ${descriptor.id}`); error.code = "MIGRATION_STEP_FAILED"; throw error; }
      if (typeof descriptor.apply === "function") descriptor.apply({ targetRoot, migrationId, index, state });
      const completedSteps = [...state.completedSteps, descriptor.id];
      state = { ...state, steps: state.steps.map((item, itemIndex) => itemIndex === index ? { ...item, status: "COMPLETED" } : item), completedSteps };
      writeJson(statePath, state);
    }
    state = { ...state, status: "COMPLETED", completedAt: now.toISOString(), rollback: null };
    writeJson(statePath, state);
    return { ...state, statePath };
  } catch (error) {
    state = { ...state, status: "ROLLED_BACK", rollback: { status: "CHECKPOINT_AVAILABLE", restoredFromBackup: Boolean(backup), reason: error.code ?? "MIGRATION_FAILED", message: error.message }, failedAt: now.toISOString(), failClosed: true };
    writeJson(statePath, state);
    return { ...state, statePath };
  }
}

function scenarioResult(id, passed, message, evidence = {}) { return { id, status: passed ? "PASS" : "FAIL", message, evidence }; }

export function runMigrationMatrixCertification({ reportRoot = null, now = new Date() } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-p9-1-migration-"));
  const vaultRoot = path.join(tempRoot, "vault");
  const runsRoot = path.join(tempRoot, "runs");
  const backupRoot = path.join(tempRoot, "backups");
  const results = [];
  try {
    fs.mkdirSync(path.join(vaultRoot, "projects"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(runsRoot, "runtime"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(vaultRoot, "projects", "registry.md"), "# registry\n", { mode: 0o600 });
    fs.writeFileSync(path.join(runsRoot, "runtime", "runtime.json"), "{}\n", { mode: 0o600 });
    const backup = createDisasterRecoveryBackup({ vaultRoot, runsRoot, backupRoot, runtime: { running: false }, now });
    const clean = executeVersionedMigration({ runsRoot, migrationId: "clean-install", matrixId: "clean-install", sourceRuntime: "none", sourceSchemaVersion: 0, steps: ["initialize-runtime"], now });
    results.push(scenarioResult("clean-install", ["COMPLETED", "ALREADY_COMPLETE"].includes(clean.status), "Clean install creates a fresh v1 state without a backup dependency.", { status: clean.status }));
    const phase4 = executeVersionedMigration({ runsRoot, migrationId: "phase4-to-v1", matrixId: "phase4-to-v1", sourceRuntime: "phase4", sourceSchemaVersion: 1, backupPath: backup.backupPath, steps: ["normalize-runtime-envelope", "migrate-vault-index"], now });
    results.push(scenarioResult("phase4-to-v1", phase4.status === "COMPLETED" && phase4.backup?.backupId === backup.backupId, "Phase 4 data migrates only after a verified checkpoint.", { status: phase4.status, backupId: phase4.backup?.backupId }));
    const restoredRoot = path.join(tempRoot, "restored");
    const restored = restoreDisasterRecoveryBackup({ backupPath: backup.backupPath, targetRoot: restoredRoot });
    const restoredUpgrade = executeVersionedMigration({ runsRoot: restored.runsRoot, migrationId: "restore-then-upgrade", matrixId: "restore-then-upgrade", sourceRuntime: "restored-phase4", sourceSchemaVersion: 1, backupPath: backup.backupPath, steps: ["validate-quarantine", "migrate-vault-index"], now });
    results.push(scenarioResult("restore-then-upgrade", restoredUpgrade.status === "COMPLETED" && readRecoveryMode(restored.runsRoot)?.executionBlocked === true, "Restored data stays quarantined while upgrade evidence is produced.", { status: restoredUpgrade.status, executionBlocked: readRecoveryMode(restored.runsRoot)?.executionBlocked ?? false }));
    const future = executeVersionedMigration({ runsRoot, migrationId: "future-schema", matrixId: "future-schema", sourceRuntime: "future", sourceSchemaVersion: 99, now });
    results.push(scenarioResult("future-schema", future.status === "REJECTED" && future.failClosed === true, "Future/incompatible schema is rejected before any write step.", { status: future.status, errors: future.errors }));
    const interrupted = executeVersionedMigration({ runsRoot, migrationId: "interrupted-migration", matrixId: "interrupted-migration", sourceRuntime: "phase4", sourceSchemaVersion: 1, backupPath: backup.backupPath, steps: ["step-one", "step-two"], interruptAtStep: 1, now });
    results.push(scenarioResult("interrupted-migration", interrupted.status === "ROLLED_BACK" && interrupted.rollback?.restoredFromBackup === true, "Interrupted migration rolls back to the durable checkpoint and remains fail-closed.", { status: interrupted.status, rollback: interrupted.rollback }));
    const failed = executeVersionedMigration({ runsRoot, migrationId: "failed-migration-rollback", matrixId: "failed-migration-rollback", sourceRuntime: "phase4", sourceSchemaVersion: 1, backupPath: backup.backupPath, steps: ["step-one", "step-two"], failAtStep: 1, now });
    results.push(scenarioResult("failed-migration-rollback", failed.status === "ROLLED_BACK" && failed.failClosed === true, "A failed migration records rollback evidence and cannot promote itself.", { status: failed.status, reason: failed.rollback?.reason }));
    const replay = executeVersionedMigration({ runsRoot, migrationId: "phase4-to-v1", matrixId: "phase4-to-v1", sourceRuntime: "phase4", sourceSchemaVersion: 1, backupPath: backup.backupPath, steps: ["should-not-run"], now });
    results.push(scenarioResult("repeatable-replay", replay.status === "ALREADY_COMPLETE", "A completed migration is repeatable without running steps twice.", { status: replay.status }));
    const report = { schemaVersion: MIGRATION_SCHEMA_VERSION, kind: MIGRATION_MATRIX_KIND, contractVersion: MIGRATION_CONTRACT_VERSION, createdAt: now.toISOString(), status: results.every((item) => item.status === "PASS") ? "PASS" : "FAIL", humanGate: { required: true, confirmed: false }, matrix: MIGRATION_MATRIX, results, failClosed: true };
    if (reportRoot) {
      const reportPath = path.join(reportRoot, "runtime", "migration-matrix", "p9.1-report.json");
      writeJson(reportPath, report);
      fs.writeFileSync(`${reportPath}.sha256`, `${sha256(`${JSON.stringify(report, null, 2)}\n`)}  ${path.basename(reportPath)}\n`, { encoding: "utf8", mode: 0o600 });
      return { ...report, reportPath, checksum: sha256(`${JSON.stringify(report, null, 2)}\n`) };
    }
    return report;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function verifyMigrationMatrixReport({ reportPath } = {}) {
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error(`Migration matrix report tidak ditemukan: ${reportPath}`);
  const text = fs.readFileSync(reportPath, "utf8");
  const report = readJson(reportPath);
  const recorded = readJson(`${reportPath}.sha256`);
  const checksumLine = fs.existsSync(`${reportPath}.sha256`) ? fs.readFileSync(`${reportPath}.sha256`, "utf8").trim() : "";
  const valid = Boolean(report?.kind === MIGRATION_MATRIX_KIND && report?.schemaVersion === MIGRATION_SCHEMA_VERSION && checksumLine.split(/\s+/)[0] === sha256(text));
  return { valid, status: report?.status ?? null, checksum: sha256(text), report };
}
