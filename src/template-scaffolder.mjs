import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_ROOT = path.join(ORCHESTRATOR_ROOT, "templates");

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} tidak valid: ${error.message}`);
  }
}

function templateFiles(templateRoot) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name !== "manifest.json") files.push(absolute);
    }
  };
  walk(templateRoot);
  return files.sort();
}

function safeRelativePath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Template path keluar dari root: ${filePath}`);
  }
  return relative;
}

function mergePackageSection(packageDocument, section, managedValues, changes) {
  packageDocument[section] = { ...(packageDocument[section] ?? {}) };
  for (const [name, version] of Object.entries(managedValues ?? {})) {
    const previous = packageDocument[section][name] ?? null;
    if (previous === version) continue;
    packageDocument[section][name] = version;
    changes.push({ section, name, previous, version });
  }
}

export function applyDeterministicTemplate({ repository, blueprint, expectedPolicyVersion }) {
  const templateRoot = path.join(TEMPLATE_ROOT, blueprint);
  const manifestPath = path.join(templateRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Deterministic template tidak ditemukan: ${templateRoot}`);

  const manifest = readJson(manifestPath, `Template manifest ${blueprint}`);
  if (manifest.blueprint !== blueprint) {
    throw new Error(`Template manifest mismatch: expected ${blueprint}, received ${manifest.blueprint || "EMPTY"}.`);
  }
  if (manifest.policyVersion !== expectedPolicyVersion) {
    throw new Error(`Template policy version ${manifest.policyVersion} tidak sesuai orchestrator policy ${expectedPolicyVersion}.`);
  }

  const isGo = manifest.toolchain === "go" || blueprint === "backend-golang";
  let packageDocument = null;
  const packageChanges = [];

  if (!isGo) {
    const packagePath = path.join(repository, "package.json");
    packageDocument = readJson(packagePath, "package.json");
    packageDocument.scripts = { ...(packageDocument.scripts ?? {}), ...(manifest.scripts ?? {}) };
    mergePackageSection(packageDocument, "dependencies", manifest.dependencies, packageChanges);
    mergePackageSection(packageDocument, "devDependencies", manifest.devDependencies, packageChanges);
    writeAtomic(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`);
  }

  const projectName = String(packageDocument?.name ?? path.basename(repository));
  const snakeCaseName = projectName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  const kebabCaseName = projectName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const substitutions = {
    __PROJECT_NAME__: projectName,
    __PROJECT_NAME_SNAKE__: snakeCaseName,
    __PROJECT_NAME_KEBAB__: kebabCaseName,
    ...(isGo ? {
      "base-be-golang": projectName,
      "base_be": snakeCaseName,
      "base-be": kebabCaseName,
    } : {}),
  };
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(manifestPath));
  const writtenFiles = [];
  for (const sourcePath of templateFiles(templateRoot)) {
    const relative = safeRelativePath(templateRoot, sourcePath);
    let content = fs.readFileSync(sourcePath, "utf8");
    hash.update(relative);
    hash.update(content);
    for (const [token, value] of Object.entries(substitutions)) content = content.replaceAll(token, value);
    writeAtomic(path.join(repository, relative), content);
    writtenFiles.push(relative.split(path.sep).join("/"));
  }

  return {
    blueprint,
    templateVersion: manifest.templateVersion,
    policyVersion: manifest.policyVersion,
    wikiBlueprint: manifest.wikiBlueprint,
    checksum: hash.digest("hex"),
    filesWritten: writtenFiles,
    packageChanges,
  };
}

