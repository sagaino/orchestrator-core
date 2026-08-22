/**
 * P6.0: versioned release compatibility contract.
 *
 * This module is intentionally descriptive and fail-closed. It does not
 * activate a release, migrate data, or accept a candidate on behalf of a
 * human. Those actions belong to the external supervisor and later phases.
 */

export const RELEASE_CONTRACT_VERSION = "p6.0-2026-08-22";
export const RELEASE_MANIFEST_KIND = "personal-ai-os-release-manifest";
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RUNTIME_COMPATIBILITY_VERSION = "1.0";
export const API_COMPATIBILITY_VERSION = "1.0";
export const DASHBOARD_COMPATIBILITY_VERSION = "1.0";
export const VAULT_SCHEMA_VERSION = 1;
export const ROLLBACK_PROTOCOL_VERSION = 1;

export const RELEASE_COMPATIBILITY = Object.freeze({
  contractVersion: RELEASE_CONTRACT_VERSION,
  manifestSchemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
  runtime: { compatibilityVersion: RUNTIME_COMPATIBILITY_VERSION },
  api: { compatibilityVersion: API_COMPATIBILITY_VERSION },
  dashboard: { compatibilityVersion: DASHBOARD_COMPATIBILITY_VERSION },
  vault: { schemaVersion: VAULT_SCHEMA_VERSION },
  rollback: { protocolVersion: ROLLBACK_PROTOCOL_VERSION },
});

export const RELEASE_ACTIVATION_POLICY = Object.freeze({
  activationAuthority: "EXTERNAL_SUPERVISOR",
  requiresHumanGate: true,
  selfAcceptAllowed: false,
  inProcessActivationAllowed: false,
  rollbackAuthority: "EXTERNAL_SUPERVISOR",
});

export const RELEASE_COMPATIBILITY_MATRIX = Object.freeze([
  Object.freeze({
    id: "same-runtime-and-data",
    current: "supported",
    candidate: "supported",
    data: "current",
    outcome: "ACTIVATION_ELIGIBLE",
    migration: "none",
  }),
  Object.freeze({
    id: "old-runtime-new-data",
    current: "old-runtime",
    candidate: "old-runtime",
    data: "new-data",
    outcome: "BLOCKED_UNTIL_COMPATIBILITY_PROVEN",
    migration: "external-only",
  }),
  Object.freeze({
    id: "new-runtime-old-data",
    current: "new-runtime",
    candidate: "new-runtime",
    data: "old-data",
    outcome: "READ_COMPATIBLE_MIGRATION_REQUIRED",
    migration: "external-checkpoint-before-write",
  }),
  Object.freeze({
    id: "incompatible-components",
    current: "any",
    candidate: "incompatible",
    data: "any",
    outcome: "REJECT_BEFORE_ACTIVATION",
    migration: "none",
  }),
]);

function nonEmpty(value, field, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${field} must be a non-empty string`);
}

function positiveInteger(value, field, errors) {
  if (!Number.isInteger(value) || value < 1) errors.push(`${field} must be a positive integer`);
}

export function validateReleaseManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Release manifest must be a non-null object"] };
  }
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) errors.push("Unsupported release manifest schemaVersion");
  if (manifest.kind !== RELEASE_MANIFEST_KIND) errors.push("Invalid release manifest kind");
  nonEmpty(manifest.releaseId, "releaseId", errors);
  nonEmpty(manifest.contractVersion, "contractVersion", errors);
  if (manifest.contractVersion !== RELEASE_CONTRACT_VERSION) errors.push("Release contract version mismatch");

  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== "object") errors.push("runtime metadata is required");
  else {
    nonEmpty(runtime.version, "runtime.version", errors);
    if (runtime.compatibilityVersion !== RUNTIME_COMPATIBILITY_VERSION) errors.push("Unsupported runtime compatibility version");
  }
  const api = manifest.api;
  if (!api || api.compatibilityVersion !== API_COMPATIBILITY_VERSION) errors.push("Unsupported API compatibility version");
  const dashboard = manifest.dashboard;
  if (!dashboard || dashboard.compatibilityVersion !== DASHBOARD_COMPATIBILITY_VERSION) errors.push("Unsupported dashboard compatibility version");

  const vault = manifest.vault;
  if (!vault || typeof vault !== "object") errors.push("vault metadata is required");
  else positiveInteger(vault.schemaVersion, "vault.schemaVersion", errors);
  if (vault?.schemaVersion !== VAULT_SCHEMA_VERSION) errors.push("Unsupported Vault schema version");

  const rollback = manifest.rollback;
  if (!rollback || typeof rollback !== "object") errors.push("rollback metadata is required");
  else {
    if (rollback.protocolVersion !== ROLLBACK_PROTOCOL_VERSION) errors.push("Unsupported rollback protocol version");
    if (rollback.backupRequired !== true) errors.push("rollback.backupRequired must be true");
  }

  const activation = manifest.activation;
  if (!activation || typeof activation !== "object") errors.push("activation policy is required");
  else {
    if (activation.activationAuthority !== RELEASE_ACTIVATION_POLICY.activationAuthority) errors.push("Activation authority must remain external");
    if (activation.requiresHumanGate !== true) errors.push("Human gate is required for activation");
    if (activation.selfAcceptAllowed !== false) errors.push("Self-accept is forbidden");
    if (activation.inProcessActivationAllowed !== false) errors.push("In-process activation is forbidden");
    if (activation.rollbackAuthority !== RELEASE_ACTIVATION_POLICY.rollbackAuthority) errors.push("Rollback authority must remain external");
  }

  return { valid: errors.length === 0, errors };
}

export function createReleaseManifest({
  releaseId,
  runtimeVersion,
  sourceCommit = null,
  builtAt = null,
  provenance = {},
} = {}) {
  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: RELEASE_MANIFEST_KIND,
    releaseId,
    contractVersion: RELEASE_CONTRACT_VERSION,
    runtime: { version: runtimeVersion, compatibilityVersion: RUNTIME_COMPATIBILITY_VERSION },
    api: { compatibilityVersion: API_COMPATIBILITY_VERSION },
    dashboard: { compatibilityVersion: DASHBOARD_COMPATIBILITY_VERSION },
    vault: { schemaVersion: VAULT_SCHEMA_VERSION },
    rollback: { protocolVersion: ROLLBACK_PROTOCOL_VERSION, backupRequired: true },
    activation: { ...RELEASE_ACTIVATION_POLICY },
    provenance: { sourceCommit, builtAt, ...provenance },
  };
  const validation = validateReleaseManifest(manifest);
  if (!validation.valid) throw new Error(`Generated release manifest is invalid: ${validation.errors.join(", ")}`);
  return Object.freeze(manifest);
}

export function assessReleaseCompatibility(manifest) {
  const validation = validateReleaseManifest(manifest);
  if (!validation.valid) {
    return { compatible: false, outcome: "REJECT_BEFORE_ACTIVATION", errors: validation.errors };
  }
  return {
    compatible: true,
    outcome: "ACTIVATION_ELIGIBLE",
    errors: [],
    contractVersion: RELEASE_CONTRACT_VERSION,
    activationPolicy: RELEASE_ACTIVATION_POLICY,
  };
}
