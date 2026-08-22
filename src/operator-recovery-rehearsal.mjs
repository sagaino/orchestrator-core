import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createDisasterRecoveryBackup, restoreDisasterRecoveryBackup, verifyDisasterRecoveryBackup } from "./disaster-recovery.mjs";
import { assertExecutionAllowed, readRecoveryMode } from "./recovery-mode.mjs";

export const RECOVERY_REHEARSAL_SCHEMA_VERSION = 1;
export const RECOVERY_REHEARSAL_CONTRACT_VERSION = "p9.3-2026-08-22";
export const RECOVERY_REHEARSAL_KIND = "personal-ai-os-operator-recovery-rehearsal";
export const DEFAULT_OPERATOR_RUNBOOK_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../P9_3_OPERATOR_RUNBOOK.md");

const REQUIRED_SECTIONS = [
  "Safety boundary",
  "Install on a clean supported host",
  "Start and stop",
  "Task lifecycle",
  "Review, request changes, accept, or reject",
  "Update and rollback",
  "Alerts and operations",
  "Backup",
  "Restore to a clean recovery target",
  "Emergency recovery",
  "Explicit promotion gate",
];

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return { filePath, checksum: sha256(text) };
}

function persistEvidenceBundle({ reportRoot, backup, restored, backupVerification }) {
  const bundleRoot = path.join(reportRoot, "runtime", "recovery-rehearsal", "evidence", backup.backupId);
  fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  const sources = [
    { label: "backup-manifest", source: path.join(backup.backupPath, "manifest.json") },
    { label: "backup-ready", source: path.join(backup.backupPath, "READY") },
    { label: "restored-registry", source: path.join(restored.vaultRoot, "project-registry.md") },
    { label: "restored-audit-head", source: path.join(restored.runsRoot, "runtime", "audit-head.json") },
  ].filter((item) => fs.existsSync(item.source));
  const artifacts = sources.map((item) => {
    const extension = path.extname(item.source);
    const destination = path.join(bundleRoot, `${item.label}${extension}`);
    const content = fs.readFileSync(item.source);
    fs.writeFileSync(destination, content, { mode: 0o600 });
    return { label: item.label, relativePath: path.relative(reportRoot, destination), checksum: createHash("sha256").update(content).digest("hex") };
  });
  const manifest = { schemaVersion: 1, backupId: backup.backupId, verification: { status: backupVerification.status, fileCount: backupVerification.fileCount, totalBytes: backupVerification.totalBytes }, artifacts };
  const persisted = writePrivateJson(path.join(bundleRoot, "evidence-manifest.json"), manifest);
  return { root: path.relative(reportRoot, bundleRoot), manifest: path.relative(reportRoot, persisted.filePath), checksum: persisted.checksum, artifacts };
}

function runbookChecks(runbookText) {
  const missingSections = REQUIRED_SECTIONS.filter((section) => !runbookText.includes(`## ${section}`));
  const requiredSafetyTerms = ["human", "quarantine", "checksum", "executionBlocked", "secret"];
  const missingSafetyTerms = requiredSafetyTerms.filter((term) => !runbookText.toLowerCase().includes(term.toLowerCase()));
  return { passed: missingSections.length === 0 && missingSafetyTerms.length === 0, missingSections, missingSafetyTerms, sectionCount: REQUIRED_SECTIONS.length };
}

function fixtureRoots(root) {
  return { vaultRoot: path.join(root, "vault"), runsRoot: path.join(root, "runs"), backupRoot: path.join(root, "external-backups") };
}

export function runOperatorRecoveryRehearsal({ reportRoot = null, runbookPath = DEFAULT_OPERATOR_RUNBOOK_PATH, now = new Date() } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-p9-3-rehearsal-"));
  const source = fixtureRoots(path.join(tempRoot, "source"));
  const targetRoot = path.join(tempRoot, "clean-recovery-target");
  try {
    const runbookText = fs.readFileSync(runbookPath, "utf8");
    const documentation = runbookChecks(runbookText);
    fs.mkdirSync(path.join(source.vaultRoot, "02-Projects", "pilot", "tasks"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(source.runsRoot, "runtime"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source.vaultRoot, "project-registry.md"), "# Registered Projects\n\n- pilot\n", { mode: 0o600 });
    fs.writeFileSync(path.join(source.vaultRoot, "02-Projects", "pilot", "tasks", "TASK-RECOVERY.md"), "---\ntask_id: TASK-RECOVERY\nstatus: DONE\n---\n\n# Recovery rehearsal\n", { mode: 0o600 });
    fs.writeFileSync(path.join(source.runsRoot, "runtime", "audit-head.json"), JSON.stringify({ schemaVersion: 1, head: "fixture-audit-head" }) + "\n", { mode: 0o600 });
    const backup = createDisasterRecoveryBackup({ ...source, runtime: { running: false }, now });
    const backupVerification = verifyDisasterRecoveryBackup({ backupPath: backup.backupPath });
    const restored = restoreDisasterRecoveryBackup({ backupPath: backup.backupPath, targetRoot });
    const restoredRegistry = path.join(restored.vaultRoot, "project-registry.md");
    const restoredAudit = path.join(restored.runsRoot, "runtime", "audit-head.json");
    const recoveryMode = readRecoveryMode(restored.runsRoot);
    let executionBlocked = false;
    let blockCode = null;
    try { assertExecutionAllowed(restored.runsRoot); } catch (error) { executionBlocked = error.code === "RECOVERY_MODE_BLOCKED"; blockCode = error.code ?? null; }
    const reconstruction = {
      registryRestored: fs.existsSync(restoredRegistry),
      taskRestored: fs.existsSync(path.join(restored.vaultRoot, "02-Projects", "pilot", "tasks", "TASK-RECOVERY.md")),
      auditRestored: fs.existsSync(restoredAudit),
      recoveryMarkerPresent: Boolean(recoveryMode?.executionBlocked),
      executionBlocked,
      blockCode,
    };
    const checks = {
      documentationComplete: documentation.passed,
      backupVerified: backupVerification.status === "VERIFIED",
      cleanTargetReconstructed: reconstruction.registryRestored && reconstruction.taskRestored && reconstruction.auditRestored,
      quarantinePreserved: reconstruction.recoveryMarkerPresent && restored.executionBlocked === true,
      mutationBlocked: reconstruction.executionBlocked,
      promotionExplicit: restored.executionBlocked === true && !reconstruction.promoted,
    };
    const evidenceBundle = reportRoot ? persistEvidenceBundle({ reportRoot, backup, restored, backupVerification }) : null;
    const report = {
      schemaVersion: RECOVERY_REHEARSAL_SCHEMA_VERSION,
      kind: RECOVERY_REHEARSAL_KIND,
      contractVersion: RECOVERY_REHEARSAL_CONTRACT_VERSION,
      createdAt: now.toISOString(),
      status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
      humanGate: { required: true, confirmed: false, instruction: "Review rehearsal evidence and explicitly promote only after compatibility and health checks." },
      runbook: { path: path.resolve(runbookPath), checksum: sha256(runbookText), requiredSections: REQUIRED_SECTIONS, documentation },
      backup: { backupId: backup.backupId, temporarySourceRemoved: true, verification: { status: backupVerification.status, fileCount: backupVerification.fileCount, totalBytes: backupVerification.totalBytes } },
      restore: { temporaryTargetRemoved: true, status: restored.status, executionBlocked: restored.executionBlocked, reconstruction },
      evidenceBundle,
      checks,
      promotion: { performed: false, requiresHuman: true },
    };
    if (reportRoot) {
      const reportPath = path.join(reportRoot, "runtime", "recovery-rehearsal", "p9.3-report.json");
      const persisted = writePrivateJson(reportPath, report);
      fs.writeFileSync(`${reportPath}.sha256`, `${persisted.checksum}  ${path.basename(reportPath)}\n`, { encoding: "utf8", mode: 0o600 });
      return { ...report, reportPath, checksum: persisted.checksum };
    }
    return report;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function verifyRecoveryRehearsalReport({ reportPath } = {}) {
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error(`Recovery rehearsal report tidak ditemukan: ${reportPath}`);
  const text = fs.readFileSync(reportPath, "utf8");
  let report = null;
  try { report = JSON.parse(text); } catch { return { valid: false, status: null, checksum: sha256(text), report: null }; }
  const checksumText = fs.existsSync(`${reportPath}.sha256`) ? fs.readFileSync(`${reportPath}.sha256`, "utf8").trim() : "";
  const reportRoot = path.resolve(path.dirname(reportPath), "../..");
  const artifactsValid = Array.isArray(report?.evidenceBundle?.artifacts) && report.evidenceBundle.artifacts.length > 0 && report.evidenceBundle.artifacts.every((artifact) => {
    const artifactPath = path.join(reportRoot, artifact.relativePath);
    return fs.existsSync(artifactPath) && sha256(fs.readFileSync(artifactPath)) === artifact.checksum;
  });
  return { valid: report?.kind === RECOVERY_REHEARSAL_KIND && report?.schemaVersion === RECOVERY_REHEARSAL_SCHEMA_VERSION && report?.status === "PASS" && checksumText.split(/\s+/)[0] === sha256(text) && artifactsValid, status: report?.status ?? null, checksum: sha256(text), artifactsValid, report };
}
