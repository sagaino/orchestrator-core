import fs from "node:fs";
import path from "node:path";

export const SUPPORTED_BLUEPRINTS = Object.freeze([
  "frontend-vite",
  "backend-golang",
]);

export function detectRepositoryBlueprint(repositoryPath) {
  if (!repositoryPath || typeof repositoryPath !== "string" || !fs.existsSync(repositoryPath)) {
    return null;
  }

  const goModPath = path.join(repositoryPath, "go.mod");
  const packageJsonPath = path.join(repositoryPath, "package.json");

  const hasGoMod = fs.existsSync(goModPath);
  const hasPackageJson = fs.existsSync(packageJsonPath);

  if (hasGoMod && !hasPackageJson) {
    return "backend-golang";
  }

  if (hasPackageJson && !hasGoMod) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      if (allDeps.vite || allDeps.react || allDeps.typescript || allDeps["@vitejs/plugin-react"] || pkg.scripts?.dev) {
        return "frontend-vite";
      }
      return "frontend-vite";
    } catch {
      return "frontend-vite";
    }
  }

  return null;
}

export function resolveProjectBlueprint({ projectMetadata = {}, registryMetadata = {}, repositoryPath = null } = {}) {
  // 1. Explicit project metadata
  const explicit = projectMetadata?.blueprint || projectMetadata?.blueprintId;
  if (explicit) {
    const clean = String(explicit).trim();
    if (SUPPORTED_BLUEPRINTS.includes(clean)) {
      return {
        id: clean,
        source: "PROJECT_METADATA",
        confidence: "EXPLICIT",
        policyVersion: 1,
        valid: true,
        error: null,
      };
    }
    return {
      id: clean,
      source: "PROJECT_METADATA",
      confidence: "EXPLICIT",
      policyVersion: 1,
      valid: false,
      error: `Blueprint project tidak didukung: ${clean}`,
    };
  }

  // 2. Registry metadata
  const registry = registryMetadata?.blueprint;
  if (registry) {
    const clean = String(registry).trim();
    if (SUPPORTED_BLUEPRINTS.includes(clean)) {
      return {
        id: clean,
        source: "REGISTRY_METADATA",
        confidence: "EXPLICIT",
        policyVersion: 1,
        valid: true,
        error: null,
      };
    }
    return {
      id: clean,
      source: "REGISTRY_METADATA",
      confidence: "EXPLICIT",
      policyVersion: 1,
      valid: false,
      error: `Blueprint di project registry tidak didukung: ${clean}`,
    };
  }

  // 3. High-confidence deterministic detection
  const detected = detectRepositoryBlueprint(repositoryPath);
  if (detected && SUPPORTED_BLUEPRINTS.includes(detected)) {
    return {
      id: detected,
      source: "DETECTED",
      confidence: "HIGH",
      policyVersion: 1,
      valid: true,
      error: null,
    };
  }

  // 4. Unresolved / Ambiguous
  return {
    id: "UNRESOLVED",
    source: "UNRESOLVED",
    confidence: "NONE",
    policyVersion: 1,
    valid: false,
    error: "Project blueprint belum dapat ditentukan secara deterministik.",
  };
}
