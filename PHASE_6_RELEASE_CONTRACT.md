# Phase 6 — Release Compatibility Contract

Status: **P6.4 IMPLEMENTED — HUMAN-ACCEPTED; ACTIVATION HUMAN GATE REQUIRED**  
Contract version: **p6.0-2026-08-22**  
Deployment model: **local-first, single-user macOS host**

This contract defines what a release candidate must prove before a later
external supervisor may activate it. P6.4 does not build, activate, migrate,
or accept a candidate. Those are separate, guarded phases.

## 1. Versioned compatibility surface

Every candidate carries a manifest with these versioned surfaces:

| Surface | Contract field | Current compatibility |
|---|---|---:|
| Release manifest | `schemaVersion` | `1` |
| Runtime | `runtime.compatibilityVersion` | `1.0` |
| Local API | `api.compatibilityVersion` | `1.0` |
| Dashboard shell | `dashboard.compatibilityVersion` | `1.0` |
| Obsidian/Vault data | `vault.schemaVersion` | `1` |
| Rollback protocol | `rollback.protocolVersion` | `1` |

The manifest kind is `personal-ai-os-release-manifest` and the contract
version is frozen as `p6.0-2026-08-22`. A candidate with an unknown or newer
value is rejected before activation; no implicit downgrade is attempted.

## 2. Compatibility outcomes

| Scenario | Required outcome | Migration boundary |
|---|---|---|
| Same supported runtime and data | `ACTIVATION_ELIGIBLE` | none |
| Old runtime reads new data | `BLOCKED_UNTIL_COMPATIBILITY_PROVEN` | external-only |
| New runtime reads old data | `READ_COMPATIBLE_MIGRATION_REQUIRED` | external checkpoint before writes |
| Any incompatible component | `REJECT_BEFORE_ACTIVATION` | none |

The old-runtime/new-data case is fail-closed because P6.0 has no authority to
rewrite or downgrade durable Vault/runtime state. The new-runtime/old-data
case may be inspected only when the new runtime explicitly proves its reader
compatibility; data migration must be an independently recorded checkpoint
before writes are enabled.

## 3. Manifest and activation rules

The manifest must include runtime, API, dashboard, Vault, rollback, and
provenance metadata. Rollback backup creation is mandatory. Activation policy
is fixed to:

- external supervisor owns activation and rollback;
- human gate is required;
- candidate self-accept is forbidden;
- in-process activation is forbidden;
- the candidate cannot mint or impersonate the operator decision.

The validator lives in [`src/release-contract.mjs`](./src/release-contract.mjs),
the machine-readable schema is
[`schemas/release-manifest.schema.json`](./schemas/release-manifest.schema.json),
and fixtures are under
[`test/fixtures/release-compatibility`](./test/fixtures/release-compatibility).

P6.1 adds [`src/release-candidate.mjs`](./src/release-candidate.mjs). It builds
the candidate in an external directory, copies only the allowlisted runtime
inputs, records the source commit, lockfile hash, regression result, and
provenance, then writes a per-file `checksums.sha256` inventory. Verification
rejects altered, incomplete, symlinked, or partial candidates before any later
activation step.

P6.2 adds [`src/release-supervisor.mjs`](./src/release-supervisor.mjs) and a
durable admission freeze. While the external supervisor owns the global
`release-admission` lease, new jobs cannot be admitted. It stops the daemon,
rejects queued/running work, active runs, corrupt ledgers, and uncertain
invocations, then delegates the guarded backup/update/health path. The
candidate cannot provide the human gate: the supervisor requires a separately
supplied OS-derived operator identity, session, nonce hash, and explicit
confirmation. `start.sh release-supervisor ...` is only a launcher; it does not
grant approval by itself.

## 4. Explicit non-goals for P6.0

- no updater behavior is changed;
- no source tree is overwritten;
- no Vault migration is executed;
- no release is self-approved;
- no activation occurs inside the daemon process.

## 5. Exit evidence

- valid manifest fixture is accepted;
- self-accept and in-process activation fixture is rejected;
- incompatible API fixture is rejected before activation;
- all four compatibility matrix outcomes are represented and tested;
- `npm test` and `graphify update .` pass.

## 6. P6.2 supervisor evidence

- `release-admission` is a durable global gate shared with job admission;
  concurrent admission callers wait or fail while the supervisor owns it.
- The drain inspector rejects queued/running jobs, active run states, corrupt
  job/run ledgers, and `RUNNING`, `INTERRUPTED`, or unknown invocations.
- The external supervisor stops the daemon before rechecking drain state,
  delegates backup/update/health verification, and always releases the freeze
  only after the guarded result is returned.
- A candidate cannot provide the human gate. The supervisor requires explicit
  confirmation, an OS-derived operator identity, operator session, and action
  nonce hash supplied outside the candidate manifest.
- `npm test`, `bash -n start.sh`, and the dedicated release-supervisor suite
  pass. A real candidate remains stored separately from the stable runtime.

P6.3 adds deterministic drills for startup crash, missing heartbeat, corrupt
manifest, incompatible schema, failed migration, and failed health probe. Each
case records the injected diagnostic, requires a failure or rejection, hashes
the managed stable source before and after, and passes only when the hashes are
identical and uncertain work is not replayed.

## 7. P6.4 Release Operations evidence

P6.4 adds `GET /api/operations/release`, a read-only DTO consumed by the
dashboard Operations page. It exposes the current runtime and verified
candidate version, queue-drain blockers, compatibility outcome, backup ID,
health checks, rollback evidence, and the external activation policy.

The dashboard confirmation is intentionally non-mutating: it records only a
local UI acknowledgement and explains that activation must still be performed
by the external supervisor with the OS-derived operator identity, session, and
nonce. No candidate can self-accept or activate in-process.

Evidence:

- backend operations API test covers the versioned DTO and fail-closed defaults;
- dashboard TypeScript, lint, production build, and Playwright browser fixture
  pass;
- browser test verifies the activation button remains disabled until the human
  acknowledgement and that the UI explicitly reports no activation occurred.
