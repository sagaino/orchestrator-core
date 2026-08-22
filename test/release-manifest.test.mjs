import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReleaseManifest, verifyReleaseManifest, verifyReleaseManifestFile, writeReleaseManifest } from "../src/release-manifest.mjs";

console.log("Running release-manifest.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-release-manifest-"));
const sourceRoot = path.join(root, "source");
const dashboardRoot = path.join(root, "dashboard");
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const backupRoot = path.join(root, "external-backups");

try {
  for (const directory of [sourceRoot, dashboardRoot, vaultRoot, runsRoot, backupRoot]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "start.sh"), "#!/usr/bin/env bash\n");
  for (const directory of [sourceRoot, dashboardRoot]) {
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: path.basename(directory), version: "1.0.0" }));
    fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: directory });
  }
  const manifest = createReleaseManifest({ sourceRoot, dashboardRoot, vaultRoot, runsRoot, backupRoot, sourceCommit: "abc123", now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(manifest.releaseVersion, "1.0.0");
  assert.equal(manifest.paths.backupRoot, path.resolve(backupRoot));
  assert.equal(manifest.uninstall.preservesDataByDefault, true);
  assert.equal(verifyReleaseManifest({ manifest }).valid, true);

  const written = writeReleaseManifest({ runsRoot, sourceRoot, dashboardRoot, vaultRoot, backupRoot });
  assert.equal(fs.existsSync(written.manifestPath), true);
  assert.equal(fs.existsSync(written.manifestPath + ".sha256"), true);
  assert.equal(verifyReleaseManifestFile({ manifestPath: written.manifestPath }).valid, true);

  fs.appendFileSync(path.join(dashboardRoot, "package-lock.json"), "tampered");
  const lockFailure = verifyReleaseManifestFile({ manifestPath: written.manifestPath });
  assert.equal(lockFailure.valid, false);
  assert.ok(lockFailure.errors.includes("dashboard lockfile checksum berubah"));
  assert.throws(() => createReleaseManifest({ sourceRoot, dashboardRoot, vaultRoot, runsRoot, backupRoot: path.join(vaultRoot, "backups") }), /di luar Vault/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("release-manifest.test.mjs passed");
