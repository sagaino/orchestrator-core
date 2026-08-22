# AI OS v1.0.4 Hotfix

Status: **IMPLEMENTED — HUMAN ACCEPTANCE REQUIRED**  
Date: 2026-08-22

## Incident

TASK-004 retry passed typecheck, build, and the initial `test:e2e` verification
and reached human review. When Accept & Sync Wiki was selected, the apply
workflow copied the change and ran post-apply verification in the project
repository. That second Playwright invocation used the old global network-deny
profile, could not bind `127.0.0.1:4173`, rolled the apply back, and changed the
run to `FAILED`.

## Resolution

- Carry the frozen verification script name into post-apply verification.
- Grant loopback-only networking to post-apply Playwright/Cypress checks, while
  continuing to deny external network access.
- Keep ordinary post-apply verification on the stricter no-network profile.
- Preserve the safe retry classification so the failed acceptance run can be
  retried without `--force` after this hotfix is active.

## Verification

- Workspace verification policy tests cover initial and post-apply browser
  script detection.
- The prior TASK-004 source repository was restored cleanly after rollback.
- The failed run remains immutable and is eligible for a new safe retry.

Fresh machine certification and separate human acceptance are required before
tagging v1.0.4.
