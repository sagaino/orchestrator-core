import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  runtimeConfigSnapshot,
  validateRuntimeProfileAlignment,
  RUNTIME_PROFILE_LOCAL_SAFE,
  RUNTIME_PROFILE_LOCAL_PILOT,
} from "../src/runtime-config.mjs";

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

console.log("environment-contract.test.mjs: All tests passed!");
