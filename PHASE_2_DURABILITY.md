# Phase 2 — Runtime Durability and Exactly-Once Execution

Status: **IMPLEMENTED**

This phase implements Mandatory Safety Property 9 and the restart-related quality gates in the [AI OS MVP Scope Contract](./AI_OS_MVP_SCOPE.md).

## Runtime Model

The orchestrator remains local-first and backward-compatible with existing JSON run and job records. Durability is added through:

- atomic cross-process leases under `runs/runtime/leases/`;
- revision-guarded run manifest writes;
- serialized job and telemetry mutations;
- stable AI invocation identities under `runs/runtime/invocations/`;
- atomic job admission and project-exclusive scheduling;
- startup reconciliation before the worker pool accepts new work.

Runtime files are local operational state and are not committed to Git.

## Exactly-Once Boundary

The exactly-once guarantee applies to starting a coding-agent invocation with a stable invocation identity.

- A completed invocation can replay its recorded result without executing the provider again.
- A concurrently running invocation rejects another caller.
- An invocation whose owner disappeared before recording a final result becomes `INTERRUPTED` and is never automatically replayed.
- Recovery and review-revision agent calls use distinct, deterministic invocation identities.

This prevents silent duplicate provider calls while preserving a human-controlled recovery path for uncertain outcomes.

## Restart Recovery Matrix

| Runtime state | Restart action |
|---|---|
| `QUEUED` | Preserved and eligible for a new atomic claim. |
| `CLAIMING` + task `READY` | Claim is rolled back to `APPROVED`. |
| `CLAIMING` + task `IN_PROGRESS` | Claim is completed to `CLAIMED`. |
| `CLAIMED` | Requeued with `resumeRunId`; coding agent has not started yet. |
| `RUNNING` | Moved to `FAILED`; automatic replay is prohibited. |
| `VERIFYING` | Moved to `FAILED`; workspace and evidence are preserved for recovery. |
| `CHANGES_REQUESTED` | Moved to `FAILED`; revision agent is not replayed automatically. |
| `REVIEW` | Preserved without changing approval or acceptance state. |

Every reconciliation action is written to run history and daemon audit logs.

## Storage Decision

SQLite was evaluated for this phase but is intentionally deferred. The MVP is single-user and local-only, while the existing JSON/JSONL records already contain production history. Atomic filesystem leases and revision guards close the identified concurrency gap without a high-risk source-of-truth migration.

SQLite remains an option when multi-process query volume or runtime-state complexity exceeds the current file protocol. Such a migration must include a reversible importer and parity tests before changing the source of truth.

## Verification

`test/durability.test.mjs` launches concurrent Node.js processes and verifies:

- concurrent admission converges on one job;
- eight claimants produce one winner for a job;
- same-project jobs remain exclusive;
- distinct projects can run in parallel;
- one invocation identity produces one side effect;
- completed invocation results replay without another execution;
- uncertain invocations are blocked from automatic replay;
- concurrent manifest patches are merged through revision retry;
- restart reconciliation preserves or fails states according to the matrix above.

## Phase 2.1 — Telemetry Identity

Inferred event-log records are normalized to the same durable invocation IDs used by explicit telemetry. Status and review projections therefore count one provider invocation exactly once across implementation, retrospective, automatic recovery, and review revision stages.

## Phase 2.2 — Transactional Git Finalization

Human acceptance now commits only the verified `appliedPaths` by default and records the resulting commit hash in the run manifest.

- Existing staged or unstaged changes outside `appliedPaths` remain untouched.
- An applied path that was already dirty before execution is rejected from auto-commit.
- Sensitive paths remain denied.
- Verification, Graphify, staging, and commit failure restore the pre-apply files; failed staging is removed.
- `accept --no-commit` is available when a human intentionally wants an uncommitted result.
- `cancel-task` and `supersede-task` close abandoned BACKLOG tasks only when no job or run exists.

`test/git-finalization.test.mjs` covers clean repositories, unrelated staged work, dirty target rejection, denied secret paths, and commit-hook rollback. `test/task-lifecycle.test.mjs` covers BACKLOG cancellation and supersession guards.

## Phase 2.3 — Browser Acceptance Gate

The `test-add-project` pilot now exposes `npm run test:e2e` as a Playwright
browser acceptance check. Its project registry entry includes `test:e2e` after
`typecheck` and `build`, so an orchestrated run cannot reach review when the
protected pilot status is absent or incorrect.

- The test uses an E2E-only key and synthetic local token; it never reads a
  developer or production `.env` file.
- It verifies the protected route, visible `role=status`, `aria-live=polite`,
  pilot label, and explanatory copy in Chromium.
- A successful run writes `ai-os-pilot-ready.png` to Playwright's run artifact
  directory.
- Failures retain a screenshot and trace, and return a non-zero exit code to
  the orchestrator verification gate.

The pilot was validated with the normal expected label and with an intentional
label mismatch through `AI_OS_E2E_EXPECTED_LABEL`; the mismatch was rejected as
expected without changing application source.
