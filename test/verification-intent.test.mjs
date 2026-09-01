import assert from "node:assert/strict";
import {
  extractVerificationIntent,
  resolveVerificationIntent,
  validateVerificationCoverage,
  normalizeCapability,
  resolveVerificationDecision,
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

assert.equal(intent.contractVersion, 2);
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

const duplicateResolutionCoverage = validateVerificationCoverage({
  intent: {
    contractVersion: 2,
    required: [{ projectId: "frontend-app", capability: "BUILD" }],
    resolved: [{ projectId: "frontend-app", capability: "BUILD", script: "build" }],
    waived: [{ projectId: "frontend-app", capability: "BUILD", reason: "duplicate", waivedBy: "operator", waivedAt: "2026-09-01T00:00:00.000Z" }],
    missing: [],
    status: "RESOLVED_WITH_WAIVERS",
  },
  planNodes,
});
assert.equal(duplicateResolutionCoverage.valid, false);
assert.equal(duplicateResolutionCoverage.code, "VERIFICATION_REQUIREMENT_UNACCOUNTED");

const runnerCoverage = validateVerificationCoverage({
  intent: {
    contractVersion: 2,
    required: [{ projectId: "frontend-app", capability: "E2E" }],
    resolved: [{ projectId: "frontend-app", capability: "E2E", runner: "browser-route-check" }],
    waived: [],
    missing: [],
    status: "RESOLVED",
  },
  planNodes,
  integrationVerification: ["frontend-app:browser-route-check"],
});
assert.equal(runnerCoverage.valid, true);
// 6. Fail-closed tests for missing or unresolved intent
const missingIntentCoverage = validateVerificationCoverage({
  intent: null,
  planNodes,
});
assert.equal(missingIntentCoverage.valid, false);
assert.equal(missingIntentCoverage.code, "VERIFICATION_INTENT_MISSING");

const unresolvedCoverage = validateVerificationCoverage({
  intent: missingIntent,
  planNodes,
});
assert.equal(unresolvedCoverage.valid, false);
assert.equal(unresolvedCoverage.code, "VERIFICATION_INTENT_UNRESOLVED");

// 7. Explicitly empty intent -> valid
const emptyIntent = {
  contractVersion: 1,
  required: [],
  resolved: [],
  missing: [],
  status: "RESOLVED",
};
const emptyCoverage = validateVerificationCoverage({
  intent: emptyIntent,
  planNodes: [],
});
assert.equal(emptyCoverage.valid, true);

// 8. Structured Decisions tests
const unresolvedIntent = extractVerificationIntent({
  request: "Tolong jalankan e2e",
  projectContexts: [{ projectId: "frontend-app", availableScripts: ["typecheck", "build"] }],
});
assert.equal(unresolvedIntent.status, "NEEDS_CLARIFICATION");

// Test SELECT_SCRIPT action
const scriptResolved = resolveVerificationDecision({
  intent: unresolvedIntent,
  projectContexts: [{ projectId: "frontend-app", availableScripts: ["test:e2e-custom"] }],
  decision: {
    action: "SELECT_SCRIPT",
    projectId: "frontend-app",
    capability: "E2E",
    selectedTarget: "test:e2e-custom",
    resolvedBy: "local:test-operator",
  },
});
assert.equal(scriptResolved.status, "RESOLVED");
assert.equal(scriptResolved.contractVersion, 2);
assert.equal(scriptResolved.resolved.length, 1);
assert.equal(scriptResolved.resolved[0].script, "test:e2e-custom");
assert.equal(scriptResolved.missing.length, 0);

assert.throws(() => resolveVerificationDecision({
  intent: unresolvedIntent,
  projectContexts: [{ projectId: "frontend-app", availableScripts: ["typecheck", "test:e2e"] }],
  decision: {
    action: "SELECT_SCRIPT",
    projectId: "frontend-app",
    capability: "E2E",
    selectedTarget: "typecheck",
    resolvedBy: "local:test-operator",
  },
}), /tidak cocok dengan capability E2E/);

assert.throws(() => resolveVerificationDecision({
  intent: unresolvedIntent,
  projectContexts: [{ projectId: "frontend-app", availableScripts: ["typecheck"] }],
  decision: {
    action: "SELECT_SCRIPT",
    projectId: "frontend-app",
    capability: "E2E",
    selectedTarget: "test:e2e",
    resolvedBy: "local:test-operator",
  },
}), /tidak terdaftar/);

// Test WAIVE action
const waivedResult = resolveVerificationDecision({
  intent: unresolvedIntent,
  decision: {
    action: "WAIVE",
    projectId: "frontend-app",
    capability: "E2E",
    reason: "E2E suite is temporarily maintained in external pipeline",
    resolvedBy: "local:lead-architect",
  },
});
assert.equal(waivedResult.status, "RESOLVED_WITH_WAIVERS");
assert.equal(waivedResult.waived.length, 1);
assert.equal(waivedResult.waived[0].reason, "E2E suite is temporarily maintained in external pipeline");
assert.equal(waivedResult.waived[0].waivedBy, "local:lead-architect");

// Test operator requirement
assert.throws(() => {
  resolveVerificationDecision({
    intent: unresolvedIntent,
    decision: {
      action: "WAIVE",
      projectId: "frontend-app",
      capability: "E2E",
      reason: "Waiving without operator",
    },
  });
}, /Operator identity/);

const runnerResolved = resolveVerificationIntent({
  intent: { contractVersion: 2, required: [{ projectId: "frontend-app", capability: "E2E" }], resolved: [], waived: [], missing: [] },
  projectContexts: [{ projectId: "frontend-app", verificationScripts: [] }],
  registeredRunners: [{ id: "browser-route-check", projectId: "frontend-app", capabilities: ["E2E"] }],
});
assert.equal(runnerResolved.status, "RESOLVED");
assert.equal(runnerResolved.resolved[0].runner, "browser-route-check");

console.log("verification-intent.test.mjs: All verification intent and decision tests passed!");
