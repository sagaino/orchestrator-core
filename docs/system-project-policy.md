# Personal AI Orchestrator System Project Policy & Architecture

## 1. System Project Policy (`orchestrator-system`)

When registered as a project managed by the orchestrator, the orchestrator itself operates under strict self-development policies to prevent self-approval, unauthorized modifications, or destructive deployment of unverified runtime binaries:

```yaml
project_id: personal-ai-orchestrator
project_type: orchestrator-system
self_update: guarded
requires_full_regression: true
requires_runtime_backup: true
requires_health_check: true
requires_human_accept: true
allow_self_accept: false
```

### Policy Rules
1. **No Self-Approval**: Neither the coding agent, recovery agent, daemon worker, nor API endpoints may self-accept, claim completion, or deploy changes to the active runtime without explicit human acceptance (`allow_self_accept: false`).
2. **Full Regression Suite**: All modifications must pass the entire test suite (`npm run test`, `test/smoke.mjs`, and targeted unit tests) within an isolated Git worktree before moving to `REVIEW`.
3. **Guarded Self-Update**: Source code accepted into the main repository does not immediately overwrite running processes. Deployment is coordinated by an external supervisor/updater.
4. **Runtime Backup**: Before any runtime replacement, the active stable runtime is backed up.
5. **Health Check & Automatic Rollback**: The updater conducts a startup health check with timeout; if the new process fails to produce a healthy heartbeat, it automatically rolls back to the stable runtime backup.

---

## 2. Runtime Compatibility Contract

- **Runtime Engine**: Node.js `>= 20.0.0` (ES Modules `type: "module"`).
- **Zero External Production Dependencies**: The orchestrator core runs on standard Node.js libraries (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:url`, `node:os`).
- **File System & Storage Compatibility**:
  - Vault Root: standard Obsidian markdown files with YAML frontmatter.
  - Runs Root: JSON manifests (`runs/<runId>.json`), jobs (`runs/jobs/<jobId>.json`), locks (`runs/locks/<lockKey>.lock`), telemetry (`runs/telemetry/`), notifications (`runs/notifications/`).
  - Workspaces: detached Git worktrees under `runs/workspaces/<projectId>/<runId>`.
- **Operating System Contract**: macOS (Apple Silicon / Intel) with support for LaunchAgent daemon (`launchd`) and native desktop notification helper (`Personal AI Orchestrator.app`).

---

## 3. External Updater & Supervisor Architecture

```text
[ Task Orchestrator ]
         │
         ▼
[ Isolated Git Worktree ] ──► [ Coding Agent ] ──► [ Tests & Verification ]
         │
         ▼
[ Human Review & Accept ]
         │
         ▼
[ Release Candidate Bundle ]
         │
         ▼
[ External Updater / Supervisor ] (Outside main runtime process)
    ├── 1. Drain active job queue
    ├── 2. Backup stable runtime binary / source
    ├── 3. Stop running daemon service
    ├── 4. Activate release candidate
    ├── 5. Launch new daemon process
    └── 6. Heartbeat Health Check (30s window)
             ├── PASS ──► Publish version, emit notification, complete task
             └── FAIL ──► Restore stable backup, restart old daemon, preserve diagnostics
```

---

## 4. Threat Model & Security Boundaries

1. **Workspace Boundary**: Agent operates strictly in detached Git worktrees; main repository is read-only until human `accept`.
2. **Secret Leakage Prevention**: Deny-pattern system (`src/security.mjs`) blocks `.env`, `.env.*` (except `.env.example`), private keys (`.pem`, `.key`, `.p12`), and credential files from entering agent workspaces.
3. **Verification Script Integrity**: Verification script commands are frozen and hashed upon atomic claim (`frozenVerificationScripts`). Any unauthorized tampering in `package.json` halts execution immediately.
4. **API Network Boundary (Fase 1)**: Local API binds strictly to `127.0.0.1` with local token authentication.
