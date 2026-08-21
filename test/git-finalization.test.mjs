import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runProcess } from "../src/executor.mjs";
import {
  activateWorkspace,
  applyIsolatedWorkspace,
  cleanupIsolatedWorkspace,
  prepareIsolatedWorkspace,
} from "../src/workspace-manager.mjs";
import { clearFaultInjection, configureFaultInjection } from "../src/fault-injection.mjs";

console.log("Running git-finalization.test.mjs...");

function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function createRepository(root, name) {
  const repository = path.join(root, name);
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "AI OS Test"]);
  git(repository, ["config", "user.email", "ai-os-test@example.invalid"]);
  fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({
    scripts: { test: "node -e \"process.exit(0)\"" },
  }, null, 2));
  fs.writeFileSync(path.join(repository, "app.txt"), "baseline\n");
  fs.writeFileSync(path.join(repository, "notes.txt"), "notes\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", "initial"]);
  return repository;
}

async function prepare({ root, repository, runId, changedPath = "app.txt" }) {
  const runsRoot = path.join(root, "runs");
  const eventLogPath = path.join(runsRoot, "events", `${runId}.jsonl`);
  const manifest = {
    runId,
    project: { id: path.basename(repository), repository, graphify: false },
    task: { id: "TASK-001", title: "Transactional finalization" },
    plan: { verificationCommands: ["npm run test"] },
    execution: { frozenVerificationScripts: { test: "node -e \"process.exit(0)\"" } },
  };
  const prepared = await prepareIsolatedWorkspace({ manifest, runsRoot, eventLogPath, processRunner: runProcess });
  manifest.execution.workspace = { ...activateWorkspace(prepared), state: "VERIFIED" };
  manifest.execution.scopeAudit = { changedPaths: [changedPath] };
  return { manifest, runsRoot, eventLogPath };
}

async function cleanup(repository, workspacePath) {
  if (workspacePath && fs.existsSync(workspacePath)) {
    try { git(repository, ["worktree", "remove", "--force", workspacePath]); } catch {}
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-finalization-"));
try {
  // Clean repository: applied paths become one auditable commit.
  {
    const repository = createRepository(root, "clean-repo");
    const { manifest, runsRoot, eventLogPath } = await prepare({ root, repository, runId: "clean-run" });
    fs.writeFileSync(path.join(manifest.execution.workspace.path, "app.txt"), "accepted\n");
    const result = await applyIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      gitFinalization: { enabled: true },
    });
    assert.equal(result.workspace.gitCommit.committed, true);
    assert.equal(result.workspace.gitCommit.commitHash, git(repository, ["rev-parse", "HEAD"]));
    assert.deepEqual(result.workspace.gitCommit.paths, ["app.txt"]);
    assert.equal(git(repository, ["status", "--short"]), "");
    assert.equal(git(repository, ["show", "--pretty=format:", "--name-only", "HEAD"]), "app.txt");
    await cleanup(repository, manifest.execution.workspace.path);
  }

  // Unrelated dirty files survive and are not included in the task commit.
  {
    const repository = createRepository(root, "dirty-unrelated-repo");
    fs.writeFileSync(path.join(repository, "notes.txt"), "user work\n");
    git(repository, ["add", "notes.txt"]);
    const { manifest, runsRoot, eventLogPath } = await prepare({ root, repository, runId: "dirty-unrelated-run" });
    fs.writeFileSync(path.join(manifest.execution.workspace.path, "app.txt"), "accepted\n");
    const result = await applyIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      gitFinalization: { enabled: true },
    });
    assert.equal(result.workspace.gitCommit.committed, true);
    assert.equal(git(repository, ["status", "--short"]), "M  notes.txt");
    assert.equal(git(repository, ["show", "--pretty=format:", "--name-only", "HEAD"]), "app.txt");
    await cleanup(repository, manifest.execution.workspace.path);
  }

  // A path that was dirty before the run is never auto-committed.
  {
    const repository = createRepository(root, "dirty-target-repo");
    fs.writeFileSync(path.join(repository, "app.txt"), "user work\n");
    const parent = git(repository, ["rev-parse", "HEAD"]);
    const { manifest, runsRoot, eventLogPath } = await prepare({ root, repository, runId: "dirty-target-run" });
    fs.writeFileSync(path.join(manifest.execution.workspace.path, "app.txt"), "agent work\n");
    await assert.rejects(() => applyIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      gitFinalization: { enabled: true },
    }), /applied path sudah dirty sebelum run/);
    assert.equal(fs.readFileSync(path.join(repository, "app.txt"), "utf8"), "user work\n");
    assert.equal(git(repository, ["rev-parse", "HEAD"]), parent);
    await cleanup(repository, manifest.execution.workspace.path);
  }

  // Sensitive paths are rejected and rolled back before they can be committed.
  {
    const repository = createRepository(root, "secret-repo");
    const { manifest, runsRoot, eventLogPath } = await prepare({
      root,
      repository,
      runId: "secret-run",
      changedPath: ".env",
    });
    fs.writeFileSync(path.join(manifest.execution.workspace.path, ".env"), "TOKEN=secret\n");
    await assert.rejects(() => applyIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      gitFinalization: { enabled: true },
    }), /path sensitif/);
    assert.equal(fs.existsSync(path.join(repository, ".env")), false);
    await cleanup(repository, manifest.execution.workspace.path);
  }

  // A commit-hook failure rolls applied files and staging back atomically.
  {
    const repository = createRepository(root, "commit-failure-repo");
    const parent = git(repository, ["rev-parse", "HEAD"]);
    const hookPath = path.join(repository, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    const { manifest, runsRoot, eventLogPath } = await prepare({
      root,
      repository,
      runId: "commit-failure-run",
    });
    fs.writeFileSync(path.join(manifest.execution.workspace.path, "app.txt"), "agent work\n");
    await assert.rejects(() => applyIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      gitFinalization: { enabled: true },
    }), /Git commit applied paths gagal/);
    assert.equal(fs.readFileSync(path.join(repository, "app.txt"), "utf8"), "baseline\n");
    assert.equal(git(repository, ["rev-parse", "HEAD"]), parent);
    assert.equal(git(repository, ["status", "--short"]), "");
    await cleanup(repository, manifest.execution.workspace.path);
  }

  // A fault after source copy rolls files back before commit and preserves the worktree for review.
  {
    const repository = createRepository(root, "apply-fault-repo");
    const parent = git(repository, ["rev-parse", "HEAD"]);
    const { manifest, runsRoot, eventLogPath } = await prepare({ root, repository, runId: "apply-fault-run" });
    fs.writeFileSync(path.join(manifest.execution.workspace.path, "app.txt"), "faulted apply\n");
    configureFaultInjection({ "apply.after-copy": { code: "EIO" } });
    await assert.rejects(() => applyIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      gitFinalization: { enabled: true },
    }), (error) => error.injected && error.faultPoint === "apply.after-copy");
    clearFaultInjection();
    assert.equal(fs.readFileSync(path.join(repository, "app.txt"), "utf8"), "baseline\n");
    assert.equal(git(repository, ["rev-parse", "HEAD"]), parent);
    assert.equal(git(repository, ["status", "--short"]), "");
    assert.equal(fs.existsSync(manifest.execution.workspace.path), true);
    await cleanup(repository, manifest.execution.workspace.path);
  }

  // Cleanup fault keeps the review worktree and archive recoverable; retry completes safely.
  {
    const repository = createRepository(root, "cleanup-fault-repo");
    const { manifest, runsRoot, eventLogPath } = await prepare({ root, repository, runId: "cleanup-fault-run" });
    fs.writeFileSync(path.join(manifest.execution.workspace.path, "app.txt"), "archive before cleanup\n");
    configureFaultInjection({ "cleanup.before-remove": { code: "EIO" } });
    await assert.rejects(() => cleanupIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      outcome: "DISCARDED",
    }), (error) => error.injected && error.faultPoint === "cleanup.before-remove");
    clearFaultInjection();
    assert.equal(fs.existsSync(manifest.execution.workspace.path), true);
    assert.equal(fs.existsSync(path.join(runsRoot, "workspace-artifacts", "cleanup-fault-run", "manifest.json")), true);
    const cleaned = await cleanupIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      outcome: "DISCARDED",
    });
    assert.equal(cleaned.workspace.state, "DISCARDED");
    assert.equal(fs.existsSync(manifest.execution.workspace.path), false);
  }
} finally {
  clearFaultInjection();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("git-finalization.test.mjs: All tests passed!");
