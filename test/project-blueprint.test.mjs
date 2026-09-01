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

// 3. Deterministic repository detection matrix
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blueprint-test-"));
try {
  const feFullDir = path.join(tmpDir, "fe-full");
  const feViteOnlyDir = path.join(tmpDir, "fe-vite-only");
  const feReactTsDir = path.join(tmpDir, "fe-react-ts");
  const beDir = path.join(tmpDir, "be");
  const mixedDir = path.join(tmpDir, "mixed");
  const nodeDir = path.join(tmpDir, "node-express");
  const emptyDir = path.join(tmpDir, "empty");

  fs.mkdirSync(feFullDir);
  fs.mkdirSync(feViteOnlyDir);
  fs.mkdirSync(feReactTsDir);
  fs.mkdirSync(beDir);
  fs.mkdirSync(mixedDir);
  fs.mkdirSync(nodeDir);
  fs.mkdirSync(emptyDir);

  // Full frontend-vite: Vite + React + TS
  fs.writeFileSync(path.join(feFullDir, "package.json"), JSON.stringify({
    devDependencies: { vite: "^5.0.0", typescript: "^5.0.0" },
    dependencies: { react: "^18.0.0" },
  }));

  // Vite only without React/TS -> UNRESOLVED
  fs.writeFileSync(path.join(feViteOnlyDir, "package.json"), JSON.stringify({
    devDependencies: { vite: "^5.0.0" },
  }));

  // React + TS without Vite -> UNRESOLVED
  fs.writeFileSync(path.join(feReactTsDir, "package.json"), JSON.stringify({
    devDependencies: { typescript: "^5.0.0" },
    dependencies: { react: "^18.0.0" },
  }));

  // Backend Go
  fs.writeFileSync(path.join(beDir, "go.mod"), "module example.com/be\ngo 1.22\n");

  // Mixed Go + package.json without explicit metadata -> UNRESOLVED
  fs.writeFileSync(path.join(mixedDir, "go.mod"), "module example.com/mixed\ngo 1.22\n");
  fs.writeFileSync(path.join(mixedDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" } }));

  // Node express only -> UNRESOLVED
  fs.writeFileSync(path.join(nodeDir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" } }));

  // Detection tests
  const detectedFe = resolveProjectBlueprint({ repositoryPath: feFullDir });
  assert.equal(detectedFe.valid, true);
  assert.equal(detectedFe.id, "frontend-vite");
  assert.equal(detectedFe.source, "DETECTED");

  const detectedViteOnly = resolveProjectBlueprint({ repositoryPath: feViteOnlyDir });
  assert.equal(detectedViteOnly.valid, false);
  assert.equal(detectedViteOnly.id, "UNRESOLVED");

  const detectedReactTs = resolveProjectBlueprint({ repositoryPath: feReactTsDir });
  assert.equal(detectedReactTs.valid, false);
  assert.equal(detectedReactTs.id, "UNRESOLVED");

  const detectedBe = resolveProjectBlueprint({ repositoryPath: beDir });
  assert.equal(detectedBe.valid, true);
  assert.equal(detectedBe.id, "backend-golang");
  assert.equal(detectedBe.source, "DETECTED");

  const detectedMixed = resolveProjectBlueprint({ repositoryPath: mixedDir });
  assert.equal(detectedMixed.valid, false);
  assert.equal(detectedMixed.id, "UNRESOLVED");

  const detectedNode = resolveProjectBlueprint({ repositoryPath: nodeDir });
  assert.equal(detectedNode.valid, false);
  assert.equal(detectedNode.id, "UNRESOLVED");

  const detectedEmpty = resolveProjectBlueprint({ repositoryPath: emptyDir });
  assert.equal(detectedEmpty.valid, false);
  assert.equal(detectedEmpty.id, "UNRESOLVED");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("project-blueprint.test.mjs: All project blueprint tests passed!");
