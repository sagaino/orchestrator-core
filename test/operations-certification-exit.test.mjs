import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOperationsCertification, verifyOperationsCertification } from "../src/operations-certification.mjs";
import { runOperationsCertificationHarness } from "../src/operations-certification-harness.mjs";

console.log("Running operations-certification-exit.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-v2074-certification-"));
const now = new Date("2026-08-23T00:00:00.000Z");

try {
  const rehearsal = await runOperationsCertificationHarness({ harnessRoot: root, durationHours: 72, stepMinutes: 15, maxSteps: 4, now, cleanupOwnedWorkspace: false });
  assert.equal(rehearsal.status, "PASS", JSON.stringify(rehearsal, null, 2));
  assert.equal(rehearsal.exitEvidence.multipleObjectives.passed, true);
  assert.equal(rehearsal.exitEvidence.restartPoints.passed, true);
  assert.equal(rehearsal.exitEvidence.budgetStop.count, 1);
  assert.equal(rehearsal.exitEvidence.backupRestore.passed, true);
  assert.equal(rehearsal.exitEvidence.noOrphanWorktree.passed, true);
  assert.equal(rehearsal.exitEvidence.noLostState.passed, true);

  const certification = createOperationsCertification({
    runsRoot: path.join(root, "runs"),
    vaultRoot: path.join(root, "vault"),
    soakReport: rehearsal.soakReport,
    now,
    requireExitEvidence: true,
    capacity: { maxArtifactBytes: 100_000 },
  });
  assert.equal(certification.status, "CERTIFICATION_READY", JSON.stringify(certification, null, 2));
  assert.equal(certification.humanGate.required, true);
  assert.equal(certification.humanGate.confirmed, false);
  for (const checkId of ["BOUNDED_SOAK_EXIT", "MULTIPLE_OBJECTIVES_EXIT", "RESTART_POINTS_EXIT", "DECISION_RECORDS_EXIT", "BUDGET_STOP_EXIT", "BACKUP_RESTORE_EXIT", "NO_ORPHAN_WORKTREE_EXIT", "NO_LOST_STATE_EXIT"]) {
    assert.equal(certification.checks.find((check) => check.id === checkId)?.status, "PASS", checkId);
  }
  assert.equal(verifyOperationsCertification({ bundleFilePath: certification.bundlePath }).valid, true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operations-certification-exit.test.mjs passed");
