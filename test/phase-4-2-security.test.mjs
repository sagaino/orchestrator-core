import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAuditEntry, verifyAuditChain, auditChainPath } from "../src/audit-chain.mjs";
import { allowlistedEnvironment, CAPABILITY_PROFILES, capabilityForStage, prepareCapabilitySpawn, sandboxPolicy } from "../src/capability-policy.mjs";
import { aiRepairApplicable, runProcess, verificationRequiresLoopback } from "../src/executor.mjs";
import { OperatorSessionStore } from "../src/api/operator-session.mjs";
import { redactSensitive, redactText } from "../src/redaction.mjs";
import { hardenRuntimePermissions } from "../src/runtime-hardening.mjs";
import { changedPaths, repositorySnapshot, snapshotFromObject, verificationRequiresLoopback as postApplyVerificationRequiresLoopback } from "../src/workspace-manager.mjs";
import { isSafeInfrastructureFailure } from "../src/task-workflow.mjs";

console.log("Running phase-4-2-security.test.mjs...");
assert.deepEqual(Object.keys(CAPABILITY_PROFILES).sort(), ["agent", "graphify", "preview", "updater", "verification"]);

const filtered = allowlistedEnvironment({ PATH: "/bin", HOME: "/Users/fixture", HOST_SECRET: "seeded-host-secret", API_KEY: "secret-api-key" }, "verification");
assert.equal(filtered.PATH, "/bin");
assert.equal(filtered.HOME, "/Users/fixture");
assert.equal(filtered.HOST_SECRET, undefined);
assert.equal(filtered.API_KEY, undefined);
assert.match(sandboxPolicy({ profileName: "agent", cwd: "/tmp" }), /\(allow network\*\)/);
assert.match(sandboxPolicy({ profileName: "verification", cwd: "/tmp" }), /\(deny network\*\)/);
const loopbackPolicy = sandboxPolicy({ profileName: "verification", cwd: "/tmp", allowLoopback: true });
assert.match(loopbackPolicy, /deny network-outbound \(require-not \(remote ip "localhost:\*"\)\)/);
assert.match(loopbackPolicy, /deny network-inbound \(require-not \(local ip "localhost:\*"\)\)/);
assert.doesNotMatch(loopbackPolicy, /\(deny network\*\)/);
assert.doesNotMatch(sandboxPolicy({ profileName: "agent", cwd: "/tmp", home: "/Users/fixture" }), /Library\/Keychains/);
assert.match(sandboxPolicy({ profileName: "verification", cwd: "/tmp", home: "/Users/fixture" }), /Library\/Keychains/);
const providerPolicy = sandboxPolicy({ profileName: "agent", cwd: "/tmp", home: "/Users/fixture", providerManagedSandbox: true });
assert.doesNotMatch(providerPolicy, /deny file-write\* \(require-all/);
assert.match(providerPolicy, /deny file-write\* \(subpath "\/Users\/fixture\/\.ssh"\)/);
for (const stage of ["task-intake-planner", "retrospective", "knowledge-classification", "knowledge-ingest", "knowledge-harvest-pass-1"]) assert.equal(capabilityForStage(stage), "agent");
assert.equal(capabilityForStage("verification:npm-test"), "verification");
assert.equal(verificationRequiresLoopback("test:e2e", "playwright test"), true);
assert.equal(verificationRequiresLoopback("test:browser", "vitest run"), true);
assert.equal(verificationRequiresLoopback("test", "vitest run"), false);
assert.equal(postApplyVerificationRequiresLoopback("test:e2e", "playwright test"), true);
assert.equal(postApplyVerificationRequiresLoopback("test", "vitest run"), false);
assert.equal(aiRepairApplicable(new Error("listen EPERM: operation not permitted 127.0.0.1:4173")), false);
assert.equal(aiRepairApplicable(new Error("Scope guard menolak automatic recovery di luar allowed_paths: test-results/playwright/.last-run.json")), false);
assert.equal(aiRepairApplicable(new Error("Verification gagal: unit assertion mismatch")), true);
assert.equal(isSafeInfrastructureFailure({
  rawError: "Verification gagal: listen EPERM: operation not permitted 127.0.0.1:4173",
  manifest: { execution: { frozenVerificationScripts: { "test:e2e": "playwright test" } } },
}), true);
assert.equal(isSafeInfrastructureFailure({
  rawError: "Scope guard menolak automatic recovery di luar allowed_paths: test-results/playwright/.last-run.json",
  manifest: { task: { allowedPaths: ["src/pages/Login/index.tsx"] }, execution: { scopeAudit: {
    agentChangedPaths: ["src/pages/Login/index.tsx"],
    allowedPaths: ["src/pages/Login/index.tsx"],
    effectiveAllowedPaths: ["src/pages/Login/index.tsx"],
    outOfScopePaths: ["test-results/playwright/.last-run.json"],
    deniedPaths: [],
  } } },
}), true);
assert.equal(isSafeInfrastructureFailure({
  rawError: "Verification gagal: assertion mismatch",
  manifest: { execution: { scopeAudit: { changedPaths: ["src/App.tsx"] } } },
}), false);

const preparedAgy = prepareCapabilitySpawn({ command: "agy", args: ["-p", "fixture"], cwd: "/tmp", env: { PATH: "/bin", HOME: "/Users/fixture" }, capabilityProfile: "agent" });
try {
  assert.equal(preparedAgy.env.HOME, "/Users/fixture");
  assert.equal(preparedAgy.args.at(-1), "--sandbox");
  assert.doesNotMatch(preparedAgy.args[1], /deny file-write\* \(require-all/);
} finally {
  fs.rmSync(preparedAgy.temporaryRoot, { recursive: true, force: true });
}

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
  const inside = path.join(workspace, "inside.txt");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(secretRoot, { recursive: true });
  const secretPath = path.join(secretRoot, "seeded-secret.txt");
  fs.writeFileSync(secretPath, knownSecret, { mode: 0o600 });

  const script = [
    "const fs=require('fs'),net=require('net');",
    `const result={envSecret:process.env.HOST_SECRET??null,home:process.env.HOME??null};`,
    `try{result.hostSecret=fs.readFileSync(${JSON.stringify(secretPath)},'utf8')}catch(e){result.hostReadError=e.code}`,
    `try{fs.writeFileSync(${JSON.stringify(outside)},'escape');result.outsideWrite=true}catch(e){result.outsideWriteError=e.code}`,
    `try{fs.writeFileSync(${JSON.stringify(inside)},'allowed');result.insideWrite=true}catch(e){result.insideWriteError=e.code}`,
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
    env: { ...process.env, HOME: hostHome, HOST_SECRET: knownSecret },
    home: hostHome,
    deadlineMs: 10_000,
  });
  assert.equal(processResult.exitCode, 0, processResult.stderrTail);
  const observation = JSON.parse(processResult.stdoutTail.trim());
  assert.equal(observation.home, hostHome);
  assert.equal(observation.envSecret, null);
  assert.equal(observation.hostSecret, undefined);
  assert.equal(observation.hostReadError, "EPERM");
  assert.equal(observation.outsideWrite, undefined);
  assert.equal(observation.outsideWriteError, "EPERM");
  assert.equal(observation.insideWrite, true, observation.insideWriteError);
  assert.equal(fs.readFileSync(inside, "utf8"), "allowed");
  assert.equal(observation.network, undefined);
  assert.ok(observation.networkError);
  assert.equal(fs.existsSync(outside), false);

  const loopbackScript = [
    "const net=require('net');const result={};",
    "const server=net.createServer((socket)=>socket.end('ok'));",
    "server.listen(0,'127.0.0.1',()=>{",
    "const local=net.connect(server.address().port,'127.0.0.1');",
    "local.on('data',()=>{result.loopback=true;local.destroy();server.close();const external=net.connect(80,'93.184.216.34');external.on('connect',()=>{result.external=true;external.destroy();console.log(JSON.stringify(result))});external.on('error',(error)=>{result.externalError=error.code;console.log(JSON.stringify(result))})});",
    "local.on('error',(error)=>{result.loopbackError=error.code;server.close();console.log(JSON.stringify(result))});",
    "});server.on('error',(error)=>{result.bindError=error.code;console.log(JSON.stringify(result))});",
  ].join("");
  const loopbackResult = await runProcess({
    command: process.execPath,
    args: ["-e", loopbackScript],
    cwd: workspace,
    stage: "verification:test:e2e",
    capabilityProfile: "verification",
    allowLoopback: true,
    env: { ...process.env, HOME: hostHome },
    home: hostHome,
    deadlineMs: 10_000,
  });
  assert.equal(loopbackResult.exitCode, 0, loopbackResult.stderrTail);
  const loopbackObservation = JSON.parse(loopbackResult.stdoutTail.trim());
  assert.equal(loopbackObservation.loopback, true, loopbackObservation.loopbackError);
  assert.equal(loopbackObservation.external, undefined);
  assert.equal(loopbackObservation.externalError, "EPERM");

  const snapshotBeforeArtifacts = repositorySnapshot(workspace);
  const playwrightArtifact = path.join(workspace, "test-results", "playwright", ".last-run.json");
  fs.mkdirSync(path.dirname(playwrightArtifact), { recursive: true });
  fs.writeFileSync(playwrightArtifact, "{}\n");
  assert.deepEqual(changedPaths(snapshotBeforeArtifacts, repositorySnapshot(workspace)), []);
  assert.equal(snapshotFromObject({ "src/App.tsx": "hash", "test-results/playwright/.last-run.json": "artifact" }).has("test-results/playwright/.last-run.json"), false);

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
