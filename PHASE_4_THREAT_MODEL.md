# Phase 4 Threat Model

Status: **BASELINE v1.0**  
Reviewed: **2026-08-22**  
Applies to: **Personal AI OS local-first single-user deployment**

## Security Objective

The AI OS may plan and execute software work, but it must not obtain more host
authority than the approved task requires. A provider response, repository,
dependency, script, local web page, or stale runtime record is untrusted until
validated by a control that does not depend on that same input.

## Protected Assets

1. Human approval and acceptance decisions.
2. Registered project source and Git history.
3. Vault tasks, project records, and global knowledge.
4. Runtime queue, run manifests, invocation identities, and audit history.
5. Workspace artifacts, diffs, logs, screenshots, and backups.
6. API token, provider credentials, SSH keys, environment variables, and other
   host secrets.
7. Host filesystem, processes, network identity, and availability.

## Actors

- trusted local operator;
- accidental or mistaken operator;
- untrusted task, attachment, knowledge, or repository content;
- compromised or malicious coding-agent/provider response;
- malicious package, build script, test, hook, or developer tool;
- local unprivileged user, browser origin, or malware;
- crashed, duplicated, stale, or resource-starved process;
- corrupted disk/state and compromised update dependency.

## Trust Boundaries

```text
Human operator
    -> Dashboard/browser session
        -> Local API + shared bearer token
            -> Durable runtime state and Obsidian Vault
            -> Daemon and lifecycle policy
                -> Agent/provider CLI
                -> Graphify/package manager/test/build scripts
                -> Isolated Git worktree
                    -> Transactional apply -> source repository
            -> Evidence, artifacts, telemetry, and notifications

macOS user account surrounds every component above.
The worktree is a Git boundary, not an OS security sandbox.
```

## Threat Analysis

| Threat | STRIDE | Attack/failure path | Existing control | Residual risk |
|---|---|---|---|---|
| Host secret theft by child process | Information disclosure | Agent or repository script reads inherited environment, home directory, Keychain-accessible material, or network credentials | Denied filenames in workspace; local-only API | CRITICAL: controls do not constrain host reads or network egress |
| Host mutation outside project | Tampering | Child process writes outside worktree or launches another process | Repository snapshot and scope audit | CRITICAL: audit covers project paths, not arbitrary host side effects |
| Forged human identity | Spoofing | Token holder submits `approvedBy`, `rejectedBy`, or similar actor label | Bearer authentication and confirmation UI | MEDIUM: actor label is self-asserted |
| Approval bypass | Elevation of privilege | Agent or API caller advances lifecycle without human action | `allow_self_accept: false`, state transition guards, explicit confirmation | LOW while token and dashboard session remain controlled |
| Duplicate task/provider execution | Tampering/repudiation | Concurrent admission or crash creates separate jobs/invocations | leases, job dedupe, stable invocation IDs | HIGH after observed intermittent split job IDs |
| Evidence secret leakage | Information disclosure | Provider JSON, stdout/stderr, prompts, test logs, or copied files persist a secret | bounded 50k tails; API auth | HIGH: no general redaction and many files are `0644` |
| Evidence rewriting | Tampering/repudiation | User-level process edits JSON/JSONL history or artifact | atomic writes and revisions during normal mutation | MEDIUM: no hash chain/signature against offline rewrite |
| API/SSE exhaustion | Denial of service | Token holder opens clients or sends repeated expensive requests | loopback binding, body cap, worker limit | MEDIUM: no rate/SSE/request concurrency limit |
| Stuck child process | Denial of service | Test/build/tool never exits or ignores graceful shutdown | some tool-specific timeouts | MEDIUM: no universal deadline/kill escalation |
| Disk exhaustion | Denial of service/tampering | Unbounded events, artifacts, backups, screenshots, or provider output fill disk | output tails bounded in some ledgers | MEDIUM: no quota, retention, or low-disk admission guard |
| Irrecoverable host/state loss | Denial of service | disk failure, deletion, corruption, or incompatible change removes Vault/runtime evidence | Git for code; updater source backup | HIGH: no coordinated backup/restore proof |
| Malicious upload/path escape | Tampering | crafted path, symlink, MIME mismatch, or oversized asset | contained path resolution, realpath ancestor checks, signature and size checks | LOW |
| Cross-origin API action | Spoofing/elevation | hostile page sends authenticated request | localhost Origin/Referer guard and bearer token | LOW; wildcard SSE response header should be removed |
| Verification weakening | Tampering | agent edits package scripts or requested checks | frozen script definitions, dependency reconciliation, post-apply checks | LOW for detected repository changes; child-process authority remains critical |
| Supply-chain compromise | Elevation/information disclosure | compromised CLI, package, update, model, or transitive dependency | lockfile, `--ignore-scripts` for reconciliation, updater rollback | HIGH until capability isolation and provenance policy exist |

## Abuse Cases Required for Phase 4 Tests

1. Agent fixture attempts to read a seeded secret outside the repository.
2. Agent fixture attempts to write outside the worktree.
3. Verification fixture attempts network access to an explicitly denied target.
4. Provider output contains known token patterns and must be redacted before all
   durable writes and notifications.
5. Eight or more processes race task admission repeatedly; only one job and one
   invocation may exist.
6. Daemon is killed during claim, agent execution, verification, apply, commit,
   knowledge sync, and cleanup.
7. Disk-full and permission-denied faults occur during every atomic write.
8. Run manifest, event log, artifact, and backup are truncated or modified.
9. A stale backup is restored in an isolated target and must not execute queued
   work until a human explicitly releases recovery mode.
10. Token holder submits a forged actor label; audit identity must remain bound
    to the authenticated local session.
11. SSE and expensive read endpoints receive sustained local load and remain
    bounded without starving lifecycle actions.
12. A dependency script ignores termination; deadline enforcement must stop its
    process tree and record the outcome.

## Security Invariants

- No child process receives an environment variable unless its capability
  profile explicitly allows it.
- No child process can read or write outside declared roots or access denied
  network destinations.
- No task admission, provider invocation, acceptance, or destructive operation
  occurs more than once for one durable identity.
- No approval actor is derived solely from request body text.
- No known secret reaches a durable log, manifest, artifact, notification, or
  browser response.
- Evidence mutation is detectable after it is committed to the audit chain.
- Restore starts in quarantine/recovery mode and cannot execute queued work.
- Low disk, stale backup, corrupt evidence, and stuck processes block new work
  before source integrity is at risk.

## Risk Acceptance Rules

- CRITICAL: never accepted for production certification.
- HIGH: must be closed before Phase 4.5.
- MEDIUM: may remain only with a named owner, compensating control, review date,
  and explicit human acceptance.
- LOW: must have an owner and planned release or documented acceptance.

The operator's current decision is to accept these risks only for supervised,
loopback-only local pilots while Phase 4 controls are implemented.

