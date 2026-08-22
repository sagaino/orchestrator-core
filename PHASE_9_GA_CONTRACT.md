# Phase 9 — v1.0 GA Certification Contract

Status: **P9.0–P9.1 HUMAN-ACCEPTED; P9.2 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**
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
- P9.1 migration/upgrade matrix is implemented below; both P9.0 and P9.1 have
  now passed their separate human acceptance gates.

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
`p9.1-report.json`; the report was reviewed as part of the human acceptance
gate.

CLI:

- `migration-matrix` runs the isolated matrix and writes
  `runs/runtime/migration-matrix/p9.1-report.json` plus its checksum;
- `test:migration-matrix` verifies the matrix, backup requirement, rejection,
  rollback, replay, report checksum, and tamper detection.

P9.1 exit gate: all matrix cases PASS, migrations are versioned and repeatable,
backup evidence is verified, incompatible input is rejected before mutation,
and failed/interrupted work remains fail-closed. P9.1 is human-accepted;
production migration or v1.0 activation remains a separate operational gate.

## P9.2 Final Pilot Cohort

The final pilot harness creates three clean, registered project fixtures and
executes ten bounded task manifests. The cohort includes code and UI changes,
executor restart recovery, request-changes followed by acceptance, explicit
rejection without mutation, rollback after failed apply, and CREATE/UPDATE
knowledge decisions. Applied runs require explicit human approval, authorized
scope, passing verification, applied-workspace evidence, and complete run
evidence. Rejected and failed runs must remain unapplied or have verified
rollback evidence.

The harness also checks invocation uniqueness, scans the isolated fixture for
private-key/API-key/secret/password patterns, and records the registered
project roots and task evidence. It emits a checksummed report while leaving
`humanGate.confirmed=false`; no provider invocation, production mutation, or
automatic acceptance is performed.

CLI:

- `pilot-cohort` runs the isolated cohort and writes
  `runs/runtime/pilot-cohort/p9.2-report.json` plus its checksum;
- `test:pilot-cohort` verifies task/project minimums, scope authorization,
  evidence completeness, duplicate invocation, secret scanning, safe failure,
  and report tamper detection.

P9.2 exit gate: ten tasks across three projects PASS all checks above. Human
acceptance is required before this cohort is used as GA certification evidence.
