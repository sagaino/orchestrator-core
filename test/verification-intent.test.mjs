import assert from "node:assert/strict";
import {
  extractVerificationIntent,
  resolveVerificationIntent,
  validateVerificationCoverage,
  normalizeCapability,
} from "../src/verification-intent.mjs";

console.log("Running verification-intent.test.mjs...");

// 1. Normalization
assert.equal(normalizeCapability("lint"), "LINT");
assert.equal(normalizeCapability("typecheck"), "TYPECHECK");
assert.equal(normalizeCapability("playwright"), "E2E");
assert.equal(normalizeCapability("custom-check"), "CUSTOM_APPROVED");

// 2. Extraction from request with available scripts
const projectContexts = [{
  projectId: "frontend-app",
  availableScripts: ["typecheck", "lint", "build", "test:e2e"],
}];

const intent = extractVerificationIntent({
  request: "Tolong tambahkan fitur login dan jalankan typecheck, lint, serta build.",
  projectContexts,
});

assert.equal(intent.contractVersion, 1);
assert.equal(intent.status, "RESOLVED");
assert.equal(intent.required.length, 3);
assert.equal(intent.resolved.length, 3);
assert.equal(intent.missing.length, 0);

// 3. Extraction when requested check is missing
const missingIntent = extractVerificationIntent({
  request: "Tolong perbaiki routing dan jalankan e2e test",
  projectContexts: [{
    projectId: "frontend-app",
    availableScripts: ["typecheck", "build"],
  }],
});

assert.equal(missingIntent.status, "NEEDS_CLARIFICATION");
assert.equal(missingIntent.missing.length, 1);
assert.equal(missingIntent.missing[0].capability, "E2E");
assert.equal(missingIntent.missing[0].reason, "NO_APPROVED_SCRIPT");

// 4. Coverage validation - PASS
const planNodes = [{
  nodeId: "N1",
  projectId: "frontend-app",
  verification: ["typecheck", "lint", "build"],
}];

const validCoverage = validateVerificationCoverage({
  intent,
  planNodes,
});

assert.equal(validCoverage.valid, true);
assert.equal(validCoverage.missingCoverage.length, 0);

// 5. Coverage validation - FAIL when provider omits required check
const incompleteNodes = [{
  nodeId: "N1",
  projectId: "frontend-app",
  verification: ["typecheck", "build"], // omitted lint
}];

const invalidCoverage = validateVerificationCoverage({
  intent,
  planNodes: incompleteNodes,
});

assert.equal(invalidCoverage.valid, false);
assert.equal(invalidCoverage.code, "PLAN_VERIFICATION_COVERAGE_MISSING");
assert.equal(invalidCoverage.missingCoverage.length, 1);
assert.equal(invalidCoverage.missingCoverage[0].capability, "LINT");
assert.match(invalidCoverage.error, /lint/i);

console.log("verification-intent.test.mjs: All verification intent tests passed!");
