import crypto from "node:crypto";
import { parseEslintOutput, computeFindingsFingerprint } from "./verification-adapters/eslint.mjs";

export const FINDING_MODES = Object.freeze({
  STRICT: "STRICT",
  NO_NEW_FINDINGS: "NO_NEW_FINDINGS",
});

export const SUPPORTED_ADAPTERS = Object.freeze(["eslint"]);

function findingKey(finding) {
  return `${finding.file}::${finding.ruleId}::${finding.message}`;
}

export function parseFindingsForAdapter({
  adapter = "eslint",
  output = "",
  repositoryRoot = "",
  exitCode = 0,
} = {}) {
  if (adapter === "eslint") {
    return parseEslintOutput({ output, repositoryRoot, exitCode });
  }
  return {
    adapter,
    status: "UNSUPPORTED",
    format: "NONE",
    findings: [],
    rawFingerprint: crypto.createHash("sha256").update(String(output ?? "")).digest("hex"),
    reason: `Unsupported adapter: ${adapter}`,
  };
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
  if (!SUPPORTED_ADAPTERS.includes(adapter)) {
    return {
      script,
      mode: "NO_NEW_FINDINGS",
      adapter,
      status: "ADAPTER_UNAVAILABLE",
      error: `Adapter tidak didukung: ${adapter}`,
      delta: { new: 0, resolved: 0, unchanged: 0 },
    };
  }

  if (!baseline) {
    return {
      script,
      mode: "NO_NEW_FINDINGS",
      adapter,
      status: "BASELINE_UNAVAILABLE",
      error: "Baseline verification data tidak tersedia untuk mode NO_NEW_FINDINGS.",
      delta: { new: 0, resolved: 0, unchanged: 0 },
    };
  }

  // Check baseline parse validity
  if (baseline.parseResult?.status === "UNPARSEABLE" || baseline.status === "UNPARSEABLE") {
    return {
      script,
      mode: "NO_NEW_FINDINGS",
      adapter,
      status: "BASELINE_UNAVAILABLE",
      error: "Baseline verification output gagal diparse.",
      delta: { new: 0, resolved: 0, unchanged: 0 },
    };
  }

  // Check candidate parse validity
  if (candidate?.parseResult?.status === "UNPARSEABLE" || candidate?.status === "UNPARSEABLE") {
    return {
      script,
      mode: "NO_NEW_FINDINGS",
      adapter,
      status: "UNCOMPARABLE",
      error: `Candidate verification output gagal diparse: ${candidate?.parseResult?.reason || candidate?.reason || "Unknown parse error"}`,
      delta: { new: 0, resolved: 0, unchanged: 0 },
    };
  }

  const baselineFindings = Array.isArray(baseline.findings) ? baseline.findings : (Array.isArray(baseline.parseResult?.findings) ? baseline.parseResult.findings : []);
  const candidateFindings = Array.isArray(candidate?.findings) ? candidate.findings : (Array.isArray(candidate?.parseResult?.findings) ? candidate.parseResult.findings : []);

  // Candidate exit code non-zero with 0 findings and unparsed format is uncomparable
  if (candidate?.exitCode !== 0 && candidateFindings.length === 0 && candidate?.parseResult?.format !== "ESLINT_JSON" && candidate?.parseResult?.format !== "ESLINT_STYLISH") {
    if (candidate?.parseResult?.status !== "PARSED") {
      return {
        script,
        mode: "NO_NEW_FINDINGS",
        adapter,
        status: "UNCOMPARABLE",
        error: "Candidate command gagal dengan exit code non-zero tanpa hasil parse yang valid.",
        delta: { new: 0, resolved: 0, unchanged: 0 },
      };
    }
  }

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
      rawFingerprint: baseline.parseResult?.rawFingerprint || null,
    },
    candidate: {
      commit: candidate?.commit || null,
      exitCode: candidate?.exitCode ?? (newFindings.length > 0 ? 1 : 0),
      errorCount: candidateFindings.filter((f) => f.severity === "ERROR").length,
      warningCount: candidateFindings.filter((f) => f.severity === "WARNING").length,
      findingsFingerprint: candidate?.findingsFingerprint || computeFindingsFingerprint(candidateFindings),
      rawFingerprint: candidate?.parseResult?.rawFingerprint || null,
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
