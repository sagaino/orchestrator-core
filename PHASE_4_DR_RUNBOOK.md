# Phase 4.1 Disaster Recovery Runbook

Status: **IMPLEMENTED AND DRILL-VERIFIED**
RPO target: **24 hours**
RTO target: **15 minutes**
Restore policy: **quarantine first; no automatic in-place promotion**

## Protected Datasets

Backup dependency order is:

1. Obsidian Vault: registry, project pages, task specifications, Wiki knowledge,
   candidates, sources, and human-readable audit records.
2. Runtime store: jobs, run manifests, events, invocation ledger, approvals,
   artifacts, notifications, telemetry, API token, and daemon configuration.
3. Configuration snapshot in the manifest: original roots, platform,
   architecture, Node.js version, registry location, and runtime-token location.

Project source is recovered from each registered Git repository and is not
duplicated into the AI OS state backup. The orchestrator source itself remains
Git-controlled. Active isolated worktrees are not a recovery authority; run
manifests and artifacts determine their safe recovery path.

## Create a Consistent Backup

1. Confirm no task is actively executing or verifying.
2. Stop the local orchestrator services.
3. Select a backup root outside both the Vault and runtime roots. Production
   operation should use independent encrypted media.
4. Run:

```text
npm run dr:backup -- /absolute/backup-root
```

The operation fails if the daemon is running, an execution is active, a source
changes during copy, a symlink is encountered, the target overlaps a source,
or another backup owns the backup lock. A successful directory contains:

```text
READY
manifest.json
manifest.sha256
data/vault/
data/runs/
```

Only a backup with `status: READY` and a valid completion marker is usable.

## Verify Before Every Restore

```text
npm run dr:verify -- /absolute/backup-root/dr-<id>
```

Verification checks the manifest checksum, schema version, completion marker,
dataset presence, every relative path, entry type, permission mode, byte size,
SHA-256, and aggregate summary. Never override a failed verification.

## Restore to Quarantine

The target must not already exist:

```text
npm run dr:restore -- /absolute/backup-root/dr-<id> /absolute/new-recovery-root
```

The restored layout is:

```text
RECOVERY_MODE.json
vault/
runs/
  runtime/recovery-mode.json
```

Both recovery markers set `executionBlocked: true`. The daemon refuses to start
against the restored `runs/` root. An API inspection process may expose
authenticated GET requests, but mutation requests fail with HTTP `423`.

## Validate the Quarantine

Before promotion, the operator must verify:

- project registry and representative task/knowledge documents;
- latest completed, review, failed, and queued run manifests;
- approval, commit, verification, artifact, and knowledge evidence;
- API token mode `0600` and expected private directory ownership;
- registered Git repositories exist at the expected paths;
- queued work is understood and will not start unexpectedly;
- backup age is within the 24-hour RPO.

## Explicit Offline Promotion

Automated in-place promotion is intentionally not provided. If disaster
recovery is required:

1. Keep services stopped.
2. Create a second rollback copy of any surviving current Vault/runtime roots.
3. Verify the quarantine again immediately before promotion.
4. Move current roots aside without deleting them.
5. Move the verified `vault/` and `runs/` roots into their configured locations
   on the same filesystem, preserving ownership and modes.
6. Confirm all paths and Git repositories.
7. Remove `runs/runtime/recovery-mode.json` only after explicit operator sign-off.
8. Start services and inspect health, queue, runs, evidence, and notifications.
9. Retain the pre-promotion roots until the recovery is formally accepted.

Removing the marker is the recovery acceptance boundary. It must never be
performed by an agent or as part of restore.

## Failed Restore Handling

- Partial backup/restore directories are never authoritative.
- Checksum, permission, schema, or marker failure invalidates the backup.
- A corrupt recovery marker fails closed.
- Do not repair a backup in place. Select an earlier verified backup and record
  the rejected backup ID and reason.
- Do not point the daemon to quarantine to “see if it works”; inspect first.

## 2026-08-22 Recovery Drill Evidence

| Evidence | Result |
|---|---|
| Backup ID | `dr-20260821T195127Z-5e7b0069` |
| Backup path | `/Users/sagaino/Documents/personal-ai-orchestrator-backups/dr-20260821T195127Z-5e7b0069` |
| Restored quarantine | `/Users/sagaino/Documents/personal-ai-orchestrator-recovery-drill-20260822` |
| Dataset size | 1,634 files; 85,630,228 bytes |
| Backup duration | 717 ms |
| Verify duration | 219 ms |
| Restore duration | 327 ms |
| Content comparison | Registry and Phase 3 pilot run manifest byte-identical |
| Permission comparison | API token and recovery marker `0600` |
| Execution safety | Daemon start rejected with `RECOVERY_MODE_BLOCKED` |
| Primary services | Restarted successfully after the drill |

The retained backup and quarantine are on the same physical host and therefore
prove the mechanism, not independent-media resilience. Copy verified backups to
encrypted independent storage at least once per 24-hour RPO window.
