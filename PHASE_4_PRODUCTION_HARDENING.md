# Phase 4 — Production Hardening and Controlled Operations

Status: **PHASE 4.1 IMPLEMENTED — PRODUCTION CERTIFICATION BLOCKED**
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
| P4-001 | CRITICAL | Agent and repository-controlled child processes inherit the user's environment, filesystem authority, and network access. Worktree isolation cannot prevent host mutation or secret exfiltration. | 4.2 |
| P4-002 | CLOSED | Versioned quiescent backup now covers Vault, runtime state, evidence, and configuration metadata; verified quarantine restore preserves permissions and blocks execution. Independent-media scheduling remains an operational requirement. | 4.1 |
| P4-003 | HIGH | Run evidence and process output may contain sensitive material; many records are `0644` and no general structured redaction occurs before persistence. | 4.2 |
| P4-004 | HIGH | Concurrent admission produced two job IDs in one baseline run, although 25 subsequent stress executions and the final suite passed. The exactly-once property therefore needs deterministic reproduction and fault proof. | 4.3 |
| P4-005 | MEDIUM | Approval actor names come from authenticated request payloads under one shared token; evidence proves token possession, not an independently authenticated human identity. | 4.2 |
| P4-006 | MEDIUM | No API rate limit, SSE client ceiling, runtime quota, artifact retention policy, low-disk guard, or universal child-process deadline exists. | 4.3/4.4 |
| P4-007 | MEDIUM | Health is fragmented and does not provide one readiness decision covering daemon, Vault, repositories, disk, backups, queue age, provider reachability, and evidence integrity. | 4.4 |
| P4-008 | MEDIUM | Evidence is durable but not cryptographically integrity-protected; a process with user-level filesystem access can rewrite historical JSON/JSONL records. | 4.2/4.4 |
| P4-009 | LOW | SSE emits `Access-Control-Allow-Origin: *` even though the request layer rejects foreign origins. The inconsistent defense should be removed. | 4.2 |
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

Status: **BLOCKED BY P4-001/P4-003/P4-005/P4-008/P4-009**

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

### Phase 4.3 — Reliability and Failure Injection

Status: **BLOCKED BY P4-004/P4-006**

- Reproduce and eliminate the concurrent admission split.
- Add repeated race tests and deterministic fault injection around lease,
  rename, manifest, queue, apply, commit, and cleanup boundaries.
- Test process kill, timeout, disk-full, permission loss, Git conflict, corrupt
  state, provider interruption, and restart during every active lifecycle state.
- Enforce bounded retries and child-process deadlines.

Exit gate: the reliability suite completes repeated stress runs with zero
duplicate invocation, zero silent approval, zero out-of-scope mutation, and a
documented safe terminal state for every injected fault.

### Phase 4.4 — Operations Center and Resource Governance

Status: **PLANNED**

- Publish one readiness projection with actionable degraded reasons.
- Add queue-age, disk, backup freshness, artifact growth, process deadline,
  provider failure, and evidence-integrity signals.
- Add quotas, retention preview, explicit purge approval, and recoverable trash.
- Define alert severity, deduplication, acknowledgement, and operator runbooks.

Exit gate: the dashboard detects and explains every Phase 4.3 injected failure,
and no automated cleanup deletes audit or source data without confirmation.

### Phase 4.5 — Production Readiness Certification

Status: **PLANNED**

- Run multiple real scoped tasks across at least two registered projects.
- Complete backup/restore and crash-recovery drills from the dashboard/runbook.
- Re-run the threat model and close or explicitly accept every residual risk.
- Record reliability, recovery, resource, security, and audit evidence in a
  signed or checksummed certification bundle.

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
