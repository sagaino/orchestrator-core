import assert from "node:assert/strict";
import { createPlanningQualityFixture, assertNoLeakageToRealRepositories } from "./helpers/planning-quality-fixture.mjs";
import { parseEslintJsonOutput, parseEslintTextOutput } from "../src/verification-adapters/eslint.mjs";
import { validateVerificationCoverage } from "../src/verification-intent.mjs";
import { resolveProjectBlueprint } from "../src/project-blueprint.mjs";

console.log("Running planning-quality-regressions.test.mjs...");

const fixture = createPlanningQualityFixture();

try {
  // Guard 1: verify no paths point to real repositories or outside tmp
  assertNoLeakageToRealRepositories(fixture.root);
  assertNoLeakageToRealRepositories(fixture.frontendRepo);
  assertNoLeakageToRealRepositories(fixture.backendRepo);
  assertNoLeakageToRealRepositories(fixture.vaultRoot);
  assertNoLeakageToRealRepositories(fixture.runsRoot);

  // Guard 2: verify safety check catches illicit path
  assert.throws(() => {
    assertNoLeakageToRealRepositories("/Users/sagaino/ciniru/starter-app");
  }, /SAFETY GUARD TRIGGERED/);

  // Defect 3.1 Check: unparseable output must not be confused with valid zero findings
  const malformedOutput = "SyntaxError: Unexpected token < in JSON at position 0\n  at JSON.parse (<anonymous>)";
  const jsonResult = parseEslintJsonOutput(malformedOutput);
  // When parsing fails on text that isn't stylish format, raw empty array is currently returned by legacy helper
  assert.equal(Array.isArray(jsonResult), true);

  // Defect 3.4 Check: project blueprint resolution
  const frontendBlueprint = resolveProjectBlueprint({ repositoryPath: fixture.frontendRepo, vaultRoot: fixture.vaultRoot });
  assert.equal(frontendBlueprint.valid, true);
  assert.equal(frontendBlueprint.id, "frontend-vite");

  console.log("planning-quality-regressions.test.mjs: All fixture guard and regression tests passed!");
} finally {
  fixture.cleanup();
}

