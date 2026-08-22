# Personal AI OS — MVP Scope Contract

Status: **FROZEN FOR MVP**
Scope version: **1.0**
Owner: **Human operator**
Host platform: **macOS**
Execution model: **Local-first, single-user**

## 1. Product Definition

Personal AI OS is an agentic operating layer that runs on top of macOS. It is not a replacement for the macOS kernel, device drivers, process scheduler, or native security model.

The existing Personal AI Orchestrator is the AI OS control plane. It coordinates user intent, project context, policy checks, approvals, isolated agent execution, verification, human review, knowledge capture, notifications, and telemetry.

The dashboard is the AI OS shell. The Obsidian Vault is the durable human-readable memory layer. Git repositories remain the source of truth for project code.

## 2. MVP Outcome

The MVP must let one local human operator complete a software-engineering task through a single controlled flow:

1. Submit a natural-language request for a registered project.
2. Generate a structured task and execution plan.
3. Evaluate policy, scope, verification, and approval requirements.
4. Queue the approved task.
5. Execute the coding agent inside an isolated Git worktree.
6. Audit changed paths and run the configured verification commands.
7. Present the result, diff, logs, and preview for human review.
8. Accept, reject, or request changes.
9. Apply accepted changes transactionally to the source repository.
10. Record the outcome in project history, knowledge memory, notifications, and telemetry.

The MVP is successful when this flow survives normal application restarts without silently duplicating work, losing approval state, or modifying files outside the authorized boundaries.

## 3. In Scope

### 3.1 AI OS Control Plane

- Intent and task intake for registered local projects.
- Project, agent, tool, and context selection.
- Explicit policy and approval gates.
- Persistent job queue with project-level execution isolation.
- Agent execution, automatic recovery, and review revisions.
- Scope audit using task `allowed_paths`.
- Verification using approved repository scripts.
- Human acceptance before applying changes.

### 3.2 AI OS Shell

- System health and runtime status.
- Project registry and onboarding.
- Task intake and live queue.
- Run detail, logs, diff, and preview.
- Approval and review actions.
- Notification inbox.
- Knowledge explorer and candidate review.
- Telemetry and resource-usage views.
- Security and capability visibility.

### 3.3 Memory

- Obsidian Vault as the durable, inspectable memory store.
- Project pages, task documents, Wiki knowledge, candidates, and source artifacts.
- Retrieval of relevant knowledge before execution.
- Retrospective classification after verified execution.
- Human control over global knowledge promotion.

### 3.4 Runtime and Host Integration

- macOS as the host operating system.
- Node.js backend daemon and React dashboard.
- Local Git repositories and detached Git worktrees.
- Antigravity (`agy`) as the initial coding-agent provider.
- Graphify as optional project dependency context.
- Local desktop and in-dashboard notifications.

## 4. Explicitly Out of Scope

The following capabilities are not part of the MVP and must not delay it:

- Replacing the macOS or Linux kernel.
- Multi-user accounts, teams, organizations, or role administration.
- Public internet access to the dashboard or API.
- Cloud-hosted control plane or remote worker fleet.
- Mobile or cross-device synchronization.
- Autonomous execution without the configured human approval gates.
- Third-party plugin marketplace.
- Billing, subscriptions, or provider payment reconciliation.
- General-purpose desktop automation outside registered capabilities.
- Container or virtual-machine orchestration.
- Support for every AI model or provider.
- Automatic deletion or irreversible cleanup without explicit human confirmation.

Out-of-scope work requires a new scope version and explicit human approval.

## 5. Source-of-Truth Boundaries

| Concern | Source of truth |
|---|---|
| Project code | Registered Git repository |
| Task specification | Obsidian project task document |
| Project and global knowledge | Obsidian Vault |
| Runtime state | Orchestrator state store |
| Execution evidence | Run events, logs, verification, and workspace artifacts |
| Human authorization | Recorded approval and review decisions |
| Dependency topology | Repository plus Graphify output when enabled |

No generated summary may override its underlying source of truth.

## 6. Execution Lifecycle Contract

The target AI OS lifecycle is:

```text
DRAFT
  -> PLANNED
  -> WAITING_APPROVAL
  -> QUEUED
  -> RUNNING
  -> VERIFYING
  -> REVIEW
  -> APPLYING
  -> DONE
```

Allowed recovery branches:

```text
RUNNING | VERIFYING
  -> RECOVERING
  -> VERIFYING | REVIEW | FAILED

REVIEW
  -> CHANGES_REQUESTED
  -> RUNNING

REVIEW
  -> REJECTED
```

Every transition must be auditable. A process crash must not imply approval, acceptance, or completion.

## 7. Mandatory Safety Properties

The MVP is not releasable unless all properties below hold:

1. API credentials are generated and provisioned at runtime; no active credential is committed to source or bundled into browser assets.
2. Backend and dashboard bind to local interfaces by default.
3. Every filesystem write, read, delete, and upload target is proven to be inside an explicitly authorized root after resolving symlinks.
4. Agent execution occurs in an isolated workspace.
5. Changed paths outside task scope stop the run.
6. Verification definitions cannot be silently weakened by the executing agent.
7. Applying workspace changes is transactional and recoverable.
8. Idempotency is scoped to request identity, endpoint, method, and payload.
9. A task cannot be executed twice because of concurrency or restart recovery.
10. Human approval and acceptance cannot be synthesized by an agent.
11. Secrets and credential files are excluded from agent context and workspace transfer.
12. Destructive project and knowledge actions require explicit confirmation and an audit record.

## 8. MVP Quality Gates

The MVP can move from development to pilot only when:

- Backend unit and smoke tests pass.
- Dashboard typecheck, lint policy, and production build pass.
- Security tests cover path traversal, symlink escape, secret exposure, origin validation, and token rotation.
- Transaction tests cover queue claiming, run transitions, apply rollback, and daemon restart recovery.
- Telemetry does not double-count the same provider invocation.
- A complete task can be accepted and applied with no out-of-scope file changes.
- A rejected task leaves the source repository unchanged.
- Restart testing demonstrates recovery from `QUEUED`, `RUNNING`, `VERIFYING`, and `REVIEW`.
- The pilot audit record can reconstruct who approved, what ran, what changed, what was verified, and what was applied.

## 9. MVP Success Measures

For the initial pilot cohort:

- 100% of applied runs have explicit human acceptance.
- 100% of applied paths are inside the approved scope or explicitly recorded automatic dependency paths.
- 0 active credentials are present in tracked source or frontend bundles.
- 0 duplicated executions after restart or repeated requests.
- 0 unrecoverable source-repository mutations from rejected or failed runs.
- 100% of reported AI calls have a stable invocation identity.
- At least one real registered project completes the full lifecycle through the AI OS shell.

## 10. Preserved Technical Decisions

The MVP intentionally preserves the current stack:

- Node.js ES modules for the control plane.
- React and Vite for the AI OS shell.
- Obsidian Markdown for durable human-readable memory.
- Git worktrees for execution isolation.
- Local files for logs and artifacts.

The runtime state store may move from individual JSON state files to SQLite during the durability phase. This is an implementation change, not a product-scope expansion.

## 11. Phase Exit and Change Control

Phase 0 is complete when this document is tracked in the repository, linked from the main README, and accepted by the human owner.

Subsequent implementation phases must reference this contract. A proposed feature that conflicts with the In Scope, Out of Scope, or Mandatory Safety Properties sections must be documented as a scope change before implementation.

The MVP scope remains the product boundary. Work after the Phase 0–4 MVP
certification follows the separately versioned
[Phase 5 to v1.0 Execution Plan](./PHASE_5_TO_V1_EXECUTION_PLAN.md); it is a
sequenced hardening and release roadmap, not a replacement for this scope
contract. Any post-MVP work must continue to preserve the safety properties and
out-of-scope restrictions defined above.

Implementation status:

- **Phase 0 — MVP Scope Contract:** complete.
- **Phase 1 — Security Hardening:** complete.
- **Phase 2 — Runtime Durability and Exactly-Once Execution:** implemented; see [Phase 2 Runtime Durability Contract](./PHASE_2_DURABILITY.md).
- **Phase 3 — AI OS Shell and Pilot Readiness:** Phase 3.0 scope frozen; see [Phase 3 Shell and Pilot Contract](./PHASE_3_SHELL_PILOT.md).
- **Phase 4 — Production Hardening and Controlled Operations:** complete; see [Phase 4 Production Hardening](./PHASE_4_PRODUCTION_HARDENING.md) and [Phase 4 Production Certificate](./PHASE_4_PRODUCTION_CERTIFICATE.md).
- **Phase 5 — Cost and Context Efficiency:** complete through P5.4; efficiency certification was human-accepted with a 36.83% median token reduction; see [Phase 5 to v1.0 Execution Plan](./PHASE_5_TO_V1_EXECUTION_PLAN.md).
- **Phase 6 — Guarded Release and Self-Update:** complete through P6.5; all Phase 6 packets are human-accepted. P6.5 proves one isolated successful activation and one forced rollback while preserving source/candidate/supervisor separation and durable checksum/audit evidence. Production activation remains separately human-gated; see [Phase 6 Release Compatibility Contract](./PHASE_6_RELEASE_CONTRACT.md).
- **Phase 7 — Visual QA Completion:** P7.0 through P7.5 are human-accepted. The versioned evidence contract, dashboard inspector, bounded multi-viewport capture, deterministic comparison, layout diagnostics, bounded accessibility evidence, durable visual feedback revision linkage, and human-gated visual certification are complete. See [Phase 7 Visual QA Contract](./PHASE_7_VISUAL_QA_CONTRACT.md).
- **Phase 8 — Knowledge and Long-Running Operations:** P8.0–P8.5 are human-accepted. The phase now covers provenance, reversible maintenance, alert ownership/action, backup and recovery review, deterministic soak/capacity evidence, and the final human-gated operations certification. Synthetic soak work is never executed or automatically approved. Legacy provenance warnings remain explicit for directed migration. See [Phase 8 Knowledge Contract](./PHASE_8_KNOWLEDGE_CONTRACT.md).
- **Phase 9 — v1.0 GA Certification:** P9.0 and P9.1 are human-accepted. P9.0 records supported hosts, dependency lock checksums, absolute data roots, uninstall preservation, and external rollback steps. P9.1 provides a versioned, repeatable, checkpoint-backed migration matrix for clean install, Phase 4 upgrade, restore-then-upgrade, incompatible schema, interruption, and rollback. Production migration/activation remains separately gated. P9.2–P9.4 remain planned. See [Phase 9 GA Contract](./PHASE_9_GA_CONTRACT.md).
