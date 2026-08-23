import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendAuditEntry } from "./audit-chain.mjs";
import { splitTableRow } from "./core.mjs";

export const PROJECT_RELATIONSHIP_SCHEMA_VERSION = 1;
export const PROJECT_RELATIONSHIP_TYPES = Object.freeze([
  "CONSUMES_API",
  "PROVIDES_API",
  "SHARES_SCHEMA",
  "DEPENDS_ON",
  "DEPLOYS_WITH",
]);

const INVERSE_RELATIONSHIP_TYPES = Object.freeze({
  CONSUMES_API: "PROVIDES_API",
  PROVIDES_API: "CONSUMES_API",
  SHARES_SCHEMA: "SHARES_SCHEMA",
  DEPLOYS_WITH: "DEPLOYS_WITH",
});

function relationshipError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code === "HUMAN_CONFIRMATION_REQUIRED" ? 409 : 400;
  if (details) error.details = details;
  return error;
}

function safeProjectId(value, field = "projectId") {
  const projectId = String(value ?? "").trim();
  if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId) || [".", ".."].includes(projectId)) {
    throw relationshipError(`${field} tidak valid: ${value || "EMPTY"}.`, "INVALID_PROJECT_ID");
  }
  return projectId;
}

function safeStringList(values, field) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw relationshipError(`${field} harus berupa array.`, "INVALID_RELATIONSHIP_FIELD");
  return [...new Set(values.map((value) => {
    const item = String(value ?? "").trim();
    if (!item || /[\r\n\0]/.test(item)) throw relationshipError(`${field} mengandung nilai tidak valid.`, "INVALID_RELATIONSHIP_FIELD");
    return item;
  }))].sort((left, right) => left.localeCompare(right));
}

function normalizeRelationship(value, { sourceProjectId, registeredProjectIds }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw relationshipError("Setiap relationship harus berupa object.", "INVALID_RELATIONSHIP");
  }
  const type = String(value.type ?? "").trim().toUpperCase();
  if (!PROJECT_RELATIONSHIP_TYPES.includes(type)) {
    throw relationshipError(`Relationship type tidak didukung: ${type || "EMPTY"}.`, "INVALID_RELATIONSHIP_TYPE", { allowedTypes: PROJECT_RELATIONSHIP_TYPES });
  }
  const targetProjectId = safeProjectId(value.targetProjectId, "targetProjectId");
  if (targetProjectId === sourceProjectId) {
    throw relationshipError("Project tidak dapat memiliki relationship ke dirinya sendiri.", "SELF_RELATIONSHIP");
  }
  if (!registeredProjectIds.has(targetProjectId)) {
    throw relationshipError(`Target project belum terdaftar: ${targetProjectId}.`, "TARGET_PROJECT_NOT_REGISTERED", { targetProjectId });
  }
  return {
    type,
    targetProjectId,
    contractPaths: safeStringList(value.contractPaths, "contractPaths"),
    verification: safeStringList(value.verification, "verification"),
  };
}

function relationshipKey(relationship) {
  return JSON.stringify(relationship);
}

function normalizeRelationships(values, options) {
  if (!Array.isArray(values)) throw relationshipError("relationships harus berupa array.", "INVALID_RELATIONSHIPS");
  const unique = new Map();
  for (const value of values) {
    const normalized = normalizeRelationship(value, options);
    unique.set(relationshipKey(normalized), normalized);
  }
  return [...unique.values()].sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
}

function rawCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function registryRows(content) {
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim().startsWith("|")) return [];
    const cells = splitTableRow(line);
    if (cells.length < 6 || cells[0] === "project_id" || /^-+$/.test(cells[0])) return [];
    return [{
      index,
      id: cells[0],
      cells,
      relationships: parseRelationshipCell(cells[6] ?? "[]", cells[0]),
    }];
  });
}

function parseRelationshipCell(value, projectId) {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) throw new Error("relationships harus berupa array");
    return parsed;
  } catch (error) {
    throw relationshipError(`Metadata relationships project ${projectId} tidak valid: ${error.message}.`, "INVALID_REGISTRY_RELATIONSHIPS");
  }
}

function readRegistry(vaultRoot) {
  const registryPath = path.join(vaultRoot, "project-registry.md");
  if (!fs.existsSync(registryPath)) throw relationshipError("project-registry.md tidak ditemukan.", "REGISTRY_NOT_FOUND");
  const content = fs.readFileSync(registryPath, "utf8");
  const rows = registryRows(content);
  if (rows.length === 0) throw relationshipError("Tabel project registry tidak dapat ditemukan.", "REGISTRY_TABLE_NOT_FOUND");
  return { registryPath, content, rows };
}

function projectRow(registry, projectId) {
  const row = registry.rows.find((candidate) => candidate.id === projectId);
  if (!row) throw relationshipError(`Project ${projectId} tidak ditemukan di project-registry.md.`, "PROJECT_NOT_REGISTERED", { projectId });
  return row;
}

function inverseRelationship(relationship, sourceProjectId) {
  const inverseType = INVERSE_RELATIONSHIP_TYPES[String(relationship?.type ?? "").toUpperCase()];
  if (!inverseType || !relationship?.targetProjectId) return null;
  return {
    type: inverseType,
    targetProjectId: sourceProjectId,
    contractPaths: Array.isArray(relationship.contractPaths) ? [...relationship.contractPaths] : [],
    verification: Array.isArray(relationship.verification) ? [...relationship.verification] : [],
  };
}

function effectiveRelationships(registry, projectId, explicitRelationships) {
  const relationships = [...explicitRelationships];
  for (const row of registry.rows) {
    if (row.id === projectId) continue;
    for (const relationship of row.relationships) {
      if (relationship?.targetProjectId !== projectId) continue;
      const inverse = inverseRelationship(relationship, row.id);
      if (inverse) relationships.push(inverse);
    }
  }
  return normalizeRelationships(relationships, {
    sourceProjectId: projectId,
    registeredProjectIds: new Set(registry.rows.map((candidate) => candidate.id)),
  });
}

function inverseConflict({ sourceProjectId, relationship, rows }) {
  const inverseType = INVERSE_RELATIONSHIP_TYPES[relationship.type];
  for (const row of rows) {
    if (row.id === sourceProjectId) continue;
    for (const existing of row.relationships) {
      if (existing?.targetProjectId !== sourceProjectId || String(existing.type ?? "").toUpperCase() !== inverseType) continue;
      if (relationship.targetProjectId !== row.id) continue;
      return {
        sourceProjectId: row.id,
        targetProjectId: sourceProjectId,
        type: existing.type,
        inverseType: relationship.type,
      };
    }
  }
  return null;
}

function registryWithRelationships(registry, row, relationships) {
  const lines = registry.content.split(/\r?\n/);
  const cells = rawCells(lines[row.index]);
  while (cells.length < 7) cells.push("");
  cells[6] = `\`${JSON.stringify(relationships)}\``;
  lines[row.index] = `| ${cells.join(" | ")} |`;

  const headerIndex = lines.findIndex((line) => {
    if (!line.trim().startsWith("|")) return false;
    return splitTableRow(line)[0] === "project_id";
  });
  if (headerIndex < 0) throw relationshipError("Header project registry tidak dapat ditemukan.", "REGISTRY_HEADER_NOT_FOUND");
  const headerCells = rawCells(lines[headerIndex]);
  if (headerCells.length < 7) {
    headerCells.push("relationships");
    lines[headerIndex] = `| ${headerCells.join(" | ")} |`;
    const separatorIndex = lines.findIndex((line, index) => index > headerIndex && /^\s*\|/.test(line) && splitTableRow(line).every((cell) => /^-+$/.test(cell)));
    if (separatorIndex >= 0) {
      const separatorCells = rawCells(lines[separatorIndex]);
      while (separatorCells.length < 7) separatorCells.push("---");
      lines[separatorIndex] = `| ${separatorCells.join(" | ")} |`;
    }
  }
  return lines.join("\n");
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.partial`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function relationshipsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function getProjectRelationships({ vaultRoot, projectId: requestedProjectId } = {}) {
  const projectId = safeProjectId(requestedProjectId);
  const registry = readRegistry(vaultRoot);
  const row = projectRow(registry, projectId);
  const relationships = normalizeRelationships(row.relationships, {
    sourceProjectId: projectId,
    registeredProjectIds: new Set(registry.rows.map((candidate) => candidate.id)),
  });
  const effective = effectiveRelationships(registry, projectId, relationships);
  const incomingRelationships = effective.filter((relationship) => !relationships.some((explicit) => relationshipKey(explicit) === relationshipKey(relationship)));
  return {
    schemaVersion: PROJECT_RELATIONSHIP_SCHEMA_VERSION,
    projectId,
    relationships,
    incomingRelationships,
    effectiveRelationships: effective,
    allowedTypes: PROJECT_RELATIONSHIP_TYPES,
    registeredProjectIds: registry.rows.map((candidate) => candidate.id).sort(),
  };
}

export function replaceProjectRelationships({
  vaultRoot,
  runsRoot,
  projectId: requestedProjectId,
  relationships,
  confirmed = false,
  confirmedBy = null,
  now = new Date(),
} = {}) {
  const projectId = safeProjectId(requestedProjectId);
  if (confirmed !== true || !String(confirmedBy ?? "").trim()) {
    throw relationshipError("Mengubah project relationship membutuhkan konfirmasi human operator.", "HUMAN_CONFIRMATION_REQUIRED");
  }
  if (!runsRoot) throw relationshipError("runsRoot wajib untuk audit relationship.", "AUDIT_ROOT_REQUIRED");
  const registry = readRegistry(vaultRoot);
  const row = projectRow(registry, projectId);
  const registeredProjectIds = new Set(registry.rows.map((candidate) => candidate.id));
  const normalized = normalizeRelationships(relationships, { sourceProjectId: projectId, registeredProjectIds });
  const previous = normalizeRelationships(row.relationships, { sourceProjectId: projectId, registeredProjectIds });
  for (const relationship of normalized) {
    const conflict = inverseConflict({ sourceProjectId: projectId, relationship, rows: registry.rows });
    if (conflict) throw relationshipError(
      `Inverse relationship sudah terdaftar secara eksplisit: ${conflict.sourceProjectId} ${conflict.type} ${conflict.targetProjectId}.`,
      "INVERSE_RELATIONSHIP_CONFLICT",
      conflict,
    );
  }

  const changed = !relationshipsEqual(previous, normalized);
  const action = changed ? "PROJECT_RELATIONSHIPS_REPLACED" : "PROJECT_RELATIONSHIPS_CONFIRMED_NOOP";
  const updatedContent = changed ? registryWithRelationships(registry, row, normalized) : null;
  if (changed) {
    try {
      writeAtomic(registry.registryPath, updatedContent);
    } catch (error) {
      throw new Error(`Project relationship gagal disimpan: ${error.message}`);
    }
  }
  let audit;
  try {
    audit = appendAuditEntry(runsRoot, {
      event: action,
      actor: String(confirmedBy).trim(),
      projectId,
      relationshipCount: normalized.length,
      targetProjectIds: normalized.map((relationship) => relationship.targetProjectId),
      relationshipTypes: normalized.map((relationship) => relationship.type),
      at: now.toISOString(),
    });
  } catch (error) {
    if (changed) writeAtomic(registry.registryPath, registry.content);
    throw new Error(`Project relationship audit gagal disimpan: ${error.message}`);
  }
  return {
    schemaVersion: PROJECT_RELATIONSHIP_SCHEMA_VERSION,
    action,
    changed,
    projectId,
    relationships: normalized,
    confirmedBy: String(confirmedBy).trim(),
    audit: { auditId: audit.auditId, event: audit.event, at: audit.at },
  };
}
