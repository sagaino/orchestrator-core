# Phase 7 — Visual QA Contract

Status: **P7.0 IMPLEMENTED — HUMAN-ACCEPTED**  
Contract version: **p7.0-2026-08-22**  
Boundary: **metadata contract only; no capture or scanner is implicit**

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
compare pixels, run an accessibility scanner, or rewrite UI code. Those actions
are explicitly deferred to the bounded P7.1–P7.3 packets.

## Evidence

- visual contract unit test covers captured and unavailable screenshots,
  checksum generation, revision metadata, and invalid payload rejection;
- API test covers authenticated create/list/detail behavior;
- dashboard types and Run Inspector expose route, viewport, comparison,
  accessibility status, revision, and artifact checksum;
- dashboard typecheck, lint, build, and five browser tests pass.
