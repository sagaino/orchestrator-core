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
  normalizeSafeRelativePath,
  resolveContainedPath,
} from "../src/security.mjs";
import { assertVerificationScriptsUnmodified } from "../src/executor.mjs";
import { saveUploadedAsset, deleteUploadedAsset } from "../src/asset-manager.mjs";
import { apiTokenPath, ensureApiToken, rotateApiToken } from "../src/api/auth.mjs";
import { resolveTaskFile } from "../src/core.mjs";

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

// 6. Contained path checks
const containmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "containment-test-"));
const containmentOutside = fs.mkdtempSync(path.join(os.tmpdir(), "containment-outside-"));
try {
  fs.mkdirSync(path.join(containmentRoot, "safe"));
  assert.equal(normalizeSafeRelativePath("safe/file.png"), "safe/file.png");
  assert.throws(() => normalizeSafeRelativePath("../outside.png"), /root yang diizinkan/);
  assert.throws(() => normalizeSafeRelativePath("/tmp/outside.png"), /path relatif/);
  assert.throws(() => normalizeSafeRelativePath("C:\\outside.png"), /path relatif/);
  assert.equal(resolveContainedPath(containmentRoot, "safe/file.png"), path.join(fs.realpathSync(containmentRoot), "safe", "file.png"));

  fs.symlinkSync(containmentOutside, path.join(containmentRoot, "escape"));
  assert.throws(
    () => resolveContainedPath(containmentRoot, "escape/file.png"),
    /symlink di luar root/,
  );
} finally {
  fs.rmSync(containmentRoot, { recursive: true, force: true });
  fs.rmSync(containmentOutside, { recursive: true, force: true });
}

// 7. Asset upload and deletion stay inside authorized roots
const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asset-security-test-"));
try {
  const vault = path.join(assetRoot, "vault");
  const repository = path.join(assetRoot, "repository");
  fs.mkdirSync(vault);
  fs.mkdirSync(repository);
  const pngData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  const uploaded = await saveUploadedAsset({
    vaultRoot: vault,
    projectRepository: repository,
    type: "PROJECT_ASSET",
    fileName: "pixel.png",
    base64Data: pngData,
  });
  assert.equal(uploaded.relativeProjectPath.startsWith("src/assets/images/"), true);
  assert.equal(fs.existsSync(uploaded.absolutePath), true);
  assert.equal(path.relative(fs.realpathSync(repository), uploaded.absolutePath).startsWith(".."), false);

  await assert.rejects(
    saveUploadedAsset({
      vaultRoot: vault,
      projectRepository: repository,
      type: "PROJECT_ASSET",
      fileName: "escape.png",
      base64Data: pngData,
      targetSubDir: "../outside",
    }),
    /root yang diizinkan|path relatif/,
  );
  assert.equal(fs.existsSync(path.join(assetRoot, "outside", "escape.png")), false);

  await assert.rejects(
    saveUploadedAsset({
      vaultRoot: vault,
      projectRepository: repository,
      type: "PROJECT_ASSET",
      fileName: "payload.svg",
      base64Data: Buffer.from("<svg/>").toString("base64"),
    }),
    /Format asset tidak didukung/,
  );

  const deletion = await deleteUploadedAsset({
    vaultRoot: vault,
    projectRepository: repository,
    type: "PROJECT_ASSET",
    relativeProjectPath: uploaded.relativeProjectPath,
  });
  assert.equal(deletion.deleted, true);
  assert.equal(fs.existsSync(uploaded.absolutePath), false);
} finally {
  fs.rmSync(assetRoot, { recursive: true, force: true });
}

// 8. Runtime token rotation never exposes the token in its result
const tokenRuns = fs.mkdtempSync(path.join(os.tmpdir(), "token-security-test-"));
try {
  const first = ensureApiToken(tokenRuns);
  const rotation = rotateApiToken(tokenRuns);
  const second = ensureApiToken(tokenRuns);
  assert.notEqual(first, second);
  assert.equal(Object.hasOwn(rotation, "token"), false);
  assert.equal(rotation.restartRequired, true);
  assert.equal((fs.statSync(apiTokenPath(tokenRuns)).mode & 0o777), 0o600);
} finally {
  fs.rmSync(tokenRuns, { recursive: true, force: true });
}

// 9. Task resolution cannot read an arbitrary file outside the project task root
const taskVault = fs.mkdtempSync(path.join(os.tmpdir(), "task-path-test-"));
const externalTaskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "external-task-test-"));
try {
  const tasksRoot = path.join(taskVault, "02-Projects", "safe-project", "tasks");
  fs.mkdirSync(tasksRoot, { recursive: true });
  const validTask = path.join(tasksRoot, "task-001.md");
  const externalTask = path.join(externalTaskRoot, "outside.md");
  fs.writeFileSync(validTask, "---\ntask_id: SAFE-001\n---\n# Safe task\n");
  fs.writeFileSync(externalTask, "---\ntask_id: OUTSIDE-001\n---\n# Outside task\n");

  assert.equal(resolveTaskFile(taskVault, "safe-project", "task-001"), fs.realpathSync(validTask));
  assert.equal(
    resolveTaskFile(taskVault, "safe-project", "02-Projects/safe-project/tasks/task-001.md"),
    fs.realpathSync(validTask),
  );
  assert.throws(
    () => resolveTaskFile(taskVault, "safe-project", externalTask),
    /Task tidak ditemukan/,
  );
  fs.symlinkSync(externalTask, path.join(tasksRoot, "linked-outside.md"));
  assert.throws(
    () => resolveTaskFile(taskVault, "safe-project", "linked-outside.md"),
    /Task tidak ditemukan/,
  );
} finally {
  fs.rmSync(taskVault, { recursive: true, force: true });
  fs.rmSync(externalTaskRoot, { recursive: true, force: true });
}

console.log("security.test.mjs: All tests passed!");
