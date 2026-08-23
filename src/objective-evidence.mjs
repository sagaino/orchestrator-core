import { getObjective, updateObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration } from "./orchestration-store.mjs";
import { createDecision, listDecisions } from "./decision-store.mjs";
import { listJobs } from "./job-queue.mjs";
import { getRun, listRuns } from "./run-manager.mjs";
import { buildRunEvidence } from "./interaction.mjs";
import { getIntegrationEvidence } from "./integration-manager.mjs";
import { withDurableLease } from "./durable-runtime.mjs";
import { buildObjectiveVisualEvidence } from "./objective-visual-evidence.mjs";

export class ObjectiveEvidenceError extends Error {
  constructor(message, { statusCode = 400, code = "OBJECTIVE_EVIDENCE_INVALID", details = null } = {}) {
    super(message);
    this.name = "ObjectiveEvidenceError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new ObjectiveEvidenceError(message, options);
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function context({ runsRoot, objectiveId }) {
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) fail(`Objective tidak ditemukan: ${objectiveId}`, { statusCode: 404, code: "OBJECTIVE_NOT_FOUND", details: { code: "OBJECTIVE_NOT_FOUND", objectiveId } });
  const plan = objective.activePlanId ? getPlan(runsRoot, objective.activePlanId, { knownProjectIds: objective.projectIds, budget: objective.budget }) : null;
  const orchestration = objective.activeOrchestrationId ? getOrchestration(runsRoot, objective.activeOrchestrationId) : null;
  return { objective, plan, orchestration };
}

function commitHash(run) {
  return run?.execution?.result?.gitCommit?.commitHash
    ?? run?.execution?.workspace?.gitCommit?.commitHash
    ?? null;
}

function verificationStatus(results) {
  if (!results.length) return "UNKNOWN";
  if (results.some((item) => item?.status === "FAIL" || item?.passed === false)) return "FAIL";
  if (results.every((item) => item?.status === "PASS" || item?.passed === true)) return "PASS";
  return "UNKNOWN";
}

function nodeEvidence({ planNode, runtime, jobs, runs, runsRoot }) {
  const job = jobs
    .filter((item) => item.orchestrationId === runtime?.orchestrationId && item.nodeId === planNode.nodeId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
  const runId = runtime?.runId ?? job?.runId ?? null;
  let run = null;
  let evidence = null;
  if (runId) {
    try {
      run = runs.find((item) => item.runId === runId) ?? getRun(runsRoot, runId);
      evidence = buildRunEvidence(run, { runsRoot });
    } catch {
      run = null;
      evidence = null;
    }
  }
  const changedPaths = evidence?.scope?.changedPaths ?? run?.execution?.scopeAudit?.modifiedFiles ?? [];
  const verification = evidence?.verification?.results ?? run?.execution?.verification?.results ?? [];
  const nodeState = runtime?.state ?? "READY";
  return {
    nodeId: planNode.nodeId,
    title: planNode.title,
    purpose: planNode.purpose,
    projectId: planNode.projectId,
    type: planNode.type,
    role: planNode.role,
    dependsOn: planNode.dependsOn,
    state: nodeState,
    runId,
    jobId: runtime?.jobId ?? job?.jobId ?? null,
    commitHash: commitHash(run),
    changedPaths,
    allowedPaths: planNode.allowedPaths ?? [],
    verification,
    verificationStatus: verificationStatus(verification),
    links: runId ? {
      evidence: `/api/runs/${encodeURIComponent(runId)}/evidence`,
      diff: `/api/runs/${encodeURIComponent(runId)}/diff`,
      preview: `/api/runs/${encodeURIComponent(runId)}/preview`,
    } : { evidence: null, diff: null, preview: null },
    error: runtime?.lastError ?? null,
  };
}

function blockerForNode(node) {
  if (["FAILED", "BLOCKED"].includes(node.state)) {
    return { id: `node-${node.nodeId}`, kind: "NODE", nodeId: node.nodeId, state: node.state, message: node.error?.message ?? `Node ${node.nodeId} belum berhasil.` };
  }
  if (!["DONE", "CANCELLED"].includes(node.state)) {
    return { id: `node-${node.nodeId}`, kind: "NODE", nodeId: node.nodeId, state: node.state, message: `Node ${node.nodeId} masih ${node.state}.` };
  }
  if (node.state === "DONE" && !node.runId && node.type !== "INTEGRATION") {
    return { id: `node-${node.nodeId}-run`, kind: "EVIDENCE", nodeId: node.nodeId, state: node.state, message: `Node ${node.nodeId} selesai tanpa run evidence.` };
  }
  return null;
}

export function buildObjectiveEvidence({ runsRoot, objectiveId } = {}) {
  const { objective, plan, orchestration } = context({ runsRoot, objectiveId });
  const decisions = listDecisions(runsRoot).filter((decision) => decision.objectiveId === objective.objectiveId);
  const jobs = listJobs(runsRoot);
  const runs = listRuns(runsRoot);
  const nodes = plan && orchestration
    ? plan.nodes.map((planNode) => nodeEvidence({
      planNode,
      runtime: { ...(orchestration.nodes?.[planNode.nodeId] ?? {}), orchestrationId: orchestration.orchestrationId },
      jobs,
      runs,
      runsRoot,
    }))
    : [];
  const integration = orchestration ? getIntegrationEvidence({ runsRoot, orchestrationId: orchestration.orchestrationId }) : null;
  const openDecisions = decisions.filter((decision) => decision.state === "OPEN");
  const blockers = [
    ...nodes.map(blockerForNode).filter(Boolean),
    ...openDecisions.map((decision) => ({ id: decision.decisionId, kind: "DECISION", decisionId: decision.decisionId, state: decision.state, message: decision.requestedAction })),
  ];
  if (objective.mode === "CROSS_PROJECT_INCIDENT") {
    const repositoryAcceptance = Array.isArray(integration?.repositoryAcceptance) ? integration.repositoryAcceptance : [];
    for (const projectId of objective.projectIds ?? []) {
      const acceptance = repositoryAcceptance.find((item) => item.projectId === projectId);
      if (!acceptance || acceptance.acceptance?.status !== "PASS") {
        blockers.push({ id: `repository-${projectId}`, kind: "REPOSITORY_ACCEPTANCE", projectId, state: acceptance?.acceptance?.status ?? "MISSING", message: `Per-repository acceptance untuk ${projectId} belum lulus.` });
      }
    }
    if (integration?.crossProjectVerification?.required && integration.crossProjectVerification.status !== "PASS") {
      blockers.push({ id: "cross-project-verification", kind: "CROSS_PROJECT_VERIFICATION", state: integration.crossProjectVerification.status, message: "Cross-project contract/E2E verification belum lulus." });
    }
  }
  const runVerification = nodes.flatMap((node) => node.verification);
  const integrationVerification = Array.isArray(integration?.verification)
    ? integration.verification
    : Array.isArray(integration?.verification?.results) ? integration.verification.results : [];
  const verificationResults = [...runVerification, ...integrationVerification];
  const integrationRequired = plan?.integration?.required === true;
  const integrationStatus = integration
    ? integration.status === "PASSED" ? "PASS" : integration.status === "BLOCKED" ? "FAIL" : "UNKNOWN"
    : integrationRequired ? "UNKNOWN" : "NOT_REQUIRED";
  const allNodesDone = nodes.length > 0 && nodes.every((node) => node.state === "DONE");
  const verification = {
    status: integrationStatus === "FAIL" || verificationStatus(verificationResults) === "FAIL"
      ? "FAIL"
      : integrationRequired && integrationStatus !== "PASS"
        ? "UNKNOWN"
        : integrationRequired && integrationStatus === "PASS" && verificationStatus(verificationResults) === "UNKNOWN"
          ? "PASS"
          : verificationStatus(verificationResults),
    results: verificationResults,
    integration: { required: integrationRequired, status: integrationStatus, artifactPath: integration?.artifactPath ?? null },
  };
  const acceptanceDecision = decisions.find((decision) => decision.type === "OBJECTIVE_ACCEPTANCE" && decision.state === "RESOLVED" && decision.resolution?.action === "ACCEPT") ?? null;
  const canAccept = Boolean(orchestration)
    && orchestration.state === "DONE"
    && allNodesDone
    && blockers.length === 0
    && verification.status === "PASS"
    && !acceptanceDecision;
  return {
    schemaVersion: 1,
    mode: "objective-evidence",
    objective,
    plan,
    orchestration,
    nodes,
    visualEvidence: buildObjectiveVisualEvidence({ runsRoot, objective, nodes }),
    integration,
    diffs: nodes.filter((node) => node.runId).map((node) => ({ nodeId: node.nodeId, runId: node.runId, projectId: node.projectId, href: node.links.diff, changedPaths: node.changedPaths })),
    previews: nodes.filter((node) => node.runId).map((node) => ({ nodeId: node.nodeId, runId: node.runId, projectId: node.projectId, href: node.links.preview })),
    verification,
    blockers,
    usage: {
      actual: orchestration?.usage ?? { totalTokens: 0, agentInvocations: 0, retries: 0 },
      budget: objective.budget,
      remainingTokens: objective.budget.maxTotalTokens === null || objective.budget.maxTotalTokens === undefined
        ? null
        : Math.max(0, objective.budget.maxTotalTokens - Number(orchestration?.usage?.totalTokens ?? 0)),
    },
    finalAcceptance: {
      state: acceptanceDecision ? "ACCEPTED" : blockers.length || verification.status !== "PASS" || !orchestration ? "BLOCKED" : "PENDING",
      canAccept,
      decisionId: acceptanceDecision?.decisionId ?? null,
      acceptedBy: acceptanceDecision?.resolution?.resolvedBy ?? null,
      acceptedAt: acceptanceDecision?.resolution?.resolvedAt ?? null,
      requiredReview: true,
    },
    decisions,
  };
}

export function acceptObjective({ runsRoot, objectiveId, acceptedBy = "user", now = new Date() } = {}) {
  return withDurableLease({ runsRoot, namespace: "objective-evidence", key: objectiveId, purpose: `accept objective ${objectiveId}`, ttlMs: 5 * 60 * 1000, reclaimDeadOwner: true, waitTimeoutMs: 2_000 }, () => {
    const evidence = buildObjectiveEvidence({ runsRoot, objectiveId });
    if (evidence.finalAcceptance.state === "ACCEPTED") return { evidence, alreadyAccepted: true };
    if (!evidence.finalAcceptance.canAccept) {
      fail("Final acceptance diblokir sampai seluruh objective evidence lulus review.", { statusCode: 409, code: "OBJECTIVE_ACCEPTANCE_BLOCKED", details: { code: "OBJECTIVE_ACCEPTANCE_BLOCKED", blockers: evidence.blockers, verification: evidence.verification, orchestrationState: evidence.orchestration?.state ?? null } });
    }
    const decisionId = `decision-objective-acceptance-${evidence.objective.objectiveId}-${evidence.orchestration.orchestrationId}`;
    const decision = createDecision({
      runsRoot,
      record: {
        schemaVersion: 1,
        revision: 0,
        decisionId,
        objectiveId: evidence.objective.objectiveId,
        nodeId: null,
        runId: null,
        type: "OBJECTIVE_ACCEPTANCE",
        state: "RESOLVED",
        evidence: {
          orchestrationId: evidence.orchestration.orchestrationId,
          planId: evidence.plan?.planId ?? null,
          planFingerprint: evidence.plan?.planFingerprint ?? null,
          sourceRunIds: evidence.nodes.map((node) => node.runId).filter(Boolean),
          commitHashes: evidence.nodes.map((node) => node.commitHash).filter(Boolean),
          changedPaths: [...new Set(evidence.nodes.flatMap((node) => node.changedPaths))],
          verification: evidence.verification,
        },
        requestedAction: "Accept the completed objective after reviewing node outcomes, diffs, previews, verification, blockers, and usage.",
        allowedChoices: ["ACCEPT", "CANCEL"],
        creator: "SYSTEM",
        createdAt: iso(now),
        resolution: { action: "ACCEPT", resolvedBy: String(acceptedBy), resolvedAt: iso(now) },
      },
    });
    const currentObjective = getObjective(runsRoot, objectiveId);
    const objective = currentObjective.state === "DONE"
      ? currentObjective
      : updateObjective({ runsRoot, objectiveId, expectedRevision: currentObjective.revision, now, patch: { state: "DONE" } });
    return { objective, decision, evidence: buildObjectiveEvidence({ runsRoot, objectiveId }), alreadyAccepted: false };
  });
}
