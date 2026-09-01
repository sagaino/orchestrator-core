# AI OS v2 — Production Hardening Completion Plan

Status: **SUPERSEDED — REPLACED BY AI OS V2 HARDENING RECERTIFICATION REMEDIATION PLAN**  
Plan date: **2026-09-01 (Asia/Jakarta)**  
Owner and final approver: **Human operator**  
Primary repositories: **personal-ai-orchestrator** and **orchestrator-dashboard**  
Backend review baseline: **`3c5a583`**  
Dashboard review baseline: **`7210433`**  
Supersedes completion claims in: **`AI_OS_V2_PLANNING_QUALITY_AND_E2E_HARDENING_PLAN.md`**  
Explicit exclusion: **Do not edit, commit, clean, reset, inspect via automated tests, or otherwise mutate `starter-app`**

## 1. Purpose

Complete the production-hardening controls that were only partially implemented
by the previous Planning Quality and E2E plan.

The implementing model must close four production blockers:

1. the planner receives and obeys the correct project blueprint policy;
2. approval, materialization, execution, and delivery certification fail closed
   when governance evidence is missing, stale, or inconsistent;
3. `NO_NEW_FINDINGS` verification runs against a frozen baseline in the real
   executor and becomes part of completion evidence;
4. deterministic backend and Dashboard E2E tests prove the complete objective
   lifecycle through final acceptance, cleanup, and audit verification.

This is a completion and integration plan. The existing orchestration core must
not be rewritten.

## 2. Current Verified State

The review baseline has the following strengths:

- deterministic verification-intent extraction exists;
- provider output is checked for resolved verification coverage;
- blueprint resolution and a read-only blueprint audit command exist;
- normalized ESLint findings and a generic comparator exist;
- objective plan evidence is visible in one Dashboard plan-review modal;
- disposable test fixtures exist;
- backend `npm test` passes;
- Dashboard typecheck, lint, build, and existing browser tests pass.

The green tests do not prove the target production contracts because these gaps
remain:

1. `project-decomposer.mjs` passes a blueprint evidence object to
   `loadRulePolicy`, which expects a blueprint ID. The provider receives no
   project rule policy.
2. Bounded provider project context omits blueprint provenance.
3. Any repository containing only `package.json` is classified as
   `frontend-vite`, including weak, non-Vite, and invalid manifests.
4. Verification coverage and blueprint consistency are not revalidated at
   approval and materialization.
5. Delivery certification treats a missing `verificationIntent` as an empty
   successful intent.
6. `verification_policies`, the ESLint adapter, and the baseline comparator are
   not connected to the production executor.
7. The backend lifecycle E2E stops after a job is queued.
8. The cancellation scenario cancels during intake/planning, not at
   `PLAN_REVIEW`.
9. The Dashboard Task Intake plan-review panel does not show or enforce all
   governance evidence.
10. No stable Dashboard `test:e2e:ai-os` command exists.
11. The clarification prompt offers continuation without a check, but no
    structured, auditable operator decision can resolve that choice.
12. New governed plans still use the historical plan schema version.

## 3. Required End State

After this plan is complete, the following statement must be true:

> A new objective cannot execute or be certified unless the exact approved plan
> used the correct frozen project policy, preserved every requested or
> explicitly waived verification requirement, introduced no new configured
> finding, completed the full lifecycle, and retained machine-verifiable audit
> evidence.

Target maturity after successful machine certification:

- implementation status: `IMPLEMENTED`;
- machine certification: `PASSED`;
- human acceptance: `PENDING` until the operator explicitly accepts it;
- rollout recommendation: `PRODUCTION_CANDIDATE`, not automatic production
  activation.

## 4. Non-Negotiable Safety Rules

1. Do not touch `starter-app`. All product-project fixtures must be newly created
   under an OS temporary directory.
2. Do not use a live LLM, live coding agent, real managed repository, external
   network, operator Vault, or operator run root in automated tests.
3. Preserve all unrelated local changes. Never clean, reset, overwrite, or
   reformat unrelated files.
4. No task, job, run, worktree, or fixture source write may exist before approval
   of the exact plan fingerprint.
5. Backend enforcement is authoritative. Dashboard controls are explanatory and
   must not be the only blocker.
6. Missing, unknown, stale, invalid, or unparseable governance evidence must
   block. `UNKNOWN` must never be interpreted as `PASS`.
7. Historical records remain readable. Do not invent or backfill missing intent,
   blueprint, baseline, approval, or acceptance evidence.
8. Do not invent a human identity, approval, verification waiver, final
   acceptance, or rollout acceptance.
9. Never replace a frozen baseline with a failed candidate during retry or
   recovery.
10. Do not mark a packet complete before its production path and negative tests
    pass.
11. Do not mark this plan `CERTIFIED` merely because unit, typecheck, lint, or
    build passes.
12. Keep backend and Dashboard commits separate and independently reviewable.

## 5. Authoritative Contracts

### 5.1 Blueprint policy evidence

Every new governed plan must freeze one valid blueprint result per project:

```json
{
  "projectId": "fixture-frontend",
  "blueprint": {
    "contractVersion": 2,
    "id": "frontend-vite",
    "source": "PROJECT_METADATA",
    "confidence": "EXPLICIT",
    "policyVersion": 1,
    "policyFingerprint": "<sha256>",
    "valid": true
  }
}
```

Required behavior:

- rule loading accepts the resolved blueprint ID, never an evidence object;
- the provider context retains ID, source, confidence, policy version, policy
  fingerprint, and approved verification scripts;
- frontend plans contain frontend guardrails and no Go guardrails;
- Go plans contain Go guardrails and no frontend guardrails;
- weak or conflicting signals produce `PROJECT_BLUEPRINT_UNRESOLVED`;
- unsupported explicit metadata produces `PROJECT_BLUEPRINT_UNSUPPORTED`;
- a missing rule policy is a typed planning failure;
- approval and materialization compare current project evidence with the frozen
  evidence and return `PROJECT_BLUEPRINT_DRIFT` on any material change.

### 5.2 Verification intent and operator decision evidence

New governed plans must use a deterministic verification-intent artifact. A
missing check can only be resolved by one of these explicit outcomes:

1. an approved project script is selected;
2. a registered orchestrator runner is selected;
3. the operator supplies an approved alternative;
4. the operator explicitly waives the requirement with a reason;
5. the objective is cancelled.

Suggested decision shape:

```json
{
  "decisionId": "decision-verification-<objective>-<capability>",
  "type": "VERIFICATION_REQUIREMENT_RESOLUTION",
  "projectId": "fixture-frontend",
  "capability": "E2E",
  "action": "SELECT_SCRIPT | SELECT_RUNNER | WAIVE | CANCEL",
  "selectedTarget": "test:e2e",
  "reason": "<operator supplied>",
  "resolvedBy": "<authenticated operator>",
  "resolvedAt": "<ISO timestamp>"
}
```

Rules:

- the model may request the decision but may not create a human resolution;
- a waiver must remain visible in the plan, fingerprint, approval modal,
  objective evidence, certification, and audit trail;
- `RESOLVED_WITH_WAIVERS` is not equivalent to silent omission;
- the same deterministic coverage validation runs after provider output,
  immediately before approval, and immediately before materialization;
- historical plans without intent may be viewed or cancelled but may not be
  newly approved as governed v2 plans.

### 5.3 Baseline-aware verification evidence

Every executed verification command has an explicit mode:

- `STRICT`: candidate exit code must be zero;
- `NO_NEW_FINDINGS`: compare the frozen baseline finding set with the candidate
  finding set using the configured adapter.

Target evidence:

```json
{
  "script": "lint",
  "mode": "NO_NEW_FINDINGS",
  "adapter": "eslint",
  "toolchainFingerprint": "<sha256>",
  "baseline": {
    "commit": "<frozen-base-commit>",
    "exitCode": 1,
    "errorCount": 35,
    "warningCount": 0,
    "findingsFingerprint": "<sha256>"
  },
  "candidate": {
    "commit": "<candidate-commit-or-workspace-fingerprint>",
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

Allowed successful statuses:

- `PASS`;
- `PASS_NO_REGRESSION`;
- `PASS_IMPROVED`.

Blocking statuses:

- `FAIL`;
- `FAIL_REGRESSION`;
- `BASELINE_UNAVAILABLE`;
- `UNCOMPARABLE`;
- `ADAPTER_UNAVAILABLE`;
- `TOOLCHAIN_DRIFT`.

The baseline commit, approved command, adapter, dependency/toolchain identity,
and normalized finding set must be immutable across retries.

### 5.4 Delivery certification evidence

Certification must distinguish these states:

- evidence present and passing;
- evidence present and failing;
- evidence not required by the frozen plan;
- evidence missing or unknown.

Only the first and explicitly `NOT_REQUIRED` state may pass. Optional chaining,
default empty arrays, or absent historical fields must not turn missing evidence
into a passing check.

### 5.5 Full objective lifecycle E2E

The deterministic backend fixture must prove:

```text
INTAKE
  -> PLANNING
  -> PLAN_REVIEW
  -> HUMAN APPROVAL
  -> MATERIALIZATION
  -> JOB CLAIM
  -> FIXTURE AGENT EXECUTION
  -> STRICT + BASELINE VERIFICATION
  -> RESULT REVIEW
  -> DELIVERY CERTIFICATION READY
  -> HUMAN FINAL ACCEPTANCE
  -> CLEANUP
  -> AUDIT CHAIN VERIFIED
```

The test is incomplete if it stops at task creation, job queueing, run creation,
or verification.

## 6. Implementation Packets

### [x] PHC-000 — Freeze remediation regressions and correct status authority

Type: **READ-ONLY DISCOVERY + REGRESSION TESTS + DOCUMENTATION STATUS**  
Depends on: none

Primary backend paths:

- `docs/AI_OS_V2_PLANNING_QUALITY_AND_E2E_HARDENING_PLAN.md`;
- `test/planning-quality-regressions.test.mjs`;
- `test/helpers/planning-quality-fixture.mjs`;
- new focused regression tests where necessary.

Actions:

1. Reproduce every gap listed in section 2 using temporary fixtures.
2. Add assertions against production entry points, not only pure helper
   functions.
3. Add a prompt-capture test proving the current provider prompt lacks the
   correct rule policy before applying PHC-010.
4. Add direct approval and certification regression cases for missing evidence.
5. Add a guard proving all fixture paths remain inside the temporary root.
6. Change the old plan status from `IMPLEMENTED & CERTIFIED` to a truthful
   `SUPERSEDED — REPLACED BY PRODUCTION HARDENING COMPLETION PLAN`.

Acceptance criteria:

- regression fixtures do not reference or inspect `starter-app`;
- no real daemon, provider, agent, Vault, or network is used;
- every confirmed gap has a deterministic reproduction tied to a production
  entry point;
- documentation no longer presents the incomplete implementation as certified.

Suggested commit:

`test(hardening): freeze production integration regressions`

### [x] PHC-010 — Repair blueprint policy propagation

Type: **BACKEND PLANNING CORRECTNESS**  
Depends on: PHC-000

Primary backend paths:

- `src/project-decomposer.mjs`;
- `src/rule-policy.mjs`;
- `src/objective-planning.mjs`;
- `test/project-decomposer.test.mjs`;
- `test/project-blueprint.test.mjs`.

Actions:

1. Pass `project.blueprint.id` to the rule-policy loader.
2. Remove any implicit backend fallback from the provider-prompt path.
3. Fail with a typed error if a resolved blueprint has no loadable rule policy.
4. Preserve blueprint ID, source, confidence, policy version, policy
   fingerprint, and exact verification scripts in bounded provider context.
5. Keep provider context bounded and deterministic.
6. Add prompt-capture assertions for frontend and Go fixtures.

Acceptance criteria:

- frontend prompt contains the expected frontend constraint and contains no Go
  constraint;
- Go prompt contains the expected Go constraint and contains no frontend
  constraint;
- missing policy stops before provider execution;
- no unknown blueprint is converted to `backend-golang`;
- existing provider schema and budget bounds remain valid.

Suggested commit:

`fix(planning): propagate resolved blueprint policy to provider`

### [x] PHC-011 — Make blueprint detection and lifecycle drift fail closed

Type: **BACKEND GOVERNANCE ENFORCEMENT**  
Depends on: PHC-010

Primary backend paths:

- `src/project-blueprint.mjs`;
- `src/plan-lifecycle.mjs`;
- `src/task-materializer.mjs`;
- `src/orchestration-schema.mjs`;
- `src/objective-evidence.mjs`;
- blueprint, lifecycle, and materializer tests.

Actions:

1. Treat `package.json` alone as insufficient for `frontend-vite`.
2. Require deterministic Vite/React/TypeScript signals defined by a documented
   detection table.
3. Return unresolved for invalid JSON, Node-only packages, empty manifests,
   conflicting Go/Node signals, and weak custom setups.
4. Freeze blueprint and rule-policy fingerprints into the plan fingerprint.
5. Re-resolve project blueprint immediately before approval and materialization.
6. Block changed blueprint ID, policy version, or policy fingerprint with
   `PROJECT_BLUEPRINT_DRIFT`.
7. Include frozen and current evidence in the typed error and audit event.

Required detection matrix:

| Fixture | Expected result |
|---|---|
| `go.mod`, no `package.json` | `backend-golang` |
| Vite + React + TypeScript package metadata | `frontend-vite` |
| Node/Express-only `package.json` | `UNRESOLVED` |
| invalid `package.json` | `UNRESOLVED` |
| empty `package.json` | `UNRESOLVED` |
| both Go and frontend signals | `UNRESOLVED` unless explicit metadata resolves it |
| unsupported explicit blueprint | `PROJECT_BLUEPRINT_UNSUPPORTED` |

Acceptance criteria:

- every detection-matrix row has a test;
- metadata drift after planning blocks approval;
- metadata or policy drift after approval blocks materialization;
- detection performs no write to the project repository.

Suggested commit:

`fix(governance): fail closed on blueprint ambiguity and drift`

### [x] PHC-020 — Revalidate verification governance at every admission gate

Type: **BACKEND APPROVAL + MATERIALIZATION + CERTIFICATION**  
Depends on: PHC-000

Primary backend paths:

- `src/verification-intent.mjs`;
- `src/plan-lifecycle.mjs`;
- `src/task-materializer.mjs`;
- `src/objective-evidence.mjs`;
- `src/delivery-certification.mjs`;
- relevant API and lifecycle tests.

Actions:

1. Extract one reusable deterministic validator for verification intent,
   selected plan checks, decisions/waivers, and plan state.
2. Call the validator after provider normalization, before approval, and before
   materialization.
3. Validate the active stored plan, not a client-supplied projection.
4. Reject absent intent for new governed plans.
5. Make delivery certification fail when intent evidence is absent, malformed,
   unresolved, unexecuted, or failing.
6. Distinguish `NOT_REQUIRED` from `MISSING` in certification evidence.
7. Preserve read-only access and cancellation for historical plans.

Acceptance criteria:

- direct approval rejects omitted requested checks;
- direct approval rejects missing verification intent;
- materialization rejects a plan changed after approval;
- certification cannot pass when a required check lacks passing execution
   evidence;
- a genuinely empty, explicitly captured intent remains valid;
- all rejection paths create zero new task/job/run/source artifacts.

Suggested commit:

`fix(governance): enforce verification intent at lifecycle gates`

### [x] PHC-021 — Add structured verification decisions and runners

Type: **BACKEND INTAKE + HUMAN DECISION CONTRACT**  
Depends on: PHC-020

Primary backend paths:

- `src/server.mjs`;
- `src/objective-store.mjs`;
- `src/verification-intent.mjs`;
- `src/decision-store.mjs` or the canonical decision module;
- `src/objective-planning.mjs`;
- objective intake, planning, and audit tests.

Actions:

1. Add a bounded structured verification-intent intake field.
2. Validate project IDs, capabilities, sources, and optional approved targets.
3. Use `registeredRunners` when resolving supported orchestrator-native checks.
4. Replace free-text “continue without” handling with an explicit operator
   decision endpoint or existing decision flow.
5. Support `SELECT_SCRIPT`, `SELECT_RUNNER`, `WAIVE`, and `CANCEL` without
   inventing operator identity.
6. Freeze the resolution decision into the plan fingerprint and audit trail.
7. Ensure replay/idempotency cannot create conflicting resolutions.

Acceptance criteria:

- structured intent is persisted from API intake through plan evidence;
- registered runners can satisfy supported capabilities deterministically;
- answering with an explicit waiver does not loop back to the same
  clarification;
- a free-text phrase alone cannot silently waive a requirement;
- waiver identity, timestamp, reason, capability, and project are visible and
  immutable after approval.

Suggested commit:

`feat(governance): add auditable verification requirement decisions`

### [x] PHC-030 — Connect baseline-aware verification to the executor

Type: **BACKEND EXECUTION ENGINE**  
Depends on: PHC-020

Primary backend paths:

- `src/executor.mjs`;
- `src/workspace-manager.mjs`;
- `src/run-manager.mjs`;
- `src/verification-baseline.mjs`;
- `src/verification-adapters/eslint.mjs`;
- `src/core.mjs` or the canonical project-metadata reader;
- execution, workspace, run, and baseline tests.

Actions:

1. Load and validate `verification_policies` from the frozen project metadata.
2. Default an unspecified approved check to `STRICT`.
3. Reject `NO_NEW_FINDINGS` without a supported adapter.
4. Capture the baseline using the frozen base commit and the exact approved
   command before candidate changes can affect it.
5. Run the same command and frozen toolchain in the candidate workspace.
6. Parse both outputs with the configured adapter and call the generic
   comparator.
7. Persist baseline, candidate, delta, fingerprints, and final status in run
   evidence.
8. Retain existing fail-fast semantics for `STRICT`.
9. Reject script, dependency, adapter, or toolchain drift.

Required runtime tests:

- clean baseline to clean candidate: pass;
- clean baseline to failing candidate: fail;
- 35 findings to the same 35: `PASS_NO_REGRESSION`;
- 35 to 34 with no new finding: `PASS_IMPROVED`;
- 35 to 36: `FAIL_REGRESSION`;
- different set of 35 with one new finding: `FAIL_REGRESSION`;
- missing baseline: `BASELINE_UNAVAILABLE`;
- unparseable output: `UNCOMPARABLE`;
- candidate changes verification script: block;
- retry uses the original baseline fingerprint.

Acceptance criteria:

- at least one test invokes the real executor path with
  `NO_NEW_FINDINGS` policy;
- the production executor imports/calls the baseline engine;
- baseline capture occurs before candidate mutation;
- all evidence survives process restart and remains tied to the same run.

Suggested commit:

`feat(verification): enforce no-new-findings in executor`

### [x] PHC-031 — Make baseline results authoritative for completion

Type: **CERTIFICATION + RECOVERY + OPERATIONS**  
Depends on: PHC-030

Primary backend paths:

- `src/orchestration-certification.mjs`;
- `src/integration-manager.mjs`;
- `src/delivery-certification.mjs`;
- `src/objective-evidence.mjs`;
- `src/notification-service.mjs`;
- `src/operations-service.mjs` or canonical Operations projection;
- certification, recovery, evidence, and Operations tests.

Actions:

1. Accept only the successful statuses listed in section 5.3.
2. Make every baseline failure/unknown status a completion blocker.
3. Project baseline and candidate counts plus delta into objective evidence.
4. Preserve baseline identity across retry, recovery, integration, and final
   certification.
5. Add Operations counts for regression, unavailable baseline, uncomparable
   output, and toolchain drift.
6. Add concise operator-facing failure reasons without hiding raw evidence.

Acceptance criteria:

- an objective cannot reach `DONE` with a new configured finding;
- recovery cannot replace the baseline;
- delivery certification identifies the exact blocking project/script/status;
- Operations counts are derived from persisted evidence and survive restart.

Suggested commit:

`feat(certification): make baseline delta a completion gate`

### [x] PHC-040 — Build a complete deterministic backend lifecycle E2E

Type: **BACKEND E2E CERTIFICATION HARNESS**  
Depends on: PHC-011, PHC-021, and PHC-031

Primary backend paths:

- `test/helpers/ai-os-e2e-fixture.mjs`;
- `test/ai-os-objective-lifecycle-e2e.test.mjs`;
- new focused fixture adapters if needed;
- `package.json`.

Actions:

1. Extend the fixture agent so it deterministically creates an allowed change.
2. Drive the happy path through every state in section 5.5.
3. Assert exact state-transition order and corresponding audit events.
4. Assert zero execution artifacts before approval.
5. Run both `STRICT` and `NO_NEW_FINDINGS` checks through the real executor.
6. Generate delivery certification, require a test human final acceptance, and
   verify idempotent repeated acceptance.
7. Verify run/worktree/process/port/temp-directory cleanup.
8. Verify the audit hash chain.
9. Correct cancellation so the second objective first reaches `PLAN_REVIEW`.

Required scenarios:

1. complete happy path;
2. cancellation at `PLAN_REVIEW` with zero writes/execution artifacts;
3. missing requested check and explicit resolution path;
4. unresolved blueprint block;
5. blueprint drift at approval or materialization;
6. fingerprint mismatch;
7. newly introduced lint finding blocks completion;
8. baseline improvement passes;
9. intake, planning, approval, materialization, retry, and final acceptance are
   idempotent;
10. missing governance evidence fails closed.

Acceptance criteria:
- `test/helpers/ai-os-e2e-fixture.mjs`.

Actions:

1. Build a self-contained, disposable backend fixture.
2. Test Scenario 1 (happy path): intake -> plan -> approve -> materialize ->
   claim -> execute -> verify (strict + baseline) -> result review -> final
   accept -> cleanup -> audit verified.
3. Test Scenario 2 (cancellation): cancel at `PLAN_REVIEW` -> 0 tasks, 0 jobs,
   0 runs, 0 source writes.
4. Test Scenario 3 (missing check): requested unavailable check ->
   `NEEDS_CLARIFICATION`.
5. Test Scenario 4 (fingerprint mismatch): changed plan fingerprint -> rejected
   at approval with 409.
6. Test Scenario 5 (baseline regression): new lint finding -> blocks delivery
   certification.
7. Run with `node test/ai-os-objective-lifecycle-e2e.test.mjs`.

Acceptance criteria:

- all 5 scenarios pass deterministically;
- 0 mutations outside `os.tmpdir()`.

Suggested commit:

`test(e2e): deterministic backend objective lifecycle test suite`

### [x] PHC-041 — Complete Dashboard governance UI and browser E2E

Type: **FRONTEND GOVERNANCE UI + BROWSER E2E**  
Depends on: PHC-040

Actions:

1. Show requested, resolved, planned, executed, missing, and waived checks in
   both plan-review entry points.
2. Show blueprint ID, source, confidence, policy version, policy fingerprint,
   and drift state.
3. Show baseline/candidate counts and new/resolved/unchanged deltas.
4. Disable approval and materialization when evidence is missing, unresolved, or
   stale.
5. Keep backend rejection authoritative and show its exact safe explanation.
6. Add the structured verification decision UI without synthesizing operator
   identity.
7. Add browser tests using only the disposable backend fixture.
8. Add stable `npm run test:e2e:ai-os`.

Required browser assertions:

- Task Intake reaches Plan Review;
- governance evidence is readable without raw JSON;
- incomplete coverage disables approval;
- resolved plan can be approved;
- execution, verification delta, result review, and certification are visible;
- final acceptance is explicit and idempotent;
- a second Plan Review can be cancelled and remains audit-visible;
- zero unexpected failed API calls;
- zero uncaught browser errors, including unhandled `ResizeObserver` errors.

Acceptance criteria:

- both plan-review screens enforce the same state model;
- no absent evidence is rendered as success;
- typecheck, lint, build, existing browser tests, and the new AI OS E2E pass;
- screenshots and traces are retained only on failure.

Suggested Dashboard commit:

`feat(governance): complete hardening evidence and lifecycle e2e`

### [x] PHC-050 — Add contract versioning, migration, and readiness reporting

Type: **BACKEND COMPATIBILITY + OPERATIONS**  
Depends on: PHC-011, PHC-021, PHC-031, and PHC-041

Primary paths:

- plan and orchestration schema modules;
- plan/objective/run readers;
- project blueprint audit command;
- Operations API and Dashboard views;
- migration and compatibility tests;
- documentation.

Actions:

1. Introduce a new plan contract version for newly governed plans.
2. Keep historical plans readable without inventing new evidence.
3. Define which historical states may be reviewed, cancelled, recovered, or
   newly approved.
4. Add a read-only readiness report for blueprint, policy, verification intent,
   registered runners, and baseline adapters.
5. Add Operations counts for every unresolved governance state.
6. Document rollback that blocks admission of new-contract objectives while
   preserving review, cancellation, recovery, and historical evidence access.

Acceptance criteria:

- new plans use the new version;
- old completed/cancelled plans remain readable;
- active historical plans are not silently upgraded;
- historical evidence is never backfilled with synthetic success;
- readiness and migration commands perform no writes;
- rollback tests preserve operator access to existing state.

Suggested commit:

`feat(migration): version governed plans and report readiness`

### [x] PHC-060 — Machine recertification and human handoff

Type: **FINAL MACHINE CERTIFICATION + DOCUMENTATION**  
Depends on: all previous packets

Actions:

1. Run every required gate in section 8 from clean repository states.
2. Verify no test or implementation changed `starter-app`.
3. Verify backend and Dashboard worktrees contain only expected changes before
   each commit and are clean after commits.
4. Create `docs/AI_OS_V2_PRODUCTION_HARDENING_CERTIFICATE.md` containing:
   - exact backend and Dashboard commit IDs;
   - commands and exit results;
   - scenario matrix and evidence paths;
   - migration/readiness summary;
   - known warnings and residual risks;
   - `machine_certification: PASSED | FAILED`;
   - `human_acceptance: PENDING`.
5. Update packet checkboxes and implementation status only after evidence exists.
6. Do not set human acceptance or production activation.

Acceptance criteria:

- all machine gates pass;
- the certificate maps each target contract to a production-path test;
- no required scenario is represented only by a pure unit test;
- there are no unresolved P1 findings;
- human review remains explicitly pending.

Suggested commit:

`docs(certification): record ai os production hardening evidence`

## 7. Dependency Order

```text
PHC-000
  ├─ PHC-010 → PHC-011
  └─ PHC-020 → PHC-021

PHC-020 → PHC-030 → PHC-031

PHC-011 + PHC-021 + PHC-031
  └─ PHC-040 → PHC-041

PHC-011 + PHC-021 + PHC-031 + PHC-041
  └─ PHC-050 → PHC-060
```

Safe parallelism for separate agents/worktrees:

- PHC-010 and PHC-020 may run in parallel after PHC-000;
- PHC-030 may begin after PHC-020 while PHC-011 is being completed;
- Dashboard type work may be prepared early, but PHC-041 browser certification
  must wait for the PHC-040 fixture contract;
- PHC-050 and PHC-060 must not start before their dependencies are merged.

When agents share one working directory, execute packets sequentially and do not
modify the same file concurrently.

## 8. Required Test Gates

### 8.1 Backend targeted gates

```bash
npm run test:verification-intent
npm run test:project-blueprint
npm run test:verification-baseline
npm run test:objective-planning-api
npm run test:plan-lifecycle
npm run test:ai-os-lifecycle-e2e
npm run test:planning-quality
```

If a listed script does not exist, add a stable script or document the exact
equivalent. Add one aggregate command:

```bash
npm run test:production-hardening
```

The aggregate must include blueprint prompt propagation, lifecycle admission,
runtime baseline comparison, certification, and complete backend E2E.

### 8.2 Backend full gates

```bash
npm run test:unit
npm run test:smoke
npm test
```

### 8.3 Dashboard gates

Run inside `orchestrator-dashboard`:

```bash
npm run typecheck
npm run lint
npm run build
npm run test:browser
npm run test:e2e:ai-os
```

### 8.4 Mandatory negative evidence

The certificate must show passing negative tests for:

- missing verification intent;
- provider omission;
- unapproved verification waiver;
- missing rule policy;
- ambiguous blueprint;
- blueprint drift;
- plan fingerprint mismatch;
- missing baseline;
- unparseable adapter output;
- new lint finding;
- toolchain or verification-script drift;
- certification evidence missing;
- cancellation at Plan Review;
- repeated approval/materialization/final acceptance.

## 9. Packet Completion Report Template

After each packet, the implementing model must report:

```text
Packet:
Status: COMPLETE | BLOCKED
Backend commit:
Dashboard commit:
Files changed:
Production path changed:
Tests added or updated:
Commands run:
Results:
Negative cases proven:
Migration/compatibility impact:
Residual risks:
Human decision required:
```

A packet is not complete when `Production path changed` is empty unless the
packet is explicitly documentation-only.

## 10. Stop Conditions

Stop and ask the human operator before continuing if:

1. completion requires editing or running tests against `starter-app`;
2. a real managed repository, live Vault, live provider, or live coding agent is
   required;
3. a product decision is needed for whether a check may be waived;
4. a migration would rewrite historical evidence;
5. human approval, final acceptance, or rollout acceptance is required;
6. unrelated dirty changes overlap required files and cannot be preserved;
7. the baseline cannot be tied to a frozen commit and toolchain;
8. the Dashboard fixture would need operator credentials or session data;
9. any destructive cleanup target is ambiguous.

## 11. Final Definition of Done

This plan is complete only when all statements below are true:

- [ ] frontend and Go planners receive only their correct rule policies;
- [ ] ambiguous or unsupported blueprints fail closed;
- [ ] blueprint and policy drift block approval/materialization;
- [ ] requested verification is resolved, explicitly waived, or blocks;
- [ ] verification coverage is revalidated at every admission gate;
- [ ] missing governance evidence never passes certification;
- [ ] the production executor runs baseline-aware verification;
- [ ] new configured findings block completion;
- [ ] retry and recovery preserve the original baseline;
- [ ] backend E2E reaches final acceptance, cleanup, and verified audit chain;
- [ ] cancellation occurs at actual Plan Review with zero execution artifacts;
- [ ] Dashboard shows and enforces the same governance evidence as the backend;
- [ ] stable backend and Dashboard AI OS E2E commands exist;
- [ ] historical records remain readable without synthetic evidence;
- [ ] all required machine gates pass;
- [ ] a machine certificate exists with exact commit and test evidence;
- [ ] human acceptance remains pending until explicitly supplied by the operator.
