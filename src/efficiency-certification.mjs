/**
 * P5.4: provider-free efficiency certification.
 *
 * This module deliberately consumes the frozen P5.0 fixture.  Gate evidence is
 * supplied by deterministic verification/safety/knowledge suites; no provider
 * or network access is possible from this module.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createBenchmarkFixture, createOptimizedBenchmarkFixture, runTokenBenchmark, TOKEN_BENCHMARK_VERSION } from "./token-benchmark.mjs";

export const EFFICIENCY_CERTIFICATION_VERSION = "p5.4-2026-08-22";
export const DEFAULT_BASELINE_PATH = path.resolve("runs/runtime/token-benchmarks/p5.0-2026-08-22.json");
export const DEFAULT_REPORT_PATH = path.resolve("runs/runtime/token-benchmarks/p5.4-2026-08-22.json");
export const TARGET_MEDIAN_REDUCTION_PERCENT = 30;

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function recordsFromReport(report) {
  const records = report?.records ?? report?.invocations;
  return Array.isArray(records) ? records.map((item) => Number(item.totalTokens ?? item.total_tokens))
    .filter((item) => Number.isFinite(item) && item >= 0) : null;
}

function metrics(report, fallbackRecords = []) {
  const records = recordsFromReport(report) ?? fallbackRecords.map((item) => item.totalTokens);
  const fallbackMedian = numberOrNull(report?.medianTokens);
  const fallbackP95 = numberOrNull(report?.p95Tokens);
  return {
    invocationCount: Number(report?.invocationCount ?? records.length),
    totalTokens: Number(report?.totalTokens ?? records.reduce((sum, item) => sum + item, 0)),
    medianTokens: fallbackMedian ?? median(records),
    p95Tokens: fallbackP95 ?? percentile(records, 0.95),
  };
}

function gate(name, passed, details = {}) {
  return { name, status: passed ? "PASS" : "FAIL", passed, ...details };
}

function gateEvidence(input = {}) {
  const verification = input.verification ?? {};
  const safety = input.safety ?? {};
  const knowledge = input.knowledge ?? input.knowledgeDecisions ?? {};
  const findings = input.findings ?? input.newFindings ?? [];
  const passRate = numberOrNull(input.verificationPassRate ?? verification.passRate);
  const baselinePassRate = numberOrNull(input.baselineVerificationPassRate ?? verification.baselinePassRate);
  const safetyCount = numberOrNull(input.safetyRegressions ?? safety.regressions ?? safety.count);
  const coverage = numberOrNull(input.knowledgeDecisionCoverage ?? knowledge.coverage ?? knowledge.passRate);
  const normalizedFindings = Array.isArray(findings) ? findings : [];
  const severeFindings = normalizedFindings.filter((finding) => ["HIGH", "CRITICAL"].includes(String(finding?.severity ?? finding).toUpperCase()));
  return [
    gate("verification-pass-rate", passRate !== null && (baselinePassRate === null || passRate >= baselinePassRate), {
      passRate, baselinePassRate, requirement: "current rate must not regress",
    }),
    gate("safety-regressions", safetyCount !== null && safetyCount === 0, {
      regressions: safetyCount, requirement: "zero regressions",
    }),
    gate("knowledge-decision-coverage", coverage !== null && coverage >= 1, {
      coverage, requirement: "every task has a knowledge decision (100%)",
    }),
    gate("new-high-critical-findings", severeFindings.length === 0, {
      findings: severeFindings, requirement: "no new HIGH/CRITICAL finding",
    }),
  ];
}

function readBaseline(baselinePath) {
  if (!baselinePath || !fs.existsSync(baselinePath)) throw new Error(`P5.0 baseline report not found: ${baselinePath}`);
  let report;
  try { report = JSON.parse(fs.readFileSync(baselinePath, "utf8")); } catch (error) {
    throw new Error(`P5.0 baseline report is invalid JSON: ${error.message}`);
  }
  if (report?.benchmarkVersion !== TOKEN_BENCHMARK_VERSION) throw new Error(`Unsupported benchmark baseline: ${report?.benchmarkVersion ?? "missing version"}`);
  return report;
}

export function certifyEfficiency({ baselinePath = DEFAULT_BASELINE_PATH, gateEvidence: evidence = {}, now = new Date() } = {}) {
  const baselineReport = readBaseline(baselinePath);
  const fixture = createBenchmarkFixture();
  const currentFixture = createOptimizedBenchmarkFixture();
  const currentReport = runTokenBenchmark(currentFixture);
  const baseline = metrics(baselineReport, fixture);
  const current = metrics(currentReport, currentFixture);
  const medianReductionPercent = baseline.medianTokens === 0
    ? 0 : ((baseline.medianTokens - current.medianTokens) / baseline.medianTokens) * 100;
  const gates = gateEvidence(evidence);
  const allAutomatedGatesPass = gates.every((item) => item.passed);
  const targetMet = medianReductionPercent >= TARGET_MEDIAN_REDUCTION_PERCENT;
  const finalDecision = !allAutomatedGatesPass
    ? "BLOCKED_AUTOMATED_GATES"
    : targetMet
      ? "HUMAN_GATE_REQUIRED"
      : "BLOCKED_TARGET_NOT_MET";
  return {
    schemaVersion: 1, kind: "personal-ai-os-efficiency-certification",
    certificationVersion: EFFICIENCY_CERTIFICATION_VERSION,
    createdAt: now.toISOString(), model: "ECONOMY", providerCalls: 0,
    baseline: { path: path.resolve(baselinePath), benchmarkVersion: baselineReport.benchmarkVersion, ...baseline },
    current: { benchmarkVersion: currentReport.benchmarkVersion, ...current },
    comparison: { medianReductionPercent, targetPercent: TARGET_MEDIAN_REDUCTION_PERCENT, targetMet },
    gates, automatedGatesPass: allAutomatedGatesPass,
    finalDecision, status: finalDecision === "HUMAN_GATE_REQUIRED" ? "HUMAN_GATE_REQUIRED" : "BLOCKED",
    evidence: {
      fixture: "P5.0 frozen corpus with P5.1-P5.3 bounded context path",
      baselineReport,
      measurement: "current input tokens are deterministic context-compactor estimates; frozen output tokens are retained",
      providerCalls: 0,
    },
  };
}

export function writeEfficiencyCertification(report, reportPath = DEFAULT_REPORT_PATH) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.${process.pid}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, reportPath);
  fs.writeFileSync(`${reportPath}.sha256`, `${createHash("sha256").update(text).digest("hex")}  ${path.basename(reportPath)}\n`, { encoding: "utf8", mode: 0o600 });
  return reportPath;
}

function cli() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] || fallback) : fallback;
  };
  const baselinePath = option("--baseline", DEFAULT_BASELINE_PATH);
  const outputPath = option("--output", DEFAULT_REPORT_PATH);
  const numericOption = (name) => {
    const value = option(name, null);
    return value === null ? undefined : Number(value);
  };
  const report = certifyEfficiency({
    baselinePath,
    gateEvidence: {
      verificationPassRate: numericOption("--verification-pass-rate"),
      baselineVerificationPassRate: numericOption("--baseline-verification-pass-rate"),
      safetyRegressions: numericOption("--safety-regressions"),
      knowledgeDecisionCoverage: numericOption("--knowledge-decision-coverage"),
      newFindings: [],
    },
  });
  writeEfficiencyCertification(report, outputPath);
  process.stdout.write(`${JSON.stringify({ ...report, reportPath: path.resolve(outputPath) }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
