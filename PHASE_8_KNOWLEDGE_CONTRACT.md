# Phase 8 — Knowledge and Long-Running Operations Contract

Status: **P8.3 IMPLEMENTED — HUMAN-ACCEPTED**
Contract version: **p8.3-2026-08-22**
Boundary: **durable knowledge provenance, reversible maintenance, owned/deduplicated/snoozable operations alerts, evidence-backed resolution, and review-only backup operations; no silent admission override, automatic restore/promotion, or permanent delete**

## P8.0 Knowledge Provenance and Quality Contract

Global knowledge pages created or updated through Wiki Sync carry a versioned
provenance set:

- `provenance_schema`;
- `orchestrator_run` and non-empty `sources`;
- bounded numeric `confidence` from 0 to 1;
- accountable `owner`;
- ISO `review_by` date;
- `supersession` state: `ACTIVE`, `SUPERSEDED`, or `RETIRED`.

`src/knowledge-provenance.mjs` is the shared validator and renderer. New Wiki
pages receive the complete contract, while legacy pages are reported by
`knowledge-health` as explicit `PROVENANCE` warnings for directed migration.
Malformed fields are errors. `PROJECT_ONLY` retrospectives remain on the task
and do not require global knowledge provenance.

The schema is recorded at
`schemas/knowledge-provenance.schema.json`. Candidate templates expose the
same fields so promotion does not lose provenance. No safe-fix path rewrites
existing knowledge content automatically.

## Evidence

- provenance unit tests cover valid and invalid metadata, review-date
  calculation, project-only bypass, and legacy/malformed health findings;
- smoke coverage verifies newly promoted Wiki pages contain the complete
  provenance set;
- full backend test suite and smoke test pass.

## P8.1 Duplicate, Merge, and Staleness Workflow

`src/knowledge-quality.mjs` exposes deterministic duplicate candidates using
normalized title and bounded token similarity. Exact-title duplicates are
reported separately from near-duplicates, and potential polarity conflicts are
flagged for human review.

`src/knowledge-maintenance.mjs` provides:

- a read-only maintenance report and stale review queue based on `review_by`;
- an explicit merge preview with source/target checksums and proposed content;
- human-confirmed merge apply that retains the source as `SUPERSEDED`;
- an immutable merge artifact containing before/after snapshots and a reversible
  index update; revert refuses to overwrite concurrent changes.

The CLI and API expose the same read-only, preview, apply, and revert actions.
The Knowledge Center shows duplicate candidates, stale review items, and the
merge preview confirmation flow. No merge path deletes a source page.

## P8.1 Evidence

- `test/knowledge-maintenance.test.mjs` covers deterministic duplicate/stale
  detection, preview read-only behavior, confirmation gating, checksum guards,
  source retention, reversible index updates, and exact rollback;
- backend full suite and smoke test pass;
- dashboard typecheck, lint, and production build pass;
- Graphify updated both repositories after implementation.

## P8.2 Alert Ownership and Runbooks

Operations alerts now use a durable schema-versioned lifecycle store. An
acknowledgement records the accountable owner, owner role, deduplication key and
window, optional snooze expiry, operator note, and the acknowledgement time.
Repeated observations with the same alert and dedupe key inside the configured
window are returned as deduplicated and do not create duplicate history rows.

Each alert exposes a bounded runbook step list. Resolution is a separate,
explicit action requiring an identified operator and evidence (summary,
reference, path, or run ID). Resolution evidence is retained alongside the
acknowledgement history; it never opens admission or suppresses a still-failing
readiness check. Snooze and acknowledgement likewise never change admission.

The Operations Center UI exposes ownership, snooze, runbook steps, and evidence
capture for resolution. API and CLI callers share the same durable contract.

## P8.2 Evidence

- `test/operations-alerts.test.mjs` covers owner persistence, snooze bounds,
  deduplication, resolution evidence, runbook metadata, and admission safety;
- `test/operations-alerts-api.test.mjs` covers authenticated acknowledge,
  resolve, and resolution history routes;
- existing operations governance/API suites remain green;
- dashboard typecheck, lint, build, security, and browser gates remain green.

## P8.3 Backup Rotation and Recovery Review

Backup operations now expose a read-only status contract for the registered
backup and its independent target, a launchd-compatible schedule preview, an
explicit-confirmation install that writes a reviewable plist without calling
`launchctl`, and a rotation preview that never moves or deletes backup data.
The scheduler performs only the quiescent backup, verification, and status
registration sequence. Restore, promotion, retention purge, and permanent
delete remain outside the scheduler and require separate operator action.

Registered backup verification can be rerun without changing the target. A
durable recovery-drill record stores operator identity, evidence, result, RTO,
and due date. Missing, failed, or overdue drills surface as Operations alerts;
they do not silently open admission. Independent-target status is also surfaced
as a readiness check, with unknown or non-independent targets unable to pass.

## P8.3 Evidence

- `test/backup-operations.test.mjs` covers independent-target inference,
  launchd preview/install guardrails, rotation preview, registered verification,
  recovery-drill overdue state, and readiness checks;
- `test/backup-operations-api.test.mjs` covers authenticated status, schedule
  preview, and recovery-drill recording routes;
- backend disaster-recovery, operations governance, and operations API suites
  remain green;
- dashboard typecheck, lint, build, security, and browser gates remain green.

## P8.4 Soak and Capacity Harness

`src/soak-capacity-harness.mjs` provides a deterministic virtual-time harness
for one-to-72-hour windows, bounded synthetic queue admission, restart points,
authenticated API request load, bounded SSE clients, artifact-growth tracking,
and Operations alert collection. Synthetic jobs are admitted but never
executed, so a passing soak cannot silently approve work or invoke a provider.

Each run emits explicit invariant evidence for duplicate admission/invocation,
lost persisted state across restart, silent approval, bounded client/output
growth, and recoverable runtime state. The harness is isolated by default and
accepts an explicit fixture root when durable report evidence is required.
Response and artifact caps are validated before a run can pass.

## P8.4 Evidence

- `test/soak-capacity-harness.test.mjs` covers virtual-time workload, restart
  reconstruction, API/SSE load, bounded output, alert collection, and all
  safety invariants;
- CLI `soak-harness` exposes bounded duration/capacity controls and returns a
  machine-readable report with no provider invocation or automatic approval;
- backend full suite and smoke test remain the release gate.
