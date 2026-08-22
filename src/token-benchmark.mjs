/**
 * P5.0: provider-free, reproducible token benchmark.
 *
 * The corpus is intentionally data (not generated prompts). This makes a
 * baseline auditable and ensures a benchmark run never invokes a provider.
 */

import { buildStageContext } from "./context-compactor.mjs";

export const TOKEN_BENCHMARK_VERSION = "p5.0-2026-08-22";

const CORPUS = [
  { id: "simple", kind: "simple", stages: ["TASK_INTAKE", "IMPLEMENTATION"] },
  { id: "medium", kind: "medium", stages: ["TASK_INTAKE", "IMPLEMENTATION", "RETROSPECTIVE"] },
  { id: "ui", kind: "ui", stages: ["TASK_INTAKE", "IMPLEMENTATION"] },
  { id: "recovery", kind: "recovery", stages: ["TASK_INTAKE", "AUTOMATIC_RECOVERY"] },
  { id: "knowledge", kind: "knowledge", stages: ["KNOWLEDGE_HARVEST", "KNOWLEDGE_INGEST"] },
];

const FIXTURE = [
  ["simple", "TASK_INTAKE", "simple:intake", 210, 95],
  ["simple", "IMPLEMENTATION", "simple:implementation", 620, 240],
  ["medium", "TASK_INTAKE", "medium:intake", 330, 120],
  ["medium", "IMPLEMENTATION", "medium:implementation", 1_280, 510],
  ["medium", "RETROSPECTIVE", "medium:retrospective", 410, 160],
  ["ui", "TASK_INTAKE", "ui:intake", 270, 110],
  ["ui", "IMPLEMENTATION", "ui:implementation", 940, 420],
  ["recovery", "TASK_INTAKE", "recovery:intake", 250, 100],
  ["recovery", "AUTOMATIC_RECOVERY", "recovery:automatic-recovery", 780, 360],
  ["knowledge", "KNOWLEDGE_HARVEST", "knowledge:harvest", 560, 230],
  ["knowledge", "KNOWLEDGE_INGEST", "knowledge:ingest", 390, 180],
].map(([caseId, stage, invocationId, totalTokens, latencyMs]) => ({
  caseId, stage, invocationId, inputTokens: Math.floor(totalTokens * 0.7),
  outputTokens: totalTokens - Math.floor(totalTokens * 0.7), totalTokens, latencyMs,
}));

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export const BENCHMARK_CORPUS = freeze(CORPUS);
export const BENCHMARK_FIXTURE = freeze(FIXTURE);

function finiteNonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be a non-negative number.`);
  return number;
}

export function normalizeBenchmarkRecords(records = BENCHMARK_FIXTURE) {
  if (!Array.isArray(records)) throw new TypeError("Benchmark records must be an array.");
  const seen = new Set();
  return records.map((record, index) => {
    if (!record || typeof record !== "object") throw new TypeError(`Benchmark record ${index} is invalid.`);
    const invocationId = String(record.invocationId ?? "").trim();
    if (!invocationId) throw new Error(`Benchmark record ${index} is missing invocationId.`);
    if (seen.has(invocationId)) throw new Error(`Duplicate benchmark invocation rejected: ${invocationId}`);
    seen.add(invocationId);
    const inputTokens = finiteNonNegative(record.inputTokens ?? record.input_tokens, "inputTokens");
    const outputTokens = finiteNonNegative(record.outputTokens ?? record.output_tokens, "outputTokens");
    const totalTokens = finiteNonNegative(record.totalTokens ?? record.total_tokens, "totalTokens");
    const latencyMs = finiteNonNegative(record.latencyMs ?? record.latency_ms, "latencyMs");
    if (totalTokens !== inputTokens + outputTokens) throw new Error(`Token total mismatch for ${invocationId}.`);
    return Object.freeze({
      caseId: String(record.caseId ?? ""), stage: String(record.stage ?? "").trim().toUpperCase(),
      invocationId, inputTokens, outputTokens, totalTokens, latencyMs,
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function runTokenBenchmark(records = BENCHMARK_FIXTURE) {
  const normalized = normalizeBenchmarkRecords(records);
  const byStage = {};
  for (const record of normalized) (byStage[record.stage] ??= []).push(record);
  const stages = Object.fromEntries(Object.entries(byStage).sort(([a], [b]) => a.localeCompare(b)).map(([stage, values]) => [stage, {
    invocations: values.length,
    totalTokens: values.reduce((sum, item) => sum + item.totalTokens, 0),
    medianTokens: median(values.map((item) => item.totalTokens)),
    totalLatencyMs: values.reduce((sum, item) => sum + item.latencyMs, 0),
    medianLatencyMs: median(values.map((item) => item.latencyMs)),
  }]));
  return {
    schemaVersion: 1, benchmarkVersion: TOKEN_BENCHMARK_VERSION,
    corpus: BENCHMARK_CORPUS, invocationCount: normalized.length,
    totalTokens: normalized.reduce((sum, item) => sum + item.totalTokens, 0),
    totalLatencyMs: normalized.reduce((sum, item) => sum + item.latencyMs, 0),
    stages,
  };
}

export function createBenchmarkFixture() {
  return BENCHMARK_FIXTURE.map((record) => ({ ...record }));
}

/**
 * Build the current, provider-free measurement from the same frozen cases.
 *
 * P5.0's fixture remains the immutable baseline.  This companion fixture
 * measures the actual bounded context path introduced by P5.1-P5.3 and keeps
 * the recorded completion side of each invocation constant.  Consequently a
 * reduction can only come from the context/routing path, never from invented
 * provider output or a changed baseline.
 */
export function createOptimizedBenchmarkFixture() {
  return BENCHMARK_FIXTURE.map((baseline) => {
    const context = buildStageContext({
      stage: baseline.stage.toLowerCase(),
      task: { id: baseline.caseId, body: `Frozen ${baseline.caseId} benchmark task.` },
      acceptanceCriteria: ["Preserve acceptance, verification, and safety requirements."],
      latestFeedback: "Retain the latest reviewer feedback and required evidence.",
      latestDiff: "diff --git a/src/core.mjs b/src/core.mjs\n+const optimizedPath = true;",
      revisionState: { status: "ready", caseId: baseline.caseId },
      allowedPaths: ["src/core.mjs", "src/context-compactor.mjs"],
      graphifyContext: "Dependency delta: execution uses the bounded context pack.",
      knowledge: [{ path: "01-Knowledge/relevant.md", summary: "Relevant contract", score: 1 }],
    });
    return {
      ...baseline,
      inputTokens: context.estimatedTokens,
      // Keep output tokens fixed to the frozen P5.0 invocation.
      totalTokens: context.estimatedTokens + baseline.outputTokens,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(runTokenBenchmark(), null, 2)}\n`);
}
