import { getObjective } from "./objective-store.mjs";
import { getPlan } from "./plan-store.mjs";
import { getOrchestration } from "./orchestration-store.mjs";

export const OBJECTIVE_GRAPH_SCHEMA_VERSION = 1;
export const OBJECTIVE_GRAPH_DEFAULT_PAGE_SIZE = 50;
export const OBJECTIVE_GRAPH_MAX_PAGE_SIZE = 100;

function integerQuery(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nodeState(orchestration, nodeId) {
  return orchestration?.nodes?.[nodeId] ?? {};
}

export function buildObjectiveGraph({ runsRoot, objectiveId, page = 1, pageSize = OBJECTIVE_GRAPH_DEFAULT_PAGE_SIZE } = {}) {
  if (!runsRoot || !objectiveId) throw new Error("Objective graph membutuhkan runsRoot dan objectiveId.");
  const objective = getObjective(runsRoot, objectiveId);
  if (!objective) {
    const error = new Error(`Objective tidak ditemukan: ${objectiveId}`);
    error.statusCode = 404;
    error.code = "OBJECTIVE_NOT_FOUND";
    throw error;
  }
  const plan = objective.activePlanId ? getPlan(runsRoot, objective.activePlanId, { knownProjectIds: objective.projectIds, projectIds: objective.projectIds, budget: objective.budget }) : null;
  const orchestration = objective.activeOrchestrationId ? getOrchestration(runsRoot, objective.activeOrchestrationId) : null;
  const normalizedPageSize = Math.min(integerQuery(pageSize, OBJECTIVE_GRAPH_DEFAULT_PAGE_SIZE), OBJECTIVE_GRAPH_MAX_PAGE_SIZE);
  const normalizedPage = integerQuery(page, 1);
  const planNodes = Array.isArray(plan?.nodes) ? plan.nodes : [];
  const allNodes = planNodes.map((node, index) => {
    const runtime = nodeState(orchestration, node.nodeId);
    return {
      id: node.nodeId,
      index,
      title: node.title,
      purpose: node.purpose,
      projectId: node.projectId,
      type: node.type,
      role: node.role,
      state: runtime.state ?? "READY",
      statusLabel: String(runtime.state ?? "READY").replaceAll("_", " "),
      runId: runtime.runId ?? null,
      jobId: runtime.jobId ?? null,
      dependsOn: [...(node.dependsOn ?? [])],
      canRunInParallel: node.canRunInParallel === true,
    };
  });
  const nodeIds = new Set(allNodes.map((node) => node.id));
  const allEdges = allNodes
    .flatMap((node) => node.dependsOn.filter((dependency) => nodeIds.has(dependency)).map((dependency) => ({ id: `${dependency}->${node.id}`, source: dependency, target: node.id, type: "DEPENDS_ON", label: "Depends on" })))
    .sort((left, right) => left.id.localeCompare(right.id));
  const totalPages = Math.max(1, Math.ceil(allNodes.length / normalizedPageSize));
  const currentPage = Math.min(normalizedPage, totalPages);
  const start = (currentPage - 1) * normalizedPageSize;
  const nodes = allNodes.slice(start, start + normalizedPageSize);
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = allEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const stateCounts = allNodes.reduce((counts, node) => {
    counts[node.state] = (counts[node.state] ?? 0) + 1;
    return counts;
  }, {});
  return {
    schemaVersion: OBJECTIVE_GRAPH_SCHEMA_VERSION,
    mode: "objective-graph",
    objectiveId: objective.objectiveId,
    objectiveState: objective.state,
    planId: plan?.planId ?? null,
    orchestrationId: orchestration?.orchestrationId ?? null,
    revision: Number(orchestration?.revision ?? plan?.revision ?? objective.revision ?? 0),
    bounded: true,
    nodes,
    edges,
    summary: {
      totalNodes: allNodes.length,
      totalEdges: allEdges.length,
      stateCounts,
      page: currentPage,
      pageSize: normalizedPageSize,
      totalPages,
      hasPrevious: currentPage > 1,
      hasNext: currentPage < totalPages,
    },
  };
}
