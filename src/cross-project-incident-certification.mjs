import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { listProjects } from "./core.mjs";
import { getObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration } from "./orchestration-store.mjs";
import { getIntegrationEvidence } from "./integration-manager.mjs";
import { validateCrossProjectDiagnostic } from "./cross-project-diagnostics.mjs";

export const CROSS_PROJECT_INCIDENT_CERTIFICATION_SCHEMA_VERSION = 1;
export const CROSS_PROJECT_INCIDENT_CERTIFICATION_KIND = "personal-ai-os-v2-cross-project-incident-certification";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function certificationDirectory(runsRoot) {
  return path.join(runsRoot, "runtime", "certifications");
}

function check(id, passed, message, evidence = {}) {
  return { id, status: passed ? "PASS" : "FAIL", message, evidence };
}

function writeBundle(filePath, bundle) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256(text);
  fs.writeFileSync(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, checksum };
}

function repositoryStatus(repository) {
  try {
    const output = execFileSync("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { repository, status: output ? "DIRTY" : "CLEAN", output };
  } catch (error) {
    return { repository, status: "UNKNOWN", output: String(error.stderr ?? error.message ?? "git status failed").trim() };
  }
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizedDiagnosis({ diagnosis, objective }) {
  const errors = validateCrossProjectDiagnostic(diagnosis, objective);
  const outcome = String(diagnosis?.outcome ?? "").toUpperCase();
  const requiredProjectIds = unique(diagnosis?.implicatedProjects);
  return {
    valid: errors.length === 0 && outcome !== "UNDETERMINED",
    errors,
    outcome,
    requiredProjectIds,
  };
}

function integrationResults(integration) {
  return Array.isArray(integration?.crossProjectVerification?.results)
    ? integration.crossProjectVerification.results
    : (integration?.verification?.results ?? []).filter((result) => result?.scope === "CROSS_PROJECT");
}

function repositoryAcceptancePass(integration, projectIds) {
  const records = Array.isArray(integration?.repositoryAcceptance) ? integration.repositoryAcceptance : [];
  return projectIds.length > 0
    && projectIds.every((projectId) => records.some((record) => record.projectId === projectId && record.acceptance?.status === "PASS"));
}

export function createCrossProjectIncidentCertification({ runsRoot, vaultRoot, objectiveId, orchestrationId = null, diagnosis = null, now = new Date() } = {}) {
  if (!runsRoot || !vaultRoot || !objectiveId) throw new Error("Cross-project incident certification membutuhkan runsRoot, vaultRoot, dan objectiveId.");
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) throw new Error(`Objective tidak ditemukan: ${objectiveId}`);
  if (String(objective.mode).toUpperCase() !== "CROSS_PROJECT_INCIDENT") throw new Error("Certification hanya tersedia untuk CROSS_PROJECT_INCIDENT.");
  const selectedOrchestrationId = orchestrationId ?? objective.activeOrchestrationId;
  const orchestration = selectedOrchestrationId ? getOrchestration(runsRoot, selectedOrchestrationId) : null;
  if (!orchestration) throw new Error(`Orchestration tidak ditemukan untuk objective: ${objectiveId}`);
  const plan = getPlan(runsRoot, orchestration.planId, { knownProjectIds: objective.projectIds, projectIds: objective.projectIds, budget: objective.budget });
  if (!plan) throw new Error(`Plan tidak ditemukan: ${orchestration.planId}`);

  const selectedDiagnosis = diagnosis ?? plan.diagnostic ?? objective.diagnostic ?? null;
  const diagnosisCheckData = normalizedDiagnosis({ diagnosis: selectedDiagnosis, objective });
  const integration = getIntegrationEvidence({ runsRoot, orchestrationId: orchestration.orchestrationId });
  const sourceRuns = Array.isArray(integration?.sourceRuns) ? integration.sourceRuns : [];
  const changedProjectIds = unique(sourceRuns.filter((run) => (run.changedPaths ?? []).length > 0).map((run) => run.projectId));
  const implementationProjectIds = unique(plan.nodes.filter((node) => node.type === "IMPLEMENTATION").map((node) => node.projectId));
  const requiredProjectIds = diagnosisCheckData.requiredProjectIds;
  const crossResults = integrationResults(integration);
  const e2eResults = crossResults.filter((result) => /e2e|browser|playwright|cypress|visual/i.test(`${result?.script ?? ""} ${result?.command ?? ""}`));
  const projectRecords = listProjects(vaultRoot).projects.filter((project) => objective.projectIds.includes(project.id));
  const repositories = projectRecords.map((project) => ({ projectId: project.id, ...repositoryStatus(project.repository) }));
  const allNodesDone = plan.nodes.length > 0 && plan.nodes.every((node) => orchestration.nodes?.[node.nodeId]?.state === "DONE");
  const allCrossChecksPass = crossResults.length > 0 && crossResults.every((result) => result.status === "PASS");
  const implementationBoundaryPass = requiredProjectIds.length > 0
    && implementationProjectIds.every((projectId) => requiredProjectIds.includes(projectId))
    && changedProjectIds.length > 0
    && changedProjectIds.every((projectId) => requiredProjectIds.includes(projectId));

  const checks = [
    check("CROSS_PROJECT_OBJECTIVE", String(objective.mode).toUpperCase() === "CROSS_PROJECT_INCIDENT", "Pilot menggunakan mode CROSS_PROJECT_INCIDENT.", { objectiveId: objective.objectiveId, projectIds: objective.projectIds, request: objective.request }),
    check("ROOT_CAUSE_DIAGNOSED", diagnosisCheckData.valid, diagnosisCheckData.valid ? "Root cause memiliki diagnosis deterministik dan evidence reproduktif." : "Root cause belum memiliki diagnosis deterministik yang tervalidasi.", { outcome: diagnosisCheckData.outcome, implicatedProjects: requiredProjectIds, errors: diagnosisCheckData.errors, evidence: selectedDiagnosis?.evidence ?? [] }),
    check("IMPLEMENTATION_BOUNDARY", implementationBoundaryPass, implementationBoundaryPass ? "Implementation dan perubahan hanya berada pada repository yang implicated." : "Ditemukan implementation atau perubahan di luar repository yang implicated.", { requiredProjectIds, implementationProjectIds, changedProjectIds }),
    check("PER_REPOSITORY_ACCEPTANCE", repositoryAcceptancePass(integration, objective.projectIds), "Setiap repository objective memiliki acceptance per-repository PASS.", { acceptance: integration?.repositoryAcceptance ?? [] }),
    check("CROSS_PROJECT_E2E", integration?.crossProjectVerification?.status === "PASS" && allCrossChecksPass && e2eResults.length > 0 && e2eResults.every((result) => result.status === "PASS"), "Cross-project E2E verification PASS dengan command approved.", { status: integration?.crossProjectVerification?.status ?? "MISSING", results: crossResults }),
    check("ORCHESTRATION_COMPLETE", orchestration.state === "DONE" && allNodesDone && integration?.status === "PASSED", "Orchestration dan integration evidence selesai secara durable.", { orchestrationState: orchestration.state, allNodesDone, integrationStatus: integration?.status ?? "MISSING" }),
    check("REQUIRED_REPOSITORIES_CLEAN", requiredProjectIds.length > 0 && repositories.filter((repository) => requiredProjectIds.includes(repository.projectId)).every((repository) => repository.status === "CLEAN"), "Repository yang diperlukan bersih setelah pilot.", { repositories }),
  ];
  const blockers = checks.filter((item) => item.status !== "PASS").map((item) => item.id);
  const certificationId = `v2-065-${objective.objectiveId}-${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const bundle = {
    schemaVersion: CROSS_PROJECT_INCIDENT_CERTIFICATION_SCHEMA_VERSION,
    kind: CROSS_PROJECT_INCIDENT_CERTIFICATION_KIND,
    certificationId,
    createdAt: now.toISOString(),
    status: blockers.length ? "BLOCKED" : "HUMAN_GATE_REQUIRED",
    humanGate: { required: true, confirmed: false, approvedBy: null, approvedAt: null },
    blockers,
    objective: { objectiveId: objective.objectiveId, request: objective.request, state: objective.state, mode: objective.mode, projectIds: objective.projectIds },
    plan: { planId: plan.planId, planFingerprint: plan.planFingerprint, approvedBy: plan.approvedBy, approvedAt: plan.approvedAt },
    orchestration: { orchestrationId: orchestration.orchestrationId, state: orchestration.state },
    diagnosis: selectedDiagnosis,
    scope: { requiredProjectIds, implementationProjectIds, changedProjectIds },
    evidence: { integration, repositories, sourceRuns, crossProjectVerification: { results: crossResults, e2eResults } },
    checks,
    nextAction: blockers.length ? "Resolve certification blockers and rerun V2-065." : "Human must review the pilot bundle and explicitly accept V2-065.",
  };
  const persisted = writeBundle(path.join(certificationDirectory(runsRoot), `${certificationId}.json`), bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.checksum };
}

export function verifyCrossProjectIncidentCertification({ bundleFilePath } = {}) {
  if (!bundleFilePath || !fs.existsSync(bundleFilePath)) throw new Error("Cross-project incident certification bundle tidak ditemukan.");
  const text = fs.readFileSync(bundleFilePath, "utf8");
  let recorded = null;
  try { recorded = fs.readFileSync(`${bundleFilePath}.sha256`, "utf8").trim().split(/\s+/)[0]; } catch {}
  let bundle = null;
  try { bundle = JSON.parse(text); } catch {}
  const valid = Boolean(
    bundle
      && recorded === sha256(text)
      && bundle.schemaVersion === CROSS_PROJECT_INCIDENT_CERTIFICATION_SCHEMA_VERSION
      && bundle.kind === CROSS_PROJECT_INCIDENT_CERTIFICATION_KIND
      && ["BLOCKED", "HUMAN_GATE_REQUIRED"].includes(bundle.status)
      && bundle.humanGate?.required === true
      && Array.isArray(bundle.checks),
  );
  return { valid, certificationId: bundle?.certificationId ?? null, status: bundle?.status ?? null, checksum: sha256(text), bundle };
}
