import assert from "node:assert/strict";
import { compareVerificationFindings } from "../src/verification-baseline.mjs";
import { computeFindingsFingerprint, parseEslintTextOutput } from "../src/verification-adapters/eslint.mjs";

console.log("Running verification-baseline.test.mjs...");

// 1. Strict mode tests
const strictPass = compareVerificationFindings({
  script: "typecheck",
  mode: "STRICT",
  candidate: { exitCode: 0 },
});
assert.equal(strictPass.status, "PASS");

const strictFail = compareVerificationFindings({
  script: "typecheck",
  mode: "STRICT",
  candidate: { exitCode: 1 },
});
assert.equal(strictFail.status, "FAIL");

// 2. NO_NEW_FINDINGS - 35 baseline findings matching 35 candidate findings exactly
const base35 = Array.from({ length: 35 }, (_, i) => ({
  file: `src/file_${i}.ts`,
  ruleId: "@typescript-eslint/no-explicit-any",
  severity: "ERROR",
  line: 10 + i,
  column: 5,
  message: `Unexpected any in file ${i}`,
}));

const candidate35Same = [...base35];

const resultSame = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "commit-base", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: candidate35Same },
});

assert.equal(resultSame.status, "PASS_NO_REGRESSION");
assert.equal(resultSame.delta.new, 0);
assert.equal(resultSame.delta.resolved, 0);
assert.equal(resultSame.delta.unchanged, 35);

// 3. NO_NEW_FINDINGS - 35 to 34 with 1 resolved and 0 new (IMPROVED)
const candidate34 = base35.slice(0, 34);
const resultImproved = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "commit-base", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: candidate34 },
});

assert.equal(resultImproved.status, "PASS_IMPROVED");
assert.equal(resultImproved.delta.new, 0);
assert.equal(resultImproved.delta.resolved, 1);
assert.equal(resultImproved.delta.unchanged, 34);

// 4. NO_NEW_FINDINGS - 35 to 36 with 1 new finding (REGRESSION FAIL)
const candidate36 = [
  ...base35,
  {
    file: "src/new_file.ts",
    ruleId: "no-unused-vars",
    severity: "ERROR",
    line: 1,
    column: 1,
    message: "New variable is defined but never used",
  },
];

const resultRegression = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "commit-base", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: candidate36 },
});

assert.equal(resultRegression.status, "FAIL_REGRESSION");
assert.equal(resultRegression.delta.new, 1);
assert.equal(resultRegression.delta.unchanged, 35);

// 5. NO_NEW_FINDINGS - 35 to 35 with 1 fixed but 1 new (REGRESSION FAIL)
const candidate35Replaced = [
  ...base35.slice(0, 34),
  {
    file: "src/replaced.ts",
    ruleId: "no-console",
    severity: "ERROR",
    line: 20,
    column: 1,
    message: "Unexpected console statement",
  },
];

const resultReplaced = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "commit-base", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: candidate35Replaced },
});

assert.equal(resultReplaced.status, "FAIL_REGRESSION");
assert.equal(resultReplaced.delta.new, 1);
assert.equal(resultReplaced.delta.resolved, 1);
assert.equal(resultReplaced.delta.unchanged, 34);

// 6. Baseline unavailable
const resultUnavailable = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: null,
  candidate: { exitCode: 1, findings: [] },
});
assert.equal(resultUnavailable.status, "BASELINE_UNAVAILABLE");

// 8. Parser Contract & Fail-Closed Negative Tests
import { parseFindingsForAdapter } from "../src/verification-baseline.mjs";

// Malformed JSON with exit code 1 -> UNPARSEABLE and comparator UNCOMPARABLE
const malformedParsed = parseFindingsForAdapter({ adapter: "eslint", output: "SyntaxError: Unexpected token", exitCode: 1 });
assert.equal(malformedParsed.status, "UNPARSEABLE");
const compMalformed = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "base-1", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: malformedParsed.findings, parseResult: malformedParsed },
});
assert.equal(compMalformed.status, "UNCOMPARABLE");

// Truncated JSON -> UNPARSEABLE and comparator UNCOMPARABLE
const truncatedParsed = parseFindingsForAdapter({ adapter: "eslint", output: '[{"filePath":"src/app.ts"', exitCode: 1 });
assert.equal(truncatedParsed.status, "UNPARSEABLE");
const compTruncated = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "base-1", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: truncatedParsed.findings, parseResult: truncatedParsed },
});
assert.equal(compTruncated.status, "UNCOMPARABLE");

// Unsupported adapter -> ADAPTER_UNAVAILABLE
const unsupportedParsed = parseFindingsForAdapter({ adapter: "unknown-tool", output: "output", exitCode: 1 });
assert.equal(unsupportedParsed.status, "UNSUPPORTED");
const compUnsupported = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  adapter: "unknown-tool",
  baseline: { commit: "base-1", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: [] },
});
assert.equal(compUnsupported.status, "ADAPTER_UNAVAILABLE");

// Empty output with non-zero exit -> UNPARSEABLE and UNCOMPARABLE
const emptyNonZero = parseFindingsForAdapter({ adapter: "eslint", output: "", exitCode: 1 });
assert.equal(emptyNonZero.status, "UNPARSEABLE");
const compEmptyNonZero = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "base-1", exitCode: 1, findings: base35 },
  candidate: { exitCode: 1, findings: emptyNonZero.findings, parseResult: emptyNonZero },
});
assert.equal(compEmptyNonZero.status, "UNCOMPARABLE");

// Empty output with exit zero is still not machine-readable evidence.
const emptyZero = parseFindingsForAdapter({ adapter: "eslint", output: "", exitCode: 0 });
assert.equal(emptyZero.status, "UNPARSEABLE");
const compEmptyZero = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "base-1", exitCode: 1, findings: base35 },
  candidate: { exitCode: 0, findings: emptyZero.findings, parseResult: emptyZero },
});
assert.equal(compEmptyZero.status, "UNCOMPARABLE");

// Valid [] with approved formatter -> PARSED with zero findings
const validEmpty = parseFindingsForAdapter({ adapter: "eslint", output: "[]", exitCode: 0 });
assert.equal(validEmpty.status, "PARSED");
assert.equal(validEmpty.findings.length, 0);

const unexpectedSuccess = parseFindingsForAdapter({ adapter: "eslint", output: "Everything looks wonderful today", exitCode: 0 });
assert.equal(unexpectedSuccess.status, "UNPARSEABLE");
const compUnexpectedSuccess = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "base-1", exitCode: 1, findings: base35 },
  candidate: { exitCode: 0, findings: unexpectedSuccess.findings, parseResult: unexpectedSuccess },
});
assert.equal(compUnexpectedSuccess.status, "UNCOMPARABLE");

// Baseline parse failure -> BASELINE_UNAVAILABLE
const compBaselineParseFail = compareVerificationFindings({
  script: "lint",
  mode: "NO_NEW_FINDINGS",
  baseline: { commit: "base-1", exitCode: 1, status: "UNPARSEABLE", findings: [] },
  candidate: { exitCode: 0, findings: [] },
});
assert.equal(compBaselineParseFail.status, "BASELINE_UNAVAILABLE");

console.log("verification-baseline.test.mjs: All verification baseline tests passed!");
