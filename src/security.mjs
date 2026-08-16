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
