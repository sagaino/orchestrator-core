import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentTelemetryRecord,
  appendRunTelemetry,
  collectRunTelemetry,
  telemetryReport,
} from "../src/telemetry.mjs";
import { RUN_STATES } from "../src/run-manager.mjs";

console.log("Running telemetry-dedup.test.mjs...");

const tempRuns = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-test-"));
try {
  // 1. Source field checks
  const explicitRecord = createAgentTelemetryRecord({
    stage: "IMPLEMENTATION",
    result: {
      exitCode: 0,
      finalResult: {
        conversation_id: "conv-1",
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        duration_seconds: 5,
      },
    },
    agentConfig: { model: "gemini-3.7-flash-high", effort: "high" },
    invocationId: "inv-1",
  });
  assert.equal(explicitRecord.source, "explicit");

  // 2. appendRunTelemetry dedup check
  const runId = "test-run-1";
  const manifest = {
    schemaVersion: 1,
    runId,
    state: RUN_STATES.REVIEW,
    project: { id: "p1", repository: "/tmp/repo" },
    task: { path: "task.md" },
    execution: {
      telemetry: {
        records: [explicitRecord],
      },
    },
    history: [],
  };
  fs.writeFileSync(path.join(tempRuns, `${runId}.json`), JSON.stringify(manifest, null, 2));

  // Try appending identical record again
  const dedupResult = appendRunTelemetry({
    runsRoot: tempRuns,
    runId,
    record: explicitRecord,
  });
  assert.equal(dedupResult.deduplicated, true);

  // Appending new distinct record should succeed
  const distinctRecord = createAgentTelemetryRecord({
    stage: "RETROSPECTIVE",
    result: {
      exitCode: 0,
      finalResult: {
        conversation_id: "conv-2",
        usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
        duration_seconds: 3,
      },
    },
    agentConfig: { model: "gemini-3.7-flash-high", effort: "high" },
    invocationId: "inv-2",
  });
  const appendResult = appendRunTelemetry({
    runsRoot: tempRuns,
    runId,
    record: distinctRecord,
  });
  assert.equal(appendResult.deduplicated, undefined);
  assert.equal(appendResult.execution.telemetry.records.length, 2);

  // 3. telemetryReport summary metrics
  const report = telemetryReport({
    runsRoot: tempRuns,
    selector: runId,
  });
  assert.equal(report.summary.explicitRecords >= 2, true);
  assert.equal(typeof report.summary.inferredRecords, "number");
  assert.equal(typeof report.summary.inferredSkippedByExplicit, "number");
} finally {
  fs.rmSync(tempRuns, { recursive: true, force: true });
}

console.log("telemetry-dedup.test.mjs: All tests passed!");
