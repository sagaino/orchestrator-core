# AI OS v1.0.1 Hotfix

Status: **IMPLEMENTED — HUMAN ACCEPTANCE REQUIRED**  
Date: 2026-08-22

## Incident

Live task intake failed before planning because the capability sandbox removed
`HOME` from the child environment. After restoring `HOME`, the same path exposed
two related compatibility defects: task-intake planning was classified as a
verification process instead of an authenticated agent process, and the global
macOS file-write restriction prevented `agy` from reading its authenticated
Keychain session.

## Resolution

- Preserve only the allowlisted `HOME` value and resolve it to an absolute path.
- Route planner, retrospective, and knowledge-provider stages through the agent
  capability profile.
- Correct the sandbox write rule so explicitly writable roots are effective.
- Resolve both lexical and canonical macOS paths (`/var` and `/private/var`).
- For authenticated `agy` invocations, require `agy --sandbox` and retain the AI
  OS environment, network, deadline, output, and sensitive-directory controls.
  This avoids the macOS Keychain incompatibility without disabling provider-side
  workspace/terminal isolation. Non-provider processes retain the stricter AI OS
  filesystem allowlist.
- Keep `.ssh`, `.aws`, `.gnupg`, `.kube`, and `.docker` unreadable and
  unwritable from agent processes. Keychain access is not granted to
  verification, graphify, preview, or updater profiles.
- Make final certification version-aware so the v1.0.1 certificate and release
  manifest do not overwrite the accepted v1.0.0 evidence.

## Verification

- The original `agy --version` `$HOME` startup failure is resolved.
- A sandboxed, authenticated, non-interactive `agy` plan invocation succeeds.
- The exact reported request produces a valid structured task draft for
  `test-add-project` with no project or task mutation.
- Phase 4.2 security regression tests cover environment filtering, stage routing,
  network policy, sensitive paths, workspace writes, and mandatory provider
  sandboxing.

The v1.0.0 tag and accepted certificate remain immutable. v1.0.1 requires fresh
machine certification and a separate human acceptance before tagging.
