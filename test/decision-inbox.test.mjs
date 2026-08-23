import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { createDecision, getDecision, listDecisionInbox } from "../src/decision-store.mjs";

console.log("Running decision-inbox.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "decision-inbox-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
fs.mkdirSync(vaultRoot, { recursive: true });
fs.mkdirSync(runsRoot, { recursive: true });

const decision = ({ decisionId, createdAt, risk, type = "PLAN_APPROVAL" }) => ({
  schemaVersion: 1,
  revision: 0,
  decisionId,
  objectiveId: "obj-inbox-fixture",
  nodeId: null,
  runId: null,
  type,
  state: "OPEN",
  evidence: { risk },
  requestedAction: "Review the durable decision before continuing.",
  allowedChoices: ["APPROVE", "CANCEL"],
  creator: "SYSTEM",
  createdAt,
  resolution: null,
});

createDecision({ runsRoot, record: decision({ decisionId: "decision-low-old", createdAt: "2026-08-22T00:00:00.000Z", risk: "LOW" }) });
createDecision({ runsRoot, record: decision({ decisionId: "decision-high-new", createdAt: "2026-08-23T02:00:00.000Z", risk: "HIGH" }) });
createDecision({ runsRoot, record: decision({ decisionId: "decision-high-old", createdAt: "2026-08-23T01:00:00.000Z", risk: "HIGH" }) });

try {
  const inbox = listDecisionInbox(runsRoot, { now: "2026-08-23T03:00:00.000Z" });
  assert.deepEqual(inbox.map((item) => item.decisionId), ["decision-high-old", "decision-high-new", "decision-low-old"]);
  assert.deepEqual(inbox.map((item) => item.risk), ["HIGH", "HIGH", "LOW"]);
  assert.equal(inbox[0].ageMs, 7_200_000);

  const service = createOrchestratorServer({ vaultRoot, runsRoot, port: 0, host: "127.0.0.1", apiToken: "p".repeat(64) });
  await service.start();
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const inboxResponse = await fetch(`${base}/api/decisions/inbox`, { headers: { Authorization: `Bearer ${service.token}` } });
    const inboxPayload = await inboxResponse.json();
    assert.equal(inboxResponse.status, 200);
    assert.deepEqual(inboxPayload.data.map((item) => item.decisionId), ["decision-high-old", "decision-high-new", "decision-low-old"]);

    const sessionResponse = await fetch(`${base}/api/auth/session`, { headers: { Authorization: `Bearer ${service.token}` } });
    const session = (await sessionResponse.json()).data;
    const headers = {
      Authorization: `Bearer ${service.token}`,
      "Content-Type": "application/json",
      "X-Operator-Session": session.sessionId,
      "X-Action-Nonce": session.actionNonce,
      "Idempotency-Key": "decision-inbox-resolve-1",
    };
    const resolvedResponse = await fetch(`${base}/api/decisions/decision-high-old/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "APPROVE", resolvedBy: "external-forged-identity" }),
    });
    const resolvedPayload = await resolvedResponse.json();
    assert.equal(resolvedResponse.status, 201);
    assert.notEqual(resolvedPayload.data.decision.resolution.resolvedBy, "external-forged-identity");
    assert.match(resolvedPayload.data.decision.resolution.resolvedBy, /^local:/);

    const repeatedHeaders = { ...headers, "X-Action-Nonce": resolvedResponse.headers.get("x-action-nonce") ?? headers["X-Action-Nonce"] };
    const repeatedResponse = await fetch(`${base}/api/decisions/decision-high-old/resolve`, {
      method: "POST",
      headers: repeatedHeaders,
      body: JSON.stringify({ action: "APPROVE" }),
    });
    const repeatedPayload = await repeatedResponse.json();
    assert.equal(repeatedResponse.status, 200);
    assert.equal(repeatedPayload.data.alreadyResolved, true);

    const invalidHeaders = { ...repeatedHeaders, "X-Action-Nonce": repeatedResponse.headers.get("x-action-nonce") ?? repeatedHeaders["X-Action-Nonce"], "Idempotency-Key": "decision-inbox-invalid-1" };
    const invalidResponse = await fetch(`${base}/api/decisions/decision-high-new/resolve`, {
      method: "POST",
      headers: invalidHeaders,
      body: JSON.stringify({ action: "EXECUTE" }),
    });
    const invalidPayload = await invalidResponse.json();
    assert.equal(invalidResponse.status, 422);
    assert.equal(invalidPayload.error.details.code, "DECISION_ACTION_NOT_ALLOWED");
    assert.equal(getDecision(runsRoot, "decision-high-new").state, "OPEN");
  } finally {
    await service.stop();
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("decision-inbox.test.mjs: All tests passed!");
