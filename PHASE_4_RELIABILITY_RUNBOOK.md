# Phase 4.3 Reliability and Failure-Injection Runbook

Status: **IMPLEMENTED — RELIABILITY GATE PASSED**  
Certified: **2026-08-22 (Asia/Jakarta)**  
Command: `npm run test:reliability`

## Race Root Cause and Repair

The intermittent duplicate-admission finding was traced to the lease creation
window. `open(..., "wx")` made the lease filename visible before its JSON body
was completely written. A competing process could read an empty/partial file,
classify it as stale, unlink the live lease, and enter the same admission
critical section.

Lease acquisition now treats an existing unreadable or incomplete record as
held/corrupt and fails closed. It never reclaims such a record automatically.
Lease contents are flushed before acquisition returns, and stale reclamation
requires the same valid lease ID on two reads.

Certification ran 25 rounds with eight OS processes per admission race and two
OS processes per manifest race:

- 200 admission callers;
- exactly 25 created jobs and 25 durable job IDs;
- zero duplicate admission;
- 50 concurrent manifest mutations;
- zero lost execution patches or history entries.

The regular unit suite retains five race rounds so every normal regression run
continues to exercise the boundary.

## Deterministic Fault Points

Fault injection is an in-process test API only. It is not exposed through the
CLI, HTTP API, environment, or dashboard. Each configured fault has a bounded
remaining count and is cleared after its test.

| Boundary | Injected failure | Required safe terminal state |
|---|---|---|
| lease creation | empty/partial lease | acquisition fails closed; live/corrupt lease is not deleted |
| queue admission | `ENOSPC` before create | no partial job; admission lease released; explicit retry creates one job |
| queue rename | `EACCES` before rename | previous job remains valid and queued; temp file removed |
| manifest rename | `ENOSPC` before rename | prior revision remains readable; no partial patch/history; retry succeeds |
| invocation ledger | `EIO` before result rename | ledger becomes `FAILED`; completed side effect is never automatically replayed |
| process execution | real `SIGKILL` | dead-owner invocation becomes `INTERRUPTED`; execution remains blocked pending review |
| process deadline | parent and descendant run past limit | process group receives TERM/KILL; no delayed descendant write occurs |
| output flood | output exceeds profile ceiling | process group terminates with `terminatedReason=output_limit`; retained tail stays bounded |
| workspace apply | injected fault after source copy | backup restores source, Git HEAD/index remain unchanged, review worktree remains |
| Git commit | failing pre-commit hook | applied paths and staging roll back; unrelated user work remains |
| cleanup | injected fault before worktree removal | worktree and archived evidence remain; cleanup retry succeeds |
| Git conflict | source changed after task baseline | apply is rejected before mutation |
| corrupt/restart state | dead owner during active lifecycle | safe pre-agent work requeues; uncertain execution fails for manual review; review remains review |
| provider/verification interruption | bounded deterministic retry and AI repair | retry count remains bounded; exhaustion ends in `FAILED`, never silent acceptance |

## Process Termination Contract

Orchestrated child processes start in a dedicated process group. Deadline and
output-limit enforcement signal the group, then escalate from `SIGTERM` to
`SIGKILL` after two seconds. The result records `deadline` or `output_limit` so
restart evidence can distinguish policy termination from an ordinary tool exit.

Capability-profile deadlines remain:

- agent: 35 minutes;
- verification: 15 minutes;
- Graphify: 10 minutes;
- updater: 5 minutes;
- preview: 30 seconds.

Automatic recovery remains bounded to zero through three AI repair attempts,
with one deterministic retry before AI repair. Durable invocation identity
prevents retries from repeating an uncertain provider side effect.

## Operator Procedure

Run the certification stress suite:

```sh
npm run test:reliability
```

Then run the complete regression:

```sh
npm test
```

If a fault leaves `FAILED` or `INTERRUPTED` evidence, inspect the run and
invocation ledger. Use explicit `recover` only for safe verification or
infrastructure continuation; use `retry --force` when repeating agent execution
is intentionally approved. Never delete a corrupt lease merely to resume work;
quarantine and inspect it first.
