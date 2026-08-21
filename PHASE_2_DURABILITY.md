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
