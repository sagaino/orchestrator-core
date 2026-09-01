# AI OS v2 — Hardening Recertification Certificate

Status: **MACHINE RECERTIFIED — HUMAN ACCEPTANCE PENDING**
Certificate date: **2026-09-01 (Asia/Jakarta)**
Authority: **AI OS v2 Hardening Recertification Remediation Plan (RHC-000 through RHC-070)**
Backend implementation commit: **`cc4bc535265cb04f72525b1963e05c1b9e010b55`**
Dashboard implementation commit: **`23798ef1eedbd7438e40d593a66033a34f7b5a6f`**
Machine certification: **PASSED**
Human acceptance: **PENDING**

## 1. Scope and verdict

This certificate applies to `personal-ai-orchestrator` and
`orchestrator-dashboard`. It records machine evidence only; it does not record
operator rollout approval or human final acceptance.

All nine defect groups in Section 3 of the remediation plan now have production
code, negative tests, and a traceable gate. No implementation edit or automated
test command targeted `starter-app`, and no `starter-app` file was modified.

## 2. Defect-to-evidence mapping

| Defect | Implemented outcome | Production-path evidence |
|---|---|---|
| 3.1 parser fail-open | Empty, malformed, truncated, unexpected, and unsupported adapter output is not valid findings evidence. `NO_NEW_FINDINGS` blocks on `UNPARSEABLE`, `UNSUPPORTED`, or `UNCOMPARABLE`. | `test/verification-baseline.test.mjs`; lifecycle E2E regression scenario. |
| 3.2 baseline absent | Executor captures the baseline before agent mutation in the isolated run worktree and freezes command, adapter, dependency, toolchain, and policy identity. Candidate identity drift blocks. | `test/ai-os-objective-lifecycle-e2e.test.mjs`, scenarios 1 and 5. |
| 3.3 admission fail-open | Governed approval and materialization require Intent v2, exactly one resolution/waiver per requirement, empty `missing`, semantic script compatibility, and planned targets. | `test/verification-intent.test.mjs`; `test/plan-lifecycle-api.test.mjs`; lifecycle E2E scenarios 3, 4, and 6. |
| 3.4 blueprint identity | Planning uses the resolved Vault policy and fingerprint; approval/materialization drift remains blocking; automatic frontend detection requires Vite + React + TypeScript. | `test/project-blueprint.test.mjs`; `test/objective-planning-api.test.mjs`. |
| 3.5 decisions absent | `SELECT_SCRIPT`, `SELECT_RUNNER`, `WAIVE`, and `CANCEL` are structured. Script/runner selection requires registered targets; durable decision and audit evidence are created. | `test/verification-intent.test.mjs`; lifecycle E2E scenario 6. |
| 3.6 governed version absent | Newly persisted plans use Plan schema v2 and Intent contract v2. Historical v1 remains readable but is not silently granted a new governance/certification claim. | `test/orchestration-schema.test.mjs`; lifecycle and scheduler/integration fixtures exercise v2 revisions. |
| 3.7 simulated backend E2E | Happy and regression paths use job claim, run creation, production executor, isolated worktree, baseline capture, agent mutation, candidate verification, retrospective, acceptance, cleanup, and audit. Tests do not prewrite terminal run outcomes. | `test/ai-os-objective-lifecycle-e2e.test.mjs`, six scenarios. |
| 3.8 Dashboard display-only | Both approval surfaces use the same fail-closed admission evaluator. UI shows blueprint/policy fingerprint, intent, waivers, blockers, and baseline delta. | `test/e2e/plan-review.spec.ts`; `test/e2e/objective-evidence.spec.ts`; `test/e2e/lifecycle.spec.ts`. |
| 3.9 certification overstated | Delivery certification now requires governed v2 intent and matching PASS execution evidence for every resolved script/runner. This certificate references the tested implementation commits. | `test/delivery-certification.test.mjs`; full backend and Dashboard gates below. |

## 3. Executed machine gates

### Backend — `cc4bc535265cb04f72525b1963e05c1b9e010b55`

- `npm run test:production-hardening`: **PASS**, exit `0`, wall time `4.02s`
  - parser, intent, blueprint, baseline, plan lifecycle, planning API;
  - six real lifecycle E2E scenarios;
  - planning-quality regression guard.
- `npm test`: **PASS**, exit `0`, wall time `51.19s`
  - migration, pilot, recovery rehearsal, final-v1 compatibility;
  - complete unit chain, including delivery certification and post-run automation;
  - smoke test.

### Dashboard — `23798ef1eedbd7438e40d593a66033a34f7b5a6f`

- `npm run test:verify`: **PASS**, exit `0`, wall time `45.35s`
  - typecheck: PASS;
  - lint: PASS with 0 errors and 10 pre-existing Fast Refresh warnings;
  - production build: PASS;
  - security: PASS;
  - browser: **21 passed, 1 configuration-dependent scenario skipped, 0 failed**.
- `npm run test:e2e:ai-os`: **10 passed, 0 failed**, exit `0`, wall time `18.85s`.

Timed recertification execution window: **2026-09-01 15:48–15:50 WIB**.

The browser harness fails on console errors, page errors, and HTTP responses
with status 400 or higher. The two exact browser-engine `ResizeObserver` timing
messages are narrowly classified in the test harness; production code no longer
suppresses global browser errors.

## 4. Mandatory negative evidence

- malformed, truncated, unexpected prose, and empty ESLint output block;
- non-zero output without parseable findings blocks;
- missing intent, unresolved requirements, duplicate resolution + waiver, and
  semantically mismatched scripts block;
- unregistered script and runner selection block;
- stale plan fingerprint and baseline environment identity drift block;
- a newly introduced lint finding produces `FAIL_REGRESSION` through the real
  executor and prevents successful completion;
- delivery certification blocks when a resolved target lacks matching PASS
  execution evidence;
- both Dashboard approval paths render `BLOCKED` and disable execution when
  governance evidence is incomplete;
- unexpected browser/API errors fail the certified browser specs.

## 5. Remaining human gate

```text
machine_certification: PASSED
human_acceptance: PENDING
rollout_authority: HUMAN OPERATOR
```

The machine result supports a production-candidate review. Rollout remains
blocked until the operator explicitly reviews this certificate and accepts the
release.
