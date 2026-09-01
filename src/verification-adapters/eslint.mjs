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

export function parseEslintJsonOutput(stdout, repositoryRoot = "") {
  if (!stdout || typeof stdout !== "string") return [];
  try {
    const raw = JSON.parse(stdout.trim());
    if (!Array.isArray(raw)) return [];
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
    return findings;
  } catch {
    return parseEslintTextOutput(stdout, repositoryRoot);
  }
}

export function parseEslintTextOutput(text, repositoryRoot = "") {
  if (!text || typeof text !== "string") return [];
  const lines = text.split("\n");
  const findings = [];
  let currentFile = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // File header: e.g. /path/to/file.tsx or src/components/Button.tsx
    if (/^[/\w.-]+\.[a-zA-Z0-9]+$/.test(trimmed) || (trimmed.startsWith("/") && trimmed.includes("."))) {
      currentFile = normalizeComparableFilePath(trimmed, repositoryRoot);
      continue;
    }

    // Message line: e.g. "  12:5  error  'foo' is defined but never used  @typescript-eslint/no-unused-vars"
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
