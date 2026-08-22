/**
 * P6.4: stable, read-only DTO for the Release Operations dashboard.
 *
 * This module deliberately has no activation authority. It only assembles
 * evidence from the current runtime, an explicitly configured candidate, the
 * drain inspector, and the durable backup records.
 */

import fs from "node:fs";
import path from "node:path";
import { assessReleaseCompatibility } from "./release-contract.mjs";
import { verifyReleaseCandidate } from "./release-candidate.mjs";
import { inspectReleaseDrain } from "./release-supervisor.mjs";
import { daemonStatus } from "./daemon.mjs";
import { readBackupStatus } from "./operations-governance.mjs";
import { runtimeBackupsRoot } from "./updater.mjs";

export const RELEASE_OPERATIONS_SCHEMA_VERSION = 1;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function currentVersion(sourceRoot) {
  const packageJson = readJson(path.join(sourceRoot, "package.json"));
  return typeof packageJson?.version === "string" ? packageJson.version : "unknown";
}

function latestRuntimeBackup(runsRoot) {
  const root = runtimeBackupsRoot(runsRoot);
  if (!fs.existsSync(root)) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const backupDir = path.join(root, entry.name);
      const manifest = readJson(path.join(backupDir, "backup-manifest.json"));
      return manifest?.backupId ? {
        backupId: manifest.backupId,
        backedUpAt: manifest.backedUpAt ?? null,
        filesCount: manifest.filesCount ?? null,
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => String(right.backedUpAt ?? "").localeCompare(String(left.backedUpAt ?? "")));
  return entries[0] ?? null;
}

function candidateEvidence(candidateRoot) {
  if (!candidateRoot) return {
    configured: false,
    available: false,
    status: "NOT_CONFIGURED",
    releaseId: null,
    runtimeVersion: null,
    sourceCommit: null,
    builtAt: null,
    compatibility: { compatible: false, outcome: "NO_CANDIDATE", errors: [] },
  };

  try {
    const verified = verifyReleaseCandidate(candidateRoot);
    const manifest = verified.manifest;
    const compatibility = assessReleaseCompatibility(manifest);
    return {
      configured: true,
      available: true,
      status: "VERIFIED",
      releaseId: manifest.releaseId,
      runtimeVersion: manifest.runtime?.version ?? null,
      sourceCommit: manifest.provenance?.sourceCommit ?? null,
      builtAt: manifest.provenance?.builtAt ?? null,
      fileCount: verified.files.length,
      compatibility,
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      status: "REJECTED",
      releaseId: null,
      runtimeVersion: null,
      sourceCommit: null,
      builtAt: null,
      compatibility: { compatible: false, outcome: "REJECT_BEFORE_ACTIVATION", errors: [error.message] },
    };
  }
}

export function getReleaseOperations({
  sourceRoot = process.cwd(),
  releaseCandidateRoot = process.env.ORCHESTRATOR_RELEASE_CANDIDATE_ROOT ?? null,
  runsRoot,
  now = new Date(),
  drainInspector = inspectReleaseDrain,
  daemonStatusFn = daemonStatus,
} = {}) {
  if (!runsRoot) throw new Error("runsRoot is required.");
  const checkedAt = now.toISOString();
  const candidate = candidateEvidence(releaseCandidateRoot);
  const drain = drainInspector({ runsRoot, daemonStatusFn });
  const daemon = daemonStatusFn({ runsRoot });
  const verifiedBackup = readBackupStatus(runsRoot);
  const latestBackup = latestRuntimeBackup(runsRoot);
  const backup = verifiedBackup ?? latestBackup;
  const compatibility = candidate.compatibility;
  const eligible = Boolean(candidate.available && compatibility.compatible && drain.drained && backup);

  return {
    schemaVersion: RELEASE_OPERATIONS_SCHEMA_VERSION,
    checkedAt,
    current: { runtimeVersion: currentVersion(sourceRoot) },
    candidate,
    queueDrain: {
      drained: drain.drained,
      blockers: drain.blockers,
      counts: drain.counts,
      pending: drain.pending,
      activation: drain.activation,
      daemon: drain.daemon,
    },
    compatibility: {
      outcome: compatibility.outcome,
      compatible: compatibility.compatible,
      errors: compatibility.errors,
      contractVersion: compatibility.contractVersion ?? null,
    },
    backup: {
      required: true,
      status: backup ? "AVAILABLE" : "MISSING",
      backupId: backup?.backupId ?? null,
      verifiedAt: verifiedBackup?.verifiedAt ?? null,
      backedUpAt: backup?.backedUpAt ?? backup?.completedAt ?? backup?.createdAt ?? null,
      filesCount: backup?.filesCount ?? verifiedBackup?.fileCount ?? null,
    },
    health: {
      status: daemon.running && daemon.healthy ? "PASS" : "WARN",
      daemon: {
        running: Boolean(daemon.running),
        healthy: Boolean(daemon.healthy),
        heartbeatAt: daemon.heartbeatAt ?? null,
        heartbeatAgeMs: daemon.heartbeatAgeMs ?? null,
      },
      checks: [
        { id: "daemon", status: daemon.running && daemon.healthy ? "PASS" : "WARN", message: daemon.running && daemon.healthy ? "Daemon healthy." : "Daemon belum sehat atau berhenti." },
      ],
    },
    rollback: {
      required: true,
      protocolVersion: 1,
      evidenceStatus: backup ? "READY" : "MISSING",
      backupId: backup?.backupId ?? null,
      message: backup ? "Backup tersedia untuk rollback eksternal." : "Aktivasi tetap diblokir sampai backup tersedia.",
    },
    activation: {
      eligible,
      state: eligible ? "HUMAN_GATE_REQUIRED" : "BLOCKED",
      requiresHumanConfirmation: true,
      authority: "EXTERNAL_SUPERVISOR",
      selfAcceptAllowed: false,
      inProcessActivationAllowed: false,
      confirmation: { confirmed: false, approvedBy: null, approvedAt: null },
    },
  };
}
