# Phase 4 — Production Hardening and Controlled Operations

Status: **PHASE 4 COMPLETE — LOCAL SUPERVISED PRODUCTION CERTIFIED**
Baseline date: **2026-08-22 (Asia/Jakarta)**
Deployment model: **local-first, single-user macOS host**

Phase 3 certified one real end-to-end pilot through the AI OS shell. Phase 4
raises the target from a successful local MVP to a controlled operational
system with explicit recovery objectives, least privilege, failure drills,
resource governance, and reproducible production-readiness evidence.

## Phase 4.0 Outcome

The current system is suitable for continued local pilot use with human
approval. It is **not yet production-certified**. Existing controls protect Git
scope and normal restart behavior well, but they do not yet contain a hostile
or compromised child process at the host boundary, guarantee whole-system
restore, protect all evidence at rest, or prove reliability under sustained
fault and concurrency pressure.

Detailed threats and mitigations are maintained in
[`PHASE_4_THREAT_MODEL.md`](./PHASE_4_THREAT_MODEL.md).

## Audited System Boundary

### In scope

- React dashboard and local API;
- daemon, queue, run state, leases, and invocation ledger;
- Obsidian Vault task and knowledge records;
- registered Git repositories and isolated worktrees;
- coding-agent, Graphify, package-manager, test, and build child processes;
- review, acceptance, transactional apply, artifacts, notifications, and
  telemetry;
- runtime updater and its source rollback.

### Outside the trusted application boundary

- macOS kernel, user account, filesystem permissions, Keychain, and backups;
- external model/provider behavior and availability;
- repository-controlled package scripts and dependencies;
- `agy`, Graphify, Git, Node.js, browser, and package-manager binaries;
- network services reached by inherited child-process credentials.

## Existing Control Baseline

| Control area | Evidence | Baseline result |
|---|---|---|
| Network binding | API `127.0.0.1:3721`; dashboard `127.0.0.1:5173` | PASS |
| API authentication | 256-bit runtime bearer token, timing-safe comparison, token file mode `0600` | PASS |
| Browser-origin guard | localhost-only Origin/Referer validation and authenticated API routes | PASS with hardening gap |
| Input bounds | JSON body limit 8 MiB; uploaded images 5 MiB with extension, MIME, and signature checks | PASS |
| Filesystem scope | normalized relative paths, ancestor realpath validation, symlink escape checks, denied secret filenames | PASS |
| Agent code isolation | detached Git worktree, path scope audit, frozen verification definitions | PASS for repository integrity only |
| Apply safety | backup, rollback, post-apply verification, Graphify refresh, scoped Git commit | PASS |
| Human control | explicit queue approval and acceptance confirmation; no self-accept | PASS for single shared operator token |
| Durable execution | atomic leases, revision guards, stable invocation IDs, restart reconciliation | DEGRADED; intermittent admission race observed |
| Evidence durability | manifests, JSONL events, artifacts, archived diff, knowledge record | PASS for restart visibility |
| Whole-system recovery | versioned Vault/runtime/config snapshot, SHA-256 verification, permission preservation, and quarantine restore | PASS for local recovery drill |
| Secrets in evidence | child output and provider payloads are persisted without a general redaction layer | FAIL |
| Resource governance | worker count exists; no request rate limit, SSE cap, artifact retention, disk quota, or universal process deadline | FAIL |
| Operational health | API health, daemon heartbeat, counters, notifications, and telemetry | PARTIAL |

## Measured Baseline

- Orchestrator unit/smoke run: one failure in the concurrent admission assertion
  (`2` job IDs instead of `1`), followed by five consecutive standalone PASS
  runs, a further 20/20 durability stress PASS, and a final full-suite PASS.
  The initial split remains classified as an intermittent reliability defect,
  not erased by the successful reruns.
- Dashboard verification: typecheck, build, security test, and four Playwright
  lifecycle tests passed. Lint completed with 8 pre-existing warnings and no
  errors.
- Local authenticated `GET /api/runs`, 30 sequential requests: p50 `32.64 ms`,
  p95 `78.98 ms`, maximum `92.14 ms`.
- Runtime data: approximately `20 MiB`; Graphify output: `5.6 MiB`.
- Host data volume at audit: `78%` used with approximately `93 GiB` available.
- API token mode: `0600`. Many run manifests, event-derived artifacts, patches,
  and copied files are mode `0644`.

These measurements are a development-host baseline, not a capacity claim.

## Prioritized Findings

| ID | Severity | Finding | Required phase |
|---|---|---|---|
| P4-001 | CLOSED | macOS capability profiles now allowlist environment, deny host credential roots and out-of-root writes, apply network policy, deadlines, and output ceilings; unsupported hosts fail closed. | 4.2 |
| P4-002 | CLOSED | Versioned quiescent backup now covers Vault, runtime state, evidence, and configuration metadata; verified quarantine restore preserves permissions and blocks execution. Independent-media scheduling remains an operational requirement. | 4.1 |
| P4-003 | CLOSED | Shared structured/text redaction runs before core durable writes, and the real runtime permission migration applied private modes to 657 directories and 883 files. | 4.2 |
| P4-004 | CLOSED | The partial-lease visibility race was identified and fixed fail-closed. Certification completed 25 rounds / 200 admission callers and 50 manifest writers with zero duplicates or lost updates. | 4.3 |
| P4-005 | CLOSED for local single-user deployment | Mutations require an OS-derived local operator session and one-time action nonce; payload actor labels are overwritten. | 4.2 |
| P4-006 | CLOSED | Universal process-group deadlines, kill escalation, bounded output, bounded recovery, API request/SSE limits, disk guard, quota, and confirmation-only retention are enforced. | 4.3/4.4 |
| P4-007 | CLOSED | Operations readiness now yields one admission decision with actionable disk, backup freshness, queue age, artifact growth, deadline/provider, daemon, and evidence-integrity signals. | 4.4 |
| P4-008 | CLOSED for operator mutations | Authorized mutations are recorded in a SHA-256 previous-hash chain with verification API/CLI; Phase 4.5 will anchor the final head in its certification bundle. | 4.2/4.5 |
| P4-009 | CLOSED | Wildcard SSE CORS response header removed; the localhost origin guard remains authoritative. | 4.2 |
| P4-010 | LOW | Dashboard lint has eight warnings and the production bundle reports a chunk above 500 kB; neither blocks correctness, but both reduce operations signal quality. | 4.4 |

## Phase 4 Delivery Contract

### Phase 4.1 — Backup, Restore, and Disaster Recovery

Status: **IMPLEMENTED — RECOVERY DRILL PASSED 2026-08-22**

- Define protected datasets and dependency order.
- Produce versioned, checksummed, permission-preserving backups.
- Restore into an isolated target before any in-place recovery.
- Define and measure RPO/RTO.
- Exercise corrupted, incomplete, and incompatible backup rejection.

Exit gate: a clean host-state fixture can reconstruct registry, tasks, runtime
state, evidence, knowledge, and configuration from a verified backup without
silently starting or accepting work.

Implementation notes:

- `dr-backup` requires a stopped daemon and rejects active execution state.
- Backup directories are atomically promoted from a partial staging directory
  only after every copied file matches its recorded SHA-256 and size.
- The versioned manifest records dataset inventory, source roots, platform and
  runtime configuration metadata, file modes, checksums, RPO/RTO targets, and
  the fail-closed recovery contract.
- `dr-verify` rejects a missing completion marker, altered manifest, incompatible
  schema, missing entry, permission drift, size mismatch, and checksum mismatch.
- `dr-restore` accepts only a new target, verifies the backup first, preserves
  permissions, rechecks copied content, and writes recovery markers at the
  quarantine root and restored runtime.
- A daemon pointed at restored runtime refuses to start. An inspection API may
  serve authenticated reads, but all POST/PUT/DELETE requests return `423`
  until an offline, explicit promotion removes recovery mode.
- The first real snapshot contains 1,634 files / 85,630,228 bytes. Backup took
  717 ms, verification 219 ms, and quarantine restore 327 ms on the audit host.
- Target RPO is 24 hours and target RTO is 15 minutes. The copy engine is well
  below the RTO target on the current dataset; operator validation and storage
  replacement time remain part of the full recovery drill.
- The operator runbook and exact retained evidence paths are documented in
  `PHASE_4_DR_RUNBOOK.md`.

### Phase 4.2 — Policy, Identity, and Capability Enforcement

Status: **IMPLEMENTED — ADVERSARIAL GATE PASSED 2026-08-22**

- Introduce capability profiles for agent, verification, Graphify, updater, and
  preview processes.
- Start child processes with an explicit environment allowlist, constrained
  filesystem roots, network policy, deadlines, and bounded output.
- Redact secrets before events, ledgers, notifications, or evidence are written.
- Apply private modes to runtime evidence and migrate existing records safely.
- Bind approval evidence to a local authenticated operator session and action
  nonce rather than accepting an actor label as identity.
- Add tamper-evident audit chaining or signed checkpoints.

Exit gate: an adversarial fixture cannot read a seeded host secret, write
outside authorized roots, reach a denied network target, forge an approval
actor, or persist a known secret in evidence.

Implementation evidence and operational commands are documented in
[`PHASE_4_POLICY_RUNBOOK.md`](./PHASE_4_POLICY_RUNBOOK.md). The dedicated
adversarial suite passed all exit-gate cases, the core API session/identity
regression passed, and both supported CLI binaries (`agy` and Graphify) launched
successfully inside their assigned profiles.

### Phase 4.3 — Reliability and Failure Injection

Status: **IMPLEMENTED — RELIABILITY GATE PASSED 2026-08-22**

- Reproduce and eliminate the concurrent admission split.
- Add repeated race tests and deterministic fault injection around lease,
  rename, manifest, queue, apply, commit, and cleanup boundaries.
- Test process kill, timeout, disk-full, permission loss, Git conflict, corrupt
  state, provider interruption, and restart during every active lifecycle state.
- Enforce bounded retries and child-process deadlines.

Exit gate: the reliability suite completes repeated stress runs with zero
duplicate invocation, zero silent approval, zero out-of-scope mutation, and a
documented safe terminal state for every injected fault.

Implementation evidence and the safe terminal-state matrix are documented in
[`PHASE_4_RELIABILITY_RUNBOOK.md`](./PHASE_4_RELIABILITY_RUNBOOK.md). The
certification stress run completed 25 rounds with zero duplicate admission and
zero lost manifest updates. Deterministic faults covered lease visibility,
disk-full, permission loss, atomic rename, invocation ledger ambiguity, real
process kill, process-tree timeout, output flood, apply rollback, commit hook,
cleanup retry, Git conflict, corrupt restart state, and bounded recovery.

### Phase 4.4 — Operations Center and Resource Governance

Status: **IMPLEMENTED — GOVERNANCE CONTRACT VERIFIED 2026-08-22**

- `GET /api/operations/readiness` and `operations-readiness` publish one
  deterministic admission decision. The projection includes disk free space,
  verified backup freshness, runtime/artifact quotas, audit-chain integrity,
  queue age, deadline/provider failures, and daemon signal.
- Production launcher enables `ORCHESTRATOR_ENFORCE_OPERATIONS_GUARD=1`.
  A blocked readiness state prevents daemon admission and dashboard run starts;
  developer fixtures remain explicitly non-enforcing unless that policy is set.
- API traffic has separate read/mutation request buckets (240/120 per minute by
  default), while SSE connections are capped at 20 by default and return 429
  with `Retry-After` when full. Limits are configurable through
  `ORCHESTRATOR_MAX_SSE_CLIENTS`, `ORCHESTRATOR_MIN_FREE_DISK_MB`,
  `ORCHESTRATOR_MAX_RUNTIME_BYTES`, `ORCHESTRATOR_MAX_ARTIFACT_BYTES`,
  `ORCHESTRATOR_MAX_BACKUP_AGE_HOURS`, and `ORCHESTRATOR_MAX_QUEUE_AGE_MINUTES`.
- Retention is preview-first. `retention-preview` writes an expiring plan;
  `retention-purge <plan-id> --confirm` requires a bound operator identity and
  moves only old workspace artifacts/backups into recoverable runtime trash.
  It never auto-deletes Vault, source, audit, run manifests, or evidence.
  `retention-restore <trash-id> --confirm` restores a non-conflicting trash item.
- Alerts expose severity, a stable deduplication key, acknowledgement semantics,
  an action, and an operator runbook. The Dashboard Operations page visualizes
  the same readiness object, active alerts, and retention confirmation flow.

Exit gate: the dashboard detects and explains every Phase 4.3 injected failure,
and no automated cleanup deletes audit or source data without confirmation.

### Phase 4.5 — Production Readiness Certification

Status: **IMPLEMENTED — CERTIFIED 2026-08-22**

- Revalidated two immutable, human-accepted scoped pilots: `TASK-003` on
  `test-add-project` and `TASK-025` on `orchestrator-dashboard`. Both retain
  passing scope, pre/post-apply verification, evidence integrity, and cleaned
  workspace records. `FE-024` on `starter-app` remains an additional completed
  pilot but was not rerun because that repository has user-owned local files.
- Reran `typecheck`, `build`, and `test:e2e` on clean `test-add-project`; reran
  dashboard typecheck/lint/build/security/browser verification; and reran the
  complete orchestrator regression suite.
- Created, SHA-256 verified, and restored quiescent backup
  `dr-20260822T001634Z-e9fed046` (1,637 files / 85,633,652 bytes) into an
  isolated recovery root. The restored inspection API returned `200` while a
  mutation returned `423`, proving quarantine execution denial. Updater crash
  rollback regression also passed; live daemon restart restored healthy state.
- Re-reviewed the threat model. No CRITICAL or HIGH risk remains. The one
  MEDIUM operational dependency has owner, review date, compensating controls,
  and explicit local-supervised acceptance recorded in the certificate.
- Wrote a private checksummed bundle under
  `runs/runtime/certifications/phase4-cert-20260822T002000234Z-e23bed2f.json`
  (`b4664ee0cfe28ee226cc9df1f5c6e1a7b9f9cf07c7786aaa98774e0ea848d28b`).
  `certification-verify` verifies its checksum and schema.

Exit gate: no open CRITICAL or HIGH finding; all mandatory drills pass; residual
MEDIUM risks have an owner, expiry, and explicit human acceptance.

## Phase 4 Global Exit Criteria

Phase 4 is complete only when:

- P4-001 through P4-004 are closed with automated adversarial evidence;
- a tested backup meets declared RPO/RTO and restores without executing work;
- child processes receive least privilege rather than the full user environment;
- stored evidence is private, redacted, bounded, and tamper-evident;
- concurrency and fault-injection suites show no duplicate execution;
- operations health detects low disk, stale backup, stuck processes, corrupt
  evidence, and degraded dependencies;
- the full orchestrator and dashboard regression suites pass repeatedly;
- a Phase 4.5 certificate records any accepted residual risk.

## Phase 4.0 Decision

Continue local supervised pilots, but do not expose the API beyond loopback or
allow unattended execution. The recovery floor is established. Execute
**Phase 4.2** next to close host capability isolation, evidence secrecy,
operator identity, audit integrity, and SSE-origin findings.
