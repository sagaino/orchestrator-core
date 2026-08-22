import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditAccessibilitySnapshot } from "../src/visual-accessibility.mjs";
import { captureVisualEvidence } from "../src/visual-qa.mjs";

console.log("Running visual-accessibility.test.mjs...");

const pass = auditAccessibilitySnapshot({
  controls: [{ selector: "button#save", role: "button", name: "Save", requiresName: true, tabIndex: 0, disabled: false }],
  images: [{ selector: "img#logo", alt: "Company logo", hasAlt: true, role: null, requiresAlt: true }],
  headings: [{ selector: "h1", level: 1 }, { selector: "h2", level: 2 }],
  contrastSamples: [{ selector: "p", ratio: 7, largeText: false }],
  keyboard: { evaluable: true, focusLost: false, tabStops: 1 },
});
assert.equal(pass.status, "PASS");
assert.equal(pass.findings.length, 0);
assert.equal(pass.checks.bounded, true);

const fail = auditAccessibilitySnapshot({
  controls: [{ selector: "button#delete", role: "button", name: "", requiresName: true, tabIndex: -1, disabled: false }],
  images: [{ selector: "img#hero", alt: "", role: null, requiresAlt: true }],
  headings: [{ selector: "h1", level: 1 }, { selector: "h3", level: 3 }],
  contrastSamples: [{ selector: "p.muted", ratio: 2.1, largeText: false }],
  keyboard: { evaluable: true, focusLost: true, tabStops: 2 },
});
assert.equal(fail.status, "FAIL");
assert.deepEqual(new Set(fail.findings.map((item) => item.id)), new Set(["MISSING_ACCESSIBLE_NAME", "FOCUSABILITY_FAILURE", "IMAGE_ALT_MISSING", "HEADING_ORDER_SKIP", "CONTRAST_LOW", "KEYBOARD_FLOW_FAILURE"]));

const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "visual-accessibility-runs-"));
try {
  const report = await captureVisualEvidence({
    runsRoot,
    runId: "accessibility-fixture",
    baseUrl: "http://127.0.0.1:4173",
    route: "/operations",
    viewportNames: ["desktop"],
    timeoutMs: 500,
    captureViewport: async ({ outputPath }) => {
      fs.writeFileSync(outputPath, "capture-fixture");
      return { status: "CAPTURED", accessibility: fail, processTree: { strategy: "fixture", bounded: true } };
    },
  });
  assert.equal(report.viewports[0].evidence.accessibility.status, "FAIL");
  assert.equal(report.viewports[0].evidence.accessibility.findings[0].id, "MISSING_ACCESSIBLE_NAME");
} finally {
  fs.rmSync(runsRoot, { recursive: true, force: true });
}

console.log("visual-accessibility.test.mjs: All tests passed!");
