/**
 * Pure dependency-graph helpers for orchestration plans.
 *
 * This module intentionally has no filesystem, clock, network, or provider
 * dependency. Node IDs are returned in every graph traversal so callers can
 * resolve the durable plan/runtime records themselves.
 */

const ACTIVE_STATES = new Set(["READY", "BLOCKED"]);
const TERMINAL_OR_ACTIVE_STATES = new Set(["QUEUED", "RUNNING", "REVIEW", "DONE", "FAILED", "CANCELLED"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nodeId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function pathBase(value) {
  const normalized = normalizedPath(value);
  const wildcardIndex = normalized.search(/[?*\[]/);
  return (wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex)).replace(/\/+$/, "");
}

function pathsOverlap(left, right) {
  const a = pathBase(left);
  const b = pathBase(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function graphIndex(nodes) {
  const byId = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = nodeId(node?.nodeId);
    if (id && !byId.has(id)) byId.set(id, node);
  }
  return byId;
}

function dependencyMap(nodes) {
  return new Map(
    [...graphIndex(nodes)].map(([id, node]) => [
      id,
      Array.isArray(node.dependsOn) ? node.dependsOn.map(nodeId).filter(Boolean) : [],
    ]),
  );
}

function findCycle(nodes) {
  const dependencies = dependencyMap(nodes);
  const colors = new Map();
  const stack = [];

  const visit = (id) => {
    const color = colors.get(id);
    if (color === "GRAY") {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (color === "BLACK") return null;

    colors.set(id, "GRAY");
    stack.push(id);
    for (const dependency of uniqueSorted(dependencies.get(id) ?? [])) {
      if (!dependencies.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    colors.set(id, "BLACK");
    return null;
  };

  for (const id of uniqueSorted([...dependencies.keys()])) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return [];
}

function dependsTransitivelyOn(startId, targetId, dependencies, visiting = new Set()) {
  if (startId === targetId) return true;
  if (visiting.has(startId)) return false;
  visiting.add(startId);
  for (const dependency of dependencies.get(startId) ?? []) {
    if (dependency === targetId || dependsTransitivelyOn(dependency, targetId, dependencies, visiting)) return true;
  }
  return false;
}

function graphConflicts(nodes) {
  const byId = graphIndex(nodes);
  const dependencies = dependencyMap(nodes);
  const parallelNodes = [...byId.values()]
    .filter((node) => node.canRunInParallel === true)
    .sort((left, right) => nodeId(left.nodeId).localeCompare(nodeId(right.nodeId)));
  const conflicts = [];

  for (let leftIndex = 0; leftIndex < parallelNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parallelNodes.length; rightIndex += 1) {
      const left = parallelNodes[leftIndex];
      const right = parallelNodes[rightIndex];
      const leftId = nodeId(left.nodeId);
      const rightId = nodeId(right.nodeId);
      if (left.projectId !== right.projectId) continue;
      if (dependsTransitivelyOn(leftId, rightId, dependencies) || dependsTransitivelyOn(rightId, leftId, dependencies)) continue;

      const leftPaths = Array.isArray(left.allowedPaths) ? left.allowedPaths.map(normalizedPath).filter(Boolean) : [];
      const rightPaths = Array.isArray(right.allowedPaths) ? right.allowedPaths.map(normalizedPath).filter(Boolean) : [];
      const overlappingPaths = leftPaths.filter((leftPath) => rightPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)));
      const sameConflictGroup = Boolean(left.writeConflictGroup && right.writeConflictGroup && left.writeConflictGroup === right.writeConflictGroup);
      if (!overlappingPaths.length && !sameConflictGroup) continue;

      conflicts.push({
        nodeIds: [leftId, rightId],
        projectId: left.projectId ?? null,
        reasons: [
          ...(overlappingPaths.length ? ["OVERLAPPING_PATHS"] : []),
          ...(sameConflictGroup ? ["WRITE_CONFLICT_GROUP"] : []),
        ],
        overlappingPaths,
        writeConflictGroup: sameConflictGroup ? left.writeConflictGroup : null,
      });
    }
  }
  return conflicts;
}

function result(errors, details = {}) {
  const normalizedErrors = [...new Set(errors.map(String))];
  return {
    valid: normalizedErrors.length === 0,
    errors: normalizedErrors,
    issues: normalizedErrors.map((message) => ({ message })),
    ...details,
  };
}

export class TaskGraphError extends Error {
  constructor(message, validation) {
    super(message);
    this.name = "TaskGraphError";
    this.validation = validation;
  }
}

/**
 * Validate node IDs, dependencies, cycles, and unsafe same-project parallel
 * write overlap. The input array is never mutated.
 */
export function validateTaskGraph(nodes) {
  const errors = [];
  const duplicateNodeIds = [];
  const missingDependencies = [];
  const selfDependencies = [];
  const byId = new Map();

  if (!Array.isArray(nodes) || nodes.length === 0) {
    return result(["nodes must be a non-empty array"], {
      cycle: [],
      cycles: [],
      conflicts: [],
      duplicateNodeIds,
      missingDependencies,
      selfDependencies,
    });
  }

  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node)) {
      errors.push(`nodes[${index}] must be an object`);
      continue;
    }
    const id = nodeId(node.nodeId);
    if (!id) {
      errors.push(`nodes[${index}].nodeId must be a non-empty string`);
      continue;
    }
    if (byId.has(id)) duplicateNodeIds.push(id);
    else byId.set(id, node);
    if (!Array.isArray(node.dependsOn)) {
      errors.push(`node ${id}.dependsOn must be an array`);
      continue;
    }
    const dependencies = node.dependsOn.map(nodeId);
    if (dependencies.some((dependency) => dependency === null)) errors.push(`node ${id}.dependsOn must contain non-empty strings`);
    if (new Set(dependencies.filter(Boolean)).size !== dependencies.filter(Boolean).length) errors.push(`node ${id}.dependsOn contains duplicate dependencies`);
    for (const dependency of dependencies.filter(Boolean)) {
      if (dependency === id) selfDependencies.push(id);
      else if (!nodes.some((candidate) => nodeId(candidate?.nodeId) === dependency)) missingDependencies.push({ nodeId: id, dependency });
    }
  }

  if (duplicateNodeIds.length) errors.push(`duplicate node IDs: ${uniqueSorted(duplicateNodeIds).join(", ")}`);
  for (const item of missingDependencies.sort((left, right) => `${left.nodeId}:${left.dependency}`.localeCompare(`${right.nodeId}:${right.dependency}`))) {
    errors.push(`missing dependency: ${item.nodeId} -> ${item.dependency}`);
  }
  for (const id of uniqueSorted(selfDependencies)) errors.push(`self dependency: ${id} -> ${id}`);

  const cycle = findCycle(nodes);
  if (cycle.length) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

  const conflicts = graphConflicts(nodes);
  for (const conflict of conflicts) {
    errors.push(`parallel write conflict: ${conflict.nodeIds.join(" and ")} (${conflict.reasons.join(", ")})`);
  }

  return result(errors, {
    cycle,
    cycles: cycle.length ? [cycle] : [],
    conflicts,
    duplicateNodeIds: uniqueSorted(duplicateNodeIds),
    missingDependencies,
    selfDependencies: uniqueSorted(selfDependencies),
  });
}

function requireValidGraph(nodes) {
  const validation = validateTaskGraph(nodes);
  if (!validation.valid) throw new TaskGraphError(`Invalid task graph: ${validation.errors.join("; ")}`, validation);
  return validation;
}

/** Return stable node IDs ordered by dependency depth, then node ID. */
export function topologicalOrder(nodes) {
  requireValidGraph(nodes);
  const byId = graphIndex(nodes);
  const dependencies = dependencyMap(nodes);
  const memo = new Map();
  const depthOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const depth = Math.max(0, ...(dependencies.get(id) ?? []).map((dependency) => depthOf(dependency) + 1));
    memo.set(id, depth);
    return depth;
  };
  return [...byId.keys()].sort((left, right) => depthOf(left) - depthOf(right) || left.localeCompare(right));
}

function runtimeStateFor(runtimeStates, id, node) {
  const value = runtimeStates instanceof Map ? runtimeStates.get(id) : runtimeStates?.[id];
  if (typeof value === "string") return value.toUpperCase();
  if (isRecord(value) && typeof value.state === "string") return value.state.toUpperCase();
  if (typeof node?.state === "string") return node.state.toUpperCase();
  return null;
}

/** Return node IDs whose predecessor runtime states are all exactly DONE. */
export function eligibleNodes(nodes, runtimeStates = {}) {
  requireValidGraph(nodes);
  const byId = graphIndex(nodes);
  const dependencies = dependencyMap(nodes);
  return topologicalOrder(nodes).filter((id) => {
    const node = byId.get(id);
    const state = runtimeStateFor(runtimeStates, id, node);
    if (state && TERMINAL_OR_ACTIVE_STATES.has(state) && !ACTIVE_STATES.has(state)) return false;
    return (dependencies.get(id) ?? []).every((dependency) => runtimeStateFor(runtimeStates, dependency, byId.get(dependency)) === "DONE");
  });
}

/** Return all parallel-write conflicts without touching the filesystem. */
export function detectWriteConflicts(nodes) {
  requireValidGraphStructure(nodes);
  return graphConflicts(nodes);
}

function requireValidGraphStructure(nodes) {
  const validation = validateTaskGraph(nodes);
  if (!validation.valid && (validation.cycle.length || validation.missingDependencies.length || validation.selfDependencies.length || validation.duplicateNodeIds.length)) {
    throw new TaskGraphError(`Invalid task graph: ${validation.errors.join("; ")}`, validation);
  }
  return validation;
}

/**
 * Return descendant node IDs. Both (nodeId, nodes) and (nodes, nodeId) are
 * accepted so callers can use the natural argument order for their context.
 */
export function descendantsOf(first, second) {
  const nodes = Array.isArray(first) ? first : second;
  const rootId = Array.isArray(first) ? nodeId(second) : nodeId(first);
  requireValidGraph(nodes);
  if (!rootId || !graphIndex(nodes).has(rootId)) return [];

  const byId = graphIndex(nodes);
  const dependents = new Map([...byId.keys()].map((id) => [id, []]));
  for (const [id, node] of byId) {
    for (const dependency of Array.isArray(node.dependsOn) ? node.dependsOn.map(nodeId).filter(Boolean) : []) {
      if (dependents.has(dependency)) dependents.get(dependency).push(id);
    }
  }
  const descendants = new Set();
  const pending = [...(dependents.get(rootId) ?? [])].sort((left, right) => left.localeCompare(right));
  while (pending.length) {
    const id = pending.shift();
    if (descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...(dependents.get(id) ?? []).filter((dependent) => !descendants.has(dependent)));
  }
  return topologicalOrder(nodes).filter((id) => descendants.has(id));
}
