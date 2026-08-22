import fs from "node:fs";
import path from "node:path";
import { resolveAgentRoute } from "./agent-routing.mjs";
import { detectTaskComplexity } from "./agent-config.mjs";

const FAST_PATH_SAFE_WORDS = new Set([
  "ubah", "ganti", "perbaiki", "tambahkan", "update", "fix", "change", "set", "adjust", "tweak", "rename", "hide", "show", "display", "tampilkan", "sembunyikan", "switch", "toggle",
  "the", "a", "an", "in", "on", "to", "for", "of", "and", "with", "from", "be", "as", "into", "jadi", "menjadi", "di", "pada", "untuk", "ke", "dengan", "dari", "dan", "yang",
  "text", "label", "title", "button", "placeholder", "typo", "padding", "margin", "warna", "color", "icon", "styling", "css", "font", "size", "border", "opacity", "shadow", "rounded", "gap", "align", "alignment", "z", "index", "hover", "cursor", "disabled", "readonly", "loading", "spinner", "class", "tailwind", "layout",
]);
const FAST_PATH_SAFE_PROPERTIES = new Set([
  "text", "label", "title", "button", "placeholder", "typo", "padding", "margin", "warna", "color", "icon", "styling", "css", "font", "size", "border", "opacity", "shadow", "rounded", "gap", "align", "alignment", "z", "hover", "cursor", "disabled", "readonly", "loading", "class", "tailwind", "layout",
]);

function isSafeFastPathRequest(request, allowedPaths) {
  const withoutPaths = allowedPaths.reduce((value, filePath) => value.replaceAll(String(filePath).toLowerCase(), " "), request.toLowerCase());
  const tokens = withoutPaths.match(/[\p{L}\p{N}-]+/gu) ?? [];
  return tokens.length > 0
    && tokens.every((token) => FAST_PATH_SAFE_WORDS.has(token))
    && tokens.some((token) => FAST_PATH_SAFE_PROPERTIES.has(token));
}

/**
 * Attempts deterministic fast-path task planning without invoking LLM tokens.
 * Returns normalized draft object if deterministic rules match with 100% confidence, or null to fallback to AI planner.
 */
export function tryDeterministicTaskDraft({ project, request, attachedAssets = [] }) {
  if (!request || typeof request !== "string") return null;
  const cleanRequest = request.trim();

  // If there are attached visual assets or mockups, rely on multimodal AI planner
  if (Array.isArray(attachedAssets) && attachedAssets.length > 0) {
    return null;
  }

  // Detect explicit file references in the request e.g. `src/components/Header.tsx` or `src/pages/Login.tsx`
  const filePathRegex = /(?:src|public|lib|hooks|components|pages|routes|services)\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g;
  const matchedPaths = [...new Set(cleanRequest.match(filePathRegex) || [])];

  // Verify that matched files actually exist inside project repository
  const validAllowedPaths = matchedPaths.filter((relPath) => {
    const absPath = path.join(project.repository, relPath);
    return fs.existsSync(absPath) && fs.statSync(absPath).isFile();
  });

  // Fast-path requires at least 1 verified file path if request targets specific file modification
  if (validAllowedPaths.length === 0) {
    return null;
  }

  // Check for simple patterns:
  // 1. Styling / CSS / Layout adjustments
  // 2. Text / Copywriting / Label / Typo changes
  // 3. Simple component tweaks (e.g. padding, margin, color, icon, placeholder, disabled state)
  const isSimpleStylingOrText = /^(ubah|ganti|perbaiki|tambahkan|update|fix|change|set|adjust|remove|hapus|tweak|rename|hide|show|tampilkan|sembunyikan|switch|toggle)\b/i.test(cleanRequest);
  
  // Complexity indicators that disqualify fast-path and MUST use full AI planning:
  const complexityIndicators = /\b(arsitektur|architecture|refactor besar|major refactor|database|migration|migrasi|auth flow|oauth|full slicing|state management|redesign total|breaking change|multi-module|payment|webhook|websocket|concurrency|race condition)\b/i;
  if (complexityIndicators.test(cleanRequest)) {
    return null;
  }
  // The deterministic path must never conceal work requiring strong review.
  const complexity = detectTaskComplexity(cleanRequest);
  // Only a fully allowlisted UI/text/style request qualifies for the
  // zero-token path. Any unrecognized word or mixed intent is unknown.
  const safeRequest = isSafeFastPathRequest(cleanRequest, validAllowedPaths);
  const risk = safeRequest && complexity !== "high"
    ? "LOW"
    : "UNKNOWN";
  const route = resolveAgentRoute({ stage: "task-intake", risk, complexity });
  if (route.tier === "STRONG_REVIEW") return null;

  if (isSimpleStylingOrText && validAllowedPaths.length <= 3) {
    // Generate clean concise title
    const firstLine = cleanRequest.split("\n")[0].slice(0, 80);
    const title = firstLine.charAt(0).toUpperCase() + firstLine.slice(1);

    const verificationDefaults = Array.isArray(project.verificationDefaults) && project.verificationDefaults.length > 0
      ? project.verificationDefaults
      : ["typecheck", "build"];

    return {
      title,
      purpose: cleanRequest,
      expectedResult: `Perubahan diterapkan secara presisi pada target file: ${validAllowedPaths.join(", ")} dan lulus verifikasi.`,
      acceptanceCriteria: [
        `Implementasi instruksi: "${cleanRequest}".`,
        `Hanya mengubah file yang relevan (${validAllowedPaths.join(", ")}).`,
        `Kode lulus semua skrip verifikasi otomatis.`,
      ],
      dependencies: [],
      verification: verificationDefaults,
      allowedPaths: validAllowedPaths,
      requiresChanges: true,
      risk: "LOW",
      complexity: complexity.toUpperCase(),
      clarificationNeeded: false,
      clarificationQuestion: null,
      _isFastPath: true,
    };
  }

  return null;
}
