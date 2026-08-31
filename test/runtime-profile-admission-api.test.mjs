import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorServer } from "../src/server.mjs";

console.log("Running runtime-profile-admission-api.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-profile-admission-api-"));
const runsRoot = path.join(root, "runs");
const vaultRoot = path.join(root, "vault");
const token = "p".repeat(64);
let service;

try {
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  service = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: 0,
    host: "127.0.0.1",
    apiToken: token,
    env: {
      ORCHESTRATOR_PROFILE: "LOCAL_SAFE",
      ORCHESTRATOR_OBJECTIVES_ENABLED: "1",
      ORCHESTRATOR_APPROVAL_MODE: "MANUAL",
      ORCHESTRATOR_MAX_PARALLEL_JOBS: "2",
      ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS: "2",
    },
    services: { objectivesEnabled: () => true },
  });
  await service.start();
  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
  const session = (await sessionResponse.json()).data;

  const readResponse = await fetch(`${baseUrl}/api/objectives`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(readResponse.status, 200, "Read-only objective inspection remains available");

  const admissionResponse = await fetch(`${baseUrl}/api/objectives`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "profile-mismatch-intake",
      "X-Operator-Session": session.sessionId,
      "X-Action-Nonce": session.actionNonce,
    },
    body: JSON.stringify({ mode: "EXISTING_PROJECT", projectIds: ["missing"], request: "Must be rejected before intake." }),
  });
  assert.equal(admissionResponse.status, 503);
  const admissionBody = await admissionResponse.json();
  assert.equal(admissionBody.error.details.code, "RUNTIME_PROFILE_MISMATCH");
  assert.equal(admissionBody.error.details.profile, "LOCAL_SAFE");
  assert.ok(admissionBody.error.details.mismatches.some((item) => item.field === "flags.objectives"));

  const nextNonce = admissionResponse.headers.get("x-action-nonce");
  const recoveryResponse = await fetch(`${baseUrl}/api/runs/missing-run/recover`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Operator-Session": session.sessionId,
      "X-Action-Nonce": nextNonce,
    },
    body: JSON.stringify({ recoveredBy: "test" }),
  });
  assert.notEqual(recoveryResponse.status, 503, "Recovery endpoints are not blocked by profile admission");

  const readinessResponse = await fetch(`${baseUrl}/api/operations/readiness`, { headers: { Authorization: `Bearer ${token}` } });
  const readinessBody = await readinessResponse.json();
  const profileBlocker = readinessBody.data.admission.blockers.find((item) => item.id === "runtime-profile");
  assert.equal(profileBlocker.code, "RUNTIME_PROFILE_MISMATCH");
} finally {
  if (service) await service.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("runtime-profile-admission-api.test.mjs passed");
