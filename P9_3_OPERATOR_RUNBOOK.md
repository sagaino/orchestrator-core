# P9.3 Operator Runbook — UI-First Install, Recovery, and Rollback

Status: **P9.3 IMPLEMENTED — HUMAN ACCEPTANCE PENDING**

This runbook is the operator path for the local-first AI OS. The dashboard is
the primary interface. CLI commands are the auditable fallback for an operator
who has already confirmed the target paths. No step in this document grants
itself approval, clears recovery quarantine, or promotes a release.

## Safety boundary

- Confirm the project, task, allowed paths, operator identity, and current
  backup status before every mutating action.
- Stop when the dashboard shows a red admission blocker, an unknown run state,
  a checksum mismatch, or a `RECOVERY_QUARANTINE` banner.
- Never paste secrets into tasks, evidence, chat, logs, screenshots, or
  knowledge. Rotate any credential that appears in evidence.
- Keep the Vault and runtime roots separate from the external backup target.

## Install on a clean supported host

1. In the dashboard, open **Release → Installation** and review the release
   version, supported macOS/Node host, absolute data roots, and lockfile
   checksums.
2. Confirm the source and dashboard repositories are clean and the manifest
   verification is green.
3. Install dependencies using the reviewed manifest command:
   `npm ci --ignore-scripts --no-audit --no-fund`.
4. Start only after the human operator confirms the installation checklist.

CLI fallback: `release-manifest <version>` followed by
`release-manifest-verify <absolute-manifest-path>`.

## Start and stop

1. Dashboard: open **Operations → Runtime**, inspect heartbeat and admission,
   then choose **Start** or **Stop** and confirm the action.
2. Wait for the health indicator and queue drain evidence; never start while a
   recovery quarantine or unresolved critical alert is present.

CLI fallback: `daemon:start`, `daemon:status`, and `daemon:stop`.

## Task lifecycle

1. Open **Projects → Task Intake**, select a registered project, and create a
   scoped task with explicit allowed paths and verification commands.
2. Review the generated plan and context; approve execution only after scope
   and capability admission are green.
3. Follow the run in **Operations → Queue** through claim, execution,
   verification, and review. A run must not be manually edited in the runtime
   store.

## Review, request changes, accept, or reject

- **Review:** inspect diff, scope audit, verification, screenshots, Graphify,
  and knowledge proposal in the dashboard.
- **Request changes:** select **Request changes**, provide bounded feedback,
  and re-review the new evidence. The previous evidence remains immutable.
- **Accept:** select **Accept** only when scope, tests, evidence, and knowledge
  decision are satisfactory. This is the human approval for applied changes.
- **Reject:** select **Reject** with a reason. Rejected work must remain
  unapplied or be explicitly recovered; it is never silently retried.

## Update and rollback

1. In **Release → Candidate**, verify candidate checksum, compatibility, queue
   drain, and the external supervisor gate.
2. Approve activation only as the human operator. Observe startup and health
   evidence.
3. If startup, migration, or health fails, keep the stable release active and
   inspect the rollback evidence. Do not retry blindly.

CLI fallback: `release-supervisor` and the guarded rollback procedure recorded
in the release manifest. A failed candidate is quarantined; it cannot approve
itself.

## Alerts and operations

1. Open **Operations → Alerts**, assign an owner and role, and open the linked
   runbook steps.
2. Acknowledge or snooze only with an expiry and evidence. Acknowledgement does
   not open admission when the underlying blocker remains.
3. Resolve only after the evidence is attached and the readiness check is
   green.

CLI fallback: `operations-readiness`, `notifications`, and the alert action in
the Operations Center.

## Backup

1. Stop the daemon and wait for active jobs/runs to reach a safe state.
2. In **Operations → Backup**, review the external target and schedule, then
   explicitly confirm a consistent backup.
3. Verify the backup checksum and register it as the current recovery point.

CLI fallback: `dr-backup <absolute-backup-root>`, `dr-verify <absolute-backup>`
and `dr-register-verified <absolute-backup>`.

## Restore to a clean recovery target

1. Create a new, empty target directory outside the Vault and runtime roots.
2. In **Operations → Recovery**, select the verified backup and choose
   **Restore to quarantine**. Confirm the target path and backup ID.
3. Verify the restored Vault, runtime state, audit/evidence files, and
   `RECOVERY_QUARANTINE` banner. Execution must remain blocked.
4. Run health, compatibility, and evidence checks while still quarantined.

CLI fallback: `dr-restore <absolute-backup-directory>
<absolute-new-target-root>`.

## Emergency recovery

1. Stop the daemon and record the incident/alert ID. Do not mutate the source
   dataset while the state is uncertain.
2. Preserve logs, audit head, run IDs, backup ID, and the last known release
   manifest.
3. Restore only to a new quarantine target. If the marker is missing or
   corrupt, treat the target as blocked and repair the marker offline.
4. Re-run compatibility, backup, audit, and health checks. Escalate if any
   check is unknown or failed.

## Explicit promotion gate

Promotion is a separate operator action after recovery evidence is reviewed.
The rehearsal and restore commands never point the daemon at the recovery
target, never clear `executionBlocked`, and never mark a release as accepted.
Record the human approver, timestamp, target root, backup ID, and evidence
checksum before any future promotion.

## Rehearsal evidence

Run `recovery-rehearsal` to verify that this runbook covers every required
operator area and that a clean target reconstructs state while remaining
quarantined. The checksummed report is written to
`runs/runtime/recovery-rehearsal/p9.3-report.json`.
