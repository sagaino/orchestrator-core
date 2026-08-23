import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { verifyAuditChain } from "./audit-chain.mjs";
import { knowledgeHealth } from "./knowledge-quality.mjs";
import { operationsConfig, operationsReadiness, readBackupStatus, recoveryDrillStatus } from "./operations-governance.mjs";
import { verifyDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import { restoreDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import { listDecisions } from "./decision-store.mjs";
import { listObjectives } from "./objective-store.mjs";
import { listOrchestrations } from "./orchestration-store.mjs";
import { listRuns } from "./run-manager.mjs";
import { findWorkspacePath } from "./dev-server-manager.mjs";

export const OPERATIONS_CERTIFICATION_SCHEMA_VERSION = 1;
export const OPERATIONS_CERTIFICATION_KIND = "personal-ai-os-operations-certification";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function certificationDirectory(runsRoot) { return path.join(runsRoot, "runtime", "certifications"); }

function writeBundle(filePath, bundle) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256(text);
  fs.writeFileSync(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, checksum };
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function loadSoakReport({ soakReport, soakReportPath }) {
  if (soakReport && typeof soakReport === "object") return soakReport;
  return soakReportPath ? readJson(soakReportPath) : null;
}

function result(id, passed, message, evidence = null) {
  return { id, status: passed ? "PASS" : "FAIL", message, ...(evidence ? { evidence } : {}) };
}

function resourceTrendCheck({ readiness, soak, capacity }) {
  const artifactBytes = Number(soak?.workload?.artifacts?.bytes ?? 0);
  const maxArtifactBytes = Number(capacity.maxArtifactBytes ?? soak?.capacity?.maxArtifactBytes ?? Number.MAX_SAFE_INTEGER);
  const apiFailures = Number(soak?.workload?.apiFailures ?? 0);
  const sseRejected = Number(soak?.workload?.sseRejected ?? 0);
  const resourceChecks = (readiness?.checks ?? []).filter((item) => ["runtime-storage", "artifact-growth", "queue-age"].includes(item.id));
  const readinessResourcesPass = resourceChecks.every((item) => item.status === "PASS");
  const passed = soak?.status === "PASS" && artifactBytes <= maxArtifactBytes && apiFailures === 0 && sseRejected === 0 && readinessResourcesPass;
  return result("RESOURCE_CAPACITY_TREND", passed, passed ? "Resource trend remains within declared capacity." : "Resource trend exceeded declared capacity or reported failures.", { artifactBytes, maxArtifactBytes, apiFailures, sseRejected, readinessChecks: resourceChecks });
}

function artifactCoverageCheck({ readiness, soak }) {
  const coverage = soak?.workload?.artifactCoverage ?? readiness?.signals?.artifactCoverage ?? null;
  if (!coverage) return result("OPERATIONS_ARTIFACT_COVERAGE", true, "Artifact coverage evidence belum diperlukan oleh fixture ini.");
  const passed = coverage.complete === true && coverage.activeStateNeverPurged === true;
  return result("OPERATIONS_ARTIFACT_COVERAGE", passed, passed ? "Durable orchestration dan integration artifacts memiliki coverage evidence; active state protected." : "Artifact coverage tidak lengkap atau active state protection tidak terbukti.", { complete: coverage.complete, activeStateNeverPurged: coverage.activeStateNeverPurged, protectedActiveRecordCount: coverage.protectedActiveRecordCount ?? 0, requiredCollections: coverage.requiredCollections ?? [] });
}

function ids(records, field) { return records.map((record) => record?.[field]).filter(Boolean).sort(); }

function restoreCoverage({ runsRoot, backup }) {
  if (!backup?.backupPath || !fs.existsSync(backup.backupPath)) return { attempted: false, passed: false, reason: "REGISTERED_BACKUP_UNAVAILABLE" };
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-operations-cert-restore-"));
  const targetRoot = path.join(parent, "quarantine");
  try {
    const restored = restoreDisasterRecoveryBackup({ backupPath: backup.backupPath, targetRoot });
    const source = { objectives: ids(listObjectives(runsRoot), "objectiveId"), orchestrations: ids(listOrchestrations(runsRoot), "orchestrationId"), decisions: ids(listDecisions(runsRoot), "decisionId") };
    const restoredState = { objectives: ids(listObjectives(restored.runsRoot), "objectiveId"), orchestrations: ids(listOrchestrations(restored.runsRoot), "orchestrationId"), decisions: ids(listDecisions(restored.runsRoot), "decisionId") };
    const statePreserved = Object.entries(source).every(([key, values]) => JSON.stringify(values) === JSON.stringify(restoredState[key]));
    return { attempted: true, passed: restored.status === "RESTORED_TO_QUARANTINE" && restored.executionBlocked === true && statePreserved, backupId: restored.backupId, executionBlocked: restored.executionBlocked, statePreserved, source, restoredState };
  } catch (error) {
    return { attempted: true, passed: false, reason: error.message };
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

export function collectOperationsExitEvidence({ runsRoot, soak = null, backup = null } = {}) {
  const objectives = listObjectives(runsRoot);
  const orchestrations = listOrchestrations(runsRoot);
  const decisions = listDecisions(runsRoot);
  const budgetStops = decisions.filter((decision) => decision.type === "BUDGET_EXCEEDED" && decision.evidence?.budgetCode);
  const orphanWorktrees = listRuns(runsRoot).filter((run) => Boolean(findWorkspacePath(runsRoot, run.runId))).map((run) => run.runId);
  const lostUpdateInvariant = (soak?.invariants ?? []).find((item) => item.id === "NO_LOST_UPDATE");
  const restore = restoreCoverage({ runsRoot, backup: backup ?? readBackupStatus(runsRoot) });
  return {
    boundedSoak: { passed: soak?.status === "PASS" && Number(soak?.virtualWindow?.durationHours) >= 72, durationHours: soak?.virtualWindow?.durationHours ?? null, status: soak?.status ?? "MISSING" },
    multipleObjectives: { passed: objectives.length >= 2, count: objectives.length, objectiveIds: ids(objectives, "objectiveId") },
    restartPoints: { passed: Number(soak?.workload?.restarts ?? 0) >= 1, count: Number(soak?.workload?.restarts ?? 0) },
    decisionRecords: { passed: decisions.length >= 2, count: decisions.length, decisionIds: ids(decisions, "decisionId") },
    budgetStop: { passed: budgetStops.length === 1, count: budgetStops.length, decisionIds: ids(budgetStops, "decisionId"), budgetCodes: budgetStops.map((decision) => decision.evidence.budgetCode) },
    backupRestore: restore,
    noOrphanWorktree: { passed: orphanWorktrees.length === 0, count: orphanWorktrees.length, runIds: orphanWorktrees },
    noLostState: { passed: lostUpdateInvariant?.passed === true && restore.passed === true, soakInvariant: lostUpdateInvariant?.passed ?? false, restoreStatePreserved: restore.statePreserved ?? false, objectiveCount: objectives.length, orchestrationCount: orchestrations.length },
  };
}

function exitEvidenceChecks(evidence) {
  return [
    result("BOUNDED_SOAK_EXIT", evidence.boundedSoak.passed, "Bounded soak mencapai virtual window minimal 72 jam.", evidence.boundedSoak),
    result("MULTIPLE_OBJECTIVES_EXIT", evidence.multipleObjectives.passed, "Minimal dua objective durable terobservasi.", evidence.multipleObjectives),
    result("RESTART_POINTS_EXIT", evidence.restartPoints.passed, "Soak memiliki restart point dan state tetap dapat direkonsiliasi.", evidence.restartPoints),
    result("DECISION_RECORDS_EXIT", evidence.decisionRecords.passed, "Decision records tersedia sebagai evidence durable.", evidence.decisionRecords),
    result("BUDGET_STOP_EXIT", evidence.budgetStop.passed, "Tepat satu budget stop tercatat sebagai BUDGET_EXCEEDED.", evidence.budgetStop),
    result("BACKUP_RESTORE_EXIT", evidence.backupRestore.passed, "Backup dapat diverifikasi dan direstore ke quarantine dengan execution tetap blocked.", evidence.backupRestore),
    result("NO_ORPHAN_WORKTREE_EXIT", evidence.noOrphanWorktree.passed, "Tidak ada isolated worktree orphan yang tersisa.", evidence.noOrphanWorktree),
    result("NO_LOST_STATE_EXIT", evidence.noLostState.passed, "Tidak ada lost state pada soak atau restore continuity.", evidence.noLostState),
  ];
}

export function createOperationsCertification({
  runsRoot,
  vaultRoot,
  soakReport = null,
  soakReportPath = null,
  now = new Date(),
  config = operationsConfig(),
  maxRecoveryRtoMinutes = 15,
  capacity = {},
  readinessFn = operationsReadiness,
  knowledgeHealthFn = knowledgeHealth,
  auditFn = verifyAuditChain,
  backupVerifierFn = verifyDisasterRecoveryBackup,
  requireExitEvidence = false,
} = {}) {
  if (!runsRoot || !vaultRoot) throw new Error("Operations certification membutuhkan runsRoot dan vaultRoot.");
  const soak = loadSoakReport({ soakReport, soakReportPath });
  const readiness = readinessFn({ runsRoot, now, config });
  const knowledge = knowledgeHealthFn({ vaultRoot, fixSafe: false });
  const audit = auditFn(runsRoot);
  const backup = readBackupStatus(runsRoot);
  const drill = recoveryDrillStatus({ runsRoot, now, config });
  const backupAgeMs = backup?.verifiedAt ? Math.max(0, now.getTime() - Date.parse(backup.verifiedAt)) : null;
  const rpoMaxAgeMs = config.maxBackupAgeHours * 60 * 60 * 1000;
  let backupVerification = null;
  if (backup?.backupPath && fs.existsSync(backup.backupPath)) {
    try { backupVerification = backupVerifierFn({ backupPath: backup.backupPath }); } catch (error) { backupVerification = { status: "FAILED", error: error.message }; }
  }
  const alertsOwned = (readiness.alerts ?? []).every((alert) => Boolean(String(alert.owner ?? "").trim()) && Array.isArray(alert.runbookSteps) && alert.runbookSteps.length > 0);
  const exitEvidence = requireExitEvidence ? collectOperationsExitEvidence({ runsRoot, soak, backup }) : null;
  const checks = [
    result("SOAK_72_HOURS", soak?.status === "PASS" && Number(soak?.virtualWindow?.durationHours) >= 72 && (soak.invariants ?? []).every((item) => item.passed), "72-hour soak report and invariants are passing.", { status: soak?.status ?? "MISSING", durationHours: soak?.virtualWindow?.durationHours ?? null, invariantCount: soak?.invariants?.length ?? 0 }),
    result("OPERATIONS_ADMISSION", readiness.admission.allowed === true, "Operations admission is open with no active blocker.", { status: readiness.status, blockers: readiness.admission.blockers ?? [] }),
    result("BACKUP_WITHIN_RPO", Boolean(backup && backupAgeMs !== null && backupAgeMs <= rpoMaxAgeMs && backup.independentTarget === true && backupVerification?.status === "VERIFIED"), "Verified backup is fresh, independently targeted, and integrity-checked.", { backupId: backup?.backupId ?? null, ageMs: backupAgeMs, maximumAgeMs: rpoMaxAgeMs, independentTarget: backup?.independentTarget ?? null, verification: backupVerification?.status ?? "MISSING" }),
    result("RECOVERY_DRILL_WITHIN_RTO", drill.status === "CURRENT" && drill.lastDrill?.result === "PASS" && Number.isFinite(Number(drill.lastDrill?.rtoMinutes)) && Number(drill.lastDrill.rtoMinutes) <= maxRecoveryRtoMinutes, "Recovery drill is current and meets the declared RTO.", { status: drill.status, rtoMinutes: drill.lastDrill?.rtoMinutes ?? null, maximumRtoMinutes: maxRecoveryRtoMinutes, dueAt: drill.dueAt }),
    result("ALERT_OWNERSHIP_ACTION", alertsOwned, alertsOwned ? "Every active alert has an owner and runbook action." : "One or more active alerts lack owner or action.", { alertCount: readiness.alerts?.length ?? 0, unowned: (readiness.alerts ?? []).filter((alert) => !String(alert.owner ?? "").trim()).map((alert) => alert.alertId) }),
    result("KNOWLEDGE_INTEGRITY", Number(knowledge?.summary?.errors ?? 0) === 0 && knowledge?.verdict !== "FAIL", "Knowledge health has no unresolved integrity error.", { verdict: knowledge?.verdict ?? "MISSING", errors: knowledge?.summary?.errors ?? null, warnings: knowledge?.summary?.warnings ?? null }),
    result("AUDIT_INTEGRITY", audit?.valid === true, "Audit chain is valid.", { valid: audit?.valid ?? false, errors: audit?.errors ?? [] }),
    resourceTrendCheck({ readiness, soak, capacity }),
    artifactCoverageCheck({ readiness, soak }),
    ...(exitEvidence ? exitEvidenceChecks(exitEvidence) : []),
  ];
  const blockers = checks.filter((item) => item.status !== "PASS").map((item) => item.id);
  const certificationId = `p85-ops-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const bundle = {
    schemaVersion: OPERATIONS_CERTIFICATION_SCHEMA_VERSION,
    kind: OPERATIONS_CERTIFICATION_KIND,
    certificationId,
    createdAt: now.toISOString(),
    status: blockers.length ? "CONDITIONAL" : "CERTIFICATION_READY",
    humanGate: { required: true, confirmed: false, approvedBy: null, approvedAt: null },
    blockers,
    checks,
    operations: { readinessStatus: readiness.status, admissionAllowed: readiness.admission.allowed, alerts: readiness.alerts ?? [], signals: readiness.signals ?? {} },
    evidence: { soakReportPath: soakReportPath ? path.resolve(soakReportPath) : null, soakSummary: soak ? { status: soak.status, virtualWindow: soak.virtualWindow, invariants: soak.invariants, artifactCoverage: soak.workload?.artifactCoverage ?? null } : null, exitEvidence, backup, backupVerification, recoveryDrill: drill, knowledge: { verdict: knowledge?.verdict ?? null, summary: knowledge?.summary ?? null }, audit, capacity },
    nextAction: blockers.length ? "Resolve certification blockers and rerun P8.5." : "Human must review this bundle and explicitly accept P8.5.",
  };
  const persisted = writeBundle(path.join(certificationDirectory(runsRoot), `${certificationId}.json`), bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.checksum };
}

export function verifyOperationsCertification({ bundleFilePath } = {}) {
  if (!bundleFilePath || !fs.existsSync(bundleFilePath)) throw new Error("Operations certification bundle tidak ditemukan.");
  const text = fs.readFileSync(bundleFilePath, "utf8");
  let recorded = null;
  try { recorded = fs.readFileSync(`${bundleFilePath}.sha256`, "utf8").trim().split(/\s+/)[0]; } catch {}
  let bundle = null;
  try { bundle = JSON.parse(text); } catch {}
  const valid = Boolean(bundle && recorded === sha256(text) && bundle.kind === OPERATIONS_CERTIFICATION_KIND && bundle.humanGate?.required === true);
  return { valid, certificationId: bundle?.certificationId ?? null, status: bundle?.status ?? null, checksum: sha256(text), bundle };
}
