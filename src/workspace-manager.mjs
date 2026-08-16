import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeniedPath, validateSymlink } from "./security.mjs";

const SNAPSHOT_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "graphify-out",
  ".next",
]);

function safeSegment(value) {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!normalized) throw new Error(`Workspace identifier tidak valid: ${value}`);
  return normalized;
}

function ensureInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workspace target berada di luar root: ${target}`);
  }
  return resolvedTarget;
}

function hashPath(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    return createHash("sha256").update(`symlink:${fs.readlinkSync(filePath)}`).digest("hex");
  }
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function repositorySnapshot(repository) {
  const snapshot = new Map();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (SNAPSHOT_EXCLUDES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink() && !validateSymlink(absolute, repository).valid) continue;
        const relative = path.relative(repository, absolute).split(path.sep).join("/");
        snapshot.set(relative, hashPath(absolute));
      }
    }
  };
  walk(repository);
  return snapshot;
}

export function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort();
}

export function snapshotToObject(snapshot) {
  return Object.fromEntries([...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function snapshotFromObject(snapshot = {}) {
  return new Map(Object.entries(snapshot));
}

function copyEntry(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stat = fs.lstatSync(source);
  if (pathExists(target) && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
  if (stat.isSymbolicLink()) {
    if (pathExists(target)) fs.unlinkSync(target);
    fs.symlinkSync(fs.readlinkSync(source), target);
    return;
  }
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.chmodSync(temporary, stat.mode);
  fs.renameSync(temporary, target);
}

function pruneEmptyDirectories(root) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || SNAPSHOT_EXCLUDES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      walk(absolute);
      if (fs.readdirSync(absolute).length === 0) fs.rmdirSync(absolute);
    }
  };
  walk(root);
}

function seedWorkingTree(sourceRepository, workspacePath) {
  const source = repositorySnapshot(sourceRepository);
  const workspace = repositorySnapshot(workspacePath);
  for (const relative of workspace.keys()) {
    if (source.has(relative)) continue;
    const target = path.join(workspacePath, relative);
    if (pathExists(target)) fs.unlinkSync(target);
  }
  for (const relative of source.keys()) {
    if (isDeniedPath(relative).denied) continue;
    const sourcePath = path.join(sourceRepository, relative);
    if (fs.lstatSync(sourcePath).isSymbolicLink()) {
      if (!validateSymlink(sourcePath, sourceRepository).valid) continue;
    }
    copyEntry(sourcePath, path.join(workspacePath, relative));
  }
  pruneEmptyDirectories(workspacePath);
  return source;
}

async function requireSuccessfulProcess(processRunner, invocation, errorPrefix) {
  const result = await processRunner(invocation);
  if (result.exitCode !== 0) {
    const detail = String(result.stderrTail || result.stdoutTail || "").trim();
    throw new Error(`${errorPrefix} (exit code ${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export async function prepareIsolatedWorkspace({ manifest, runsRoot, eventLogPath, processRunner }) {
  const existing = manifest.execution?.workspace;
  if (existing?.path && fs.existsSync(existing.path) && ["PREPARING", "ACTIVE", "VERIFIED"].includes(existing.state)) {
    return existing;
  }

  const repository = fs.realpathSync(path.resolve(manifest.project.repository));
  const gitRootResult = await requireSuccessfulProcess(processRunner, {
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: repository,
    stage: "workspace:git-root",
    eventLogPath,
  }, "Repository project bukan Git worktree yang valid");
  const gitRoot = fs.realpathSync(path.resolve(gitRootResult.stdoutTail.trim()));
  if (gitRoot !== repository) {
    throw new Error(`Repository registry harus menunjuk Git root: ${gitRoot}`);
  }
  const commitResult = await requireSuccessfulProcess(processRunner, {
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repository,
    stage: "workspace:base-commit",
    eventLogPath,
  }, "Base commit Git tidak dapat ditentukan");
  const statusResult = await requireSuccessfulProcess(processRunner, {
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: repository,
    stage: "workspace:source-status",
    eventLogPath,
  }, "Status repository tidak dapat dibaca");

  const workspaceRoot = path.join(runsRoot, "workspaces");
  const workspacePath = ensureInside(
    workspaceRoot,
    path.join(workspaceRoot, safeSegment(manifest.project.id), safeSegment(manifest.runId)),
  );
  if (fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path sudah ada dan tidak tercatat aktif: ${workspacePath}`);
  }
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  await requireSuccessfulProcess(processRunner, {
    command: "git",
    args: ["worktree", "add", "--detach", workspacePath, commitResult.stdoutTail.trim()],
    cwd: repository,
    stage: "workspace:create",
    eventLogPath,
  }, "Git worktree gagal dibuat");

  try {
    const sourceBaseline = seedWorkingTree(repository, workspacePath);
    return {
      schemaVersion: 1,
      mode: "git-worktree",
      state: "PREPARING",
      path: workspacePath,
      sourceRepository: repository,
      baseCommit: commitResult.stdoutTail.trim(),
      sourceDirty: Boolean(statusResult.stdoutTail.trim()),
      sourceStatusEntryCount: statusResult.stdoutTail.split("\n").filter((line) => line.trim()).length,
      sourceBaseline: snapshotToObject(sourceBaseline),
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    await processRunner({
      command: "git",
      args: ["worktree", "remove", "--force", workspacePath],
      cwd: repository,
      stage: "workspace:create-rollback",
      eventLogPath,
    });
    throw error;
  }
}

export function activateWorkspace(workspace) {
  const baseline = repositorySnapshot(workspace.path);
  return {
    ...workspace,
    state: "ACTIVE",
    baseline: snapshotToObject(baseline),
    activatedAt: new Date().toISOString(),
  };
}

function parseVerificationCommand(command) {
  const match = String(command).match(/^npm run ([A-Za-z0-9:_-]+)$/);
  if (!match) throw new Error(`Verification command tidak didukung saat apply workspace: ${command}`);
  return { command: "npm", args: ["run", match[1]] };
}

function packageInstallInvocation(repository) {
  const packageDocument = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
  const declared = String(packageDocument.packageManager ?? "").split("@")[0].trim();
  const manager = declared
    || (fs.existsSync(path.join(repository, "pnpm-lock.yaml")) ? "pnpm" : null)
    || (fs.existsSync(path.join(repository, "yarn.lock")) ? "yarn" : null)
    || (fs.existsSync(path.join(repository, "bun.lock")) || fs.existsSync(path.join(repository, "bun.lockb")) ? "bun" : null)
    || "npm";
  const invocations = {
    npm: { command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] },
    pnpm: { command: "pnpm", args: ["install", "--ignore-scripts", "--no-frozen-lockfile"] },
    yarn: { command: "yarn", args: ["install", "--ignore-scripts"] },
    bun: { command: "bun", args: ["install", "--ignore-scripts"] },
  };
  if (!invocations[manager]) throw new Error(`Package manager belum didukung saat apply workspace: ${manager}`);
  return { manager, ...invocations[manager] };
}

function backupChangedPaths({ sourceRepository, changed, backupRoot }) {
  const entries = [];
  for (const relative of changed) {
    const source = path.join(sourceRepository, relative);
    const existed = pathExists(source);
    entries.push({ path: relative, existed });
    if (existed) copyEntry(source, path.join(backupRoot, "files", relative));
  }
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  return entries;
}

function applyChangedPaths({ workspacePath, sourceRepository, changed }) {
  for (const relative of changed) {
    const source = path.join(workspacePath, relative);
    const target = path.join(sourceRepository, relative);
    if (pathExists(source)) copyEntry(source, target);
    else if (pathExists(target)) fs.unlinkSync(target);
  }
  pruneEmptyDirectories(sourceRepository);
}

function restoreBackup({ sourceRepository, backupRoot, entries }) {
  for (const entry of entries) {
    const target = path.join(sourceRepository, entry.path);
    if (entry.existed) copyEntry(path.join(backupRoot, "files", entry.path), target);
    else if (pathExists(target)) fs.unlinkSync(target);
  }
  pruneEmptyDirectories(sourceRepository);
}

function assertVerificationScriptsUnmodified(repository, frozenScripts) {
  if (!frozenScripts || Object.keys(frozenScripts).length === 0) return;
  const packagePath = path.join(repository, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error("package.json tidak ditemukan saat validasi verification script.");
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Gagal membaca package.json untuk validasi script: ${error.message}`);
  }
  const currentScripts = pkg.scripts || {};
  for (const [name, expectedCommand] of Object.entries(frozenScripts)) {
    const actualCommand = currentScripts[name];
    if (actualCommand !== expectedCommand) {
      throw new Error(
        `Verification script "${name}" berubah setelah claim (sebelumnya: "${expectedCommand}", sekarang: "${actualCommand ?? "dihapus"}"). Perubahan pada verification script membutuhkan otorisasi eksplisit.`
      );
    }
  }
}

export async function applyIsolatedWorkspace({
  manifest,
  runsRoot,
  eventLogPath,
  processRunner,
}) {
  const workspace = manifest.execution?.workspace;
  if (!workspace?.path || !fs.existsSync(workspace.path)) {
    return { skipped: true, reason: "Run legacy tidak memiliki isolated workspace." };
  }
  if (workspace.state === "APPLIED" || workspace.state === "CLEANED") {
    return { skipped: true, reason: `Workspace sudah ${workspace.state}.`, workspace };
  }
  if (workspace.state !== "VERIFIED") {
    throw new Error(`Workspace belum siap diterapkan; state ${workspace.state}.`);
  }
  if (!workspace.baseline) throw new Error("Workspace baseline tidak tersedia.");

  const changed = manifest.execution?.scopeAudit?.changedPaths ?? changedPaths(
    snapshotFromObject(workspace.baseline),
    repositorySnapshot(workspace.path),
  );
  const sourceCurrent = repositorySnapshot(workspace.sourceRepository);
  const conflicts = changed.filter((relative) => sourceCurrent.get(relative) !== workspace.sourceBaseline?.[relative]);
  if (conflicts.length) {
    throw new Error(`Workspace apply conflict; file sumber berubah setelah task dimulai: ${conflicts.join(", ")}.`);
  }

  const backupRoot = path.join(
    runsRoot,
    "workspace-backups",
    safeSegment(manifest.runId),
    `${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  const entries = backupChangedPaths({
    sourceRepository: workspace.sourceRepository,
    changed,
    backupRoot,
  });

  const verification = [];
  let dependency = { skipped: true, reason: "package.json tidak berubah." };
  let graphify = { skipped: true, reason: "Graphify disabled for project." };
  try {
    applyChangedPaths({
      workspacePath: workspace.path,
      sourceRepository: workspace.sourceRepository,
      changed,
    });
    if (changed.includes("package.json")) {
      const invocation = packageInstallInvocation(workspace.sourceRepository);
      const result = await requireSuccessfulProcess(processRunner, {
        command: invocation.command,
        args: invocation.args,
        cwd: workspace.sourceRepository,
        stage: "workspace-apply:dependency-install",
        eventLogPath,
      }, "Dependency install setelah workspace apply gagal");
      dependency = { skipped: false, manager: invocation.manager, exitCode: result.exitCode };
    }
    assertVerificationScriptsUnmodified(workspace.sourceRepository, manifest.execution?.frozenVerificationScripts);
    for (const verificationCommand of manifest.plan.verificationCommands) {
      const invocation = parseVerificationCommand(verificationCommand);
      const result = await requireSuccessfulProcess(processRunner, {
        ...invocation,
        cwd: workspace.sourceRepository,
        stage: `workspace-apply:verification:${verificationCommand}`,
        eventLogPath,
      }, `Post-apply verification gagal: ${verificationCommand}`);
      verification.push({ command: verificationCommand, exitCode: result.exitCode });
    }
    if (manifest.project.graphify) {
      const result = await requireSuccessfulProcess(processRunner, {
        command: "graphify",
        args: ["update", "."],
        cwd: workspace.sourceRepository,
        stage: "workspace-apply:graphify-update",
        eventLogPath,
      }, "Graphify update setelah workspace apply gagal");
      graphify = { skipped: false, exitCode: result.exitCode };
    }
  } catch (error) {
    restoreBackup({ sourceRepository: workspace.sourceRepository, backupRoot, entries });
    if (changed.includes("package.json")) {
      try {
        const invocation = packageInstallInvocation(workspace.sourceRepository);
        await processRunner({
          command: invocation.command,
          args: invocation.args,
          cwd: workspace.sourceRepository,
          stage: "workspace-apply:rollback-dependencies",
          eventLogPath,
        });
      } catch {
        // Preserve the original apply error; rollback details remain in the event log.
      }
    }
    if (manifest.project.graphify) {
      await processRunner({
        command: "graphify",
        args: ["update", "."],
        cwd: workspace.sourceRepository,
        stage: "workspace-apply:rollback-graphify",
        eventLogPath,
      });
    }
    throw error;
  }

  return {
    skipped: false,
    workspace: {
      ...workspace,
      state: "APPLIED",
      appliedAt: new Date().toISOString(),
      appliedPaths: changed,
      backupPath: path.relative(runsRoot, backupRoot).split(path.sep).join("/"),
      postApplyVerification: verification,
      postApplyDependency: dependency,
      postApplyGraphify: graphify,
    },
  };
}

function archiveWorkspace({ manifest, runsRoot }) {
  const workspace = manifest.execution?.workspace;
  const changed = workspace.baseline && fs.existsSync(workspace.path)
    ? changedPaths(snapshotFromObject(workspace.baseline), repositorySnapshot(workspace.path))
    : manifest.execution?.scopeAudit?.changedPaths ?? [];
  const artifactRoot = path.join(runsRoot, "workspace-artifacts", safeSegment(manifest.runId));
  if (fs.existsSync(artifactRoot)) return path.relative(runsRoot, artifactRoot).split(path.sep).join("/");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const entries = [];
  for (const relative of changed) {
    const source = path.join(workspace.path, relative);
    const exists = pathExists(source);
    entries.push({ path: relative, exists });
    if (exists) copyEntry(source, path.join(artifactRoot, "files", relative));
  }
  fs.writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: manifest.runId,
    archivedAt: new Date().toISOString(),
    workspace: {
      mode: workspace.mode,
      baseCommit: workspace.baseCommit,
      sourceDirty: workspace.sourceDirty,
    },
    entries,
  }, null, 2)}\n`, "utf8");
  return path.relative(runsRoot, artifactRoot).split(path.sep).join("/");
}

export async function cleanupIsolatedWorkspace({
  manifest,
  runsRoot,
  eventLogPath,
  processRunner,
  outcome = "CLEANED",
}) {
  const workspace = manifest.execution?.workspace;
  if (!workspace?.path) return { skipped: true, reason: "Run tidak memiliki isolated workspace." };
  if (!fs.existsSync(workspace.path)) {
    return { skipped: true, reason: "Workspace sudah tidak ada.", workspace: { ...workspace, state: outcome } };
  }
  const workspaceRoot = path.join(runsRoot, "workspaces");
  ensureInside(workspaceRoot, workspace.path);
  const artifactPath = archiveWorkspace({ manifest, runsRoot });
  await requireSuccessfulProcess(processRunner, {
    command: "git",
    args: ["worktree", "remove", "--force", workspace.path],
    cwd: workspace.sourceRepository,
    stage: "workspace:cleanup",
    eventLogPath,
  }, "Git worktree gagal dibersihkan");
  await processRunner({
    command: "git",
    args: ["worktree", "prune"],
    cwd: workspace.sourceRepository,
    stage: "workspace:prune",
    eventLogPath,
  });
  return {
    skipped: false,
    workspace: {
      ...workspace,
      state: outcome,
      removedAt: new Date().toISOString(),
      artifactPath,
    },
  };
}
