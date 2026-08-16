import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DENY_PATTERNS,
  isDeniedPath,
  filterDeniedPaths,
  validateSymlink,
  auditWorkspaceSecrets,
} from "../src/security.mjs";
import { assertVerificationScriptsUnmodified } from "../src/executor.mjs";

console.log("Running security.test.mjs...");

// 1. isDeniedPath checks
assert.equal(isDeniedPath(".env").denied, true, ".env must be denied");
assert.equal(isDeniedPath(".env.local").denied, true, ".env.local must be denied");
assert.equal(isDeniedPath(".env.production").denied, true, ".env.production must be denied");
assert.equal(isDeniedPath("subfolder/.env").denied, true, "subfolder/.env must be denied");
assert.equal(isDeniedPath(".env.example").denied, false, ".env.example must be allowed");
assert.equal(isDeniedPath("subfolder/.env.example").denied, false, "subfolder/.env.example must be allowed");

assert.equal(isDeniedPath("server.key").denied, true, ".key must be denied");
assert.equal(isDeniedPath("cert.pem").denied, true, ".pem must be denied");
assert.equal(isDeniedPath("bundle.p12").denied, true, ".p12 must be denied");
assert.equal(isDeniedPath("keystore.jks").denied, true, ".jks must be denied");
assert.equal(isDeniedPath("id_rsa").denied, true, "id_rsa must be denied");
assert.equal(isDeniedPath("id_ed25519").denied, true, "id_ed25519 must be denied");
assert.equal(isDeniedPath("credentials.json").denied, true, "credentials.json must be denied");
assert.equal(isDeniedPath("service-account-key.json").denied, true, "service-account JSON must be denied");

assert.equal(isDeniedPath("src/App.tsx").denied, false, "src/App.tsx must be allowed");
assert.equal(isDeniedPath("package.json").denied, false, "package.json must be allowed");

// 2. filterDeniedPaths checks
const samplePaths = [
  "src/index.ts",
  ".env",
  ".env.example",
  "config/secret.pem",
  "package-lock.json",
];
const filtered = filterDeniedPaths(samplePaths);
assert.deepEqual(filtered.allowed, ["src/index.ts", ".env.example", "package-lock.json"]);
assert.equal(filtered.denied.length, 2);
assert.equal(filtered.denied[0].path, ".env");
assert.equal(filtered.denied[1].path, "config/secret.pem");

// 3. validateSymlink checks
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-test-"));
try {
  const insideFile = path.join(tempDir, "inside.txt");
  fs.writeFileSync(insideFile, "hello");
  const validSymlink = path.join(tempDir, "link-valid");
  fs.symlinkSync("inside.txt", validSymlink);

  const validResult = validateSymlink(validSymlink, tempDir);
  assert.equal(validResult.valid, true);

  const outsideFile = path.join(os.tmpdir(), "outside.txt");
  fs.writeFileSync(outsideFile, "secret");
  const escapeSymlink = path.join(tempDir, "link-escape");
  fs.symlinkSync(outsideFile, escapeSymlink);

  const escapeResult = validateSymlink(escapeSymlink, tempDir);
  assert.equal(escapeResult.valid, false);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// 4. auditWorkspaceSecrets checks
const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
try {
  fs.writeFileSync(path.join(auditDir, "clean.js"), "console.log('hi');");
  fs.writeFileSync(path.join(auditDir, ".env.example"), "KEY=VALUE");
  const cleanAudit = auditWorkspaceSecrets(auditDir);
  assert.equal(cleanAudit.clean, true);
  assert.equal(cleanAudit.violations.length, 0);

  fs.writeFileSync(path.join(auditDir, ".env.production"), "SECRET=123");
  const dirtyAudit = auditWorkspaceSecrets(auditDir);
  assert.equal(dirtyAudit.clean, false);
  assert.equal(dirtyAudit.violations.length, 1);
  assert.equal(dirtyAudit.violations[0].path, ".env.production");
} finally {
  fs.rmSync(auditDir, { recursive: true, force: true });
}

// 5. assertVerificationScriptsUnmodified checks
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-test-"));
try {
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    scripts: {
      typecheck: "tsc -b",
      build: "vite build",
    },
  }));

  const frozen = { typecheck: "tsc -b", build: "vite build" };
  // Should pass when unchanged
  assert.doesNotThrow(() => assertVerificationScriptsUnmodified(repoDir, frozen));

  // Should throw when script command is modified
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    scripts: {
      typecheck: "echo bypassed",
      build: "vite build",
    },
  }));
  assert.throws(
    () => assertVerificationScriptsUnmodified(repoDir, frozen),
    /Verification script "typecheck" berubah setelah claim/
  );

  // Should throw when script is removed
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    scripts: {
      build: "vite build",
    },
  }));
  assert.throws(
    () => assertVerificationScriptsUnmodified(repoDir, frozen),
    /Verification script "typecheck" berubah setelah claim/
  );
} finally {
  fs.rmSync(repoDir, { recursive: true, force: true });
}

console.log("security.test.mjs: All tests passed!");
