import { parseEslintJsonOutput, computeFindingsFingerprint } from "./verification-adapters/eslint.mjs";

export const FINDING_MODES = Object.freeze({
  STRICT: "STRICT",
  NO_NEW_FINDINGS: "NO_NEW_FINDINGS",
});

function findingKey(finding) {
  return `${finding.file}::${finding.ruleId}::${finding.message}`;
}

export function parseFindingsForAdapter({ adapter = "eslint", output = "", repositoryRoot = "" }) {
  if (adapter === "eslint") {
    return parseEslintJsonOutput(output, repositoryRoot);
  }
  return [];
}

export function compareVerificationFindings({
  script = "lint",
  mode = "STRICT",
  baseline = null,
  candidate = null,
  adapter = "eslint",
} = {}) {
  // 1. Strict mode
  if (mode === "STRICT") {
    const exitCode = candidate?.exitCode ?? (candidate?.status === "PASS" ? 0 : 1);
    return {
      script,
      mode: "STRICT",
      status: exitCode === 0 ? "PASS" : "FAIL",
      delta: { new: 0, resolved: 0, unchanged: 0 },
      baseline: null,
      candidate: { exitCode },
    };
  }

  // 2. NO_NEW_FINDINGS mode
  if (!baseline) {
    return {
      script,
      mode: "NO_NEW_FINDINGS",
      status: "BASELINE_UNAVAILABLE",
      error: "Baseline verification data tidak tersedia untuk mode NO_NEW_FINDINGS.",
      delta: { new: 0, resolved: 0, unchanged: 0 },
    };
  }

  const baselineFindings = Array.isArray(baseline.findings) ? baseline.findings : [];
  const candidateFindings = Array.isArray(candidate?.findings) ? candidate.findings : [];

  const baselineMap = new Map(baselineFindings.map((f) => [findingKey(f), f]));
  const candidateMap = new Map(candidateFindings.map((f) => [findingKey(f), f]));

  const newFindings = [];
  const unchangedFindings = [];
  const resolvedFindings = [];

  for (const [key, finding] of candidateMap.entries()) {
    if (baselineMap.has(key)) {
      unchangedFindings.push(finding);
    } else {
      newFindings.push(finding);
    }
  }

  for (const [key, finding] of baselineMap.entries()) {
    if (!candidateMap.has(key)) {
      resolvedFindings.push(finding);
    }
  }

  let status = "FAIL_REGRESSION";
  if (newFindings.length === 0) {
    if (resolvedFindings.length > 0) {
      status = "PASS_IMPROVED";
    } else {
      status = "PASS_NO_REGRESSION";
    }
  }

  return {
    script,
    mode: "NO_NEW_FINDINGS",
    adapter,
    baseline: {
      commit: baseline.commit || null,
      exitCode: baseline.exitCode ?? 1,
      errorCount: baselineFindings.filter((f) => f.severity === "ERROR").length,
      warningCount: baselineFindings.filter((f) => f.severity === "WARNING").length,
      findingsFingerprint: baseline.findingsFingerprint || computeFindingsFingerprint(baselineFindings),
    },
    candidate: {
      exitCode: candidate?.exitCode ?? (newFindings.length > 0 ? 1 : 0),
      errorCount: candidateFindings.filter((f) => f.severity === "ERROR").length,
      warningCount: candidateFindings.filter((f) => f.severity === "WARNING").length,
      findingsFingerprint: candidate?.findingsFingerprint || computeFindingsFingerprint(candidateFindings),
    },
    delta: {
      new: newFindings.length,
      resolved: resolvedFindings.length,
      unchanged: unchangedFindings.length,
    },
    newFindings,
    resolvedFindings,
    status,
  };
}
