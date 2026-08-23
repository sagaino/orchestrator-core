# Personal AI OS v2 — Objective, Multi-Agent, and Cross-Project Orchestration Plan

Status: **PROPOSED — NOT YET IMPLEMENTED**  
Plan date: **2026-08-22 (Asia/Jakarta)**  
Owner and final approver: **Human operator**  
Starting point: **Personal AI OS v1.0.4, local-first, single-user, supervised**  
Target: **one user objective can become an approved, dependency-aware, multi-task execution across one or more registered projects**

## 1. Purpose

This document is the implementation contract for the next AI OS capabilities:

1. create a fresh project and its first objective from one Task Intake flow;
2. convert one large objective into a master plan and deterministic subtasks;
3. validate and persist a task dependency graph (DAG);
4. execute subtasks sequentially before enabling parallel execution;
5. integrate subtask results and run project-level quality gates;
6. assign temporary role-based sub-agents automatically;
7. diagnose and fix bugs across linked frontend/backend projects;
8. expose the graph, decisions, budgets, progress, and integration result in the dashboard;
9. add Telegram as an optional control and notification channel after a separate security gate;
10. add a formal Skill Registry and automatic Skill Router last.

This is an execution plan, not authorization to implement every phase at once. Each packet in section 13 must be created, reviewed, executed, and accepted separately.

## 2. Required Interpretation for Any Model

The words below have one fixed meaning throughout this plan:

| Term | Required meaning |
|---|---|
| Objective | The user's high-level request, for example “build a mini e-commerce project.” |
| Master plan | The approved architecture and ordered set of subtasks for one objective. |
| Subtask | One small canonical AI OS task executed through the existing task/run lifecycle. |
| DAG | A directed acyclic graph. A node is a subtask and an edge means “must finish before.” |
| Orchestration | Durable runtime state that schedules all nodes in one approved plan. |
| Role | A temporary responsibility such as `DIAGNOSTIC`, `FRONTEND`, or `BACKEND`. A role is not yet a formal skill. |
| Sub-agent | A task-scoped invocation of the existing coding-agent adapter with one role, one task, one workspace, and bounded permissions. |
| Integration | Combining verified subtask outputs and running checks that cover the whole objective. |
| Linked projects | Separately registered repositories with an explicit typed relationship, for example frontend `CONSUMES_API` backend. |
| Skill | A versioned reusable procedure selected from a registry. Wiki knowledge is context, not a skill. |

Models must not reinterpret “multi-agent” as permission for autonomous approval, public network access, unbounded concurrency, or unrestricted filesystem access.

## 3. Current Baseline: Reuse, Do Not Duplicate

The following capabilities already exist and must be extended rather than reimplemented:

| Existing capability | Existing implementation | Required reuse |
|---|---|---|
| New project onboarding | `src/project-onboarding.mjs`, `POST /api/projects/onboard/new` | Fresh Project must call this service; do not create a second scaffolder. |
| Natural-language Task Intake | `src/task-intake.mjs`, `POST /api/tasks/request` | Subtask materialization must reuse canonical task generation/readiness behavior. |
| Persistent queue | `src/job-queue.mjs` | DAG scheduler must enqueue existing jobs with additional orchestration metadata. |
| Parallel workers | `src/daemon.mjs#createParallelJobPool` | Reuse worker pool; do not start a second daemon. |
| Project-exclusive lease | `src/job-queue.mjs#claimNextJob` | Preserve until same-project parallel integration is explicitly enabled. |
| Run lifecycle | `src/run-manager.mjs` | Every executable subtask remains a normal run. |
| Isolated Git worktree | `src/workspace-manager.mjs` | Every sub-agent must run in an isolated worktree. |
| Scope and verification gates | `src/executor.mjs`, `src/task-readiness.mjs` | Never weaken `allowed_paths` or frozen verification scripts. |
| Model tier routing | `src/agent-routing.mjs`, `src/agent-config.mjs` | Keep model risk routing separate from the future Skill Router. |
| Preview and visual QA | `src/dev-server-manager.mjs`, visual QA modules | Objective preview must aggregate existing evidence. |
| Human review and transactional apply | `src/review-workflow.mjs`, `src/workspace-manager.mjs` | Objective-level acceptance must preserve explicit human authority. |
| Wiki retrieval and retrospective | knowledge workflow modules | Each subtask and final objective retain provenance and knowledge decisions. |
| Dashboard task intake | dashboard `src/pages/Tasks/` | Extend the existing screen; do not build a disconnected second intake. |

The current new-project flow supports the `frontend-vite` blueprint. Supporting backend, monorepo, or multi-repository blueprints is a separate expansion and must not be silently assumed by the Fresh Project packet.

## 4. Product Scope

### 4.1 In scope

- Local, single-user, human-supervised operation.
- Existing registered Git repositories and the existing deterministic new-project blueprint.
- One objective targeting one project or an explicitly linked set of projects.
- AI-generated plan followed by explicit human plan approval.
- Sequential execution as the first production mode.
- Bounded parallel execution after sequential certification.
- Temporary role prompts before formal skills exist.
- Durable restart recovery for objective, plan, graph, and scheduler state.
- Aggregate diff, verification, preview, and human acceptance.
- Optional Telegram control through an outbound or verified-webhook adapter only after threat-model approval.
- Formal Skill Registry and Skill Router only after the orchestration core is certified.

### 4.2 Explicitly out of scope

- Multi-user accounts, teams, or role-based access control.
- Public dashboard/API exposure.
- Cloud worker fleets.
- Agent-created approval or acceptance.
- Agents installing arbitrary plugins or skills without approval.
- Automatic production deployment.
- Real payment execution or access to production secrets.
- Parallel writes to overlapping paths.
- More than one active integration apply per repository.
- Arbitrary model-provider adapters. The plan is model-readable, but runtime provider expansion requires a separate adapter packet.
- Marketplace, billing, or irreversible cleanup.

## 5. Non-Negotiable Safety Invariants

Every phase must preserve all v1 safety properties plus the following:

1. Planning is read-only. A plan may not create, edit, queue, approve, or execute tasks.
2. Plan approval and result acceptance are separate human decisions.
3. Only an approved plan revision may be materialized into canonical tasks.
4. A changed plan creates a new revision and invalidates the previous approval.
5. A DAG containing a cycle, missing dependency, duplicate node ID, unknown project, unsafe path, or missing verification is rejected before materialization.
6. Dependency release occurs only after the predecessor run reaches `DONE`, not `REVIEW`, `VERIFYING`, or `FAILED`.
7. Plan approval may authorize execution of every unchanged node in that exact plan revision; each job and run must copy the human approval provenance and prove its node scope is a subset of the approved plan.
8. Every agent has exactly one primary task, role, project, repository, and workspace.
9. `role` and future `skills` may narrow behavior; they may never broaden paths, tools, model tier, or approval authority.
10. Current project-exclusive execution remains the default. Same-project parallel mode is disabled until packet V2-053 is accepted and activated by a human.
11. Concurrent nodes with overlapping predicted write paths cannot run in parallel.
12. Main repositories remain unchanged until the applicable human acceptance gate.
13. A cross-project operation records evidence and rollback state for every repository.
14. If one repository changes externally after its integration baseline was frozen, aggregate apply stops and requires re-plan/rebase review.
15. Runtime restart never converts uncertain work into `DONE` or replays an uncertain provider invocation.
16. Secrets are represented by references, never raw values in plans, prompts, events, task files, or Telegram messages.
17. Telegram cannot approve high-risk changes unless the linked local operator identity and one-time confirmation policy are both verified.
18. Skill selection cannot install, edit, or enable a skill automatically.

## 6. Target Architecture

```text
User Objective
    -> Objective Intake
    -> Project Context / Fresh Project Proposal
    -> Decomposer (read-only)
    -> Plan Validator
    -> Human Plan Approval
    -> Task Materializer
    -> Durable DAG Scheduler
    -> Existing Job Queue / Run Lifecycle
    -> Temporary Role-Based Sub-Agents
    -> Integration Manager
    -> Project / Cross-Project Verification
    -> Aggregate Preview and Human Acceptance
    -> Knowledge and Objective Completion
```

The orchestrator remains the only lifecycle owner. Agents edit code but do not mutate task state, graph state, approvals, integration state, Wiki indexes, or runtime manifests.

## 7. Durable Data Contracts

### 7.1 Storage layout

Use the existing `runsRoot` and atomic-write/lease patterns:

```text
runs/
  objectives/<objectiveId>.json
  plans/<planId>.json
  orchestrations/<orchestrationId>.json
  decisions/<decisionId>.json
  integration/<orchestrationId>/<projectId>/...
  skills/...                              # created only in final skill phase
```

Do not store mutable orchestration runtime only in the Obsidian Vault. Runtime JSON is authoritative for scheduling. Vault task documents remain authoritative for individual task specifications and human-readable history.

All state files require:

- `schemaVersion`;
- stable ID;
- `revision` optimistic concurrency counter;
- `createdAt` and `updatedAt` ISO timestamps;
- atomic temporary-file plus rename writes;
- owner-only file permissions where supported;
- validation before every write;
- redaction before persistence;
- durable lease around mutation.

### 7.2 Objective record

Minimum contract:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "objectiveId": "obj-20260822-<random>",
  "mode": "EXISTING_PROJECT",
  "state": "PLANNING",
  "request": "Fix checkout error and verify frontend/backend.",
  "requestedBy": "user",
  "projectIds": ["shop-frontend", "shop-backend"],
  "freshProject": null,
  "activePlanId": null,
  "activeOrchestrationId": null,
  "budget": {
    "maxSubtasks": 8,
    "maxParallelAgents": 2,
    "maxRetriesPerNode": 2,
    "maxTotalTokens": null,
    "deadlineAt": null
  },
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

Allowed `mode` values:

- `FRESH_PROJECT`
- `EXISTING_PROJECT`
- `CROSS_PROJECT_INCIDENT`

Allowed objective state transitions:

```text
DRAFT -> GENESIS_REVIEW | PLANNING
GENESIS_REVIEW -> ONBOARDING | CANCELLED
ONBOARDING -> PLANNING | FAILED
PLANNING -> NEEDS_CLARIFICATION | PLAN_REVIEW | FAILED
NEEDS_CLARIFICATION -> PLANNING | CANCELLED
PLAN_REVIEW -> APPROVED | PLANNING | CANCELLED
APPROVED -> MATERIALIZING
MATERIALIZING -> RUNNING | FAILED
RUNNING -> INTEGRATING | BLOCKED | FAILED | CANCELLED
BLOCKED -> RUNNING | CANCELLED | FAILED
INTEGRATING -> RESULT_REVIEW | BLOCKED | FAILED
RESULT_REVIEW -> DONE | RUNNING | CANCELLED
```

No model may produce `APPROVED`, `RESULT_REVIEW -> DONE`, or a human identity.

### 7.3 Plan record

The decomposer must return strict JSON, not free-form Markdown. Minimum fields:

```json
{
  "schemaVersion": 1,
  "planId": "plan-<objectiveId>-r1",
  "objectiveId": "obj-...",
  "revision": 1,
  "state": "PENDING_APPROVAL",
  "summary": "Diagnose checkout and repair only affected repositories.",
  "architectureDecisions": [],
  "assumptions": [],
  "clarificationNeeded": false,
  "clarificationQuestion": null,
  "projects": ["shop-frontend", "shop-backend"],
  "nodes": [],
  "integration": {
    "required": true,
    "projectVerification": [],
    "crossProjectVerification": [],
    "previewRequired": true
  },
  "risk": "MEDIUM",
  "complexity": "HIGH",
  "approvedBy": null,
  "approvedAt": null,
  "createdAt": "<ISO timestamp>"
}
```

Each `nodes[]` item must contain:

```json
{
  "nodeId": "N03",
  "title": "Repair backend checkout validation",
  "purpose": "Correct the verified backend root cause.",
  "projectId": "shop-backend",
  "role": "BACKEND",
  "type": "IMPLEMENTATION",
  "dependsOn": ["N01"],
  "acceptanceCriteria": ["Regression test fails before and passes after the fix."],
  "allowedPaths": ["src/checkout/**", "test/checkout/**"],
  "verification": ["test", "build"],
  "risk": "MEDIUM",
  "complexity": "MEDIUM",
  "requiresChanges": true,
  "canRunInParallel": false,
  "writeConflictGroup": "shop-backend:checkout",
  "contextFrom": ["N01"],
  "skills": []
}
```

Allowed initial `role` values:

- `PLANNER`
- `DIAGNOSTIC`
- `FRONTEND`
- `BACKEND`
- `DATABASE`
- `INTEGRATION`
- `TESTING`
- `REVIEW`
- `GENERAL`

Allowed `type` values:

- `DIAGNOSTIC` — read-only unless a later approved implementation node exists;
- `IMPLEMENTATION` — code changes allowed inside `allowedPaths`;
- `INTEGRATION` — combines already verified outputs;
- `VERIFICATION` — no product-code edits unless a new revision is approved.

`skills` must remain an empty array until the Skill Registry phase. Earlier packets must not add fake skill names.

### 7.4 Orchestration runtime record

Minimum contract:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "orchestrationId": "orch-<objectiveId>",
  "objectiveId": "obj-...",
  "planId": "plan-...-r1",
  "state": "RUNNING",
  "planFingerprint": "sha256...",
  "nodes": {
    "N01": {
      "state": "QUEUED",
      "taskId": "SHOP-101",
      "jobId": "...",
      "runId": null,
      "attempt": 1,
      "blockedBy": [],
      "lastError": null
    }
  },
  "integration": {
    "state": "NOT_READY",
    "projectBaselines": {},
    "artifacts": [],
    "verification": [],
    "rollback": null
  },
  "usage": {
    "totalTokens": 0,
    "agentInvocations": 0,
    "retries": 0
  },
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

Allowed node scheduler states:

```text
BLOCKED -> READY -> QUEUED -> RUNNING -> REVIEW -> DONE
                              |          |         |
                              +-------> FAILED <---+
FAILED -> READY only through recorded retry authorization
Any non-terminal state -> CANCELLED only through human cancellation
```

The scheduler derives eligibility from persisted predecessor states. It must not rely only on in-memory promises.

### 7.5 Project relationship record

Extend project registry metadata without replacing existing fields:

```json
{
  "projectId": "shop-frontend",
  "relationships": [
    {
      "type": "CONSUMES_API",
      "targetProjectId": "shop-backend",
      "contractPaths": ["src/lib/api/**", "../shop-backend/openapi.yaml"],
      "verification": ["test:contract"]
    }
  ]
}
```

Allowed relationship types in the first release:

- `CONSUMES_API`
- `PROVIDES_API`
- `SHARES_SCHEMA`
- `DEPENDS_ON`
- `DEPLOYS_WITH`

Both projects must be registered. A relationship is metadata only; it grants no write permission.

## 8. Planner and Decomposer Contract

The decomposer is a read-only stage. Its prompt must include:

- the exact user objective;
- selected project metadata;
- bounded Graphify context per project;
- package scripts and verification defaults;
- active task summary;
- relevant Wiki knowledge;
- project relationships;
- objective budget;
- the strict plan JSON schema;
- all safety invariants that affect planning.

The decomposer must:

1. create the smallest useful number of nodes;
2. keep one measurable outcome per node;
3. include a diagnostic node for ambiguous cross-project bugs;
4. use dependencies instead of narrative ordering;
5. keep verification names limited to scripts that exist in the target project;
6. set `clarificationNeeded=true` when a safe path, repository, required contract, or verification cannot be determined;
7. avoid parallel flags when paths overlap or one node consumes another node's output;
8. include an integration node or integration contract whenever more than one implementation node exists;
9. leave `skills=[]` until the final phase;
10. never create more nodes than `budget.maxSubtasks`.

The deterministic validator, not the model, is authoritative. It must reject:

- cycles;
- self-dependencies;
- missing node references;
- duplicate IDs;
- unknown projects;
- absolute or traversal paths;
- missing acceptance criteria;
- unsupported verification scripts;
- diagnostic nodes that request writes;
- parallel nodes sharing a `writeConflictGroup`;
- implementation nodes without `allowedPaths`;
- plans above the approved risk, subtask, concurrency, or budget ceiling.

## 9. Scheduler Contract

Initial scheduling algorithm:

1. Load the approved plan and verify its fingerprint.
2. Reconcile each node from its canonical task, job, and run.
3. Mark a `BLOCKED` node `READY` only when every predecessor is `DONE`.
4. Sort eligible nodes by topological depth, then `nodeId` for deterministic order.
5. In sequential mode, enqueue exactly one eligible node.
6. In parallel mode, select up to `maxParallelAgents` nodes that do not share a project lease or `writeConflictGroup`.
7. Use `enqueueTaskJob`; include `objectiveId`, `orchestrationId`, `planId`, and `nodeId` as optional job metadata.
8. Copy the approved plan's human approval provenance into the job and resulting run; reject scheduling if the node fingerprint is not included in that approval.
9. Persist orchestration state before requesting another scheduling pass.
10. When a node reaches `FAILED`, block descendants and create a decision item.
11. When every implementation node reaches `DONE`, transition to `INTEGRATING`.

Restart behavior:

- reconstruct node state from persisted task/job/run evidence;
- never enqueue a duplicate active node;
- keep uncertain running work failed-safe;
- do not release descendants until reconciliation proves predecessor `DONE`;
- preserve retry count and budget usage.

## 10. Integration Contract

### 10.1 Sequential certification mode

The first integration release uses the existing acceptance path:

1. execute one subtask;
2. human reviews and accepts it through the existing run lifecycle;
3. apply it transactionally to the project repository;
4. continue to the next dependency node;
5. after all implementation nodes are `DONE`, run one explicit integration/verification node;
6. present objective-level evidence and completion decision.

This mode is slower but must be certified before aggregate parallel integration.

### 10.2 Aggregate integration mode

Later parallel mode adds one integration workspace per objective and project:

```text
runs/integration/<orchestrationId>/<projectId>/workspace
```

Required behavior:

- freeze one base commit per project before execution;
- preserve each subtask patch, changed-path list, run ID, and verification evidence;
- apply patches to the integration workspace in topological order;
- stop on conflict; never auto-resolve semantic conflicts;
- audit aggregate changed paths against the union of approved node paths;
- run project verification, contract verification, and E2E verification;
- create one aggregate diff and preview;
- require explicit human aggregate acceptance;
- verify the source repository still matches the frozen baseline before apply;
- use transactional apply and rollback artifacts;
- commit with objective, plan, orchestration, and source run IDs in provenance.

Same-project parallel mode remains feature-flagged off until this contract passes fault-injection and rollback tests.

### 10.3 Cross-project apply

First release: require separate human acceptance for each repository and a final cross-project verification gate.

Later coordinated apply may use prepare/apply/rollback phases, but must not claim atomicity unless tests prove every modified repository can be restored after failure at each apply point.

## 11. Dashboard Contract

Extend the existing dashboard with these user-visible states:

### Task Intake

- Target mode: `Existing Project`, `Fresh Project`, or `Linked Projects`.
- Existing Project shows the current project selector.
- Fresh Project shows project ID, absolute target directory, supported blueprint, and first objective prompt.
- Linked Projects shows two or more explicitly related registered projects.
- Execution mode defaults to `Guided`.
- Budget defaults are visible before plan generation.

### Plan Review

Display before approval:

- objective summary;
- project list;
- architecture decisions and assumptions;
- every node with role, project, dependencies, paths, checks, risk, and parallel eligibility;
- integration checks;
- budget ceiling;
- warnings and clarification blockers.

Actions:

- `Approve Plan`;
- `Request Plan Revision`;
- `Cancel`.

No `Approve Plan` action may also imply final result acceptance.

### Objective detail

Required tabs or sections:

- graph;
- subtasks;
- agent activity;
- decisions/blockers;
- integration evidence;
- usage/budget;
- final result.

Graph node colors must derive from the authoritative scheduler state. The UI must not infer completion from a missing error.

### Decision Inbox

Initial decision types:

- `FRESH_PROJECT_CREATION`;
- `PLAN_APPROVAL`;
- `PLAN_CLARIFICATION`;
- `NODE_RETRY`;
- `SCOPE_EXPANSION`;
- `INTEGRATION_CONFLICT`;
- `HIGH_RISK_CHANGE`;
- `OBJECTIVE_ACCEPTANCE`.

Each decision must include objective, node/run when applicable, evidence, requested action, allowed choices, creator (`SYSTEM`, never a forged human), and resolution audit.

## 12. API Contract

Add versioned routes while preserving all current routes:

| Method and route | Purpose |
|---|---|
| `POST /api/objectives` | Create an objective; start read-only planning for existing projects or genesis review for Fresh Project. |
| `GET /api/objectives` | List objective summaries. |
| `GET /api/objectives/:id` | Return authoritative objective, plan, orchestration, and decision summary. |
| `POST /api/objectives/:id/approve-genesis` | Approve the deterministic Fresh Project proposal and invoke existing onboarding. |
| `POST /api/objectives/:id/clarify` | Add user clarification and create a new plan revision. |
| `POST /api/objectives/:id/approve-plan` | Record explicit plan approval and start materialization. |
| `POST /api/objectives/:id/request-plan-changes` | Reject current revision and return to planning. |
| `POST /api/objectives/:id/cancel` | Cancel non-applied remaining work. |
| `POST /api/objectives/:id/retry-node` | Human-authorized retry for one failed node. |
| `GET /api/objectives/:id/graph` | Return nodes and edges with authoritative states. |
| `GET /api/objectives/:id/evidence` | Return aggregate scope, verification, integration, and usage evidence. |
| `GET /api/decisions` | List unresolved and recent decisions. |
| `POST /api/decisions/:id/resolve` | Resolve one decision with allowed action and human identity. |
| `GET /api/projects/:id/relationships` | Read project relationships. |
| `PUT /api/projects/:id/relationships` | Validate and replace relationships with explicit confirmation. |

All mutating endpoints require the existing authenticated local operator session, idempotency protection, body limits, redaction, audit event, and explicit error DTO. New routes must not accept `approvedBy` from an untrusted external connector without identity binding.

## 13. Ordered Implementation Packets

Run packets in order. A later phase cannot start until the previous phase exit gate is human-accepted.

### Phase V2.0 — Scope, threat model, and schemas

#### ✅ V2-000 — Freeze the v2 scope contract

- Model: `ECONOMY + STRONG REVIEW`; acceptance: `HUMAN GATE`.
- Objective: convert this proposal into an approved v2 scope and threat model without changing runtime behavior.
- Backend paths: `docs/AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md`, new `docs/AI_OS_V2_SCOPE.md`, new `docs/AI_OS_V2_THREAT_MODEL.md`, `README.md`.
- Must define: trust boundaries, agent/sub-agent identity, integration workspace, cross-project apply, Telegram boundary, skill-install boundary, remaining out-of-scope items.
- Tests: documentation link/check script only if an existing convention exists; no runtime code.
- Exit: human records approval of scope and threat model.

#### ✅ V2-001 — Add strict objective, plan, orchestration, and decision validators

- Model: `ECONOMY + STRONG REVIEW`.
- Objective: implement pure validation with no API, planner, queue, or filesystem mutation.
- Backend paths: new schemas under `schemas/`, new `src/orchestration-schema.mjs`, new `test/orchestration-schema.test.mjs`, `package.json` only for the test script.
- Acceptance:
  - valid fixtures pass;
  - every invalid condition in section 8 has a table-driven failing fixture;
  - future schema versions fail closed;
  - validator never modifies input;
  - `skills` accepts only an empty array in schema version 1.
- Verification: new focused test, then `npm run test:unit`.

#### ✅ V2-002 — Add durable stores with revision and lease guards

- Model: `ECONOMY + STRONG REVIEW`.
- Objective: CRUD for state files without planning or execution.
- Backend paths: new `src/objective-store.mjs`, `src/plan-store.mjs`, `src/orchestration-store.mjs`, `src/decision-store.mjs`, new `test/orchestration-store.test.mjs`.
- Acceptance:
  - create uses exclusive write;
  - update increments revision;
  - stale revision is rejected;
  - interrupted temp write preserves last valid record;
  - corrupted JSON is reported, never ignored;
  - files are redacted and owner-only;
  - concurrent mutation test proves no lost update.
- Verification: focused store/fault tests, then `npm run test:unit`.

Phase V2.0 exit: schema and persistence are accepted before any AI-generated plan can be stored.

### Phase V2.1 — Unified Objective Intake and Fresh Project

#### ✅ V2-010 — Add objective intake service and read-only API

- Model: `ECONOMY`.
- Objective: create/list/read objectives without decomposition.
- Backend paths: new `src/objective-intake.mjs`, `src/server.mjs`, API tests.
- Acceptance:
  - validates mode, project IDs, budget, and request;
  - existing projects must exist;
  - `CROSS_PROJECT_INCIDENT` is rejected with `FEATURE_DISABLED` until Phase V2.6 is enabled;
  - existing-project initial state is `PLANNING`;
  - fresh-project initial state is `GENESIS_REVIEW` with a deterministic proposal;
  - duplicate idempotency key returns the same objective;
  - no task/job/run is created.
- Verification: API tests plus `npm run test:unit`.

#### ✅ V2-011 — Add Fresh Project proposal and approved chaining

- Model: `ECONOMY + STRONG REVIEW`.
- Objective: chain an approved Fresh Project genesis proposal to the existing `onboardNewProject`; master-plan decomposition is added later in Phase V2.2.
- Backend paths: `src/objective-intake.mjs`, `src/project-onboarding.mjs` only if a small adapter is required, `src/server.mjs`, tests.
- Required sequence:
  1. intake stores project ID, target path, supported blueprint, and prompt;
  2. a deterministic Fresh Project genesis proposal is reviewed before repository creation;
  3. `approve-genesis` records a distinct human `FRESH_PROJECT_CREATION` decision and invokes existing onboarding exactly once;
  4. successful onboarding attaches the new project ID to the objective;
  5. failed onboarding leaves no registered partial project and objective becomes `FAILED` with evidence;
  6. first task is not queued until a later materialization packet exists.
- Acceptance: retry cannot create a second repository or duplicate registry entry.
- Verification: injected failure before/after onboarding registration, API test, full unit gate.

#### ✅ V2-012 — Extend dashboard Task Intake with target modes

- Model: `ECONOMY`.
- Dashboard paths: `src/pages/Tasks/`, `src/services/orchestrator.ts`, `src/hooks/use-orchestrator.ts`, browser fixtures/tests.
- Acceptance:
  - Existing mode preserves current behavior;
  - Fresh mode requests project ID, absolute target path, supported blueprint, prompt;
  - Linked mode remains hidden/disabled until Phase V2.6;
  - unsupported blueprint is not shown;
  - plan generation does not queue work;
  - errors and clarification remain visible;
  - existing lifecycle browser test remains unchanged and passing.
- Verification: `npm run test:verify` in dashboard.

Phase V2.1 exit: one prompt can create a reviewed Fresh Project objective using the existing blueprint, but large-objective decomposition is still disabled.

### Phase V2.2 — Project Decomposition and DAG

#### ✅ V2-020 — Implement pure DAG validation and deterministic ordering

- Model: `ECONOMY`.
- Backend paths: new `src/task-graph.mjs`, new `test/task-graph.test.mjs`.
- Functions required:
  - `validateTaskGraph(nodes)`;
  - `topologicalOrder(nodes)`;
  - `eligibleNodes(nodes, runtimeStates)`;
  - `detectWriteConflicts(nodes)`;
  - `descendantsOf(nodeId)`.
- Acceptance:
  - order is stable by depth then node ID;
  - cycles return the exact cycle path;
  - missing and self-dependencies fail;
  - two parallel nodes with the same project and overlapping paths/conflict group are rejected;
  - no filesystem or provider calls.
- Verification: focused tests and unit gate.

#### ✅ V2-021 — Add read-only decomposition planner

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `src/project-decomposer.mjs`, `src/agent-config.mjs`, `src/agent-routing.mjs`, `src/context-compactor.mjs`, tests.
- Add stage: `project-decomposition` to model-tier routing. Unknown/high complexity must select strong review.
- Planner output: exact plan schema in section 7.3.
- Acceptance:
  - provider mode is plan/read-only;
  - prompt contains bounded context only;
  - output parser rejects prose or partial JSON;
  - validator runs after parsing;
  - invalid plan cannot be stored as reviewable;
  - clarification produces `NEEDS_CLARIFICATION` without tasks/jobs;
  - low budget cannot be silently exceeded.
- Verification: mocked provider tests, routing tests, context-budget tests, unit gate.

#### ✅ V2-022 — Add plan revision and approval lifecycle

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: objective/plan stores, `src/server.mjs`, audit/events, tests.
- Acceptance:
  - planning creates revision 1;
  - clarification or requested changes creates revision N+1;
  - old approval never applies to new revision;
  - approval records human identity, timestamp, plan fingerprint, projects, risk, budget;
  - approving twice is idempotent;
  - model output cannot populate approval fields.
- Verification: transition and API tests, unit gate.

#### ✅ V2-023 — Add Plan Review dashboard

- Model: `ECONOMY`.
- Dashboard paths: new objective types/hooks/components, Task Intake plan modal or objective page, browser tests.
- Acceptance: every field listed in section 11 is visible; dependency edges are readable without relying only on color; approve/revise/cancel actions map to separate endpoints.
- Verification: dashboard `npm run test:verify`.

Phase V2.2 exit: one prompt produces a human-reviewable, validated DAG, but approval still does not execute until materialization is implemented.

### Phase V2.3 — Canonical Task Materialization and Sequential Scheduler

#### ✅ V2-030 — Materialize approved nodes into canonical tasks

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: `src/task-intake.mjs`, new `src/task-materializer.mjs`, stores, tests.
- Required behavior:
  - accept only an approved plan fingerprint;
  - assign canonical task IDs using existing project numbering;
  - create task documents transactionally;
  - add `objective_id`, `plan_id`, `orchestration_id`, `node_id`, `master_task: <objectiveId>`, and `orchestration_managed: true` to frontmatter;
  - keep the existing `dependencies` field limited to predecessor task IDs in the same project so the current readiness gate remains valid;
  - store all DAG predecessors, including cross-project edges, as qualified `orchestration_dependencies` values such as `shop-backend:SHOP-101`;
  - preserve acceptance criteria, paths, verification, risk, and complexity exactly from approved nodes;
  - do not call the Task Intake AI planner again;
  - rollback all newly created task files if any node fails validation/write;
  - repeated call returns existing materialization.
- Verification: transaction/fault tests, task readiness tests, unit and smoke gates.

#### ✅ V2-031 — Implement sequential orchestration scheduler

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `src/orchestration-scheduler.mjs`, `src/job-queue.mjs`, `src/daemon.mjs`, tests.
- Initial feature flag: `ORCHESTRATOR_OBJECTIVE_SCHEDULER=0` by default until certification.
- Acceptance:
  - only one node per orchestration is queued at a time;
  - predecessors must be `DONE`;
  - direct/manual queue requests for `orchestration_managed: true` tasks are rejected; only the scheduler may enqueue them after checking the approved graph;
  - existing project reservation is preserved;
  - job metadata links objective/plan/orchestration/node and the original human plan-approval provenance;
  - duplicate scheduler ticks do not create duplicate jobs;
  - failed node blocks descendants;
  - independent objectives remain governed by existing worker capacity;
  - restart reconstructs state without replaying uncertain work.
- Verification: scheduler table tests, daemon restart tests, reliability fault tests, unit/smoke gates.

#### ✅ V2-032 — Add node retry, cancellation, and blocker decisions

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: scheduler, decision store, server routes, tests.
- Acceptance:
  - retry requires human decision and respects `maxRetriesPerNode`;
  - cancellation does not discard already accepted repository changes;
  - descendants become `CANCELLED` or remain `BLOCKED` according to recorded policy;
  - scope expansion always creates a new plan revision;
  - no direct state mutation endpoint accepts arbitrary target state.
- Verification: transition/fault/API tests.

#### ✅ V2-033 — Certify sequential objective execution

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Pilot: one real objective with at least three nodes and one dependency chain.
- Required evidence:
  - approved plan fingerprint;
  - canonical task mapping;
  - no duplicate jobs/runs;
  - restart recovery during a blocked/queued transition;
  - each accepted path within scope;
  - final repositories clean;
  - all node knowledge decisions recorded.

Phase V2.3 exit: validated subtasks execute sequentially through the existing lifecycle.

### Phase V2.4 — Integration Manager

#### ✅ V2-040 — Add sequential integration node and aggregate evidence

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `src/integration-manager.mjs`, `src/interaction.mjs`, evidence modules, tests.
- Acceptance:
  - integration starts only when required predecessor nodes are `DONE`;
  - runs approved project verification scripts;
  - links all source run IDs and commit hashes;
  - aggregate scope equals union of approved node scopes;
  - failed integration creates a blocker decision, not automatic success;
  - aggregate result never hides a failed/missing node.
- Verification: aggregate evidence fixtures, failure tests, unit gate.

#### ✅ V2-041 — Add integration recovery and targeted repair planning

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: integration manager, decomposer, scheduler, tests.
- Acceptance:
  - infrastructure failures use existing safe retry classification;
  - product failures may propose one repair node with explicit paths and tests;
  - repair node creates a new plan revision and requires approval;
  - maximum repair cycles is bounded by objective budget;
  - previous valid changes remain traceable.
- Verification: deterministic integration failure fixtures.

#### ✅ V2-042 — Add objective evidence and final review dashboard

- Model: `ECONOMY`.
- Dashboard paths: new Objective page/components, services/types, browser tests.
- Acceptance: shows node outcomes, aggregate diff links, verification, preview, unresolved blockers, usage, and separate final acceptance action.
- Verification: dashboard full gate.

#### ✅ V2-043 — Certify sequential integration

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Pilot: one objective where unit checks pass but integration initially fails, one approved repair revision, then final pass.
- Exit: evidence reconstructs initial failure, revision, repair run, final verification, and human acceptance.

### Phase V2.5 — Role-Based Sub-Agents and Parallel Execution

#### V2-050 — Add role assignment without skills ✅

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: `src/executor.mjs`, `src/context-compactor.mjs`, new role tests.
- Acceptance:
  - executor inserts the approved role and role-specific responsibility into the prompt;
  - role prompt cannot alter paths/tools/tier/approval;
  - `skills=[]` remains unchanged;
  - role is recorded in telemetry and evidence;
  - temporary sub-agent ends with its run.
- Verification: prompt golden tests, scope tests, unit gate.

#### V2-051 — Enable parallel nodes across distinct projects ✅

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: scheduler, existing queue/daemon pool, tests.
- Acceptance:
  - respects objective and global concurrency ceilings;
  - reuses project-exclusive leases;
  - schedules only dependency-independent nodes;
  - one failed branch blocks only descendants, while unrelated branches may finish;
  - restart and lease recovery remain exactly-once.
- Verification: parallel distinct-project reliability tests and soak workload.

#### ✅ V2-052 — Build aggregate integration workspace

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new integration workspace helpers, `src/workspace-manager.mjs`, integration manager, tests.
- Acceptance: satisfies section 10.2 for one project with sequentially produced patches; source repository remains unchanged before acceptance.
- Verification: conflict, baseline drift, denied path, verification failure, apply failure, rollback, and cleanup tests.

#### ✅ V2-053 — Enable same-project parallel execution behind a flag

- Model: `ECONOMY + STRONG REVIEW`; activation: `HUMAN GATE`.
- Feature flag: `ORCHESTRATOR_SAME_PROJECT_PARALLEL=0` by default.
- Preconditions: V2-052 accepted; nodes have disjoint write groups; frozen common base; aggregate integration required.
- Acceptance:
  - overlapping paths never run together;
  - each node has a separate worktree and invocation identity;
  - integration order follows DAG;
  - semantic conflict stops for human decision;
  - one aggregate acceptance applies to main only after all gates pass.
- Verification: forced concurrent edits, semantic conflict fixture, restart during both agents, rollback after partial integration.

#### ✅ V2-054 — Multi-agent certification

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Pilot: at least four nodes, two genuinely parallel, one dependent integration node, one restart point.
- Exit metrics: zero duplicate execution, zero path overlap, zero silent conflict resolution, bounded token/concurrency usage, recoverable reject, clean source repository.

### Phase V2.6 — Cross-Project Incident Orchestration

#### ✅ V2-060 — Add validated project relationships

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `src/project-relations.mjs`, registry integration, API routes, tests.
- Acceptance:
  - both endpoints exist in registry;
  - duplicate/inverse relationship behavior is deterministic;
  - relationship changes require human confirmation and audit;
  - removing a project reports relationship blockers;
  - relationship grants no write access.
- Verification: registry migration/backward compatibility tests and API tests.

#### ✅ V2-061 — Expose project relationships and Linked Projects intake

- Model: `ECONOMY`.
- Dashboard paths: Task Intake components/hooks/types, project management components, service client, browser fixtures/tests.
- Acceptance:
  - Task Intake enables Linked Projects mode only when `ORCHESTRATOR_CROSS_PROJECT=1`;
  - the user selects a primary project and only explicitly related projects are offered;
  - relationship type and configured contract checks are visible before planning;
  - the UI cannot submit an unregistered or unrelated project ID;
  - relationship editing uses the explicit confirmation API and displays audit errors.
- Verification: dashboard `npm run test:verify`.

#### ✅ V2-062 — Add cross-project diagnostic phase

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `src/cross-project-diagnostics.mjs`, decomposer, context compactor, tests.
- Required diagnostic outcomes:
  - `FRONTEND`;
  - `BACKEND`;
  - `BOTH`;
  - `CONTRACT`;
  - `INFRASTRUCTURE`;
  - `COMPATIBLE`;
  - `UNDETERMINED`.
- Acceptance:
  - diagnosis cites reproducible evidence;
  - read-only diagnostic cannot edit either repository;
  - `UNDETERMINED` requests clarification/investigation;
  - `COMPATIBLE` creates only read-only diagnostic/verification nodes with empty write scope;
  - implementation nodes are created only for implicated projects;
  - contract mismatch creates coordinated FE/BE nodes plus a contract verification node.
- Verification: mocked FE-only, BE-only, both, contract, and unknown fixtures.

#### ✅ V2-063 — Add cross-project verification

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: integration manager, dev-server and visual-evidence aggregation, API DTOs, tests.
- Acceptance:
  - starts required local services on allocated loopback ports;
  - no public binding;
  - contract and E2E checks use approved commands only;
  - evidence names every project baseline, run, diff, check, and acceptance;
  - first release uses per-repository acceptance plus final objective gate.
- Verification: loopback/security tests, contract/E2E fixture, backend unit/smoke gates.

#### ✅ V2-064 — Add cross-project result review

- Model: `ECONOMY`.
- Dashboard paths: Objective page, integration evidence components, service/types, browser tests.
- Acceptance: one screen identifies diagnosis outcome, repositories inspected, repositories changed, per-repository diff/run/acceptance, contract/E2E results, blockers, and final objective action.
- Verification: dashboard `npm run test:verify`.

#### ✅ V2-065 — Cross-project incident certification

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Pilot: one real linked FE/BE bug submitted as one prompt. Root cause must be diagnosed, only required repositories changed, and cross-project E2E verified.

### Phase V2.7 — Graph UI, Decision Inbox, Budget, and Operations

#### ✅ V2-070 — Add objective graph and live events

- Model: `ECONOMY`.
- Backend/dashboard paths: objective graph API, SSE event mapping, new objective graph components, browser tests.
- Acceptance: reload reconstructs identical graph; updates are idempotent; keyboard and non-color status labels are present; large graphs are bounded/paginated or summarized.

#### ✅ V2-071 — Add Decision Inbox

- Model: `ECONOMY + STRONG REVIEW`.
- Backend/dashboard paths: decision store/API, navigation/page/components, tests.
- Acceptance: unresolved decisions are ordered by risk/time; only enumerated actions are accepted; resolution is auditable and idempotent; external messages cannot synthesize local identity.

#### ✅ V2-072 — Enforce objective budgets

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `src/orchestration-budget.mjs`, scheduler, telemetry, operations, tests.
- Acceptance:
  - node, concurrency, retry, token, and deadline ceilings are enforced before new work;
  - reaching a ceiling creates `BUDGET_EXCEEDED` decision/blocker;
  - completed evidence remains available;
  - budgets may be increased only by recorded human decision;
  - model tier safety cannot be downgraded to meet budget.

#### ✅ V2-073 — Extend operations, capacity, backup, and retention

- Model: `ECONOMY + STRONG REVIEW`.
- Backend/dashboard paths: operations governance, backup/retention enumerators, soak harness, Operations page, tests.
- Acceptance: objectives/plans/orchestrations/decisions/integration artifacts are included in backup, restore, capacity alerts, retention preview, and recovery drills; active state is never purged.

#### ✅ V2-074 — Operations certification

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Exit: bounded soak with multiple objectives, restart points, decisions, one budget stop, backup/restore, and no orphan worktree or lost state.

### Phase V2.8 — Aggregate Preview and Delivery

#### ✅ V2-080 — Aggregate project preview

- Model: `ECONOMY`.
- Backend paths: extend `src/dev-server-manager.mjs` and visual evidence services; tests.
- Acceptance: one objective can expose approved loopback preview URLs per runnable project; processes are bounded and cleaned; unavailable preview is explicit, not a failed verification pass.

#### ✅ V2-081 — Objective-level visual and E2E evidence

- Model: `ECONOMY`.
- Backend/dashboard paths: existing visual QA modules, Objective review UI, tests.
- Acceptance: existing per-run evidence is linked, not duplicated; aggregate report shows route/viewport/check ownership by node and project; request-changes creates an approved repair path.

#### ✅ V2-082 — Delivery certification

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Exit: one objective completes plan, execution, integration, preview, visual/E2E evidence, human acceptance, cleanup, and knowledge capture.

### Phase V2.9 — Optional Telegram Channel

This phase is optional and must not block core orchestration. It requires the v2 threat model to explicitly permit the selected Telegram connectivity mode.

#### V2-090 — Add connector and secret-reference contract

- Model: `ECONOMY + STRONG REVIEW`; security approval: `HUMAN GATE`.
- Objective: define connector interface, outbound/inbound transport, account linking, allowed commands, message redaction, replay protection, rate limit, and secret references.
- Constraint: no raw bot token in source, Vault, browser, plan, task, event, or message log.

#### V2-091 — Implement notification-only Telegram adapter

- Model: `ECONOMY + STRONG REVIEW`.
- Initial permissions: send status, completion, failure, and decision-required notifications only. No task creation or approval.
- Acceptance: delivery failure cannot fail the objective; messages contain no secrets/absolute sensitive paths; retries are bounded and deduplicated.

#### V2-092 — Add bounded command handling

- Model: `ECONOMY + STRONG REVIEW`; activation: `HUMAN GATE`.
- Allowed first commands: list projects, create draft objective, read status, answer clarification.
- Approval, scope expansion, high-risk change, merge, deployment, and deletion remain local-dashboard-only until separately certified.

### Phase V2.10 — Skill Registry and Skill Router (Last)

No earlier phase may depend on this phase. Existing role prompts must already support the complete orchestration lifecycle.

#### ✅ V2-100 — Define skill package and registry contract

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `docs/AI_OS_SKILL_CONTRACT.md`, new schemas, new `src/skill-registry.mjs`, tests.
- Skill minimum metadata:
  - stable ID and semantic version;
  - purpose and supported roles/task types;
  - required context types;
  - required tools/capabilities;
  - compatible project signals;
  - risk level;
  - instruction resource path and checksum;
  - verification requirements;
  - enabled/disabled state;
  - provenance and human installer.
- Acceptance: registry is read-only to agents; invalid checksum/version/tool request fails closed; Wiki knowledge is referenced as context, never reclassified as a skill.

#### ✅ V2-101 — Add manual skill assignment in Guided mode

- Model: `ECONOMY + STRONG REVIEW`.
- Acceptance: Plan Review may select only installed/enabled compatible skills; selection creates a new plan revision; skill cannot broaden task permissions; full skill instructions are loaded only for the assigned node.

#### ✅ V2-102 — Implement automatic Skill Router

- Model: `ECONOMY + STRONG REVIEW`.
- Backend paths: new `src/skill-router.mjs`, decomposer/executor integration, tests.
- Router inputs: approved node role/type, project signals, risk, allowed tools, installed skills.
- Router output: ordered skill IDs plus reasons, or `NO_COMPATIBLE_SKILL`.
- Acceptance:
  - deterministic rules run before optional model recommendation;
  - only installed, enabled, checksum-valid skills are eligible;
  - no compatible skill falls back to the existing general role agent or asks for a human decision according to policy;
  - routing never installs a skill;
  - routing never lowers model tier, path scope, or verification;
  - selected skill IDs/checksums are recorded in plan fingerprint, prompt evidence, telemetry, and result evidence.

#### V2-103 — Add Skill Management dashboard ✅

- Model: `ECONOMY`.
- Scope: list, inspect, enable/disable, compatibility, version, provenance, and usage. Installation/update remains a separate human-confirmed workflow.

#### V2-104 — Skill Router certification ✅

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Pilot: one FE, one BE, one diagnostic, and one integration node. Prove correct selection, no incompatible selection, general-agent fallback, checksum rejection, and unchanged scope safety.

#### ✅ V2-105 — Enforce rollout flags after certification

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Scope: enforce `ORCHESTRATOR_SKILLS_ENABLED`, `ORCHESTRATOR_SKILL_AUTO_ROUTING`, and `ORCHESTRATOR_PARALLEL_OBJECTIVES` at runtime; unknown values remain disabled.
- Acceptance:
  - new skill assignment is rejected while skills are disabled;
  - automatic routing is skipped while auto-routing is disabled, while human-approved assignments remain intact;
  - a disabled parallel-objective flag prevents new objective execution from joining an already active objective, while active-state recovery remains allowed;
  - tests cover enabled, disabled, and unknown values;
  - backend and dashboard certification gates remain green.

#### ✅ V2-106 — Migrate Existing Project intake to objective orchestration

- Model: `ECONOMY + STRONG REVIEW`; result: `HUMAN GATE`.
- Scope: replace the Dashboard Existing Project legacy task-intake path with durable objective creation, read-only project decomposition, Plan Review, explicit approval, and approved-plan materialization.
- Acceptance:
  - Existing Project intake creates an objective and never creates task/job/run before plan approval;
  - project context and registered verification scripts constrain decomposition output;
  - planner clarification is durable and can resume planning without creating execution artifacts;
  - uploaded asset references remain attached to the objective;
  - `Approve & Run` approves the exact plan fingerprint and then materializes its canonical tasks;
  - duplicate planning remains idempotent and the Dashboard no longer calls legacy `/api/tasks/request` for Existing Project;
  - backend unit and Dashboard typecheck, lint, build, security, and browser gates remain green.

#### ✅ V2-107 — Harden Linked Projects live diagnostic intake

- Model: `ECONOMY`; result: `HUMAN GATE` for any resulting verification plan.
- Scope: start diagnostic planning from Dashboard Linked Projects intake, run Antigravity diagnostics non-interactively with cached authentication, accept current structured-output envelopes, and represent a verified no-mismatch result as `COMPATIBLE`.
- Acceptance:
  - Linked Projects intake creates the objective and starts read-only diagnostic planning without legacy task intake;
  - diagnostic capability allows provider network/authentication while retaining provider sandbox and plan mode;
  - diagnostic print mode does not require interactive login or command approval;
  - structured-output envelopes are parsed deterministically;
  - `UNDETERMINED` requests clarification with no implicated project;
  - `COMPATIBLE` permits only diagnostic/verification nodes with `requiresChanges=false` and `allowedPaths=[]`;
  - integration verification accepts only registered scoped `projectId:script` strings, never prose or object payloads;
  - no implementation task is materialized for a compatible contract audit;
  - focused backend security/Cross-project tests and Dashboard Linked Projects browser gates remain green.

## 14. Required Test Matrix

Every phase adds focused tests. Before phase acceptance, run the complete applicable gates.

### Backend

```text
npm run test:unit
npm run test:smoke
npm test
```

Required scenario families:

- valid/invalid schema fixtures;
- DAG cycle and dependency errors;
- stale revision and concurrent write;
- duplicate intake/materialization/scheduler tick;
- daemon restart in every orchestration state;
- provider invocation uncertainty;
- failed node and descendant blocking;
- retry budget;
- integration conflict and baseline drift;
- rollback after every apply fault point;
- cross-project FE-only, BE-only, both, contract, unknown diagnosis;
- denied path, symlink escape, secret redaction;
- backup/restore and retention;
- skill checksum/compatibility only in final phase.

### Dashboard

```text
npm run typecheck
npm run lint
npm run build
npm run test:security
npm run test:browser
npm run test:verify
```

Required browser scenarios:

- current single-task intake remains functional;
- Fresh Project objective review;
- plan clarification/revision/approval;
- graph updates and restart reload;
- blocked node and Decision Inbox;
- sequential completion;
- parallel branches;
- integration failure and repair revision;
- cross-project incident;
- budget exceeded;
- aggregate preview/review;
- skill assignment/router only after final phase.

## 15. Rollout Flags and Defaults

Add flags only when their packet is implemented. Safe defaults:

```env
ORCHESTRATOR_OBJECTIVES_ENABLED=0
ORCHESTRATOR_OBJECTIVE_SCHEDULER=0
ORCHESTRATOR_PARALLEL_OBJECTIVES=0
ORCHESTRATOR_SAME_PROJECT_PARALLEL=0
ORCHESTRATOR_CROSS_PROJECT=0
ORCHESTRATOR_TELEGRAM_ENABLED=0
ORCHESTRATOR_SKILLS_ENABLED=0
ORCHESTRATOR_SKILL_AUTO_ROUTING=0
```

Rules:

- unknown values mean disabled;
- enabling later feature does not implicitly enable prerequisites;
- production activation is a separate human action after certification;
- flags must be visible in Operations readiness;
- disabling a flag blocks new admission but preserves active-state recovery and review.

## 16. Economy-Model Task Packet Template

Create exactly one packet per AI OS task. Copy this template and fill every field. Do not leave placeholder text.

```yaml
packet_id: V2-000
objective: "One measurable outcome only"
model_tier: ECONOMY
requires_strong_review: true
requires_human_gate: false

repository: "personal-ai-orchestrator OR orchestrator-dashboard"
allowed_paths:
  - "exact/file/or/narrow/directory/**"
forbidden_paths:
  - ".env"
  - ".env.*"
  - "runs/runtime credentials"
  - "unrelated source files"

preconditions:
  - "Previous packet ID is human-accepted"
  - "Working tree has no overlapping user changes"
  - "Required feature flag remains disabled"

inputs:
  - "Exact schema/API/function contract from this plan"
outputs:
  - "Exact new or changed function/API/test artifact"

implementation_steps:
  - "Read only the named source and directly related test files"
  - "Add failing deterministic test"
  - "Implement the smallest code satisfying the contract"
  - "Run focused test"
  - "Run repository gate"
  - "Update Graphify after code changes"

acceptance_criteria:
  - "Observable boolean or exact returned value"
  - "Negative/failure case"
  - "Restart/idempotency case when runtime state changes"
  - "Security/scope case when filesystem or agent access changes"

verification_commands:
  - "Exact existing package script"

rollback:
  - "Remove or revert only this packet's paths; preserve user changes"

evidence_required:
  - "changed paths"
  - "focused test result"
  - "full gate result"
  - "risk and remaining warnings"

stop_and_escalate_if:
  - "Contract requires a new dependency not listed in the packet"
  - "Schema migration is not backward compatible"
  - "A safety invariant would be weakened"
  - "Required path is outside allowed_paths"
  - "Two fix attempts fail with the same evidence"
```

## 17. Rules for Economy and Vendor-Neutral Execution

These rules exist so Gemini, DeepSeek, Claude, OpenAI, or another model can execute the same packet consistently:

1. Use repository code and this contract as source of truth; do not rely on vendor-specific memory.
2. Do not combine packets or phases.
3. Do not rename public fields, state values, or routes for stylistic preference.
4. Do not add a dependency unless the packet explicitly authorizes it.
5. Do not perform opportunistic refactors.
6. Start with deterministic/pure functions, then storage, then API, then UI.
7. Add the failing test before implementation when practical.
8. Use strict JSON schema for model output and deterministic validation afterward.
9. When code and plan conflict, stop and report the exact conflict; do not silently choose.
10. After two failed correction cycles, stop with logs, changed paths, hypothesis, and requested decision.
11. A strong reviewer reviews diff and evidence; it does not automatically reimplement the packet.
12. Only the human operator approves plan, scope expansion, high-risk action, feature activation, integration acceptance, connector activation, or skill installation.

## 18. Final Definition of Done

The complete roadmap is done only when all of the following are true:

- one prompt can create a Fresh Project objective using a supported blueprint;
- one large objective can be decomposed into an approved, valid DAG;
- sequential scheduling is restart-safe and exactly-once;
- role-based temporary sub-agents execute canonical tasks through existing safety gates;
- independent tasks can run in bounded parallel without overlapping writes;
- integration conflicts and baseline drift fail closed;
- aggregate verification, preview, evidence, and human acceptance are durable;
- one prompt can diagnose and repair a real bug in linked FE/BE projects, changing only implicated repositories;
- budgets and decisions stop work predictably;
- backup, restore, retention, telemetry, and operations cover every new artifact;
- Telegram, if enabled, passes its separate threat model and cannot synthesize privileged local approval;
- Skill Registry and Skill Router are added last and do not weaken role-only behavior;
- all backend and dashboard gates pass;
- a new human-accepted certification records versions, commits, checksums, threat-model status, pilot evidence, and rollback evidence.

Until that certification is human-accepted, the new orchestration features remain disabled by default.
