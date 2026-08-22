# Phase 5 to v1.0 Execution Plan

Status: **PLANNED — READY FOR TASK PACKET EXECUTION**  
Plan date: **2026-08-22 (Asia/Jakarta)**  
Starting point: **Phase 4 production-certified**  
Final target: **Personal AI OS v1.0 GA, local-first, single-user, supervised macOS**

## 1. Purpose and Final Boundary

This plan turns the remaining product roadmap into small, deterministic task
packets that can normally be implemented by an economy model. Architectural,
security-boundary, migration, release activation, and final certification
decisions still require a stronger reviewer and explicit human acceptance.

The v1.0 final state includes:

- measurable token efficiency without lower verification quality;
- guarded self-update with an external rollback path;
- first-class visual QA and accessibility evidence;
- maintainable knowledge, alert, backup, and long-running operations;
- reproducible installation, upgrade, recovery, and GA certification.

The following remain outside v1.0: public network exposure, multi-user roles,
cloud workers, mobile synchronization, unattended execution, general desktop
automation, third-party marketplace, billing, and irreversible automated
cleanup. Any of them requires an `AI_OS_SCOPE_V2.md` approved before code work.

## 2. Economy-Model Execution Protocol

Execute exactly one task packet per task/run. Do not combine packets merely to
save turns.

Every packet must follow this sequence:

1. Run `graphify query` for the packet objective and inspect the listed files.
2. Confirm both target repositories are clean, except explicitly documented
   user-owned files. Never overwrite or stage unrelated changes.
3. Freeze `allowed_paths`, acceptance criteria, and verification commands in
   the task before implementation.
4. Implement only the frozen packet. No opportunistic refactor or dependency
   upgrade is allowed.
5. Add or update a deterministic test before claiming the behavior works.
6. Run the packet verification, then the owning repository's full gate.
7. Run `graphify update .` in every modified code repository.
8. Produce evidence: changed paths, test results, risk, rollback, and remaining
   warnings. Human acceptance remains separate from implementation.

The economy model must stop and escalate when:

- required behavior conflicts with Phase 0–4 safety contracts;
- a manifest/schema migration is ambiguous or not backward-compatible;
- a security profile, updater activation, rollback, or recovery rule changes;
- a test exposes duplicate execution, evidence corruption, secret leakage,
  out-of-scope writes, or silent approval;
- implementation needs a new runtime dependency not named by the packet;
- the repository is dirty in an overlapping path;
- acceptance criteria cannot be satisfied without expanding scope.

Model labels used below:

- `ECONOMY`: implementation and deterministic verification may use the cheaper
  model. Default recommendation: `gpt-5.6-luna` with medium reasoning.
- `ECONOMY + STRONG REVIEW`: cheaper model may implement, but a strong model
  must review the diff and failure evidence before human acceptance. Default
  reviewer recommendation: `gpt-5.6-sol` with high reasoning, used only for the
  review turn rather than reimplementing the packet.
- `HUMAN GATE`: no model may approve, activate, promote, or certify the result.

Token discipline for an economy packet:

- Graphify query budget: approximately 1,200–2,000 tokens and one focused
  follow-up query only when the first result is insufficient.
- Read only the task contract, directly linked source files, and relevant test;
  never preload complete run history or the entire Wiki.
- Keep one implementation objective and one repository per packet, except an
  explicitly named API/dashboard wiring packet.
- Stop after two unsuccessful fix cycles and escalate with the exact failing
  evidence; do not spend an open-ended token budget guessing.
- A strong review consumes the economy model's diff and evidence summary, not a
  fresh full-codebase exploration.

## 3. Dependency Map

```text
Phase 5 — Cost and Context Efficiency
  -> Phase 6 — Guarded Release and Self-Update
      -> Phase 7 — Visual QA Completion
          -> Phase 8 — Knowledge and Long-Running Operations
              -> Phase 9 — v1.0 GA Certification
```

Phase order is strict. Packets inside a phase are sequential unless the packet
explicitly says otherwise.

## 4. Phase 5 — Cost and Context Efficiency

Objective: reduce median token use by at least 30% from a reproducible baseline
without reducing verification pass rate, evidence completeness, or safety.

### P5.0 — Reproducible Token Benchmark

- Model: `ECONOMY`
- Scope: add a versioned benchmark corpus for simple, medium, UI, recovery, and
  knowledge tasks; normalize per-stage token and latency metrics.
- Primary paths: `src/telemetry.mjs`, new `src/token-benchmark.mjs`, new
  `test/token-benchmark.test.mjs`, `package.json`.
- Verification: benchmark fixture is deterministic; duplicate invocation data
  is rejected; baseline report can be reproduced without provider calls.
- Exit evidence: checked-in benchmark definition and private baseline result.

### P5.1 — Deterministic Routing Policy

- Model: `ECONOMY + STRONG REVIEW`
- Scope: route intake, retrospective, knowledge classification, implementation,
  and recovery by frozen risk/complexity rules. Unknown or high-risk input must
  choose the stronger tier.
- Primary paths: `src/agent-config.mjs`, `src/task-intake.mjs`,
  `src/knowledge-workflow.mjs`, new routing tests.
- Verification: table-driven routing tests cover every risk and stage; payload
  labels cannot request a cheaper tier than policy permits.

### P5.2 — Context Budget and Delta Retrieval

- Model: `ECONOMY`
- Scope: enforce per-stage context budgets; use `allowed_paths`, Graphify delta,
  latest diff, compact revision state, and bounded knowledge selection.
- Primary paths: `src/context-compactor.mjs`, `src/core.mjs`, `src/executor.mjs`,
  related tests.
- Verification: golden fixtures prove relevant acceptance criteria and latest
  feedback are retained while unrelated history is omitted.

### P5.3 — Operational Signal Cleanup

- Model: `ECONOMY`
- Scope: add time-window decay and acknowledgement history for provider/deadline
  warnings; close the eight known dashboard lint warnings; split the largest
  lazy-loadable dashboard routes.
- Primary backend paths: `src/operations-governance.mjs`, `src/server.mjs`,
  operations tests.
- Primary dashboard paths: the eight currently warned files, `src/routes/`, and
  build configuration only when required.
- Verification: zero lint warnings, browser suite pass, bundle warning removed
  or a measured exception documented, readiness alerts expire predictably.

### P5.4 — Efficiency Certification

- Model: `ECONOMY`; final decision is `HUMAN GATE`.
- Scope: rerun the frozen benchmark and compare it with P5.0.
- Exit gate: median tokens decrease at least 30%; p95 is reported; verification
  pass rate and safety suites do not regress; every task has a knowledge
  decision; no new HIGH/CRITICAL finding.

## 5. Phase 6 — Guarded Release and Self-Update

Objective: allow the orchestrator to prepare its own release candidate while an
external supervisor, strong review, and human acceptance retain activation and
rollback authority.

### P6.0 — Release Compatibility Contract

- Model: `ECONOMY + STRONG REVIEW`
- Scope: define versioned runtime, manifest, API, dashboard, Vault, and rollback
  compatibility; explicitly forbid self-accept and in-process activation.
- Primary paths: new `PHASE_6_RELEASE_CONTRACT.md`, schema fixtures, version
  constants.
- Exit gate: old runtime/new data and new runtime/old data outcomes are defined
  before updater code changes.

### P6.1 — Release Candidate Builder

- Model: `ECONOMY + STRONG REVIEW`
- Scope: build a checksummed candidate in a separate directory; include source
  commit, lockfile, compatibility version, regression result, and provenance.
- Primary paths: `src/updater.mjs`, new `src/release-candidate.mjs`, updater
  tests, CLI wiring.
- Verification: partial or altered candidates are rejected; stable runtime is
  never overwritten during build.

### P6.2 — External Supervisor and Queue Drain

- Model: `ECONOMY + STRONG REVIEW`; activation is `HUMAN GATE`.
- Scope: external process drains admission, waits for safe terminal states,
  creates a backup, activates the candidate atomically, and owns rollback.
- Primary paths: new external supervisor module/script, `src/daemon.mjs`,
  `start.sh`, release tests.
- Verification: active/uncertain invocation blocks activation; operator session
  cannot be synthesized by the candidate.

### P6.3 — Health, Compatibility, and Rollback Drills

- Model: `ECONOMY + STRONG REVIEW`; promotion is `HUMAN GATE`.
- Scope: inject startup crash, missing heartbeat, corrupt manifest, incompatible
  schema, failed migration, and failed health probe.
- Verification: every injected failure restores the exact stable version,
  preserves diagnostics, and never replays uncertain work.

### P6.4 — Release Operations UI

- Model: `ECONOMY`
- Scope: Operations page shows current/candidate version, queue-drain state,
  compatibility result, backup ID, health checks, rollback evidence, and the
  explicit activation confirmation.
- Primary paths: operations API DTO, dashboard service/hooks, Operations page,
  browser fixtures.

### P6.5 — Guarded Self-Update Certification

- Model: `ECONOMY + STRONG REVIEW`; certificate is `HUMAN GATE`.
- Exit gate: one successful candidate activation and one forced rollback drill;
  source, stable runtime, and supervisor remain separate; audit and checksums
  reconstruct both outcomes.

## 6. Phase 7 — Visual QA Completion

Objective: make UI tasks reviewable through durable visual and accessibility
evidence, not only code diff and a temporary preview.

### P7.0 — Visual Evidence Contract

- Model: `ECONOMY`
- Scope: versioned DTO for route, viewport, reference, actual screenshot,
  comparison, accessibility findings, revision, and artifact checksum.
- Primary paths: `src/interaction.mjs`, `src/server.mjs`, evidence tests,
  dashboard types.

### P7.1 — Multi-Viewport Capture

- Model: `ECONOMY`
- Scope: capture desktop, tablet, and mobile through bounded Playwright jobs
  owned by the run; persist evidence outside source repositories.
- Primary paths: `src/dev-server-manager.mjs`, new visual QA service, tests.
- Verification: timeout/process-tree limits apply; a failed viewport remains
  explicit and does not become PASS.

### P7.2 — Comparison and Layout Diagnostics

- Model: `ECONOMY`
- Scope: side-by-side and overlay evidence; detect horizontal overflow,
  clipped elements, missing target route, and viewport capture mismatch.
- Primary paths: visual QA service and dashboard Runs components.
- Verification: deterministic screenshot fixtures cover pass, mismatch, and
  unavailable reference cases.

### P7.3 — Accessibility Evidence

- Model: `ECONOMY`
- Scope: bounded automated checks for labels, names, contrast metadata when
  available, focusability, obvious heading/order failures, and keyboard flow.
- Constraint: no new scanning dependency without an approved packet revision.
- Verification: findings are evidence, not automatically rewritten code.

### P7.4 — Visual Feedback Revision Loop

- Model: `ECONOMY`
- Scope: bind region annotations and viewport feedback to request-changes;
  preserve before/after evidence for every revision.
- Primary paths: existing diff/annotation components, Runs hooks, review API,
  context compactor.

### P7.5 — Visual QA Certification

- Model: `ECONOMY`; result is `HUMAN GATE`.
- Exit gate: one real scoped UI task completes multi-viewport capture,
  accessibility evidence, annotated revision, post-change capture, acceptance,
  restart reconstruction, and cleanup without source-artifact leakage.

## 7. Phase 8 — Knowledge and Long-Running Operations

Objective: keep the certified system useful and recoverable over time without
manual archaeology or uncontrolled growth.

### P8.0 — Knowledge Provenance and Quality Contract

- Model: `ECONOMY`
- Scope: require source/run provenance, confidence, owner, review date, and
  supersession state for global knowledge; retain project-only fast path.
- Primary paths: `src/knowledge-quality.mjs`, schemas, tests, Knowledge types.

### P8.1 — Duplicate, Merge, and Staleness Workflow

Implementation status: **IMPLEMENTED — HUMAN-ACCEPTED (2026-08-22)**

- Model: `ECONOMY`
- Scope: deterministic similarity candidates, explicit merge preview, stale
  review queue, and reversible index updates. No automatic content deletion.
- Primary paths: `src/knowledge-workflow.mjs`, `src/knowledge-quality.mjs`,
  Knowledge Center components and browser tests.

### P8.2 — Alert Ownership and Runbooks

Implementation status: **IMPLEMENTED — HUMAN-ACCEPTED (2026-08-22)**

- Model: `ECONOMY`
- Scope: durable acknowledgement, owner, snooze expiry, deduplication window,
  and resolution evidence for Operations alerts.
- Primary paths: `src/operations-governance.mjs`, audit/API routes, Operations
  page, tests.

### P8.3 — Backup Rotation and Recovery Review

Implementation status: **IMPLEMENTED — HUMAN-ACCEPTED (2026-08-22)**

- Model: `ECONOMY + STRONG REVIEW`; purge/promotion is `HUMAN GATE`.
- Scope: launchd-compatible reminder/schedule, independent-target status,
  retention preview, periodic verify, and overdue recovery drill alert.
- Verification: scheduling never promotes restore or permanently deletes a
  backup; stale/invalid backup blocks admission as before.

### P8.4 — Soak and Capacity Harness

Implementation status: **IMPLEMENTED — HUMAN-ACCEPTED (2026-08-22)**

- Model: `ECONOMY`
- Scope: deterministic 24/72-hour workload harness with bounded synthetic jobs,
  restart points, API/SSE load, artifact growth, and alert collection.
- Verification: no duplicate invocation, lost update, silent approval,
  unbounded client/output, or unrecoverable state.

### P8.5 — Operations Certification

Implementation status: **IMPLEMENTED — HUMAN-ACCEPTED (2026-08-22)**

- Model: `ECONOMY + STRONG REVIEW`; result is `HUMAN GATE`.
- Exit gate: 72-hour soak passes; backup is within RPO; a recovery drill is
  within RTO; all alerts have owner/action; knowledge health has no unresolved
  integrity error; resource trend remains within declared capacity.

## 8. Phase 9 — v1.0 GA Certification

Objective: make the local supervised product installable, upgradeable,
recoverable, documented, and reproducibly certified as v1.0.

### P9.0 — Release Manifest and Installation Contract

Implementation status: **HUMAN-ACCEPTED (2026-08-22)**

- Model: ECONOMY + STRONG REVIEW
- Model: `ECONOMY + STRONG REVIEW`
- Scope: versioned release manifest, supported macOS/Node versions, dependency
  verification, absolute data roots, uninstall behavior, and rollback steps.
- Primary paths: installer/start scripts, new release manifest, README/runbook,
  installation tests.

### P9.1 — Migration and Upgrade Matrix

Implementation status: **HUMAN-ACCEPTED (2026-08-22)**

- Model: `ECONOMY + STRONG REVIEW`; activation is `HUMAN GATE`.
- Scope: latest Phase 4 runtime to v1.0, clean install, restore then upgrade,
  incompatible future schema, interrupted migration, and rollback.
- Exit gate: migrations are versioned, repeatable, backed up, and fail closed.
- Evidence: `src/migration-upgrade.mjs`, `test/migration-upgrade.test.mjs`, and
  the checksummed `runs/runtime/migration-matrix/p9.1-report.json`.

### P9.2 — Final Pilot Cohort

Implementation status: **HUMAN-ACCEPTED (2026-08-22)**

- Model: `ECONOMY` for ordinary implementation; acceptance is `HUMAN GATE`.
- Scope: at least ten real scoped tasks across at least three clean registered
  projects, including code, UI, failure recovery, request-changes, rejection,
  and knowledge decisions.
- Exit gate: 100% accepted paths authorized; 0 duplicate invocation; 0 secret
  exposure; 0 unrecoverable rejected/failed mutation; every applied run has
  explicit human acceptance and complete evidence.
- Evidence: `src/final-pilot-cohort.mjs`, `test/final-pilot-cohort.test.mjs`, and
  the checksummed `runs/runtime/pilot-cohort/p9.2-report.json`.

### P9.3 — Operator Documentation and Recovery Rehearsal

- Model: `ECONOMY`
- Scope: install, start/stop, task lifecycle, review, update, alert, backup,
  restore, rollback, and emergency recovery documentation using UI-first steps.
- Exit gate: a clean recovery target reconstructs system state by following the
  runbook alone and remains quarantined until human promotion.

### P9.4 — Final Threat Model and v1.0 Certificate

- Model: `ECONOMY + STRONG REVIEW`; release is `HUMAN GATE`.
- Scope: rerun adversarial, reliability, recovery, operations, browser,
  benchmark, self-update, visual QA, soak, install, and migration gates; anchor
  audit head and release provenance in a checksummed certificate.
- Final gate: no CRITICAL/HIGH risk; MEDIUM risks have owner, control, expiry,
  and explicit human acceptance; repositories are clean; documentation and
  bundle checksums verify; human assigns version `v1.0.0`.

## 9. Final Definition of Done

The roadmap is complete only when P9.4 is human-accepted and all statements
below are true:

- normal task flow, review, visual QA, knowledge decision, and operations can be
  completed from the dashboard;
- source changes and runtime releases cannot self-approve;
- restart, update failure, and host-state restore have tested safe outcomes;
- the 30% median token-reduction target is met without quality regression;
- long-running resource, alert, backup, and knowledge health stay bounded;
- installation and upgrade are reproducible on a clean supported host;
- the v1.0 certificate and audit head are checksummed and independently
  verifiable.

After v1.0, stop adding phases under this contract. Any request for multi-user,
cloud, public access, unattended agents, mobile sync, or a plugin marketplace
must begin with a separately approved v2 scope and threat model.

## 10. Copyable Task Packet Template

Use this exact structure for every cheap-model execution task:

```yaml
phase_packet: P5.0
objective: one measurable outcome
model_tier: ECONOMY
requires_strong_review: false
requires_human_gate: false
repository: absolute registered repository path
allowed_paths: []
forbidden_paths: [.env, .env.*, credential files, unrelated source]
preconditions: []
acceptance_criteria: []
verification_commands: []
rollback: explicit reversible action
evidence_required: [changed_paths, tests, graphify, risk, remaining_warnings]
stop_and_escalate_if: [scope conflict, schema ambiguity, security regression]
```

The planner may narrow `allowed_paths`; it may not broaden them during
implementation. Any broadening creates a new task packet and requires human
approval.
