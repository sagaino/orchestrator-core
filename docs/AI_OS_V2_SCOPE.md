# Personal AI OS v2 — Approved Scope Contract
 
Status: **ACCEPTED FOR CONTROLLED LOCAL ROLLOUT**  
Implementation status: **IMPLEMENTED** (Core phases 1-7; optional Telegram deferred)  
Acceptance status: **ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT**  
Default activation: **DISABLED** (`LOCAL_SAFE` default-off)  
Source plan: [AI OS v2 Orchestration Implementation Plan](./AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md)

## 1. Objective

v2 adds a supervised orchestration layer in which one user objective can be
turned into an approved, dependency-aware set of canonical tasks and executed
through the existing task, queue, run, worktree, verification, review, and
knowledge workflows.

The orchestrator remains the only owner of lifecycle state, approvals, graph
state, integration state, runtime manifests, and knowledge indexes. Agents may
inspect and edit code only inside their assigned isolated workspace and
approved scope.

## 2. In scope

- Local, single-user, human-supervised operation.
- Existing registered repositories and the existing `frontend-vite` Fresh
  Project blueprint.
- Existing-project objectives and Fresh Project objectives.
- Read-only objective decomposition into strict JSON plans.
- Deterministic plan validation, DAG scheduling, and durable restart recovery.
- Sequential execution as the first production mode.
- Bounded parallel execution only after its certification gate.
- Temporary role-based sub-agents before formal skills exist.
- Sequential and aggregate integration evidence with explicit human
  acceptance.
- Explicitly registered linked-project relationships and cross-project
  diagnostics after the cross-project phase is accepted.
- Dashboard visibility for plans, graph state, decisions, evidence, budgets,
  and final acceptance.
- Optional Telegram notification/control boundary only after its separate
  threat-model gate.
- Skill Registry and Skill Router only as the final v2 phase.

## 3. Safety and authority boundaries

The following decisions always belong to the local human operator:

- approving Fresh Project creation;
- approving a plan revision;
- authorizing retries, scope expansion, high-risk changes, and cancellation;
- accepting individual run results and aggregate integration results;
- activating feature flags, parallel execution, Telegram, or skills;
- installing, enabling, updating, or disabling skills.

Planning is read-only. A model cannot create an approval, impersonate a human,
change a plan after approval, broaden paths/tools/model tier, or mark a result
accepted. A changed plan creates a new revision and invalidates the prior
approval.

## 4. Runtime boundaries

All durable objective, plan, orchestration, decision, and integration state is
stored under the existing `runsRoot` using validated JSON, atomic writes,
revision checks, redaction, owner-only permissions where supported, and durable
leases. Vault task documents remain the human-readable source for individual
task specifications; runtime JSON is authoritative for orchestration.

Each sub-agent receives exactly one primary task, role, project, repository,
isolated worktree, approved path scope, verification contract, and bounded
runtime budget. The project-exclusive lease remains the default. Main
repositories are unchanged until the applicable human acceptance gate.

## 5. Integration and cross-project scope

Aggregate integration uses a frozen baseline per repository, preserves every
source run and patch, applies changes in dependency order, stops on conflicts
or baseline drift, verifies the union of approved scopes, and provides rollback
evidence before human acceptance.

The first cross-project release requires separate acceptance for each modified
repository plus a final cross-project verification gate. It does not claim
atomic multi-repository commits unless rollback tests prove that guarantee.

## 6. Telegram boundary

Telegram is optional and disabled by default. The initial permitted capability
is notification-only. Any later command mode must use a verified local operator
identity, replay protection, bounded commands, redaction, rate limits, and
secret references. Telegram cannot approve high-risk changes, merge, deploy,
delete, or synthesize local human identity in the initial release.

## 7. Skill-install boundary

Formal skills are disabled until the final skill phase. Agents and the Skill
Router may select only installed, enabled, checksum-valid skills. They may not
install, edit, enable, disable, update, or redefine a skill. Skill instructions
cannot broaden task paths, tools, model tier, verification, or approval power.

## 8. Explicitly out of scope

- Multi-user accounts, teams, or RBAC.
- Public dashboard/API exposure.
- Cloud worker fleets or unbounded concurrency.
- Agent-created approval or acceptance.
- Automatic production deployment.
- Production secrets, real payment execution, or arbitrary plugin/skill
  installation.
- Parallel writes to overlapping paths.
- More than one active integration apply per repository.
- Arbitrary model-provider adapter expansion.
- Marketplace, billing, irreversible cleanup, and automatic deletion.

## 9. Rollout defaults

All v2 capabilities remain disabled by default:

```env
ORCHESTRATOR_OBJECTIVES_ENABLED=0
ORCHESTRATOR_OBJECTIVE_SCHEDULER=0
ORCHESTRATOR_PARALLEL_OBJECTIVES=0
ORCHESTRATOR_SAME_PROJECT_PARALLEL=0
ORCHESTRATOR_CROSS_PROJECT=0
ORCHESTRATOR_TELEGRAM_ENABLED=0
ORCHESTRATOR_SKILLS_ENABLED=0
ORCHESTRATOR_SKILL_AUTO_ROUTING=0
```

Disabling a flag blocks new admission but preserves active-state recovery and
human review. No later flag implicitly enables its prerequisites.

## 10. Human acceptance

This document is not an approval by a model. The human operator has reviewed
this scope together with the threat model and authorized controlled local rollout:

```yaml
accepted: true
accepted_by: "local:sagaino"
accepted_at: "2026-08-31T04:42:25.000Z"
notes: "Accepted for controlled local rollout of core capabilities (Phases 1-7); optional Telegram deferred."
```

