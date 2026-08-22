import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRun } from "./run-manager.mjs";
import { buildRunEvidence } from "./interaction.mjs";
import { verifyAuditChain } from "./audit-chain.mjs";
import { operationsReadiness } from "./operations-governance.mjs";
import { hardenRuntimePermissions } from "./runtime-hardening.mjs";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function certificationDirectory(runsRoot) { return path.join(runsRoot, "runtime", "certifications"); }
function bundlePath(runsRoot, certificationId) { return path.join(certificationDirectory(runsRoot), `${certificationId}.json`); }

function writePrivateBundle(filePath, bundle) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.writeFileSync(`${filePath}.sha256`, `${sha256(text)}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, sha256: sha256(text) };
}

function allPass(results) {
  return Array.isArray(results) && results.length > 0 && results.every((result) => result?.status === "PASS");
}

export function summarizeCertifiedPilot({ runsRoot, runId }) {
  const run = getRun(runsRoot, runId);
  const evidence = buildRunEvidence(run, { runsRoot });
  const valid = run.state === "DONE"
    && evidence.scope?.status === "PASS"
    && evidence.verification?.status === "PASS"
    && evidence.finalization?.status === "APPLIED"
    && evidence.finalization?.humanApproved === true
    && evidence.finalization?.postApplyVerification?.status === "PASS"
    && evidence.integrity?.status === "OK";
  return {
    runId,
    projectId: run.project?.id ?? null,
    taskId: run.task?.id ?? null,
    state: run.state,
    valid,
    scope: evidence.scope,
    verification: evidence.verification,
    finalization: evidence.finalization,
    integrity: evidence.integrity,
  };
}

function residualRiskStatus(risks) {
  return risks.map((risk) => ({
    ...risk,
    valid: risk.severity !== "MEDIUM" || (Boolean(risk.owner) && Boolean(risk.reviewBy) && Boolean(risk.acceptedBy) && Boolean(risk.acceptedAt)),
  }));
}

export function createProductionCertification({
  runsRoot,
  pilotRunIds,
  verification = {},
  drills = {},
  residualRisks = [],
  now = new Date(),
} = {}) {
  if (!runsRoot || !Array.isArray(pilotRunIds) || pilotRunIds.length < 2) {
    throw new Error("Sertifikasi produksi membutuhkan sedikitnya dua run pilot.");
  }
  const pilots = pilotRunIds.map((runId) => summarizeCertifiedPilot({ runsRoot, runId }));
  const distinctProjects = new Set(pilots.map((pilot) => pilot.projectId).filter(Boolean));
  const readiness = operationsReadiness({ runsRoot, now });
  const audit = verifyAuditChain(runsRoot);
  const permissions = hardenRuntimePermissions(runsRoot, { apply: false });
  const risks = residualRiskStatus(residualRisks);
  const blockingRisk = risks.some((risk) => ["CRITICAL", "HIGH"].includes(risk.severity) || !risk.valid);
  const blockers = [
    ...(pilots.some((pilot) => !pilot.valid) ? ["PILOT_EVIDENCE_INVALID"] : []),
    ...(distinctProjects.size < 2 ? ["PILOT_PROJECT_DIVERSITY_INSUFFICIENT"] : []),
    ...(!audit.valid ? ["AUDIT_CHAIN_INVALID"] : []),
    ...(!readiness.admission.allowed ? ["OPERATIONS_ADMISSION_BLOCKED"] : []),
    ...(verification.backend !== "PASS" ? ["BACKEND_REGRESSION_FAILED"] : []),
    ...(verification.dashboard !== "PASS" ? ["DASHBOARD_REGRESSION_FAILED"] : []),
    ...(drills.backupRestore !== "PASS" ? ["BACKUP_RESTORE_DRILL_FAILED"] : []),
    ...(drills.crashRecovery !== "PASS" ? ["CRASH_RECOVERY_DRILL_FAILED"] : []),
    ...(blockingRisk ? ["RISK_ACCEPTANCE_INCOMPLETE"] : []),
  ];
  const certificationId = `phase4-cert-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const bundle = {
    schemaVersion: 1,
    kind: "personal-ai-os-production-readiness-certification",
    certificationId,
    createdAt: now.toISOString(),
    status: blockers.length ? "CONDITIONAL" : "CERTIFIED",
    blockers,
    scope: { deployment: "local-first single-user macOS", pilotRunIds, distinctProjectCount: distinctProjects.size },
    pilots,
    operations: readiness,
    audit,
    runtimePermissions: permissions,
    verification,
    drills,
    residualRisks: risks,
  };
  const persisted = writePrivateBundle(bundlePath(runsRoot, certificationId), bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.sha256 };
}

export function verifyProductionCertification({ bundleFilePath } = {}) {
  if (!bundleFilePath || !fs.existsSync(bundleFilePath)) throw new Error("Bundle sertifikasi tidak ditemukan.");
  const text = fs.readFileSync(bundleFilePath, "utf8");
  const recorded = fs.readFileSync(`${bundleFilePath}.sha256`, "utf8").trim().split(/\s+/)[0];
  let bundle = null;
  try { bundle = JSON.parse(text); } catch { return { valid: false, certificationId: null, status: null, checksum: sha256(text), bundle: null }; }
  const valid = recorded === sha256(text) && bundle?.kind === "personal-ai-os-production-readiness-certification";
  return { valid, certificationId: bundle?.certificationId ?? null, status: bundle?.status ?? null, checksum: sha256(text), bundle };
}
