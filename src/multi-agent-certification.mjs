import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { listProjects } from "./core.mjs";
import { getObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration } from "./orchestration-store.mjs";
import { listJobs } from "./job-queue.mjs";
import { listRuns, RUN_STATES } from "./run-manager.mjs";

export const MULTI_AGENT_CERTIFICATION_SCHEMA_VERSION = 1;
export const MULTI_AGENT_CERTIFICATION_KIND = "personal-ai-os-v2-multi-agent-certification";

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

function planOptions(objective) {
  return { knownProjectIds: objective.projectIds, projectIds: objective.projectIds, budget: objective.budget };
}

function currentJob(jobs, orchestrationId, nodeId, attempt = 1) {
  return jobs
    .filter((job) => job.orchestrationId === orchestrationId && job.nodeId === nodeId && Number(job.attempt ?? 1) === Number(attempt))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
}

function dependsOn(nodes, startId, targetId, visiting = new Set()) {
  if (startId === targetId) return true;
  if (visiting.has(startId)) return false;
  visiting.add(startId);
  const node = nodes.find((candidate) => candidate.nodeId === startId);
  return (node?.dependsOn ?? []).some((dependency) => dependency === targetId || dependsOn(nodes, dependency, targetId, visiting));
}

function normalizedPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function pathsOverlap(left, right) {
  const a = normalizedPath(left).split(/[?*\[]/, 1)[0];
  const b = normalizedPath(right).split(/[?*\[]/, 1)[0];
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function interval(item) {
  const start = Date.parse(item?.startedAt ?? item?.claim?.claimedAt ?? item?.createdAt ?? "");
  const end = Date.parse(item?.finishedAt ?? item?.updatedAt ?? item?.createdAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
}

function maxConcurrency(items) {
  const events = items.flatMap((item) => {
    const range = interval(item);
    return range ? [{ at: range.start, delta: 1 }, { at: range.end, delta: -1 }] : [];
  }).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let maximum = 0;
  for (const event of events) {
    current += event.delta;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function tokenUsage(run) {
  return Number(
    run?.execution?.usage?.totalTokens
      ?? run?.execution?.result?.usage?.totalTokens
      ?? run?.usage?.totalTokens
      ?? 0,
  );
}

function repositoryStatus(repository) {
  try {
    const output = execFileSync("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { repository, status: output ? "DIRTY" : "CLEAN", output };
  } catch (error) {
    return { repository, status: "UNKNOWN", output: String(error.stderr ?? error.message ?? "git status failed").trim() };
  }
}

function sourceRunsFor({ nodes, orchestration, jobs, runs }) {
  return nodes.map((node) => {
    const runtime = orchestration.nodes[node.nodeId];
    const job = currentJob(jobs, orchestration.orchestrationId, node.nodeId, runtime?.attempt ?? 1);
    const run = job?.runId ? runs.find((candidate) => candidate.runId === job.runId) : null;
    return { node, runtime, job, run };
  });
}

function duplicateEvidence(records, jobs = []) {
  const attempts = new Map();
  const runIds = new Set();
  const duplicateAttempts = [];
  const duplicateRuns = [];
  const attemptRecords = jobs.length
    ? jobs.map((job) => ({ nodeId: job.nodeId, attempt: job.attempt ?? 1, runId: job.runId }))
    : records.map((record) => ({ nodeId: record.node.nodeId, attempt: record.job?.attempt ?? record.runtime?.attempt ?? 1, runId: record.run?.runId }));
  for (const record of attemptRecords) {
    const key = `${record.nodeId}:attempt-${record.attempt}`;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    if (count > 1) duplicateAttempts.push(key);
    if (record.runId) {
      if (runIds.has(record.runId)) duplicateRuns.push(record.runId);
      runIds.add(record.runId);
    }
  }
  return { passed: duplicateAttempts.length === 0 && duplicateRuns.length === 0, duplicateAttempts, duplicateRuns };
}

function parallelEvidence({ nodes, records }) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (left.projectId !== right.projectId || left.canRunInParallel !== true || right.canRunInParallel !== true) continue;
      if (dependsOn(nodes, left.nodeId, right.nodeId) || dependsOn(nodes, right.nodeId, left.nodeId)) continue;
      const leftRecord = records.find((record) => record.node.nodeId === left.nodeId);
      const rightRecord = records.find((record) => record.node.nodeId === right.nodeId);
      const leftInterval = interval(leftRecord?.job);
      const rightInterval = interval(rightRecord?.job);
      const overlap = Boolean(leftInterval && rightInterval && Math.max(leftInterval.start, rightInterval.start) < Math.min(leftInterval.end, rightInterval.end));
      pairs.push({ nodeIds: [left.nodeId, right.nodeId], projectId: left.projectId, sameProjectParallel: leftRecord?.job?.sameProjectParallel === true && rightRecord?.job?.sameProjectParallel === true, overlap, intervals: { [left.nodeId]: leftInterval, [right.nodeId]: rightInterval } });
    }
  }
  const genuine = pairs.filter((pair) => pair.sameProjectParallel && pair.overlap);
  return { passed: genuine.length > 0, pairs, genuinePairs: genuine };
}

function pathEvidence({ nodes, records }) {
  const conflicts = [];
  const parallelNodes = nodes.filter((node) => node.canRunInParallel === true);
  for (let leftIndex = 0; leftIndex < parallelNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parallelNodes.length; rightIndex += 1) {
      const left = parallelNodes[leftIndex];
      const right = parallelNodes[rightIndex];
      if (left.projectId !== right.projectId) continue;
      const leftPaths = records.find((record) => record.node.nodeId === left.nodeId)?.run?.execution?.scopeAudit?.changedPaths ?? [];
      const rightPaths = records.find((record) => record.node.nodeId === right.nodeId)?.run?.execution?.scopeAudit?.changedPaths ?? [];
      for (const leftPath of leftPaths) for (const rightPath of rightPaths) {
        if (pathsOverlap(leftPath, rightPath)) conflicts.push({ nodeIds: [left.nodeId, right.nodeId], path: leftPath, otherPath: rightPath });
      }
    }
  }
  return { passed: conflicts.length === 0, conflicts };
}

function conflictEvidence({ orchestration, records }) {
  const events = [
    ...(orchestration.integration?.conflictEvents ?? []),
    ...records.flatMap((record) => record.run?.execution?.conflictEvents ?? []),
  ];
  const silent = events.filter((event) => event?.resolved === true && !event?.decisionId && event?.humanAccepted !== true);
  return { passed: silent.length === 0, observedConflicts: events.length, silentConflicts: silent };
}

function restartCheck(restartEvidence) {
  const evidence = restartEvidence ?? null;
  const passed = evidence?.status === "PASS"
    && evidence.safe === true
    && evidence.sourceUnchanged === true
    && evidence.duplicateExecution === false
    && evidence.recoverableReject?.verified === true;
  return check("RESTART_RECOVERY", passed, passed ? "Restart point recovered safely without duplicate execution or source mutation." : "Restart evidence does not prove safe recoverable rejection.", evidence ?? { required: true });
}

export function createMultiAgentCertification({ runsRoot, vaultRoot, objectiveId, orchestrationId = null, restartEvidence = null, now = new Date() } = {}) {
  if (!runsRoot || !vaultRoot || !objectiveId) throw new Error("Multi-agent certification membutuhkan runsRoot, vaultRoot, dan objectiveId.");
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) throw new Error(`Objective tidak ditemukan: ${objectiveId}`);
  const selectedOrchestrationId = orchestrationId ?? objective.activeOrchestrationId;
  const orchestration = selectedOrchestrationId ? getOrchestration(runsRoot, selectedOrchestrationId) : null;
  if (!orchestration) throw new Error(`Orchestration tidak ditemukan untuk objective: ${objectiveId}`);
  const plan = getPlan(runsRoot, orchestration.planId, planOptions(objective));
  if (!plan) throw new Error(`Plan tidak ditemukan: ${orchestration.planId}`);
  const jobs = listJobs(runsRoot).filter((job) => job.orchestrationId === orchestration.orchestrationId);
  const runs = listRuns(runsRoot);
  const records = sourceRunsFor({ nodes: plan.nodes, orchestration, jobs, runs });
  const parallel = parallelEvidence({ nodes: plan.nodes, records });
  const paths = pathEvidence({ nodes: plan.nodes, records });
  const duplicates = duplicateEvidence(records, jobs);
  const conflict = conflictEvidence({ orchestration, records });
  const nodeStatesPass = plan.nodes.every((node) => orchestration.nodes[node.nodeId]?.state === "DONE" && records.find((record) => record.node.nodeId === node.nodeId)?.job?.state === "DONE" && records.find((record) => record.node.nodeId === node.nodeId)?.run?.state === RUN_STATES.DONE);
  const integrationNodes = plan.nodes.filter((node) => node.type === "INTEGRATION");
  const dependentIntegration = integrationNodes.filter((node) => node.dependsOn?.length > 0 && node.dependsOn.every((dependency) => plan.nodes.find((candidate) => candidate.nodeId === dependency)));
  const structure = check("PILOT_STRUCTURE", plan.nodes.length >= 4 && parallel.pairs.length > 0 && dependentIntegration.length > 0, "Pilot contains four nodes, a genuine parallel pair, and a dependent integration node.", { nodeCount: plan.nodes.length, parallelPairs: parallel.pairs, dependentIntegration: dependentIntegration.map((node) => node.nodeId) });
  const terminalCheck = check("ALL_NODES_DONE", nodeStatesPass, nodeStatesPass ? "Every pilot node has a durable DONE job, run, and orchestration state." : "One or more pilot nodes is not durably DONE.", { nodes: records.map((record) => ({ nodeId: record.node.nodeId, orchestrationState: record.runtime?.state ?? null, jobState: record.job?.state ?? null, runState: record.run?.state ?? null })) });
  const parallelCheck = check("GENUINE_PARALLEL_EXECUTION", parallel.passed, parallel.passed ? "At least two independent same-project nodes overlapped in execution." : "No genuine same-project parallel execution interval was proven.", parallel);
  const duplicateCheck = check("ZERO_DUPLICATE_EXECUTION", duplicates.passed, duplicates.passed ? "Every node attempt and run identity is unique." : "Duplicate job attempt or run identity detected.", duplicates);
  const pathCheck = check("ZERO_PATH_OVERLAP", paths.passed, paths.passed ? "Parallel branches have no overlapping changed paths." : "Parallel branches changed overlapping paths.", paths);
  const conflictCheck = check("ZERO_SILENT_CONFLICT_RESOLUTION", conflict.passed, conflict.passed ? "No conflict was silently resolved." : "A conflict was resolved without a human decision.", conflict);
  const maxConcurrency = maxConcurrencyFromRecords(records);
  const totalTokens = records.reduce((sum, record) => sum + Math.max(0, tokenUsage(record.run)), 0);
  const maxAgents = Number(objective.budget?.maxParallelAgents ?? 1);
  const tokenCeiling = objective.budget?.maxTotalTokens === null || objective.budget?.maxTotalTokens === undefined ? null : Number(objective.budget.maxTotalTokens);
  const usageCheck = check("BOUNDED_USAGE", maxConcurrency <= maxAgents && (tokenCeiling === null || totalTokens <= tokenCeiling), "Observed concurrency and token usage remain within the approved objective budget.", { maxConcurrency, maxParallelAgents: maxAgents, totalTokens, tokenCeiling });
  const orderErrors = [];
  for (const node of plan.nodes) {
    const successor = records.find((record) => record.node.nodeId === node.nodeId)?.job;
    for (const dependency of node.dependsOn ?? []) {
      const predecessor = records.find((record) => record.node.nodeId === dependency)?.job;
      if (!predecessor || !successor || String(predecessor.finishedAt ?? predecessor.updatedAt).localeCompare(String(successor.startedAt ?? successor.createdAt)) > 0) orderErrors.push(`${dependency}->${node.nodeId}`);
    }
  }
  const orderCheck = check("DAG_INTEGRATION_ORDER", orderErrors.length === 0, orderErrors.length === 0 ? "Dependent nodes started only after their predecessors completed." : "DAG execution order was violated.", { errors: orderErrors });
  const restart = restartCheck(restartEvidence ?? orchestration.restartRecovery ?? orchestration.recovery?.restart);
  const projects = listProjects(vaultRoot).projects.filter((project) => objective.projectIds.includes(project.id));
  const repositories = projects.map((project) => repositoryStatus(project.repository));
  const cleanCheck = check("CLEAN_SOURCE_REPOSITORY", repositories.length === objective.projectIds.length && repositories.every((repository) => repository.status === "CLEAN"), "All source repositories are clean after the pilot.", { repositories });
  const checks = [structure, terminalCheck, parallelCheck, duplicateCheck, pathCheck, conflictCheck, usageCheck, orderCheck, restart, cleanCheck];
  const blockers = checks.filter((item) => item.status !== "PASS").map((item) => item.id);
  const certificationId = `v2-054-${objective.objectiveId}-${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const bundle = {
    schemaVersion: MULTI_AGENT_CERTIFICATION_SCHEMA_VERSION,
    kind: MULTI_AGENT_CERTIFICATION_KIND,
    certificationId,
    createdAt: now.toISOString(),
    status: blockers.length ? "CONDITIONAL" : "CERTIFICATION_READY",
    humanGate: { required: true, confirmed: false, approvedBy: null, approvedAt: null },
    blockers,
    objective: { objectiveId: objective.objectiveId, state: objective.state, projectIds: objective.projectIds },
    plan: { planId: plan.planId, planFingerprint: plan.planFingerprint, approvedBy: plan.approvedBy, approvedAt: plan.approvedAt },
    orchestration: { orchestrationId: orchestration.orchestrationId, state: orchestration.state, nodeCount: plan.nodes.length },
    metrics: { maxConcurrency, maxParallelAgents: maxAgents, totalTokens, tokenCeiling, sourceRunIds: records.map((record) => record.run?.runId).filter(Boolean) },
    checks,
    evidence: { parallel, duplicates, paths, conflict, order: { errors: orderErrors }, restart: restart.evidence, repositories },
    nextAction: blockers.length ? "Resolve certification blockers and rerun V2-054." : "Human must review this bundle and explicitly accept V2-054.",
  };
  const persisted = writeBundle(path.join(certificationDirectory(runsRoot), `${certificationId}.json`), bundle);
  return { ...bundle, bundlePath: persisted.filePath, checksum: persisted.checksum };
}

function maxConcurrencyFromRecords(records) {
  return maxConcurrency(records.map((record) => record.job).filter(Boolean));
}

export function verifyMultiAgentCertification({ bundleFilePath } = {}) {
  if (!bundleFilePath || !fs.existsSync(bundleFilePath)) throw new Error("Multi-agent certification bundle tidak ditemukan.");
  const text = fs.readFileSync(bundleFilePath, "utf8");
  const recorded = fs.existsSync(`${bundleFilePath}.sha256`) ? fs.readFileSync(`${bundleFilePath}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
  let bundle = null;
  try { bundle = JSON.parse(text); } catch {}
  const valid = Boolean(bundle
    && recorded === sha256(text)
    && bundle.schemaVersion === MULTI_AGENT_CERTIFICATION_SCHEMA_VERSION
    && bundle.kind === MULTI_AGENT_CERTIFICATION_KIND
    && bundle.humanGate?.required === true);
  return { valid, certificationId: bundle?.certificationId ?? null, status: bundle?.status ?? null, checksum: sha256(text), bundle };
}
