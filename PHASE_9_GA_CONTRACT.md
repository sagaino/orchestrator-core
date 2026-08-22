# Phase 9 — v1.0 GA Certification Contract

Status: **P9.0 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**
Contract version: **p9.0-2026-08-22**
Boundary: **reproducible local-first release packaging, installation, upgrade, recovery, documentation, and final human-gated v1.0 certification**

## P9.0 Release Manifest and Installation Contract

The release-manifest module creates a versioned, checksum-backed release
manifest. It records supported macOS architectures and Node major versions,
backend/dashboard versions, package-lock checksums, absolute Vault/runtime/
backup roots, dependency installation policy, start and health commands,
uninstall behavior, and the external rollback sequence.

The contract preserves data roots during uninstall by default. Purging data
requires a separate explicit confirmation and is not part of manifest
generation. Rollback restores into quarantine and requires health checks plus
human promotion; the manifest cannot activate a release or approve itself.

CLI:

- release-manifest writes runs/runtime/release-manifest/v<version>.json;
- release-manifest-verify <absolute-manifest-path> checks the checksum,
  supported host, absolute roots, lockfiles, and launcher presence.

## P9.0 Evidence

- test/release-manifest.test.mjs covers manifest creation, absolute-root
  guardrails, uninstall preservation, lockfile drift detection, and checksum
  verification;
- backend full suite and smoke test remain the release gate;
- P9.1 migration/upgrade matrix is the next implementation packet.
