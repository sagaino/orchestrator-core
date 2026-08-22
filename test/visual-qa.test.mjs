import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureVisualEvidence, listCaptureReports } from "../src/visual-qa.mjs";
import { listVisualEvidence } from "../src/visual-evidence.mjs";

console.log("Running visual-qa.test.mjs...");

const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visual-qa-runs-"));
try {
  const report = await captureVisualEvidence({
    runsRoot,
    runId: "run-visual-qa",
    baseUrl: "http://127.0.0.1:4173",
    route: "/operations",
    timeoutMs: 500,
    captureViewport: async ({ viewport, outputPath }) => {
      if (viewport.name === "tablet") throw new Error("tablet fixture failure");
      if (viewport.name === "mobile") await new Promise(() => {});
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${viewport.name}-png-fixture`);
      return { status: "CAPTURED", processTree: { strategy: "fixture", bounded: true } };
    },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "PARTIAL");
  assert.deepEqual(report.viewports.map((item) => item.status), ["PASS", "FAIL", "FAIL"]);
  assert.equal(report.viewports[2].timedOut, true);
  assert.match(report.viewports[1].error, /tablet fixture failure/);
  assert.equal(report.viewports.every((item) => item.processTree.bounded), true);
  assert.equal(listVisualEvidence({ runsRoot, runId: "run-visual-qa" }).length, 3);
  assert.equal(listVisualEvidence({ runsRoot, runId: "run-visual-qa" }).filter((item) => item.actual.status === "UNAVAILABLE").length, 2);
  assert.equal(listCaptureReports({ runsRoot, runId: "run-visual-qa" }).length, 1);

  const successful = await captureVisualEvidence({
    runsRoot,
    runId: "run-visual-qa-success",
    baseUrl: "http://127.0.0.1:4173",
    route: "/runs",
    viewportNames: ["desktop", "tablet", "mobile"],
    timeoutMs: 500,
    captureViewport: async ({ outputPath }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "success-png-fixture");
      return { status: "CAPTURED", processTree: { strategy: "fixture", bounded: true } };
    },
  });
  assert.equal(successful.status, "PASS");
  assert.equal(successful.viewports.every((item) => item.status === "PASS"), true);
  assert.equal(successful.viewports.every((item) => item.evidence.artifact.sha256), true);
} finally {
  fs.rmSync(runsRoot, { recursive: true, force: true });
}

console.log("visual-qa.test.mjs: All tests passed!");
