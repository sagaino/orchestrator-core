import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { RequestRateLimiter } from "../src/operations-governance.mjs";

console.log("Running operations-alerts-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-alerts-api-"));
const token = "b".repeat(64);
let service;
try {
  const runsRoot = path.join(root, "runs");
  const vaultRoot = path.join(root, "vault");
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  service = createOrchestratorServer({ vaultRoot, runsRoot, port: 0, host: "127.0.0.1", apiToken: token, rateLimiter: new RequestRateLimiter({ readLimit: 10, mutationLimit: 5 }) });
  await service.start();
  const port = service.server.address().port;
  const headers = { Authorization: `Bearer ${token}` };
  const session = (await (await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers })).json()).data;
  const mutationHeaders = { ...headers, "Content-Type": "application/json", "X-Operator-Session": session.sessionId, "X-Action-Nonce": session.actionNonce };
  const acknowledged = await fetch(`http://127.0.0.1:${port}/api/operations/alerts/acknowledge`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ alertId: "OPS_BACKUP", acknowledgedBy: "api-operator", owner: "recovery-oncall", snoozeMinutes: 15, note: "triage" }) });
  assert.equal(acknowledged.status, 200);
  const acknowledgedBody = await acknowledged.json();
  assert.equal(acknowledgedBody.data.owner, "recovery-oncall");

  const nextSession = (await (await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers })).json()).data;
  const resolveHeaders = { ...headers, "Content-Type": "application/json", "X-Operator-Session": nextSession.sessionId, "X-Action-Nonce": nextSession.actionNonce };
  const resolved = await fetch(`http://127.0.0.1:${port}/api/operations/alerts/resolve`, { method: "POST", headers: resolveHeaders, body: JSON.stringify({ alertId: "OPS_BACKUP", resolvedBy: "api-operator", evidence: { summary: "Backup verified", reference: "backup-20260822" } }) });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).data.kind, "RESOLUTION");

  const resolutions = await fetch(`http://127.0.0.1:${port}/api/operations/alerts/resolutions?alertId=OPS_BACKUP`, { headers });
  assert.equal(resolutions.status, 200);
  assert.equal((await resolutions.json()).data.length, 1);
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operations-alerts-api.test.mjs: All tests passed!");
