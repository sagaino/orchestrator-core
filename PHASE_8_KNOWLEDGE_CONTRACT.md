# Phase 8 — Knowledge and Long-Running Operations Contract

Status: **P8.2 IMPLEMENTED — HUMAN-ACCEPTED**
Contract version: **p8.2-2026-08-22**
Boundary: **durable knowledge provenance, reversible maintenance, owned/deduplicated/snoozable operations alerts, and evidence-backed resolution; no silent admission override**

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
