import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildKnowledgeProvenance, reviewDateFrom, validateKnowledgeProvenance } from "../src/knowledge-provenance.mjs";
import { knowledgeHealth } from "../src/knowledge-quality.mjs";
import { applyKnowledgeProvenanceMigration, previewKnowledgeProvenanceMigration, rollbackKnowledgeProvenanceMigration } from "../src/knowledge-provenance-migration.mjs";

console.log("Running knowledge-provenance.test.mjs...");

const provenance = buildKnowledgeProvenance({
  orchestratorRun: "run-p8-0",
  sources: ["[[03-Sources/other/orchestrator-runs/run-p8-0.json]]"],
  confidence: 0.94,
  owner: "reviewer",
  now: new Date("2026-08-22T00:00:00.000Z"),
});
assert.equal(provenance.schemaVersion, 1);
assert.equal(provenance.review_by, "2027-02-18");
assert.equal(validateKnowledgeProvenance({
  provenance_schema: provenance.schemaVersion,
  orchestrator_run: provenance.orchestrator_run,
  sources: provenance.sources,
  confidence: provenance.confidence,
  owner: provenance.owner,
  review_by: provenance.review_by,
  supersession: provenance.supersession,
}).valid, true);
assert.equal(validateKnowledgeProvenance({ classification: "PROJECT_ONLY" }, { scope: "PROJECT_ONLY" }).valid, true);
assert.deepEqual(validateKnowledgeProvenance({ orchestrator_run: "run", sources: [], confidence: 2, review_by: "bad", supersession: "UNKNOWN" }), {
  valid: false,
  missing: ["sources", "owner"],
  invalid: ["confidence", "review_by", "supersession"],
  scope: "GLOBAL",
});
assert.equal(reviewDateFrom({ now: new Date("2026-01-01T00:00:00.000Z"), days: 1 }), "2026-01-02");

const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-provenance-vault-"));
try {
  fs.mkdirSync(path.join(vaultRoot, "01-Knowledge", "patterns"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "index.md"), "# Index\n");
  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), "# Projects\n");
  fs.writeFileSync(path.join(vaultRoot, "01-Knowledge", "patterns", "legacy.md"), "---\ntitle: Legacy\ntype: pattern\ntags: [pattern]\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources: [legacy]\n---\n# Legacy\n");
  fs.writeFileSync(path.join(vaultRoot, "01-Knowledge", "patterns", "invalid.md"), "---\ntitle: Invalid\ntype: pattern\ntags: [pattern]\ncreated: 2026-01-01\nupdated: 2026-01-01\nprovenance_schema: 99\norchestrator_run: run\nsources: [source]\nconfidence: 0.8\nowner: reviewer\nreview_by: 2026-12-01\nsupersession: ACTIVE\n---\n# Invalid\n");
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "demo"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "demo", "task.md"), "---\ntitle: Project task\ntype: task\ntags: [task]\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources: []\n---\n# Project task\n");
  const report = knowledgeHealth({ vaultRoot });
  assert.ok(report.findings.some((item) => item.check === "PROVENANCE" && item.path.endsWith("legacy.md") && item.severity === "WARNING"));
  assert.ok(report.findings.some((item) => item.check === "PROVENANCE" && item.path.endsWith("invalid.md") && item.severity === "ERROR"));
  assert.equal(report.findings.some((item) => item.path.endsWith("02-Projects/demo/task.md") && item.check === "PROVENANCE"), false);

  const preview = previewKnowledgeProvenanceMigration({ vaultRoot, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(preview.action, "KNOWLEDGE_PROVENANCE_MIGRATION_PREVIEW");
  assert.equal(preview.summary.candidateCount, 2);
  assert.throws(() => applyKnowledgeProvenanceMigration({ vaultRoot, selector: preview.planId }), /confirmation eksplisit/);
  const applied = applyKnowledgeProvenanceMigration({ vaultRoot, selector: preview.planId, approvedBy: "tester", confirmed: true });
  assert.equal(applied.status, "APPLIED");
  const after = knowledgeHealth({ vaultRoot });
  assert.equal(after.findings.filter((item) => item.check === "PROVENANCE").length, 0);
  const rolledBack = rollbackKnowledgeProvenanceMigration({ vaultRoot, selector: preview.planId, revertedBy: "tester", confirmed: true });
  assert.equal(rolledBack.status, "ROLLED_BACK");
} finally {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
}

console.log("knowledge-provenance.test.mjs: All tests passed!");
