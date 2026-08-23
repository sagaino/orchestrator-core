import fs from "node:fs";
import path from "node:path";

export const OPERATIONS_ARTIFACT_SCHEMA_VERSION = 1;

export const OPERATIONS_ARTIFACT_COLLECTIONS = Object.freeze([
  { id: "objectives", dataset: "runs", pathPrefix: "objectives", kind: "DURABLE_OBJECTIVES", stateField: "state", activeStates: new Set(["DRAFT", "GENESIS_REVIEW", "ONBOARDING", "PLANNING", "NEEDS_CLARIFICATION", "PLAN_REVIEW", "APPROVED", "MATERIALIZING", "RUNNING", "INTEGRATING", "BLOCKED", "RESULT_REVIEW", "FAILED"]) },
  { id: "plans", dataset: "runs", pathPrefix: "plans", kind: "DURABLE_PLANS", stateField: "state", activeStates: new Set(["PENDING_APPROVAL", "APPROVED"]) },
  { id: "orchestrations", dataset: "runs", pathPrefix: "orchestrations", kind: "DURABLE_ORCHESTRATIONS", stateField: "state", activeStates: new Set(["CREATED", "RUNNING", "INTEGRATING", "BLOCKED"]) },
  { id: "decisions", dataset: "runs", pathPrefix: "decisions", kind: "DURABLE_DECISIONS", stateField: "state", activeStates: new Set(["OPEN"]) },
  { id: "integration", dataset: "runs", pathPrefix: "integration", kind: "INTEGRATION_ARTIFACTS", stateField: null, activeStates: new Set() },
]);

function normalizeRelative(value) {
  return String(value).split(path.sep).join("/").replace(/^\.\//, "");
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function entriesBelow(entries, prefix) {
  return entries.filter((entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`));
}

function summarizeEntries({ entries, rootPath, sourceLabel, definition, backupPath = null }) {
  const scoped = entriesBelow(entries, definition.pathPrefix);
  const files = scoped.filter((entry) => entry.type === "file");
  const directRecords = files.filter((entry) => definition.stateField && entry.path.startsWith(`${definition.pathPrefix}/`) && !entry.path.slice(definition.pathPrefix.length + 1).includes("/"));
  const activePaths = [];
  for (const entry of directRecords) {
    const absolute = backupPath
      ? path.join(backupPath, "data", definition.dataset, ...entry.path.split("/"))
      : path.join(rootPath, ...entry.path.split("/"));
    const record = readJson(absolute);
    if (record && definition.activeStates.has(record[definition.stateField])) activePaths.push(normalizeRelative(entry.path));
  }
  const bytes = files.reduce((sum, entry) => sum + Number(entry.sizeBytes ?? 0), 0);
  return {
    kind: definition.kind,
    dataset: definition.dataset,
    pathPrefix: definition.pathPrefix,
    present: scoped.length > 0,
    included: true,
    fileCount: files.length,
    bytes,
    recordCount: definition.stateField ? directRecords.length : null,
    activeRecordCount: activePaths.length,
    activePaths,
    source: sourceLabel,
  };
}

function walkFiles(rootPath, relativeDirectory = "", output = []) {
  if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) return output;
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolute = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(absolute, relative, output);
    else if (entry.isFile()) output.push({ path: normalizeRelative(relative), type: "file", sizeBytes: fs.statSync(absolute).size });
  }
  return output;
}

function sourceEntries(runsRoot) {
  return walkFiles(runsRoot).map((entry) => ({ ...entry, path: normalizeRelative(entry.path) }));
}

function coverageResult({ entries, rootPath, sourceLabel, backupPath = null }) {
  const collections = Object.fromEntries(OPERATIONS_ARTIFACT_COLLECTIONS.map((definition) => [
    definition.id,
    summarizeEntries({ entries, rootPath, sourceLabel, definition, backupPath }),
  ]));
  const all = Object.values(collections);
  const activePaths = all.flatMap((item) => item.activePaths);
  return {
    schemaVersion: OPERATIONS_ARTIFACT_SCHEMA_VERSION,
    requiredCollections: OPERATIONS_ARTIFACT_COLLECTIONS.map((item) => item.id),
    complete: all.every((item) => item.included),
    activeStateNeverPurged: true,
    protectedActiveRecordCount: activePaths.length,
    protectedActivePaths: activePaths,
    collections,
    totals: {
      fileCount: all.reduce((sum, item) => sum + item.fileCount, 0),
      bytes: all.reduce((sum, item) => sum + item.bytes, 0),
      recordCount: all.reduce((sum, item) => sum + Number(item.recordCount ?? 0), 0),
    },
  };
}

export function summarizeOperationsArtifacts({ runsRoot } = {}) {
  if (!runsRoot) throw new Error("summarizeOperationsArtifacts membutuhkan runsRoot.");
  return coverageResult({ entries: sourceEntries(runsRoot), rootPath: path.resolve(runsRoot), sourceLabel: path.resolve(runsRoot) });
}

export function summarizeBackupArtifactCoverage({ manifest, backupPath } = {}) {
  if (!manifest || !backupPath) throw new Error("summarizeBackupArtifactCoverage membutuhkan manifest dan backupPath.");
  const runsDataset = (manifest.datasets ?? []).find((dataset) => dataset.dataset === "runs");
  const entries = (runsDataset?.entries ?? []).map((entry) => ({ ...entry, path: normalizeRelative(entry.path) }));
  return coverageResult({ entries, rootPath: null, sourceLabel: path.resolve(backupPath), backupPath: path.resolve(backupPath) });
}

export function assertBackupArtifactCoverage({ manifest, backupPath } = {}) {
  const coverage = summarizeBackupArtifactCoverage({ manifest, backupPath });
  if (!coverage.complete) {
    const error = new Error("Backup artifact coverage tidak lengkap.");
    error.code = "BACKUP_ARTIFACT_COVERAGE_INCOMPLETE";
    error.details = coverage;
    throw error;
  }
  return coverage;
}
