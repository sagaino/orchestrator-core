/**
 * P6.5: isolated certification of the guarded self-update protocol.
 *
 * The certification exercises the external supervisor against disposable
 * source/candidate/runtime roots. It never updates this repository's stable
 * runtime and it never converts the result into a production approval.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildReleaseCandidate, verifyReleaseCandidate } from "./release-candidate.mjs";
import { superviseReleaseActivation } from "./release-supervisor.mjs";
import { RUNTIME_SOURCE_ITEMS } from "./updater.mjs";
import { appendAuditEntry, verifyAuditChain } from "./audit-chain.mjs";

export const RELEASE_CERTIFICATION_SCHEMA_VERSION = 1;
export const RELEASE_CERTIFICATION_KIND = "personal-ai-os-guarded-self-update-certification";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256(text);
  fs.writeFileSync(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, checksum };
}

function walkFiles(root, relative = "") {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, next);
    if (entry.isSymbolicLink()) throw new Error(`Symlink tidak diizinkan dalam certification fixture: ${next}`);
    if (entry.isDirectory()) return walkFiles(root, next);
    return entry.isFile() ? [next.replaceAll(path.sep, "/")] : [];
  }).sort();
}

function snapshotRuntime(root) {
  const files = walkFiles(root).filter((file) => !["candidate-manifest.json", "checksums.sha256"].includes(file));
  const entries = files.map((file) => ({ file, sha256: sha256(fs.readFileSync(path.join(root, file))) }));
  return { fileCount: entries.length, sha256: sha256(JSON.stringify(entries)), files: entries };
}

function writeFixtureSource(root, value) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const item of RUNTIME_SOURCE_ITEMS) {
    const target = path.join(root, item);
    if (item.endsWith("/src") || item === "src") fs.mkdirSync(target, { recursive: true });
    else if (["templates", "schemas", "docs"].includes(item)) fs.mkdirSync(target, { recursive: true });
  }
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, "schemas"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.mjs"), `export const releaseValue = ${JSON.stringify(value)};\n`);
  fs.writeFileSync(path.join(root, "templates", "manifest.json"), "{}\n");
  fs.writeFileSync(path.join(root, "schemas", "fixture.json"), "{}\n");
  fs.writeFileSync(path.join(root, "docs", "release.md"), `fixture ${value}\n`);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p65-fixture", version: value === "stable" ? "1.0.0" : "1.1.0" }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "p65-fixture", lockfileVersion: 3 }));
  fs.writeFileSync(path.join(root, "README.md"), `fixture ${value}: README.md\n`);
  fs.writeFileSync(path.join(root, "docs", "PHASE_6_RELEASE_CONTRACT.md"), `fixture ${value}: docs/PHASE_6_RELEASE_CONTRACT.md\n`);
  for (const file of ["start.sh", "stop.sh"]) {
    const filePath = path.join(root, file);
    fs.writeFileSync(filePath, `#!/usr/bin/env bash\n# certification fixture: ${file}\n`);
    fs.chmodSync(filePath, 0o755);
  }
}

function humanGate(operatorIdentity, label) {
  return {
    confirmed: true,
    source: "external-supervisor",
    approvedBy: operatorIdentity,
    approvedAt: new Date().toISOString(),
    operatorSessionId: `p65-session-${label}-${randomUUID()}`,
    actionNonceHash: sha256(`p65-nonce-${label}-${randomUUID()}`),
  };
}

function separatePaths(paths) {
  return paths.every((left, index) => paths.every((right, other) => index === other || path.resolve(left) !== path.resolve(right)));
}

function certificatePath(runsRoot, now) {
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  return path.join(runsRoot, "runtime", "certifications", `phase6.5-cert-${stamp}-${randomUUID().slice(0, 8)}.json`);
}

export async function runGuardedSelfUpdateCertification({
  outputRunsRoot = null,
  runsRoot: requestedRunsRoot = null,
  now = new Date(),
  operatorIdentity = `local:${os.userInfo().username}`,
} = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p65-guarded-self-update-"));
  const sourceRoot = path.join(workspaceRoot, "stable-runtime");
  const candidateBuildRoot = path.join(workspaceRoot, "candidates");
  const successCandidateRoot = path.join(candidateBuildRoot, "success-candidate");
  const rollbackCandidateRoot = path.join(candidateBuildRoot, "rollback-candidate");
  const runsRoot = (outputRunsRoot ?? requestedRunsRoot) ? path.resolve(outputRunsRoot ?? requestedRunsRoot) : path.join(workspaceRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const daemonState = { running: false };
  const daemonOps = {
    stopDaemon: async () => { daemonState.running = false; return { action: "STOPPED" }; },
    startDaemon: async () => { daemonState.running = true; return { action: "STARTED" }; },
    daemonStatus: () => ({ running: false, pid: null }),
    verifyHealth: async () => {
      const source = fs.readFileSync(path.join(sourceRoot, "src", "index.mjs"), "utf8");
      const healthy = !source.includes("forced-rollback");
      return healthy ? { healthy: true, status: { running: true, healthy: true } } : { healthy: false, error: "forced rollback health probe" };
    },
  };

  try {
    writeFixtureSource(sourceRoot, "stable");
    const successSource = path.join(workspaceRoot, "success-source");
    writeFixtureSource(successSource, "candidate-success");
    buildReleaseCandidate({ sourceRoot: successSource, outputRoot: successCandidateRoot, releaseId: "candidate-p65-success", sourceCommit: "p65-success-source", regressionResult: { status: "PASS", command: "fixture regression", exitCode: 0 }, now });
    fs.rmSync(successSource, { recursive: true, force: true });

    const sourceBeforeSuccess = snapshotRuntime(sourceRoot);
    const successCandidateBefore = snapshotRuntime(successCandidateRoot);
    const success = await superviseReleaseActivation({ sourceRoot, releaseCandidateRoot: successCandidateRoot, runsRoot, operatorIdentity, humanGate: humanGate(operatorIdentity, "success"), daemonOps });
    const sourceAfterSuccess = snapshotRuntime(sourceRoot);
    const successCandidateAfter = snapshotRuntime(successCandidateRoot);
    const successAudit = appendAuditEntry(runsRoot, {
      event: "P65_SELF_UPDATE_SUCCEEDED",
      outcome: "ACTIVATED_IN_ISOLATED_CERTIFICATION",
      supervisorId: success.supervisorId,
      releaseId: success.candidate.releaseId,
      backupId: path.basename(success.update.backupDir),
      sourceBeforeSha256: sourceBeforeSuccess.sha256,
      sourceAfterSha256: sourceAfterSuccess.sha256,
      candidateSha256: successCandidateAfter.sha256,
    });

    const rollbackSource = path.join(workspaceRoot, "rollback-source");
    writeFixtureSource(rollbackSource, "forced-rollback");
    buildReleaseCandidate({ sourceRoot: rollbackSource, outputRoot: rollbackCandidateRoot, releaseId: "candidate-p65-rollback", sourceCommit: "p65-rollback-source", regressionResult: { status: "PASS", command: "fixture regression", exitCode: 0 }, now });
    fs.rmSync(rollbackSource, { recursive: true, force: true });
    const sourceBeforeRollback = snapshotRuntime(sourceRoot);
    const rollbackCandidateBefore = snapshotRuntime(rollbackCandidateRoot);
    const rollback = await superviseReleaseActivation({ sourceRoot, releaseCandidateRoot: rollbackCandidateRoot, runsRoot, operatorIdentity, humanGate: humanGate(operatorIdentity, "rollback"), daemonOps });
    const sourceAfterRollback = snapshotRuntime(sourceRoot);
    const rollbackCandidateAfter = snapshotRuntime(rollbackCandidateRoot);
    const rollbackAudit = appendAuditEntry(runsRoot, {
      event: "P65_SELF_UPDATE_ROLLED_BACK",
      outcome: "FORCED_HEALTH_FAILURE_RESTORED_STABLE",
      supervisorId: rollback.supervisorId,
      releaseId: rollback.candidate.releaseId,
      backupId: path.basename(rollback.update.backupDir),
      sourceBeforeSha256: sourceBeforeRollback.sha256,
      sourceAfterSha256: sourceAfterRollback.sha256,
      candidateSha256: rollbackCandidateAfter.sha256,
      rollbackErrorCode: rollback.update.errorCode ?? null,
    });

    const audit = verifyAuditChain(runsRoot);
    const checks = {
      successfulActivation: success.update.success === true && success.update.rolledBack === false && sourceAfterSuccess.sha256 !== sourceBeforeSuccess.sha256,
      forcedRollback: rollback.update.success === false && rollback.update.rolledBack === true && sourceAfterRollback.sha256 === sourceBeforeRollback.sha256,
      stableRestoredAfterRollback: sourceAfterRollback.sha256 === sourceBeforeRollback.sha256,
      successCandidateChecksumStable: successCandidateBefore.sha256 === successCandidateAfter.sha256,
      rollbackCandidateChecksumStable: rollbackCandidateBefore.sha256 === rollbackCandidateAfter.sha256,
      candidateIntegrity: verifyReleaseCandidate(successCandidateRoot).valid && verifyReleaseCandidate(rollbackCandidateRoot).valid,
      sourceCandidateSupervisorSeparated: separatePaths([sourceRoot, successCandidateRoot, rollbackCandidateRoot]) && success.humanGate.source === "external-supervisor" && rollback.humanGate.source === "external-supervisor",
      auditReconstructsBothOutcomes: audit.valid && successAudit.event === "P65_SELF_UPDATE_SUCCEEDED" && rollbackAudit.event === "P65_SELF_UPDATE_ROLLED_BACK",
    };
    const passed = Object.values(checks).every(Boolean);
    const certificate = {
      schemaVersion: RELEASE_CERTIFICATION_SCHEMA_VERSION,
      kind: RELEASE_CERTIFICATION_KIND,
      certificationId: `phase6.5-cert-${randomUUID()}`,
      createdAt: now.toISOString(),
      status: passed ? "CERTIFIED_HUMAN_GATE_REQUIRED" : "FAILED",
      humanGate: { required: true, approved: false, authority: "EXTERNAL_SUPERVISOR", note: "Certification evidence does not approve production activation." },
      checks,
      outcomes: {
        successfulActivation: { supervisorId: success.supervisorId, releaseId: success.candidate.releaseId, backupId: path.basename(success.update.backupDir), sourceBeforeSha256: sourceBeforeSuccess.sha256, sourceAfterSha256: sourceAfterSuccess.sha256, sourceBeforeFiles: sourceBeforeSuccess.files, sourceAfterFiles: sourceAfterSuccess.files, candidateSha256: successCandidateAfter.sha256, candidateFiles: successCandidateAfter.files },
        forcedRollback: { supervisorId: rollback.supervisorId, releaseId: rollback.candidate.releaseId, backupId: path.basename(rollback.update.backupDir), error: rollback.update.error, sourceBeforeSha256: sourceBeforeRollback.sha256, sourceAfterSha256: sourceAfterRollback.sha256, sourceBeforeFiles: sourceBeforeRollback.files, sourceAfterFiles: sourceAfterRollback.files, candidateSha256: rollbackCandidateAfter.sha256, candidateFiles: rollbackCandidateAfter.files },
      },
      separation: { sourceRoot, stableRuntime: sourceRoot, successCandidateRoot, rollbackCandidateRoot, supervisorAuthority: "external-supervisor" },
      audit: { ...audit, successAuditId: successAudit.auditId, rollbackAuditId: rollbackAudit.auditId },
      nextAction: "Human gate tetap diperlukan sebelum kandidat production apa pun diaktifkan.",
    };
    const persisted = writePrivateJson(certificatePath(runsRoot, now), certificate);
    return { ...certificate, bundlePath: persisted.filePath, checksum: persisted.checksum };
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function cli() {
  const outputRunsRoot = process.env.ORCHESTRATOR_RUNS ?? path.join(process.cwd(), "runs");
  const report = await runGuardedSelfUpdateCertification({ outputRunsRoot });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "CERTIFIED_HUMAN_GATE_REQUIRED") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
