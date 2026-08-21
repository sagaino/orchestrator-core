# Phase 4.2 Policy, Identity, and Capability Runbook

Status: **IMPLEMENTED AND ADVERSARIAL GATE PASSED**  
Platform boundary: **single-user macOS; fail-closed when `sandbox-exec` is unavailable**  
Implemented: **2026-08-22 (Asia/Jakarta)**

## Enforced Boundary

- Every orchestrated agent, verification, Graphify, and preview launch receives
  an explicit capability profile. Unknown profiles and hosts without the OS
  sandbox are rejected.
- Child environments start from an allowlist. Verification, Graphify, updater,
  and preview do not receive provider credentials. The agent profile receives
  only its explicitly named provider variables.
- macOS sandbox policy denies writes outside the declared repository/worktree
  and a private per-invocation temporary directory. Verification and Graphify
  also deny network access. Common host credential roots (`.ssh`, `.aws`,
  `.gnupg`, `.kube`, `.docker`, and Keychains) are unreadable.
- Profiles set a hard deadline and a total output ceiling. Deadline or output
  overflow terminates the process and records the reason.
- Process output, structured provider payloads, run manifests, durable ledgers,
  telemetry, notifications, and operator audit entries pass through the shared
  redaction layer before persistence.

## Operator Identity

Authenticated browsers obtain a short-lived local operator session from
`GET /api/auth/session`. Every `POST`, `PUT`, and `DELETE` must include its
session ID and current one-time action nonce. A successful authorization rotates
the nonce. Actor fields supplied in JSON are overwritten with the OS-derived
identity (`local:<macOS-user>`), so payload text cannot forge approval evidence.

The dashboard serializes mutations to preserve nonce order. A restarted page
obtains a new session. The bearer token remains required and the API remains
bound to loopback.

## Evidence Integrity and Privacy

Authorized mutations append to `runs/runtime/operator-audit.jsonl`. Each entry
contains its sequence, previous hash, request hash, actor, session, nonce hash,
and its own SHA-256 hash. The API read route `GET /api/audit/verify` and CLI
command below fail when an entry is altered, removed from the middle, reordered,
or malformed.

```sh
npm run security:verify-audit
```

Runtime migration applies `0700` to private directories and `0600` to evidence
files, excluding Git worktrees so executable bits and source semantics are not
changed:

```sh
npm run security:harden-runtime
```

The real migration processed 657 directories and 883 files on 2026-08-22.

## Verification Evidence

`test/phase-4-2-security.test.mjs` proves that the adversarial child:

1. cannot obtain a seeded environment secret;
2. cannot read the seeded host credential fixture;
3. cannot write to a sibling path outside its authorized root;
4. cannot reach a network target under the verification profile;
5. cannot persist the known token through redacted evidence;
6. cannot reuse an action nonce; and
7. cannot modify a chained audit entry without detection.

`test/api.test.mjs` additionally proves authenticated session issuance and that
a forged `approvedBy` value is replaced by the local operator identity.

## Operational Limits

- This policy is intentionally macOS-specific. A future Linux deployment needs
  an equivalent sandbox (for example a dedicated container/VM policy) before
  execution is enabled.
- The agent profile allows provider network access and its explicitly allowed
  provider credential. Provider-scoped short-lived credentials remain preferred.
- The hash chain detects historical mutation during verification; Phase 4.5
  certification should anchor its final head in the signed/checksummed
  certification bundle.
