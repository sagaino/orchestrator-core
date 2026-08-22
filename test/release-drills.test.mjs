import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReleaseCandidate } from "../src/release-candidate.mjs";
import { runReleaseDrill, RELEASE_DRILL_CASES } from "../src/release-drills.mjs";
import { superviseReleaseActivation } from "../src/release-supervisor.mjs";
import { performGuardedUpdate } from "../src/updater.mjs";

console.log("Running release-drills.test.mjs...");

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const operatorIdentity = "local:p63-test";

function writeFixtureSource(root, value) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "schemas"), { recursive: true });
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  for (const file of ["start.sh", "stop.sh", "README.md"]) fs.writeFileSync(path.join(root, file), `fixture:${file}\n`);
  fs.writeFileSync(path.join(root, "docs", "PHASE_6_RELEASE_CONTRACT.md"), "fixture:docs/PHASE_6_RELEASE_CONTRACT.md\n");
  fs.writeFileSync(path.join(root, "src", "index.mjs"), `export const value = ${JSON.stringify(value)};\n`);
  fs.writeFileSync(path.join(root, "schemas", "fixture.json"), "{}\n");
  fs.writeFileSync(path.join(root, "templates", "manifest.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3 }));
}

function buildFixtureCandidate(candidateRoot) {
  const candidateSource = fs.mkdtempSync(path.join(os.tmpdir(), "p63-candidate-source-"));
  writeFixtureSource(candidateSource, "candidate");
  try {
    buildReleaseCandidate({ sourceRoot: candidateSource, outputRoot: candidateRoot, releaseId: `candidate-${path.basename(candidateRoot)}`, sourceCommit, regressionResult: { status: "PASS", command: "fixture", exitCode: 0 } });
  } finally { fs.rmSync(candidateSource, { recursive: true, force: true }); }
}

function humanGate() {
  return {
    confirmed: true,
    source: "external-supervisor",
    approvedBy: operatorIdentity,
    approvedAt: "2026-08-22T00:00:00.000Z",
    operatorSessionId: "session-p63",
    actionNonceHash: "nonce-p63",
  };
}

async function runCase(caseId) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p63-${caseId}-source-`));
  const candidateRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `p63-${caseId}-candidate-`)), "candidate");
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), `p63-${caseId}-runs-`));
  writeFixtureSource(sourceRoot, "stable");
  buildFixtureCandidate(candidateRoot);
  const daemonOps = {
    stopDaemon: async () => ({ action: "STOPPED" }),
    startDaemon: async () => ({ action: "STARTED" }),
    verifyHealth: async () => ({ healthy: true, status: { running: true, healthy: true } }),
    daemonStatus: () => ({ running: false }),
  };
  let startAttempts = 0;
  if (caseId === "startup-crash") daemonOps.startDaemon = async () => {
    startAttempts += 1;
    if (startAttempts === 1) throw Object.assign(new Error("startup crash"), { code: "STARTUP_CRASH" });
    return { action: "STARTED" };
  };
  if (caseId === "missing-heartbeat") daemonOps.verifyHealth = async () => ({ healthy: false, error: "heartbeat missing" });
  if (caseId === "failed-health-probe") daemonOps.verifyHealth = async () => ({ healthy: false, error: "health probe failed" });
  if (caseId === "failed-migration") daemonOps.startDaemon = async () => {
    startAttempts += 1;
    if (startAttempts === 1) {
      fs.writeFileSync(path.join(sourceRoot, "src", "migration-partial.mjs"), "export const partial = true;\n");
      throw Object.assign(new Error("migration failed"), { code: "MIGRATION_FAILED" });
    }
    return { action: "STARTED" };
  };
  if (caseId === "corrupt-manifest") fs.writeFileSync(path.join(candidateRoot, "candidate-manifest.json"), "{corrupt\n");
  if (caseId === "incompatible-schema") {
    const manifestPath = path.join(candidateRoot, "candidate-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.vault.schemaVersion = 999;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const checksumPath = path.join(candidateRoot, "checksums.sha256");
    const manifestHash = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
    const lines = fs.readFileSync(checksumPath, "utf8").split(/\r?\n/).map((line) => line.startsWith("candidate-manifest.json") ? line : line);
    const updated = lines.map((line) => line.endsWith("  candidate-manifest.json") ? `${manifestHash}  candidate-manifest.json` : line).join("\n");
    fs.writeFileSync(checksumPath, updated);
  }
  try {
    return await runReleaseDrill({
      caseId,
      sourceRoot,
      execute: () => superviseReleaseActivation({ sourceRoot, releaseCandidateRoot: candidateRoot, runsRoot, operatorIdentity, humanGate: humanGate(), daemonOps }),
    });
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(candidateRoot), { recursive: true, force: true });
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
}

try {
  const reports = [];
  for (const definition of RELEASE_DRILL_CASES) reports.push(await runCase(definition.id));
  assert.equal(reports.length, 6);
  assert.ok(reports.every((report) => report.status === "PASS"), JSON.stringify(reports, null, 2));
  assert.ok(reports.every((report) => report.failureObserved && report.stableRestored));
  assert.ok(reports.some((report) => report.diagnostics.result?.update?.errorCode === "STARTUP_CRASH"));
  assert.ok(reports.some((report) => report.diagnostics.result?.update?.errorCode === "MIGRATION_FAILED"));
  console.log(JSON.stringify({ status: "PASS", reports }, null, 2));
} finally {
  // Each case owns and removes its temporary fixture.
}

console.log("release-drills.test.mjs: All tests passed!");
