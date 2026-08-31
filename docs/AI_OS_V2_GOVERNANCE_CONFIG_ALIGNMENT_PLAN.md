# AI OS v2 — Governance and Configuration Alignment Plan

Status: **CORE IMPLEMENTED — PACKETS GCA-000 THROUGH GCA-006 COMPLETE (PASSED CERTIFICATION)**  
Implementation status: **IMPLEMENTED** (Packets GCA-000..006 complete; GCA-007 operator rollout active)  
Acceptance status: **ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT**  
Default activation: **DISABLED** (`LOCAL_SAFE` default-off)  
Plan date: **2026-08-31 (Asia/Jakarta)**  
Owner and final approver: **Human operator**  
Scope: **Documentation authority, runtime-profile contracts, safe defaults, and rollout evidence only**

## 1. Objective

Align the repository so that every source of truth answers these questions
consistently:

1. Which AI OS v2 capabilities are implemented?
2. Which capabilities have been explicitly accepted by the human operator?
3. Which capabilities are enabled in the current runtime?
4. What happens on a fresh installation that copies the default environment
   example?

The completed work must make a fresh installation fail safe, preserve the
existing local runtime unless the operator explicitly changes it, and leave an
auditable human gate for formal v2 acceptance.

## 2. Problem Statement and Confirmed Drift

The implementation and operational history show that the core v2 objective,
orchestration, cross-project, and skill capabilities exist and have been used.
The repository governance and configuration artifacts do not yet describe that
state consistently:

| Source | Current statement | Conflict |
|---|---|---|
| `docs/AI_OS_V2_SCOPE.md` | `PENDING HUMAN ACCEPTANCE`, `accepted: false` | Core implementation already exists and has runtime history. |
| `docs/AI_OS_V2_THREAT_MODEL.md` | `PENDING HUMAN ACCEPTANCE`, review before packets that are already implemented | Review markers are stale. |
| `docs/AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md` | `PROPOSED — NOT YET IMPLEMENTED` | Most packets are marked complete; optional Telegram remains incomplete. |
| `.env.example` | `LOCAL_SAFE` while objectives, scheduler, and cross-project are enabled | A copied default can activate v2 while claiming to be safe. |
| `README.md` and v2 scope | v2 is disabled by default | Contradicts `.env.example`. |
| Runtime without explicit flags | v2 disabled, approval mode `MANUAL` | Runtime code is fail-safe but examples do not prove or preserve that contract. |
| Vault configuration | Launcher documents/uses `ORCHESTRATOR_VAULT_PATH`; direct CLI reads `ORCHESTRATOR_VAULT` | The same `.env` can select different Vaults depending on entry point. |
| Port configuration | README documents `PORT`; runtime reads `ORCHESTRATOR_API_PORT`; launcher hardcodes `3721` | The documented override is not authoritative. |

This packet must not reinterpret historical use as human acceptance. Only the
human operator may change an acceptance record from pending to accepted.

## 3. Non-Negotiable Decisions

### 3.1 Separate implementation, acceptance, and activation

Every governance document must use three independent fields:

```yaml
implementation_status: IMPLEMENTED | PARTIAL | NOT_IMPLEMENTED
acceptance_status: PENDING | ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT | REJECTED
default_activation: DISABLED
```

- `implementation_status` is supported by repository evidence.
- `acceptance_status` is set only by the human operator.
- `default_activation` describes fresh-install behavior, not the operator's
  ignored local `.env`.
- A model may prepare an acceptance diff but may not write `ACCEPTED`, invent
  `accepted_by`, or invent `accepted_at` without an explicit human decision.

### 3.2 Safe defaults remain default-off

The canonical fresh-install profile is `LOCAL_SAFE`. It must use `MANUAL`
approval and disable every v2 admission flag. Copying `.env.example` must never
start objective scheduling, cross-project work, skills, Telegram, or automatic
finalization.

### 3.3 Pilot activation is explicit

An opt-in `.env.pilot.example` may expose the already implemented supervised
pilot configuration. The filename, comments, README instructions, and profile
validation must make clear that it is not the default configuration.

### 3.4 Profiles do not silently grant capability

Individual flags remain authoritative. `ORCHESTRATOR_PROFILE` is a named
contract used for visibility and consistency checking; selecting a profile
string must not automatically enable flags.

### 3.5 Active runtime configuration is not edited by this work

The ignored local `.env` is operator-owned. No packet may overwrite it. The
agent may inspect only key names and effective non-secret configuration. Any
activation change is a separate human action after the alignment certificate is
accepted.

## 4. Target Runtime Profiles

### 4.1 `LOCAL_SAFE` — canonical `.env.example`

```env
ORCHESTRATOR_PROFILE=LOCAL_SAFE
ORCHESTRATOR_APPROVAL_MODE=MANUAL
ORCHESTRATOR_AUTO_FINALIZE_TASKS=0
ORCHESTRATOR_OBJECTIVES_ENABLED=0
ORCHESTRATOR_OBJECTIVE_SCHEDULER=0
ORCHESTRATOR_PARALLEL_OBJECTIVES=0
ORCHESTRATOR_SAME_PROJECT_PARALLEL=0
ORCHESTRATOR_CROSS_PROJECT=0
ORCHESTRATOR_TELEGRAM_ENABLED=0
ORCHESTRATOR_SKILLS_ENABLED=0
ORCHESTRATOR_SKILL_AUTO_ROUTING=0
ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS=2
ORCHESTRATOR_MAX_PARALLEL_JOBS=2
```

Expected effective behavior:

- legacy/manual task workflow remains available;
- no new objective orchestration is admitted;
- active-state recovery and human review remain available;
- unknown boolean values are treated as disabled;
- human acceptance cannot be synthesized.

### 4.2 `LOCAL_PILOT` — opt-in `.env.pilot.example`

```env
ORCHESTRATOR_PROFILE=LOCAL_PILOT
ORCHESTRATOR_APPROVAL_MODE=PLAN_REVIEW_THEN_AUTOPILOT
ORCHESTRATOR_AUTO_FINALIZE_TASKS=0
ORCHESTRATOR_OBJECTIVES_ENABLED=1
ORCHESTRATOR_OBJECTIVE_SCHEDULER=1
ORCHESTRATOR_PARALLEL_OBJECTIVES=0
ORCHESTRATOR_SAME_PROJECT_PARALLEL=0
ORCHESTRATOR_CROSS_PROJECT=1
ORCHESTRATOR_TELEGRAM_ENABLED=0
ORCHESTRATOR_SKILLS_ENABLED=0
ORCHESTRATOR_SKILL_AUTO_ROUTING=0
ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS=2
ORCHESTRATOR_MAX_PARALLEL_JOBS=3
```

Expected effective behavior:

- objective intake and scheduler are enabled;
- exact plan review remains a human gate;
- final objective acceptance remains a human gate;
- linked-project mode is available only for explicitly registered
  relationships;
- parallel-objective, same-project-parallel, Telegram, and skills remain
  separate opt-ins;
- disabling a flag blocks new admission but does not destroy recovery or review
  state.

If the operator does not want cross-project mode in the standard pilot, set it
to `0` before implementation and update the profile contract and tests together.
The implementing model must not make this product decision independently.

## 5. Canonical Configuration Names

Use the following names for new documentation and examples:

| Concern | Canonical name | Compatibility behavior |
|---|---|---|
| Vault path | `ORCHESTRATOR_VAULT_PATH` | Continue accepting legacy `ORCHESTRATOR_VAULT` as a lower-priority fallback for at least one release. |
| Runs path | `ORCHESTRATOR_RUNS` | Preserve current behavior. |
| Backend port | `ORCHESTRATOR_API_PORT` | Launcher, daemon, server, CLI, and README must use the same value. |
| Dashboard port | `ORCHESTRATOR_DASHBOARD_PORT` | Default `5173`; launcher only. |
| Dashboard repository | `ORCHESTRATOR_DASHBOARD_PATH` | Preserve current behavior. |

Required precedence:

```text
explicit CLI option
  > canonical exported environment variable
  > canonical project-local .env value
  > supported legacy environment alias
  > built-in safe default
```

Do not remove a legacy alias in this work. Emit no secret or absolute-path value
in public API responses beyond the visibility already authorized for the local
operator.

## 6. Target Governance Status

After implementation, governance artifacts must describe the following factual
state without overstating optional features:

| Area | Implementation target | Default activation | Notes |
|---|---|---|---|
| Objective intake, planning, DAG, scheduler | `IMPLEMENTED` | Disabled | Controlled local rollout only. |
| Sequential and aggregate integration | `IMPLEMENTED` | Disabled | Human acceptance preserved. |
| Bounded parallel and same-project parallel | `IMPLEMENTED` | Disabled | Separate flag and certification evidence required. |
| Cross-project relationships and diagnostics | `IMPLEMENTED` | Disabled | Explicit relationships and per-repository evidence required. |
| Graph, decisions, budgets, operations, delivery evidence | `IMPLEMENTED` | Disabled with objectives | Recovery remains available. |
| Skill Registry and Skill Router | `IMPLEMENTED` | Disabled | Installation and enablement remain human-controlled. |
| Telegram connector and command channel | `NOT_IMPLEMENTED` or `DEFERRED` | Disabled | V2-090 through V2-092 remain outside core completion. |

The top-level implementation-plan status should become:

```text
CORE IMPLEMENTED — CONTROLLED LOCAL ROLLOUT; OPTIONAL TELEGRAM DEFERRED
```

The scope and threat-model status may become
`ACCEPTED FOR CONTROLLED LOCAL ROLLOUT` only after Gate G1 below is satisfied.
Before that gate, they remain pending even if all mechanical alignment packets
are complete.

## 7. Implementation Sequence

Execute exactly one packet at a time. Do not combine the human acceptance gate
with mechanical configuration### ✅ GCA-000 — Capture baseline evidence
 
Type: **READ-ONLY**  
Model: economy-capable model  
Human gate: no
 
Allowed paths: none.
 
Actions:
 
1. Record the backend and dashboard commit IDs and working-tree status.
2. Record effective runtime configuration through the existing read-only
   Operations/runtime-config projection; do not print secrets.
3. Record the status fields from the three v2 governance documents.
4. Record `.env.example` key/value pairs.
5. Run focused rollout/config tests and record their results.
6. Confirm the local `.env` is ignored by Git and will not be edited.
 
Acceptance criteria:
 
- evidence identifies every confirmed contradiction in section 2;
- no file is changed;
- no secret value is included;
- dirty user changes, if any, are reported before proceeding.
 
Stop if the worktree contains overlapping changes in any packet path.
 
### ✅ GCA-001 — Human acceptance decision
 
Type: **HUMAN GATE**  
Model: no authority to decide
 
The operator must choose exactly one outcome:
 
#### Outcome A — Accept controlled local rollout
 
The operator supplies:
 
```yaml
acceptance_status: ACCEPTED_FOR_CONTROLLED_LOCAL_ROLLOUT
accepted_by: "<operator-provided identity>"
accepted_at: "<operator-provided ISO-8601 timestamp>"
notes: "<operator-provided constraints or none>"
```
 
#### Outcome B — Defer acceptance
 
Keep `acceptance_status: PENDING`. Continue the safe-default, profile-contract,
and factual implementation-status corrections, but do not describe v2 as
human-accepted or activate it.
 
Acceptance criteria:
 
- the decision is provided directly by the human operator;
- the model copies the identity and timestamp exactly;
- missing identity or timestamp never becomes an inferred value;
- rejection or deferment leaves all v2 defaults disabled.
 
### ✅ GCA-002 — Establish runtime-profile contracts
 
Type: **BACKEND CODE + TESTS**  
Model: economy + strong review  
Human gate: no
 
Primary files:
 
- `src/runtime-config.mjs`
- `src/rollout-flags.mjs` only if shared parsing is needed
- `test/rollout-flags.test.mjs`
- new `test/runtime-profile-contract.test.mjs`
 
Implementation requirements:
 
1. Export immutable `LOCAL_SAFE` and `LOCAL_PILOT` expected-setting contracts.
2. Keep explicit environment flags authoritative; do not auto-enable from the
   profile name.
3. Add a pure function that compares an effective snapshot with its named
   contract and returns:
 
   ```json
   {
     "profile": "LOCAL_SAFE",
     "aligned": false,
     "mismatches": [
       {
         "field": "flags.objectives",
         "expected": false,
         "actual": true,
         "severity": "BLOCKER"
       }
     ]
   }
   ```
 
4. `LOCAL_SAFE` with any v2 admission/automation capability enabled must be a
   blocker for new admission.
5. Unknown profiles must not grant capability. They should be visible as
   `UNKNOWN_PROFILE` and fail safe for admission when the operations guard is
   enforced.
6. Preserve active recovery and human review when a mismatch blocks admission.
 
Tests must cover:
 
- empty environment resolves to aligned `LOCAL_SAFE`;
- the exact section 4.1 values resolve to aligned `LOCAL_SAFE`;
- the exact section 4.2 values resolve to aligned `LOCAL_PILOT`;
- `LOCAL_SAFE` plus any enabled v2 flag is rejected;
- invalid boolean values remain disabled;
- a profile mismatch does not mutate environment variables;
- current manual task behavior is unchanged.
 
Verification:
 
```text
node test/runtime-profile-contract.test.mjs
node test/rollout-flags.test.mjs
npm run test:unit
```
 
### ✅ GCA-003 — Correct environment examples and canonical aliases
 
Type: **CONFIGURATION + COMPATIBILITY TESTS**  
Model: economy + strong review  
Human gate: no
 
Primary files:
 
- `.env.example`
- new `.env.pilot.example`
- `start.sh`
- `src/orchestrator.mjs`
- `src/daemon.mjs`
- `src/server.mjs`
- `src/final-v1-certification.mjs` if it resolves the Vault independently
- new `test/environment-contract.test.mjs`
 
Implementation requirements:
 
1. Replace `.env.example` with the exact `LOCAL_SAFE` contract from section
   4.1 plus documented optional path and port variables. No secret value may be
   included.
2. Create `.env.pilot.example` using the exact opt-in contract from section
   4.2 and a header requiring explicit operator review before copying.
3. Make `ORCHESTRATOR_VAULT_PATH` canonical across launcher and direct CLI;
   preserve `ORCHESTRATOR_VAULT` as a compatibility fallback.
4. Make `ORCHESTRATOR_API_PORT` authoritative across launcher, daemon, server,
   status checks, displayed URLs, and CLI.
5. Add `ORCHESTRATOR_DASHBOARD_PORT` to the launcher with default `5173`.
6. Validate ports as integers in the range `1-65535` before starting or stopping
   services.
7. Do not source or evaluate arbitrary `.env` content; preserve the launcher's
   existing bounded parser.
8. Do not edit `.env`.
 
Tests must parse both example files and assert:
 
- every required key appears exactly once;
- `LOCAL_SAFE` matches the runtime contract;
- `LOCAL_PILOT` matches the runtime contract;
- no token, credential, or non-placeholder absolute user path exists;
- canonical variable precedence is identical for launcher and direct CLI;
- legacy Vault alias continues to work;
- invalid ports fail before a process is launched;
- copying `.env.example` cannot enable objective, cross-project, Telegram, or
   skill admission.
 
Verification:
 
```text
node test/environment-contract.test.mjs
node test/security.test.mjs
npm run test:unit
```
 
### ✅ GCA-004 — Reconcile governance documents
 
Type: **DOCUMENTATION**  
Model: economy + strong review  
Human gate: GCA-001 determines acceptance fields
 
Primary files:
 
- `docs/AI_OS_V2_SCOPE.md`
- `docs/AI_OS_V2_THREAT_MODEL.md`
- `docs/AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md`
- `docs/AI_OS_V2_SKILL_CONTRACT.md` only if its status conflicts
- `README.md`
 
Required changes:
 
1. Add separate implementation, acceptance, and activation fields defined in
   section 3.1.
2. Replace `NOT YET IMPLEMENTED` with the factual core implementation status.
3. Add a phase-status summary that explicitly marks V2-090 through V2-092 as
   deferred/not implemented.
4. Preserve the historical packet detail and acceptance evidence; do not mark
   an unchecked packet complete merely for formatting consistency.
5. Replace stale threat-model review markers with event-based review gates:
   before Telegram, a new provider/connector, public/network exposure,
   multi-user support, or any capability expansion.
6. If GCA-001 Outcome A was selected, copy the human-provided acceptance fields
   exactly into the canonical acceptance blocks.
7. If GCA-001 Outcome B was selected, retain pending acceptance and explicitly
   state that code availability is not activation authorization.
8. Update README with:
   - the difference between implemented, accepted, and enabled;
   - safe setup from `.env.example`;
   - explicit pilot setup from `.env.pilot.example`;
   - the complete flag matrix;
   - canonical Vault and port variable names;
   - a warning that `.env` is operator-owned and ignored by Git.
9. Remove contradictory claims that objective intake is both default-off and
   enabled in the default example.
 
Documentation acceptance criteria:
 
- a text search finds no `PROPOSED — NOT YET IMPLEMENTED` claim for the core;
- the optional Telegram phase remains visibly deferred;
- every documented default matches `LOCAL_SAFE`;
- every pilot example matches `LOCAL_PILOT`;
- no model-generated human identity or acceptance timestamp appears;
- all local Markdown links resolve.
 
### ✅ GCA-005 — Add operations admission check and visibility
 
Type: **BACKEND; DASHBOARD ONLY IF REQUIRED BY THE EXISTING DTO**  
Model: economy + strong review  
Human gate: no
 
Primary backend files:
 
- `src/runtime-config.mjs`
- `src/operations-governance.mjs`
- `src/server.mjs` only for DTO wiring
- focused operations tests
 
Conditional dashboard files:
 
- Operations runtime-profile component and types only if the existing generic
   checks cannot render the new result.
 
Implementation requirements:
 
1. Add `runtimeProfileAlignment` to Operations readiness evidence.
2. A `LOCAL_SAFE` mismatch blocks new admission with a stable code such as
   `RUNTIME_PROFILE_MISMATCH` and an actionable message.
3. The response lists field names and expected/actual non-secret values.
4. Recovery, review, backup, and read-only endpoints remain available.
5. Do not expose environment variables unrelated to the contract.
6. The Dashboard must show whether the profile is aligned and the exact safe
   next action; it must not offer one-click activation.
 
Tests must cover:
 
- aligned safe profile passes this check;
- unsafe flags under `LOCAL_SAFE` block admission;
- pilot contract is recognized;
- unknown profile fails safe;
- response is redacted;
- active recovery is not blocked;
- duplicate readiness calls are read-only and deterministic.
 
Verification:
 
```text
node test/operations-governance.test.mjs
node test/operations-api.test.mjs
npm run test:unit
```
 
If dashboard code changes:
 
```text
npm run typecheck
npm run lint
npm run build
npm run test:security
```
 
Do not repair unrelated Dashboard browser-test drift inside this packet. Record
it as a separate blocker with its existing evidence.
 
### ✅ GCA-006 — Add governance/config certification gate

Type: **TEST + RELEASE EVIDENCE**  
Model: economy + strong review  
Human gate: final certificate acceptance

Primary files:

- new `test/governance-config-alignment.test.mjs`
- `package.json`
- optional new certification module following existing repository patterns
- documentation certificate path chosen by the existing release convention

Add scripts:

```json
{
  "test:governance-config": "node test/governance-config-alignment.test.mjs"
}
```

The focused certification must verify:

1. both environment examples match their runtime contracts;
2. fresh-install defaults are disabled;
3. scope, threat model, plan, README, and runtime agree on defaults;
4. implementation status does not claim Telegram completion;
5. acceptance fields are either fully pending or fully human-supplied—never
   partially populated;
6. canonical environment aliases and precedence pass tests;
7. Operations exposes profile alignment without secrets;
8. all referenced documentation paths exist;
9. `.env`, runtime credentials, and operator secrets are not tracked;
10. backend focused and full regression gates pass.

Required final verification:

```text
npm run test:governance-config
npm test
npm run operations:readiness
git status --short
```

If Dashboard source changed, also run its existing `npm run test:verify` and
keep this certificate blocked until that gate passes. If Dashboard source did
not change, record any pre-existing Dashboard failure as an external product
release risk; it does not block the scoped governance/config alignment
certificate, but it must not be silently presented as a green full-product
release gate.

Certificate evidence must include:

- backend and dashboard commit IDs;
- changed paths;
- focused and full test results;
- effective runtime profile and alignment status with secrets removed;
- GCA-001 human decision provenance;
- deferred capabilities;
- rollback instructions;
- final human acceptance fields.

### GCA-007 — Controlled rollout and post-change observation

Type: **OPERATOR ACTION**  
Model: advisory only  
Human gate: required

Sequence:

1. Merge or apply the alignment changes while retaining `LOCAL_SAFE`.
2. Restart services using the safe profile.
3. Confirm health, Operations readiness, audit-chain validity, and that no v2
   admission occurred automatically.
4. Observe one normal manual/read-only workflow.
5. Only if the operator explicitly chooses pilot activation, copy selected
   values from `.env.pilot.example` into the operator-owned `.env`.
6. Restart and verify the effective `LOCAL_PILOT` alignment before admitting an
   objective.
7. Run one low-risk registered-project objective through plan review and final
   acceptance.
8. Record rollback and pilot evidence.

Rollback:

- restore `LOCAL_SAFE` values in the operator-owned `.env`;
- restart services;
- verify new objective admission is blocked while existing recovery/review
  remains available;
- do not delete objectives, plans, runs, evidence, or audit records;
- revert only the alignment commit if code rollback is required.

Exit criteria:

- safe restart is green;
- no capability was activated only by a profile label;
- pilot activation, if performed, is explicit and auditable;
- rollback to safe mode is demonstrated;
- the human accepts or rejects the final alignment certificate.

## 8. Required Test Matrix

| Layer | Required cases |
|---|---|
| Pure configuration | Safe/pilot exact match, unknown profile, invalid boolean, invalid port, immutability. |
| Environment examples | Unique keys, no secrets, safe default-off, explicit pilot opt-in. |
| Compatibility | Vault legacy alias, CLI precedence, launcher precedence, unchanged runs path. |
| Runtime admission | Safe alignment pass, mismatch block, recovery preserved, deterministic repeated reads. |
| Documentation | Status consistency, acceptance completeness, Telegram deferred, links resolve. |
| Security | `.env` ignored, credentials untracked, redacted readiness response, bounded dotenv parsing. |
| Regression | Full backend suite; Dashboard gates only when Dashboard is changed, with existing failures never waived silently. |

## 9. Agent/Model Execution Contract

Every implementing model must follow these rules:

1. Read this entire plan and only the packet's named files plus directly related
   tests.
2. Execute one packet per task/run.
3. Preserve unrelated user changes and ignored local runtime files.
4. Add or update focused tests before broad refactoring.
5. Do not activate features, edit `.env`, restart services, or create acceptance
   provenance unless the packet explicitly assigns that action to the human.
6. Do not infer that a checked implementation packet equals human acceptance.
7. Do not mark Telegram implemented.
8. Do not remove compatibility aliases in this work.
9. Do not weaken human approval, final acceptance, worktree isolation, path
   scope, or verification contracts.
10. Stop after two failed correction cycles with exact evidence and no scope
    expansion.

Packet completion report format:

```yaml
packet_id: GCA-000
status: COMPLETE | BLOCKED
changed_paths: []
tests:
  focused: PASS | FAIL | NOT_RUN
  full_backend: PASS | FAIL | NOT_RUN
  dashboard: PASS | FAIL | NOT_APPLICABLE
human_gate:
  required: false
  status: NOT_REQUIRED | PENDING | ACCEPTED | REJECTED
evidence:
  - "concise factual evidence"
remaining_risks:
  - "concise risk or none"
next_packet: GCA-001
```

## 10. Stop and Escalate Conditions

Stop the packet and ask the human operator when:

- acceptance identity or timestamp is missing;
- the operator has not chosen whether `LOCAL_PILOT` includes cross-project mode;
- current `.env` would need to be edited;
- a required compatibility change would break an existing documented entry
  point;
- the runtime profile check would block recovery or review rather than only new
  admission;
- Telegram or another deferred capability appears to be active without an
  accepted threat-model update;
- an unrelated Dashboard failure would need a product change;
- working-tree changes overlap packet paths;
- a safety invariant would be weakened.

## 11. Final Definition of Done

Point 2 is complete only when:

- implementation, acceptance, and activation are separate everywhere;
- `.env.example` is unambiguously `LOCAL_SAFE` and default-off;
- `.env.pilot.example` is explicit opt-in and machine-tested;
- the launcher, CLI, daemon, server, README, and examples use canonical Vault
  and port configuration with backward compatibility;
- Operations detects a profile/flag mismatch and blocks only new admission;
- scope, threat model, implementation plan, README, and runtime contracts agree;
- optional Telegram is still marked deferred and disabled;
- no model-invented human acceptance exists;
- focused and full backend tests pass;
- any changed Dashboard passes its applicable gates or the certificate remains
  blocked with explicit evidence;
- safe-mode restart and rollback are demonstrated;
- a human accepts or rejects the final alignment certificate.

Until all criteria are met, v2 availability in source code must not be described
as default activation authorization.
