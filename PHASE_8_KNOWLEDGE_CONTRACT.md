# Phase 8 — Knowledge and Long-Running Operations Contract

Status: **P8.1 IMPLEMENTED — HUMAN-ACCEPTED**
Contract version: **p8.1-2026-08-22**
Boundary: **durable provenance, deterministic duplicate/staleness review, explicit reversible merge; no automatic content deletion or silent merge**

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
