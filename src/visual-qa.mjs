/**
 * P7.1: bounded multi-viewport capture jobs.
 *
 * Capture owns only the screenshot job and evidence persistence. Pixel
 * comparison and accessibility scanning remain UNKNOWN until P7.2/P7.3.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createVisualEvidence, persistVisualEvidence, VISUAL_EVIDENCE_SCHEMA_VERSION } from "./visual-evidence.mjs";

export const VISUAL_CAPTURE_SCHEMA_VERSION = 1;
export const VISUAL_CAPTURE_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 }),
  tablet: Object.freeze({ name: "tablet", width: 1024, height: 768, deviceScaleFactor: 1 }),
  mobile: Object.freeze({ name: "mobile", width: 390, height: 844, deviceScaleFactor: 1 }),
});

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function captureRoot(runsRoot, runId) {
  return path.join(runsRoot, "runtime", "visual-evidence", runId, "captures");
}

function captureReportPath(runsRoot, runId, captureId) {
  return path.join(runsRoot, "runtime", "visual-evidence", runId, "capture-jobs", `${captureId}.json`);
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256(text);
  const checksumPath = `${filePath}.sha256`;
  fs.writeFileSync(checksumPath, `${checksum}  ${path.basename(filePath)}\n`, { encoding: "utf8", mode: 0o600 });
  return { path: filePath, checksum, checksumPath };
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function assertCaptureInput({ runsRoot, runId, baseUrl, route }) {
  if (!runsRoot || !runId) throw new Error("runsRoot dan runId wajib diisi.");
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl harus berupa URL HTTP(S).");
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) throw new Error("route harus berupa path lokal yang diawali '/'.");
}

async function defaultCaptureViewport({ url, viewport, outputPath, timeoutMs, signal }) {
  let browser;
  const closeBrowser = () => browser?.close().catch(() => {});
  const onAbort = () => { void closeBrowser(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const { chromium } = await import("playwright");
    if (signal?.aborted) {
      const error = new Error("Viewport capture dibatalkan setelah timeout.");
      error.code = "VISUAL_CAPTURE_ABORTED";
      throw error;
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 });
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    if (signal?.aborted) {
      const error = new Error("Viewport capture dibatalkan setelah timeout.");
      error.code = "VISUAL_CAPTURE_ABORTED";
      throw error;
    }
    await page.screenshot({ path: outputPath, fullPage: false, animations: "disabled" });
    return { status: "CAPTURED", processTree: { strategy: "playwright-browser-close", bounded: true } };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeBrowser();
  }
}

async function runBoundedCapture({ captureViewport, input, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const operation = Promise.resolve().then(() => captureViewport({ ...input, signal: controller.signal }));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      const error = new Error(`Viewport capture timeout setelah ${timeoutMs}ms.`);
      error.code = "VISUAL_CAPTURE_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([operation, timeout]);
    return { result, timedOut: false };
  } catch (error) {
    return { error, timedOut };
  } finally {
    clearTimeout(timer);
    operation.then(() => {
      if (timedOut && fs.existsSync(input.outputPath)) fs.rmSync(input.outputPath, { force: true });
    }, () => {
      if (timedOut && fs.existsSync(input.outputPath)) fs.rmSync(input.outputPath, { force: true });
    });
  }
}

function persistCaptureReport({ runsRoot, report }) {
  return writePrivateJson(captureReportPath(runsRoot, report.runId, report.captureId), report);
}

export async function captureVisualEvidence({
  runsRoot,
  runId,
  baseUrl,
  route,
  reference = { kind: "NONE" },
  revision = { number: 1, requestedBy: null, reason: null },
  viewportNames = Object.keys(VISUAL_CAPTURE_VIEWPORTS),
  timeoutMs = 30_000,
  captureViewport = defaultCaptureViewport,
  now = new Date(),
} = {}) {
  assertCaptureInput({ runsRoot, runId, baseUrl, route });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000) throw new Error("timeoutMs harus integer antara 500 dan 120000.");
  if (!Array.isArray(viewportNames) || viewportNames.length === 0 || viewportNames.some((name) => !VISUAL_CAPTURE_VIEWPORTS[name])) throw new Error("viewportNames berisi viewport yang tidak didukung.");

  const captureId = `capture-${randomUUID()}`;
  const startedAt = now.toISOString();
  const root = captureRoot(runsRoot, runId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const viewports = [];
  for (const name of viewportNames) {
    const viewport = VISUAL_CAPTURE_VIEWPORTS[name];
    const outputPath = path.join(root, `${captureId}-${name}.png`);
    const result = await runBoundedCapture({
      captureViewport,
      timeoutMs,
      input: { url: new URL(route, baseUrl).toString(), viewport, outputPath, timeoutMs, runId, captureId },
    });
    const captured = !result.error && result.result?.status === "CAPTURED" && fs.existsSync(outputPath);
    if (!captured && fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    const errorMessage = result.error?.message ?? (captured ? null : "Capture tidak menghasilkan screenshot artifact.");
    const evidence = createVisualEvidence({
      evidenceId: `${captureId}-${name}`,
      runId,
      route,
      viewport,
      reference,
      actual: { status: captured ? "CAPTURED" : "UNAVAILABLE", path: captured ? outputPath : null, capturedAt: captured ? new Date().toISOString() : null },
      comparison: { status: "UNKNOWN", method: "DEFERRED_TO_P7.2", score: null, mismatchPixels: null, notes: errorMessage ? [errorMessage] : ["Comparison deferred to P7.2."] },
      accessibility: { status: "UNKNOWN", findings: [{ id: "SCANNER_DEFERRED", severity: "INFO", message: "Accessibility scanning deferred to P7.3." }] },
      revision,
      artifactPath: captured ? outputPath : null,
      createdAt: new Date().toISOString(),
    });
    const persisted = persistVisualEvidence({ runsRoot, evidence });
    viewports.push({
      name,
      viewport,
      status: captured ? "PASS" : "FAIL",
      timedOut: Boolean(result.timedOut),
      error: errorMessage,
      evidenceId: evidence.evidenceId,
      evidence: persisted,
      processTree: result.result?.processTree ?? { strategy: "capture-runner", bounded: true },
    });
  }
  const report = {
    schemaVersion: VISUAL_CAPTURE_SCHEMA_VERSION,
    mode: "multi-viewport-capture",
    captureId,
    runId,
    route,
    baseUrl,
    startedAt,
    completedAt: new Date().toISOString(),
    timeoutMs,
    status: viewports.every((item) => item.status === "PASS") ? "PASS" : "PARTIAL",
    viewports,
    evidenceContract: { schemaVersion: VISUAL_EVIDENCE_SCHEMA_VERSION, comparison: "P7.2", accessibility: "P7.3" },
  };
  const persisted = persistCaptureReport({ runsRoot, report });
  return { ...report, persistence: persisted };
}

export function listCaptureReports({ runsRoot, runId } = {}) {
  const directory = path.join(runsRoot, "runtime", "visual-evidence", runId, "capture-jobs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(directory, entry.name)))
    .filter((report) => report?.mode === "multi-viewport-capture")
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
}
