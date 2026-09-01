import crypto from "node:crypto";
import path from "node:path";

export function normalizeComparableFilePath(filePath, repositoryRoot) {
  if (!filePath) return "";
  let clean = String(filePath).trim().split(path.sep).join("/");
  if (repositoryRoot) {
    const cleanRoot = path.resolve(repositoryRoot).split(path.sep).join("/");
    if (clean.startsWith(cleanRoot)) {
      clean = clean.slice(cleanRoot.length).replace(/^\/+/, "");
    }
  }
  return clean.replace(/^\.\//, "");
}

export function computeRawOutputFingerprint(output = "") {
  return crypto.createHash("sha256").update(String(output ?? "")).digest("hex");
}

export function computeFindingsFingerprint(findings = []) {
  const sorted = [...findings].sort((a, b) => {
    const fileComp = String(a.file).localeCompare(String(b.file));
    if (fileComp !== 0) return fileComp;
    const ruleComp = String(a.ruleId).localeCompare(String(b.ruleId));
    if (ruleComp !== 0) return ruleComp;
    const lineComp = (a.line ?? 0) - (b.line ?? 0);
    if (lineComp !== 0) return lineComp;
    return String(a.message).localeCompare(String(b.message));
  });

  const serialized = JSON.stringify(sorted);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function parseEslintOutput({
  output = "",
  repositoryRoot = "",
  exitCode = 0,
  expectedFormat = "ESLINT_JSON",
} = {}) {
  const rawFingerprint = computeRawOutputFingerprint(output);
  const text = typeof output === "string" ? output.trim() : "";

  if (!text) {
    return {
      adapter: "eslint",
      status: "UNPARSEABLE",
      format: "NONE",
      findings: [],
      rawFingerprint,
      reason: `Empty output is not valid ${expectedFormat} evidence`,
    };
  }

  // 1. Attempt JSON parse
  try {
    const raw = JSON.parse(text);
    if (Array.isArray(raw)) {
      const findings = [];
      for (const fileReport of raw) {
        const filePath = normalizeComparableFilePath(fileReport.filePath, repositoryRoot);
        const messages = Array.isArray(fileReport.messages) ? fileReport.messages : [];
        for (const msg of messages) {
          findings.push({
            file: filePath,
            ruleId: msg.ruleId || "syntax-error",
            severity: msg.severity === 2 ? "ERROR" : "WARNING",
            line: typeof msg.line === "number" ? msg.line : null,
            column: typeof msg.column === "number" ? msg.column : null,
            message: String(msg.message || "").trim(),
          });
        }
      }
      return {
        adapter: "eslint",
        status: "PARSED",
        format: "ESLINT_JSON",
        findings,
        rawFingerprint,
        reason: null,
      };
    }
  } catch {
    // JSON parse failed. Check if stylish format is recognized.
  }

  // 2. Check stylish text output
  const stylishFindings = expectedFormat === "ESLINT_STYLISH" ? parseEslintStylishText(text, repositoryRoot) : [];
  if (stylishFindings.length > 0) {
    return {
      adapter: "eslint",
      status: "PARSED",
      format: "ESLINT_STYLISH",
      findings: stylishFindings,
      rawFingerprint,
      reason: null,
    };
  }

  // Any non-empty output that is neither valid ESLint JSON nor recognized
  // stylish output is unsafe to compare. A successful exit code is not proof
  // that an adapter produced the expected evidence contract.
  return {
    adapter: "eslint",
    status: "UNPARSEABLE",
    format: "NONE",
    findings: [],
    rawFingerprint,
    reason: `Malformed or unparseable ESLint output (expected ${expectedFormat})`,
  };
}

export function parseEslintStylishText(text, repositoryRoot = "") {
  if (!text || typeof text !== "string") return [];
  const lines = text.split("\n");
  const findings = [];
  let currentFile = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^[/\w.-]+\.[a-zA-Z0-9]+$/.test(trimmed) || (trimmed.startsWith("/") && trimmed.includes("."))) {
      currentFile = normalizeComparableFilePath(trimmed, repositoryRoot);
      continue;
    }

    const match = trimmed.match(/^(\d+):(\d+)\s+(error|warning)\s+(.*?)\s+([@\w\d_/-]+)$/i);
    if (match) {
      const [, lineNum, colNum, severity, message, ruleId] = match;
      findings.push({
        file: currentFile,
        ruleId: ruleId || "lint-rule",
        severity: severity.toUpperCase() === "ERROR" ? "ERROR" : "WARNING",
        line: Number(lineNum) || null,
        column: Number(colNum) || null,
        message: message.trim(),
      });
    }
  }

  return findings;
}

export function parseEslintJsonOutput(stdout, repositoryRoot = "") {
  const result = parseEslintOutput({ output: stdout, repositoryRoot });
  return result.findings;
}

export function parseEslintTextOutput(text, repositoryRoot = "") {
  return parseEslintStylishText(text, repositoryRoot);
}
