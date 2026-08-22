# P9.4 Final Threat Model — v1.0 Local-First GA

Status: **P9.4 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**
Contract: `p9.4-2026-08-22`

## Boundary

The system is a local-first, single-user macOS orchestrator bound to
localhost. The operator, Vault, registered repositories, runtime roots,
external backup target, dashboard, release supervisor, and evidence stores are
in scope. Public network exposure, multi-user access, unattended agents,
mobile sync, and a plugin marketplace remain out of scope.

## Residual risk register

| ID | Threat | Inherent | Residual | Control | Owner / expiry |
| --- | --- | --- | --- | --- | --- |
| TM-001 | Unauthorized mutation or self-approval | HIGH | LOW | Approval-gated lifecycle, external supervisor, human gates | release operator |
| TM-002 | Secret exposure in task/evidence/log output | HIGH | LOW | Redaction, private artifacts, secret scan, localhost binding | security operator |
| TM-003 | Recovery target promoted before validation | HIGH | LOW | `RECOVERY_QUARANTINE`, `executionBlocked`, explicit promotion | recovery operator |
| TM-004 | Audit/certificate tampering | HIGH | LOW | SHA-256 sidecars and previous-hash audit chain | security operator |
| TM-005 | Runtime or artifact growth | MEDIUM | MEDIUM | Soak/capacity limits, alerts, retention preview | operations operator; expires 2026-09-30; accepted in P9.4 strong review |
| TM-006 | Browser or host compatibility drift | MEDIUM | LOW | Release compatibility matrix and browser gate | release operator |
| TM-007 | Provider/dependency failure causes unsafe retry | MEDIUM | LOW | Exactly-once admission, bounded recovery, fail-closed rollback | runtime operator |

No residual CRITICAL/HIGH risk is accepted. The one residual MEDIUM risk has
an owner, control, expiry, and explicit strong-review acceptance; it is not a
production activation approval.

## Required evidence rerun

The final certificate reruns adversarial, reliability, recovery, operations,
browser, benchmark, self-update, visual QA, soak, install, and migration gates.
It records each command, exit code, duration, and redacted output tail. It also
anchors the current source commit, release manifest checksum, audit-chain head,
documentation presence, and Phase 9 report sidecar checksums.

## Human release gate

The certificate status can become `CERTIFIED_HUMAN_GATE_REQUIRED`, but its
`humanGate.approved` field remains false. A human must review the threat model,
gate results, repository cleanliness, provenance, and checksums before assigning
`v1.0.0` or activating a production release.
