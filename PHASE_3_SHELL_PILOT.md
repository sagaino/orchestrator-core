# Phase 3 — AI OS Shell and Pilot Readiness

Status: **SCOPE FROZEN — PHASE 3.0 COMPLETE**

This phase closes the remaining AI OS MVP gap: one real registered project must
complete the controlled software-engineering lifecycle through the dashboard,
with evidence that a human can inspect and reconstruct after completion.

Phase 3 does not replace the control plane implemented in Phases 1 and 2. The
dashboard remains a human-operated shell over the same local API, durable run
manifests, Obsidian task records, Git repositories, and isolated workspaces.

## Phase Outcome

A human operator can use the dashboard to:

1. submit a request for a registered project;
2. inspect the canonical task, readiness result, and frozen execution policy;
3. approve execution when approval is required;
4. observe queue, execution, verification, and recovery state;
5. inspect changed paths, diff, logs, verification results, and visual evidence;
6. request changes, reject, or accept with an explicit Git finalization choice;
7. inspect the final commit, applied paths, knowledge decision, and audit trail;
8. reconstruct the completed pilot after a normal daemon or dashboard restart.

## Phase 3.0 Baseline Audit

The live dashboard and its source were audited against the MVP lifecycle on
2026-08-22.

### Present and usable

- local daemon health, worker capacity, heartbeat, and durability status;
- registered projects and project verification defaults;
- natural-language task intake, clarification, attachments, and auto-start;
- live job queue and SSE connection state;
- run search and filters for active, review, done, and failed runs;
- run timeline, diff, event logs, visual QA dev server, and retrospective tabs;
- explicit approve, request-changes, accept, reject, recover, and retry actions;
- transactional auto-commit choice during acceptance;
- notification inbox, knowledge center, and telemetry views.

### Blocking gaps found

| ID | Gap | Evidence | Required correction |
|---|---|---|---|
| P3-001 | Run evidence schema is inconsistent between API and shell. | A completed `TASK-001` displayed `Scope Audit: FAIL / PENDING` and no verification results even though its timeline recorded successful scope audit, typecheck, and build. | Publish a versioned, user-facing run evidence DTO from the control plane and consume that DTO in the shell. Do not infer safety state from missing fields. |
| P3-002 | Finalization evidence is not a first-class completed-run view. | Applied paths, post-apply verification, artifact path, and transactional Git commit live under workspace state but are not presented together in the inspector. | Add a finalization card containing acceptance identity, applied paths, post-apply gates, commit hash or explicit no-commit decision, artifact location, and cleanup state. |
| P3-003 | Task intake does not expose the frozen plan before execution clearly enough for a full shell-only audit. | Context and plan API capabilities exist, while intake primarily reports the created task and queue result. | Add a task confirmation surface showing allowed paths, verification scripts, approval mode, and readiness findings before execution approval. |
| P3-004 | Dashboard lifecycle behavior lacks an automated browser contract. | The dashboard has typecheck, lint, build, and security tests but no end-to-end lifecycle browser suite. | Add deterministic browser tests backed by isolated fixtures or a test runtime. Cover positive, rejection, verification failure, and restart-visible states. |
| P3-005 | Restart readiness is visible in backend tests but not proven through the shell. | Phase 2 covers durable reconciliation; the shell has no acceptance test proving recovered states and required next actions are rendered correctly. | Add shell tests for `QUEUED`, interrupted `RUNNING`, failed `VERIFYING`, preserved `REVIEW`, and safe manual recovery guidance. |

## Versioned Shell Contract

The dashboard must consume a stable projection instead of coupling itself to
the internal run-manifest layout. The projection may extend the existing
`reviewBundle()` model and must include:

- `schemaVersion`, `runId`, project, task, state, and `nextAction`;
- approval and acceptance actors and timestamps;
- frozen allowed paths and verification commands;
- scope result with changed, out-of-scope, and denied paths;
- verification command, exit code, status, and bounded output tails;
- workspace state, diff availability, artifacts, and visual evidence;
- post-apply verification and Graphify results;
- applied paths and Git finalization result;
- knowledge proposal, decision, and sync destination;
- compact telemetry with stable invocation identities;
- ordered audit history.

Missing safety evidence must render as **UNKNOWN / UNAVAILABLE**, never as PASS.
Contradictory evidence must render as an explicit data-integrity warning.

## Delivery Plan

### Phase 3.1 — Evidence Contract and Inspector

- Add and test the versioned run-evidence API projection.
- Migrate the Runs inspector to the projection.
- Correct scope and verification rendering for historical and new runs.
- Add finalization, commit, artifact, and acceptance evidence.

Exit gate: a completed historical run and a new run both render truthful scope,
verification, finalization, and audit evidence without reading raw manifests in
the browser.

### Phase 3.2 — Task Confirmation and Lifecycle UX

- Expose canonical task plan, allowed paths, verification, and policy before
  approval.
- Make approval mode and auto-start consequences explicit.
- Show a single authoritative next action for every lifecycle state.
- Keep destructive and acceptance actions behind explicit confirmation.

Exit gate: the operator can move a task from intake to review without using the
CLI and can identify exactly what will run before approval.

### Phase 3.3 — Dashboard Browser and Restart Tests

- Add deterministic browser fixtures for lifecycle states.
- Cover intake, approval, review evidence, request changes, reject, and accept.
- Cover verification failure and restart reconciliation projections.
- Preserve screenshots and traces for failed browser gates.

Exit gate: dashboard typecheck, lint, build, security tests, and browser
lifecycle tests are mandatory verification defaults for the dashboard project.

### Phase 3.4 — Real Pilot Certification

- Execute a scoped task on `test-add-project` from the dashboard.
- Review all evidence and accept it from the dashboard.
- Restart the local services and confirm the completed audit remains available.
- Record the run ID, task ID, commit hash, verification evidence, artifacts, and
  knowledge outcome in a pilot certificate.

Exit gate: the MVP success measure “one real registered project completes the
full lifecycle through the AI OS shell” is satisfied and reproducible.

## Non-Goals

Phase 3 does not add multi-user access, cloud workers, autonomous self-accept,
general desktop automation, a plugin marketplace, or public network exposure.
It does not weaken any Phase 1 security property or Phase 2 durability and
transactional-finalization guarantee.

## Phase Exit Criteria

Phase 3 is complete only when:

- all Phase 3.1–3.4 exit gates pass;
- every applied pilot path is authorized and explicitly human-accepted;
- failed or rejected pilots leave the source repository unchanged;
- the shell displays scope, verification, acceptance, commit, artifact, and
  knowledge evidence truthfully after restart;
- the pilot audit identifies who approved, what ran, what changed, what was
  verified, and what was applied;
- the orchestrator and dashboard regression suites pass.
