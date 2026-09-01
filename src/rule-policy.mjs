import fs from "node:fs";
import path from "node:path";

export const DEFAULT_FALLBACK_RULES = Object.freeze({
  "backend-golang": Object.freeze({
    ruleId: "backend-golang",
    name: "Go Modular Clean Architecture Rules & Guardrails",
    version: 1,
    toolchain: "go",
    allowedPathPatterns: [
      "internal/core/domain/<feature>.go",
      "internal/core/usecase/<feature>/**",
      "internal/adapter/controller/<feature>.go",
      "internal/adapter/controller/<feature>_test.go",
      "cmd/api/api.go",
    ],
    forbiddenPathPatterns: [
      "internal/<feature>/**",
      "internal/models/**",
      "internal/routes/**",
      "internal/domain/**",
    ],
    verificationDefaults: [
      "go test ./...",
      "go vet ./...",
    ],
    architectureConstraints: [
      "Domain entity struct wajib meng-embed domain.BaseEntity",
      "DTO request & response diletakkan di internal/core/usecase/<feature>/dto.go",
      "Business logic diletakkan di internal/core/usecase/<feature>/usecase.go",
      "HTTP handler Gin diletakkan di internal/adapter/controller/<feature>.go",
      "Error handling wajib menggunakan pkg/localerror",
      "Format JSON response HTTP wajib menggunakan shared/payload.Response",
      "Pendaftaran route controller dan AutoMigrate entity dilakukan di cmd/api/api.go",
    ],
  }),
  "frontend-vite": Object.freeze({
    ruleId: "frontend-vite",
    name: "Frontend Vite React TypeScript Rules & Guardrails",
    version: 1,
    toolchain: "node",
    allowedPathPatterns: [
      "src/components/**",
      "src/pages/**",
      "src/hooks/**",
      "src/services/**",
      "src/lib/**",
      "src/routes/**",
      "src/types/**",
      "src/App.tsx",
      "src/main.tsx",
    ],
    forbiddenPathPatterns: [
      "src/components/ui/**",
    ],
    verificationDefaults: [
      "npm run typecheck",
      "npm run lint",
      "npm run build",
    ],
    architectureConstraints: [
      "Gunakan TypeScript dengan strict type checking",
      "Komponen UI Shadcn di src/components/ui/ dianggap vendor output dan tidak diedit manual",
      "Panggil API backend melalui lib axios/api client terpusat di src/services/ atau src/lib/",
    ],
  }),
});

/**
 * Load rule policy from Obsidian Vault (01-Knowledge/rules/<ruleId>.json) with embedded fallback.
 */
export function loadRulePolicy(vaultRoot, ruleId) {
  if (!ruleId) return null;
  const normalizedId = String(ruleId).trim();
  if (vaultRoot && typeof vaultRoot === "string") {
    const candidatePath = path.join(vaultRoot, "01-Knowledge", "rules", `${normalizedId}.json`);
    try {
      if (fs.existsSync(candidatePath)) {
        const content = fs.readFileSync(candidatePath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {
      // Fallback to embedded default if parse fails
    }
  }

  return DEFAULT_FALLBACK_RULES[normalizedId] ?? null;
}

/**
 * Format prompt constraint text from a rule policy.
 */
export function formatRulePromptConstraint(policy) {
  if (!policy || typeof policy !== "object") return "";
  const allowed = Array.isArray(policy.allowedPathPatterns) ? policy.allowedPathPatterns.map((p) => `\`${p}\``).join(", ") : "";
  const forbidden = Array.isArray(policy.forbiddenPathPatterns) ? policy.forbiddenPathPatterns.map((p) => `\`${p}\``).join(", ") : "";
  const rules = Array.isArray(policy.architectureConstraints) ? policy.architectureConstraints.join("; ") : "";

  const lines = [];
  if (allowed) {
    lines.push(`For ${policy.name || policy.ruleId}: allowedPaths for any business feature MUST strictly be inside ${allowed}.`);
  }
  if (forbidden) {
    lines.push(`Do NOT create or allow ad-hoc root directories like ${forbidden}.`);
  }
  if (rules) {
    lines.push(`Architecture constraints: ${rules}.`);
  }
  return lines.join(" ");
}

/**
 * Normalize verification command using rule policy defaults.
 */
export function normalizeVerificationForRule(script, policy, availableScripts = []) {
  const candidate = String(script ?? "").trim();
  const pool = Array.isArray(availableScripts) && availableScripts.length > 0
    ? availableScripts
    : (Array.isArray(policy?.verificationDefaults) ? policy.verificationDefaults : ["go test ./...", "go vet ./..."]);

  if (pool.includes(candidate)) return candidate;
  if (/^go\s+test\b/i.test(candidate) && pool.includes("go test ./...")) {
    return "go test ./...";
  }
  if (/^go\s+vet\b/i.test(candidate) && pool.includes("go vet ./...")) {
    return "go vet ./...";
  }
  const cleanCmd = candidate.replace(/^(?:npm\s+run\s+|pnpm\s+|yarn\s+)/i, "").trim();
  if (pool.includes(cleanCmd)) return cleanCmd;

  return candidate;
}
