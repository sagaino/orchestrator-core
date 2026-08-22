import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";
import { RequestRateLimiter } from "../src/operations-governance.mjs";

console.log("Running operations-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-operations-api-"));
const runsRoot = path.join(root, "runs");
const vaultRoot = path.join(root, "vault");
let service;
try {
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  service = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: 0,
    host: "127.0.0.1",
    apiToken: "a".repeat(64),
    rateLimiter: new RequestRateLimiter({ readLimit: 1, mutationLimit: 1 }),
  });
  await service.start();
  const port = service.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/operations/readiness`, { headers: { Authorization: `Bearer ${"a".repeat(64)}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.data.status, "BLOCKED");
  assert.equal(body.data.admission.blockers[0].id, "backup");

  const limited = await fetch(`http://127.0.0.1:${port}/api/operations/readiness`, { headers: { Authorization: `Bearer ${"a".repeat(64)}` } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("operations-api.test.mjs passed");
