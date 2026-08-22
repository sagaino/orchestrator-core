# AI OS v1.0.2 Hotfix

Status: **IMPLEMENTED — HUMAN ACCEPTANCE REQUIRED**  
Date: 2026-08-22

## Incident

Live run TASK-004 passed type checking and build, but `npm run test:e2e`
failed because the verification sandbox denied Playwright's local web server from
binding to `127.0.0.1:4173`. Playwright then wrote its normal run metadata and
screenshot under `test-results/playwright`; the scope guard incorrectly counted
those generated artifacts as source changes outside the task's `allowed_paths`.
Automatic recovery consequently attempted source repair for an environment
failure that no source edit could fix.

## Resolution

- Permit browser verification to bind and connect through local loopback only.
- Continue denying all verification traffic to non-loopback network addresses.
- Detect browser verification from the frozen npm script name or its
  Playwright/Cypress command, so ordinary verification retains the stricter
  no-network profile.
- Exclude `test-results`, `playwright-report`, and `blob-report` from workspace
  source snapshots, including normalization of baselines persisted by an older
  runtime.
- Stop automatic recovery before AI repair when the failure is a known sandbox
  or generated-verification-artifact condition.

## Verification

- A sandboxed process successfully opens a server and client on `127.0.0.1`.
- The same process receives `EPERM` when connecting to an external IP address.
- The exact Playwright test from the failed TASK-004 worktree passes under the
  corrected verification profile.
- Comparing the old TASK-004 baseline with its worktree now reports only the
  allowed source file, `src/pages/Login/index.tsx`; Playwright output is absent
  from the scope delta.
- Phase 4.2 security regression tests cover the policy, detection, artifact
  filtering, persisted-baseline normalization, and AI-repair classification.

The failed TASK-004 run remains immutable evidence and is not rewritten. It may
be retried as a new run after this hotfix is active. v1.0.2 requires fresh
machine certification and separate human acceptance before tagging.
