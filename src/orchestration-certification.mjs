import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { listProjects, readMarkdown } from "./core.mjs";
import { getDecision, listDecisions } from "./decision-store.mjs";
import { getObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration } from "./orchestration-store.mjs";
import { listJobs } from "./job-queue.mjs";
import { listRuns, RUN_STATES } from "./run-manager.mjs";
import { buildRunEvidence } from "./interaction.mjs";
import { planFingerprint } from "./plan-lifecycle.mjs";
import { pathMatchesAllowed } from "./security.mjs";

export const SEQUENTIAL_ORCHESTRATION_CERTIFICATION_SCHEMA_VERSION = 1;
export const SEQUENTIAL_ORCHESTRATION_CERTIFICATION_KIND = "personal-ai-os-v2-sequential-orchestration-certification";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function certificationDirectory(runsRoot) {
  return path.join(runsRoot, "runtime", "certifications");
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

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathWithinAllowed(candidate, allowedPaths) {
  return allowedPaths.some((allowed) => pathMatchesAllowed(candidate, allowed));
}

function repositoryStatus(repository) {
  try {
    const output = execFileSync("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: output.trim() ? "DIRTY" : "CLEAN", output: output.trim() };
  } catch (error) {
    return { status: "UNKNOWN", output: String(error.stderr ?? error.message ?? "git status failed").trim() };
  }
}

function planOptions(objective) {
  return { knownProjectIds: objective.projectIds, projectIds: objective.projectIds, budget: objective.budget };
}

function approvalDecision(runsRoot, plan) {
  const exact = getDecision(runsRoot, `decision-plan-approval-${plan.planId}`);
  return exact ?? listDecisions(runsRoot).find((decision) => (
    decision.type === "PLAN_APPROVAL"
    && decision.objectiveId === plan.objectiveId
    && decision.state === "RESOLVED"
    && decision.evidence?.planId === plan.planId
  )) ?? null;
}

function currentJobForNode(jobs, orchestrationId, nodeId, attempt) {
  return jobs
    .filter((job) => job.orchestrationId === orchestrationId && job.nodeId === nodeId)
    .filter((job) => Number(job.attempt ?? 1) === Number(attempt ?? 1))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
}

function canonicalTaskMapping({ vaultRoot, objective, plan, orchestration }) {
  const expectedNodes = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const mappings = orchestration.materialization?.tasks ?? [];
  const errors = [];
  const seenNodes = new Set();
  const details = [];
  for (const mapping of mappings) {
    const node = expectedNodes.get(mapping.nodeId);
    const taskPath = mapping.path ? path.resolve(vaultRoot, mapping.path) : null;
    const document = taskPath && inside(vaultRoot, taskPath) && fs.existsSync(taskPath) ? readMarkdown(taskPath, vaultRoot) : null;
    if (!node) errors.push(`unknown node ${mapping.nodeId}`);
    if (seenNodes.has(mapping.nodeId)) errors.push(`duplicate mapping for node ${mapping.nodeId}`);
    seenNodes.add(mapping.nodeId);
    if (!mapping.projectId || mapping.projectId !== node?.projectId) errors.push(`project mismatch for ${mapping.nodeId}`);
    if (!mapping.taskId || !document) errors.push(`task document missing for ${mapping.nodeId}`);
    if (document) {
      const metadata = document.metadata ?? {};
      const checks = {
        taskId: metadata.task_id === mapping.taskId,
        project: metadata.project === mapping.projectId,
        objectiveId: metadata.objective_id === objective.objectiveId,
        planId: metadata.plan_id === plan.planId,
        orchestrationId: metadata.orchestration_id === orchestration.orchestrationId,
        nodeId: metadata.node_id === mapping.nodeId,
        managed: metadata.orchestration_managed === true,
      };
      for (const [field, passed] of Object.entries(checks)) if (!passed) errors.push(`${mapping.nodeId} task metadata ${field} mismatch`);
      details.push({ nodeId: mapping.nodeId, taskId: mapping.taskId, path: mapping.path, checks });
    }
  }
  for (const nodeId of expectedNodes.keys()) if (!seenNodes.has(nodeId)) errors.push(`missing mapping for node ${nodeId}`);
  return { passed: errors.length === 0, errors, details, mappingCount: mappings.length };
}

function duplicateEvidence({ jobs, orchestration }) {
  const jobsForOrchestration = jobs.filter((job) => job.orchestrationId === orchestration.orchestrationId);
  const keys = new Map();
  const duplicateJobAttempts = [];
  for (const job of jobsForOrchestration) {
    const key = `${job.nodeId}:a${Number(job.attempt ?? 1)}`;
    if (keys.has(key)) duplicateJobAttempts.push({ key, jobIds: [keys.get(key), job.jobId] });
    else keys.set(key, job.jobId);
  }
  const activeByTask = new Map();
  for (const job of jobsForOrchestration) {
    if (!["QUEUED", "RUNNING", "REVIEW"].includes(job.state)) continue;
    const entries = activeByTask.get(job.taskId) ?? [];
    entries.push(job.jobId);
    activeByTask.set(job.taskId, entries);
  }
  const activeDuplicates = [...activeByTask.entries()].filter(([, jobIds]) => jobIds.length > 1).map(([taskId, jobIds]) => ({ taskId, jobIds }));
  const runIds = jobsForOrchestration.map((job) => job.runId).filter(Boolean);
  const duplicateRunIds = [...new Set(runIds.filter((runId, index) => runIds.indexOf(runId) !== index))];
  return {
    passed: duplicateJobAttempts.length === 0 && activeDuplicates.length === 0 && duplicateRunIds.length === 0,
    jobCount: jobsForOrchestration.length,
    duplicateJobAttempts,
    activeDuplicates,
    duplicateRunIds,
  };
}

function restartCheck(orchestration, evidence) {
  const candidate = evidence ?? orchestration.restartRecovery ?? orchestration.recovery?.restart ?? null;
  const passed = Boolean(candidate && (candidate.status === "PASS" || candidate.verified === true) && candidate.safe !== false && ["QUEUED", "BLOCKED", "QUEUED_OR_BLOCKED"].includes(String(candidate.phase ?? "QUEUED_OR_BLOCKED").toUpperCase()));
  return result("RESTART_RECOVERY", passed, passed ? "Restart recovery evidence confirms safe reconstruction during queued/blocked transition." : "Restart recovery evidence is missing or does not prove a safe queued/blocked reconstruction.", candidate ?? { required: true });
}

export function createSequentialOrchestrationCertification({
  runsRoot,
  vaultRoot,
  objectiveId,
  orchestrationId = null,
  restartEvidence = null,
  now = new Date(),
} = {}) {
  if (!runsRoot || !vaultRoot || !objectiveId) throw new Error("Sequential orchestration certification membutuhkan runsRoot, vaultRoot, dan objectiveId.");
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) throw new Error(`Objective tidak ditemukan: ${objectiveId}`);
  const selectedOrchestrationId = orchestrationId ?? objective.activeOrchestrationId;
  const orchestration = selectedOrchestrationId ? getOrchestration(runsRoot, selectedOrchestrationId) : null;
  if (!orchestration) throw new Error(`Orchestration tidak ditemukan untuk objective: ${objectiveId}`);
  const plan = getPlan(runsRoot, orchestration.planId, planOptions(objective));
  if (!plan) throw new Error(`Plan tidak ditemukan: ${orchestration.planId}`);
  const jobs = listJobs(runsRoot);
  const runs = listRuns(runsRoot);
  const approval = approvalDecision(runsRoot, plan);
  const mapping = canonicalTaskMapping({ vaultRoot, objective, plan, orchestration });
  const duplicates = duplicateEvidence({ jobs, orchestration });
  const nodeEvidence = [];
  const nodeErrors = [];
  const executionErrors = [];
  const nodeCompletionTimes = new Map();
  for (const node of plan.nodes) {
    const runtime = orchestration.nodes[node.nodeId];
    const job = currentJobForNode(jobs, orchestration.orchestrationId, node.nodeId, runtime?.attempt ?? 1);
    const run = job?.runId ? runs.find((candidate) => candidate.runId === job.runId) : null;
    const evidence = run ? buildRunEvidence(run, { runsRoot }) : null;
    const allowedPaths = node.allowedPaths ?? [];
    const changedPaths = evidence?.scope?.changedPaths ?? [];
    const pathsWithinScope = changedPaths.every((changedPath) => pathWithinAllowed(changedPath, allowedPaths));
    const knowledge = run?.knowledge?.approval ?? null;
    const knowledgeRecorded = Boolean(knowledge?.approvedBy && knowledge?.approvedAt && knowledge?.classification && knowledge?.destination && run?.completion?.humanApproved === true);
    const nodePassed = runtime?.state === "DONE"
      && job?.state === "DONE"
      && run?.state === RUN_STATES.DONE
      && evidence?.verification?.status === "PASS"
      && evidence?.scope?.status === "PASS"
      && evidence?.finalization?.status === "APPLIED"
      && pathsWithinScope;
    if (!nodePassed) nodeErrors.push(node.nodeId);
    if (!knowledgeRecorded) nodeErrors.push(`${node.nodeId}:knowledge`);
    if (job?.createdAt) nodeCompletionTimes.set(node.nodeId, { createdAt: job.createdAt, completedAt: run?.completion?.completedAt ?? job.updatedAt ?? job.createdAt });
    nodeEvidence.push({
      nodeId: node.nodeId,
      state: runtime?.state ?? null,
      attempt: runtime?.attempt ?? null,
      jobId: job?.jobId ?? null,
      runId: run?.runId ?? null,
      runState: run?.state ?? null,
      passed: nodePassed,
      pathsWithinScope,
      changedPaths,
      allowedPaths,
      knowledgeRecorded,
      knowledge: knowledge ? { classification: knowledge.classification, destination: knowledge.destination, approvedBy: knowledge.approvedBy, approvedAt: knowledge.approvedAt } : null,
    });
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      const predecessor = nodeCompletionTimes.get(dependency);
      const successor = nodeCompletionTimes.get(node.nodeId);
      if (!predecessor || !successor || String(predecessor.createdAt).localeCompare(String(successor.createdAt)) > 0) {
        executionErrors.push(`${dependency}->${node.nodeId}`);
      }
    }
  }
  const projects = listProjects(vaultRoot).projects.filter((project) => new Set(plan.projects).has(project.id));
  const repositoryEvidence = projects.map((project) => ({ projectId: project.id, repository: project.repository, ...repositoryStatus(project.repository) }));
  const planCheck = result("APPROVED_PLAN_FINGERPRINT", Boolean(
    plan.state === "APPROVED"
      && plan.planFingerprint === planFingerprint(plan)
      && orchestration.planFingerprint === plan.planFingerprint
      && approval?.state === "RESOLVED"
      && approval.resolution?.action === "APPROVE"
      && approval.evidence?.planFingerprint === plan.planFingerprint,
  ), "Approved plan fingerprint and human approval provenance are consistent.", {
    planId: plan.planId,
    planFingerprint: plan.planFingerprint,
    approvalDecisionId: approval?.decisionId ?? null,
    approvedBy: approval?.resolution?.resolvedBy ?? null,
  });
  const structureCheck = result("SEQUENTIAL_PILOT_STRUCTURE", plan.nodes.length >= 3 && plan.nodes.some((node) => (node.dependsOn ?? []).length > 0), "Pilot contains at least three nodes and a dependency edge.", { nodeCount: plan.nodes.length, dependencyEdges: plan.nodes.reduce((sum, node) => sum + (node.dependsOn?.length ?? 0), 0) });
  const mappingCheck = result("CANONICAL_TASK_MAPPING", mapping.passed, mapping.passed ? "Every plan node maps to its canonical materialized task document." : "Canonical task mapping is incomplete or inconsistent.", mapping);
  const duplicateCheck = result("NO_DUPLICATE_JOBS_RUNS", duplicates.passed, duplicates.passed ? "No duplicate job attempt, active task job, or run identity was found." : "Duplicate job or run evidence was found.", duplicates);
  const executionCheck = result("SEQUENTIAL_EXECUTION_ORDER", executionErrors.length === 0 && orchestration.state === "DONE", executionErrors.length === 0 && orchestration.state === "DONE" ? "All dependency edges executed in deterministic sequential order." : "Execution order or terminal orchestration state is not certifiable.", { orchestrationState: orchestration.state, errors: executionErrors });
  const restartCheckResult = restartCheck(orchestration, restartEvidence);
  const scopeCheck = result("NODE_ACCEPTANCE_SCOPE", nodeErrors.filter((error) => !String(error).endsWith(":knowledge")).length === 0, nodeErrors.length === 0 ? "Every accepted node has passing verification, applied evidence, and in-scope paths." : "One or more accepted nodes lacks complete in-scope acceptance evidence.", { nodes: nodeEvidence, failedNodes: nodeErrors.filter((error) => !String(error).endsWith(":knowledge")) });
  const knowledgeCheck = result("NODE_KNOWLEDGE_DECISIONS", nodeErrors.filter((error) => String(error).endsWith(":knowledge")).length === 0, nodeErrors.filter((error) => String(error).endsWith(":knowledge")).length === 0 ? "Every node has a recorded human knowledge decision." : "One or more nodes lacks a recorded human knowledge decision.", { failedNodes: nodeErrors.filter((error) => String(error).endsWith(":knowledge")), nodes: nodeEvidence.map((item) => ({ nodeId: item.nodeId, runId: item.runId, knowledgeRecorded: item.knowledgeRecorded })) });
  const repositoryCheck = result("FINAL_REPOSITORIES_CLEAN", repositoryEvidence.length === new Set(plan.projects).size && repositoryEvidence.every((repository) => repository.status === "CLEAN"), repositoryEvidence.every((repository) => repository.status === "CLEAN") ? "All pilot repositories are clean after accepted execution." : "One or more pilot repositories is dirty or unavailable.", { repositories: repositoryEvidence });
  const checks = [structureCheck, planCheck, mappingCheck, duplicateCheck, executionCheck, restartCheckResult, scopeCheck, knowledgeCheck, repositoryCheck];
  const blockers = checks.filter((check) => check.status !== "PASS").map((check) => check.id);
  const certificationId = `v2-033-sequential-${objective.objectiveId}-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
  const bundle = {
    schemaVersion: SEQUENTIAL_ORCHESTRATION_CERTIFICATION_SCHEMA_VERSION,
    kind: SEQUENTIAL_ORCHESTRATION_CERTIFICATION_KIND,
    certificationId,
    createdAt: now.toISOString(),
    status: blockers.length ? "CONDITIONAL" : "CERTIFICATION_READY",
    humanGate: { required: true, confirmed: false, approvedBy: null, approvedAt: null },
    blockers,
    objective: { objectiveId: objective.objectiveId, state: objective.state, projectIds: objective.projectIds },
    plan: { planId: plan.planId, revision: plan.revision, planFingerprint: plan.planFingerprint, approvedBy: plan.approvedBy, approvedAt: plan.approvedAt },
    orchestration: { orchestrationId: orchestration.orchestrationId, state: orchestration.state, nodeCount: plan.nodes.length },
    checks,
    evidence: { nodeEvidence, canonicalTaskMapping: mapping, duplicateJobsRuns: duplicates, restartRecovery: restartEvidence ?? orchestration.restartRecovery ?? orchestration.recovery?.restart ?? null, repositories: repositoryEvidence },
    nextAction: blockers.length ? "Resolve certification blockers and rerun V2-033." : "Human must review this bundle and explicitly accept V2-033.",
  };
  const persisted = writeBundle(path.join(certificationDirectory(runsRoot), `${certificationId}.json`), bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.checksum };
}

export function verifySequentialOrchestrationCertification({ bundleFilePath } = {}) {
  if (!bundleFilePath || !fs.existsSync(bundleFilePath)) throw new Error("Sequential orchestration certification bundle tidak ditemukan.");
  const text = fs.readFileSync(bundleFilePath, "utf8");
  const recorded = fs.existsSync(`${bundleFilePath}.sha256`) ? fs.readFileSync(`${bundleFilePath}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
  let bundle = null;
  try { bundle = JSON.parse(text); } catch {}
  const valid = Boolean(bundle
    && recorded === sha256(text)
    && bundle.schemaVersion === SEQUENTIAL_ORCHESTRATION_CERTIFICATION_SCHEMA_VERSION
    && bundle.kind === SEQUENTIAL_ORCHESTRATION_CERTIFICATION_KIND
    && bundle.humanGate?.required === true);
  return { valid, certificationId: bundle?.certificationId ?? null, status: bundle?.status ?? null, checksum: sha256(text), bundle };
}
