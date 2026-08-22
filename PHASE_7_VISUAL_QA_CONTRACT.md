# Phase 7 — Visual QA Contract

Status: **P7.4 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**
Contract version: **p7.4-2026-08-22**
Boundary: **bounded capture, deterministic comparison, layout diagnostics, accessibility evidence, and visual feedback revision linkage; no source rewrite**

## P7.0 Visual Evidence Contract

`src/visual-evidence.mjs` defines a versioned `visual-evidence` DTO with:

- route and named viewport dimensions;
- reference metadata and checksum;
- actual screenshot status and capture path;
- comparison status, method, score, mismatch count, and notes;
- accessibility status and structured findings;
- revision number, reviewer, and reason;
- artifact path, existence, byte count, content type, and SHA-256 checksum.

Evidence is persisted under `runs/runtime/visual-evidence/<runId>/` with a
private JSON bundle and a sidecar checksum. Invalid or tampered evidence is
not returned by the list API, and detail reads fail closed.

API surface:

- `GET /api/runs/:id/visual-evidence`
- `GET /api/runs/:id/visual-evidence/:evidenceId`
- `POST /api/runs/:id/visual-evidence`

The POST endpoint records metadata only. It does not capture screenshots,
compare pixels, run an accessibility scanner, or rewrite UI code.

## P7.1 Multi-Viewport Capture

`src/visual-qa.mjs` adds a bounded capture job for the canonical desktop,
tablet, and mobile viewports (1440×900, 1024×768, and 390×844). Each viewport
produces its own screenshot artifact and versioned visual-evidence record. A
failed or timed-out viewport is recorded as `FAIL`/`UNAVAILABLE` without
discarding successful siblings; the job is `PASS` only when every requested
viewport succeeds.

Capture reports are persisted under
`runs/runtime/visual-evidence/<runId>/capture-jobs/` with a sidecar checksum.
The capture endpoint resolves the active run-owned dev server when `baseUrl`
is omitted; it fails closed when that server is not running.
The API surface is:

- `POST /api/runs/:id/visual-evidence/capture`
- `GET /api/runs/:id/visual-evidence/captures`

The default runner uses headless Playwright and closes the browser in a
`finally` path. Tests inject a deterministic capture fixture so timeout,
partial-success, artifact checksum, and report persistence behavior can be
verified without requiring browser binaries in CI. Pixel comparison and
accessibility evidence are implemented below.

## P7.2 Comparison and Layout Diagnostics

`src/visual-comparison.mjs` provides deterministic 8-bit PNG comparison with
configurable per-channel threshold and mismatch ratio. When a reference is
available, each capture records `PASS` or `FAIL`, mismatch count and score,
and persists side-by-side and 50/50 overlay PNG artifacts. A missing or
checksum-invalid reference remains explicit `UNKNOWN` rather than becoming a
false pass.

The Playwright capture also records bounded diagnostics for missing target
routes, horizontal overflow, clipped fixed/sticky elements, and screenshot
dimension mismatch against the requested viewport. These findings are folded
into the comparison evidence and surfaced by the Runs inspector. Existing
evidence can be re-compared through:

- `POST /api/runs/:id/visual-evidence/:evidenceId/compare`

Comparison never rewrites source code and does not infer accessibility
results; accessibility findings are recorded separately below.

## P7.3 Accessibility Evidence

`src/visual-accessibility.mjs` runs a bounded, dependency-free audit during
each Playwright capture. It checks interactive accessible names, image alt
text, focusability, heading order, contrast when computed colors are
available, and a bounded Tab flow. Findings are structured evidence with
`ERROR`, `WARN`, or `INFO` severity; they do not rewrite source code and do
not block execution automatically.

The persisted evidence includes the audit schema version, status, findings,
bounded check counts, and explicit unavailable states. Existing evidence can
be re-audited through:

- `POST /api/runs/:id/visual-evidence/:evidenceId/accessibility`

The endpoint requires an explicit HTTP(S) `baseUrl` for the run-owned preview
and fails closed when the target cannot be reached within the timeout.

## P7.4 Visual Feedback Revision Loop

`src/visual-revision.mjs` persists each request-changes iteration as a durable,
checksum-backed revision record. Structured region annotations and inline file
comments are normalized and stored with the review iteration. The record keeps
the evidence IDs visible before the revision (`beforeEvidenceIds`) and is
completed only when later capture evidence is linked as
`afterEvidenceIds`; invalid or unknown evidence IDs are ignored.

The request-changes workflow and the Runs inspector use the same revision
record, so feedback remains inspectable after a restart and can be correlated
with the run manifest lifecycle. The API surface is:

- `GET /api/runs/:id/visual-revisions`
- `GET /api/runs/:id/visual-revisions/:iteration`
- `POST /api/runs/:id/visual-revisions/:iteration/complete`

Viewport capture accepts the revision iteration and automatically links its
evidence as the after-state when the revision exists. The explicit completion
endpoint supports recovery when capture and revision persistence occur in a
different order. This loop records evidence and feedback; it never rewrites
source code or silently auto-accepts a run.

## Evidence

- visual contract unit test covers captured and unavailable screenshots,
  checksum generation, revision metadata, and invalid payload rejection;
- API test covers authenticated create/list/detail behavior;
- multi-viewport capture tests cover partial success, timeout isolation,
  artifact checksums, capture report persistence, and the capture API;
- deterministic comparison tests cover pass, pixel mismatch, unavailable
  reference, side-by-side/overlay artifacts, route/overflow/clipping findings,
  and the comparison API;
- accessibility tests cover passing and failing deterministic snapshots,
  bounded finding limits, capture persistence, and the audit API;
- visual revision tests cover annotation/comment normalization, before/after
  evidence filtering, durable persistence, restart reads, and capture linking;
- dashboard types and Run Inspector expose route, viewport, comparison,
  accessibility status, revision, before/after evidence counts, and artifact
  checksum;
- dashboard typecheck, lint, build, and five browser tests pass.
