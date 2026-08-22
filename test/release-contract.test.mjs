import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  RELEASE_COMPATIBILITY_MATRIX,
  RELEASE_CONTRACT_VERSION,
  assessReleaseCompatibility,
  createReleaseManifest,
  validateReleaseManifest,
} from "../src/release-contract.mjs";

console.log("Running release-contract.test.mjs...");

const fixtureRoot = path.resolve("test/fixtures/release-compatibility");
const valid = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "manifest-valid.json"), "utf8"));
const selfAccept = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "manifest-self-accept.json"), "utf8"));
const matrixFixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "compatibility-matrix.json"), "utf8"));

assert.equal(validateReleaseManifest(valid).valid, true);
assert.deepEqual(assessReleaseCompatibility(valid), {
  compatible: true,
  outcome: "ACTIVATION_ELIGIBLE",
  errors: [],
  contractVersion: RELEASE_CONTRACT_VERSION,
  activationPolicy: valid.activation,
});
assert.equal(validateReleaseManifest(selfAccept).valid, false);
assert.match(validateReleaseManifest(selfAccept).errors.join(" "), /external|Human gate|Self-accept|In-process/);

const generated = createReleaseManifest({ releaseId: "candidate-generated", runtimeVersion: "0.1.0" });
assert.equal(validateReleaseManifest(generated).valid, true);
assert.equal(generated.activation.selfAcceptAllowed, false);
assert.equal(assessReleaseCompatibility({ ...valid, api: { compatibilityVersion: "2.0" } }).outcome, "REJECT_BEFORE_ACTIVATION");

assert.deepEqual(matrixFixture.cases.map((item) => item.id), RELEASE_COMPATIBILITY_MATRIX.map((item) => item.id));
assert.deepEqual(matrixFixture.cases.map((item) => item.outcome), RELEASE_COMPATIBILITY_MATRIX.map((item) => item.outcome));

console.log("release-contract.test.mjs: All tests passed!");
