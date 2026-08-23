import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getObjective } from "./objective-store.mjs";
import { getPlan, listPlans } from "./plan-store.mjs";
import { getOrchestration } from "./orchestration-store.mjs";
import { listDecisions } from "./decision-store.mjs";
import { listJobs } from "./job-queue.mjs";
import { getRun, listRuns, RUN_STATES } from "./run-manager.mjs";
import { buildRunEvidence } from "./interaction.mjs";
import { getIntegrationEvidence } from "./integration-manager.mjs";

export const SEQUENTIAL_INTEGRATION_CERTIFICATION_SCHEMA_VERSION = 1;
export const SEQUENTIAL_INTEGRATION_CERTIFICATION_KIND = "personal-ai-os-v2-sequential-integration-certification";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function result(id, passed, message, evidence = {}) {
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

function certificationDirectory(runsRoot) {
  return path.join(runsRoot, "runtime", "certifications");
}

function latestRunEvidence({ runsRoot, orchestration, nodeId }) {
  const runtime = orchestration?.nodes?.[nodeId] ?? null;
  const job = listJobs(runsRoot)
    .filter((candidate) => candidate.orchestrationId === orchestration?.orchestrationId && candidate.nodeId === nodeId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
  const runId = runtime?.runId ?? job?.runId ?? null;
  const run = runId ? getRun(runsRoot, runId) : null;
  return { runtime, job, run, evidence: run ? buildRunEvidence(run, { runsRoot }) : null };
}

export function createSequentialIntegrationCertification({ runsRoot, objectiveId, initialOrchestrationId = null, now = new Date() } = {}) {
  if (!runsRoot || !objectiveId) throw new Error("Sequential integration certification membutuhkan runsRoot dan objectiveId.");
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) throw new Error(`Objective tidak ditemukan: ${objectiveId}`);
  const decisions = listDecisions(runsRoot).filter((decision) => decision.objectiveId === objectiveId);
  const initialFailure = decisions.find((decision) => decision.type === "INTEGRATION_CONFLICT") ?? null;
  const initialId = initialOrchestrationId ?? initialFailure?.evidence?.orchestrationId ?? null;
  const initialOrchestration = initialId ? getOrchestration(runsRoot, initialId) : null;
  const repairPlan = listPlans(runsRoot).filter((plan) => plan.objectiveId === objectiveId && plan.repair?.parentPlanId).sort((left, right) => right.revision - left.revision)[0] ?? null;
  const initialPlan = repairPlan?.repair?.parentPlanId ? getPlan(runsRoot, repairPlan.repair.parentPlanId) : initialOrchestration ? getPlan(runsRoot, initialOrchestration.planId) : null;
  const finalOrchestration = objective.activeOrchestrationId ? getOrchestration(runsRoot, objective.activeOrchestrationId) : null;
  const finalPlan = finalOrchestration ? getPlan(runsRoot, finalOrchestration.planId) : null;
  const finalIntegration = finalOrchestration ? getIntegrationEvidence({ runsRoot, orchestrationId: finalOrchestration.orchestrationId }) : null;
  const repairNodeId = repairPlan?.repair?.nodeId ?? null;
  const repairEvidence = repairNodeId && finalOrchestration ? latestRunEvidence({ runsRoot, orchestration: finalOrchestration, nodeId: repairNodeId }) : { runtime: null, job: null, run: null, evidence: null };
  const acceptance = decisions.find((decision) => decision.type === "OBJECTIVE_ACCEPTANCE" && decision.state === "RESOLVED" && decision.resolution?.action === "ACCEPT") ?? null;

  const checks = [
    result("INITIAL_INTEGRATION_FAILURE", Boolean(initialFailure && (initialOrchestration?.integration?.state === "BLOCKED" || initialFailure.evidence?.verification?.some((item) => item?.status === "FAIL") || initialFailure.evidence?.sourceErrors?.length)), "Initial integration failure is preserved as a blocker decision and aggregate evidence.", { decisionId: initialFailure?.decisionId ?? null, orchestrationId: initialId, sourceErrors: initialFailure?.evidence?.sourceErrors ?? [], verification: initialFailure?.evidence?.verification ?? [] }),
    result("APPROVED_REPAIR_REVISION", Boolean(repairPlan && repairPlan.state === "APPROVED" && repairPlan.repair?.parentPlanId === initialPlan?.planId && repairPlan.repair?.sourceRunIds?.length), "Repair revision is approved and linked to the failed parent plan and source runs.", { initialPlanId: initialPlan?.planId ?? null, repairPlanId: repairPlan?.planId ?? null, repair: repairPlan?.repair ?? null }),
    result("REPAIR_RUN_EVIDENCE", Boolean(repairEvidence.runtime?.state === "DONE" && repairEvidence.job?.state === "DONE" && repairEvidence.run?.state === RUN_STATES.DONE && repairEvidence.evidence?.verification?.status === "PASS" && repairEvidence.evidence?.finalization?.status === "APPLIED"), "The approved repair node has a completed run with passing verification and applied evidence.", { nodeId: repairNodeId, runId: repairEvidence.run?.runId ?? null, runtime: repairEvidence.runtime, verification: repairEvidence.evidence?.verification ?? null }),
    result("FINAL_INTEGRATION_VERIFICATION", Boolean(finalOrchestration?.state === "DONE" && finalIntegration?.status === "PASSED" && finalIntegration?.verification?.status === "PASS"), "Final sequential integration is complete and its aggregate verification passes.", { orchestrationId: finalOrchestration?.orchestrationId ?? null, evidencePath: finalIntegration?.artifactPath ?? null, sourceRunIds: finalIntegration?.sourceRunIds ?? [], commitHashes: finalIntegration?.commitHashes ?? [], verification: finalIntegration?.verification ?? null }),
    result("HUMAN_OBJECTIVE_ACCEPTANCE", Boolean(acceptance), "Final objective acceptance is recorded as a resolved human decision.", { decisionId: acceptance?.decisionId ?? null, acceptedBy: acceptance?.resolution?.resolvedBy ?? null, acceptedAt: acceptance?.resolution?.resolvedAt ?? null }),
  ];
  const blockers = checks.filter((check) => check.status !== "PASS").map((check) => check.id);
  const certificationId = `v2-043-sequential-integration-${objectiveId}-${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const bundle = {
    schemaVersion: SEQUENTIAL_INTEGRATION_CERTIFICATION_SCHEMA_VERSION,
    kind: SEQUENTIAL_INTEGRATION_CERTIFICATION_KIND,
    certificationId,
    createdAt: now.toISOString(),
    status: blockers.length ? "CONDITIONAL" : "CERTIFICATION_READY",
    humanGate: { required: true, confirmed: Boolean(acceptance), approvedBy: acceptance?.resolution?.resolvedBy ?? null, approvedAt: acceptance?.resolution?.resolvedAt ?? null },
    blockers,
    objective: { objectiveId, state: objective.state, projectIds: objective.projectIds },
    initial: { orchestrationId: initialOrchestration?.orchestrationId ?? initialId, planId: initialPlan?.planId ?? null, failureDecisionId: initialFailure?.decisionId ?? null },
    revision: { planId: repairPlan?.planId ?? null, parentPlanId: repairPlan?.repair?.parentPlanId ?? null, repairNodeId, sourceRunIds: repairPlan?.repair?.sourceRunIds ?? [], commitHashes: repairPlan?.repair?.commitHashes ?? [] },
    final: { orchestrationId: finalOrchestration?.orchestrationId ?? null, planId: finalPlan?.planId ?? null, integrationEvidence: finalIntegration, acceptanceDecisionId: acceptance?.decisionId ?? null },
    checks,
    evidence: { initialFailure: initialFailure?.evidence ?? null, repairRun: repairEvidence, finalIntegration, acceptance },
    nextAction: blockers.length ? "Resolve certification blockers and rerun V2-043." : "Sequential integration pilot is ready for certification review.",
  };
  const persisted = writeBundle(path.join(certificationDirectory(runsRoot), `${certificationId}.json`), bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.checksum };
}

export function verifySequentialIntegrationCertification({ bundleFilePath } = {}) {
  if (!bundleFilePath || !fs.existsSync(bundleFilePath)) throw new Error("Sequential integration certification bundle tidak ditemukan.");
  const text = fs.readFileSync(bundleFilePath, "utf8");
  const recorded = fs.existsSync(`${bundleFilePath}.sha256`) ? fs.readFileSync(`${bundleFilePath}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
  let bundle = null;
  try { bundle = JSON.parse(text); } catch {}
  const valid = Boolean(bundle
    && recorded === sha256(text)
    && bundle.schemaVersion === SEQUENTIAL_INTEGRATION_CERTIFICATION_SCHEMA_VERSION
    && bundle.kind === SEQUENTIAL_INTEGRATION_CERTIFICATION_KIND
    && bundle.humanGate?.required === true
    && bundle.checks?.every((check) => check.status === "PASS"));
  return { valid, certificationId: bundle?.certificationId ?? null, status: bundle?.status ?? null, checksum: sha256(text), bundle };
}
