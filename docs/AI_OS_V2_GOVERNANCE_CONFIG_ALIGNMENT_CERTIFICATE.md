# AI OS v2 Governance and Configuration Alignment Certificate

Certificate status: **MACHINE VERIFIED — HUMAN REVIEW PENDING**
Human gate: **PENDING**
Certificate scope: governance/config alignment and its current remediation
Prepared on: **2026-08-31 (Asia/Jakarta)**

## Purpose

This durable record separates technical verification from human acceptance. It
does not authorize feature activation, public exposure, multi-user operation,
or optional Telegram capabilities.

## Provenance

| Component | Baseline commit | Verified implementation commit |
|---|---|---|
| Backend | `0fbf7b808b4bac90e4b3ecb03cff7e4aba914cfd` | `b83f7576f3a12a055ebd663599f2710dba7cca75` |
| Dashboard | `2276f7f` | `c53ec2678eeea3815bf45e34d12e1a75474f9e26` |

The backend and Dashboard implementation commits above are the exact revisions
covered by the machine gates below. This certificate is committed immediately
after those revisions so the repository history preserves their relationship.

## Required Machine Gates

| Gate | Required command | Status |
|---|---|---|
| Runtime profile | `npm run test:runtime-profile` | PASS |
| Environment contract | `npm run test:environment-contract` | PASS |
| Governance/config | `npm run test:governance-config` | PASS |
| Full backend regression | `npm test` | PASS |
| Operations readiness | `npm run operations:readiness` | PASS — `READY`, no blockers |
| Audit chain | `npm run security:verify-audit` | PASS — 681 valid entries |
| Dashboard release gate | `npm run test:verify` | PASS — 20 browser tests passed, 1 intentionally skipped |
| Repository review | `git diff --check` and working-tree review | PASS |

Machine verification completed on **2026-08-31 15:39 (Asia/Jakarta)**. The
Dashboard lint gate completed with zero errors and ten remaining Fast Refresh
warnings; these warnings do not affect the release result.

## Runtime Evidence

- Required default profile: `LOCAL_SAFE`.
- Required default activation: all v2 admission flags disabled.
- `LOCAL_PILOT` baseline may use only recognized, bounded opt-ins; Operations
  records them as explicit overrides, while invalid dependencies, excess
  capacity, and deferred Telegram activation fail closed.
- Profile mismatch behavior: new intake and execution fail closed with
  `RUNTIME_PROFILE_MISMATCH`.
- Preserved actions during mismatch: read-only inspection, review, cancel,
  backup, and recovery.
- Effective readiness result: `READY`; admission allowed with no blockers, the
  active `LOCAL_SAFE` profile is aligned, the daemon is healthy, backup evidence
  is current, and the audit chain is valid.
- Deferred capability: optional Telegram remains disabled and not implemented.

## Rollback Instructions

1. Restore the operator-owned `.env` to the exact `LOCAL_SAFE` contract from
   `.env.example`.
2. Restart backend and dashboard services.
3. Confirm Operations reports an aligned `LOCAL_SAFE` profile.
4. Confirm new objective admission is blocked when a deliberate mismatch is
   introduced in an isolated test environment.
5. Confirm read-only inspection and recovery remain available.
6. Revert only the scoped remediation changes if code rollback is required; do
   not delete objectives, plans, runs, evidence, backups, or audit records.

## Human Acceptance

The machine gates above must pass before this section can be accepted. An agent
must not populate these fields on behalf of the operator.

```yaml
accepted: false
accepted_by: null
accepted_at: null
decision: PENDING
notes: "Machine verification passed; awaiting explicit operator review."
```
