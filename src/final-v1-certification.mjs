import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReleaseManifest, verifyReleaseManifestFile } from "./release-manifest.mjs";
import { verifyAuditChain } from "./audit-chain.mjs";
import { redactText } from "./redaction.mjs";
import { verifyMigrationMatrixReport } from "./migration-upgrade.mjs";
import { verifyFinalPilotCohortReport } from "./final-pilot-cohort.mjs";
import { verifyRecoveryRehearsalReport } from "./operator-recovery-rehearsal.mjs";
import { verifyReleaseArtifact } from "./release-artifact.mjs";
import { DEFAULT_VAULT } from "./core.mjs";
import { readBackupStatus } from "./operations-governance.mjs";

export const FINAL_CERTIFICATION_SCHEMA_VERSION = 2;
export const FINAL_CERTIFICATION_CONTRACT_VERSION = "p9.4-ga-remediation-2026-08-22";
export const FINAL_CERTIFICATION_KIND = "personal-ai-os-v1-final-certification";
export const FINAL_CERTIFICATION_VERSION = "1.0.3";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_DASHBOARD_ROOT = path.resolve(REPO_ROOT, "../../ciniru/orchestrator-dashboard");

export const FINAL_GATE_IDS = Object.freeze([
  "adversarial",
  "reliability",
  "recovery",
  "operations",
  "browser",
  "benchmark",
  "self-update",
  "visual-qa",
  "soak",
  "install",
  "migration",
]);

export const FINAL_THREAT_MODEL = Object.freeze([
  { id: "TM-001", threat: "Unauthorized mutation or self-approval", inherentSeverity: "HIGH", residualSeverity: "LOW", control: "Approval-gated run lifecycle, external supervisor, explicit human gates" },
  { id: "TM-002", threat: "Secret exposure through task/evidence/log output", inherentSeverity: "HIGH", residualSeverity: "LOW", control: "Redaction, private artifacts, secret scan, local-only binding" },
  { id: "TM-003", threat: "Recovery target promoted before validation", inherentSeverity: "HIGH", residualSeverity: "LOW", control: "RECOVERY_QUARANTINE and executionBlocked until explicit promotion" },
  { id: "TM-004", threat: "Audit or certification evidence tampering", inherentSeverity: "HIGH", residualSeverity: "LOW", control: "SHA-256 sidecars and previous-hash audit chain" },
  { id: "TM-005", threat: "Unbounded runtime/artifact growth", inherentSeverity: "MEDIUM", residualSeverity: "MEDIUM", control: "Soak/capacity limits, alert ownership, retention preview", owner: "operations-operator", expiresAt: "2026-09-30", acceptedBy: "strong-review:p9.4", acceptedAt: "2026-08-22T00:00:00.000Z" },
  { id: "TM-006", threat: "Browser or host compatibility drift", inherentSeverity: "MEDIUM", residualSeverity: "LOW", control: "Release compatibility matrix and browser regression gate" },
  { id: "TM-007", threat: "Provider or dependency failure causes unsafe retry", inherentSeverity: "MEDIUM", residualSeverity: "LOW", control: "Exactly-once admission, bounded recovery, fail-closed rollback" },
]);

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256(text);
  fs.writeFileSync(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, checksum };
}

function repoCommit(repoRoot) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(); } catch { return null; }
}

function repositoryClean(repoRoot) {
  try { return execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim() === ""; } catch { return false; }
}

function gateDefinitions({ repoRoot, dashboardRoot }) {
  const node = process.execPath;
  return [
    { id: "adversarial", cwd: repoRoot, command: "npm", args: ["run", "test:security:certification"] },
    { id: "reliability", cwd: repoRoot, command: "npm", args: ["run", "test:reliability"] },
    { id: "recovery", cwd: repoRoot, command: "npm", args: ["run", "test:recovery-rehearsal"] },
    { id: "operations", cwd: repoRoot, command: "npm", args: ["run", "operations:readiness"] },
    { id: "browser", cwd: dashboardRoot, command: "npm", args: ["run", "test:verify"] },
    { id: "benchmark", cwd: repoRoot, command: node, args: ["test/efficiency-certification.test.mjs"] },
    { id: "self-update", cwd: repoRoot, command: node, args: ["test/release-certification.test.mjs"] },
    { id: "visual-qa", cwd: repoRoot, command: node, args: ["test/visual-certification.test.mjs"] },
    { id: "soak", cwd: repoRoot, command: node, args: ["test/soak-capacity-harness.test.mjs"] },
    { id: "install", cwd: repoRoot, command: "npm", args: ["run", "test:release-packaging"] },
    { id: "migration", cwd: repoRoot, command: node, args: ["test/migration-upgrade.test.mjs"] },
  ];
}

function runGate(definition) {
  const started = Date.now();
  const result = spawnSync(definition.command, definition.args, { cwd: definition.cwd, encoding: "utf8", timeout: 180_000, env: { ...process.env, CI: "1" } });
  const output = redactText(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).trim();
  return { id: definition.id, status: result.status === 0 ? "PASS" : "FAIL", command: [definition.command, ...definition.args].join(" "), cwd: definition.cwd, exitCode: result.status ?? null, signal: result.signal ?? null, durationMs: Date.now() - started, outputTail: output.slice(-800), timedOut: result.error?.code === "ETIMEDOUT" };
}

function normalizeGateResults(gates, definitions) {
  if (!gates) return definitions.map(runGate);
  return definitions.map((definition) => {
    const supplied = Array.isArray(gates) ? gates.find((item) => item.id === definition.id) : gates[definition.id];
    return { id: definition.id, status: supplied?.status === "PASS" ? "PASS" : "FAIL", command: supplied?.command ?? [definition.command, ...definition.args].join(" "), exitCode: supplied?.exitCode ?? (supplied?.status === "PASS" ? 0 : 1), durationMs: supplied?.durationMs ?? 0, outputTail: supplied?.outputTail ?? "injected evidence", injected: true };
  });
}

function riskReview(threatModel, now) {
  const risks = threatModel.map((risk) => ({ ...risk, valid: risk.residualSeverity !== "MEDIUM" || (Boolean(risk.owner) && Boolean(risk.control) && Boolean(risk.expiresAt) && Boolean(risk.acceptedBy) && Boolean(risk.acceptedAt) && Date.parse(risk.expiresAt) > now.getTime()) }));
  return { risks, noCriticalHigh: risks.every((risk) => !["CRITICAL", "HIGH"].includes(risk.residualSeverity)), mediumControlled: risks.filter((risk) => risk.residualSeverity === "MEDIUM").every((risk) => risk.valid) };
}

function verifyBundleChecksums(reportRoot, relativePaths) {
  const checks = relativePaths.map((relativePath) => {
    const filePath = path.join(reportRoot, relativePath);
    if (!fs.existsSync(filePath) || !fs.existsSync(`${filePath}.sha256`)) return { path: filePath, valid: false, reason: "missing" };
    const text = fs.readFileSync(filePath, "utf8");
    const recorded = fs.readFileSync(`${filePath}.sha256`, "utf8").trim().split(/\s+/)[0];
    return { path: filePath, valid: recorded === sha256(text), checksum: sha256(text) };
  });
  return { valid: checks.length > 0 && checks.every((item) => item.valid), checks };
}

function safeEvidenceVerification(verify, reportPath) {
  try { return verify({ reportPath }); } catch (error) { return { valid: false, status: null, checksum: null, error: error.message }; }
}

export async function runFinalV1Certification({ reportRoot = null, repoRoot = REPO_ROOT, dashboardRoot = null, gateResults = null, executeGates = true, allowInjectedTestEvidence = false, now = new Date(), releaseVersion = FINAL_CERTIFICATION_VERSION } = {}) {
  if (!executeGates && !allowInjectedTestEvidence) throw new Error("Injected gate evidence dilarang untuk final certification produksi.");
  const resolvedReportRoot = path.resolve(reportRoot ?? path.join(repoRoot, "runs"));
  const resolvedDashboardRoot = path.resolve(dashboardRoot ?? process.env.ORCHESTRATOR_DASHBOARD_PATH ?? DEFAULT_DASHBOARD_ROOT);
  const definitions = gateDefinitions({ repoRoot: path.resolve(repoRoot), dashboardRoot: resolvedDashboardRoot });
  const gates = executeGates ? normalizeGateResults(null, definitions) : normalizeGateResults(gateResults, definitions);
  const sourceCommit = repoCommit(repoRoot);
  const registeredBackup = readBackupStatus(resolvedReportRoot);
  const backupRoot = path.resolve(process.env.ORCHESTRATOR_BACKUP_ROOT ?? (registeredBackup?.backupPath ? path.dirname(registeredBackup.backupPath) : path.join(path.dirname(resolvedReportRoot), "external-backups")));
  const manifest = createReleaseManifest({ sourceRoot: repoRoot, dashboardRoot: resolvedDashboardRoot, vaultRoot: path.resolve(process.env.ORCHESTRATOR_VAULT ?? DEFAULT_VAULT), runsRoot: resolvedReportRoot, backupRoot, releaseVersion, sourceCommit, now });
  const manifestPath = path.join(resolvedReportRoot, "runtime", "release-manifest", `v${releaseVersion}.json`);
  const manifestPersisted = writePrivateJson(manifestPath, manifest);
  const manifestVerification = verifyReleaseManifestFile({ manifestPath });
  const audit = verifyAuditChain(resolvedReportRoot);
  const risk = riskReview(FINAL_THREAT_MODEL, now);
  const bundleChecksums = verifyBundleChecksums(resolvedReportRoot, [
    "runtime/migration-matrix/p9.1-report.json",
    "runtime/pilot-cohort/p9.2-report.json",
    "runtime/recovery-rehearsal/p9.3-report.json",
    `runtime/release-manifest/v${releaseVersion}.json`,
  ]);
  const durableEvidence = {
    migration: safeEvidenceVerification(verifyMigrationMatrixReport, path.join(resolvedReportRoot, "runtime", "migration-matrix", "p9.1-report.json")),
    pilot: safeEvidenceVerification(verifyFinalPilotCohortReport, path.join(resolvedReportRoot, "runtime", "pilot-cohort", "p9.2-report.json")),
    recovery: safeEvidenceVerification(verifyRecoveryRehearsalReport, path.join(resolvedReportRoot, "runtime", "recovery-rehearsal", "p9.3-report.json")),
  };
  const releaseArtifact = verifyReleaseArtifact({ manifestPath: path.join(resolvedReportRoot, "runtime", "release-artifacts", `v${releaseVersion}`, "release-artifact.json") });
  const documentationPaths = ["P9_3_OPERATOR_RUNBOOK.md", "P9_4_THREAT_MODEL.md", "PHASE_9_GA_CONTRACT.md", "PHASE_5_TO_V1_EXECUTION_PLAN.md", "AI_OS_MVP_SCOPE.md"];
  const documentation = { valid: documentationPaths.every((item) => fs.existsSync(path.join(repoRoot, item))), paths: documentationPaths.map((item) => path.join(repoRoot, item)) };
  const checks = {
    allRequiredGatesPass: FINAL_GATE_IDS.every((id) => gates.find((gate) => gate.id === id)?.status === "PASS"),
    noCriticalHighResidualRisk: risk.noCriticalHigh,
    mediumRisksControlled: risk.mediumControlled,
    repositoriesClean: repositoryClean(repoRoot) && repositoryClean(resolvedDashboardRoot),
    documentationPresent: documentation.valid,
    releaseManifestValid: manifestVerification.valid === true,
    bundleChecksumsValid: bundleChecksums.valid,
    durableEvidenceValid: Object.values(durableEvidence).every((item) => item.valid === true),
    releaseArtifactValid: releaseArtifact.valid === true && releaseArtifact.manifest?.components?.some((item) => item.label === "backend" && item.commit === sourceCommit) && releaseArtifact.manifest?.components?.some((item) => item.label === "dashboard" && item.commit === repoCommit(resolvedDashboardRoot)),
    auditHeadValid: audit.valid === true,
    releaseProvenanceAnchored: Boolean(sourceCommit && manifest.provenance?.sourceCommit === sourceCommit && manifestVerification.valid === true),
    dashboardProvenanceAnchored: Boolean(manifest.provenance?.dashboardCommit && manifest.provenance.dashboardCommit === repoCommit(resolvedDashboardRoot)),
    nonInjectedGateEvidence: gates.every((gate) => gate.injected !== true),
  };
  const report = {
    schemaVersion: FINAL_CERTIFICATION_SCHEMA_VERSION,
    kind: FINAL_CERTIFICATION_KIND,
    contractVersion: FINAL_CERTIFICATION_CONTRACT_VERSION,
    releaseVersion,
    certificationId: `v1-final-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`,
    createdAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: Object.values(checks).every(Boolean) ? "CERTIFIED_HUMAN_GATE_REQUIRED" : "CONDITIONAL",
    humanGate: { required: true, approved: false, approvedBy: null, approvedAt: null, instruction: `Human must review this certificate and explicitly assign v${releaseVersion}; certificate never self-approves.` },
    checks,
    gates,
    threatModel: risk,
    provenance: { sourceCommit, dashboardCommit: repoCommit(resolvedDashboardRoot), manifestPath, manifestChecksum: manifestPersisted.checksum, manifestVerification, auditHead: audit.head ?? null, auditEntries: audit.entries ?? 0 },
    evidence: { documentation, bundleChecksums, durableEvidence: Object.fromEntries(Object.entries(durableEvidence).map(([key, value]) => [key, { valid: value.valid, status: value.status, checksum: value.checksum }])), releaseArtifact: { valid: releaseArtifact.valid, manifestPath: path.join(resolvedReportRoot, "runtime", "release-artifacts", `v${releaseVersion}`, "release-artifact.json"), checksum: releaseArtifact.valid ? sha256(fs.readFileSync(path.join(resolvedReportRoot, "runtime", "release-artifacts", `v${releaseVersion}`, "release-artifact.json"), "utf8")) : null }, reportRoots: { backend: path.resolve(repoRoot), dashboard: resolvedDashboardRoot, runs: resolvedReportRoot } },
    nextAction: `Human gate remains required before v${releaseVersion} is assigned or production activation occurs.`,
  };
  const reportPath = path.join(resolvedReportRoot, "runtime", "certifications", `v${releaseVersion}-final-certificate.json`);
  const persisted = writePrivateJson(reportPath, report);
  return { ...report, reportPath: persisted.filePath, checksum: persisted.checksum };
}

export function verifyFinalV1Certificate({ reportPath } = {}) {
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error(`Final v1 certificate tidak ditemukan: ${reportPath}`);
  const text = fs.readFileSync(reportPath, "utf8");
  let report = null;
  try { report = JSON.parse(text); } catch { return { valid: false, status: null, checksum: sha256(text), report: null }; }
  const checksumText = fs.existsSync(`${reportPath}.sha256`) ? fs.readFileSync(`${reportPath}.sha256`, "utf8").trim() : "";
  const checksumValid = checksumText.split(/\s+/)[0] === sha256(text);
  const allChecksPass = report?.checks && Object.values(report.checks).every(Boolean);
  const currentSource = report?.evidence?.reportRoots?.backend ? repoCommit(report.evidence.reportRoots.backend) : null;
  const currentDashboard = report?.evidence?.reportRoots?.dashboard ? repoCommit(report.evidence.reportRoots.dashboard) : null;
  const provenanceCurrent = Boolean(currentSource && currentDashboard && currentSource === report?.provenance?.sourceCommit && currentDashboard === report?.provenance?.dashboardCommit);
  const notExpired = Number.isFinite(Date.parse(report?.validUntil)) && Date.parse(report.validUntil) >= Date.now();
  const integrityValid = report?.kind === FINAL_CERTIFICATION_KIND && report?.schemaVersion === FINAL_CERTIFICATION_SCHEMA_VERSION && checksumValid;
  const valid = integrityValid && report?.status === "CERTIFIED" && report?.humanGate?.approved === true && allChecksPass && provenanceCurrent && notExpired;
  return { valid, integrityValid, checksumValid, allChecksPass, provenanceCurrent, notExpired, status: report?.status ?? null, checksum: sha256(text), report };
}

export function acceptFinalV1Certificate({ reportPath, approvedBy, now = new Date() } = {}) {
  if (!String(approvedBy ?? "").trim()) throw new Error("Final certificate acceptance membutuhkan identitas operator.");
  const verification = verifyFinalV1Certificate({ reportPath });
  const report = verification.report;
  if (!verification.integrityValid || report?.status !== "CERTIFIED_HUMAN_GATE_REQUIRED" || !report?.checks || !Object.values(report.checks).every(Boolean)) throw new Error("Certificate belum memenuhi seluruh machine gate.");
  if (!verification.provenanceCurrent || !verification.notExpired) throw new Error("Certificate stale atau provenance tidak lagi cocok.");
  const accepted = { ...report, status: "CERTIFIED", humanGate: { ...report.humanGate, approved: true, approvedBy: String(approvedBy).trim(), approvedAt: now.toISOString() }, nextAction: "Certificate accepted; production activation remains a separate explicit operation." };
  const persisted = writePrivateJson(reportPath, accepted);
  return { ...accepted, reportPath: persisted.filePath, checksum: persisted.checksum };
}
