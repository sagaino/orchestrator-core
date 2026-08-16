import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runProcess } from "./executor.mjs";
import { agyConfigArgs, resolveAgyConfig } from "./agent-config.mjs";
import { createAgentTelemetryRecord } from "./telemetry.mjs";
import { JOB_STATES, listJobs } from "./job-queue.mjs";
import { RUN_STATES, listRuns } from "./run-manager.mjs";
import { applyDeterministicTemplate } from "./template-scaffolder.mjs";

const DEFAULT_BLUEPRINT = "frontend-vite";
const SHADCN_VERSION = "4.18.0";
const BLUEPRINT_PATHS = Object.freeze({
  "frontend-vite": "01-Knowledge/patterns/frontend/project-skeleton-template.md",
});
const BLUEPRINT_POLICIES = Object.freeze({
  "frontend-vite": Object.freeze({
    version: 3,
    shadcnVersion: SHADCN_VERSION,
    managedDevDependencies: Object.freeze({
      typescript: "~5.9.3",
    }),
  }),
});
const REQUIRED_NEW_PROJECT_PATHS = Object.freeze([
  "src/components/ui",
  "src/hooks/useLocalStorage.ts",
  "src/lib/constant/endpoints.ts",
  "src/lib/axios.ts",
  "src/lib/signature.ts",
  "src/lib/error-utils.ts",
  "src/pages/Login",
  "src/routes",
  "src/services/auth.ts",
]);
const NEW_PROJECT_REQUIRED_SCRIPTS = Object.freeze(["typecheck", "lint", "build"]);
const ACTIVE_PROJECT_JOB_STATES = new Set([JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.REVIEW]);
const ACTIVE_PROJECT_RUN_STATES = new Set([
  RUN_STATES.PENDING_APPROVAL,
  RUN_STATES.APPROVED,
  RUN_STATES.CLAIMING,
  RUN_STATES.CLAIMED,
  RUN_STATES.RUNNING,
  RUN_STATES.VERIFYING,
  RUN_STATES.REVIEW,
  RUN_STATES.CHANGES_REQUESTED,
  RUN_STATES.RETROSPECTIVE,
  RUN_STATES.KNOWLEDGE_APPROVAL,
  RUN_STATES.WIKI_SYNCED,
]);
const ACTIVE_PROJECT_TASK_STATES = new Set(["READY", "IN_PROGRESS", "REVIEW"]);

export function configuredOnboardingAiFallback(env = process.env) {
  const raw = String(env.ORCHESTRATOR_ONBOARDING_AI_FALLBACK ?? "true").trim().toLowerCase();
  if (["true", "1", "on"].includes(raw)) return true;
  if (["false", "0", "off"].includes(raw)) return false;
  throw new Error("ORCHESTRATOR_ONBOARDING_AI_FALLBACK harus true/false, 1/0, atau on/off.");
}

function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function titleFromId(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function yamlArray(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function ensureAbsoluteSafePath(input, { mustExist = false, mustNotExist = false } = {}) {
  if (!path.isAbsolute(String(input ?? ""))) {
    throw new Error(`Repository path harus absolute: ${input || "EMPTY"}`);
  }
  const resolved = path.resolve(input);
  if (/[\r\n|`]/.test(resolved)) {
    throw new Error(`Repository path mengandung karakter yang tidak aman untuk registry: ${resolved}`);
  }
  const forbidden = new Set([path.parse(resolved).root, os.homedir()]);
  if (forbidden.has(resolved)) throw new Error(`Repository path terlalu luas dan tidak aman: ${resolved}`);
  if (mustExist && (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())) {
    throw new Error(`Repository tidak ditemukan: ${resolved}`);
  }
  if (mustNotExist && fs.existsSync(resolved)) {
    throw new Error(`Target project sudah ada dan tidak akan ditimpa: ${resolved}`);
  }
  return resolved;
}

function readPackage(repository) {
  const packagePath = path.join(repository, "package.json");
  if (!fs.existsSync(packagePath)) throw new Error(`package.json tidak ditemukan di ${repository}.`);
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`package.json tidak valid: ${error.message}`);
  }
}

function writePackage(repository, packageDocument) {
  writeAtomic(path.join(repository, "package.json"), `${JSON.stringify(packageDocument, null, 2)}\n`);
}

export function applyBlueprintDependencyPolicy(repository, blueprint = DEFAULT_BLUEPRINT) {
  const policy = BLUEPRINT_POLICIES[blueprint];
  if (!policy) throw new Error(`Dependency policy belum tersedia untuk blueprint ${blueprint}.`);
  const packageDocument = readPackage(repository);
  const changes = [];
  packageDocument.dependencies = { ...(packageDocument.dependencies ?? {}) };
  packageDocument.devDependencies = { ...(packageDocument.devDependencies ?? {}) };
  for (const [dependency, requiredVersion] of Object.entries(policy.managedDevDependencies)) {
    const previous = packageDocument.devDependencies[dependency] ?? packageDocument.dependencies[dependency] ?? null;
    if (Object.hasOwn(packageDocument.dependencies, dependency)) {
      delete packageDocument.dependencies[dependency];
      changes.push({ dependency, action: "MOVED_TO_DEV_DEPENDENCIES", previous, requiredVersion });
    }
    if (packageDocument.devDependencies[dependency] !== requiredVersion) {
      packageDocument.devDependencies[dependency] = requiredVersion;
      changes.push({ dependency, action: previous ? "VERSION_CORRECTED" : "VERSION_PINNED", previous, requiredVersion });
    }
  }
  if (Object.keys(packageDocument.dependencies).length === 0) delete packageDocument.dependencies;
  if (changes.length > 0) writePackage(repository, packageDocument);
  return {
    blueprint,
    policyVersion: policy.version,
    shadcnVersion: policy.shadcnVersion,
    managedDevDependencies: policy.managedDevDependencies,
    corrected: changes.length > 0,
    changes,
  };
}

function verificationScripts(packageDocument, { requireNewBaseline = false } = {}) {
  const scripts = packageDocument.scripts ?? {};
  if (requireNewBaseline) {
    const missing = NEW_PROJECT_REQUIRED_SCRIPTS.filter((name) => !scripts[name]);
    if (missing.length > 0) {
      throw new Error(`Blueprint wajib menyediakan script: ${missing.join(", ")}.`);
    }
    return [...NEW_PROJECT_REQUIRED_SCRIPTS, ...(scripts.test ? ["test"] : [])];
  }
  const preferred = ["typecheck", "build"].filter((name) => scripts[name]);
  const fallback = ["test", "lint"].filter((name) => scripts[name]);
  const selected = preferred.length > 0 ? preferred : fallback;
  if (selected.length === 0) {
    throw new Error("Project belum memiliki script verification yang didukung: typecheck, build, test, atau lint.");
  }
  return selected;
}

function frameworkTags(packageDocument) {
  const dependencies = { ...(packageDocument.dependencies ?? {}), ...(packageDocument.devDependencies ?? {}) };
  const tags = ["project"];
  if (dependencies.react) tags.push("frontend", "react");
  if (dependencies.vite) tags.push("vite");
  return tags;
}

function graphOutputPath(repository) {
  return path.join(repository, "graphify-out", "graph.json");
}

function emitProgress(onProgress, event) {
  try {
    onProgress?.({ at: new Date().toISOString(), ...event });
  } catch {
    // Progress reporting is best-effort and must never alter onboarding state.
  }
}

async function runObserved(processRunner, invocation, label, onProgress) {
  const startedAt = Date.now();
  emitProgress(onProgress, { state: "STARTED", stage: invocation.stage, label, elapsedSeconds: 0 });
  const heartbeat = setInterval(() => {
    emitProgress(onProgress, {
      state: "RUNNING",
      stage: invocation.stage,
      label,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
    });
  }, 15_000);
  heartbeat.unref?.();
  let result;
  try {
    result = await processRunner(invocation);
  } catch (error) {
    clearInterval(heartbeat);
    emitProgress(onProgress, {
      state: "FAILED",
      stage: invocation.stage,
      label,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
      error: error.message,
    });
    throw new Error(`${label} tidak dapat dijalankan: ${error.message}`);
  }
  clearInterval(heartbeat);
  emitProgress(onProgress, {
    state: result.exitCode === 0 ? "COMPLETED" : "FAILED",
    stage: invocation.stage,
    label,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
    exitCode: result.exitCode,
  });
  return result;
}

function processFailure(result, label) {
  const diagnostic = String(result.stderrTail || result.stdoutTail || "").trim().slice(-6_000);
  return new Error(`${label} gagal dengan exit code ${result.exitCode}.${diagnostic ? `\n${diagnostic}` : ""}`);
}

async function runRequired(processRunner, invocation, label, onProgress) {
  const result = await runObserved(processRunner, invocation, label, onProgress);
  if (result.exitCode !== 0) {
    throw processFailure(result, label);
  }
  return result;
}

async function runVerification({ repository, scripts, processRunner, eventLogPath, onProgress }) {
  const results = [];
  for (const script of scripts) {
    const result = await runRequired(processRunner, {
      command: "npm",
      args: ["run", script],
      cwd: repository,
      stage: `project-onboarding:verification:${script}`,
      eventLogPath,
    }, `Verification npm run ${script}`, onProgress);
    results.push({ script, exitCode: result.exitCode });
  }
  return results;
}

async function updateGraphify({ repository, processRunner, eventLogPath, onProgress }) {
  const existed = fs.existsSync(graphOutputPath(repository));
  const result = await runRequired(processRunner, {
    command: "graphify",
    args: ["update", "."],
    cwd: repository,
    stage: "project-onboarding:graphify-update",
    eventLogPath,
  }, "Graphify bootstrap", onProgress);
  const output = graphOutputPath(repository);
  if (!fs.existsSync(output)) {
    throw new Error(`Graphify selesai tetapi output tidak ditemukan: ${output}`);
  }
  return { action: existed ? "REFRESHED" : "BOOTSTRAPPED", output, exitCode: result.exitCode };
}

function dependencyResolutionFailure(result) {
  return /(?:ERESOLVE|unable to resolve dependency tree|could not resolve dependency)/i
    .test(`${result?.stderrTail ?? ""}\n${result?.stdoutTail ?? ""}`);
}

async function installBlueprintDependencies({
  repository,
  blueprint,
  processRunner,
  eventLogPath,
  onProgress,
}) {
  const policy = applyBlueprintDependencyPolicy(repository, blueprint);
  emitProgress(onProgress, {
    state: "COMPLETED",
    stage: "project-onboarding:dependency-policy",
    label: `Dependency policy v${policy.policyVersion}`,
    elapsedSeconds: 0,
  });

  const attempts = [];
  const preflight = async (stage) => {
    const result = await runObserved(processRunner, {
      command: "npm",
      args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      cwd: repository,
      stage,
      eventLogPath,
    }, "Dependency resolution preflight", onProgress);
    attempts.push({
      attempt: attempts.length + 1,
      exitCode: result.exitCode,
      dependencyConflict: dependencyResolutionFailure(result),
    });
    return result;
  };

  let preflightResult = await preflight("project-onboarding:dependency-preflight");
  let recovered = false;
  if (preflightResult.exitCode !== 0 && dependencyResolutionFailure(preflightResult)) {
    applyBlueprintDependencyPolicy(repository, blueprint);
    emitProgress(onProgress, {
      state: "STARTED",
      stage: "project-onboarding:dependency-recovery",
      label: "Deterministic dependency recovery",
      elapsedSeconds: 0,
    });
    preflightResult = await preflight("project-onboarding:dependency-preflight-retry");
    recovered = preflightResult.exitCode === 0;
    emitProgress(onProgress, {
      state: recovered ? "COMPLETED" : "FAILED",
      stage: "project-onboarding:dependency-recovery",
      label: "Deterministic dependency recovery",
      elapsedSeconds: 0,
    });
  }
  if (preflightResult.exitCode !== 0) throw processFailure(preflightResult, "Dependency resolution preflight");

  const installResult = await runRequired(processRunner, {
    command: "npm",
    args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: repository,
    stage: "project-onboarding:dependency-install",
    eventLogPath,
  }, "Dependency installation", onProgress);

  return {
    policy,
    preflight: { attempts, recovered },
    install: { exitCode: installResult.exitCode, ignoreScripts: true },
  };
}

function cleanCell(value) {
  return String(value).trim().replace(/^`|`$/g, "").replace(/^<|>$/g, "");
}

function registryRows(content) {
  const rows = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanCell);
    if (cells.length < 6 || cells[0] === "project_id" || /^-+$/.test(cells[0])) continue;
    rows.push({ index, id: cells[0], repository: cells[2] });
  }
  return rows;
}

function safeProjectId(value) {
  const projectId = String(value ?? "").trim();
  if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId) || [".", ".."].includes(projectId)) {
    throw new Error(`Project ID tidak valid: ${value || "EMPTY"}`);
  }
  return projectId;
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function walkProjectFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && ![".git", ".obsidian", "node_modules"].includes(entry.name)) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  walk(root);
  return files.sort();
}

function projectArchiveInventory(projectRoot) {
  return walkProjectFiles(projectRoot).map((absolute) => {
    const content = fs.readFileSync(absolute);
    return {
      path: toPosix(path.relative(projectRoot, absolute)),
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

function projectLinkedMarkdown(vaultRoot, projectRoot, projectId) {
  const projectPrefix = `[[02-Projects/${projectId}/`;
  return walkProjectFiles(vaultRoot)
    .filter((filePath) => filePath.endsWith(".md"))
    .filter((filePath) => !filePath.startsWith(`${projectRoot}${path.sep}`))
    .filter((filePath) => !toPosix(path.relative(vaultRoot, filePath)).startsWith("03-Sources/"))
    .filter((filePath) => fs.readFileSync(filePath, "utf8").includes(projectPrefix));
}

function rewriteProjectWikilinks(content, projectId, archivePath, updatedAt) {
  const rewritten = content.replaceAll(`[[02-Projects/${projectId}/`, `[[${archivePath}/`);
  if (rewritten === content || !/^updated:\s*.*$/m.test(rewritten)) return rewritten;
  return rewritten.replace(/^updated:\s*.*$/m, `updated: ${updatedAt.slice(0, 10)}`);
}

function taskStatusFromFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return String(content.match(/^status:\s*([^\s#]+)/m)?.[1] ?? "").toUpperCase();
}

function projectRemovalBlockers({ runsRoot, projectId, projectRoot }) {
  const jobs = listJobs(runsRoot)
    .filter((job) => job.projectId === projectId && ACTIVE_PROJECT_JOB_STATES.has(job.state))
    .map((job) => ({ type: "JOB", id: job.jobId, state: job.state, taskId: job.taskId ?? null }));
  const runs = listRuns(runsRoot)
    .filter((run) => run.project?.id === projectId && ACTIVE_PROJECT_RUN_STATES.has(run.state))
    .map((run) => ({ type: "RUN", id: run.runId, state: run.state, taskId: run.task?.id ?? null }));
  const tasksRoot = path.join(projectRoot, "tasks");
  const tasks = fs.existsSync(tasksRoot)
    ? walkProjectFiles(tasksRoot)
      .filter((filePath) => filePath.endsWith(".md"))
      .map((filePath) => ({ filePath, state: taskStatusFromFile(filePath) }))
      .filter((task) => ACTIVE_PROJECT_TASK_STATES.has(task.state))
      .map((task) => ({
        type: "TASK",
        id: toPosix(path.relative(projectRoot, task.filePath)),
        state: task.state,
        taskId: null,
      }))
    : [];
  return [...jobs, ...runs, ...tasks];
}

function assertRegistrationAvailable(vaultRoot, projectId, repository) {
  const registryPath = path.join(vaultRoot, "project-registry.md");
  if (!fs.existsSync(registryPath)) throw new Error("project-registry.md tidak ditemukan.");
  const rows = registryRows(fs.readFileSync(registryPath, "utf8"));
  const idConflict = rows.find((row) => row.id === projectId && path.resolve(row.repository) !== repository);
  if (idConflict) throw new Error(`Project ID ${projectId} sudah digunakan oleh ${idConflict.repository}.`);
  const repositoryConflict = rows.find((row) => path.resolve(row.repository) === repository && row.id !== projectId);
  if (repositoryConflict) throw new Error(`Repository sudah terdaftar sebagai ${repositoryConflict.id}.`);
  return rows.some((row) => row.id === projectId);
}

function frontmatterField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function upsertFrontmatter(content, fields) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error("Project page existing tidak memiliki frontmatter.");
  let frontmatter = match[1];
  for (const [field, value] of Object.entries(fields)) {
    const line = `${field}: ${value}`;
    const expression = new RegExp(`^${field}:.*$`, "m");
    frontmatter = expression.test(frontmatter)
      ? frontmatter.replace(expression, line)
      : `${frontmatter.trimEnd()}\n${line}`;
  }
  return `---\n${frontmatter}\n---\n\n${content.slice(match[0].length).replace(/^\s+/, "")}`;
}

function newProjectPage(input) {
  const { title, projectId, repository, graphifyOutput, verificationDefaults, tags, blueprint } = input;
  const today = new Date().toISOString().slice(0, 10);
  const sources = blueprint ? [`[[${BLUEPRINT_PATHS[blueprint].replace(/\.md$/, "")}]]`] : [];
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    "type: project",
    `project_id: ${projectId}`,
    `repository: ${JSON.stringify(repository)}`,
    "agent: agy",
    "graphify: true",
    `graphify_output: ${JSON.stringify(graphifyOutput)}`,
    `verification_defaults: ${yamlArray(verificationDefaults)}`,
    ...(blueprint ? [`blueprint: ${blueprint}`] : []),
    ...(input.templateVersion ? [`template_version: ${input.templateVersion}`] : []),
    ...(input.blueprintPolicyVersion ? [`blueprint_policy_version: ${input.blueprintPolicyVersion}`] : []),
    ...(input.templateChecksum ? [`template_checksum: ${JSON.stringify(input.templateChecksum)}`] : []),
    ...(input.scaffoldMode ? [`scaffold_mode: ${input.scaffoldMode}`] : []),
    `tags: ${yamlArray(tags)}`,
    `created: ${today}`,
    `updated: ${today}`,
    `sources: ${yamlArray(sources)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Role in the Wiki",
    "",
    "Project metadata used by Personal AI Orchestrator. Source code and Graphify output remain in the repository.",
    "",
    "## Repository",
    "",
    `- Repository: \`${repository}\``,
    "- Coding agent: `agy`",
    "- Graphify enabled: `true`",
    `- Graphify output: \`${graphifyOutput}\``,
    `- Verification defaults: ${verificationDefaults.map((item) => `\`${item}\``).join(", ")}`,
    ...(input.scaffoldMode ? [`- Scaffold mode: \`${input.scaffoldMode}\``] : []),
    ...(input.templateVersion ? [`- Template version: \`${input.templateVersion}\``] : []),
    "",
    "## Task Queue",
    "",
    `- Tasks: \`02-Projects/${projectId}/tasks/\``,
    "",
    "## Graphify Note",
    "",
    "Graphify is refreshed in the repository by the orchestrator. Its output is never copied into the Vault.",
    "",
  ].join("\n");
}

function updatedProjectPage(existing, input) {
  const existingProjectId = frontmatterField(existing, "project_id");
  if (existingProjectId !== input.projectId) {
    throw new Error(`Project page existing memiliki project_id ${existingProjectId || "EMPTY"}.`);
  }
  const today = new Date().toISOString().slice(0, 10);
  return upsertFrontmatter(existing, {
    title: JSON.stringify(input.title),
    repository: JSON.stringify(input.repository),
    agent: "agy",
    graphify: "true",
    graphify_output: JSON.stringify(input.graphifyOutput),
    verification_defaults: yamlArray(input.verificationDefaults),
    ...(input.blueprint ? { blueprint: input.blueprint } : {}),
    ...(input.templateVersion ? { template_version: input.templateVersion } : {}),
    ...(input.blueprintPolicyVersion ? { blueprint_policy_version: input.blueprintPolicyVersion } : {}),
    ...(input.templateChecksum ? { template_checksum: JSON.stringify(input.templateChecksum) } : {}),
    ...(input.scaffoldMode ? { scaffold_mode: input.scaffoldMode } : {}),
    tags: yamlArray(input.tags),
    updated: today,
  });
}

function updatedRegistry(content, input) {
  const rows = registryRows(content);
  const row = `| \`${input.projectId}\` | [[02-Projects/${input.projectId}/project]] | \`${input.repository}\` | \`agy\` | \`true\` | \`${input.graphifyOutput}\` |`;
  const existing = rows.find((item) => item.id === input.projectId);
  const lines = content.split(/\r?\n/);
  if (existing) {
    lines[existing.index] = row;
  } else {
    const tableRows = rows.map((item) => item.index);
    if (tableRows.length > 0) {
      lines.splice(Math.max(...tableRows) + 1, 0, row);
    } else {
      const separatorIndex = lines.findIndex((line) => /^\|\s*-+\s*\|/.test(line.trim()));
      if (separatorIndex < 0) throw new Error("Tabel project registry tidak dapat ditemukan.");
      lines.splice(separatorIndex + 1, 0, row);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  return lines.join("\n").replace(/^updated:\s*.*$/m, `updated: ${today}`);
}

function updatedIndex(content, input) {
  const link = `02-Projects/${input.projectId}/project`;
  if (content.includes(`[[${link}|`)) return content;
  const entry = `- [[${link}|${input.title} Project]]: Metadata project, repository, dan Graphify pointer.`;
  const heading = "## Orchestrator-registered Projects";
  if (!content.includes(heading)) return `${content.trimEnd()}\n\n${heading}\n\n${entry}\n`;
  const headingIndex = content.indexOf(heading);
  const nextHeadingIndex = content.indexOf("\n## ", headingIndex + heading.length);
  const insertionIndex = nextHeadingIndex < 0 ? content.length : nextHeadingIndex;
  return `${content.slice(0, insertionIndex).trimEnd()}\n${entry}\n\n${content.slice(insertionIndex).replace(/^\s+/, "")}`;
}

function appendIndexSectionEntry(content, heading, entry) {
  if (!content.includes(heading)) return `${content.trimEnd()}\n\n${heading}\n\n${entry}\n`;
  const headingIndex = content.indexOf(heading);
  const nextHeadingIndex = content.indexOf("\n## ", headingIndex + heading.length);
  const insertionIndex = nextHeadingIndex < 0 ? content.length : nextHeadingIndex;
  return `${content.slice(0, insertionIndex).trimEnd()}\n${entry}\n\n${content.slice(insertionIndex).replace(/^\s+/, "")}`;
}

function updatedRegistryForRemoval(content, projectId) {
  const row = registryRows(content).find((item) => item.id === projectId);
  if (!row) throw new Error(`Project ${projectId} tidak ditemukan di project-registry.md.`);
  const lines = content.split(/\r?\n/);
  lines.splice(row.index, 1);
  return lines.join("\n").replace(/^updated:\s*.*$/m, `updated: ${new Date().toISOString().slice(0, 10)}`);
}

function updatedIndexForRemoval(content, { projectId, title, archiveProjectPage }) {
  const activePrefix = `[[02-Projects/${projectId}/`;
  const withoutActiveProject = content
    .split(/\r?\n/)
    .filter((line) => !line.includes(activePrefix))
    .join("\n");
  const entry = `- [[${archiveProjectPage}|${title} Project Archive]]: Immutable project metadata and task history.`;
  return appendIndexSectionEntry(withoutActiveProject, "## Archived Projects", entry);
}

function updatedIndexForArchivePurge(content, projectId) {
  const archivePrefix = `[[03-Sources/other/removed-projects/${projectId}/`;
  const updated = content
    .split(/\r?\n/)
    .filter((line) => !line.includes(archivePrefix))
    .join("\n");
  return updated.replace(/^updated:\s*.*$/m, `updated: ${new Date().toISOString().slice(0, 10)}`);
}

function removalLog(content, input) {
  const entry = [
    `## [${input.removedAt.slice(0, 10)}] project-removal | ${input.projectId}`,
    `- Action: \`PROJECT_UNREGISTERED_AND_ARCHIVED\`; repository preserved: \`${input.repository}\`.`,
    `- Archive: \`${input.archivePath}\`; files preserved: \`${input.inventory.length}\`.`,
    `- Removed by: \`${input.removedBy}\`; global knowledge, Candidates, run sources, source code, and Graphify were not deleted.`,
  ].join("\n");
  return `${content.trimEnd()}\n\n${entry}\n`;
}

function archivePurgeLog(content, input) {
  const entry = [
    `## [${input.purgedAt.slice(0, 10)}] project-archive-purge | ${input.projectId}`,
    `- Action: \`PROJECT_ARCHIVE_PURGED_FROM_VAULT\`; archive versions: \`${input.archiveVersions}\`; files: \`${input.inventory.length}\`.`,
    `- Purged by: \`${input.purgedBy}\`; repository, Graphify, global knowledge, Candidates, and run history were not deleted.`,
    `- Quarantine audit: \`${input.quarantinePath}\`; the archive is no longer part of the Obsidian Vault.`,
  ].join("\n");
  return `${content.trimEnd()}\n\n${entry}\n`;
}

function archivePurgeLinkBlockers({ vaultRoot, archiveRoot, projectId, indexPath }) {
  const archivePrefix = `[[03-Sources/other/removed-projects/${projectId}/`;
  const legacyPrefix = `[[02-Projects/${projectId}/`;
  return walkProjectFiles(vaultRoot)
    .filter((filePath) => filePath.endsWith(".md"))
    .filter((filePath) => !filePath.startsWith(`${archiveRoot}${path.sep}`))
    .filter((filePath) => filePath !== indexPath)
    .flatMap((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const reasons = [];
      if (content.includes(archivePrefix)) reasons.push("ARCHIVE_WIKILINK");
      if (content.includes(legacyPrefix)) reasons.push("LEGACY_PROJECT_WIKILINK");
      return reasons.map((reason) => ({
        path: toPosix(path.relative(vaultRoot, filePath)),
        reason,
      }));
    });
}

function removeEmptyDirectory(directory, stopAt) {
  let current = directory;
  const boundary = path.resolve(stopAt);
  while (path.resolve(current).startsWith(`${boundary}${path.sep}`)) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function registrationLog(content, input, action, registeredBy) {
  const entry = [
    `## [${new Date().toISOString().slice(0, 10)}] project-onboarding | ${input.projectId}`,
    `- Action: \`${action}\`; repository: \`${input.repository}\`.`,
    `- Graphify: \`${input.graphifyOutput}\`; verification defaults: \`${input.verificationDefaults.join(", ")}\`.`,
    `- Registered by: \`${registeredBy}\`${input.blueprint ? `; blueprint: \`${input.blueprint}\`` : ""}.`,
  ].join("\n");
  return `${content.trimEnd()}\n\n${entry}\n`;
}

function registerProject({ vaultRoot, input, registeredBy }) {
  const registryPath = path.join(vaultRoot, "project-registry.md");
  const indexPath = path.join(vaultRoot, "index.md");
  const logPath = path.join(vaultRoot, "wiki-log.md");
  for (const required of [registryPath, indexPath, logPath]) {
    if (!fs.existsSync(required)) throw new Error(`Vault control file tidak ditemukan: ${required}`);
  }
  const projectRoot = path.join(vaultRoot, "02-Projects", input.projectId);
  const pagePath = path.join(projectRoot, "project.md");
  const tasksPath = path.join(projectRoot, "tasks");
  const rootExisted = fs.existsSync(projectRoot);
  const pageExisted = fs.existsSync(pagePath);
  const backups = new Map([
    [registryPath, fs.readFileSync(registryPath, "utf8")],
    [indexPath, fs.readFileSync(indexPath, "utf8")],
    [logPath, fs.readFileSync(logPath, "utf8")],
    [pagePath, pageExisted ? fs.readFileSync(pagePath, "utf8") : null],
  ]);
  const action = pageExisted ? "PROJECT_UPDATED" : "PROJECT_REGISTERED";
  const rollback = () => {
    for (const [filePath, content] of backups) {
      if (content === null) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        writeAtomic(filePath, content);
      }
    }
    if (!rootExisted && fs.existsSync(projectRoot)) fs.rmSync(projectRoot, { recursive: true, force: true });
  };
  try {
    const page = pageExisted
      ? updatedProjectPage(backups.get(pagePath), input)
      : newProjectPage(input);
    writeAtomic(pagePath, page);
    fs.mkdirSync(tasksPath, { recursive: true });
    writeAtomic(registryPath, updatedRegistry(backups.get(registryPath), input));
    writeAtomic(indexPath, updatedIndex(backups.get(indexPath), input));
    writeAtomic(logPath, registrationLog(backups.get(logPath), input, action, registeredBy));
  } catch (error) {
    rollback();
    throw error;
  }
  return {
    summary: {
      action,
      projectPage: toPosix(path.relative(vaultRoot, pagePath)),
      tasksPath: toPosix(path.relative(vaultRoot, tasksPath)),
      registry: "project-registry.md",
      index: "index.md",
      log: "wiki-log.md",
    },
    rollback,
  };
}

function onboardingAuditPath(runsRoot, onboardingId) {
  return path.join(runsRoot, "onboarding", `${onboardingId}.json`);
}

function persistOnboardingAudit(runsRoot, onboardingId, value) {
  const filePath = onboardingAuditPath(runsRoot, onboardingId);
  writeJsonAtomic(filePath, value);
  return toPosix(path.relative(runsRoot, filePath));
}

function eventLogPath(runsRoot, onboardingId) {
  return path.join(runsRoot, "onboarding", "events", `${onboardingId}.jsonl`);
}

function projectIdentity(repository, packageDocument, requestedId = null) {
  const id = slugify(requestedId || packageDocument.name || path.basename(repository));
  if (!id) throw new Error("Project ID tidak dapat ditentukan.");
  return { id, title: titleFromId(id) };
}

function auditIdentity(value) {
  return String(value ?? "user").replace(/\s+/g, " ").trim().slice(0, 120) || "user";
}

function appendGitignore(repository, entry) {
  const filePath = path.join(repository, ".gitignore");
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry)) return;
  writeAtomic(filePath, `${content.trimEnd()}${content.trim() ? "\n" : ""}${entry}\n`);
}

function isSensitiveEnvironmentFile(relativePath) {
  const basename = path.posix.basename(toPosix(relativePath));
  return basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example");
}

export function assertSafeStagedFiles(stagedFiles) {
  const normalized = stagedFiles.map((item) => toPosix(item).trim()).filter(Boolean);
  const forbiddenFiles = normalized.filter(isSensitiveEnvironmentFile);
  if (forbiddenFiles.length > 0) {
    throw new Error(`Sensitive environment file tidak boleh masuk initial commit: ${forbiddenFiles.join(", ")}. Gunakan .env.example tanpa secret.`);
  }
  return { stagedFilesChecked: normalized.length, forbiddenFiles };
}

function repositoryFileSnapshot(repository) {
  return new Map(walkProjectFiles(repository).map((filePath) => {
    const relative = toPosix(path.relative(repository, filePath));
    const checksum = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    return [relative, checksum];
  }));
}

function changedSnapshotPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((filePath) => before.get(filePath) !== after.get(filePath)).sort();
}

function assertFallbackScope(changedPaths, templateFiles) {
  const allowed = new Set(["package.json", "eslint.config.js", ".env.example", ...templateFiles]);
  const outOfScope = changedPaths.filter((filePath) => !allowed.has(filePath));
  if (outOfScope.length > 0) {
    throw new Error(`Blueprint fallback agent mengubah file di luar scope template: ${outOfScope.join(", ")}.`);
  }
  return { changedPaths, outOfScope };
}

function assertNoSensitiveEnvironmentFiles(repository) {
  const forbiddenFiles = walkProjectFiles(repository)
    .map((filePath) => toPosix(path.relative(repository, filePath)))
    .filter(isSensitiveEnvironmentFile);
  if (forbiddenFiles.length > 0) {
    throw new Error(`Deterministic template hanya mengizinkan .env.example; file sensitif ditemukan: ${forbiddenFiles.join(", ")}.`);
  }
  return { forbiddenFiles };
}

function assertBlueprintResult(repository) {
  const missing = REQUIRED_NEW_PROJECT_PATHS.filter((relative) => !fs.existsSync(path.join(repository, relative)));
  if (missing.length > 0) throw new Error(`Blueprint belum lengkap; path wajib tidak ditemukan: ${missing.join(", ")}.`);
  const uiRoot = path.join(repository, "src", "components", "ui");
  const componentCount = fs.readdirSync(uiRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(tsx|ts)$/.test(entry.name)).length;
  if (componentCount === 0) throw new Error("Shadcn add --all tidak menghasilkan komponen UI.");
  return { requiredPaths: REQUIRED_NEW_PROJECT_PATHS.length, shadcnComponentCount: componentCount };
}

function scaffoldFallbackAgentInvocation({ repository, projectId, blueprintPath, verificationError }) {
  const agentConfig = resolveAgyConfig();
  const prompt = [
    `Perbaiki deterministic scaffold project ${projectId} di ${repository}.`,
    `Blueprint source: ${blueprintPath}`,
    "Template deterministic sudah diterapkan oleh orchestrator. Baca blueprint hanya jika error membutuhkan detail kontrak.",
    "",
    "Verification error yang harus diperbaiki:",
    String(verificationError).slice(-6_000),
    "",
    "Kontrak fallback:",
    "1. Perbaiki hanya file template di src selain src/components/ui, serta package.json atau eslint.config.js jika error membutuhkannya.",
    "2. Jangan membaca, menginspeksi, menulis ulang, atau menghapus src/components/ui.",
    "3. Jangan menggunakan terminal, package manager, Git, Graphify, test, lint, atau build; orchestrator mengulang semua pemeriksaan.",
    "4. Hindari any, dummy/fallback authentication, kontrak API rekaan, credential, .env, dan user-facing text tanpa i18n.",
    "5. Jangan mengubah versi toolchain inti yang dikelola orchestrator.",
    "6. Lakukan edit minimum yang langsung menyelesaikan error di atas.",
  ].join("\n");
  return {
    command: "agy",
    args: [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      ...agyConfigArgs(agentConfig),
      "--mode",
      "accept-edits",
      "--print-timeout",
      "30m",
    ],
    agentConfig,
  };
}

function cleanupStaging(stageRoot) {
  const marker = path.join(stageRoot, ".personal-ai-onboarding-stage");
  if (fs.existsSync(stageRoot) && fs.existsSync(marker)) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

export async function addExistingProject({
  vaultRoot,
  runsRoot,
  repositoryPath,
  projectId = null,
  registeredBy = "user",
  processRunner = runProcess,
  onProgress = () => {},
}) {
  const repository = ensureAbsoluteSafePath(repositoryPath, { mustExist: true });
  if (!fs.existsSync(path.join(repository, ".git"))) {
    throw new Error("Existing project harus berupa Git repository sebelum didaftarkan.");
  }
  const packageDocument = readPackage(repository);
  const identity = projectIdentity(repository, packageDocument, projectId);
  const alreadyRegistered = assertRegistrationAvailable(vaultRoot, identity.id, repository);
  const onboardingId = `existing-${identity.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const events = eventLogPath(runsRoot, onboardingId);
  let registrationTransaction = null;
  const stages = [];
  try {
    const scripts = verificationScripts(packageDocument);
    const verification = await runVerification({ repository, scripts, processRunner, eventLogPath: events, onProgress });
    stages.push("VERIFIED");
    const graphify = await updateGraphify({ repository, processRunner, eventLogPath: events, onProgress });
    stages.push(graphify.action === "BOOTSTRAPPED" ? "GRAPHIFY_BOOTSTRAPPED" : "GRAPHIFY_REFRESHED");
    registrationTransaction = registerProject({
      vaultRoot,
      registeredBy: auditIdentity(registeredBy),
      input: {
        title: identity.title,
        projectId: identity.id,
        repository,
        graphifyOutput: graphify.output,
        verificationDefaults: scripts,
        tags: frameworkTags(packageDocument),
        blueprint: null,
      },
    });
    stages.push("REGISTERED");
    emitProgress(onProgress, {
      state: "COMPLETED",
      stage: "project-onboarding:wiki-registration",
      label: "Wiki project registration",
      elapsedSeconds: 0,
    });
    const result = {
      schemaVersion: 1,
      action: alreadyRegistered ? "EXISTING_PROJECT_UPDATED" : "EXISTING_PROJECT_ADDED",
      onboardingId,
      project: {
        id: identity.id,
        title: identity.title,
        repository,
        graphify: true,
        graphifyOutput: graphify.output,
        verificationDefaults: scripts,
        valid: true,
      },
      stages,
      verification,
      graphify,
      registration: registrationTransaction.summary,
      auditPath: toPosix(path.relative(runsRoot, onboardingAuditPath(runsRoot, onboardingId))),
      nextAction: `npm run request-task -- ${identity.id} "Instruksi task" --start --by user`,
    };
    persistOnboardingAudit(runsRoot, onboardingId, result);
    return result;
  } catch (error) {
    registrationTransaction?.rollback();
    const failure = {
      schemaVersion: 1,
      action: "EXISTING_PROJECT_FAILED",
      onboardingId,
      project: { id: identity.id, repository },
      stages,
      error: error.message,
    };
    persistOnboardingAudit(runsRoot, onboardingId, failure);
    throw error;
  }
}

export async function addNewProject({
  vaultRoot,
  runsRoot,
  projectName,
  targetPath,
  blueprint = DEFAULT_BLUEPRINT,
  registeredBy = "user",
  processRunner = runProcess,
  onProgress = () => {},
  allowAgentFallback = configuredOnboardingAiFallback(),
}) {
  const projectId = slugify(projectName);
  if (!projectId) throw new Error("Nama project baru tidak valid.");
  if (!BLUEPRINT_PATHS[blueprint]) throw new Error(`Blueprint belum didukung: ${blueprint}.`);
  const target = ensureAbsoluteSafePath(targetPath, { mustNotExist: true });
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`Parent directory target tidak ditemukan: ${parent}`);
  }
  assertRegistrationAvailable(vaultRoot, projectId, target);
  const blueprintPath = path.join(vaultRoot, BLUEPRINT_PATHS[blueprint]);
  if (!fs.existsSync(blueprintPath)) throw new Error(`Blueprint Wiki tidak ditemukan: ${blueprintPath}`);

  const onboardingId = `new-${projectId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const events = eventLogPath(runsRoot, onboardingId);
  const stageRoot = fs.mkdtempSync(path.join(parent, `.personal-ai-${projectId}-`));
  const stageMarker = path.join(stageRoot, ".personal-ai-onboarding-stage");
  fs.writeFileSync(stageMarker, `${onboardingId}\n`, "utf8");
  const generated = path.join(stageRoot, projectId);
  let movedToTarget = false;
  const stages = [];
  let agentTelemetry = null;
  let templateAudit = null;
  let agentFallback = { used: false, reason: "DETERMINISTIC_TEMPLATE_VERIFIED", scopeAudit: null };
  let dependency = null;
  let security = null;
  let registrationTransaction = null;

  try {
    await runRequired(processRunner, {
      command: "npx",
      args: ["-y", `shadcn@${SHADCN_VERSION}`, "init", "-t", "vite", "-b", "base", "-n", projectId, "-p", "nova", "--no-monorepo", "-y"],
      cwd: stageRoot,
      stage: "project-onboarding:shadcn-init",
      eventLogPath: events,
    }, "Vite + Shadcn initialization", onProgress);
    stages.push("SHADCN_INIT");
    if (!fs.existsSync(generated) || !fs.statSync(generated).isDirectory()) {
      throw new Error(`Shadcn tidak membuat project pada path yang diharapkan: ${generated}`);
    }

    await runRequired(processRunner, {
      command: "npx",
      args: ["-y", `shadcn@${SHADCN_VERSION}`, "add", "--all", "-y"],
      cwd: generated,
      stage: "project-onboarding:shadcn-add-all",
      eventLogPath: events,
    }, "Shadcn add --all", onProgress);
    stages.push("SHADCN_ADD_ALL");

    templateAudit = applyDeterministicTemplate({
      repository: generated,
      blueprint,
      expectedPolicyVersion: BLUEPRINT_POLICIES[blueprint].version,
    });
    emitProgress(onProgress, {
      state: "COMPLETED",
      stage: "project-onboarding:deterministic-template",
      label: `Deterministic template v${templateAudit.templateVersion}`,
      elapsedSeconds: 0,
    });
    stages.push("DETERMINISTIC_TEMPLATE_APPLIED", "BLUEPRINT_APPLIED");

    dependency = await installBlueprintDependencies({
      repository: generated,
      blueprint,
      processRunner,
      eventLogPath: events,
      onProgress,
    });
    stages.push("DEPENDENCY_POLICY_APPLIED", "DEPENDENCIES_RESOLVED");
    stages.push("DEPENDENCIES_INSTALLED");

    let packageDocument = readPackage(generated);
    let scripts = verificationScripts(packageDocument, { requireNewBaseline: true });
    let blueprintAudit = assertBlueprintResult(generated);
    let verification;
    try {
      verification = await runVerification({
        repository: generated,
        scripts,
        processRunner,
        eventLogPath: events,
        onProgress,
      });
    } catch (verificationError) {
      if (!allowAgentFallback) {
        throw new Error(`${verificationError.message}\nAI fallback dinonaktifkan oleh ORCHESTRATOR_ONBOARDING_AI_FALLBACK.`);
      }
      const beforeAgent = repositoryFileSnapshot(generated);
      const agentInvocation = scaffoldFallbackAgentInvocation({
        repository: generated,
        projectId,
        blueprintPath,
        verificationError: verificationError.message,
      });
      const agentResult = await runRequired(processRunner, {
        ...agentInvocation,
        cwd: generated,
        stage: "project-onboarding:blueprint-agent",
        eventLogPath: events,
      }, "Blueprint fallback agent", onProgress);
      const fallbackChangedPaths = changedSnapshotPaths(beforeAgent, repositoryFileSnapshot(generated));
      agentFallback = {
        used: true,
        reason: "DETERMINISTIC_VERIFICATION_FAILED",
        initialError: verificationError.message,
        scopeAudit: assertFallbackScope(fallbackChangedPaths, templateAudit.filesWritten),
      };
      assertNoSensitiveEnvironmentFiles(generated);
      agentTelemetry = createAgentTelemetryRecord({
        stage: "PROJECT_ONBOARDING_FALLBACK",
        result: agentResult,
        agentConfig: agentInvocation.agentConfig,
        invocationId: onboardingId,
        metadata: { onboardingId, projectId, blueprint },
      });
      stages.push("AI_FALLBACK_APPLIED");

      const initialDependency = dependency;
      const fallbackDependency = await installBlueprintDependencies({
        repository: generated,
        blueprint,
        processRunner,
        eventLogPath: events,
        onProgress,
      });
      dependency = {
        ...fallbackDependency,
        repeatedAfterFallback: true,
        history: [initialDependency, fallbackDependency],
      };
      packageDocument = readPackage(generated);
      scripts = verificationScripts(packageDocument, { requireNewBaseline: true });
      blueprintAudit = assertBlueprintResult(generated);
      verification = await runVerification({
        repository: generated,
        scripts,
        processRunner,
        eventLogPath: events,
        onProgress,
      });
      stages.push("AI_FALLBACK_VERIFIED");
    }
    assertNoSensitiveEnvironmentFiles(generated);
    stages.push("VERIFIED");

    appendGitignore(generated, ".env");
    appendGitignore(generated, ".env.*");
    appendGitignore(generated, "!.env.example");
    appendGitignore(generated, "graphify-out");
    if (!fs.existsSync(path.join(generated, ".git"))) {
      await runRequired(processRunner, {
        command: "git",
        args: ["init"],
        cwd: generated,
        stage: "project-onboarding:git-init",
        eventLogPath: events,
      }, "Git initialization", onProgress);
    }
    await runRequired(processRunner, {
      command: "git",
      args: ["add", "."],
      cwd: generated,
      stage: "project-onboarding:git-add",
      eventLogPath: events,
    }, "Git staging", onProgress);
    const stagedResult = await runRequired(processRunner, {
      command: "git",
      args: ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
      cwd: generated,
      stage: "project-onboarding:security-staged-files",
      eventLogPath: events,
    }, "Initial commit security gate", onProgress);
    security = {
      envIgnored: true,
      ...assertSafeStagedFiles(String(stagedResult.stdoutTail ?? "").split(/\r?\n/)),
    };
    stages.push("SECURITY_GATE_PASSED");
    await runRequired(processRunner, {
      command: "git",
      args: [
        "-c", "user.name=Personal AI Orchestrator",
        "-c", "user.email=orchestrator@local.invalid",
        "commit", "-m", "chore: initialize project from orchestrator blueprint",
      ],
      cwd: generated,
      stage: "project-onboarding:git-commit",
      eventLogPath: events,
    }, "Initial Git commit", onProgress);
    stages.push("GIT_INITIALIZED");

    fs.renameSync(generated, target);
    movedToTarget = true;
    const graphify = await updateGraphify({ repository: target, processRunner, eventLogPath: events, onProgress });
    stages.push("GRAPHIFY_BOOTSTRAPPED");

    const finalPackage = readPackage(target);
    registrationTransaction = registerProject({
      vaultRoot,
      registeredBy: auditIdentity(registeredBy),
      input: {
        title: titleFromId(projectId),
        projectId,
        repository: target,
        graphifyOutput: graphify.output,
        verificationDefaults: scripts,
        tags: frameworkTags(finalPackage),
        blueprint,
        templateVersion: templateAudit.templateVersion,
        blueprintPolicyVersion: templateAudit.policyVersion,
        templateChecksum: templateAudit.checksum,
        scaffoldMode: agentFallback.used ? "DETERMINISTIC_WITH_AI_FALLBACK" : "DETERMINISTIC_TEMPLATE",
      },
    });
    stages.push("REGISTERED");
    emitProgress(onProgress, {
      state: "COMPLETED",
      stage: "project-onboarding:wiki-registration",
      label: "Wiki project registration",
      elapsedSeconds: 0,
    });

    const result = {
      schemaVersion: 1,
      action: "NEW_PROJECT_CREATED",
      onboardingId,
      project: {
        id: projectId,
        title: titleFromId(projectId),
        repository: target,
        blueprint,
        scaffoldMode: agentFallback.used ? "DETERMINISTIC_WITH_AI_FALLBACK" : "DETERMINISTIC_TEMPLATE",
        shadcn: { version: SHADCN_VERSION, base: "base", preset: "nova", allComponents: true },
        graphify: true,
        graphifyOutput: graphify.output,
        verificationDefaults: scripts,
        valid: true,
      },
      stages,
      template: templateAudit,
      agentFallback,
      dependency,
      security,
      blueprintAudit,
      verification,
      graphify,
      registration: registrationTransaction.summary,
      telemetry: agentTelemetry,
      auditPath: toPosix(path.relative(runsRoot, onboardingAuditPath(runsRoot, onboardingId))),
      nextAction: `npm run request-task -- ${projectId} "Instruksi task" --start --by user`,
    };
    persistOnboardingAudit(runsRoot, onboardingId, result);
    cleanupStaging(stageRoot);
    return result;
  } catch (error) {
    registrationTransaction?.rollback();
    if (movedToTarget && fs.existsSync(target) && !fs.existsSync(generated)) {
      try {
        fs.renameSync(target, generated);
        movedToTarget = false;
      } catch (rollbackError) {
        throw new Error(`${error.message}\nRollback target gagal: ${rollbackError.message}. Project dipertahankan di ${target}.`);
      }
    }
    cleanupStaging(stageRoot);
    const failure = {
      schemaVersion: 1,
      action: "NEW_PROJECT_FAILED",
      onboardingId,
      project: { id: projectId, target, blueprint },
      stages,
      error: error.message,
      template: templateAudit,
      agentFallback,
      dependency,
      security,
      telemetry: agentTelemetry,
    };
    persistOnboardingAudit(runsRoot, onboardingId, failure);
    throw error;
  }
}

export function removeProject({
  vaultRoot,
  runsRoot,
  projectId: requestedProjectId,
  removedBy = "user",
  now = new Date(),
  auditWriter = persistOnboardingAudit,
}) {
  const projectId = safeProjectId(requestedProjectId);
  const registryPath = path.join(vaultRoot, "project-registry.md");
  const indexPath = path.join(vaultRoot, "index.md");
  const logPath = path.join(vaultRoot, "wiki-log.md");
  for (const required of [registryPath, indexPath, logPath]) {
    if (!fs.existsSync(required)) throw new Error(`Vault control file tidak ditemukan: ${required}`);
  }

  const registryContent = fs.readFileSync(registryPath, "utf8");
  const registryProject = registryRows(registryContent).find((row) => row.id === projectId);
  if (!registryProject) throw new Error(`Project ${projectId} tidak ditemukan di project-registry.md.`);
  const projectRoot = path.join(vaultRoot, "02-Projects", projectId);
  const projectPagePath = path.join(projectRoot, "project.md");
  if (!fs.existsSync(projectPagePath)) {
    throw new Error(`Project page tidak ditemukan dan tidak dapat diarsipkan: ${projectPagePath}`);
  }

  const blockers = projectRemovalBlockers({ runsRoot, projectId, projectRoot });
  if (blockers.length > 0) {
    const error = new Error(`Project ${projectId} masih memiliki task/job/run aktif dan belum aman dihapus dari orchestrator.`);
    error.details = { blockers };
    throw error;
  }

  const projectPage = fs.readFileSync(projectPagePath, "utf8");
  const title = frontmatterField(projectPage, "title") || titleFromId(projectId);
  const repository = path.resolve(registryProject.repository);
  const graphifyOutput = frontmatterField(projectPage, "graphify_output") || graphOutputPath(repository);
  const removedAt = now.toISOString();
  const archiveVersion = `${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const archiveBase = path.join(vaultRoot, "03-Sources", "other", "removed-projects");
  const archiveRoot = path.join(archiveBase, projectId, archiveVersion);
  const archivePath = toPosix(path.relative(vaultRoot, archiveRoot));
  const archiveProjectPage = `${archivePath}/project`;
  const manifestPath = path.join(archiveRoot, "removal-manifest.json");
  let inventory = [];
  const onboardingId = `remove-${projectId}-${archiveVersion}`;
  const actor = auditIdentity(removedBy);
  const originalProjectMarkdown = new Map(
    walkProjectFiles(projectRoot)
      .filter((filePath) => filePath.endsWith(".md"))
      .map((filePath) => [filePath, fs.readFileSync(filePath, "utf8")]),
  );
  const backups = new Map([
    [registryPath, registryContent],
    [indexPath, fs.readFileSync(indexPath, "utf8")],
    [logPath, fs.readFileSync(logPath, "utf8")],
  ]);
  const linkedMarkdown = projectLinkedMarkdown(vaultRoot, projectRoot, projectId);
  for (const filePath of linkedMarkdown) {
    if (!backups.has(filePath)) backups.set(filePath, fs.readFileSync(filePath, "utf8"));
  }
  let archived = false;

  const rollback = () => {
    if (archived && fs.existsSync(archiveRoot) && !fs.existsSync(projectRoot)) {
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      fs.mkdirSync(path.dirname(projectRoot), { recursive: true });
      fs.renameSync(archiveRoot, projectRoot);
      archived = false;
      for (const [filePath, content] of originalProjectMarkdown) writeAtomic(filePath, content);
    }
    for (const [filePath, content] of backups) writeAtomic(filePath, content);
    removeEmptyDirectory(path.dirname(archiveRoot), archiveBase);
  };

  try {
    fs.mkdirSync(path.dirname(archiveRoot), { recursive: true });
    fs.renameSync(projectRoot, archiveRoot);
    archived = true;
    for (const archivedMarkdown of walkProjectFiles(archiveRoot).filter((filePath) => filePath.endsWith(".md"))) {
      const content = fs.readFileSync(archivedMarkdown, "utf8");
      writeAtomic(archivedMarkdown, rewriteProjectWikilinks(content, projectId, archivePath, removedAt));
    }
    for (const filePath of linkedMarkdown) {
      writeAtomic(filePath, rewriteProjectWikilinks(backups.get(filePath), projectId, archivePath, removedAt));
    }
    inventory = projectArchiveInventory(archiveRoot);
    const removalManifest = {
      schemaVersion: 1,
      action: "PROJECT_UNREGISTERED_AND_ARCHIVED",
      removedAt,
      removedBy: actor,
      project: {
        id: projectId,
        title,
        repository,
        graphifyOutput,
      },
      archive: {
        sourcePath: `02-Projects/${projectId}`,
        path: archivePath,
        inventory,
        wikilinkRewrite: {
          from: `02-Projects/${projectId}/`,
          to: `${archivePath}/`,
          mutablePagesUpdated: linkedMarkdown.length,
        },
      },
      preservation: {
        repository: true,
        graphify: true,
        globalKnowledge: true,
        knowledgeCandidates: true,
        immutableRunSources: true,
      },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(removalManifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    writeAtomic(registryPath, updatedRegistryForRemoval(backups.get(registryPath), projectId));
    writeAtomic(indexPath, updatedIndexForRemoval(backups.get(indexPath), { projectId, title, archiveProjectPage }));
    writeAtomic(logPath, removalLog(
      rewriteProjectWikilinks(backups.get(logPath), projectId, archivePath, removedAt),
      {
      projectId,
      repository,
      removedAt,
      removedBy: actor,
      archivePath,
      inventory,
      },
    ));

    const result = {
      schemaVersion: 1,
      action: "PROJECT_UNREGISTERED_AND_ARCHIVED",
      onboardingId,
      project: {
        id: projectId,
        title,
        repository,
        graphifyOutput,
        active: false,
      },
      archive: {
        path: archivePath,
        projectPage: `${archiveProjectPage}.md`,
        manifest: `${archivePath}/removal-manifest.json`,
        fileCount: inventory.length,
        taskCount: inventory.filter((item) => item.path.startsWith("tasks/") && item.path.endsWith(".md")).length,
      },
      preservation: removalManifest.preservation,
      registry: {
        projectRemoved: true,
        activeIndexLinksRemoved: true,
        archiveIndexed: true,
        wikiLogUpdated: true,
      },
      auditPath: toPosix(path.relative(runsRoot, onboardingAuditPath(runsRoot, onboardingId))),
      nextAction: `Untuk mengaktifkan kembali: npm run add-project -- existing ${JSON.stringify(repository)} --id ${projectId} --by user`,
    };
    auditWriter(runsRoot, onboardingId, result);
    return result;
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new Error(`${error.message}\nRollback project removal gagal: ${rollbackError.message}`);
    }
    try {
      persistOnboardingAudit(runsRoot, onboardingId, {
        schemaVersion: 1,
        action: "PROJECT_REMOVAL_FAILED",
        onboardingId,
        project: { id: projectId, repository },
        error: error.message,
        rolledBack: true,
      });
    } catch {
      // The original failure remains authoritative when the audit store is unavailable.
    }
    throw error;
  }
}

export function purgeProjectArchive({
  vaultRoot,
  runsRoot,
  projectId: requestedProjectId,
  purgedBy = "user",
  confirmed = false,
  now = new Date(),
  auditWriter = persistOnboardingAudit,
}) {
  const projectId = safeProjectId(requestedProjectId);
  if (!confirmed) {
    throw new Error("Permanent archive purge membutuhkan flag --confirm.");
  }

  const registryPath = path.join(vaultRoot, "project-registry.md");
  const indexPath = path.join(vaultRoot, "index.md");
  const logPath = path.join(vaultRoot, "wiki-log.md");
  for (const required of [registryPath, indexPath, logPath]) {
    if (!fs.existsSync(required)) throw new Error(`Vault control file tidak ditemukan: ${required}`);
  }

  const registryContent = fs.readFileSync(registryPath, "utf8");
  if (registryRows(registryContent).some((row) => row.id === projectId)) {
    throw new Error(`Project ${projectId} masih aktif. Jalankan remove-project sebelum purge archive.`);
  }
  const activeProjectRoot = path.join(vaultRoot, "02-Projects", projectId);
  if (fs.existsSync(activeProjectRoot)) {
    throw new Error(`Project page ${projectId} masih aktif di 02-Projects dan tidak boleh dipurge.`);
  }
  const activeBlockers = projectRemovalBlockers({ runsRoot, projectId, projectRoot: activeProjectRoot });
  if (activeBlockers.length > 0) {
    const error = new Error(`Project ${projectId} masih memiliki job/run aktif dan archive belum aman dipurge.`);
    error.details = { blockers: activeBlockers };
    throw error;
  }

  const archiveBase = path.join(vaultRoot, "03-Sources", "other", "removed-projects");
  const archiveRoot = path.join(archiveBase, projectId);
  if (!fs.existsSync(archiveRoot) || !fs.statSync(archiveRoot).isDirectory()) {
    throw new Error(`Archive project tidak ditemukan: ${toPosix(path.relative(vaultRoot, archiveRoot))}`);
  }
  const linkBlockers = archivePurgeLinkBlockers({ vaultRoot, archiveRoot, projectId, indexPath });
  if (linkBlockers.length > 0) {
    const error = new Error(`Archive ${projectId} masih memiliki backlink di luar index dan belum aman dipurge.`);
    error.details = { backlinks: linkBlockers };
    throw error;
  }

  const purgedAt = now.toISOString();
  const purgeVersion = `${compactTimestamp(now)}-${randomUUID().slice(0, 8)}`;
  const onboardingId = `purge-${projectId}-${purgeVersion}`;
  const quarantineRoot = path.join(runsRoot, "purged-project-archives", projectId, purgeVersion);
  const quarantineArchive = path.join(quarantineRoot, "archive");
  const quarantineManifest = path.join(quarantineRoot, "purge-manifest.json");
  if (fs.existsSync(quarantineRoot)) throw new Error(`Quarantine target sudah ada: ${quarantineRoot}`);
  fs.mkdirSync(quarantineRoot, { recursive: true });
  if (fs.statSync(archiveRoot).dev !== fs.statSync(quarantineRoot).dev) {
    fs.rmdirSync(quarantineRoot);
    throw new Error("Vault dan quarantine berada di filesystem berbeda; transactional purge tidak dapat dilakukan.");
  }

  const inventory = projectArchiveInventory(archiveRoot);
  const archiveVersions = fs.readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).length;
  const actor = auditIdentity(purgedBy);
  const quarantinePath = toPosix(path.relative(runsRoot, quarantineRoot));
  const backups = new Map([
    [indexPath, fs.readFileSync(indexPath, "utf8")],
    [logPath, fs.readFileSync(logPath, "utf8")],
  ]);
  let moved = false;

  const rollback = () => {
    for (const [filePath, content] of backups) writeAtomic(filePath, content);
    if (moved && fs.existsSync(quarantineArchive) && !fs.existsSync(archiveRoot)) {
      fs.mkdirSync(path.dirname(archiveRoot), { recursive: true });
      fs.renameSync(quarantineArchive, archiveRoot);
      moved = false;
    }
    if (fs.existsSync(quarantineRoot)) fs.rmSync(quarantineRoot, { recursive: true, force: true });
    removeEmptyDirectory(path.dirname(quarantineRoot), path.join(runsRoot, "purged-project-archives"));
  };

  try {
    fs.renameSync(archiveRoot, quarantineArchive);
    moved = true;
    const manifest = {
      schemaVersion: 1,
      action: "PROJECT_ARCHIVE_PURGED_FROM_VAULT",
      purgedAt,
      purgedBy: actor,
      project: { id: projectId, active: false },
      source: {
        vaultPath: `03-Sources/other/removed-projects/${projectId}`,
        archiveVersions,
        inventory,
      },
      quarantine: {
        path: quarantinePath,
        archivePath: `${quarantinePath}/archive`,
        recoverable: true,
      },
      preservation: {
        repository: true,
        graphify: true,
        globalKnowledge: true,
        knowledgeCandidates: true,
        runHistory: true,
      },
    };
    writeJsonAtomic(quarantineManifest, manifest);
    writeAtomic(indexPath, updatedIndexForArchivePurge(backups.get(indexPath), projectId));
    writeAtomic(logPath, archivePurgeLog(backups.get(logPath), {
      projectId,
      purgedAt,
      purgedBy: actor,
      archiveVersions,
      inventory,
      quarantinePath,
    }));

    const result = {
      schemaVersion: 1,
      action: "PROJECT_ARCHIVE_PURGED_FROM_VAULT",
      onboardingId,
      project: { id: projectId, active: false },
      archive: {
        removedFromVault: true,
        sourcePath: `03-Sources/other/removed-projects/${projectId}`,
        versions: archiveVersions,
        fileCount: inventory.length,
      },
      quarantine: manifest.quarantine,
      preservation: manifest.preservation,
      registry: {
        projectInactive: true,
        archiveIndexRemoved: true,
        wikiLogUpdated: true,
      },
      auditPath: toPosix(path.relative(runsRoot, onboardingAuditPath(runsRoot, onboardingId))),
      nextAction: "Archive sudah tidak terlihat di Obsidian; repository external tetap dipertahankan.",
    };
    auditWriter(runsRoot, onboardingId, result);
    return result;
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new Error(`${error.message}\nRollback archive purge gagal: ${rollbackError.message}`);
    }
    try {
      persistOnboardingAudit(runsRoot, onboardingId, {
        schemaVersion: 1,
        action: "PROJECT_ARCHIVE_PURGE_FAILED",
        onboardingId,
        project: { id: projectId },
        error: error.message,
        rolledBack: true,
      });
    } catch {
      // The original failure remains authoritative when the audit store is unavailable.
    }
    throw error;
  }
}

export const PROJECT_BLUEPRINTS = BLUEPRINT_PATHS;
