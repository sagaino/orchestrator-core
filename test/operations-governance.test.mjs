import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { appendAuditEntry } from "../src/audit-chain.mjs";
import { RequestRateLimiter, applyRetentionPlan, operationsReadiness, previewRetention, recordVerifiedBackup, restoreRetentionTrash } from "../src/operations-governance.mjs";
import { createEventHub } from "../src/api/events.mjs";

console.log("Running operations-governance.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-ops-"));
const runsRoot = path.join(root, "runs");
try {
  fs.mkdirSync(path.join(runsRoot, "workspace-artifacts", "old-run"), { recursive: true });
  fs.mkdirSync(path.join(runsRoot, "workspace-artifacts", "new-run"), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, "workspace-artifacts", "old-run", "result.txt"), "old result");
  fs.writeFileSync(path.join(runsRoot, "workspace-artifacts", "new-run", "result.txt"), "new result");
  const oldDate = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(path.join(runsRoot, "workspace-artifacts", "old-run"), oldDate, oldDate);
  appendAuditEntry(runsRoot, { event: "TEST", actor: "test" });

  const blocked = operationsReadiness({ runsRoot, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.admission.blockers[0].id, "backup");

  recordVerifiedBackup({
    runsRoot,
    backupPath: path.join(root, "backup"),
    verification: { verifiedAt: "2026-08-22T00:00:00.000Z", fileCount: 1, totalBytes: 10 },
    manifest: { backupId: "dr-test", createdAt: "2026-08-22T00:00:00.000Z", completedAt: "2026-08-22T00:00:00.000Z" },
  });
  const ready = operationsReadiness({ runsRoot, now: new Date("2026-08-22T01:00:00.000Z") });
  assert.equal(ready.admission.allowed, true);

  const preview = previewRetention({ runsRoot, olderThanDays: 30, now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(preview.summary.candidateCount, 1);
  assert.equal(preview.candidates[0].name, "old-run");
  assert.throws(() => applyRetentionPlan({ runsRoot, planId: preview.planId, confirmed: false, confirmedBy: "test" }), /confirm=true/);
  const moved = applyRetentionPlan({ runsRoot, planId: preview.planId, confirmed: true, confirmedBy: "test", now: new Date("2026-08-22T00:01:00.000Z") });
  assert.equal(moved.status, "MOVED_TO_TRASH");
  assert.equal(fs.existsSync(path.join(runsRoot, "workspace-artifacts", "old-run")), false);
  assert.equal(fs.existsSync(path.join(runsRoot, "trash", "retention", preview.planId, "workspace-artifacts", "old-run", "result.txt")), true);
  const restored = restoreRetentionTrash({ runsRoot, trashId: preview.planId, confirmed: true, confirmedBy: "test" });
  assert.equal(restored.status, "RESTORED");
  assert.equal(fs.existsSync(path.join(runsRoot, "workspace-artifacts", "old-run", "result.txt")), true);

  let now = 0;
  const limiter = new RequestRateLimiter({ readLimit: 2, mutationLimit: 1, windowMs: 1_000, now: () => now });
  assert.equal(limiter.check({ key: "local" }).allowed, true);
  assert.equal(limiter.check({ key: "local" }).allowed, true);
  assert.equal(limiter.check({ key: "local" }).allowed, false);
  assert.equal(limiter.check({ key: "local", mutation: true }).allowed, true);
  assert.equal(limiter.check({ key: "local", mutation: true }).allowed, false);
  now = 1_001;
  assert.equal(limiter.check({ key: "local" }).allowed, true);

  const hub = createEventHub({ maxClients: 1, heartbeatIntervalMs: 60_000 });
  const request = new EventEmitter();
  const firstResponse = { writeHead: () => {}, write: () => {}, end: () => {} };
  const limitedResponse = { status: null, headers: null, body: "", writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  hub.addClient(request, firstResponse);
  assert.equal(hub.clientCount, 1);
  assert.equal(hub.addClient(new EventEmitter(), limitedResponse), null);
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers["Retry-After"], "15");
  assert.equal(hub.rejectedClientCount, 1);
  hub.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operations-governance.test.mjs passed");
