# Phase 7 — Visual QA Contract

Status: **P7.2 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**
Contract version: **p7.2-2026-08-22**
Boundary: **bounded capture, deterministic comparison, and layout diagnostics; accessibility scanning remains deferred**

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
verified without requiring browser binaries in CI. Pixel comparison is
implemented below; accessibility scanning remains deferred to P7.3.

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
results; those remain evidence for the later P7.3 packet.

## Evidence

- visual contract unit test covers captured and unavailable screenshots,
  checksum generation, revision metadata, and invalid payload rejection;
- API test covers authenticated create/list/detail behavior;
- multi-viewport capture tests cover partial success, timeout isolation,
  artifact checksums, capture report persistence, and the capture API;
- deterministic comparison tests cover pass, pixel mismatch, unavailable
  reference, side-by-side/overlay artifacts, route/overflow/clipping findings,
  and the comparison API;
- dashboard types and Run Inspector expose route, viewport, comparison,
  accessibility status, revision, and artifact checksum;
- dashboard typecheck, lint, build, and five browser tests pass.
