import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

export const RELEASE_ARTIFACT_SCHEMA_VERSION = 1;
export const RELEASE_ARTIFACT_KIND = "personal-ai-os-release-artifact";

function sha256File(filePath) { return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function git(root, args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function packageData(root) { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
function dependencyInventory(root) {
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  return { lockfileVersion: lock.lockfileVersion, packageCount: Object.keys(lock.packages ?? {}).length, lockSha256: sha256File(lockPath) };
}
function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = createHash("sha256").update(text).digest("hex");
  fs.writeFileSync(`${filePath}.sha256`, `${checksum}  ${path.basename(filePath)}\n`, { mode: 0o600 });
  return checksum;
}

export function buildReleaseArtifact({ repoRoot, dashboardRoot, outputRoot, releaseVersion = "1.0.0", now = new Date() } = {}) {
  for (const [label, value] of Object.entries({ repoRoot, dashboardRoot, outputRoot })) if (!value || !path.isAbsolute(value)) throw new Error(`${label} harus absolute path.`);
  const roots = { backend: path.resolve(repoRoot), dashboard: path.resolve(dashboardRoot) };
  for (const [label, root] of Object.entries(roots)) {
    if (git(root, ["status", "--porcelain"]) !== "") throw new Error(`${label} repository harus clean sebelum artifact dibangun.`);
    if (packageData(root).version !== releaseVersion) throw new Error(`${label} version tidak sama dengan releaseVersion.`);
  }
  const releaseRoot = path.join(path.resolve(outputRoot), `v${releaseVersion}`);
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  const components = [];
  for (const [label, root] of Object.entries(roots)) {
    const fileName = `${label}-v${releaseVersion}.tar`;
    const filePath = path.join(releaseRoot, fileName);
    execFileSync("git", ["archive", "--format=tar", `--output=${filePath}`, "HEAD"], { cwd: root });
    components.push({ label, fileName, sha256: sha256File(filePath), bytes: fs.statSync(filePath).size, commit: git(root, ["rev-parse", "HEAD"]), version: packageData(root).version, dependencies: dependencyInventory(root) });
  }
  const manifest = { schemaVersion: RELEASE_ARTIFACT_SCHEMA_VERSION, kind: RELEASE_ARTIFACT_KIND, releaseVersion, createdAt: now.toISOString(), reproducibleFrom: "git archive --format=tar HEAD", components };
  const manifestPath = path.join(releaseRoot, "release-artifact.json");
  const checksum = writeJson(manifestPath, manifest);
  return { ...manifest, manifestPath, checksum };
}

export function verifyReleaseArtifact({ manifestPath } = {}) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return { valid: false, errors: ["manifest missing"] };
  const text = fs.readFileSync(manifestPath, "utf8");
  let manifest;
  try { manifest = JSON.parse(text); } catch { return { valid: false, errors: ["invalid json"] }; }
  const errors = [];
  const sidecar = fs.existsSync(`${manifestPath}.sha256`) ? fs.readFileSync(`${manifestPath}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
  if (sidecar !== createHash("sha256").update(text).digest("hex")) errors.push("manifest checksum mismatch");
  if (manifest.kind !== RELEASE_ARTIFACT_KIND || manifest.schemaVersion !== RELEASE_ARTIFACT_SCHEMA_VERSION) errors.push("schema/kind mismatch");
  for (const component of manifest.components ?? []) {
    const filePath = path.join(path.dirname(manifestPath), component.fileName);
    if (!fs.existsSync(filePath) || sha256File(filePath) !== component.sha256) errors.push(`${component.label} artifact checksum mismatch`);
  }
  if ((manifest.components ?? []).length !== 2) errors.push("backend/dashboard artifacts required");
  return { valid: errors.length === 0, errors, manifest };
}
