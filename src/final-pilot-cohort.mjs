import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildRunEvidence } from "./interaction.mjs";
import { listRuns, RUN_STATES } from "./run-manager.mjs";

export const PILOT_COHORT_SCHEMA_VERSION = 2;
export const PILOT_COHORT_CONTRACT_VERSION = "p9.2-real-runs-2026-08-22";
export const PILOT_COHORT_KIND = "personal-ai-os-final-pilot-cohort";
export const PILOT_COHORT_MIN_TASKS = 10;
export const PILOT_COHORT_MIN_PROJECTS = 3;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
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

function historyEvents(run) { return new Set((run.history ?? []).map((item) => item.event)); }
function realAcceptedRun(run) {
  const evidence = buildRunEvidence(run);
  return run.state === RUN_STATES.DONE
    && run.completion?.humanApproved === true
    && evidence.scope.status === "PASS"
    && evidence.verification.status === "PASS"
    && evidence.finalization.status === "APPLIED"
    && evidence.integrity.status === "OK";
}

function selectBalancedRuns(runs) {
  const eligible = runs.filter(realAcceptedRun).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
  const byProject = new Map();
  for (const run of eligible) {
    const projectId = run.project?.id;
    if (!projectId) continue;
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId).push(run);
  }
  const projects = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length);
  if (projects.length < PILOT_COHORT_MIN_PROJECTS) return [];
  const selected = [];
  for (const [, candidates] of projects.slice(0, PILOT_COHORT_MIN_PROJECTS)) selected.push(candidates.shift());
  const remaining = projects.flatMap(([, candidates]) => candidates).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
  while (selected.length < PILOT_COHORT_MIN_TASKS && remaining.length) selected.push(remaining.shift());
  return selected;
}

function taskProjection(run) {
  const evidence = buildRunEvidence(run);
  const events = historyEvents(run);
  return {
    runId: run.runId,
    taskId: run.task?.id ?? null,
    projectId: run.project?.id ?? null,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
    source: "persisted-real-run",
    status: realAcceptedRun(run) ? "PASS" : "FAIL",
    scenarios: { requestChanges: events.has("REVIEW_CHANGES_REQUESTED"), recovery: [...events].some((event) => /RECOVERY|RECONCIL/i.test(event)), knowledgeApproval: events.has("KNOWLEDGE_APPROVED") },
    evidence: { scope: evidence.scope.status, verification: evidence.verification.status, finalization: evidence.finalization.status, integrity: evidence.integrity.status, humanApproved: evidence.finalization.humanApproved, changedPaths: evidence.scope.changedPaths },
  };
}

function exceptionalScenarioCoverage(runs) {
  const requestChanges = runs.find((run) => historyEvents(run).has("REVIEW_CHANGES_REQUESTED"));
  const recovery = runs.find((run) => [...historyEvents(run)].some((event) => /RECOVERY|RECONCIL/i.test(event)));
  const rejection = runs.find((run) => run.state === RUN_STATES.FAILED && !run.execution?.workspace?.appliedAt);
  return {
    requestChanges: requestChanges ? { covered: true, runId: requestChanges.runId } : { covered: false, runId: null },
    recovery: recovery ? { covered: true, runId: recovery.runId } : { covered: false, runId: null },
    rejection: rejection ? { covered: true, runId: rejection.runId, mutationApplied: false } : { covered: false, runId: null, mutationApplied: null },
  };
}

export function runFinalPilotCohort({ reportRoot, sourceRunsRoot = reportRoot, now = new Date() } = {}) {
  if (!sourceRunsRoot || !path.isAbsolute(sourceRunsRoot)) throw new Error("Final pilot membutuhkan sourceRunsRoot absolut berisi run nyata.");
  const allRuns = listRuns(sourceRunsRoot);
  const selectedRuns = selectBalancedRuns(allRuns);
  const tasks = selectedRuns.map(taskProjection);
  const projectIds = [...new Set(tasks.map((item) => item.projectId))];
  const scenarios = exceptionalScenarioCoverage(allRuns);
  const checks = {
    realPersistedRunsOnly: tasks.length > 0 && tasks.every((item) => item.source === "persisted-real-run"),
    minimumTaskCount: tasks.length >= PILOT_COHORT_MIN_TASKS,
    minimumProjectCount: projectIds.length >= PILOT_COHORT_MIN_PROJECTS,
    acceptedPathsAuthorized: tasks.length > 0 && tasks.every((item) => item.evidence.scope === "PASS"),
    verificationPassed: tasks.length > 0 && tasks.every((item) => item.evidence.verification === "PASS"),
    humanApprovedAndApplied: tasks.length > 0 && tasks.every((item) => item.evidence.humanApproved && item.evidence.finalization === "APPLIED"),
    completeEvidence: tasks.length > 0 && tasks.every((item) => item.status === "PASS"),
    exceptionalScenariosCovered: Object.values(scenarios).every((item) => item.covered),
  };
  const report = {
    schemaVersion: PILOT_COHORT_SCHEMA_VERSION, kind: PILOT_COHORT_KIND, contractVersion: PILOT_COHORT_CONTRACT_VERSION,
    createdAt: now.toISOString(), status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    humanGate: { required: true, confirmed: false, instruction: "Review real-run cohort evidence before final certification." },
    source: { runsRoot: path.resolve(sourceRunsRoot), discoveredRunCount: allRuns.length, selectionPolicy: "balanced-latest-human-approved-real-runs" },
    scope: { taskCount: tasks.length, projectCount: projectIds.length, projectIds }, checks, scenarios, tasks,
  };
  if (!reportRoot) return report;
  const bundleRoot = path.join(reportRoot, "runtime", "pilot-cohort", "evidence", report.createdAt.replace(/[-:.]/g, ""));
  const artifacts = [];
  for (const run of selectedRuns) {
    const artifactPath = path.join(bundleRoot, `${run.runId}.json`);
    const persisted = writePrivateJson(artifactPath, run);
    artifacts.push({ runId: run.runId, relativePath: path.relative(reportRoot, artifactPath), checksum: persisted.checksum });
  }
  report.evidenceBundle = { root: path.relative(reportRoot, bundleRoot), artifacts };
  const reportPath = path.join(reportRoot, "runtime", "pilot-cohort", "p9.2-report.json");
  const persisted = writePrivateJson(reportPath, report);
  return { ...report, reportPath, checksum: persisted.checksum };
}

export function verifyFinalPilotCohortReport({ reportPath } = {}) {
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error(`Pilot cohort report tidak ditemukan: ${reportPath}`);
  const text = fs.readFileSync(reportPath, "utf8");
  let report = null;
  try { report = JSON.parse(text); } catch { return { valid: false, status: null, checksum: sha256(text), report: null }; }
  const sidecar = fs.existsSync(`${reportPath}.sha256`) ? fs.readFileSync(`${reportPath}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
  const reportRoot = path.resolve(path.dirname(reportPath), "../..");
  const artifactsValid = Array.isArray(report?.evidenceBundle?.artifacts) && report.evidenceBundle.artifacts.length >= PILOT_COHORT_MIN_TASKS && report.evidenceBundle.artifacts.every((artifact) => {
    const artifactPath = path.join(reportRoot, artifact.relativePath);
    if (!fs.existsSync(artifactPath) || !fs.existsSync(`${artifactPath}.sha256`)) return false;
    const artifactText = fs.readFileSync(artifactPath, "utf8");
    return sha256(artifactText) === artifact.checksum && fs.readFileSync(`${artifactPath}.sha256`, "utf8").trim().split(/\s+/)[0] === artifact.checksum;
  });
  const valid = report?.kind === PILOT_COHORT_KIND && report?.schemaVersion === PILOT_COHORT_SCHEMA_VERSION && report?.status === "PASS" && report?.checks?.realPersistedRunsOnly === true && sidecar === sha256(text) && artifactsValid;
  return { valid, status: report?.status ?? null, checksum: sha256(text), artifactsValid, report };
}
