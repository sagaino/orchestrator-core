/**
 * P7.1/P7.2: bounded multi-viewport capture jobs and visual diagnostics.
 *
 * Capture owns only the screenshot job and evidence persistence. Pixel
 * accessibility scanning remains UNKNOWN until P7.3.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createVisualEvidence, persistVisualEvidence, VISUAL_EVIDENCE_SCHEMA_VERSION } from "./visual-evidence.mjs";
import { compareVisualArtifacts, readPng } from "./visual-comparison.mjs";
import { ACCESSIBILITY_EVIDENCE_SCHEMA_VERSION, runAccessibilityAudit } from "./visual-accessibility.mjs";

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
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    if (signal?.aborted) {
      const error = new Error("Viewport capture dibatalkan setelah timeout.");
      error.code = "VISUAL_CAPTURE_ABORTED";
      throw error;
    }
    const diagnostics = await page.evaluate(({ width, height, responseStatus }) => {
      const documentElement = document.documentElement;
      const body = document.body;
      const scrollWidth = Math.max(documentElement?.scrollWidth ?? width, body?.scrollWidth ?? width);
      const clientWidth = documentElement?.clientWidth ?? width;
      const candidates = [];
      for (const element of Array.from(document.querySelectorAll("*"))) {
        if (candidates.length >= 20) break;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.left < width;
        const horizontallyClipped = visible && (rect.left < -1 || rect.right > width + 1);
        const fixedVerticallyClipped = visible && ["fixed", "sticky"].includes(style.position) && (rect.top < -1 || rect.bottom > height + 1);
        if (horizontallyClipped || fixedVerticallyClipped) candidates.push({ tag: element.tagName.toLowerCase(), id: element.id || null, className: typeof element.className === "string" ? element.className.slice(0, 120) : null, rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) }, reason: horizontallyClipped ? "HORIZONTAL_CLIP" : "VIEWPORT_CLIP" });
      }
      return { route: { status: responseStatus === null || responseStatus >= 400 ? "MISSING_ROUTE" : "RENDERED", httpStatus: responseStatus, title: document.title || null }, layout: { horizontalOverflow: scrollWidth > clientWidth + 1, scrollWidth, clientWidth, clippedElements: candidates }, viewport: { width, height } };
    }, { width: viewport.width, height: viewport.height, responseStatus: response?.status() ?? null });
    let accessibility;
    try {
      accessibility = await runAccessibilityAudit(page);
    } catch (error) {
      accessibility = { schemaVersion: ACCESSIBILITY_EVIDENCE_SCHEMA_VERSION, status: "UNKNOWN", findings: [{ id: "ACCESSIBILITY_AUDIT_UNAVAILABLE", severity: "INFO", message: error.message }], checks: { bounded: true, unavailable: true } };
    }
    await page.screenshot({ path: outputPath, fullPage: false, animations: "disabled" });
    return { status: "CAPTURED", diagnostics, accessibility, processTree: { strategy: "playwright-browser-close", bounded: true } };
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

function resolveReferencePath({ runsRoot, referencePath }) {
  if (!referencePath || typeof referencePath !== "string") return null;
  if (path.isAbsolute(referencePath)) return referencePath;
  const fromWorkingDirectory = path.resolve(referencePath);
  if (fs.existsSync(fromWorkingDirectory)) return fromWorkingDirectory;
  return path.resolve(runsRoot, referencePath);
}

function checksumFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function layoutIssues(captureDiagnostics) {
  const issues = [];
  if (captureDiagnostics?.route?.status === "MISSING_ROUTE") issues.push("TARGET_ROUTE_MISSING");
  if (captureDiagnostics?.layout?.horizontalOverflow) issues.push("HORIZONTAL_OVERFLOW");
  if ((captureDiagnostics?.layout?.clippedElements?.length ?? 0) > 0) issues.push("CLIPPED_ELEMENTS");
  return issues;
}

function compareCapture({ runsRoot, evidenceId, actualPath, reference, comparisonRoot, captureDiagnostics, pixelThreshold, maxMismatchRatio }) {
  const issues = layoutIssues(captureDiagnostics);
  if (actualPath && fs.existsSync(actualPath) && captureDiagnostics?.viewport) {
    try {
      const actualDimensions = readPng(actualPath);
      if (actualDimensions.width !== captureDiagnostics.viewport.width || actualDimensions.height !== captureDiagnostics.viewport.height) issues.push("VIEWPORT_CAPTURE_MISMATCH");
    } catch {}
  }
  const referencePath = resolveReferencePath({ runsRoot, referencePath: reference?.path });
  if (reference?.kind === "NONE" || !referencePath) {
    return { status: issues.length > 0 ? "FAIL" : "UNKNOWN", method: issues.length > 0 ? "layout-diagnostics-v1" : "pixel-diff-v1", score: null, mismatchPixels: null, notes: [...issues.map((issue) => `Diagnostic: ${issue}`), "Reference screenshot unavailable; pixel comparison remains UNKNOWN."], diagnostics: { reason: "REFERENCE_UNAVAILABLE", issues, layout: captureDiagnostics?.layout ?? null, route: captureDiagnostics?.route ?? null, viewport: captureDiagnostics?.viewport ?? null, artifacts: null } };
  }
  if (!fs.existsSync(referencePath)) {
    return { status: issues.length > 0 ? "FAIL" : "UNKNOWN", method: issues.length > 0 ? "layout-diagnostics-v1" : "pixel-diff-v1", score: null, mismatchPixels: null, notes: [...issues.map((issue) => `Diagnostic: ${issue}`), "Reference screenshot tidak ditemukan."], diagnostics: { reason: "REFERENCE_UNAVAILABLE", referencePath, issues, layout: captureDiagnostics?.layout ?? null, route: captureDiagnostics?.route ?? null, viewport: captureDiagnostics?.viewport ?? null, artifacts: null } };
  }
  if (reference?.checksum && /^[a-f0-9]{64}$/.test(reference.checksum) && checksumFile(referencePath) !== reference.checksum) {
    return { status: issues.length > 0 ? "FAIL" : "UNKNOWN", method: issues.length > 0 ? "layout-diagnostics-v1" : "pixel-diff-v1", score: null, mismatchPixels: null, notes: [...issues.map((issue) => `Diagnostic: ${issue}`), "Checksum reference tidak cocok; comparison ditahan."], diagnostics: { reason: "REFERENCE_CHECKSUM_MISMATCH", referencePath, issues, layout: captureDiagnostics?.layout ?? null, route: captureDiagnostics?.route ?? null, viewport: captureDiagnostics?.viewport ?? null, artifacts: null } };
  }
  const result = compareVisualArtifacts({ actualPath, referencePath, comparisonRoot, evidenceId, pixelThreshold, maxMismatchRatio });
  return { ...result.comparison, status: issues.length > 0 ? "FAIL" : result.comparison.status, method: issues.length > 0 ? "pixel-diff-and-layout-v1" : result.comparison.method, notes: [...issues.map((issue) => `Diagnostic: ${issue}`), ...result.comparison.notes], diagnostics: { ...result.comparison.diagnostics, issues, layout: captureDiagnostics?.layout ?? null, route: captureDiagnostics?.route ?? null, viewport: captureDiagnostics?.viewport ?? result.dimensions?.actual ?? null } };
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
  pixelThreshold = 16,
  maxMismatchRatio = 0.01,
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
    const comparison = captured ? compareCapture({ runsRoot, evidenceId: `${captureId}-${name}`, actualPath: outputPath, reference, comparisonRoot: path.join(path.dirname(root), "comparisons"), captureDiagnostics: result.result?.diagnostics ?? null, pixelThreshold, maxMismatchRatio }) : { status: "UNKNOWN", method: "pixel-diff-v1", score: null, mismatchPixels: null, notes: ["Comparison skipped because screenshot capture failed."], diagnostics: { reason: "ACTUAL_CAPTURE_UNAVAILABLE", layout: result.result?.diagnostics?.layout ?? null, route: result.result?.diagnostics?.route ?? null, viewport: result.result?.diagnostics?.viewport ?? viewport, artifacts: null } };
    const accessibility = result.result?.accessibility ?? { schemaVersion: ACCESSIBILITY_EVIDENCE_SCHEMA_VERSION, status: "UNKNOWN", findings: [{ id: "SCANNER_DEFERRED", severity: "INFO", message: "Accessibility audit tidak tersedia karena capture gagal." }], checks: { bounded: true, unavailable: true } };
    const evidence = createVisualEvidence({
      evidenceId: `${captureId}-${name}`,
      runId,
      route,
      viewport,
      reference,
      actual: { status: captured ? "CAPTURED" : "UNAVAILABLE", path: captured ? outputPath : null, capturedAt: captured ? new Date().toISOString() : null, diagnostics: result.result?.diagnostics ?? null },
      comparison: errorMessage && comparison.status === "UNKNOWN" ? { ...comparison, notes: [errorMessage, ...comparison.notes] } : comparison,
      accessibility,
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
      comparisonStatus: evidence.comparison.status,
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
    comparisonStatus: viewports.some((item) => item.comparisonStatus === "FAIL") ? "FAIL" : (viewports.every((item) => item.comparisonStatus === "PASS") ? "PASS" : "UNKNOWN"),
    viewports,
    evidenceContract: { schemaVersion: VISUAL_EVIDENCE_SCHEMA_VERSION, comparison: "P7.2", accessibility: "P7.3" },
  };
  const persisted = persistCaptureReport({ runsRoot, report });
  return { ...report, persistence: persisted };
}

export function comparePersistedVisualEvidence({ runsRoot, evidence, reference = evidence?.reference, pixelThreshold = 16, maxMismatchRatio = 0.01 } = {}) {
  if (!evidence?.evidenceId || !evidence?.runId) throw new Error("Visual evidence tidak lengkap untuk comparison.");
  const actualPath = evidence.actual?.path ?? evidence.artifact?.path;
  const comparison = compareCapture({ runsRoot, evidenceId: evidence.evidenceId, actualPath, reference, comparisonRoot: path.join(runsRoot, "runtime", "visual-evidence", evidence.runId, "comparisons"), captureDiagnostics: evidence.actual?.diagnostics ?? null, pixelThreshold, maxMismatchRatio });
  const updated = createVisualEvidence({ ...evidence, reference, actual: { ...evidence.actual, diagnostics: evidence.actual?.diagnostics ?? null }, comparison, artifactPath: actualPath, createdAt: evidence.createdAt });
  return persistVisualEvidence({ runsRoot, evidence: updated });
}

export async function auditVisualEvidence({ runsRoot, evidence, baseUrl, route = evidence?.route, viewport = evidence?.viewport, timeoutMs = 30_000 } = {}) {
  if (!evidence?.evidenceId || !evidence?.runId) throw new Error("Visual evidence tidak lengkap untuk accessibility audit.");
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl harus berupa URL HTTP(S).");
  if (!route?.startsWith?.("/")) throw new Error("route harus berupa path lokal yang diawali '/'.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000) throw new Error("timeoutMs harus integer antara 500 dan 120000.");
  let browser;
  let timer;
  const operation = (async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 });
    await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "networkidle", timeout: timeoutMs });
    return runAccessibilityAudit(page, { maxElements: 120, maxTabStops: 20 });
  })();
  let accessibility;
  try {
    accessibility = await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Accessibility audit timeout setelah ${timeoutMs}ms.`)), timeoutMs); }),
    ]);
  } catch (error) {
    accessibility = { schemaVersion: ACCESSIBILITY_EVIDENCE_SCHEMA_VERSION, status: "UNKNOWN", findings: [{ id: "ACCESSIBILITY_AUDIT_UNAVAILABLE", severity: "INFO", message: error.message }], checks: { bounded: true, unavailable: true } };
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    operation.catch(() => {});
  }
  const updated = createVisualEvidence({ ...evidence, actual: { ...evidence.actual, diagnostics: evidence.actual?.diagnostics ?? null }, accessibility, createdAt: evidence.createdAt, artifactPath: evidence.actual?.path ?? evidence.artifact?.path });
  return persistVisualEvidence({ runsRoot, evidence: updated });
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
