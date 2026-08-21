import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAuditEntry, verifyAuditChain, auditChainPath } from "../src/audit-chain.mjs";
import { allowlistedEnvironment, CAPABILITY_PROFILES } from "../src/capability-policy.mjs";
import { runProcess } from "../src/executor.mjs";
import { OperatorSessionStore } from "../src/api/operator-session.mjs";
import { redactSensitive, redactText } from "../src/redaction.mjs";
import { hardenRuntimePermissions } from "../src/runtime-hardening.mjs";

console.log("Running phase-4-2-security.test.mjs...");
assert.deepEqual(Object.keys(CAPABILITY_PROFILES).sort(), ["agent", "graphify", "preview", "updater", "verification"]);

const filtered = allowlistedEnvironment({ PATH: "/bin", HOST_SECRET: "seeded-host-secret", API_KEY: "secret-api-key" }, "verification");
assert.equal(filtered.PATH, "/bin");
assert.equal(filtered.HOST_SECRET, undefined);
assert.equal(filtered.API_KEY, undefined);

const knownSecret = "phase42-known-secret-value";
assert.equal(redactText(`Bearer ${knownSecret}`, { env: { TEST_TOKEN: knownSecret } }), "Bearer [REDACTED]");
assert.deepEqual(redactSensitive({ password: knownSecret, nested: `token=${knownSecret}` }, { env: { TEST_TOKEN: knownSecret } }), {
  password: "[REDACTED]", nested: "token=[REDACTED]",
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "phase42-security-"));
try {
  const workspace = path.join(fixture, "workspace");
  const hostHome = path.join(fixture, "host-home");
  const secretRoot = path.join(hostHome, ".ssh");
  const outside = path.join(fixture, "outside.txt");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(secretRoot, { recursive: true });
  const secretPath = path.join(secretRoot, "seeded-secret.txt");
  fs.writeFileSync(secretPath, knownSecret, { mode: 0o600 });

  const script = [
    "const fs=require('fs'),net=require('net');",
    `const result={envSecret:process.env.HOST_SECRET??null};`,
    `try{result.hostSecret=fs.readFileSync(${JSON.stringify(secretPath)},'utf8')}catch(e){result.hostReadError=e.code}`,
    `try{fs.writeFileSync(${JSON.stringify(outside)},'escape');result.outsideWrite=true}catch(e){result.outsideWriteError=e.code}`,
    "const socket=net.connect({host:'127.0.0.1',port:9});",
    "socket.on('connect',()=>{result.network=true;socket.destroy();console.log(JSON.stringify(result))});",
    "socket.on('error',(e)=>{result.networkError=e.code;console.log(JSON.stringify(result))});",
  ].join("");
  const processResult = await runProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: workspace,
    stage: "verification:adversarial",
    capabilityProfile: "verification",
    env: { ...process.env, HOST_SECRET: knownSecret },
    home: hostHome,
    deadlineMs: 10_000,
  });
  assert.equal(processResult.exitCode, 0, processResult.stderrTail);
  const observation = JSON.parse(processResult.stdoutTail.trim());
  assert.equal(observation.envSecret, null);
  assert.equal(observation.hostSecret, undefined);
  assert.equal(observation.hostReadError, "EPERM");
  assert.equal(observation.outsideWrite, undefined);
  assert.equal(observation.outsideWriteError, "EPERM");
  assert.equal(observation.network, undefined);
  assert.ok(observation.networkError);
  assert.equal(fs.existsSync(outside), false);

  const runsRoot = path.join(fixture, "runs");
  appendAuditEntry(runsRoot, { event: "TEST", actor: "local:test", detail: `token=${knownSecret}` });
  appendAuditEntry(runsRoot, { event: "TEST_2", actor: "local:test" });
  const valid = verifyAuditChain(runsRoot);
  assert.equal(valid.valid, true);
  assert.equal(valid.entries, 2);
  assert.doesNotMatch(fs.readFileSync(auditChainPath(runsRoot), "utf8"), new RegExp(knownSecret));
  const auditText = fs.readFileSync(auditChainPath(runsRoot), "utf8").replace("TEST_2", "FORGED");
  fs.writeFileSync(auditChainPath(runsRoot), auditText);
  assert.equal(verifyAuditChain(runsRoot).valid, false);

  const sessions = new OperatorSessionStore({ identity: "local:verified-operator" });
  const issued = sessions.issue();
  const authorized = sessions.authorize(issued.sessionId, issued.actionNonce);
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.actor, "local:verified-operator");
  assert.equal(sessions.authorize(issued.sessionId, issued.actionNonce).authorized, false);

  const evidenceFile = path.join(runsRoot, "evidence.json");
  fs.writeFileSync(evidenceFile, "{}", { mode: 0o644 });
  const hardened = hardenRuntimePermissions(runsRoot, { apply: true });
  assert.ok(hardened.files >= 2);
  assert.equal(fs.statSync(evidenceFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runsRoot).mode & 0o777, 0o700);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("phase-4-2-security.test.mjs: All tests passed!");
