import path from "node:path";

export const VERIFICATION_CAPABILITIES = Object.freeze([
  "TYPECHECK",
  "LINT",
  "BUILD",
  "UNIT",
  "INTEGRATION",
  "E2E",
  "CUSTOM_APPROVED",
]);

const CAPABILITY_PATTERNS = [
  { capability: "TYPECHECK", pattern: /\b(?:typecheck|type-check|tsc|types)\b/i, defaultScript: "typecheck" },
  { capability: "LINT", pattern: /\b(?:lint|linter|eslint|golangci-lint)\b/i, defaultScript: "lint" },
  { capability: "BUILD", pattern: /\b(?:build|compil(?:e|ation)|bundle)\b/i, defaultScript: "build" },
  { capability: "E2E", pattern: /\b(?:e2e|end-to-end|playwright|cypress|route(?:\s+check|\s+test|\s+login|\s+auth)?)\b/i, defaultScript: "test:e2e" },
  { capability: "INTEGRATION", pattern: /\b(?:integration(?:\s+test)?)\b/i, defaultScript: "test:integration" },
  { capability: "UNIT", pattern: /\b(?:unit(?:\s+test)?|unit-test)\b/i, defaultScript: "test:unit" },
];

export function normalizeCapability(value) {
  const upper = String(value ?? "").trim().toUpperCase();
  if (VERIFICATION_CAPABILITIES.includes(upper)) return upper;
  for (const { capability, pattern } of CAPABILITY_PATTERNS) {
    if (pattern.test(value)) return capability;
  }
  return "CUSTOM_APPROVED";
}

function findScriptForCapability(capability, availableScripts = []) {
  const scripts = availableScripts.map((s) => String(s).trim());
  if (capability === "TYPECHECK") {
    return scripts.find((s) => /^(?:typecheck|type-check|check-types|tsc)$/i.test(s)) || null;
  }
  if (capability === "LINT") {
    return scripts.find((s) => /^(?:lint|eslint|lint:all|golangci-lint)$/i.test(s)) || null;
  }
  if (capability === "BUILD") {
    return scripts.find((s) => /^(?:build|build:prod|bundle)$/i.test(s)) || null;
  }
  if (capability === "E2E") {
    return scripts.find((s) => /^(?:test:e2e|e2e|e2e:test|playwright|cypress)$/i.test(s)) || null;
  }
  if (capability === "INTEGRATION") {
    return scripts.find((s) => /^(?:test:integration|integration|test:int)$/i.test(s)) || null;
  }
  if (capability === "UNIT") {
    return scripts.find((s) => /^(?:test:unit|unit|test)$/i.test(s)) || null;
  }
  return null;
}

export function extractVerificationIntent({ request = "", structuredIntent = null, projectContexts = [] } = {}) {
  const projectIds = projectContexts.map((p) => String(p?.projectId ?? p?.id ?? "")).filter(Boolean);
  const primaryProjectId = projectIds[0] ?? "unknown";

  const required = [];
  const seen = new Set();

  const addRequired = ({ projectId, capability, source, requestedAs }) => {
    const key = `${projectId}:${capability}`;
    if (seen.has(key)) return;
    seen.add(key);
    required.push({
      projectId,
      capability,
      source,
      requestedAs,
    });
  };

  // 1. If explicit structured intent provided
  if (Array.isArray(structuredIntent?.required)) {
    for (const item of structuredIntent.required) {
      if (!item?.capability) continue;
      const cap = normalizeCapability(item.capability);
      const pid = item.projectId ? String(item.projectId) : primaryProjectId;
      addRequired({
        projectId: pid,
        capability: cap,
        source: item.source || "EXPLICIT_STRUCTURED",
        requestedAs: item.requestedAs || item.capability,
      });
    }
  }

  // 2. Scan request text for explicit natural-language mentions
  const text = String(request ?? "").trim();
  if (text) {
    for (const { capability, pattern } of CAPABILITY_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // Assign to all relevant project contexts or primary
        for (const projectId of (projectIds.length > 0 ? projectIds : [primaryProjectId])) {
          addRequired({
            projectId,
            capability,
            source: "EXPLICIT_REQUEST",
            requestedAs: match[0],
          });
        }
      }
    }
  }

  return resolveVerificationIntent({
    intent: { contractVersion: 1, required, resolved: [], missing: [], status: "RESOLVED" },
    projectContexts,
  });
}

export function resolveVerificationIntent({ intent, projectContexts = [], registeredRunners = [] } = {}) {
  const baseRequired = Array.isArray(intent?.required) ? intent.required : [];
  const resolved = [];
  const missing = [];

  const projectMap = new Map();
  for (const ctx of projectContexts) {
    const id = String(ctx?.projectId ?? ctx?.id ?? "");
    if (!id) continue;
    const available = [
      ...(Array.isArray(ctx?.verification) ? ctx.verification : []),
      ...(Array.isArray(ctx?.verificationScripts) ? ctx.verificationScripts : []),
      ...(Array.isArray(ctx?.availableScripts) ? ctx.availableScripts : []),
      ...(Array.isArray(ctx?.verificationDefaults) ? ctx.verificationDefaults : []),
    ];
    projectMap.set(id, {
      ...ctx,
      scripts: [...new Set(available.map(String))],
    });
  }

  for (const item of baseRequired) {
    const project = projectMap.get(item.projectId);
    const available = project?.scripts ?? [];
    const matchedScript = findScriptForCapability(item.capability, available);

    if (matchedScript) {
      resolved.push({
        projectId: item.projectId,
        capability: item.capability,
        script: matchedScript,
      });
    } else {
      missing.push({
        projectId: item.projectId,
        capability: item.capability,
        reason: "NO_APPROVED_SCRIPT",
        requestedAs: item.requestedAs,
      });
    }
  }

  const status = missing.length > 0 ? "NEEDS_CLARIFICATION" : "RESOLVED";

  return {
    contractVersion: 1,
    required: baseRequired,
    resolved,
    missing,
    status,
  };
}

export function validateVerificationCoverage({ intent, planNodes = [], integrationVerification = [] } = {}) {
  if (!intent || !Array.isArray(intent.resolved) || intent.resolved.length === 0) {
    return { valid: true, missingCoverage: [] };
  }

  const executedScriptsByProject = new Map();

  const addExecuted = (projectId, script) => {
    if (!projectId || !script) return;
    const cleanScript = String(script).trim();
    if (!executedScriptsByProject.has(projectId)) {
      executedScriptsByProject.set(projectId, new Set());
    }
    executedScriptsByProject.get(projectId).add(cleanScript);
  };

  // Gather node verification scripts
  for (const node of planNodes) {
    const pid = String(node?.projectId ?? "");
    const scripts = Array.isArray(node?.verification) ? node.verification : [];
    for (const script of scripts) {
      addExecuted(pid, script);
    }
  }

  // Gather integration verification scripts (format projectId:script or plain script)
  for (const item of integrationVerification) {
    const text = String(item ?? "").trim();
    if (text.includes(":")) {
      const [pid, script] = text.split(":");
      addExecuted(pid, script);
    }
  }

  const missingCoverage = [];

  for (const req of intent.resolved) {
    const executed = executedScriptsByProject.get(req.projectId);
    if (!executed || !executed.has(req.script)) {
      missingCoverage.push({
        projectId: req.projectId,
        capability: req.capability,
        script: req.script,
      });
    }
  }

  if (missingCoverage.length > 0) {
    const list = missingCoverage.map((m) => `${m.projectId}:${m.script} (${m.capability})`).join(", ");
    return {
      valid: false,
      code: "PLAN_VERIFICATION_COVERAGE_MISSING",
      missingCoverage,
      error: `Plan tidak menyertakan verifikasi yang diminta oleh user/policy: ${list}`,
    };
  }

  return {
    valid: true,
    code: null,
    missingCoverage: [],
    error: null,
  };
}
