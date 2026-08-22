import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { RUNTIME_SOURCE_ITEMS } from "./updater.mjs";

export const RELEASE_DRILL_SCHEMA_VERSION = 1;
export const RELEASE_DRILL_CASES = Object.freeze([
  Object.freeze({ id: "startup-crash", expected: "ROLLBACK_OR_REJECT" }),
  Object.freeze({ id: "missing-heartbeat", expected: "ROLLBACK_OR_REJECT" }),
  Object.freeze({ id: "corrupt-manifest", expected: "ROLLBACK_OR_REJECT" }),
  Object.freeze({ id: "incompatible-schema", expected: "ROLLBACK_OR_REJECT" }),
  Object.freeze({ id: "failed-migration", expected: "ROLLBACK_OR_REJECT" }),
  Object.freeze({ id: "failed-health-probe", expected: "ROLLBACK_OR_REJECT" }),
]);

function walkFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  if (fs.statSync(directory).isFile()) return [relativeDirectory.replaceAll(path.sep, "/")];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const absolute = path.join(root, relative);
    if (entry.isDirectory()) return walkFiles(root, relative);
    if (entry.isFile()) return [relative.replaceAll(path.sep, "/")];
    return [];
  }).sort((left, right) => left.localeCompare(right));
}

export function snapshotRuntimeSource({ sourceRoot, items = RUNTIME_SOURCE_ITEMS } = {}) {
  const files = [];
  for (const item of items) {
    const absolute = path.join(sourceRoot, item);
    if (fs.existsSync(absolute)) {
      for (const relative of walkFiles(sourceRoot, item)) {
        const fullPath = path.join(sourceRoot, relative);
        files.push({ path: relative, sha256: createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex") });
      }
    }
  }
  const canonical = JSON.stringify(files);
  return {
    files,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

export async function runReleaseDrill({ caseId, sourceRoot, execute } = {}) {
  const definition = RELEASE_DRILL_CASES.find((item) => item.id === caseId);
  if (!definition) throw new Error(`Unknown release drill: ${caseId}`);
  const before = snapshotRuntimeSource({ sourceRoot });
  let result = null;
  let error = null;
  try { result = await execute(); }
  catch (caught) { error = caught; }
  const after = snapshotRuntimeSource({ sourceRoot });
  const failureObserved = Boolean(error) || result?.success === false || result?.update?.success === false;
  const stableRestored = before.sha256 === after.sha256;
  const diagnostics = {
    error: error ? { code: error.code ?? null, message: String(error.message ?? error), details: error.details ?? null } : null,
    result: result ?? null,
  };
  return {
    schemaVersion: RELEASE_DRILL_SCHEMA_VERSION,
    caseId,
    expected: definition.expected,
    status: failureObserved && stableRestored ? "PASS" : "FAIL",
    failureObserved,
    stableRestored,
    stableBeforeSha256: before.sha256,
    stableAfterSha256: after.sha256,
    diagnostics,
  };
}
