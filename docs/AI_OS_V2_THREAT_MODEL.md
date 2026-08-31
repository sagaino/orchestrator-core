# Personal AI OS v2 — Threat Model

Status: **ACCEPTED FOR CONTROLLED LOCAL ROLLOUT**  
Implementation status: **IMPLEMENTED** (Core phases 1-7; optional Telegram deferred)  
Acceptance status: **ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT**  
Default activation: **DISABLED** (`LOCAL_SAFE` default-off)  
Source plan: [AI OS v2 Orchestration Implementation Plan](./AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md)

## 1. Security objective

The v2 orchestrator must increase coordination without increasing the
authority of any model, connector, or sub-agent. Human approval remains the
trust anchor for planning, execution scope, repository mutation, integration,
and delivery.

## 2. Trust boundaries

| Boundary | Trusted authority | Untrusted or constrained side | Required control |
|---|---|---|---|
| Local operator ↔ dashboard/API | Authenticated local operator session | Browser input and requests | Local binding, authentication, body limits, idempotency, audit, DTO validation |
| Orchestrator ↔ model provider | Orchestrator contracts and validators | Model output, prose, tool suggestions | Read-only planning mode, strict JSON parsing, deterministic validation, fail-closed routing |
| Orchestrator ↔ sub-agent | Orchestrator executor and run manager | Agent prompt/output and code changes | One task/role/worktree, allowed paths, frozen verification, no lifecycle mutation |
| Runtime ↔ filesystem | Validated stores and lease owner | Corrupt, stale, partial, or tampered state | Atomic writes, revision checks, permissions, redaction, corruption surfaced |
| Worktree ↔ main repository | Human acceptance workflow | Agent-produced patches and integration conflicts | Isolated worktrees, baseline freeze, scope audit, transactional apply, rollback |
| Project ↔ linked project | Explicit relationship registry | Unregistered or unrelated repository | Both projects registered, typed relationship, contract verification, no implied write access |
| Orchestrator ↔ Telegram | Verified connector boundary | Remote messages, replay, delivery failures | Secret references, identity binding, replay protection, rate limits, notification-only first |
| Orchestrator ↔ skills | Human-managed registry | Skill metadata/instructions/checksums | Installed/enabled/checksum-valid only; agents cannot install or mutate skills |

## 3. Primary threats and mitigations

| ID | Threat | Impact | Mitigation | Residual decision |
|---|---|---|---|---|
| V2-T01 | Model fabricates approval or human identity | Unauthorized execution or acceptance | Approval fields are populated only by authenticated human endpoints; model output cannot contain authority fields | Human gate required |
| V2-T02 | Plan expands paths, tools, budget, or concurrency | Unsafe repository changes or resource exhaustion | Deterministic plan validator, approved fingerprint, subset checks, budget ceilings, feature flags off | Human gate required |
| V2-T03 | Invalid DAG releases work early | Incorrect or unsafe execution order | Cycle/missing-reference validation and persisted predecessor reconciliation; release only after `DONE` | Low after tests |
| V2-T04 | Duplicate or uncertain provider invocation after restart | Duplicate changes or inconsistent state | Durable job/run evidence, failed-safe uncertain work, no replay without reconciliation, idempotency keys | Human gate required |
| V2-T05 | Agent escapes its allowed scope | Unauthorized files or secrets modified | Isolated worktree, normalized safe paths, executor scope checks, denied-path tests | Low after tests |
| V2-T06 | Concurrent agents create a write conflict | Lost changes or semantic corruption | Project leases, conflict groups, path-overlap detection, same-project parallel flag off, integration conflict stop | Human gate required |
| V2-T07 | Source repository drifts during integration | Apply overwrites external work | Frozen baseline comparison before apply; drift stops and requires re-plan/rebase review | Human gate required |
| V2-T08 | Cross-project relationship grants unintended access | Unauthorized repository mutation | Relationship is metadata only; each node retains its own project and path scope; per-repository acceptance | Low after tests |
| V2-T09 | Telegram message is forged or replayed | Unauthorized command or approval | Verified local identity binding, one-time confirmation policy, replay protection, bounded commands, local-only privileged actions | Human gate required |
| V2-T10 | Secrets leak into prompts, plans, events, or messages | Credential compromise | Secret references only, redaction before persistence, no raw tokens in artifacts, bounded context | Human gate required |
| V2-T11 | Skill is malicious, incompatible, or silently installed | Scope bypass or arbitrary tool use | Human-managed registry, checksum/version validation, compatibility checks, no agent installation, fallback to general role | Human gate required |
| V2-T12 | Runtime state is corrupted or partially written | Lost orchestration or unsafe recovery | Atomic temp-write/rename, validation before read/write, revision and lease guards, corruption blocks execution | Low after tests |
| V2-T13 | Budget or concurrency is bypassed | Resource exhaustion and runaway execution | Admission checks before scheduling, persisted usage, ceilings, blocker decision, no tier downgrade | Human gate required |
| V2-T14 | Agent marks verification or integration successful without evidence | False completion | Orchestrator owns state transitions; evidence must name run, paths, checks, baselines, and acceptance | Low after tests |

## 4. High-risk actions requiring local human confirmation

- Fresh Project creation or retry after onboarding uncertainty.
- Plan approval and every plan revision.
- Scope expansion, high-risk changes, and node retry.
- Aggregate or per-repository integration acceptance.
- Cross-project apply and final objective acceptance.
- Feature activation for parallel execution, cross-project mode, Telegram,
  and Skill Router.
- Skill installation, update, enablement, disablement, or replacement.

## 5. Security invariants for implementation

1. Unknown feature-flag values are disabled.
2. Unknown schema versions fail closed.
3. No raw secret is persisted or sent through a connector.
4. No dependency is released unless every predecessor is durably `DONE`.
5. No main repository mutation occurs before its acceptance gate.
6. No concurrent nodes with overlapping predicted writes are admitted.
7. No external message can create local human identity.
8. No agent or skill can broaden its assigned permission set.
9. Uncertain work is never silently converted to `DONE` or replayed.
10. Any violation blocks the affected objective and creates an auditable
    decision; it does not self-heal by widening authority.

## 6. Acceptance and review cadence
 
The threat model is reviewed at each phase gate and whenever a new connector,
filesystem boundary, model capability, or integration mode is introduced.
Controlled local rollout has been authorized by the human operator:

```yaml
accepted: true
accepted_by: "local:sagaino"
accepted_at: "2026-08-31T04:42:25.000Z"
exceptions: []
next_review: "Before optional Telegram (V2-090), new connectors, public network exposure, or multi-user expansion."
```

