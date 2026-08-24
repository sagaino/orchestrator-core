import fs from 'node:fs';
import path from 'node:path';

export const DENY_PATTERNS = Object.freeze([
  {
    pattern: /^\.env(?:\.(?!example$)[a-zA-Z0-9_-]+)*$/i,
    description: '.env files',
    pathMatch: false
  },
  {
    pattern: /\.(pem|key|p12|pfx|jks)$/i,
    description: 'Private keys',
    pathMatch: false
  },
  {
    pattern: /^id_(rsa|ed25519|ecdsa)/i,
    description: 'SSH keys',
    pathMatch: false
  },
  {
    pattern: /^(\.netrc|credentials\.json|service[-_]?account.*\.json)$/i,
    description: 'Credential files',
    pathMatch: false
  }
]);

export function isDeniedPath(relativePath) {
  const basename = path.basename(relativePath);
  for (const p of DENY_PATTERNS) {
    const target = p.pathMatch ? relativePath : basename;
    if (p.pattern.test(target)) {
      return { denied: true, reason: p.description };
    }
  }
  return { denied: false, reason: null };
}

export function filterDeniedPaths(paths) {
  const allowed = [];
  const denied = [];
  for (const p of paths) {
    const check = isDeniedPath(p);
    if (check.denied) {
      denied.push({ path: p, reason: check.reason });
    } else {
      allowed.push(p);
    }
  }
  return { allowed, denied };
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function normalizeSafeRelativePath(value, { label = "Path" } = {}) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error(`${label} harus berupa path relatif yang aman.`);
  }

  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (normalized === "." || segments.includes("..") || segments.some((segment) => !segment)) {
    throw new Error(`${label} tidak boleh keluar dari root yang diizinkan.`);
  }
  return normalized;
}

function normalizeComparablePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function globSegmentPattern(segment) {
  let pattern = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += /[\\^$+?.()|{}\[\]]/.test(character) ? `\\${character}` : character;
    }
  }
  return pattern;
}

/**
 * Match a repository-relative changed path against an allowed path or glob.
 * A plain path keeps the historical directory-prefix behavior; glob paths
 * follow segment boundaries so `src/pages/Skills/**` includes index.tsx.
 */
export function pathMatchesAllowed(candidatePath, allowedPath) {
  const candidate = normalizeComparablePath(candidatePath);
  const allowed = normalizeComparablePath(allowedPath);
  if (!candidate || !allowed) return false;

  if (!/[?*]/.test(allowed)) {
    return candidate === allowed || candidate.startsWith(`${allowed}/`);
  }

  const segments = allowed.split("/");
  let expression = "^";
  segments.forEach((segment, index) => {
    if (segment === "**") {
      expression += "(?:/[^/]+)*";
      return;
    }
    expression += `${index === 0 ? "" : "/"}${globSegmentPattern(segment)}`;
  });
  expression += "$";
  return new RegExp(expression).test(candidate);
}

export function resolveContainedPath(root, relativePath, {
  label = "Path",
  mustExist = false,
} = {}) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`${label} root tidak ditemukan atau bukan direktori.`);
  }

  const normalized = normalizeSafeRelativePath(relativePath, { label });
  const realRoot = fs.realpathSync(path.resolve(root));
  const target = path.resolve(realRoot, ...normalized.split("/"));
  if (!isInsideRoot(realRoot, target)) {
    throw new Error(`${label} berada di luar root yang diizinkan.`);
  }

  let existingAncestor = target;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  if (!fs.existsSync(existingAncestor)) {
    throw new Error(`${label} tidak memiliki ancestor yang dapat divalidasi.`);
  }

  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isInsideRoot(realRoot, realAncestor)) {
    throw new Error(`${label} melewati symlink di luar root yang diizinkan.`);
  }
  const resolvedThroughAncestor = path.resolve(realAncestor, path.relative(existingAncestor, target));
  if (!isInsideRoot(realRoot, resolvedThroughAncestor)) {
    throw new Error(`${label} melewati symlink di luar root yang diizinkan.`);
  }

  if (mustExist) {
    if (!fs.existsSync(target)) throw new Error(`${label} tidak ditemukan.`);
    const realTarget = fs.realpathSync(target);
    if (!isInsideRoot(realRoot, realTarget)) {
      throw new Error(`${label} melewati symlink di luar root yang diizinkan.`);
    }
  }

  return target;
}

export function validateSymlink(symlinkPath, repositoryRoot) {
  try {
    const target = fs.readlinkSync(symlinkPath);
    const resolvedTarget = path.resolve(path.dirname(symlinkPath), target);
    const resolvedRoot = path.resolve(repositoryRoot);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { valid: false, reason: 'Symlink escapes repository root', resolvedTarget };
    }
    return { valid: true, reason: null, resolvedTarget };
  } catch (error) {
    return { valid: false, reason: error.message, resolvedTarget: '' };
  }
}

export function auditWorkspaceSecrets(workspacePath) {
  const EXCLUDES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'graphify-out', '.next']);
  const violations = [];
  
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDES.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(workspacePath, absolute);
        const check = isDeniedPath(relative);
        if (check.denied) {
          violations.push({ path: relative, reason: check.reason });
        }
      }
    }
  };
  
  walk(workspacePath);
  return { clean: violations.length === 0, violations };
}
