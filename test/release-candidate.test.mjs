import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReleaseCandidate,
  verifyReleaseCandidate,
} from "../src/release-candidate.mjs";

console.log("Running release-candidate.test.mjs...");

const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p61-source-"));
const outputParent = fs.mkdtempSync(path.join(os.tmpdir(), "p61-output-"));
const outputRoot = path.join(outputParent, "candidate");
try {
  fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "schemas"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "templates"), { recursive: true });
  for (const file of ["start.sh", "stop.sh", "README.md", "PHASE_6_RELEASE_CONTRACT.md"]) fs.writeFileSync(path.join(sourceRoot, file), `fixture:${file}\n`);
  fs.writeFileSync(path.join(sourceRoot, "src", "index.mjs"), "export const stable = true;\n");
  fs.writeFileSync(path.join(sourceRoot, "schemas", "fixture.json"), "{}\n");
  fs.writeFileSync(path.join(sourceRoot, "templates", "manifest.json"), "{}\n");
  fs.writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }));
  fs.writeFileSync(path.join(sourceRoot, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3 }));

  const built = buildReleaseCandidate({
    sourceRoot,
    outputRoot,
    releaseId: "candidate-fixture",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    regressionResult: { status: "PASS", command: "fixture test", exitCode: 0, outputSha256: "fixture" },
    now: new Date("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(built.valid, true);
  assert.equal(fs.existsSync(path.join(outputRoot, "candidate-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(outputRoot, "checksums.sha256")), true);
  assert.match(fs.readFileSync(path.join(sourceRoot, "src", "index.mjs"), "utf8"), /stable/);
  assert.equal(verifyReleaseCandidate(outputRoot).valid, true);

  fs.writeFileSync(path.join(outputRoot, "src", "index.mjs"), "export const stable = false;\n");
  assert.throws(() => verifyReleaseCandidate(outputRoot), /checksum mismatch/);
  fs.writeFileSync(path.join(outputRoot, "src", "index.mjs"), "export const stable = true;\n");
  assert.equal(verifyReleaseCandidate(outputRoot).valid, true);

  assert.throws(() => buildReleaseCandidate({
    sourceRoot,
    outputRoot: path.join(outputParent, "failed"),
    releaseId: "candidate-fail",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    regressionResult: { status: "FAIL", command: "fixture test", exitCode: 1 },
  }), /requires a PASS regression/);
  assert.equal(fs.existsSync(path.join(outputParent, "failed")), false);
  assert.throws(() => buildReleaseCandidate({
    sourceRoot,
    outputRoot: path.join(sourceRoot, "candidate-inside-source"),
    releaseId: "candidate-unsafe",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    regressionResult: { status: "PASS", command: "fixture test", exitCode: 0 },
  }), /separate directory/);
} finally {
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  fs.rmSync(outputParent, { recursive: true, force: true });
}

console.log("release-candidate.test.mjs: All tests passed!");
