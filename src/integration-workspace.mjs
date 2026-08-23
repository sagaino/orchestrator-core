import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { injectFault } from "./fault-injection.mjs";
import { isDeniedPath } from "./security.mjs";
import { changedPaths, repositorySnapshot, snapshotFromObject, snapshotToObject } from "./workspace-manager.mjs";

const WORKSPACE_ROOT = "integration";

export class IntegrationWorkspaceError extends Error {
  constructor(message, { code = "INTEGRATION_WORKSPACE_ERROR", details = null } = {}) {
    super(message);
    this.name = "IntegrationWorkspaceError";
    this.code = code;
    this.details = details ?? { code };
  }
}

function fail(message, options = {}) {
  throw new IntegrationWorkspaceError(message, options);
}

function safeSegment(value) {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!normalized) fail(`Workspace identifier tidak valid: ${value}`, { code: "INTEGRATION_WORKSPACE_IDENTIFIER_INVALID" });
  return normalized;
}

function ensureInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`Integration workspace berada di luar root: ${target}`, { code: "INTEGRATION_WORKSPACE_PATH_ESCAPE" });
  }
  return path.resolve(target);
}

function workspaceBasePath({ runsRoot, orchestrationId, projectId }) {
  return ensureInside(
    path.join(runsRoot, WORKSPACE_ROOT),
    path.join(runsRoot, WORKSPACE_ROOT, safeSegment(orchestrationId), safeSegment(projectId)),
  );
}

export function integrationWorkspacePath({ runsRoot, orchestrationId, projectId }) {
  return path.join(workspaceBasePath({ runsRoot, orchestrationId, projectId }), "workspace");
}

function metadataPath(workspace) {
  return path.join(workspace.basePath, "manifest.json");
}

function writeMetadata(workspace, metadata) {
  fs.mkdirSync(workspace.basePath, { recursive: true, mode: 0o700 });
  const target = metadataPath(workspace);
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
  return metadata;
}

function writeRollbackArtifact(workspace, { reason = null, error = null } = {}) {
  const target = path.join(workspace.basePath, "rollback.json");
  fs.writeFileSync(target, `${JSON.stringify({
    schemaVersion: 1,
    state: "ROLLED_BACK",
    orchestrationId: workspace.orchestrationId,
    projectId: workspace.projectId,
    baseCommit: workspace.baseCommit,
    reason,
    error: error ? { name: error.name, code: error.code ?? null, message: error.message } : null,
    changedPathsBeforeRollback: workspace.changedPaths ?? [],
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

function git(repository, args, { input = undefined, maxBuffer = 32 * 1024 * 1024 } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      input,
      maxBuffer,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "").trim();
    const wrapped = new IntegrationWorkspaceError(
      `Git integration workspace gagal: git ${args.join(" ")}${detail ? `: ${detail}` : "."}`,
      { code: "INTEGRATION_GIT_OPERATION_FAILED", details: { command: ["git", ...args], detail } },
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function sourceState(repository) {
  return {
    head: git(repository, ["rev-parse", "HEAD"]),
    status: git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  };
}

function assertSourceBaseline(workspace) {
  const current = sourceState(workspace.sourceRepository);
  if (current.head !== workspace.frozenSourceHead || current.status !== workspace.frozenSourceStatus) {
    fail("Source repository berubah setelah integration baseline dibekukan.", {
      code: "INTEGRATION_BASELINE_DRIFT",
      details: {
        frozenHead: workspace.frozenSourceHead,
        currentHead: current.head,
        frozenStatusHash: workspace.frozenSourceStatusHash,
        currentStatusHash: hashText(current.status),
      },
    });
  }
  return current;
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizedPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function pathAllowed(filePath, allowedPaths = []) {
  const candidate = normalizedPath(filePath);
  return allowedPaths.some((allowed) => {
    const normalized = normalizedPath(allowed);
    const base = normalized.split(/[?*\[]/, 1)[0].replace(/\/$/, "");
    return candidate === normalized || candidate === base || candidate.startsWith(`${base}/`);
  });
}

function patchPaths({ sourceRepository, parentCommit, commitHash }) {
  return git(sourceRepository, ["diff", "--name-only", parentCommit, commitHash])
    .split(/\r?\n/).map(normalizedPath).filter(Boolean);
}

function validatePatch({ sourceRepository, patch, allowedPaths }) {
  if (!patch?.runId || !patch.commitHash || !patch.parentCommit) {
    fail("Integration patch tidak memiliki runId, commitHash, atau parentCommit.", {
      code: "INTEGRATION_PATCH_METADATA_MISSING",
      details: { patch },
    });
  }
  const changed = patchPaths({ sourceRepository, parentCommit: patch.parentCommit, commitHash: patch.commitHash });
  const denied = changed.filter((filePath) => isDeniedPath(filePath).denied);
  if (denied.length) {
    fail(`Integration patch menyentuh path denied: ${denied.join(", ")}.`, {
      code: "INTEGRATION_DENIED_PATH",
      details: { runId: patch.runId, deniedPaths: denied },
    });
  }
  const outOfScope = changed.filter((filePath) => !pathAllowed(filePath, allowedPaths));
  if (outOfScope.length) {
    fail(`Integration patch berada di luar union scope: ${outOfScope.join(", ")}.`, {
      code: "INTEGRATION_SCOPE_VIOLATION",
      details: { runId: patch.runId, outOfScopePaths: outOfScope, allowedPaths },
    });
  }
  return { ...patch, changedPaths: changed };
}

function resetWorkspace(workspace) {
  git(workspace.workspacePath, ["reset", "--hard", workspace.baseCommit]);
  git(workspace.workspacePath, ["clean", "-fd"]);
  return repositorySnapshot(workspace.workspacePath);
}

export function prepareIntegrationWorkspace({
  runsRoot,
  orchestrationId,
  projectId,
  sourceRepository,
  baseCommit = null,
  objectiveId = null,
  planId = null,
} = {}) {
  if (!runsRoot || !orchestrationId || !projectId || !sourceRepository) {
    fail("Integration workspace membutuhkan runsRoot, orchestrationId, projectId, dan sourceRepository.", { code: "INTEGRATION_WORKSPACE_ARGUMENTS_REQUIRED" });
  }
  const repository = fs.realpathSync(path.resolve(sourceRepository));
  const basePath = workspaceBasePath({ runsRoot, orchestrationId, projectId });
  const workspacePath = integrationWorkspacePath({ runsRoot, orchestrationId, projectId });
  const existingMetadata = metadataPath({ basePath });
  if (fs.existsSync(existingMetadata) && fs.existsSync(workspacePath)) {
    const existing = JSON.parse(fs.readFileSync(existingMetadata, "utf8"));
    if (existing.state !== "CLEANED") return existing;
  }
  const source = sourceState(repository);
  const frozenBase = baseCommit || source.head;
  if (baseCommit && frozenBase !== source.head) {
    fail("Integration base commit tidak sama dengan HEAD source repository yang dibekukan.", {
      code: "INTEGRATION_BASELINE_BASE_COMMIT_MISMATCH",
      details: { baseCommit: frozenBase, sourceHead: source.head },
    });
  }
  git(repository, ["cat-file", "-e", `${frozenBase}^{commit}`]);
  if (fs.existsSync(workspacePath)) {
    fail(`Integration workspace sudah ada tanpa metadata aktif: ${workspacePath}`, { code: "INTEGRATION_WORKSPACE_ALREADY_EXISTS" });
  }
  fs.mkdirSync(basePath, { recursive: true, mode: 0o700 });
  try {
    injectFault("integration.workspace.before-create", { workspacePath, projectId, orchestrationId });
    git(repository, ["worktree", "add", "--detach", workspacePath, frozenBase]);
    const metadata = {
      schemaVersion: 1,
      mode: "aggregate-integration",
      state: "PREPARED",
      objectiveId,
      planId,
      orchestrationId,
      projectId,
      basePath,
      workspacePath,
      sourceRepository: repository,
      baseCommit: frozenBase,
      frozenSourceHead: source.head,
      frozenSourceStatus: source.status,
      frozenSourceStatusHash: hashText(source.status),
      baselineSnapshot: snapshotToObject(repositorySnapshot(workspacePath)),
      patches: [],
      changedPaths: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return writeMetadata({ basePath }, metadata);
  } catch (error) {
    try {
      if (fs.existsSync(workspacePath)) git(repository, ["worktree", "remove", "--force", workspacePath]);
    } catch {}
    throw error;
  }
}

export function applyIntegrationPatches({ workspace, patches = [], allowedPaths = [] } = {}) {
  if (!workspace?.workspacePath || !workspace?.sourceRepository) fail("Integration workspace belum dipersiapkan.", { code: "INTEGRATION_WORKSPACE_NOT_PREPARED" });
  if (!fs.existsSync(workspace.workspacePath)) fail("Integration workspace tidak ditemukan.", { code: "INTEGRATION_WORKSPACE_MISSING" });
  assertSourceBaseline(workspace);
  const validated = patches.map((patch) => validatePatch({ sourceRepository: workspace.sourceRepository, patch, allowedPaths }));
  const applied = [];
  try {
    for (const patch of validated) {
      if (patch.changedPaths.length === 0) {
        applied.push(patch);
        continue;
      }
      injectFault("integration.apply.before-patch", { runId: patch.runId, workspacePath: workspace.workspacePath });
      const patchText = `${git(workspace.sourceRepository, ["diff", "--binary", patch.parentCommit, patch.commitHash], { maxBuffer: 64 * 1024 * 1024 })}\n`;
      git(workspace.workspacePath, ["apply", "--index", "--whitespace=nowarn", "-"], { input: patchText, maxBuffer: 64 * 1024 * 1024 });
      injectFault("integration.apply.after-patch", { runId: patch.runId, workspacePath: workspace.workspacePath });
      applied.push(patch);
    }
    const aggregateChangedPaths = changedPaths(
      snapshotFromObject(workspace.baselineSnapshot ?? {}),
      repositorySnapshot(workspace.workspacePath),
    );
    const finalChanged = git(workspace.workspacePath, ["diff", "--name-only", workspace.baseCommit]).split(/\r?\n/).map(normalizedPath).filter(Boolean);
    const next = {
      ...workspace,
      state: "READY_FOR_VERIFICATION",
      patches: applied,
      changedPaths: finalChanged,
      aggregateChangedPaths,
      updatedAt: new Date().toISOString(),
    };
    const aggregateDiffPath = path.join(workspace.basePath, "aggregate.patch");
    fs.writeFileSync(aggregateDiffPath, `${git(workspace.workspacePath, ["diff", "--binary", workspace.baseCommit])}\n`, { encoding: "utf8", mode: 0o600 });
    next.aggregateDiffPath = aggregateDiffPath;
    return writeMetadata(workspace, next);
  } catch (error) {
    try { resetWorkspace(workspace); } catch {}
    const rollbackArtifactPath = writeRollbackArtifact(workspace, { error });
    const rolledBack = { ...workspace, state: "ROLLED_BACK", rollbackAt: new Date().toISOString(), rollbackError: error.message, rollbackArtifactPath };
    writeMetadata(workspace, rolledBack);
    throw error;
  }
}

export function rollbackIntegrationWorkspace({ workspace, reason = null } = {}) {
  if (!workspace?.workspacePath || !fs.existsSync(workspace.workspacePath)) return { ...workspace, state: "ROLLED_BACK", reason };
  resetWorkspace(workspace);
  const rollbackArtifactPath = writeRollbackArtifact(workspace, { reason });
  return writeMetadata(workspace, { ...workspace, state: "ROLLED_BACK", rollbackAt: new Date().toISOString(), rollbackReason: reason, rollbackArtifactPath });
}

export function cleanupIntegrationWorkspace({ workspace, runsRoot } = {}) {
  if (!workspace?.workspacePath) return { skipped: true, reason: "Workspace tidak tersedia." };
  const basePath = ensureInside(path.join(runsRoot, WORKSPACE_ROOT), workspace.basePath);
  const artifactPath = path.join(basePath, "aggregate.patch");
  if (fs.existsSync(workspace.workspacePath)) {
    const patch = git(workspace.workspacePath, ["diff", "--binary", workspace.baseCommit]);
    fs.writeFileSync(artifactPath, patch, { encoding: "utf8", mode: 0o600 });
    injectFault("integration.cleanup.before-remove", { workspacePath: workspace.workspacePath });
    git(workspace.sourceRepository, ["worktree", "remove", "--force", workspace.workspacePath]);
    try { git(workspace.sourceRepository, ["worktree", "prune"]); } catch {}
  }
  return writeMetadata({ basePath }, { ...workspace, state: "CLEANED", artifactPath, removedAt: new Date().toISOString() });
}
