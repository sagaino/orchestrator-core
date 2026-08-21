# Phase 3.4 Real Pilot Certificate

Certification status: **PASS**  
Certified at: **2026-08-22 (Asia/Jakarta)**  
Pilot project: **test-add-project**  
Repository: `/Users/sagaino/ciniru/test-add-project`

## Certified Lifecycle

The request was submitted from the dashboard, converted into a canonical
`BACKLOG` task, explicitly admitted with **Approve & Queue**, executed in an
isolated Git worktree, reviewed through the dashboard evidence inspector, and
explicitly finalized with **Accept & Sync Wiki** and auto-commit enabled.

| Evidence | Certified value |
|---|---|
| Task | `TASK-003` — Dokumentasi Subsection AI OS Explicit Approval Lifecycle di README.md |
| Job | `task-003-20260821T192855Z-9d99bc71` |
| Run | `task-003-20260821T192858Z-f53e742b` |
| Final state | `DONE` |
| Approval | `user`, scope `EXECUTE_TASK`, 2026-08-22 02:28:58 WIB |
| Human acceptance | `user`, 2026-08-22 02:34:41 WIB |
| Base commit | `282c7a6392c5a5441ed58d0c550a513255a20698` |
| Final commit | `20760b9fca74a731fc2e59dd5029a43907d4b961` |
| Applied path | `README.md` |
| Knowledge outcome | `PROJECT_ONLY`, destination `PROJECT` |
| Artifact | `workspace-artifacts/task-003-20260821t192858z-f53e742b` |

## Gate Evidence

- Readiness: PASS, low risk, no blockers or warnings.
- Scope audit: PASS; allowed and changed paths were both exactly `README.md`;
  no denied or out-of-scope paths.
- Pre-accept verification: `npm run typecheck`, `npm run build`, and
  `npm run test:e2e` all exited 0.
- Graphify update before review: exit 0.
- Post-apply verification: the same three commands all exited 0.
- Post-apply Graphify update: exit 0.
- Git finalization: COMMITTED; repository clean after acceptance.
- Workspace finalization: CLEANED with files, manifest, and `changes.patch`
  retained in the run artifact.

## Restart and Reconstruction Evidence

1. Services were stopped and restarted while the run was in `RETROSPECTIVE`.
   The dashboard restored the run, its authoritative next action, scope audit,
   three verification gates, and the corrected one-file diff.
2. Services were stopped and restarted again after `DONE`. The dashboard
   restored all 22 audit events, human acceptance, applied path, final commit,
   post-apply PASS result, cleanup state, artifact path, knowledge outcome, and
   the archived one-file diff.

## Certification Regression Closed

The first review exposed an evidence contradiction: the diff endpoint used
`HEAD~1`, so it projected six files from the preceding baseline commit alongside
the task's real `README.md` change. Acceptance was withheld. The control plane
was corrected to diff from the run's recorded base commit and constrain output
to scope-audited paths. Cleanup now persists `changes.patch`, and the dashboard
renders archived diffs after the worktree is removed. Automated regression
coverage verifies both live and archived projections.

## Reproduction

1. Start the local orchestrator and open **Runs & Review**.
2. Search for `task-003-20260821T192858Z-f53e742b`.
3. Confirm state `DONE` and inspect **Overview & Verification**.
4. Confirm Scope `PASS`, verification `3/3 Passed`, finalization `APPLIED`, Git
   `COMMITTED`, post-apply gates `PASS`, and workspace `CLEANED`.
5. Open **Code Changes (Diff)** and confirm exactly one archived file:
   `README.md`, with the explicit approval lifecycle subsection.

This certificate satisfies the Phase 3 exit measure: one real registered
project completed the full controlled software-engineering lifecycle through
the AI OS shell, with durable and reproducible evidence.
