import assert from "node:assert/strict";
import { createPlanningQualityFixture, assertNoLeakageToRealRepositories } from "./helpers/planning-quality-fixture.mjs";

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

  console.log("planning-quality-regressions.test.mjs: All fixture guard tests passed!");
} finally {
  fixture.cleanup();
}
