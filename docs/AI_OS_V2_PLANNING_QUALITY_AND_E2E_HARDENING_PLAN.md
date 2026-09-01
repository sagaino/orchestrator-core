# AI OS v2 — Planning Quality and E2E Hardening Plan

Status: **SUPERSEDED — REPLACED BY AI OS V2 PRODUCTION HARDENING COMPLETION PLAN (AI_OS_V2_PRODUCTION_HARDENING_COMPLETION_PLAN.md)**  
Plan date: **2026-08-31 (Asia/Jakarta)**  
Owner and final approver: **Human operator**  
Primary repositories: **personal-ai-orchestrator** and **orchestrator-dashboard**  
Explicit exclusion: **Do not edit, commit, clean, reset, or test-mutate `starter-app`**

## 1. Outcome

Implement four AI OS quality controls:

1. a requested verification may not disappear silently from a generated plan;
2. every project is planned with the correct blueprint and rule policy;
3. a change may not add new quality problems even when the project already has
   historical failures;
4. the complete objective lifecycle is covered by deterministic automated E2E
   tests.

After this plan is complete, `DONE` must mean that the objective used the correct
project rules, covered every requested check, introduced no new configured
quality finding, and passed the required objective lifecycle gates.

## 2. Confirmed Problems This Plan Must Solve

The following behavior was reproduced during a read-only pilot:

1. An objective explicitly requested `typecheck`, `build`, `lint`, and route/E2E
   checks. The generated plan retained only `typecheck` and `build` because the
   project verification allowlist contained only those two scripts.
2. The plan still reached `PLAN_REVIEW`; there was no machine-readable warning
   that requested checks had been omitted.
3. A frontend project without explicit blueprint metadata received Go backend
   guardrails because the decomposer silently defaulted to `backend-golang`.
4. A previous objective reached `DONE` after adding a new lint error because
   lint was excluded from that project's required verification set.
5. The approval gate, cancellation flow, runtime admission, and audit trail
   worked correctly. This plan must preserve those properties.

These are AI OS contract problems. Product defects inside `starter-app` are out
of scope.

## 3. Scope and Non-Goals

### 3.1 In scope

- objective intake and planning contracts;
- project-context and blueprint resolution;
- plan validation and plan-review evidence;
- verification execution and comparison evidence;
- objective delivery certification;
- backend API projections needed by the Dashboard;
- Dashboard visibility and approval blocking;
- deterministic backend and browser E2E tests;
- migration and compatibility for historical plan/run records.

### 3.2 Out of scope

- fixing application bugs or historical lint errors in any managed project;
- modifying `starter-app` or its Vault project page;
- changing human approval or final-acceptance ownership;
- enabling automatic plan approval or automatic final acceptance;
- installing a real provider, invoking a real coding agent, or using a real
  product repository from automated tests;
- Telegram, cloud deployment, or unrelated v2 capabilities;
- broad refactors not required by the four controls.

## 4. Non-Negotiable Safety Rules

1. Automated tests must create disposable repositories, Vaults, and run roots
   under an OS temporary directory.
2. Tests must use fake/deterministic planner and agent adapters. They must not
   call a live LLM or external network service.
3. No task, job, run, worktree, or product-file write may exist before the exact
   plan fingerprint is approved by a human actor in the test flow.
4. Missing verification coverage or unresolved blueprint identity must fail
   closed. It may become `NEEDS_CLARIFICATION`, but never a warning-only
   successful plan.
5. Historical v1 records remain readable. New contracts must not rewrite old
   run evidence in place.
6. Backend enforcement is authoritative. Dashboard disabling and warnings are
   explanatory controls, not the only protection.
7. Existing dirty files in managed repositories belong to the operator and must
   never be cleaned or overwritten by this work.

## 5. Target Contracts

### 5.1 Verification-intent contract

AI OS must preserve the difference between:

- checks explicitly requested by the operator;
- checks required by project policy;
- checks available in the repository;
- checks selected by the planner;
- checks that cannot currently be executed.

The authoritative artifact should be produced deterministically before provider
planning and attached to the generated plan:

```json
{
  "verificationIntent": {
    "contractVersion": 1,
    "required": [
      {
        "projectId": "fixture-frontend",
        "capability": "LINT",
        "source": "EXPLICIT_REQUEST",
        "requestedAs": "lint"
      },
      {
        "projectId": "fixture-frontend",
        "capability": "E2E",
        "source": "EXPLICIT_REQUEST",
        "requestedAs": "route login/dashboard/upload"
      }
    ],
    "resolved": [
      {
        "projectId": "fixture-frontend",
        "capability": "LINT",
        "script": "lint"
      }
    ],
    "missing": [
      {
        "projectId": "fixture-frontend",
        "capability": "E2E",
        "reason": "NO_APPROVED_SCRIPT"
      }
    ],
    "status": "NEEDS_CLARIFICATION"
  }
}
```

Required behavior:

- explicit structured intake, when supplied, is authoritative;
- deterministic aliases may detect clear natural-language mentions such as
  `typecheck`, `lint`, `build`, `unit test`, `integration`, and `e2e`;
- the provider may choose plan structure but may not remove required intent;
- after provider output, a deterministic coverage validator compares intent
  with node and integration verification;
- if an approved script exists but the provider omitted it, reject the plan as
  `PLAN_VERIFICATION_COVERAGE_MISSING`;
- if no approved script or runner exists, return `NEEDS_CLARIFICATION` with the
  exact missing capability and do not create tasks;
- static inspection of route declarations must not be presented as browser E2E
  evidence.

### 5.2 Project-blueprint contract

Planning must resolve one supported blueprint before loading a rule policy.

Target evidence:

```json
{
  "blueprint": {
    "id": "frontend-vite",
    "source": "PROJECT_METADATA",
    "confidence": "EXPLICIT",
    "policyVersion": 1
  }
}
```

Allowed sources:

- `PROJECT_METADATA` — preferred and authoritative;
- `REGISTRY_METADATA` — compatibility source;
- `DETECTED` — allowed only for high-confidence, deterministic detection;
- `UNRESOLVED` — must block planning.

Minimum deterministic signals:

- `go.mod` strongly identifies `backend-golang`;
- `package.json` plus Vite/React/TypeScript dependencies strongly identifies
  `frontend-vite`;
- conflicting or weak signals produce `UNRESOLVED`;
- unsupported blueprint identifiers produce `PROJECT_BLUEPRINT_UNSUPPORTED`;
- `loadRulePolicy` must never silently substitute Go rules for an unknown or
  absent blueprint.

The bounded project context sent to the provider must retain blueprint ID,
source, policy version, and the exact approved verification scripts.

### 5.3 Baseline-aware verification contract

Each configured verification uses one of two modes:

- `STRICT`: the candidate command must exit successfully;
- `NO_NEW_FINDINGS`: a failing historical baseline is tolerated only when the
  candidate introduces no new normalized findings.

Suggested project policy shape:

```yaml
verification_defaults: [typecheck, lint, build]
verification_policies:
  typecheck:
    mode: STRICT
  lint:
    mode: NO_NEW_FINDINGS
    adapter: eslint
  build:
    mode: STRICT
```

For `NO_NEW_FINDINGS`, AI OS must run or retrieve the same approved check for
the frozen base commit and the candidate workspace. It must store:

```json
{
  "script": "lint",
  "mode": "NO_NEW_FINDINGS",
  "baseline": {
    "commit": "<base-commit>",
    "exitCode": 1,
    "errorCount": 35,
    "warningCount": 0,
    "findingsFingerprint": "<sha256>"
  },
  "candidate": {
    "exitCode": 1,
    "errorCount": 35,
    "warningCount": 0,
    "findingsFingerprint": "<sha256>"
  },
  "delta": {
    "new": 0,
    "resolved": 0,
    "unchanged": 35
  },
  "status": "PASS_NO_REGRESSION"
}
```

Comparison rules:

- clean baseline + clean candidate: pass;
- clean baseline + failing candidate: fail;
- failing baseline + fewer findings and no new finding: pass as improvement;
- failing baseline + same count but a different/new finding: fail;
- failing baseline + more findings: fail;
- missing, stale, or unparseable baseline in `NO_NEW_FINDINGS` mode: block;
- strict verification behavior remains unchanged;
- only findings inside the same frozen toolchain and dependency baseline may be
  compared.

The first adapter may target ESLint, but the comparison core must be generic.
Other tools stay `STRICT` until an explicit adapter exists.

### 5.4 Objective-lifecycle E2E contract

The deterministic E2E scenario must prove this sequence:

1. create a disposable project, Vault entry, and runs root;
2. submit an objective;
3. generate a plan;
4. assert that no task, job, run, or source write exists;
5. inspect verification coverage and blueprint evidence;
6. approve the exact plan fingerprint as a test human actor;
7. materialize the task and start orchestration;
8. run the deterministic fixture agent;
9. execute strict and baseline-aware verification;
10. collect objective evidence and delivery certification;
11. require final human acceptance;
12. verify cleanup and the hash-chained audit trail.

A second scenario must cancel at `PLAN_REVIEW` and prove zero execution and zero
source writes. Negative scenarios must cover missing verification, unresolved
blueprint, fingerprint mismatch, and a newly introduced lint finding.

## 6. Implementation Sequence

Execute packets in the dependency order from section 7. Each packet should be
independently reviewable and must leave its targeted test set green.

### ✅ PQE-000 — Freeze regression fixtures

Type: **READ-ONLY ANALYSIS + TEST FIXTURES**  
Depends on: none

Primary paths:

- new `test/fixtures/planning-quality/**`, or runtime-created fixtures in a new
  test helper;
- new `test/planning-quality-regressions.test.mjs`.

Actions:

1. Add disposable fixture builders for a frontend repository, backend
   repository, Vault registry, project page, and runs root.
2. Reproduce the four confirmed failures without referring to `starter-app`:
   omitted lint/E2E, wrong Go fallback, historical lint plus one new finding,
   and the approval-gate lifecycle.
3. Make the tests deterministic and independent of the operator's active
   daemon, `.env`, Vault, and repositories.
4. Record current behavior as assertions that describe the desired contract;
   keep implementation commits green by landing each assertion together with
   its fix rather than committing a knowingly red branch.

Acceptance criteria:

- fixtures use only temporary directories;
- no live provider or network call occurs;
- a guard test fails immediately if a fixture path escapes its temporary root;
- `starter-app` status is identical before and after the suite.

### ✅ PQE-010 — Capture deterministic verification intent

Type: **BACKEND CONTRACT + TESTS**  
Focus: **1 — requested checks may not disappear**  
Depends on: PQE-000

Primary paths:

- new `src/verification-intent.mjs`;
- `src/objective-store.mjs`;
- `src/objective-planning.mjs`;
- `src/server.mjs`;
- `src/orchestration-schema.mjs`;
- `test/objective-intake-api.test.mjs`;
- `test/objective-planning-api.test.mjs`;
- new `test/verification-intent.test.mjs`.

Actions:

1. Add an optional structured intake field for requested checks while retaining
   natural-language compatibility.
2. Normalize capabilities to a bounded enum: `TYPECHECK`, `LINT`, `BUILD`,
   `UNIT`, `INTEGRATION`, `E2E`, and `CUSTOM_APPROVED`.
3. Resolve each capability only to an exact approved script or registered
   orchestrator runner.
4. Persist the deterministic intent with the objective/plan evidence; the LLM
   must not author this artifact.
5. Add backward-compatible readers for historical records without this field.

Acceptance criteria:

- explicit `lint` remains required even if not in project defaults;
- `test:e2e` resolves to `E2E` when approved;
- vague words such as “check the UI” do not silently become a mandatory script;
- the API never reports `COMPLETE` when required checks are unresolved.

### ✅ PQE-011 — Enforce verification coverage at plan creation and approval

Type: **BACKEND ENFORCEMENT + EVIDENCE**  
Focus: **1 — requested checks may not disappear**  
Depends on: PQE-010

Primary paths:

- `src/project-decomposer.mjs`;
- `src/plan-lifecycle.mjs`;
- `src/task-materializer.mjs`;
- `src/objective-evidence.mjs`;
- `src/delivery-certification.mjs`;
- relevant schema/API tests.

Actions:

1. Include verification intent in the bounded provider context.
2. Validate provider output against deterministic intent after normalization.
3. Re-run the same validation immediately before plan approval/materialization
   to prevent stale or tampered evidence.
4. Return `NEEDS_CLARIFICATION` for unavailable checks and a validation error
   for provider omissions.
5. Expose requested, resolved, planned, missing, and executed checks in
   objective evidence and delivery certification.

Acceptance criteria:

- missing coverage creates zero tasks, jobs, and runs;
- approval endpoint rejects incomplete coverage even if called directly;
- final certification cannot pass if a required check lacks passing evidence;
- historical v1 plans remain readable but cannot be newly approved if their
  required objective intent is incomplete.

### ✅ PQE-020 — Resolve blueprint without unsafe fallback

Type: **BACKEND PROJECT CONTRACT + TESTS**  
Focus: **2 — correct project rules**  
Depends on: PQE-000

Primary paths:

- new `src/project-blueprint.mjs`;
- `src/core.mjs`;
- `src/objective-planning.mjs`;
- `src/rule-policy.mjs`;
- `src/project-decomposer.mjs`;
- `src/project-onboarding.mjs`;
- `test/project-decomposer.test.mjs`;
- `test/objective-planning-api.test.mjs`;
- new `test/project-blueprint.test.mjs`.

Actions:

1. Implement explicit, registry, and deterministic-detection resolution.
2. Preserve blueprint evidence in bounded project contexts.
3. Replace `backend-golang` defaulting in the decomposer and rule loader with
   an explicit resolution result or a typed failure.
4. Ensure onboarding always writes supported blueprint metadata.
5. Add a read-only migration-report command that lists projects as `EXPLICIT`,
   `DETECTED`, `AMBIGUOUS`, or `UNSUPPORTED`. Do not auto-edit project pages.

Acceptance criteria:

- Vite/React fixtures receive only frontend guardrails;
- Go fixtures receive only Go guardrails;
- ambiguous fixtures stop before provider planning;
- unknown policies never fall back to Go;
- API and Dashboard evidence name blueprint source and policy version.

### ✅ PQE-021 — Enforce blueprint consistency across the lifecycle

Type: **BACKEND ENFORCEMENT**  
Focus: **2 — correct project rules**  
Depends on: PQE-020

Actions:

1. Freeze blueprint ID and policy version into the approved plan fingerprint.
2. Verify the frozen blueprint again at claim/materialization time.
3. If project metadata or deterministic signals drift, block with
   `PROJECT_BLUEPRINT_DRIFT` and require re-planning.
4. Include blueprint provenance in task and run evidence without changing the
   managed project.

Acceptance criteria:

- a post-approval blueprint change cannot execute under the old plan;
- policy drift is visible and auditable;
- no product-repository file is modified by blueprint detection.

### ✅ PQE-030 — Add normalized verification findings and baselines

Type: **BACKEND VERIFICATION ENGINE + TESTS**  
Focus: **3 — no new problems over a dirty baseline**  
Depends on: PQE-010 and PQE-020

Primary paths:

- new `src/verification-baseline.mjs`;
- new `src/verification-adapters/eslint.mjs`;
- `src/executor.mjs`;
- `src/workspace-manager.mjs`;
- `src/run-manager.mjs`;
- `src/objective-evidence.mjs`;
- `test/git-finalization.test.mjs`;
- `test/evidence.test.mjs`;
- new `test/verification-baseline.test.mjs`.

Actions:

1. Load optional per-script verification policies from project metadata.
2. Capture baseline results against the frozen base commit before candidate
   changes are applied.
3. Normalize ESLint findings using stable fields: repository-relative file,
   rule ID, severity, line/column when reliable, and normalized message.
4. Hash sorted normalized findings; never use console order as identity.
5. Compare baseline and candidate sets and persist new/resolved/unchanged
   evidence.
6. Preserve current fail-fast behavior for `STRICT` checks.
7. Block rather than pass when a `NO_NEW_FINDINGS` adapter cannot parse output.

Acceptance criteria:

- 35 baseline findings to the same 35 passes;
- 35 to 34 with no new finding passes as improvement;
- 35 to 36 fails;
- 35 to a different set of 35 fails because at least one finding is new;
- baseline capture failure blocks execution;
- a candidate cannot alter the approved verification script to manipulate
   comparison.

### ✅ PQE-031 — Make baseline results part of completion

Type: **CERTIFICATION + RECOVERY**  
Focus: **3 — no new problems over a dirty baseline**  
Depends on: PQE-030

Primary paths:

- `src/integration-manager.mjs`;
- `src/orchestration-certification.mjs`;
- `src/delivery-certification.mjs`;
- `src/notification-service.mjs`;
- certification and recovery tests.

Actions:

1. Treat `FAIL_REGRESSION`, `BASELINE_UNAVAILABLE`, and `UNCOMPARABLE` as
   blockers.
2. Allow `PASS`, `PASS_NO_REGRESSION`, and `PASS_IMPROVED` as successful
   evidence states.
3. Ensure retry/recovery cannot replace the frozen baseline with the broken
   candidate.
4. Include a concise baseline delta in notifications and final evidence.

Acceptance criteria:

- objective cannot reach `DONE` with any new configured finding;
- retry retains the original baseline commit and fingerprint;
- final acceptance UI receives enough evidence to explain the result.

### ✅ PQE-040 — Add deterministic backend objective-lifecycle E2E

Type: **BACKEND E2E TEST HARNESS**  
Focus: **4 — complete lifecycle test**  
Depends on: PQE-011, PQE-021, and PQE-031

Primary paths:

- new `test/helpers/ai-os-e2e-fixture.mjs`;
- new `test/ai-os-objective-lifecycle-e2e.test.mjs`;
- `package.json`.

Required scenarios:

1. happy path through intake, plan review, approval, execution, verification,
   result review, final acceptance, cleanup, and audit verification;
2. cancellation at plan review with no execution artifacts;
3. explicitly requested check unavailable, producing clarification;
4. wrong or unresolved blueprint, producing a planning block;
5. new lint finding, producing verification/certification failure;
6. plan fingerprint mismatch, producing approval rejection;
7. idempotent retries for intake, planning, approval, and final acceptance.

Acceptance criteria:

- suite needs no active daemon and binds only to loopback on an ephemeral port;
- suite uses a temporary Git repository and deterministic process runners;
- suite proves audit events and state transitions in order;
- temporary process trees, ports, worktrees, and directories are cleaned in
  `finally` blocks;
- add `npm run test:ai-os-lifecycle-e2e` and include it in the appropriate full
  certification suite.

### ✅ PQE-050 — Add Dashboard browser E2E

Type: **DASHBOARD E2E TEST**  
Focus: **4 — operator-visible lifecycle test**  
Depends on: PQE-040 and PQE-041

Primary repository: `orchestrator-dashboard`

Suggested paths:

- new `playwright.config.ts` if no equivalent exists;
- new `e2e/objective-governance.spec.ts`;
- new fixture/bootstrap helper;
- `package.json`.

Required browser assertions:

1. submit objective from Task Intake;
2. observe `PLANNING` then `PLAN REVIEW`;
3. see requested/resolved/missing checks and blueprint evidence;
4. verify Approve is disabled when coverage is incomplete;
5. approve a complete fixture plan and observe execution/result evidence;
6. exercise final acceptance with the deterministic fixture backend;
7. cancel a second plan and confirm it remains audit-visible;
8. assert zero uncaught browser errors and zero failed API requests outside the
   expected negative scenarios.

Acceptance criteria:

- test uses only the disposable backend fixture;
- screenshots/traces are retained only on failure;
- no operator session, real Vault, or managed repository is reused;
- add a stable `npm run test:e2e:ai-os` command.

### ✅ PQE-041 — Expose governance evidence in the Dashboard

Type: **DASHBOARD UI + API TYPES**  
Depends on: PQE-011, PQE-020, and PQE-031

Primary Dashboard paths:

- `src/services/orchestrator.ts`;
- `src/pages/Tasks/components/PlanReviewPanel.tsx`;
- `src/pages/Objectives/components/ObjectivePlanGate.tsx`;
- objective evidence and delivery-certification panels;
- focused component tests if present.

Actions:

1. Display `Requested`, `Resolved`, `Planned`, and `Missing` verification.
2. Display blueprint ID, source, confidence, and policy version.
3. Display baseline and candidate counts plus new/resolved finding deltas.
4. Disable approval when backend evidence is incomplete, while preserving the
   backend rejection as the authority.
5. Use plain-language reasons such as “E2E diminta tetapi belum tersedia” and
   “Blueprint project belum dapat ditentukan”.

Acceptance criteria:

- an operator can understand why a plan is blocked without reading raw JSON;
- no UI state suggests `PASS` when evidence is missing or unknown;
- Dashboard typecheck, lint, and build remain green.

### ✅ PQE-060 — Compatibility and migration

Type: **MIGRATION + OPERATIONS**  
Depends on: PQE-011, PQE-021, PQE-031, and PQE-050

Actions:

1. Introduce a new plan contract version for newly generated plans while
   retaining read-only support for historical plan records.
2. Do not backfill historical evidence with invented verification intent,
   blueprint provenance, or baseline results.
3. Add a dry-run report for project blueprint and verification-policy readiness.
4. Require explicit operator action for any future Vault metadata edits.
5. Add Operations counts for unresolved blueprints, incomplete verification
   coverage, and baseline-comparison failures.
6. Document rollback: disable admission of new contract plans while preserving
   review, cancellation, recovery, and historical evidence access.

Acceptance criteria:

- existing completed/cancelled objectives remain readable;
- active old-contract objectives are not silently upgraded mid-run;
- new objectives fail closed when the new contract cannot be satisfied;
- migration dry-run performs no writes.

### ✅ PQE-070 — Final certification and pilot

Type: **MACHINE CERTIFICATION + HUMAN REVIEW**  
Depends on: all previous packets

Backend required gates:

```bash
npm run test:verification-intent
npm run test:project-blueprint
npm run test:verification-baseline
npm run test:ai-os-lifecycle-e2e
npm run test:unit
npm run test:smoke
npm test
```

The implementing agent may choose different targeted script names, but must add
one documented aggregate command for the four-focus suite.

Dashboard required gates:

```bash
npm run typecheck
npm run lint
npm run build
npm run test:e2e:ai-os
```

Pilot requirements:

1. Use a newly created disposable frontend fixture, not `starter-app`.
2. Request `typecheck`, `lint`, `build`, and E2E explicitly.
3. Prove the plan contains all four or asks for clarification before approval.
4. Prove frontend rules are used and no Go rule text appears.
5. Introduce one fixture-only lint regression and prove completion is blocked.
6. Remove the regression, rerun, and prove final certification passes.
7. Complete one cancellation-at-review path.
8. Verify source status, worktree cleanup, port cleanup, and audit-chain validity.

Human gate:

- the agent may prepare evidence but may not invent final operator acceptance;
- rollout status changes only after the operator reviews the certification.

## 7. Dependency Order and Parallelism

Safe dependency order:

```text
PQE-000
  ├─ PQE-010 → PQE-011
  └─ PQE-020 → PQE-021

PQE-011 + PQE-021
  └─ PQE-030 → PQE-031

PQE-011 + PQE-021 + PQE-031
  ├─ PQE-040
  └─ PQE-041

PQE-040 + PQE-041
  └─ PQE-050 → PQE-060 → PQE-070
```

PQE-010 and PQE-020 may be developed in parallel only when separate agents use
isolated branches/worktrees. PQE-030 must wait for both contracts. Dashboard
work may begin from frozen API fixture types, but its final merge waits for the
backend evidence schema.

## 8. Required Test Matrix

| Area | Positive case | Negative case | Required outcome |
|---|---|---|---|
| Verification intent | All requested checks resolve and appear in plan | Lint/E2E requested but missing | `NEEDS_CLARIFICATION`; no task/run |
| Provider coverage | Provider retains required checks | Provider drops one required check | Plan rejected deterministically |
| Blueprint | Explicit/detected frontend or Go | Ambiguous/unsupported | Correct policy or planning block |
| Blueprint drift | Policy unchanged after approval | Metadata/signals change | Re-plan required |
| Strict verification | Exit code 0 | Exit code non-zero | Pass or fail |
| No-new-findings | Same/fewer known findings | More or different new finding | Pass/improved or regression fail |
| Baseline integrity | Frozen baseline available | Missing/unparseable/stale | Block, never pass |
| Approval gate | Correct fingerprint | Wrong/stale fingerprint | Materialize or reject |
| Cancellation | Cancel at review | Late duplicate request | Audit-visible cancel; idempotent |
| Final acceptance | Complete machine evidence | Missing required evidence | Accept or block |
| Cleanup | Processes and worktrees closed | Injected failure | Bounded cleanup still completes |

## 9. Commit and Review Strategy

Use small commits with one contract per commit. Suggested sequence:

1. `test(planning): add disposable quality regression fixtures`
2. `feat(planning): preserve and enforce verification intent`
3. `fix(planning): resolve blueprint without backend fallback`
4. `feat(verification): add no-new-findings baseline comparison`
5. `test(e2e): certify objective governance lifecycle`
6. Dashboard commit: `feat(governance): expose plan and baseline evidence`
7. `docs(governance): record planning quality certification`

Before every commit:

- inspect the exact diff;
- confirm no secret, absolute operator path, runtime artifact, or managed-project
  file is staged;
- run the targeted tests for that packet;
- do not combine backend and Dashboard commits because they are separate Git
  repositories;
- do not amend or rewrite the operator's unrelated commits.

## 10. Definition of Done

This plan is complete only when all statements below are true:

- a requested verification cannot be omitted without a machine-visible block;
- plan review displays both selected and missing checks;
- frontend projects never receive backend Go rules through fallback;
- blueprint and policy version are frozen into approval evidence;
- configured historical quality debt does not block unchanged work, but every
  new finding blocks completion;
- baseline evidence is immutable, comparable, and shown in final evidence;
- API lifecycle E2E and Dashboard browser E2E run deterministically without a
  live provider or real managed project;
- approval and final acceptance remain human gates;
- cancellation, idempotency, recovery, cleanup, and audit integrity are covered;
- full backend and Dashboard gates pass;
- `personal-ai-orchestrator` and `orchestrator-dashboard` contain only intended
  changes;
- `starter-app` remains untouched.

## 11. Handoff Instructions for the Implementing Agent

1. Read this file completely before editing.
2. Inspect repository-local instructions and dirty status in both AI OS
   repositories.
3. Do not use `starter-app` as a fixture, even read/write through an automated
   workflow. Use disposable temporary repositories.
4. Start with PQE-000 and proceed in dependency order.
5. Treat the data shapes in section 5 as contracts; small naming adjustments
   are allowed only if all semantics and evidence remain present.
6. Prefer pure functions for intent resolution, blueprint resolution, finding
   normalization, and baseline comparison.
7. Keep provider output untrusted. Recompute every safety decision
   deterministically after provider output and before approval.
8. Never solve missing coverage by silently adding arbitrary shell commands.
   Only approved scripts or registered orchestrator runners may execute.
9. Stop and request human direction if implementation requires changing active
   runtime flags, real Vault metadata, or product repositories.
10. At handoff, report commits per repository, targeted/full test results,
    remaining risks, migration dry-run output, and exact pilot evidence.

## 12. Stop Conditions

Stop implementation and report the blocker when any of these occurs:

- required work would modify `starter-app`;
- a test attempts to use the operator's real Vault, runs root, or active daemon;
- plan coverage can only be satisfied by executing an unapproved command;
- blueprint detection is ambiguous;
- baseline evidence cannot be tied to a frozen commit and toolchain;
- backward compatibility would require inventing fields in historical evidence;
- a human approval or acceptance identity would need to be synthesized;
- unrelated dirty changes overlap a required AI OS file.
