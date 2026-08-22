import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_MANIFEST_KIND = "personal-ai-os-v1-release-manifest";

function sha256File(filePath) { return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function sha256Text(value) { return createHash("sha256").update(value).digest("hex"); }
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function absoluteRoot(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(label + " harus berupa absolute path.");
  return path.resolve(value);
}
function packageVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null; } catch { return null; }
}
function gitCommit(root) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; }
}
function gitClean(root) {
  try { return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === ""; } catch { return false; }
}
function lockEvidence(root, label) {
  const lockPath = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockPath)) return { label, lockPath, exists: false, sha256: null };
  return { label, lockPath: path.resolve(lockPath), exists: true, sha256: sha256File(lockPath) };
}
function writePrivate(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + "\n";
  const temporary = filePath + "." + randomUUID() + ".partial";
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  const checksum = sha256Text(text);
  fs.writeFileSync(filePath + ".sha256", checksum + "  " + path.basename(filePath) + "\n", { encoding: "utf8", mode: 0o600 });
  return { filePath, checksum };
}

export function createReleaseManifest({
  sourceRoot,
  dashboardRoot,
  vaultRoot,
  runsRoot,
  backupRoot,
  releaseVersion = "1.0.0",
  now = new Date(),
  sourceCommit = process.env.ORCHESTRATOR_RELEASE_COMMIT ?? null,
} = {}) {
  const source = absoluteRoot(sourceRoot, "sourceRoot");
  const dashboard = absoluteRoot(dashboardRoot, "dashboardRoot");
  const vault = absoluteRoot(vaultRoot, "vaultRoot");
  const runs = absoluteRoot(runsRoot, "runsRoot");
  const backup = absoluteRoot(backupRoot, "backupRoot");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(releaseVersion))) throw new Error("releaseVersion harus berupa semver.");
  if (isInside(vault, backup) || isInside(runs, backup)) throw new Error("backupRoot harus berada di luar Vault dan runtime roots.");
  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: RELEASE_MANIFEST_KIND,
    releaseVersion: String(releaseVersion),
    generatedAt: now.toISOString(),
    provenance: {
      sourceCommit: sourceCommit ? String(sourceCommit) : gitCommit(source),
      dashboardCommit: gitCommit(dashboard),
      backendVersion: packageVersion(source),
      dashboardVersion: packageVersion(dashboard),
      repositoriesClean: { backend: gitClean(source), dashboard: gitClean(dashboard) },
    },
    supportedHost: { platforms: ["darwin"], architectures: ["arm64", "x64"], node: { minimumMajor: 18, maximumMajor: 26 } },
    dependencies: { packageManager: "npm", installCommand: "npm ci --ignore-scripts --no-audit --no-fund", locks: [lockEvidence(source, "backend"), lockEvidence(dashboard, "dashboard")] },
    paths: { sourceRoot: source, dashboardRoot: dashboard, vaultRoot: vault, runsRoot: runs, backupRoot: backup },
    installation: { startCommand: "./start.sh", healthCommand: "node src/orchestrator.mjs operations-readiness", bindsTo: "127.0.0.1", dataRootsCreatedAutomatically: true },
    uninstall: { command: "./start.sh stop", preservesDataByDefault: true, removesLaunchAgent: true, purgeDataRequiresExplicitConfirmation: true, retainedRoots: [vault, runs, backup] },
    rollback: { backupRequired: true, authority: "EXTERNAL_SUPERVISOR", steps: ["Stop services with ./start.sh stop.", "Verify the last independent backup and checksum.", "Restore to a new quarantine target.", "Run health, audit, and compatibility checks.", "Promote only after explicit human confirmation."] },
    policy: { localOnly: true, productionActivationHumanGate: true, selfApprovalAllowed: false, publicNetworkExposure: false },
  };
  return { ...manifest, checksum: sha256Text(JSON.stringify(manifest, null, 2) + "\n") };
}

export function writeReleaseManifest({ runsRoot, ...options } = {}) {
  const manifest = createReleaseManifest({ runsRoot, ...options });
  const filePath = path.join(absoluteRoot(runsRoot, "runsRoot"), "runtime", "release-manifest", "v" + manifest.releaseVersion + ".json");
  const persisted = writePrivate(filePath, manifest);
  return { ...manifest, manifestPath: persisted.filePath, checksum: persisted.checksum };
}

export function verifyReleaseManifest({ manifest, manifestPath = null, now = new Date() } = {}) {
  let candidate = manifest;
  let checksumValid = true;
  let sidecarChecksum = null;
  if (!candidate && manifestPath) {
    const text = fs.readFileSync(manifestPath, "utf8");
    candidate = JSON.parse(text);
    try { sidecarChecksum = fs.readFileSync(manifestPath + ".sha256", "utf8").trim().split(/\s+/)[0]; } catch { sidecarChecksum = null; }
    checksumValid = sidecarChecksum === sha256Text(text);
  }
  const errors = [];
  if (!candidate || candidate.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION || candidate.kind !== RELEASE_MANIFEST_KIND) errors.push("manifest schema/kind tidak kompatibel");
  const roots = candidate?.paths ?? {};
  for (const key of ["sourceRoot", "dashboardRoot", "vaultRoot", "runsRoot", "backupRoot"]) if (!roots[key] || !path.isAbsolute(roots[key])) errors.push(key + " bukan absolute path");
  if (roots.vaultRoot && roots.backupRoot && isInside(roots.vaultRoot, roots.backupRoot)) errors.push("backupRoot berada di dalam vaultRoot");
  if (roots.runsRoot && roots.backupRoot && isInside(roots.runsRoot, roots.backupRoot)) errors.push("backupRoot berada di dalam runsRoot");
  const major = Number(process.versions.node.split(".")[0]);
  if (candidate?.supportedHost && (!candidate.supportedHost.platforms.includes(process.platform) || !candidate.supportedHost.architectures.includes(process.arch) || major < candidate.supportedHost.node.minimumMajor || major > candidate.supportedHost.node.maximumMajor)) errors.push("host tidak didukung oleh release manifest");
  for (const lock of candidate?.dependencies?.locks ?? []) {
    if (!lock.exists) errors.push(lock.label + " lockfile tidak ditemukan");
    else if (!fs.existsSync(lock.lockPath)) errors.push(lock.label + " lockfile hilang");
    else if (sha256File(lock.lockPath) !== lock.sha256) errors.push(lock.label + " lockfile checksum berubah");
  }
  if (!candidate?.provenance?.sourceCommit) errors.push("backend commit tidak tercatat");
  if (!candidate?.provenance?.dashboardCommit) errors.push("dashboard commit tidak tercatat");
  if (candidate?.provenance?.backendVersion !== candidate?.releaseVersion) errors.push("backend version tidak sama dengan releaseVersion");
  if (candidate?.provenance?.dashboardVersion !== candidate?.releaseVersion) errors.push("dashboard version tidak sama dengan releaseVersion");
  if (candidate?.paths?.sourceRoot && !fs.existsSync(path.join(candidate.paths.sourceRoot, "start.sh"))) errors.push("start.sh tidak ditemukan");
  const valid = errors.length === 0 && checksumValid;
  return { valid, checksumValid, sidecarChecksum, checkedAt: now.toISOString(), errors, manifest: candidate ?? null };
}

export function verifyReleaseManifestFile({ manifestPath, now = new Date() } = {}) {
  if (!manifestPath || !path.isAbsolute(manifestPath) || !fs.existsSync(manifestPath)) throw new Error("Manifest release tidak ditemukan.");
  return verifyReleaseManifest({ manifestPath, now });
}
