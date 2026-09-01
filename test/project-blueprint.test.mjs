import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectBlueprint, detectRepositoryBlueprint } from "../src/project-blueprint.mjs";

console.log("Running project-blueprint.test.mjs...");

// 1. Explicit project metadata
const explicitFrontend = resolveProjectBlueprint({
  projectMetadata: { blueprint: "frontend-vite" },
});
assert.equal(explicitFrontend.valid, true);
assert.equal(explicitFrontend.id, "frontend-vite");
assert.equal(explicitFrontend.source, "PROJECT_METADATA");

const explicitBackend = resolveProjectBlueprint({
  projectMetadata: { blueprint: "backend-golang" },
});
assert.equal(explicitBackend.valid, true);
assert.equal(explicitBackend.id, "backend-golang");

// 2. Unsupported blueprint
const unsupported = resolveProjectBlueprint({
  projectMetadata: { blueprint: "unknown-stack" },
});
assert.equal(unsupported.valid, false);
assert.match(unsupported.error, /tidak didukung/i);

// 3. Deterministic repository detection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-test-"));
try {
  const feDir = path.join(tmpDir, "fe");
  const beDir = path.join(tmpDir, "be");
  const ambDir = path.join(tmpDir, "ambiguous");
  fs.mkdirSync(feDir);
  fs.mkdirSync(beDir);
  fs.mkdirSync(ambDir);

  fs.writeFileSync(path.join(feDir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5.0.0" } }));
  fs.writeFileSync(path.join(beDir, "go.mod"), "module example.com/be\ngo 1.22\n");

  const detectedFe = resolveProjectBlueprint({ repositoryPath: feDir });
  assert.equal(detectedFe.valid, true);
  assert.equal(detectedFe.id, "frontend-vite");
  assert.equal(detectedFe.source, "DETECTED");

  const detectedBe = resolveProjectBlueprint({ repositoryPath: beDir });
  assert.equal(detectedBe.valid, true);
  assert.equal(detectedBe.id, "backend-golang");
  assert.equal(detectedBe.source, "DETECTED");

  const detectedAmb = resolveProjectBlueprint({ repositoryPath: ambDir });
  assert.equal(detectedAmb.valid, false);
  assert.equal(detectedAmb.id, "UNRESOLVED");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("project-blueprint.test.mjs: All project blueprint tests passed!");
