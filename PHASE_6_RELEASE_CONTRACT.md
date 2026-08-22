# Phase 6 — Release Compatibility Contract

Status: **P6.0 IMPLEMENTED — HUMAN GATE REQUIRED**  
Contract version: **p6.0-2026-08-22**  
Deployment model: **local-first, single-user macOS host**

This contract defines what a release candidate must prove before a later
external supervisor may activate it. P6.0 does not build, activate, migrate,
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
