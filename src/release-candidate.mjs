/**
 * P6.1: build and verify an isolated release candidate.
 *
 * The builder only prepares an immutable candidate directory. It never
 * replaces the stable runtime and it cannot activate or accept a release.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  createReleaseManifest,
  validateReleaseManifest,
} from "./release-contract.mjs";

export const RELEASE_CANDIDATE_SCHEMA_VERSION = 1;
export const RELEASE_CANDIDATE_MANIFEST = "candidate-manifest.json";
export const RELEASE_CANDIDATE_CHECKSUMS = "checksums.sha256";
export const DEFAULT_CANDIDATE_PATHS = Object.freeze([
  "src",
  "templates",
  "schemas",
  "package.json",
  "package-lock.json",
  "start.sh",
  "stop.sh",
  "README.md",
  "docs/PHASE_6_RELEASE_CONTRACT.md",
]);

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertDirectory(root, label) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${label} must be an existing directory.`);
}

function safeReleaseId(releaseId) {
  const value = String(releaseId ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) throw new Error("releaseId must contain only safe identifier characters.");
  return value;
}

function walkFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const absolute = path.join(root, relative);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in release candidate: ${relative}`);
    if (entry.isDirectory()) return walkFiles(root, relative);
    if (!entry.isFile()) throw new Error(`Unsupported release candidate entry: ${relative}`);
    return [relative.replaceAll(path.sep, "/")];
  }).sort((left, right) => left.localeCompare(right));
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in release candidate: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: stat.mode & 0o777 });
    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported release candidate source: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, destination);
  try { fs.chmodSync(destination, stat.mode & 0o777); } catch {}
}

function readPackage(sourceRoot) {
  const packagePath = path.join(sourceRoot, "package.json");
  if (!fs.existsSync(packagePath)) throw new Error("package.json is required for a release candidate.");
  try { return JSON.parse(fs.readFileSync(packagePath, "utf8")); } catch (error) { throw new Error(`package.json is invalid: ${error.message}`); }
}

function sourceCommit(sourceRoot, explicitCommit) {
  if (explicitCommit) return String(explicitCommit);
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Unable to determine source commit: ${error.message}`);
  }
}

function normalizeRegression(result) {
  if (!result || typeof result !== "object") throw new Error("A regression result is required.");
  const status = String(result.status ?? "").toUpperCase();
  if (status !== "PASS") throw new Error(`Release candidate requires a PASS regression result, received ${status || "missing status"}.`);
  return {
    status,
    command: String(result.command ?? "unknown"),
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 0,
    completedAt: result.completedAt ?? null,
    outputSha256: result.outputSha256 ?? null,
  };
}

export function runRegressionSuite({ sourceRoot, command = "npm", args = ["test"] } = {}) {
  assertDirectory(sourceRoot, "sourceRoot");
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const outputSha256 = createHash("sha256").update(output).digest("hex");
  return {
    status: result.status === 0 ? "PASS" : "FAIL",
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    startedAt,
    completedAt: new Date().toISOString(),
    outputSha256,
  };
}

function writeChecksums(candidateRoot) {
  const files = walkFiles(candidateRoot).filter((file) => file !== RELEASE_CANDIDATE_CHECKSUMS);
  const lines = files.map((file) => `${sha256File(path.join(candidateRoot, file))}  ${file}`).join("\n");
  fs.writeFileSync(path.join(candidateRoot, RELEASE_CANDIDATE_CHECKSUMS), `${lines}\n`, { encoding: "utf8", mode: 0o600 });
  return files;
}

function parseChecksums(candidateRoot) {
  const checksumPath = path.join(candidateRoot, RELEASE_CANDIDATE_CHECKSUMS);
  if (!fs.existsSync(checksumPath)) throw new Error("Candidate checksum file is missing.");
  const entries = fs.readFileSync(checksumPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw new Error(`Invalid candidate checksum line: ${line}`);
    const relative = path.posix.normalize(match[2].replaceAll("\\", "/"));
    if (relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative)) throw new Error(`Unsafe candidate checksum path: ${relative}`);
    return { relative, hash: match[1] };
  });
  if (new Set(entries.map((entry) => entry.relative)).size !== entries.length) throw new Error("Duplicate candidate checksum path.");
  return entries;
}

export function verifyReleaseCandidate(candidateRoot) {
  assertDirectory(candidateRoot, "candidateRoot");
  if (fs.existsSync(path.join(candidateRoot, ".partial"))) throw new Error("Partial release candidate marker is present.");
  const manifestPath = path.join(candidateRoot, RELEASE_CANDIDATE_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new Error("Candidate manifest is missing.");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (error) { throw new Error(`Candidate manifest is invalid JSON: ${error.message}`); }
  const validation = validateReleaseManifest(manifest);
  if (!validation.valid) throw new Error(`Candidate manifest is incompatible: ${validation.errors.join(", ")}`);

  const checksums = parseChecksums(candidateRoot);
  const expectedFiles = new Set([RELEASE_CANDIDATE_MANIFEST, ...(manifest.provenance?.candidateFiles ?? [])]);
  const checksumFiles = new Set(checksums.map((entry) => entry.relative));
  if (expectedFiles.size !== checksumFiles.size || [...expectedFiles].some((file) => !checksumFiles.has(file))) throw new Error("Candidate checksum inventory does not match manifest.");
  for (const entry of checksums) {
    const absolute = path.join(candidateRoot, ...entry.relative.split("/"));
    if (!isInside(candidateRoot, absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Candidate checksum target is missing: ${entry.relative}`);
    if (sha256File(absolute) !== entry.hash) throw new Error(`Candidate checksum mismatch: ${entry.relative}`);
  }
  for (const [relative, hash] of Object.entries(manifest.provenance?.fileChecksums ?? {})) {
    const absolute = path.join(candidateRoot, ...relative.split("/"));
    if (!fs.existsSync(absolute) || sha256File(absolute) !== hash) throw new Error(`Candidate manifest file checksum mismatch: ${relative}`);
  }
  return { valid: true, manifest, files: checksums.map((entry) => entry.relative), checksumPath: path.join(candidateRoot, RELEASE_CANDIDATE_CHECKSUMS) };
}

export function buildReleaseCandidate({
  sourceRoot,
  outputRoot,
  releaseId,
  sourceCommit: explicitSourceCommit,
  regressionResult,
  runtimeVersion,
  now = new Date(),
  candidatePaths = DEFAULT_CANDIDATE_PATHS,
} = {}) {
  assertDirectory(sourceRoot, "sourceRoot");
  const sourcePath = path.resolve(sourceRoot);
  const targetPath = path.resolve(outputRoot ?? "");
  if (!outputRoot || targetPath === sourcePath || isInside(sourcePath, targetPath) || isInside(targetPath, sourcePath)) throw new Error("Candidate output must be a separate directory from sourceRoot.");
  if (fs.existsSync(targetPath)) throw new Error(`Candidate output already exists: ${targetPath}`);
  const safeId = safeReleaseId(releaseId);
  const packageJson = readPackage(sourcePath);
  const lockfilePath = path.join(sourcePath, "package-lock.json");
  if (!fs.existsSync(lockfilePath)) throw new Error("package-lock.json is required for a release candidate.");
  const regression = normalizeRegression(regressionResult);
  const commit = sourceCommit(sourcePath, explicitSourceCommit);
  const candidateParent = path.dirname(targetPath);
  fs.mkdirSync(candidateParent, { recursive: true, mode: 0o700 });
  const partialRoot = fs.mkdtempSync(path.join(candidateParent, `.${path.basename(targetPath)}.partial-`));
  try {
    for (const relative of candidatePaths) {
      const source = path.join(sourcePath, relative);
      if (!isInside(sourcePath, source) || !fs.existsSync(source)) throw new Error(`Required candidate path is missing: ${relative}`);
      copyTree(source, path.join(partialRoot, relative));
    }
    const copiedFiles = walkFiles(partialRoot);
    const fileChecksums = Object.fromEntries(copiedFiles.map((file) => [file, sha256File(path.join(partialRoot, file))]));
    const manifest = createReleaseManifest({
      releaseId: safeId,
      runtimeVersion: runtimeVersion ?? packageJson.version,
      sourceCommit: commit,
      builtAt: now.toISOString(),
      provenance: {
        builder: "p6.1-release-candidate-builder",
        candidateSchemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
        sourceRoot: sourcePath,
        lockfileSha256: sha256File(lockfilePath),
        regression,
        candidateFiles: copiedFiles,
        fileChecksums,
      },
    });
    fs.writeFileSync(path.join(partialRoot, RELEASE_CANDIDATE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    writeChecksums(partialRoot);
    fs.renameSync(partialRoot, targetPath);
    return verifyReleaseCandidate(targetPath);
  } catch (error) {
    fs.rmSync(partialRoot, { recursive: true, force: true });
    throw error;
  }
}

function cli() {
  const args = process.argv.slice(2);
  const option = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  const sourceRoot = path.resolve(option("--source", process.cwd()));
  const outputRoot = path.resolve(option("--output", path.join(path.dirname(sourceRoot), `release-candidate-${Date.now()}`)));
  const releaseId = option("--release-id", `candidate-${new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z")}`);
  const regression = runRegressionSuite({ sourceRoot });
  if (regression.status !== "PASS") throw new Error(`Regression suite failed with exit code ${regression.exitCode}. Candidate was not created.`);
  const report = buildReleaseCandidate({ sourceRoot, outputRoot, releaseId, regressionResult: regression });
  process.stdout.write(`${JSON.stringify({ ...report, candidateRoot: outputRoot }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
