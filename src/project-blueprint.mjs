import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadRulePolicy } from "./rule-policy.mjs";

export const SUPPORTED_BLUEPRINTS = Object.freeze([
  "frontend-vite",
  "backend-golang",
]);

export function computeRulePolicyFingerprint(policy) {
  if (!policy || typeof policy !== "object") return null;
  const sorted = {
    ruleId: policy.ruleId || null,
    name: policy.name || null,
    version: policy.version || 1,
    toolchain: policy.toolchain || null,
    allowedPathPatterns: Array.isArray(policy.allowedPathPatterns) ? [...policy.allowedPathPatterns].sort() : [],
    forbiddenPathPatterns: Array.isArray(policy.forbiddenPathPatterns) ? [...policy.forbiddenPathPatterns].sort() : [],
    verificationDefaults: Array.isArray(policy.verificationDefaults) ? [...policy.verificationDefaults].sort() : [],
    architectureConstraints: Array.isArray(policy.architectureConstraints) ? [...policy.architectureConstraints].sort() : [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function detectRepositoryBlueprint(repositoryPath) {
  if (!repositoryPath || typeof repositoryPath !== "string" || !fs.existsSync(repositoryPath)) {
    return null;
  }

  const goModPath = path.join(repositoryPath, "go.mod");
  const packageJsonPath = path.join(repositoryPath, "package.json");

  const hasGoMod = fs.existsSync(goModPath);
  const hasPackageJson = fs.existsSync(packageJsonPath);

  // Both Go and package.json without explicit metadata is ambiguous
  if (hasGoMod && hasPackageJson) {
    return null;
  }

  if (hasGoMod && !hasPackageJson) {
    return "backend-golang";
  }

  if (hasPackageJson && !hasGoMod) {
    try {
      const text = fs.readFileSync(packageJsonPath, "utf8").trim();
      if (!text || text === "{}") return null;
      const pkg = JSON.parse(text);
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return null;

      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {}),
      };

      const hasVite = Boolean(
        allDeps.vite ||
        allDeps["@vitejs/plugin-react"] ||
        (typeof pkg.scripts?.dev === "string" && pkg.scripts.dev.includes("vite")) ||
        (typeof pkg.scripts?.build === "string" && pkg.scripts.build.includes("vite"))
      );
      const hasReact = Boolean(allDeps.react || allDeps["react-dom"]);
      const hasTs = Boolean(allDeps.typescript || (typeof pkg.scripts?.typecheck === "string") || fs.existsSync(path.join(repositoryPath, "tsconfig.json")));

      // Strict high-confidence rule: require Vite AND React AND TypeScript
      if (hasVite && hasReact && hasTs) {
        return "frontend-vite";
      }

      // Express-only, React-only without Vite, or generic Node package without all three
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

export function resolveProjectBlueprint({
  projectMetadata = {},
  registryMetadata = {},
  repositoryPath = null,
  vaultRoot = null,
} = {}) {
  // 1. Explicit project metadata
  const explicit = projectMetadata?.blueprint || projectMetadata?.blueprintId;
  if (explicit) {
    const clean = String(explicit).trim();
    if (SUPPORTED_BLUEPRINTS.includes(clean)) {
      const policy = loadRulePolicy(vaultRoot, clean);
      if (!policy) {
        return {
          id: clean,
          source: "PROJECT_METADATA",
          confidence: "EXPLICIT",
          policyVersion: null,
          policyFingerprint: null,
          valid: false,
          error: `PROJECT_POLICY_NOT_FOUND: Policy tidak ditemukan untuk blueprint: ${clean}`,
        };
      }
      return {
        id: clean,
        source: "PROJECT_METADATA",
        confidence: "EXPLICIT",
        policyVersion: policy.version || 1,
        policyFingerprint: computeRulePolicyFingerprint(policy),
        valid: true,
        error: null,
      };
    }
    return {
      id: clean,
      source: "PROJECT_METADATA",
      confidence: "EXPLICIT",
      policyVersion: null,
      policyFingerprint: null,
      valid: false,
      error: `PROJECT_BLUEPRINT_UNSUPPORTED: Blueprint project tidak didukung: ${clean}`,
    };
  }

  // 2. Registry metadata
  const registry = registryMetadata?.blueprint;
  if (registry) {
    const clean = String(registry).trim();
    if (SUPPORTED_BLUEPRINTS.includes(clean)) {
      const policy = loadRulePolicy(vaultRoot, clean);
      if (!policy) {
        return {
          id: clean,
          source: "REGISTRY_METADATA",
          confidence: "EXPLICIT",
          policyVersion: null,
          policyFingerprint: null,
          valid: false,
          error: `PROJECT_POLICY_NOT_FOUND: Policy tidak ditemukan untuk blueprint: ${clean}`,
        };
      }
      return {
        id: clean,
        source: "REGISTRY_METADATA",
        confidence: "EXPLICIT",
        policyVersion: policy.version || 1,
        policyFingerprint: computeRulePolicyFingerprint(policy),
        valid: true,
        error: null,
      };
    }
    return {
      id: clean,
      source: "REGISTRY_METADATA",
      confidence: "EXPLICIT",
      policyVersion: null,
      policyFingerprint: null,
      valid: false,
      error: `PROJECT_BLUEPRINT_UNSUPPORTED: Blueprint di project registry tidak didukung: ${clean}`,
    };
  }

  // 3. High-confidence deterministic detection
  const detected = detectRepositoryBlueprint(repositoryPath);
  if (detected && SUPPORTED_BLUEPRINTS.includes(detected)) {
    const policy = loadRulePolicy(vaultRoot, detected);
    if (!policy) {
      return {
        id: detected,
        source: "DETECTED",
        confidence: "HIGH",
        policyVersion: null,
        policyFingerprint: null,
        valid: false,
        error: `PROJECT_POLICY_NOT_FOUND: Policy tidak ditemukan untuk blueprint: ${detected}`,
      };
    }
    return {
      id: detected,
      source: "DETECTED",
      confidence: "HIGH",
      policyVersion: policy.version || 1,
      policyFingerprint: computeRulePolicyFingerprint(policy),
      valid: true,
      error: null,
    };
  }

  // 4. Unresolved / Ambiguous
  return {
    id: "UNRESOLVED",
    source: "UNRESOLVED",
    confidence: "NONE",
    policyVersion: null,
    policyFingerprint: null,
    valid: false,
    error: "PROJECT_BLUEPRINT_UNRESOLVED: Tidak dapat mendeteksi blueprint dengan keyakinan tinggi. Tentukan blueprint eksplisit di frontmatter project.md.",
  };
}
