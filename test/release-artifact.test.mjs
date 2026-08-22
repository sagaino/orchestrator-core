import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildReleaseArtifact, verifyReleaseArtifact } from "../src/release-artifact.mjs";

console.log("Running release-artifact.test.mjs...");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-release-artifact-"));
try {
  const roots = [path.join(root, "backend"), path.join(root, "dashboard")];
  for (const componentRoot of roots) {
    fs.mkdirSync(componentRoot, { recursive: true });
    fs.writeFileSync(path.join(componentRoot, "package.json"), JSON.stringify({ name: path.basename(componentRoot), version: "1.0.0" }));
    fs.writeFileSync(path.join(componentRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    execFileSync("git", ["init", "-q"], { cwd: componentRoot });
    execFileSync("git", ["add", "."], { cwd: componentRoot });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: componentRoot });
  }
  const artifact = buildReleaseArtifact({ repoRoot: roots[0], dashboardRoot: roots[1], outputRoot: path.join(root, "output"), now: new Date("2026-08-22T00:00:00.000Z") });
  assert.equal(artifact.components.length, 2);
  assert.equal(verifyReleaseArtifact({ manifestPath: artifact.manifestPath }).valid, true);
  fs.appendFileSync(path.join(path.dirname(artifact.manifestPath), artifact.components[0].fileName), "tamper");
  assert.equal(verifyReleaseArtifact({ manifestPath: artifact.manifestPath }).valid, false);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("release-artifact.test.mjs passed");
