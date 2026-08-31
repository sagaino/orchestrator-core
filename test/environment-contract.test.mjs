import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  runtimeConfigSnapshot,
  validateRuntimeProfileAlignment,
  RUNTIME_PROFILE_LOCAL_SAFE,
  RUNTIME_PROFILE_LOCAL_PILOT,
} from "../src/runtime-config.mjs";
import { commandRequiresRuntimeProfileAdmission, parseArguments } from "../src/orchestrator.mjs";

console.log("Running environment-contract.test.mjs...");

function parseDotenvLines(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const env = {};
  const seenKeys = new Set();
  const duplicateKeys = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let val = match[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (seenKeys.has(key)) {
      duplicateKeys.push(key);
    }
    seenKeys.add(key);
    env[key] = val;
  }
  return { env, duplicateKeys };
}

// 1. Check .env.example
const safeExamplePath = path.resolve(".env.example");
assert.ok(fs.existsSync(safeExamplePath), ".env.example must exist");
const { env: safeEnv, duplicateKeys: safeDups } = parseDotenvLines(safeExamplePath);
assert.deepEqual(safeDups, [], ".env.example must have no duplicate keys");
const safeSnapshot = runtimeConfigSnapshot(safeEnv);
assert.deepEqual(safeSnapshot.flags, RUNTIME_PROFILE_LOCAL_SAFE.flags);
assert.deepEqual(safeSnapshot.capacity, RUNTIME_PROFILE_LOCAL_SAFE.capacity);
assert.deepEqual(safeSnapshot.automation, RUNTIME_PROFILE_LOCAL_SAFE.automation);
const safeAlignment = validateRuntimeProfileAlignment(safeSnapshot);
assert.equal(safeAlignment.aligned, true, ".env.example must be aligned with LOCAL_SAFE");

// 2. Check .env.pilot.example
const pilotExamplePath = path.resolve(".env.pilot.example");
assert.ok(fs.existsSync(pilotExamplePath), ".env.pilot.example must exist");
const { env: pilotEnv, duplicateKeys: pilotDups } = parseDotenvLines(pilotExamplePath);
assert.deepEqual(pilotDups, [], ".env.pilot.example must have no duplicate keys");
const pilotSnapshot = runtimeConfigSnapshot(pilotEnv);
assert.deepEqual(pilotSnapshot.flags, RUNTIME_PROFILE_LOCAL_PILOT.flags);
assert.deepEqual(pilotSnapshot.capacity, RUNTIME_PROFILE_LOCAL_PILOT.capacity);
assert.deepEqual(pilotSnapshot.automation, RUNTIME_PROFILE_LOCAL_PILOT.automation);
const pilotAlignment = validateRuntimeProfileAlignment(pilotSnapshot);
assert.equal(pilotAlignment.aligned, true, ".env.pilot.example must be aligned with LOCAL_PILOT");

// 3. No secrets or non-placeholder paths in examples
for (const filePath of [safeExamplePath, pilotExamplePath]) {
  const content = fs.readFileSync(filePath, "utf8");
  assert.ok(!content.includes("BEGIN PRIVATE KEY"), "No private keys in examples");
  assert.ok(!content.includes("eyJ"), "No raw JWT tokens in examples");
  assert.ok(!content.includes("/Users/sagaino"), "No hardcoded personal paths in examples");
}

// 4. Canonical path aliases and explicit CLI values have deterministic precedence
const canonicalVault = path.resolve("fixtures/canonical-vault");
const legacyVault = path.resolve("fixtures/legacy-vault");
const cliVault = path.resolve("fixtures/cli-vault");
assert.equal(parseArguments([], { ORCHESTRATOR_VAULT_PATH: canonicalVault, ORCHESTRATOR_VAULT: legacyVault }).vault, canonicalVault);
assert.equal(parseArguments([], { ORCHESTRATOR_VAULT: legacyVault }).vault, legacyVault);
assert.equal(parseArguments(["--vault", cliVault], { ORCHESTRATOR_VAULT_PATH: canonicalVault, ORCHESTRATOR_VAULT: legacyVault }).vault, cliVault);
assert.throws(() => parseArguments(["--port", "invalid"], {}), /Invalid port/);
assert.throws(() => parseArguments(["--port", "65536"], {}), /Invalid port/);
assert.equal(commandRequiresRuntimeProfileAdmission("execute"), true);
assert.equal(commandRequiresRuntimeProfileAdmission("approve"), false, "Human review remains available while execution is blocked");
assert.equal(commandRequiresRuntimeProfileAdmission("review"), false);

// 5. The launcher rejects an invalid canonical port before any service launch
const invalidLaunch = spawnSync("bash", [path.resolve("start.sh")], {
  cwd: path.resolve("."),
  encoding: "utf8",
  timeout: 5_000,
  env: { ...process.env, ORCHESTRATOR_API_PORT: "invalid" },
});
assert.equal(invalidLaunch.status, 1);
assert.match(`${invalidLaunch.stdout}\n${invalidLaunch.stderr}`, /ORCHESTRATOR_API_PORT tidak valid/);
assert.ok(!invalidLaunch.stdout.includes("Menjalankan Backend Daemon"), "Invalid port must fail before process launch");

console.log("environment-contract.test.mjs: All tests passed!");
