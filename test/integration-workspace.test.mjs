import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  applyIntegrationPatches,
  cleanupIntegrationWorkspace,
  prepareIntegrationWorkspace,
} from "../src/integration-workspace.mjs";
import { clearFaultInjection, configureFaultInjection } from "../src/fault-injection.mjs";

console.log("Running integration-workspace.test.mjs...");

function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function repositoryFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `integration-workspace-${name}-`));
  const repository = path.join(root, "repository");
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  git(root, ["init", "-q", repository]);
  git(repository, ["config", "user.email", "integration-workspace@example.invalid"]);
  git(repository, ["config", "user.name", "Integration Workspace Test"]);
  fs.writeFileSync(path.join(repository, "src", "a.js"), "baseline-a\n");
  fs.writeFileSync(path.join(repository, "src", "b.js"), "baseline-b\n");
  fs.writeFileSync(path.join(repository, "README.md"), "baseline\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "baseline"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "-qc", "patches"]);
  fs.writeFileSync(path.join(repository, "src", "a.js"), "patch-a\n");
  git(repository, ["add", "src/a.js"]);
  git(repository, ["commit", "-qm", "patch one"]);
  const patchOne = git(repository, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repository, "src", "b.js"), "patch-b\n");
  git(repository, ["add", "src/b.js"]);
  git(repository, ["commit", "-qm", "patch two"]);
  const patchTwo = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["switch", "-q", "-C", "main", baseCommit]);
  return {
    root,
    repository,
    runsRoot,
    orchestrationId: `orch-${name}`,
    projectId: "integration-project",
    baseCommit,
    patches: [
      { runId: "run-one", commitHash: patchOne, parentCommit: baseCommit },
      { runId: "run-two", commitHash: patchTwo, parentCommit: patchOne },
    ],
  };
}

function cleanupFixture(fixture, workspace) {
  clearFaultInjection();
  if (workspace?.workspacePath && fs.existsSync(workspace.workspacePath)) {
    try { cleanupIntegrationWorkspace({ workspace, runsRoot: fixture.runsRoot }); } catch {}
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

const success = repositoryFixture("success");
const sourceHeadBefore = git(success.repository, ["rev-parse", "HEAD"]);
const sourceStatusBefore = git(success.repository, ["status", "--porcelain=v1"]);
let prepared;
try {
  prepared = prepareIntegrationWorkspace({
    runsRoot: success.runsRoot,
    orchestrationId: success.orchestrationId,
    projectId: success.projectId,
    sourceRepository: success.repository,
    baseCommit: success.baseCommit,
  });
  const applied = applyIntegrationPatches({ workspace: prepared, patches: success.patches, allowedPaths: ["src"] });
  assert.equal(applied.state, "READY_FOR_VERIFICATION");
  assert.deepEqual(applied.changedPaths, ["src/a.js", "src/b.js"]);
  assert.equal(fs.readFileSync(path.join(applied.workspacePath, "src/a.js"), "utf8"), "patch-a\n");
  assert.equal(fs.readFileSync(path.join(applied.workspacePath, "src/b.js"), "utf8"), "patch-b\n");
  assert.equal(git(success.repository, ["rev-parse", "HEAD"]), sourceHeadBefore, "source HEAD remains unchanged");
  assert.equal(git(success.repository, ["status", "--porcelain=v1"]), sourceStatusBefore, "source working tree remains unchanged");
  const cleaned = cleanupIntegrationWorkspace({ workspace: applied, runsRoot: success.runsRoot });
  assert.equal(cleaned.state, "CLEANED");
  assert.equal(fs.existsSync(applied.workspacePath), false);
  assert.equal(fs.existsSync(path.join(success.runsRoot, "integration", success.orchestrationId, success.projectId, "aggregate.patch")), true);
} finally {
  cleanupFixture(success, prepared);
}

const fault = repositoryFixture("fault");
let faultWorkspace;
try {
  faultWorkspace = prepareIntegrationWorkspace({ runsRoot: fault.runsRoot, orchestrationId: fault.orchestrationId, projectId: fault.projectId, sourceRepository: fault.repository, baseCommit: fault.baseCommit });
  configureFaultInjection({ "integration.apply.after-patch": { remaining: 1, code: "EIO" } });
  assert.throws(
    () => applyIntegrationPatches({ workspace: faultWorkspace, patches: fault.patches, allowedPaths: ["src"] }),
    (error) => error.injected === true && error.faultPoint === "integration.apply.after-patch",
  );
  assert.equal(fs.readFileSync(path.join(faultWorkspace.workspacePath, "src/a.js"), "utf8"), "baseline-a\n", "apply failure rolls back the aggregate workspace");
  assert.equal(JSON.parse(fs.readFileSync(path.join(faultWorkspace.basePath, "manifest.json"), "utf8")).state, "ROLLED_BACK");
} finally {
  cleanupFixture(fault, faultWorkspace);
}

const denied = repositoryFixture("denied");
let deniedWorkspace;
try {
  const secretCommit = git(denied.repository, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(denied.repository, ".env"), "TOKEN=secret\n");
  git(denied.repository, ["add", ".env"]);
  git(denied.repository, ["commit", "-qm", "secret patch"]);
  const deniedCommit = git(denied.repository, ["rev-parse", "HEAD"]);
  git(denied.repository, ["switch", "-q", "-C", "main", secretCommit]);
  deniedWorkspace = prepareIntegrationWorkspace({ runsRoot: denied.runsRoot, orchestrationId: denied.orchestrationId, projectId: denied.projectId, sourceRepository: denied.repository, baseCommit: denied.baseCommit });
  assert.throws(
    () => applyIntegrationPatches({ workspace: deniedWorkspace, patches: [{ runId: "secret-run", commitHash: deniedCommit, parentCommit: secretCommit }], allowedPaths: ["src"] }),
    (error) => error.code === "INTEGRATION_DENIED_PATH",
  );
  assert.equal(fs.existsSync(path.join(deniedWorkspace.workspacePath, ".env")), false);
} finally {
  cleanupFixture(denied, deniedWorkspace);
}

const conflict = repositoryFixture("conflict");
let conflictWorkspace;
try {
  const conflictBase = conflict.baseCommit;
  git(conflict.repository, ["switch", "-qc", "conflict", conflictBase]);
  fs.writeFileSync(path.join(conflict.repository, "src", "a.js"), "conflicting-a\n");
  git(conflict.repository, ["add", "src/a.js"]);
  git(conflict.repository, ["commit", "-qm", "conflicting patch"]);
  const conflictCommit = git(conflict.repository, ["rev-parse", "HEAD"]);
  git(conflict.repository, ["switch", "-q", "-C", "main", conflictBase]);
  conflictWorkspace = prepareIntegrationWorkspace({ runsRoot: conflict.runsRoot, orchestrationId: conflict.orchestrationId, projectId: conflict.projectId, sourceRepository: conflict.repository, baseCommit: conflict.baseCommit });
  assert.throws(
    () => applyIntegrationPatches({ workspace: conflictWorkspace, patches: [conflict.patches[0], { runId: "conflict-run", commitHash: conflictCommit, parentCommit: conflictBase }], allowedPaths: ["src"] }),
    (error) => error.code === "INTEGRATION_GIT_OPERATION_FAILED",
  );
  assert.equal(fs.readFileSync(path.join(conflictWorkspace.workspacePath, "src/a.js"), "utf8"), "baseline-a\n");
} finally {
  cleanupFixture(conflict, conflictWorkspace);
}

const drift = repositoryFixture("drift");
let driftWorkspace;
try {
  driftWorkspace = prepareIntegrationWorkspace({ runsRoot: drift.runsRoot, orchestrationId: drift.orchestrationId, projectId: drift.projectId, sourceRepository: drift.repository, baseCommit: drift.baseCommit });
  fs.writeFileSync(path.join(drift.repository, "README.md"), "drift\n");
  git(drift.repository, ["add", "README.md"]);
  git(drift.repository, ["commit", "-qm", "external drift"]);
  assert.throws(
    () => applyIntegrationPatches({ workspace: driftWorkspace, patches: drift.patches, allowedPaths: ["src"] }),
    (error) => error.code === "INTEGRATION_BASELINE_DRIFT",
  );
} finally {
  cleanupFixture(drift, driftWorkspace);
}

console.log("integration-workspace.test.mjs: All tests passed!");
