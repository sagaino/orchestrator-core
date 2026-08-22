# AI OS v1.0.3 Hotfix

Status: **IMPLEMENTED — HUMAN ACCEPTANCE REQUIRED**  
Date: 2026-08-22

## Incident

After v1.0.2 was active, the historical TASK-004 run still contained a
pre-hotfix scope audit with Playwright output listed as out-of-scope. The retry
guard read that persisted audit and rejected a safe retry unless the operator
used `--force`. The run inspector also received a 404 when a failed run had no
visual-certification record; absence of evidence is normal for an uncompleted
run and should not be reported as a corrupted record.

## Resolution

- Classify the known loopback sandbox failure and the legacy Playwright-artifact
  scope failure as safe infrastructure failures when the agent changes remain
  inside allowed paths and no denied paths are present.
- Keep the retry guard fail-closed for ordinary implementation failures and
  suspicious scope/denied-path changes.
- Return HTTP 200 with `data: null` when a run has no visual-certification
  record. A present but tampered or invalid certification still returns an
  error and is never treated as valid evidence.

## Verification

- Retry-policy regression tests distinguish the known TASK-004 failure from a
  real source assertion failure.
- Visual-certification regression tests cover absent and tampered records.
- The original TASK-004 run remains immutable; its safe retry can be queued
  without `--force` after v1.0.3 is active.

Fresh machine certification and separate human acceptance are required before
tagging v1.0.3.
