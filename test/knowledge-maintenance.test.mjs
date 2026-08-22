import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyKnowledgeMerge,
  listKnowledgeMaintenance,
  previewKnowledgeMerge,
  revertKnowledgeMerge,
} from "../src/knowledge-maintenance.mjs";

console.log("Running knowledge-maintenance.test.mjs...");

const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-maintenance-vault-"));
const writePage = (relative, title, reviewBy, body) => {
  const absolute = path.join(vaultRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, [
    "---",
    `title: ${JSON.stringify(title)}`,
    "type: pattern",
    "tags: [pattern]",
    "created: 2026-01-01",
    "updated: 2026-02-01",
    "provenance_schema: 1",
    "orchestrator_run: run-maintenance",
    "sources: [\"[[03-Sources/other/orchestrator-runs/run-maintenance.json]]\"]",
    "confidence: 0.9",
    "owner: knowledge-curator",
    `review_by: ${reviewBy}`,
    "supersession: ACTIVE",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n"));
};

try {
  fs.mkdirSync(path.join(vaultRoot, "03-Sources", "other", "orchestrator-runs"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "03-Sources", "other", "orchestrator-runs", "run-maintenance.json"), "{}\n");
  writePage("01-Knowledge/patterns/alpha.md", "Deterministic Approval", "2026-01-15", "Approval is explicit and deterministic for every knowledge merge operation.");
  writePage("01-Knowledge/patterns/beta.md", "Deterministic Approvals", "2026-09-15", "Approval is explicit and deterministic for every knowledge merge operation.");
  fs.writeFileSync(path.join(vaultRoot, "index.md"), "# Index\n\n- [[01-Knowledge/patterns/alpha|Deterministic Approval]]\n- [[01-Knowledge/patterns/beta|Deterministic Approvals]]\n");

  const maintenance = listKnowledgeMaintenance({ vaultRoot, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(maintenance.schemaVersion, 1);
  assert.ok(maintenance.duplicates.some((item) => item.kind === "NEAR_DUPLICATE"));
  assert.ok(maintenance.stale.some((item) => item.path.endsWith("alpha.md") && item.status === "STALE"));
  assert.ok(maintenance.stale.some((item) => item.path.endsWith("beta.md") && item.status === "DUE_SOON"));

  const preview = previewKnowledgeMerge({
    vaultRoot,
    sourcePath: "01-Knowledge/patterns/alpha.md",
    targetPath: "01-Knowledge/patterns/beta.md",
    now: new Date("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(preview.action, "KNOWLEDGE_MERGE_PREVIEW");
  assert.equal(preview.confirmation.required, true);
  const sourceBefore = fs.readFileSync(path.join(vaultRoot, "01-Knowledge/patterns/alpha.md"), "utf8");
  assert.throws(() => applyKnowledgeMerge({ vaultRoot, sourcePath: preview.source.path, targetPath: preview.target.path }), /confirmation eksplisit/);

  const applied = applyKnowledgeMerge({
    vaultRoot,
    sourcePath: preview.source.path,
    targetPath: preview.target.path,
    approvedBy: "tester",
    confirmed: true,
    expectedSourceChecksum: preview.source.checksum,
    expectedTargetChecksum: preview.target.checksum,
    now: new Date("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(applied.action, "KNOWLEDGE_MERGE_APPLIED");
  assert.equal(applied.source.retained, true);
  assert.match(fs.readFileSync(path.join(vaultRoot, "01-Knowledge/patterns/alpha.md"), "utf8"), /supersession: SUPERSEDED/);
  assert.match(fs.readFileSync(path.join(vaultRoot, "01-Knowledge/patterns/beta.md"), "utf8"), /Consolidated from Deterministic Approval/);
  assert.match(fs.readFileSync(path.join(vaultRoot, "index.md"), "utf8"), /Deterministic Approvals/);

  const reverted = revertKnowledgeMerge({ vaultRoot, selector: applied.planId, revertedBy: "tester", confirmed: true });
  assert.equal(reverted.action, "KNOWLEDGE_MERGE_REVERTED");
  assert.equal(fs.readFileSync(path.join(vaultRoot, "01-Knowledge/patterns/alpha.md"), "utf8"), sourceBefore);
  assert.doesNotMatch(fs.readFileSync(path.join(vaultRoot, "01-Knowledge/patterns/beta.md"), "utf8"), /Consolidated from Deterministic Approval/);
} finally {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
}

console.log("knowledge-maintenance.test.mjs: All tests passed!");
