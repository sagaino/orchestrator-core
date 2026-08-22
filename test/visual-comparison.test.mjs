import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureVisualEvidence } from "../src/visual-qa.mjs";
import { compareVisualArtifacts, encodeRgbaPng } from "../src/visual-comparison.mjs";

console.log("Running visual-comparison.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-comparison-runs-"));
const referencePath = path.join(root, "reference.png");
const pixels = Buffer.from([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255,
]);
fs.writeFileSync(referencePath, encodeRgbaPng({ width: 2, height: 2, pixels }));

try {
  const actualPath = path.join(root, "actual.png");
  fs.writeFileSync(actualPath, encodeRgbaPng({ width: 2, height: 2, pixels }));
  const pass = compareVisualArtifacts({ actualPath, referencePath, comparisonRoot: path.join(root, "comparisons"), evidenceId: "pass" });
  assert.equal(pass.comparison.status, "PASS");
  assert.equal(pass.comparison.mismatchPixels, 0);
  assert.equal(fs.existsSync(pass.comparison.diagnostics.artifacts.sideBySidePath), true);
  assert.equal(fs.existsSync(pass.comparison.diagnostics.artifacts.overlayPath), true);

  const mismatchPixels = Buffer.from(pixels);
  mismatchPixels[0] = 0;
  const mismatchPath = path.join(root, "mismatch.png");
  fs.writeFileSync(mismatchPath, encodeRgbaPng({ width: 2, height: 2, pixels: mismatchPixels }));
  const mismatch = compareVisualArtifacts({ actualPath: mismatchPath, referencePath, comparisonRoot: path.join(root, "comparisons"), evidenceId: "mismatch", maxMismatchRatio: 0 });
  assert.equal(mismatch.comparison.status, "FAIL");
  assert.equal(mismatch.comparison.mismatchPixels, 1);

  const unavailable = compareVisualArtifacts({ actualPath, referencePath: path.join(root, "missing.png"), comparisonRoot: path.join(root, "comparisons"), evidenceId: "unavailable" });
  assert.equal(unavailable.comparison.status, "UNKNOWN");
  assert.equal(unavailable.comparison.diagnostics.reason, "REFERENCE_UNAVAILABLE");

  const captured = await captureVisualEvidence({
    runsRoot: root,
    runId: "comparison-pass",
    baseUrl: "http://127.0.0.1:4173",
    route: "/operations",
    reference: { kind: "path", path: referencePath },
    viewportNames: ["desktop"],
    timeoutMs: 500,
    captureViewport: async ({ outputPath }) => {
      fs.writeFileSync(outputPath, encodeRgbaPng({ width: 2, height: 2, pixels }));
      return { status: "CAPTURED", diagnostics: { route: { status: "RENDERED", httpStatus: 200 }, layout: { horizontalOverflow: false, clippedElements: [] }, viewport: { width: 2, height: 2 } }, processTree: { strategy: "fixture", bounded: true } };
    },
  });
  assert.equal(captured.viewports[0].evidence.comparison.status, "PASS");
  assert.equal(captured.comparisonStatus, "PASS");

  const diagnosed = await captureVisualEvidence({
    runsRoot: root,
    runId: "comparison-diagnostics",
    baseUrl: "http://127.0.0.1:4173",
    route: "/missing",
    reference: { kind: "NONE" },
    viewportNames: ["desktop"],
    timeoutMs: 500,
    captureViewport: async ({ outputPath }) => {
      fs.writeFileSync(outputPath, encodeRgbaPng({ width: 2, height: 2, pixels }));
      return { status: "CAPTURED", diagnostics: { route: { status: "MISSING_ROUTE", httpStatus: 404 }, layout: { horizontalOverflow: true, clippedElements: [{ tag: "div", reason: "HORIZONTAL_CLIP" }] }, viewport: { width: 2, height: 2 } }, processTree: { strategy: "fixture", bounded: true } };
    },
  });
  assert.equal(diagnosed.viewports[0].evidence.comparison.status, "FAIL");
  assert.equal(diagnosed.comparisonStatus, "FAIL");
  assert.deepEqual(diagnosed.viewports[0].evidence.comparison.diagnostics.issues, ["TARGET_ROUTE_MISSING", "HORIZONTAL_OVERFLOW", "CLIPPED_ELEMENTS"]);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("visual-comparison.test.mjs: All tests passed!");
