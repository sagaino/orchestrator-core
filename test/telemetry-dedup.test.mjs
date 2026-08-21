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
import { interactionStatus } from "../src/interaction.mjs";
import { RUN_STATES } from "../src/run-manager.mjs";

console.log("Running telemetry-dedup.test.mjs...");

const tempRuns = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-test-"));
try {
  const runId = "test-run-1";

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
    invocationId: `${runId}:implementation`,
  });
  assert.equal(explicitRecord.source, "explicit");

  // 2. appendRunTelemetry dedup check
  const manifest = {
    schemaVersion: 1,
    runId,
    state: RUN_STATES.REVIEW,
    project: { id: "p1", repository: "/tmp/repo" },
    task: { id: "TASK-001", path: "task.md" },
    execution: {
      eventLog: `events/${runId}.jsonl`,
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
    invocationId: `${runId}:retrospective`,
  });
  const appendResult = appendRunTelemetry({
    runsRoot: tempRuns,
    runId,
    record: distinctRecord,
  });
  assert.equal(appendResult.deduplicated, undefined);
  assert.equal(appendResult.execution.telemetry.records.length, 2);

  const automaticRecoveryRecord = createAgentTelemetryRecord({
    stage: "AUTOMATIC_RECOVERY",
    result: {
      exitCode: 0,
      finalResult: {
        conversation_id: "conv-3",
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
        duration_seconds: 2,
      },
    },
    invocationId: `${runId}:automatic-recovery:1`,
  });
  appendRunTelemetry({ runsRoot: tempRuns, runId, record: automaticRecoveryRecord });

  const reviewRevisionRecord = createAgentTelemetryRecord({
    stage: "REVIEW_REVISION",
    result: {
      exitCode: 0,
      finalResult: {
        conversation_id: "conv-4",
        usage: { input_tokens: 75, output_tokens: 30, total_tokens: 105 },
        duration_seconds: 4,
      },
    },
    invocationId: `${runId}:review-revision:1`,
  });
  const finalManifest = appendRunTelemetry({ runsRoot: tempRuns, runId, record: reviewRevisionRecord });
  assert.equal(finalManifest.execution.telemetry.records.length, 4);

  // The event log uses the process stage while explicit telemetry uses the
  // durable invocation stage. They describe one invocation and must count once.
  const eventDirectory = path.join(tempRuns, "events");
  fs.mkdirSync(eventDirectory, { recursive: true });
  const inferredEvents = [
    ["coding-agent", "conv-1", 5, { input_tokens: 100, output_tokens: 50, total_tokens: 150 }],
    ["retrospective", "conv-2", 3, { input_tokens: 200, output_tokens: 80, total_tokens: 280 }],
    ["automatic-recovery-agent:1", "conv-3", 2, { input_tokens: 50, output_tokens: 20, total_tokens: 70 }],
    ["review-revision-agent:1", "conv-4", 4, { input_tokens: 75, output_tokens: 30, total_tokens: 105 }],
  ].map(([stage, conversationId, durationSeconds, usage], index) => JSON.stringify({
    at: `2026-08-21T18:15:0${index + 1}.626Z`,
    event: "PROCESS_OUTPUT",
    stage,
    payload: {
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "SUCCESS",
        duration_seconds: durationSeconds,
        usage,
      },
    },
  }));
  fs.writeFileSync(path.join(eventDirectory, `${runId}.jsonl`), `${inferredEvents.join("\n")}\n`, "utf8");

  const collected = collectRunTelemetry({ runsRoot: tempRuns, run: finalManifest });
  assert.equal(collected.summary.calls, 4);
  assert.equal(collected.summary.inferredSkipped, 4);
  assert.deepEqual(collected.records.map((record) => record.source), Array(4).fill("explicit"));

  const status = interactionStatus({ runsRoot: tempRuns, selector: "TASK-001" });
  assert.equal(status.telemetry.summary.calls, 4);
  assert.equal(status.telemetry.summary.inferredSkipped, 4);

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
