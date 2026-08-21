import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getRunDiff } from "../src/dev-server-manager.mjs";

console.log("Running run-diff.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-diff-"));
const repository = path.join(root, "repository");
const runsRoot = path.join(root, "runs");
const workspace = path.join(root, "workspace");
const runId = "task-003-20260821T192858Z-f53e742b";

try {
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Tests"], { cwd: repository });

  fs.writeFileSync(path.join(repository, "README.md"), "# Pilot\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repository });

  fs.writeFileSync(path.join(repository, ".gitignore"), "dist/\n", "utf8");
  fs.appendFileSync(path.join(repository, "README.md"), "\nBaseline content.\n", "utf8");
  execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "pilot baseline"], { cwd: repository });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  execFileSync("git", ["worktree", "add", "--detach", workspace, baseCommit], { cwd: repository });
  fs.appendFileSync(path.join(workspace, "README.md"), "\n## Approval lifecycle\n", "utf8");

  fs.writeFileSync(path.join(runsRoot, `${runId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    runId,
    state: "REVIEW",
    createdAt: "2026-08-21T19:28:58.000Z",
    updatedAt: "2026-08-21T19:30:00.000Z",
    project: { id: "test-add-project", repository },
    task: { id: "TASK-003", path: "02-Projects/test-add-project/tasks/task-003.md", status: "REVIEW" },
    plan: {},
    execution: {
      workspace: { path: workspace, state: "VERIFIED", baseCommit, sourceRepository: repository },
      scopeAudit: { changedPaths: ["README.md"] },
    },
    history: [],
  }, null, 2)}\n`, "utf8");

  const live = await getRunDiff({ runsRoot, runId });
  assert.equal(live.workspaceExists, true);
  assert.equal(live.filesCount, 1);
  assert.deepEqual(live.files.map((entry) => entry.file), ["README.md"]);
  assert.doesNotMatch(live.rawDiff, /\.gitignore/);
  assert.match(live.rawDiff, /Approval lifecycle/);

  const artifactPath = path.join(runsRoot, "workspace-artifacts", runId);
  fs.mkdirSync(artifactPath, { recursive: true });
  fs.writeFileSync(path.join(artifactPath, "changes.patch"), live.rawDiff, "utf8");
  const manifestPath = path.join(runsRoot, `${runId}.json`);
  const archivedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  archivedManifest.execution.workspace = {
    ...archivedManifest.execution.workspace,
    path: path.join(root, "removed-workspace"),
    state: "CLEANED",
    artifactPath: path.relative(runsRoot, artifactPath),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(archivedManifest, null, 2)}\n`, "utf8");

  const archived = await getRunDiff({ runsRoot, runId });
  assert.equal(archived.workspaceExists, false);
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.files.map((entry) => entry.file), ["README.md"]);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("run-diff.test.mjs passed");
