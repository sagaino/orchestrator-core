import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";

console.log("Running backup-operations-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-backup-api-"));
const runsRoot = path.join(root, "runs");
const vaultRoot = path.join(root, "vault");
const backupRoot = path.join(root, "external-backups");
const token = "b".repeat(64);
let service;

try {
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  service = createOrchestratorServer({ vaultRoot, runsRoot, port: 0, host: "127.0.0.1", apiToken: token });
  await service.start();
  const port = service.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}` };

  const status = await fetch(`${base}/api/operations/backups/status`, { headers: auth });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).data.guardrails.permanentDelete, false);

  const sessionResponse = await fetch(`${base}/api/auth/session`, { headers: auth });
  const session = (await sessionResponse.json()).data;
  const mutationHeaders = { ...auth, "Content-Type": "application/json", "X-Operator-Session": session.sessionId, "X-Action-Nonce": session.actionNonce };
  const previewResponse = await fetch(`${base}/api/operations/backups/schedule/preview`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ backupRoot, intervalHours: 6 }) });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).data;
  assert.equal(preview.launchd.activated, false);
  assert.match(preview.launchd.plist, /StartInterval.*21600/s);
  const nextNonce = previewResponse.headers.get("x-action-nonce");

  const drillResponse = await fetch(`${base}/api/operations/recovery-drill/record`, { method: "POST", headers: { ...mutationHeaders, "X-Action-Nonce": nextNonce }, body: JSON.stringify({ evidence: "API drill evidence", result: "PASS" }) });
  assert.equal(drillResponse.status, 201);
  assert.equal((await drillResponse.json()).data.result, "PASS");
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("backup-operations-api.test.mjs passed");
