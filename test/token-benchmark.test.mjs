import assert from "node:assert/strict";
import {
  BENCHMARK_CORPUS,
  TOKEN_BENCHMARK_VERSION,
  createBenchmarkFixture,
  normalizeBenchmarkRecords,
  runTokenBenchmark,
} from "../src/token-benchmark.mjs";

console.log("Running token-benchmark.test.mjs...");

const first = runTokenBenchmark();
const second = runTokenBenchmark(createBenchmarkFixture());
assert.deepEqual(first, second, "the baseline must be reproducible without provider calls");
assert.equal(first.benchmarkVersion, TOKEN_BENCHMARK_VERSION);
assert.equal(first.invocationCount, 11);
assert.deepEqual(BENCHMARK_CORPUS.map((item) => item.kind), ["simple", "medium", "ui", "recovery", "knowledge"]);
assert.equal(first.stages.IMPLEMENTATION.invocations, 3);
assert.equal(first.stages.IMPLEMENTATION.totalTokens, 2840);
assert.equal(first.stages.IMPLEMENTATION.medianTokens, 940);
assert.equal(first.stages.IMPLEMENTATION.medianLatencyMs, 420);

const duplicate = createBenchmarkFixture();
duplicate.push({ ...duplicate[0], caseId: "copy", invocationId: duplicate[0].invocationId });
assert.throws(() => normalizeBenchmarkRecords(duplicate), /Duplicate benchmark invocation rejected/);
assert.throws(() => normalizeBenchmarkRecords([{ ...duplicate[0], totalTokens: 999 }]), /Token total mismatch/);

console.log("token-benchmark.test.mjs: All tests passed!");
