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

export function scriptSupportsCapability(capability, script) {
  const normalized = String(script ?? "").trim();
  if (!normalized) return false;
  if (capability === "TYPECHECK") return /^(?:typecheck|type-check|check-types|tsc)(?::[\w.-]+)?$/i.test(normalized);
  if (capability === "LINT") return /^(?:lint|eslint|lint:all|golangci-lint)(?::[\w.-]+)?$/i.test(normalized);
  if (capability === "BUILD") return /^(?:build|build:prod|bundle)(?::[\w.-]+)?$/i.test(normalized);
  if (capability === "E2E") return /^(?:test:e2e|e2e|e2e:test|playwright|cypress)(?:[:.-][\w.-]+)?$/i.test(normalized);
  if (capability === "INTEGRATION") return /^(?:test:integration|integration|test:int)(?::[\w.-]+)?$/i.test(normalized);
  if (capability === "UNIT") return /^(?:test:unit|unit|test)(?::[\w.-]+)?$/i.test(normalized);
  return capability === "CUSTOM_APPROVED";
}

function findScriptForCapability(capability, availableScripts = []) {
  const scripts = availableScripts.map((s) => String(s).trim());
  return scripts.find((candidate) => scriptSupportsCapability(capability, candidate)) || null;
}

function findRunnerForCapability(projectId, capability, runners = []) {
  return runners.find((runner) => {
    if (!runner || typeof runner !== "object") return false;
    const runnerProjectId = String(runner.projectId ?? projectId);
    const capabilities = Array.isArray(runner.capabilities) ? runner.capabilities.map(normalizeCapability) : [];
    return runnerProjectId === projectId && capabilities.includes(capability) && String(runner.id ?? runner.runner ?? "").trim();
  }) ?? null;
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
    intent: { contractVersion: 2, required, resolved: [], waived: [], missing: [], status: "RESOLVED" },
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
    const matchedRunner = findRunnerForCapability(item.projectId, item.capability, [
      ...(Array.isArray(project?.registeredRunners) ? project.registeredRunners : []),
      ...(Array.isArray(project?.verificationRunners) ? project.verificationRunners : []),
      ...registeredRunners,
    ]);

    if (matchedScript) {
      resolved.push({
        projectId: item.projectId,
        capability: item.capability,
        script: matchedScript,
      });
    } else if (matchedRunner) {
      resolved.push({
        projectId: item.projectId,
        capability: item.capability,
        runner: String(matchedRunner.id ?? matchedRunner.runner),
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
    contractVersion: 2,
    required: baseRequired,
    resolved,
    waived: Array.isArray(intent?.waived) ? intent.waived : [],
    missing,
    status,
  };
}

export function validateVerificationCoverage({ intent, planNodes = [], integrationVerification = [] } = {}) {
  if (!intent) {
    return {
      valid: false,
      code: "VERIFICATION_INTENT_MISSING",
      missingCoverage: [],
      error: "Verification intent wajib ada pada governed plan.",
    };
  }

  if (intent.status === "NEEDS_CLARIFICATION" || (Array.isArray(intent.missing) && intent.missing.length > 0)) {
    return {
      valid: false,
      code: "VERIFICATION_INTENT_UNRESOLVED",
      missingCoverage: intent.missing || [],
      error: `Verification intent belum teresolusi: ${(intent.missing || []).map((m) => m.capability || m.requestedAs).join(", ")}`,
    };
  }

  const allowedStatuses = ["RESOLVED", "RESOLVED_WITH_WAIVERS"];
  if (!allowedStatuses.includes(intent.status)) {
    return {
      valid: false,
      code: "VERIFICATION_INTENT_INVALID_STATUS",
      missingCoverage: [],
      error: `Status verification intent tidak valid: ${intent.status}`,
    };
  }

  const resolvedList = Array.isArray(intent.resolved) ? intent.resolved : [];
  const waivedList = Array.isArray(intent.waived) ? intent.waived : [];
  if (intent.contractVersion === 2) {
    const requiredList = Array.isArray(intent.required) ? intent.required : [];
    const invalidResolution = resolvedList.find((item) => item.script && !scriptSupportsCapability(item.capability, item.script));
    if (invalidResolution) {
      return {
        valid: false,
        code: "VERIFICATION_CAPABILITY_MISMATCH",
        missingCoverage: [invalidResolution],
        error: `Script ${invalidResolution.script} tidak cocok dengan capability ${invalidResolution.capability}.`,
      };
    }
    const invalidWaiver = waivedList.find((item) => !String(item.reason ?? "").trim() || !String(item.waivedBy ?? "").trim() || !Number.isFinite(Date.parse(item.waivedAt)));
    if (invalidWaiver) {
      return {
        valid: false,
        code: "VERIFICATION_WAIVER_INVALID",
        missingCoverage: [invalidWaiver],
        error: "Waiver verifikasi wajib memiliki reason, waivedBy, dan waivedAt yang valid.",
      };
    }
    const incorrectlyAccounted = requiredList.filter((required) => {
      const matches = (item) => item.projectId === required.projectId && item.capability === required.capability;
      return resolvedList.filter(matches).length + waivedList.filter(matches).length !== 1;
    });
    if (incorrectlyAccounted.length > 0) {
      return {
        valid: false,
        code: "VERIFICATION_REQUIREMENT_UNACCOUNTED",
        missingCoverage: incorrectlyAccounted,
        error: `Requirement verifikasi wajib memiliki tepat satu resolution atau waiver: ${incorrectlyAccounted.map((item) => `${item.projectId}:${item.capability}`).join(", ")}`,
      };
    }
  }
  if (resolvedList.length === 0) {
    return { valid: true, missingCoverage: [] };
  }

  const executedScriptsByProject = new Map();
  const globalIntegrationTargets = new Set();

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
      const separator = text.indexOf(":");
      const pid = text.slice(0, separator);
      const script = text.slice(separator + 1);
      if (planNodes.some((node) => String(node?.projectId ?? "") === pid)) addExecuted(pid, script);
      else globalIntegrationTargets.add(text);
    } else if (text) globalIntegrationTargets.add(text);
  }

  const missingCoverage = [];

  for (const req of resolvedList) {
    const executed = executedScriptsByProject.get(req.projectId);
    const target = req.script ?? req.runner;
    if (!target || (!executed?.has(target) && !globalIntegrationTargets.has(target) && !globalIntegrationTargets.has(`${req.projectId}:${target}`))) {
      missingCoverage.push({
        projectId: req.projectId,
        capability: req.capability,
        script: target,
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

export const VERIFICATION_DECISION_ACTIONS = Object.freeze([
  "SELECT_SCRIPT",
  "SELECT_RUNNER",
  "WAIVE",
  "CANCEL",
]);

export function resolveVerificationDecision({
  intent,
  decision = {},
  projectContexts = [],
  now = new Date(),
} = {}) {
  if (!intent) {
    throw new Error("Intent wajib diisi untuk menerapkan decision.");
  }
  const action = String(decision.action ?? "").trim().toUpperCase();
  if (!VERIFICATION_DECISION_ACTIONS.includes(action)) {
    throw new Error(`Action decision verifikasi tidak valid: ${decision.action}`);
  }

  const targetProjectId = String(decision.projectId ?? "").trim();
  const targetCapability = normalizeCapability(decision.capability);
  const operator = String(decision.resolvedBy ?? decision.operator ?? "").trim();
  if (!operator) {
    throw new Error("Operator identity (resolvedBy) wajib diisi untuk verifikasi decision.");
  }

  const required = Array.isArray(intent.required) ? [...intent.required] : [];
  const resolved = Array.isArray(intent.resolved) ? [...intent.resolved] : [];
  const waived = Array.isArray(intent.waived) ? [...intent.waived] : [];
  let missing = Array.isArray(intent.missing) ? [...intent.missing] : [];
  const targetRequirement = missing.find((item) => item.projectId === targetProjectId && item.capability === targetCapability)
    ?? required.find((item) => item.projectId === targetProjectId && item.capability === targetCapability);
  if (action !== "CANCEL" && !targetRequirement) {
    throw new Error(`Requirement verifikasi tidak ditemukan: ${targetProjectId}:${targetCapability}`);
  }
  const project = projectContexts.find((item) => String(item?.projectId ?? item?.id ?? "") === targetProjectId) ?? null;
  const registeredScripts = project ? new Set([
    ...(Array.isArray(project.verification) ? project.verification : []),
    ...(Array.isArray(project.verificationScripts) ? project.verificationScripts : []),
    ...(Array.isArray(project.availableScripts) ? project.availableScripts : []),
  ].map(String)) : null;

  if (action === "SELECT_SCRIPT") {
    const script = String(decision.selectedTarget ?? decision.script ?? "").trim();
    if (!script) {
      throw new Error("selectedTarget (script) wajib diisi untuk action SELECT_SCRIPT.");
    }
    if (!project) {
      throw new Error(`Registry project tidak tersedia untuk memvalidasi script ${targetProjectId}.`);
    }
    if (!registeredScripts.has(script)) {
      throw new Error(`Script verifikasi tidak terdaftar untuk project ${targetProjectId}: ${script}`);
    }
    if (!scriptSupportsCapability(targetCapability, script)) {
      throw new Error(`Script ${script} tidak cocok dengan capability ${targetCapability}.`);
    }
    missing = missing.filter((m) => !(m.projectId === targetProjectId && m.capability === targetCapability));
    if (!resolved.some((r) => r.projectId === targetProjectId && r.capability === targetCapability && r.script === script)) {
      resolved.push({
        projectId: targetProjectId,
        capability: targetCapability,
        script,
        source: "OPERATOR_DECISION",
        resolvedBy: operator,
        resolvedAt: now.toISOString(),
      });
    }
  } else if (action === "SELECT_RUNNER") {
    const runner = String(decision.selectedTarget ?? decision.runner ?? "").trim();
    if (!runner) {
      throw new Error("selectedTarget (runner) wajib diisi untuk action SELECT_RUNNER.");
    }
    if (!project) {
      throw new Error(`Registry project tidak tersedia untuk memvalidasi runner ${targetProjectId}.`);
    }
    const registeredRunners = new Set([
      ...(Array.isArray(project?.registeredRunners) ? project.registeredRunners : []),
      ...(Array.isArray(project?.verificationRunners) ? project.verificationRunners : []),
    ].map((item) => String(item?.id ?? item)));
    if (!registeredRunners.has(runner)) {
      throw new Error(`Runner verifikasi tidak terdaftar untuk project ${targetProjectId}: ${runner}`);
    }
    missing = missing.filter((m) => !(m.projectId === targetProjectId && m.capability === targetCapability));
    if (!resolved.some((r) => r.projectId === targetProjectId && r.capability === targetCapability)) {
      resolved.push({
        projectId: targetProjectId,
        capability: targetCapability,
        runner,
        source: "REGISTERED_RUNNER",
        resolvedBy: operator,
        resolvedAt: now.toISOString(),
      });
    }
  } else if (action === "WAIVE") {
    const reason = String(decision.reason ?? "").trim();
    if (!reason) {
      throw new Error("Reason wajib diisi untuk waiving verification requirement.");
    }
    missing = missing.filter((m) => !(m.projectId === targetProjectId && m.capability === targetCapability));
    waived.push({
      projectId: targetProjectId,
      capability: targetCapability,
      reason,
      waivedBy: operator,
      waivedAt: now.toISOString(),
    });
  } else if (action === "CANCEL") {
    return {
      ...intent,
      status: "CANCELLED",
      cancelledBy: operator,
      cancelledAt: now.toISOString(),
      cancellationReason: decision.reason || "Cancelled by operator",
    };
  }

  let status = "RESOLVED";
  if (missing.length > 0) {
    status = "NEEDS_CLARIFICATION";
  } else if (waived.length > 0) {
    status = "RESOLVED_WITH_WAIVERS";
  }

  return {
    contractVersion: 2,
    required,
    resolved,
    waived,
    missing,
    status,
  };
}
