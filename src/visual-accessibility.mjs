/**
 * P7.3 bounded accessibility evidence. This is intentionally a small,
 * deterministic evidence collector rather than a replacement for a full
 * accessibility scanner.
 */

export const ACCESSIBILITY_EVIDENCE_SCHEMA_VERSION = 1;
const MAX_FINDINGS = 80;

function finding(id, severity, message, selector = null, details = {}) {
  return { id, severity, message, selector, ...details };
}

function pushFinding(findings, item) {
  if (findings.length < MAX_FINDINGS) findings.push(item);
}

export function auditAccessibilitySnapshot(snapshot = {}) {
  const findings = [];
  const controls = Array.isArray(snapshot.controls) ? snapshot.controls : [];
  const images = Array.isArray(snapshot.images) ? snapshot.images : [];
  const headings = Array.isArray(snapshot.headings) ? snapshot.headings : [];
  const contrastSamples = Array.isArray(snapshot.contrastSamples) ? snapshot.contrastSamples : [];

  for (const control of controls) {
    if (control.requiresName && !control.name) pushFinding(findings, finding("MISSING_ACCESSIBLE_NAME", "ERROR", "Interactive element tidak memiliki accessible name.", control.selector, { role: control.role }));
    if (control.requiresName && control.tabIndex < 0 && !control.disabled) pushFinding(findings, finding("FOCUSABILITY_FAILURE", "ERROR", "Interactive element tidak dapat dicapai melalui urutan keyboard.", control.selector, { role: control.role, tabIndex: control.tabIndex }));
  }
  for (const image of images) if (image.requiresAlt && !image.hasAlt && image.role !== "presentation" && image.role !== "none") pushFinding(findings, finding("IMAGE_ALT_MISSING", "ERROR", "Image informatif tidak memiliki alt text.", image.selector));

  if (headings.length === 0) pushFinding(findings, finding("HEADING_STRUCTURE_MISSING", "WARN", "Halaman tidak memiliki heading yang dapat dipindai."));
  else {
    if (!headings.some((heading) => heading.level === 1)) pushFinding(findings, finding("H1_MISSING", "WARN", "Halaman tidak memiliki heading level 1."));
    let previous = 0;
    for (const heading of headings) {
      if (previous > 0 && heading.level > previous + 1) pushFinding(findings, finding("HEADING_ORDER_SKIP", "WARN", `Heading melompat dari h${previous} ke h${heading.level}.`, heading.selector, { previousLevel: previous, level: heading.level }));
      previous = heading.level;
    }
  }

  let contrastEvaluated = 0;
  for (const sample of contrastSamples) {
    if (typeof sample.ratio !== "number") continue;
    contrastEvaluated += 1;
    const threshold = sample.largeText ? 3 : 4.5;
    if (sample.ratio < threshold) pushFinding(findings, finding("CONTRAST_LOW", "WARN", `Contrast ratio ${sample.ratio} berada di bawah threshold ${threshold}.`, sample.selector, { ratio: sample.ratio, threshold }));
  }
  if (contrastEvaluated === 0) pushFinding(findings, finding("CONTRAST_UNAVAILABLE", "INFO", "Contrast tidak dapat dihitung dari metadata warna yang tersedia."));

  const keyboard = snapshot.keyboard ?? {};
  if (keyboard.evaluable === false) pushFinding(findings, finding("KEYBOARD_FLOW_UNAVAILABLE", "INFO", "Keyboard flow tidak dapat dievaluasi karena tidak ada focusable target."));
  else if (keyboard.focusLost) pushFinding(findings, finding("KEYBOARD_FLOW_FAILURE", "ERROR", "Urutan Tab kehilangan focus pada elemen yang tidak dapat diidentifikasi.", null, { tabStops: keyboard.tabStops ?? 0 }));

  const blocking = findings.filter((item) => item.severity === "ERROR" || item.severity === "WARN");
  return {
    schemaVersion: ACCESSIBILITY_EVIDENCE_SCHEMA_VERSION,
    status: blocking.length > 0 ? "FAIL" : "PASS",
    findings,
    checks: { controls: controls.length, images: images.length, headings: headings.length, contrastEvaluated, keyboardEvaluated: keyboard.evaluable !== false, bounded: true, maxFindings: MAX_FINDINGS },
  };
}

export async function runAccessibilityAudit(page, { maxElements = 120, maxTabStops = 20 } = {}) {
  const snapshot = await page.evaluate((limit) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selector = (element) => element.id ? `${element.tagName.toLowerCase()}#${element.id}`.slice(0, 160) : element.tagName.toLowerCase();
    const textName = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim() : "";
      const label = element.labels?.[0]?.textContent?.trim() ?? "";
      return (element.getAttribute("aria-label") || labelledText || label || element.getAttribute("title") || element.textContent || "").trim().slice(0, 160);
    };
    const controls = [];
    for (const element of Array.from(document.querySelectorAll("button,a,input,select,textarea,[role='button'],[role='link'],[tabindex]")).slice(0, limit)) {
      const type = element.getAttribute("type");
      if (element.tagName.toLowerCase() === "input" && type === "hidden") continue;
      controls.push({ selector: selector(element), role: element.getAttribute("role") || element.tagName.toLowerCase(), name: textName(element), requiresName: true, tabIndex: element.tabIndex, disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true") });
    }
    const images = Array.from(document.querySelectorAll("img")).slice(0, limit).map((element) => ({ selector: selector(element), alt: element.getAttribute("alt")?.trim() || "", hasAlt: element.hasAttribute("alt"), role: element.getAttribute("role"), requiresAlt: true }));
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).slice(0, limit).map((element) => ({ selector: selector(element), level: Number(element.tagName.slice(1)) }));
    const contrastSamples = [];
    for (const element of Array.from(document.querySelectorAll("body *")).slice(0, limit)) {
      if (!visible(element) || !element.textContent?.trim()) continue;
      const style = window.getComputedStyle(element);
      const foreground = style.color.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/i)?.[0] ?? null;
      const background = style.backgroundColor.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/i)?.[0] ?? null;
      if (!foreground || !background || background.includes(", 0)")) continue;
      const parse = (value) => { const match = value.match(/\d+/g); return match ? match.slice(0, 3).map(Number) : null; };
      const fg = parse(foreground); const bg = parse(background);
      if (!fg || !bg) continue;
      const linear = (channel) => { const normalized = channel / 255; return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4; };
      const lum = (rgb) => (0.2126 * linear(rgb[0])) + (0.7152 * linear(rgb[1])) + (0.0722 * linear(rgb[2]));
      const foregroundLum = lum(fg); const backgroundLum = lum(bg);
      const ratio = Number(((Math.max(foregroundLum, backgroundLum) + 0.05) / (Math.min(foregroundLum, backgroundLum) + 0.05)).toFixed(3));
      contrastSamples.push({ selector: selector(element), ratio, largeText: Number.parseFloat(style.fontSize) >= 24 });
    }
    return { controls, images, headings, contrastSamples };
  }, maxElements);

  const expectedFocusable = snapshot.controls.filter((control) => control.tabIndex >= 0 && !control.disabled).length;
  const keyboard = { evaluable: expectedFocusable > 0, focusLost: false, tabStops: 0 };
  if (keyboard.evaluable) {
    for (let index = 0; index < Math.min(maxTabStops, expectedFocusable + 1); index += 1) {
      await page.keyboard.press("Tab");
      const active = await page.evaluate(() => ({ tag: document.activeElement?.tagName?.toLowerCase() ?? null, id: document.activeElement?.id ?? null }));
      keyboard.tabStops += 1;
      if (!active.tag || active.tag === "body") { keyboard.focusLost = keyboard.tabStops <= expectedFocusable; break; }
    }
  }
  const result = auditAccessibilitySnapshot({ ...snapshot, keyboard });
  await page.evaluate(() => document.activeElement?.blur?.());
  return result;
}
