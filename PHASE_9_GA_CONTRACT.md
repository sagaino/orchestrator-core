# Phase 9 — v1.0 GA Certification Contract

Status: **P9.0–P9.1 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**
Contract version: **p9.1-2026-08-22**
Boundary: **reproducible local-first release packaging, installation, upgrade, recovery, documentation, and final human-gated v1.0 certification**

## P9.0 Release Manifest and Installation Contract

The release-manifest module creates a versioned, checksum-backed release
manifest. It records supported macOS architectures and Node major versions,
backend/dashboard versions, package-lock checksums, absolute Vault/runtime/
backup roots, dependency installation policy, start and health commands,
uninstall behavior, and the external rollback sequence.

The contract preserves data roots during uninstall by default. Purging data
requires a separate explicit confirmation and is not part of manifest
generation. Rollback restores into quarantine and requires health checks plus
human promotion; the manifest cannot activate a release or approve itself.

CLI:

- release-manifest writes runs/runtime/release-manifest/v<version>.json;
- release-manifest-verify <absolute-manifest-path> checks the checksum,
  supported host, absolute roots, lockfiles, and launcher presence.

## P9.0 Evidence

- test/release-manifest.test.mjs covers manifest creation, absolute-root
  guardrails, uninstall preservation, lockfile drift detection, and checksum
  verification;
- backend full suite and smoke test remain the release gate;
- P9.1 migration/upgrade matrix is implemented below; human acceptance remains
  separate from automated evidence.

## P9.1 Migration and Upgrade Matrix

The migration-upgrade module defines a versioned matrix and a fail-closed
execution state machine. Every data-changing upgrade requires a verified,
independent disaster-recovery backup before checkpointing. A migration writes
durable `CHECKPOINTED`, `IN_PROGRESS`, `COMPLETED`, `REJECTED`, or
`ROLLED_BACK` state and cannot promote a release or clear recovery quarantine.

The certification harness covers clean install, Phase 4 → v1.0 migration,
restore-then-upgrade while preserving `executionBlocked`, future/incompatible
schema rejection, interrupted migration rollback, failed-step rollback, and
repeatable replay. It runs in an isolated fixture and emits a checksummed
`p9.1-report.json`; the report remains human-gated.

CLI:

- `migration-matrix` runs the isolated matrix and writes
  `runs/runtime/migration-matrix/p9.1-report.json` plus its checksum;
- `test:migration-matrix` verifies the matrix, backup requirement, rejection,
  rollback, replay, report checksum, and tamper detection.

P9.1 exit gate: all matrix cases PASS, migrations are versioned and repeatable,
backup evidence is verified, incompatible input is rejected before mutation,
and failed/interrupted work remains fail-closed. Human acceptance is required
before production migration or v1.0 activation.
