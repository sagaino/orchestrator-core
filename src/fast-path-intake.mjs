import fs from "node:fs";
import path from "node:path";

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
  // 3. Simple component tweaks (e.g. padding, margin, color, icon, placeholder)
  const isSimpleStylingOrText = /^(ubah|ganti|perbaiki|tambahkan|update|fix|change|set|adjust|remove|hapus|tweak)\b/i.test(cleanRequest);
  
  // Complexity indicators that disqualify fast-path and MUST use full AI planning:
  const complexityIndicators = /\b(arsitektur|refactor besar|database|migration|auth flow|oauth|full slicing|state management|redesign total|breaking change|multi-module)\b/i;
  if (complexityIndicators.test(cleanRequest)) {
    return null;
  }

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
      clarificationNeeded: false,
      clarificationQuestion: null,
      _isFastPath: true,
    };
  }

  return null;
}
