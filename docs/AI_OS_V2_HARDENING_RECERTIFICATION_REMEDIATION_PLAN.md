# AI OS v2 — Hardening Recertification Remediation Plan

Status: **IMPLEMENTATION COMPLETE — MACHINE RECERTIFIED (HUMAN ACCEPTANCE PENDING)**  
Plan date: **2026-09-01 (Asia/Jakarta)**  
Owner and final approver: **Human operator**  
Primary repositories: **personal-ai-orchestrator** and **orchestrator-dashboard**  
Backend review baseline: **`022825d`**  
Dashboard review baseline: **`31432e1`**  
Human acceptance: **PENDING**  
Explicit exclusion: **Do not edit, commit, clean, reset, inspect via automated tests, or otherwise mutate `starter-app`**

## 1. Objective

Repair the remaining production-hardening defects found after implementation of:

- `AI_OS_V2_PLANNING_QUALITY_AND_E2E_HARDENING_PLAN.md`; and
- `AI_OS_V2_PRODUCTION_HARDENING_COMPLETION_PLAN.md`.

The implementation must make the machine certification truthful. It must not
merely make the existing tests green or update documentation status.

Required outcome:

> A governed objective cannot be approved, materialized, executed, completed, or
> certified when verification intent, blueprint policy, baseline evidence,
> parsing evidence, or lifecycle evidence is missing, unresolved, stale,
> simulated, or inconsistent.

## 2. Authority and Current Status

This remediation plan is the authoritative work list for the remaining gaps.
Until RHC-070 is complete:

- the implementation is not machine-certified;
- the rollout recommendation is not `PRODUCTION_CANDIDATE`;
- the previous hardening certificate is review evidence, not a valid release
  certificate;
- human acceptance remains pending;
- existing controlled-development use may continue only with operator
  supervision.

The implementing model must not change these statements before the required
machine evidence exists.

## 3. Confirmed Defects

The following defects were reproduced against the review baselines.

### 3.1 Verification parser can fail open

An unparseable ESLint candidate output is converted to an empty findings list.
When the baseline contains findings, the comparator can incorrectly return
`PASS_IMPROVED` even when the candidate command exits non-zero.

Confirmed production paths:

- `src/verification-adapters/eslint.mjs`;
- `src/verification-baseline.mjs`;
- `src/executor.mjs`.

### 3.2 Baseline data is not captured by the production lifecycle

The executor reads `execution.baselineVerification`, but no production path
creates it. `verification_policies` is also not propagated into the normal run
manifest created by the Vault task watcher/run manager.

Current result:

- normal runs silently use `STRICT`; or
- manually injected `NO_NEW_FINDINGS` runs block with no baseline.

### 3.3 Verification admission remains fail-open

`validateVerificationCoverage` currently treats these inputs as valid:

- missing intent;
- `resolved=[]` with unresolved `missing` entries;
- `NEEDS_CLARIFICATION` intent with no resolved scripts.

Approval and materialization also skip validation entirely when intent is
absent.

### 3.4 Blueprint fingerprint is not tied to the policy used by planning

Objective planning resolves the blueprint without `vaultRoot`, so the frozen
fingerprint is computed from embedded fallback rules. The decomposer and
materializer may use a custom Vault policy. A valid custom policy can therefore
look like drift without changing.

Blueprint drift is checked only during materialization, not before approval.
Blueprint detection also accepts Vite alone or React + TypeScript without Vite,
which is weaker than the documented high-confidence contract.

### 3.5 Structured verification decisions are absent

The following required actions do not exist in the production contract:

- `SELECT_SCRIPT`;
- `SELECT_RUNNER`;
- `WAIVE`;
- `CANCEL` as a verification-requirement resolution.

`registeredRunners` is unused, and structured verification intent is not
persisted from intake through the objective and plan lifecycle.

### 3.6 Governed plan versioning is absent

New plans still use `schemaVersion: 1`, and verification intent still uses
`contractVersion: 1`. The system cannot reliably distinguish a governed plan
that must fail closed from a historical readable plan.

### 3.7 Backend lifecycle E2E simulates completion

The lifecycle test manually writes a run manifest with `DONE`,
`PASS_NO_REGRESSION`, and `FAIL_REGRESSION`. It does not run the fixture agent,
production executor, baseline capture, candidate comparison, or real result
review path.

### 3.8 Dashboard governance is display-only and incompletely tested

The Task Intake approval condition does not fail closed on missing/unresolved
governance evidence. Dashboard tests do not provide or assert blueprint,
verification-intent, waiver, drift, or baseline-delta evidence. The AI OS E2E
command only aliases existing specs. Browser runs still log unhandled
`ResizeObserver` errors.

### 3.9 Certification artifacts overstate completion

The current completion plan marks every packet complete while its final
Definition of Done remains unchecked. The certificate claims contract version
2 and production-path coverage that do not exist.

## 4. Non-Negotiable Implementation Rules

1. Do not touch `starter-app` for inspection, fixtures, test execution, cleanup,
   or status comparison.
2. Use only OS-temporary repositories, Vaults, run roots, ports, worktrees, and
   processes in automated E2E tests.
3. Do not call a live model, provider, coding agent, external network, or
   operator-owned service from automated tests.
4. The deterministic fixture adapter must invoke the same production entry
   points as a real run. It may fake process results, but it may not write run or
   certification outcomes directly.
5. Missing, unknown, malformed, stale, unparseable, or unsupported evidence must
   block. Never default it to an empty successful collection.
6. The backend is authoritative. Dashboard checks are defense-in-depth and
   explanation, not the sole blocker.
7. Never invent operator identity, approval, waiver, final acceptance, or human
   rollout acceptance.
8. Do not rewrite or backfill historical records with synthetic evidence.
9. Preserve unrelated changes and operator-owned dirty files.
10. Do not weaken, remove, duplicate, or rewrite acceptance criteria to match a
    partial implementation. Any proposed scope change requires explicit human
    approval before code changes continue.
11. A packet may be checked complete only after its production-path test and all
    mandatory negative cases pass.
12. A green aggregate test command is not certification when required scenarios
    are absent from that command.
13. Keep backend and Dashboard changes in separate commits. Prefer one reviewable
    backend commit per completed packet.
14. Human acceptance remains pending after machine recertification.

## 5. Target Contracts

### 5.1 Parse-result contract

Adapters must distinguish valid empty findings from unparseable output.

Suggested shape:

```json
{
  "adapter": "eslint",
  "status": "PARSED | UNPARSEABLE | UNSUPPORTED",
  "format": "ESLINT_JSON | ESLINT_STYLISH | NONE",
  "findings": [],
  "rawFingerprint": "<sha256>",
  "reason": null
}
```

Rules:

- valid ESLint JSON `[]` is parsed success with zero findings;
- empty output is not automatically parsed success for a machine-readable
  `NO_NEW_FINDINGS` command;
- malformed or truncated JSON must not silently fall back to an empty text
  parse;
- text fallback is successful only when the expected formatter is explicitly
  configured and the structure is recognized;
- unsupported adapter returns `UNSUPPORTED`;
- candidate exit code non-zero plus no parseable findings is `UNCOMPARABLE`;
- `UNPARSEABLE`, `UNSUPPORTED`, and `UNCOMPARABLE` block execution and
  certification.

### 5.2 Frozen verification-policy contract

At run preparation/claim, freeze the project verification policy used by the
approved plan:

```json
{
  "script": "lint",
  "command": "npm run lint -- --format json",
  "mode": "NO_NEW_FINDINGS",
  "adapter": "eslint",
  "adapterVersion": 1,
  "policyFingerprint": "<sha256>",
  "toolchainFingerprint": "<sha256>"
}
```

The same command, adapter, policy, dependency identity, and toolchain identity
must be used for baseline and candidate comparison.

### 5.3 Baseline capture contract

Baseline capture must occur before candidate mutation and outside the
operator-owned checkout. Use an isolated worktree or equivalent immutable
snapshot at the frozen base commit.

Persist:

- base commit;
- command and script name;
- policy, adapter, dependency, and toolchain fingerprints;
- exit code;
- parse result;
- normalized findings and findings fingerprint;
- capture timestamp and source workspace identity.

Candidate evidence must contain the same fields plus new/resolved/unchanged
delta and final status.

### 5.4 Governed verification-intent contract

For a new governed plan:

- intent must exist;
- intent contract version must be supported;
- status must be `RESOLVED` or `RESOLVED_WITH_WAIVERS`;
- every required item must have exactly one resolved script, runner, or approved
  waiver;
- every resolved script/runner must appear in the plan and later have passing
  execution evidence;
- `missing` must be empty before approval;
- waivers must contain immutable authenticated operator evidence.

An explicitly captured intent with `required=[]`, `resolved=[]`, `missing=[]`,
and `status=RESOLVED` is valid. An absent intent is not equivalent.

### 5.5 Blueprint and rule-policy contract

The same policy object must be used for:

1. provider prompt constraints;
2. frozen plan evidence and fingerprint;
3. approval-time drift comparison;
4. materialization-time drift comparison;
5. task/run evidence.

Use the actual policy version instead of hardcoding version 1. A supported
blueprint whose policy cannot be loaded is invalid.

High-confidence frontend detection requires all documented signals:

- Vite;
- React;
- TypeScript.

Weaker or conflicting signals return `UNRESOLVED` unless explicit supported
metadata is authoritative.

### 5.6 Governed plan version contract

Introduce a new supported plan schema/contract version for newly generated
governed plans. Define explicit compatibility behavior:

| Record | Read | Cancel | Recover | Newly approve/materialize |
|---|---|---|---|---|
| historical v1 completed/cancelled | yes | when applicable | read-only policy | no new governance claim |
| active historical v1 | yes | yes | only documented safe recovery | no silent upgrade |
| governed v2 complete evidence | yes | yes | yes | yes |
| governed v2 missing evidence | yes | yes | no execution admission | no |

Do not modify historical records in place.

### 5.7 Real E2E evidence contract

The test may use a deterministic process runner, but the following must be
created by production code:

- run manifest and transitions;
- baseline capture;
- candidate verification;
- comparison result;
- executor completion/failure state;
- objective/run evidence;
- certification result;
- cleanup result;
- audit events.

The test must not directly write any of those final states.

## 6. Implementation Packets

### [x] RHC-000 — Invalidate premature certification and freeze defects

Type: **GOVERNANCE STATUS + REGRESSION TESTS**  
Depends on: none

Primary backend paths:

- `docs/AI_OS_V2_PRODUCTION_HARDENING_COMPLETION_PLAN.md`;
- `docs/AI_OS_V2_PRODUCTION_HARDENING_CERTIFICATE.md`;
- `test/planning-quality-regressions.test.mjs`;
- new focused remediation tests.

Actions:

1. Change the previous completion plan to a truthful superseded or
   certification-blocked status.
2. Mark the previous certificate as invalidated by this review. Preserve it as
   historical evidence; do not delete it.
3. Preserve the original acceptance criteria. Remove duplicated/malformed
   sections only when no requirement is lost.
4. Add deterministic regression tests proving:
   - unparseable candidate currently produces false success;
   - missing and unresolved intent currently validate successfully;
   - custom Vault policy fingerprint differs between planning and
     materialization;
   - normal run manifests currently omit verification policy/baseline evidence;
   - Dashboard governance fields are absent from existing E2E fixtures.
5. Confirm both repositories and fixtures remain independent from
   `starter-app`.

Acceptance criteria:
- `docs/AI_OS_V2_PRODUCTION_HARDENING_COMPLETION_PLAN.md`;
- regression test files under `test/`.

Actions:

1. Update the status of `AI_OS_V2_PRODUCTION_HARDENING_CERTIFICATE.md` to
   `INVALIDATED (HISTORICAL ONLY)`.
2. Update the status of `AI_OS_V2_PRODUCTION_HARDENING_COMPLETION_PLAN.md` to
   `SUPERSEDED`.
3. Add the exact defect reproducer tests from section 3 under `test/` or in a
   dedicated reproducer suite.
4. Verify that these tests fail against the baseline before any fix is applied.
5. Create this document as the single active plan.

Acceptance criteria:

- no active document claims `PRODUCTION_CANDIDATE` or completed certification;
- reproduction tests exist and can be run independently;
- the baseline commit hashes for backend and Dashboard are recorded.

Suggested commit:

`docs(governance): invalidate premature v2 hardening certification`

### [x] RHC-010 — Make adapter parsing fail closed

Type: **BACKEND VERIFICATION SAFETY**  
Depends on: RHC-000

Primary backend paths:

- `src/verification-adapters/eslint.mjs`;
- `src/verification-baseline.mjs`;
- `src/executor.mjs`;
- adapter and baseline tests.

Actions:

1. Replace bare findings-array returns with the parse-result contract.
2. Make the comparator require successful parse evidence for baseline and
   candidate.
3. Reject unsupported adapters explicitly.
4. Reject malformed, truncated, mixed JSON/stderr, unexpected text, and empty
   non-JSON output.
5. Keep valid JSON `[]` distinguishable from failed parsing.
6. Use an explicit formatter contract; do not concatenate stderr into JSON
   before parsing.
7. Persist a safe raw-output fingerprint and bounded diagnostic, not unlimited
   raw output.

Required negative tests:

- malformed JSON with exit code 1 -> `UNCOMPARABLE`;
- truncated JSON -> `UNCOMPARABLE`;
- unsupported adapter -> `ADAPTER_UNAVAILABLE`;
- valid JSON followed by stderr text -> parse JSON stdout safely or block;
- empty output with non-zero exit -> block;
- arbitrary prose -> block;
- valid `[]` with the approved formatter -> zero findings;
- baseline parse failure -> `BASELINE_UNAVAILABLE` or `UNCOMPARABLE`, never pass.

Acceptance criteria:

- the reproduced false `PASS_IMPROVED` case fails closed;
- only explicit successful statuses can pass executor and certification;
- parser and comparator APIs make parse failure impossible to confuse with zero
  findings.

Suggested commit:

`fix(verification): fail closed on unparseable findings`

### [x] RHC-020 — Capture and enforce real frozen baselines

Type: **BACKEND RUN LIFECYCLE + EXECUTOR**  
Depends on: RHC-010

Primary backend paths:

- `src/adapters/vault-task-watcher.mjs`;
- `src/run-manager.mjs`;
- `src/workspace-manager.mjs`;
- `src/executor.mjs`;
- project metadata/context readers;
- `src/objective-evidence.mjs`;
- `src/delivery-certification.mjs`;
- `src/orchestration-certification.mjs`;
- Operations projection modules;
- run, executor, recovery, evidence, and certification tests.

Actions:

1. Read and validate verification policies from the authoritative project page.
2. Freeze policies, commands, adapters, policy fingerprint, dependency identity,
   and toolchain identity into the run at claim.
3. Capture the base commit before candidate workspace mutation.
4. Create an isolated baseline snapshot/worktree under the run-owned temporary
   workspace root.
5. Execute the frozen check in that snapshot and persist parse evidence.
6. Execute the same frozen check in the candidate workspace.
7. Compare the two finding sets and persist immutable delta evidence.
8. Clean the baseline snapshot in both success and failure paths.
9. Preserve baseline identity across retry/recovery; never recapture from the
   candidate.
10. Surface the exact script and blocker status in objective, certification, and
    Operations evidence.

Required runtime scenarios:

| Baseline | Candidate | Expected |
|---|---|---|
| clean | clean | `PASS` or `PASS_NO_REGRESSION` |
| clean | one finding | `FAIL_REGRESSION` |
| 35 findings | same 35 | `PASS_NO_REGRESSION` |
| 35 findings | 34, none new | `PASS_IMPROVED` |
| 35 findings | 36 | `FAIL_REGRESSION` |
| 35 findings | different set of 35 | `FAIL_REGRESSION` |
| unavailable | any | `BASELINE_UNAVAILABLE` |
| parse failure | any | block |
| toolchain drift | any | `TOOLCHAIN_DRIFT` |
| command/policy drift | any | block |

Acceptance criteria:

- a normal objective-created run contains frozen verification policies;
- baseline evidence is created by production run/claim/executor code;
- at least one test invokes the real executor path end-to-end;
- retry reads the original baseline fingerprint;
- restart preserves baseline and candidate evidence;
- no source checkout or operator-owned path is mutated during baseline capture.

Suggested commit:

`feat(verification): capture immutable runtime baselines`

### [x] RHC-030 — Enforce governed admission and correct blueprint identity

Type: **BACKEND PLANNING + APPROVAL + MATERIALIZATION**  
Depends on: RHC-000

Primary backend paths:

- `src/verification-intent.mjs`;
- `src/objective-planning.mjs`;
- `src/project-blueprint.mjs`;
- `src/project-decomposer.mjs`;
- `src/plan-lifecycle.mjs`;
- `src/task-materializer.mjs`;
- `src/orchestration-schema.mjs`;
- `src/delivery-certification.mjs`;
- corresponding API, planning, lifecycle, and materializer tests.

Actions:

1. Implement one reusable governed-plan validator.
2. Make missing intent invalid for the new governed contract.
3. Reject any non-empty `missing` array or unsupported status.
4. Verify exact coverage for every resolved script/runner.
5. Invoke the validator after provider normalization, before approval, before
   materialization, and before certification.
6. Pass `vaultRoot` into planning blueprint resolution.
7. Load the actual policy once per validation step, verify it exists, and derive
   version/fingerprint from that policy.
8. Re-resolve blueprint and policy before both approval and materialization.
9. Block ID, source-authority, policy version, or policy fingerprint drift with
   `PROJECT_BLUEPRINT_DRIFT`.
10. Use the injected document reader consistently in testable paths.
11. Tighten detection to the documented Vite + React + TypeScript matrix.

Required admission tests:

- missing intent -> approval rejected;
- `NEEDS_CLARIFICATION` with missing E2E -> rejected;
- explicitly empty resolved intent -> accepted;
- resolved script omitted by plan -> rejected;
- malformed intent -> rejected;
- custom Vault policy plan/approval/materialization fingerprint remains stable;
- custom policy change after planning -> approval rejected;
- custom policy change after approval -> materialization rejected;
- missing policy -> planning rejected;
- Vite-only, React+TS-only, invalid, empty, Node-only, and mixed manifests ->
  unresolved;
- Vite+React+TS -> frontend;
- Go-only -> backend.

Acceptance criteria:

- no missing/unknown governance evidence can pass any admission gate;
- planning, prompt, fingerprint, approval, and materialization use the same
  policy source;
- rejected admission creates zero tasks, jobs, runs, worktrees, or source
  writes;
- typed error details include frozen and current evidence without secrets.

Suggested commit:

`fix(governance): enforce intent and blueprint at every gate`

### [x] RHC-040 — Add structured verification decisions and governed plan v2

Type: **BACKEND CONTRACT + MIGRATION**  
Depends on: RHC-030

Primary backend paths:

- `src/server.mjs`;
- `src/objective-store.mjs`;
- `src/decision-store.mjs`;
- `src/verification-intent.mjs`;
- `src/objective-planning.mjs`;
- plan/orchestration schema and store modules;
- objective evidence and certification modules;
- migration, intake, decision, planning, and idempotency tests.

Actions:

1. Add bounded structured verification intent to objective intake.
2. Validate capability, project, source, and requested target fields.
3. Implement registered-runner resolution.
4. Add an authenticated decision endpoint or canonical decision workflow for:
   - `SELECT_SCRIPT`;
   - `SELECT_RUNNER`;
   - `WAIVE`;
   - `CANCEL`.
5. Require operator-supplied reason for waiver and alternative selection.
6. Persist resolution identity, timestamp, nonce/idempotency evidence, project,
   capability, and target.
7. Include decisions/waivers in plan fingerprint, objective evidence,
   certification, and audit trail.
8. Prevent free-text clarification from silently creating a waiver.
9. Introduce the new governed plan version and intent contract version.
10. Implement the compatibility table in section 5.6.
11. Add read-only readiness reporting for blueprint, policy, adapters, scripts,
    runners, and contract readiness.
12. Add Operations counts for incomplete/unresolved governed records.

Acceptance criteria:

- structured intent persists from API intake through execution evidence;
- registered runner resolves at least one deterministic test capability;
- each decision action has positive, authorization, validation, audit, and
  idempotency tests;
- repeated resolution cannot create conflicting decisions;
- new plans use the governed version;
- old records remain readable without fabricated evidence;
- active old records are not silently upgraded or newly certified;
- readiness reporting performs no writes.

Suggested commit:

`feat(governance): add plan v2 and verification decisions`

### [x] RHC-050 — Replace simulated backend E2E with production-path E2E

Type: **BACKEND E2E CERTIFICATION HARNESS**  
Depends on: RHC-020 and RHC-040

Primary backend paths:

- `test/helpers/ai-os-e2e-fixture.mjs`;
- `test/ai-os-objective-lifecycle-e2e.test.mjs`;
- new deterministic fixture process/agent adapter;
- `package.json`.

Fixture design:

1. Create a disposable Git repository and Vault under `os.tmpdir()`.
2. Create a deterministic lint command that emits valid ESLint JSON based on
   fixture source content; do not install packages or use network.
3. Use a deterministic process runner that is injected into the production
   executor entry point.
4. The fixture coding-agent stage may edit only the allowed fixture file.
5. Run manager, claim, workspace, executor, evidence, certification, cleanup,
   and audit modules must create their own persisted state.
6. The test must not write final run state, verification status, baseline delta,
   orchestration completion, or certificate outcomes directly.

Required happy path:

```text
intake
  -> plan
  -> assert zero execution artifacts
  -> approve exact fingerprint
  -> materialize
  -> scheduler queue
  -> claim
  -> baseline capture
  -> fixture agent change
  -> strict + baseline candidate verification
  -> result review
  -> delivery certification ready
  -> explicit final acceptance
  -> cleanup
  -> audit chain verification
```

Required negative scenarios:

1. missing/unresolved intent;
2. unapproved and approved waiver paths;
3. unresolved blueprint;
4. custom-policy drift before approval;
5. custom-policy drift before materialization;
6. fingerprint mismatch;
7. missing baseline;
8. unparseable baseline output;
9. unparseable candidate output;
10. one new lint finding;
11. baseline improvement;
12. toolchain or command drift;
13. cancellation at actual `PLAN_REVIEW` with zero execution artifacts;
14. idempotent intake, planning, approval, materialization, retry, and final
    acceptance;
15. cleanup on agent, verification, and certification failure;
16. persisted audit event order and valid hash chain.

Acceptance criteria:

- the production executor is imported and invoked by the E2E;
- source change and verification result are generated during the test, not
  prewritten;
- the happy path reaches final accepted terminal state;
- every negative scenario fails at the intended boundary;
- temporary processes, ports, worktrees, and directories are cleaned and
  asserted;
- add a dedicated command such as `npm run test:ai-os-lifecycle-e2e` and include
  it in `test:production-hardening`.

Suggested commit:

`test(e2e): exercise real ai os execution and baseline lifecycle`

### [x] RHC-060 — Complete Dashboard governance and dedicated browser E2E

Type: **DASHBOARD UI + BROWSER E2E**  
Depends on: RHC-040 and RHC-050

Primary Dashboard paths:

- `src/services/orchestrator.ts`;
- `src/pages/Tasks/components/PlanReviewPanel.tsx`;
- `src/pages/Objectives/components/ObjectivePlanGate.tsx`;
- objective evidence and delivery-certification components;
- clarification/decision UI;
- new governance-specific Playwright fixture/spec;
- `package.json`.

Actions:

1. Centralize a fail-closed plan-admission view model used by both approval
   screens.
2. Disable approval/materialization for missing intent, unresolved checks,
   invalid/drifted blueprint, missing baseline readiness, or unsupported
   contract version.
3. Display requested, resolved, planned, executed, missing, and waived checks.
4. Display blueprint ID, source, confidence, policy version/fingerprint, and
   drift state.
5. Display baseline/candidate counts, new/resolved/unchanged delta, and parse
   status.
6. Add authenticated structured decision UI without synthesizing identity.
7. Show backend rejection details in safe plain language.
8. Add governance fields to the Playwright fixture.
9. Add assertions for every newly displayed field and blocked/unblocked button
   state.
10. Fix, prevent, or explicitly and narrowly classify the observed
    `ResizeObserver` error. The final AI OS E2E must have zero unhandled errors.
11. Make `test:e2e:ai-os` run a dedicated governance lifecycle spec, not only an
    alias of legacy specs.

Required browser scenarios:

- incomplete intent visibly blocks approval;
- resolved intent enables approval;
- approved waiver is visible and auditable;
- invalid/drifted blueprint visibly blocks approval;
- baseline readiness and final delta are visible;
- new finding shows failure and prevents final completion;
- result review and final acceptance are explicit and idempotent;
- Plan Review cancellation remains audit-visible;
- zero unexpected API failures;
- zero uncaught browser errors.

Acceptance criteria:

- both approval screens share the same admission rules;
- missing evidence is never rendered as success;
- Playwright actually renders and asserts the new governance fixtures;
- `typecheck`, `lint`, `build`, `test:browser`, and dedicated
  `test:e2e:ai-os` pass.

Suggested Dashboard commit:

`feat(governance): enforce and test hardened plan evidence`

### [x] RHC-070 — Recertify from production-path evidence

Type: **MACHINE RECERTIFICATION + HUMAN HANDOFF**  
Depends on: all previous packets

Actions:

1. Run every gate in section 8 from clean backend and Dashboard worktrees.
2. Confirm all required negative scenarios are part of the executed commands.
3. Confirm no E2E directly writes final outcomes that production code should
   create.
4. Confirm no test or implementation accesses `starter-app`.
5. Confirm all temporary resources are cleaned.
6. Create a new recertification certificate containing:
   - exact backend implementation commit IDs;
   - exact Dashboard implementation commit IDs;
   - exact command, date, duration, and exit result;
   - scenario-to-test mapping;
   - production entry point exercised by each scenario;
   - evidence paths/checksums where applicable;
   - compatibility/readiness result;
   - warnings and residual risks;
   - `machine_certification: PASSED | FAILED`;
   - `human_acceptance: PENDING`.
7. Mark packet checkboxes and Final Definition of Done only when backed by that
   certificate.
8. Keep rollout activation and human acceptance unchanged.

Acceptance criteria:

- all RHC packets and final checklist items have evidence;
- no unresolved P1 finding remains;
- the certificate references implementation commits, not only old baselines;
- no certificate claim relies only on a pure helper test;
- a reviewer can trace every certification claim to a production-path test;
- human acceptance remains pending.

Suggested commit:

`docs(certification): record ai os hardening recertification`

## 7. Dependency Order and Safe Parallelism

```text
RHC-000
  ├─ RHC-010 → RHC-020
  └─ RHC-030 → RHC-040

RHC-020 + RHC-040
  └─ RHC-050 → RHC-060 → RHC-070
```

Safe parallel work, only with separate worktrees:

- RHC-010 and RHC-030 may run in parallel after RHC-000;
- RHC-020 may run while RHC-040 is developed;
- RHC-050 must wait for both chains;
- Dashboard implementation may prepare type/view-model changes early, but its
  browser fixture and certification must wait for the backend v2 contract;
- RHC-070 is strictly last.

When agents share a working directory, execute packets sequentially. Never let
two agents modify the same repository files concurrently.

## 8. Required Gates

### 8.1 Backend focused gates

The implementing model must add stable focused scripts where they do not exist:

```bash
npm run test:verification-parser
npm run test:verification-baseline
npm run test:verification-intent
npm run test:project-blueprint
npm run test:plan-lifecycle
npm run test:objective-planning-api
npm run test:ai-os-lifecycle-e2e
npm run test:production-hardening
```

`test:production-hardening` must include:

- parser fail-closed tests;
- real baseline capture/executor tests;
- governed admission tests;
- custom policy fingerprint/drift tests;
- structured decision and migration tests;
- complete production-path lifecycle E2E;
- delivery and orchestration certification tests.

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
npm run test:security
npm run test:browser
npm run test:e2e:ai-os
npm run test:verify
```

The final Dashboard output must contain no unexpected browser/page/server
errors. Existing lint warnings must be documented and must not increase.

## 9. Mandatory Evidence Matrix

| Claim | Required production-path proof |
|---|---|
| Parser fails closed | executor receives malformed output and blocks |
| Baseline is immutable | claim captures base; retry uses same fingerprint |
| No new findings | real candidate change produces comparator delta |
| Intent is mandatory | direct API approval/materialization rejects missing intent |
| Waiver is human-owned | authenticated decision, audit, fingerprint, UI evidence |
| Policy is consistent | prompt/fingerprint/approval/materialization use same custom policy |
| Blueprint drift blocks | metadata/policy change rejected before execution |
| Plan v2 compatibility | v1 readable; v1 not silently upgraded; v2 fail-closed |
| Lifecycle is complete | executor through final acceptance, cleanup, audit chain |
| Dashboard is authoritative-looking but not authoritative | UI blocks and backend independently rejects |
| Certification is truthful | exact commits and scenario mapping in certificate |

## 10. Packet Handoff Template

After every packet, the implementing agent must report:

```text
Packet:
Status: COMPLETE | BLOCKED
Repository:
Commit:
Files changed:
Production entry points changed:
Contract/schema impact:
Migration impact:
Tests added or changed:
Commands run:
Exit results:
Negative scenarios proven:
Temporary-resource cleanup evidence:
Residual risks:
Human decision required:
Next unblocked packet:
```

If `Production entry points changed` is empty for a non-documentation packet,
the packet is not complete.

## 11. Stop Conditions

Stop and request operator direction if:

1. work would access or modify `starter-app`;
2. a live provider, coding agent, network, Vault, repository, or operator session
   is required;
3. a waiver policy or other product decision is ambiguous;
4. historical evidence would need rewriting;
5. a destructive or cleanup target is ambiguous;
6. unrelated dirty changes overlap required files;
7. the baseline cannot be tied to a frozen commit, command, dependency set, and
   toolchain;
8. a required acceptance criterion appears infeasible and the proposed response
   is to remove or weaken it;
9. machine work reaches a human approval, final acceptance, or rollout gate.

## 12. Final Definition of Done

This plan is complete only when every item below is checked with certificate
evidence:

- [x] malformed or unparseable verification output always blocks;
- [x] valid empty findings remain distinguishable from parse failure;
- [x] normal runs freeze verification policy and baseline before mutation;
- [x] candidate comparison uses the same command, adapter, dependencies, and toolchain;
- [x] retry and recovery preserve the original baseline;
- [x] missing, malformed, or unresolved intent blocks every admission gate;
- [x] resolved scripts/runners have matching passing execution evidence;
- [x] verification decisions and waivers are structured, authenticated, and audited;
- [x] planning, prompt, approval, and materialization use the same policy fingerprint;
- [x] blueprint and policy drift block before execution;
- [x] only Vite + React + TypeScript is auto-detected as frontend-vite;
- [x] new governed plans use the new contract version;
- [x] historical plans remain readable without synthetic evidence or silent upgrade;
- [x] backend E2E invokes the production executor and does not prewrite outcomes;
- [x] backend E2E reaches final acceptance, cleanup, and valid audit chain;
- [x] all mandatory negative lifecycle scenarios pass;
- [x] both Dashboard approval paths fail closed on incomplete evidence;
- [x] Dashboard displays blueprint, intent, waiver, baseline, and delta evidence;
- [x] dedicated Dashboard governance E2E asserts the new evidence and controls;
- [x] browser E2E reports zero unexpected errors;
- [x] backend and Dashboard full gates pass;
- [x] no implementation or test accesses `starter-app`;
- [x] the recertification certificate references exact implementation commits;
- [x] no unresolved P1 finding remains;
- [x] human acceptance is still pending until explicitly provided by the operator.
