# Phase 8 — Knowledge and Long-Running Operations Contract

Status: **P8.0 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**
Contract version: **p8.0-2026-08-22**
Boundary: **durable provenance for global knowledge; project-only fast path; no automatic content merge, deletion, or contradiction resolution**

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
