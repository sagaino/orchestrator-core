import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_CLI = fileURLToPath(import.meta.url);
export const ORCHESTRATOR_ROOT = path.resolve(path.dirname(ORCHESTRATOR_CLI), "..");
export const DEFAULT_VAULT = "/Users/sagaino/Documents/Obsidian Vault";

export const STOP_WORDS = new Set([
  "yang",
  "untuk",
  "dengan",
  "dari",
  "pada",
  "dalam",
  "atau",
  "agar",
  "bisa",
  "akan",
  "task",
  "project",
  "code",
  "file",
  "implementasi",
  "implement",
  "the",
  "and",
  "with",
  "from",
  "this",
  "that",
]);

export function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

export function exists(filePath) {
  return fs.existsSync(filePath);
}

export function readText(filePath) {
  if (!exists(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

export function cleanCell(value) {
  return value.trim().replace(/^`|`$/g, "").replace(/^<|>$/g, "");
}

export function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cleanCell);
}

export function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => parseScalar(item))
      .filter((item) => item !== "");
  }
  return trimmed;
}

export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return {};

  const metadata = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([^\s:#][^:]*):(?:\s*(.*))?$/);
    if (!field) continue;

    const key = field[1].trim();
    const rawValue = field[2] ?? "";
    if (rawValue.trim() !== "") {
      metadata[key] = parseScalar(rawValue);
      continue;
    }

    const items = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const item = lines[nextIndex].match(/^\s+-\s+(.*)$/);
      if (!item) break;
      items.push(parseScalar(item[1]));
      nextIndex += 1;
    }

    if (items.length > 0) {
      metadata[key] = items;
      index = nextIndex - 1;
    } else {
      metadata[key] = "";
    }
  }
  return metadata;
}

export function readMarkdown(filePath, vaultRoot) {
  const text = readText(filePath);
  if (text === null) return null;
  const metadata = parseFrontmatter(text);
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const content = frontmatter ? text.slice(frontmatter[0].length) : text;
  const heading = text.match(/^#\s+(.+)$/m);
  return {
    path: path.relative(vaultRoot, filePath),
    absolutePath: filePath,
    metadata,
    title: metadata.title ?? heading?.[1]?.trim() ?? path.basename(filePath, ".md"),
    body: content,
  };
}

export function parseProjectRegistry(registryText) {
  const projects = [];
  for (const line of registryText.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitTableRow(line);
    if (cells.length < 6 || cells[0] === "project_id" || /^-+$/.test(cells[0])) continue;
    const [id, projectPage, repository, agent, graphify, graphifyOutput] = cells;
    if (!id || !repository) continue;
    projects.push({
      id,
      projectPage,
      repository,
      agent,
      graphify: graphify === "true",
      graphifyOutput,
    });
  }
  return projects;
}

export function loadRegistry(vaultRoot) {
  const registryPath = path.join(vaultRoot, "project-registry.md");
  const registryText = readText(registryPath);
  if (registryText === null) fail("Project registry tidak ditemukan", { registryPath });
  return {
    path: path.relative(vaultRoot, registryPath),
    projects: parseProjectRegistry(registryText),
  };
}

export function projectPagePath(vaultRoot, projectPage) {
  const target = projectPage.match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/)?.[1] ?? projectPage;
  const withoutExtension = target.endsWith(".md") ? target : `${target}.md`;
  return path.join(vaultRoot, withoutExtension);
}

export function walkMarkdown(directory) {
  if (!exists(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
  }
  return files;
}

export function resolveTaskFile(vaultRoot, projectId, taskInput) {
  const tasksDirectory = path.join(vaultRoot, "02-Projects", projectId, "tasks");
  if (!exists(tasksDirectory)) fail("Direktori task project tidak ditemukan", { tasksDirectory });

  const normalizedInput = taskInput.trim();
  const directCandidates = [
    path.isAbsolute(normalizedInput) ? normalizedInput : path.join(vaultRoot, normalizedInput),
    path.join(tasksDirectory, normalizedInput),
    path.join(tasksDirectory, normalizedInput.endsWith(".md") ? normalizedInput : `${normalizedInput}.md`),
  ];
  for (const candidate of directCandidates) {
    if (exists(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  const matchingTask = walkMarkdown(tasksDirectory).find((filePath) => {
    const document = readMarkdown(filePath, vaultRoot);
    return String(document?.metadata?.task_id ?? "").toLowerCase() === normalizedInput.toLowerCase();
  });
  if (matchingTask) return matchingTask;

  fail("Task tidak ditemukan", {
    projectId,
    taskInput,
    tasksDirectory: path.relative(vaultRoot, tasksDirectory),
  });
}

export function tokenize(text) {
  return [...new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])
      .filter((token) => !STOP_WORDS.has(token)),
  )];
}

export function extractConciseKnowledgeSection(body, maxLength = 500) {
  if (!body || typeof body !== "string") return "";
  const lines = body.split(/\r?\n/);
  const extractedLines = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (!trimmed) continue;
    if (trimmed.startsWith("# ")) continue;

    extractedLines.push(trimmed);
    if (extractedLines.join("\n").length >= maxLength) break;
  }

  const result = extractedLines.join("\n");
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}

export function findRelevantKnowledge(vaultRoot, taskDocument) {
  const terms = tokenize(`${taskDocument.title}\n${taskDocument.body}`);
  const knowledgeDirectory = path.join(vaultRoot, "01-Knowledge");
  const matches = [];

  for (const filePath of walkMarkdown(knowledgeDirectory)) {
    if (path.basename(filePath).startsWith("_Template")) continue;
    const document = readMarkdown(filePath, vaultRoot);
    const searchable = document.body.toLowerCase();
    const matchedTerms = terms.filter((term) => searchable.includes(term));
    if (matchedTerms.length === 0) continue;
    const titleBonus = terms.some((term) => document.title.toLowerCase().includes(term)) ? 2 : 0;
    matches.push({
      path: document.path,
      title: document.title,
      type: document.metadata.type ?? null,
      score: matchedTerms.length + titleBonus,
      matchedTerms: matchedTerms.slice(0, 8),
      summary: extractConciseKnowledgeSection(document.body),
    });
  }

  return matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, 3);
}

export function readGraphSummary(graphPath) {
  if (!exists(graphPath)) return { exists: false, path: graphPath };
  try {
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    return {
      exists: true,
      path: graphPath,
      nodes: Array.isArray(graph.nodes) ? graph.nodes.length : null,
      links: Array.isArray(graph.links) ? graph.links.length : null,
      builtAtCommit: graph.built_at_commit ?? null,
    };
  } catch (error) {
    return {
      exists: true,
      path: graphPath,
      parseError: error.message,
    };
  }
}

export function getPackageScripts(repository) {
  const packagePath = path.join(repository, "package.json");
  if (!exists(packagePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

export function validateProject(vaultRoot, project) {
  const projectPage = projectPagePath(vaultRoot, project.projectPage);
  const projectDocument = readMarkdown(projectPage, vaultRoot);
  const repositoryExists = exists(project.repository) && fs.statSync(project.repository).isDirectory();
  const graphExists = exists(project.graphifyOutput);
  return {
    ...project,
    repositoryExists,
    projectPageExists: exists(projectPage),
    verificationDefaults: Array.isArray(projectDocument?.metadata?.verification_defaults)
      ? projectDocument.metadata.verification_defaults.map(String)
      : [],
    graphOutputExists: graphExists,
    valid: repositoryExists && exists(projectPage) && (!project.graphify || graphExists),
    projectPagePath: path.relative(vaultRoot, projectPage),
  };
}

export function projectPageExists(projectPage) {
  return exists(projectPage);
}

export function listProjects(vaultRoot = DEFAULT_VAULT) {
  const registry = loadRegistry(vaultRoot);
  return {
    mode: "read-only",
    vault: vaultRoot,
    registry: registry.path,
    projects: registry.projects.map((project) => validateProject(vaultRoot, project)),
  };
}

export function buildContext(vaultRoot, projectId, taskInput) {
  const registry = loadRegistry(vaultRoot);
  const project = registry.projects.find((item) => item.id === projectId);
  if (!project) fail("Project tidak ditemukan di registry", { projectId, knownProjects: registry.projects.map((item) => item.id) });

  const taskPath = resolveTaskFile(vaultRoot, projectId, taskInput);
  const task = readMarkdown(taskPath, vaultRoot);
  const projectPage = readMarkdown(projectPagePath(vaultRoot, project.projectPage), vaultRoot);
  const graphSummary = readGraphSummary(project.graphifyOutput);
  const graphReportPath = path.join(project.repository, "graphify-out", "GRAPH_REPORT.md");

  return {
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    vault: vaultRoot,
    sourcesOfTruth: {
      wiki: "01-Knowledge/",
      repository: project.repository,
      task: task.path,
      graph: project.graphifyOutput,
    },
    project: {
      id: project.id,
      repository: project.repository,
      agent: project.agent,
      graphify: project.graphify,
      repositoryExists: exists(project.repository),
      projectPage: projectPage?.path ?? null,
      graphReport: exists(graphReportPath) ? graphReportPath : null,
      graphSummary,
      packageScripts: getPackageScripts(project.repository),
    },
    task: {
      path: task.path,
      title: task.title,
      metadata: task.metadata,
      instruction: task.body,
    },
    wiki: {
      index: "index.md",
      rules: "AGENTS.md",
      relevantKnowledge: findRelevantKnowledge(vaultRoot, task),
    },
    guardrails: [
      "Tidak ada file repository, task, atau Wiki yang diubah pada mode ini.",
      "Graphify hanya dipakai sebagai peta dependency; repository tetap menjadi source of truth untuk kode.",
      "Task code wajib melalui pre-edit context dan post-edit verification.",
      "Knowledge baru hanya dipromosikan setelah hasil task terverifikasi.",
    ],
  };
}

export function chooseVerificationCommands(packageScripts, requestedScripts = []) {
  const preferred = ["typecheck", "test", "lint", "build"];
  const requested = Array.isArray(requestedScripts) && requestedScripts.length > 0
    ? requestedScripts.map(String)
    : preferred;
  return requested
    .filter((name) => /^[A-Za-z0-9:_-]+$/.test(name) && packageScripts[name])
    .map((name) => `npm run ${name}`);
}

export function buildPlan(context) {
  const taskText = context.task.instruction.toLowerCase();
  const uiTask = /ui|component|frontend|form|page|button|layout|style|tailwind|shadcn/.test(taskText);
  const verificationCommands = chooseVerificationCommands(
    context.project.packageScripts,
    context.task.metadata.verification,
  );
  const status = String(context.task.metadata.status ?? "UNKNOWN").toUpperCase();
  const completed = ["DONE", "VERIFIED", "COMPLETED"].includes(status);

  if (completed) {
    return {
      generatedAt: new Date().toISOString(),
      mode: "read-only",
      project: context.project.id,
      task: context.task.path,
      status,
      steps: [
        "Validasi bahwa task sudah selesai dan repository project masih dapat ditemukan.",
        "Baca knowledge yang relevan dan graph dependency project dari output Graphify terbaru.",
        "Review log perubahan dan bukti verifikasi yang tercatat pada task.",
        "Ekstrak insight reusable dari hasil task dan klasifikasikan sebagai Wiki, Candidate, atau project-specific.",
      ],
      verificationCommands,
      proposedWrites: [],
      approvalRequired: false,
      note: "Task berstatus selesai; planner tetap read-only dan knowledge sync hanya berjalan melalui run yang disetujui.",
    };
  }

  const steps = [
    "Validasi task, project registry, dan repository path.",
    "Baca knowledge yang relevan dan graph dependency project dari output Graphify terbaru.",
  ];
  if (uiTask) steps.push("Periksa src/components/ui/ sebelum membuat komponen UI baru.");
  steps.push(
    "Tentukan file yang terdampak dan rencanakan perubahan dengan acceptance criteria task.",
    "Minta approval eksplisit sebelum melakukan perubahan pada repository.",
    "Implementasikan perubahan pada repository project.",
    verificationCommands.length > 0
      ? `Jalankan verifikasi: ${verificationCommands.join(", ")}.`
      : "Identifikasi dan jalankan command verifikasi yang tersedia di repository.",
    "Perbarui task, topology project, dan hasil verifikasi setelah perubahan berhasil.",
    "Ekstrak insight reusable; masukkan ke Knowledge Candidate atau Wiki sesuai klasifikasi.",
  );

  return {
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    project: context.project.id,
    task: context.task.path,
    status,
    steps,
    verificationCommands,
    proposedWrites: [],
    approvalRequired: true,
    note: "Planner ini read-only. Perubahan hanya dilakukan oleh run yang sudah di-approve, di-claim, diverifikasi, dan melewati knowledge decision.",
  };
}
