import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agyConfigArgs, resolveAgyConfig } from "./agent-config.mjs";
import { runProcess } from "./executor.mjs";
import { enqueueTaskJob } from "./job-queue.mjs";
import { createAgentTelemetryRecord, persistIntakeTelemetry } from "./telemetry.mjs";
import { tryDeterministicTaskDraft } from "./fast-path-intake.mjs";

function taskDraftSchema() {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "purpose",
      "expectedResult",
      "acceptanceCriteria",
      "dependencies",
      "verification",
      "allowedPaths",
      "requiresChanges",
      "risk",
      "clarificationNeeded",
      "clarificationQuestion",
    ],
    properties: {
      title: { type: "string" },
      purpose: { type: "string" },
      expectedResult: { type: "string" },
      acceptanceCriteria: { type: "array", items: { type: "string" } },
      dependencies: { type: "array", items: { type: "string" } },
      verification: { type: "array", items: { type: "string" } },
      allowedPaths: { type: "array", items: { type: "string" } },
      requiresChanges: { type: "boolean" },
      risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
      clarificationNeeded: { type: "boolean" },
      clarificationQuestion: { type: ["string", "null"] },
    },
  });
}

function unwrapStructured(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.title && payload.purpose) return payload;
  if (payload.structured_output) return unwrapStructured(payload.structured_output);
  if (typeof payload.response === "string") {
    try {
      return unwrapStructured(JSON.parse(payload.response));
    } catch {
      return null;
    }
  }
  return null;
}

export function cleanTerminalOutput(rawOutput) {
  if (!rawOutput || typeof rawOutput !== "string") return "";

  // Strip ANSI escape codes
  const cleanAnsi = rawOutput.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
  const lines = cleanAnsi.split(/\r?\n/);
  const filteredLines = [];
  let previousLine = null;
  let omittedNodeModulesCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Identify node_modules / internal runtime stack trace lines
    const isNodeModulesTrace =
      /\bat\s+.*[/\\]node_modules[/\\]/.test(line) ||
      /\bat\s+.*node:internal[/\\]/.test(line) ||
      (trimmed.startsWith("at ") && (line.includes("node_modules/") || line.includes("node_modules\\")));

    if (isNodeModulesTrace) {
      omittedNodeModulesCount++;
      continue;
    }

    if (omittedNodeModulesCount > 0) {
      filteredLines.push(`    [... ${omittedNodeModulesCount} node_modules stack trace lines omitted ...]`);
      omittedNodeModulesCount = 0;
    }

    // Deduplicate consecutive identical lines
    if (trimmed && trimmed === previousLine) {
      continue;
    }

    filteredLines.push(line);
    if (trimmed) {
      previousLine = trimmed;
    }
  }

  if (omittedNodeModulesCount > 0) {
    filteredLines.push(`    [... ${omittedNodeModulesCount} node_modules stack trace lines omitted ...]`);
  }

  return filteredLines.join("\n").trim();
}

export function cleanErrorTail(errorText, maxLength = 4000) {
  const cleaned = cleanTerminalOutput(errorText);
  return cleaned.length > maxLength ? cleaned.slice(-maxLength) : cleaned;
}

function parsePlannerResult(result) {
  const candidates = [result.finalResult];
  const cleanedStdout = cleanTerminalOutput(result.stdoutTail ?? "");
  for (const line of cleanedStdout.split("\n").reverse()) {
    try {
      candidates.push(JSON.parse(line));
    } catch {
      // Ignore non-JSON process output.
    }
  }
  for (const candidate of candidates) {
    const draft = unwrapStructured(candidate);
    if (draft) return draft;
  }
  throw new Error("Task planner tidak menghasilkan JSON terstruktur yang valid.");
}

function packageScripts(repository) {
  const filePath = path.join(repository, "package.json");
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

function existingTaskSummary(vaultRoot, projectId, readMarkdown) {
  const root = path.join(vaultRoot, "02-Projects", projectId, "tasks");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => readMarkdown(path.join(root, entry.name), vaultRoot))
    .filter(Boolean)
    .map((document) => ({
      id: String(document.metadata.task_id ?? ""),
      title: document.title,
      status: String(document.metadata.status ?? "UNKNOWN"),
    }))
    .filter((task) => task.id);
}

export function compactActiveTaskSummary(tasks) {
  return (tasks || [])
    .filter((task) => task.status !== "DONE" && task.status !== "SUPERSEDED")
    .slice(0, 5);
}

async function graphifyContext(project, request, eventLogPath, processRunner) {
  if (!project.graphify) return "Graphify disabled for this project.";
  const result = await processRunner({
    command: "graphify",
    args: ["query", request, "--budget", "1200"],
    cwd: project.repository,
    stage: "task-intake-graphify",
    eventLogPath,
  });
  if (result.exitCode !== 0) {
    const errorTail = cleanErrorTail(result.stderrTail || result.stdoutTail || "");
    return `Graphify query unavailable: ${errorTail || "unknown error"}`;
  }
  return cleanTerminalOutput(result.stdoutTail).trim();
}

export async function planTaskWithAgy({
  vaultRoot,
  runsRoot,
  project,
  request,
  attachedAssets = [],
  readMarkdown,
  processRunner = runProcess,
}) {
  const intakeId = `intake-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const eventLogPath = path.join(runsRoot, "intake", `${intakeId}.jsonl`);
  const scripts = packageScripts(project.repository);
  const tasks = existingTaskSummary(vaultRoot, project.id, readMarkdown);
  const graphContext = await graphifyContext(project, request, eventLogPath, processRunner);
  
  // Knowledge Retrieval: retrieve top-3 relevant architectural patterns from 01-Knowledge/
  const tempTaskDoc = { title: request.slice(0, 100), body: request };
  let relevantKnowledge = [];
  try {
    const { findRelevantKnowledge } = await import("./core.mjs");
    relevantKnowledge = findRelevantKnowledge(vaultRoot, tempTaskDoc);
  } catch {}

  const knowledgeContext = relevantKnowledge.length > 0
    ? relevantKnowledge
        .map((k) => `- [${k.title}] (${k.path})\n  Overview: ${k.summary}`)
        .join("\n\n")
    : "Tidak ada pola khusus.";

  // Attached UI Mockups / Project Assets Context
  let assetsContext = "Tidak ada aset visual terlampir.";
  if (Array.isArray(attachedAssets) && attachedAssets.length > 0) {
    assetsContext = attachedAssets.map((asset, idx) => {
      if (asset.type === "MOCKUP") {
        return `${idx + 1}. [UI Mockup Reference] File: \`${asset.relativeVaultPath || asset.fileName}\` (Path absolut: \`${asset.absolutePath}\`). Instruksi: Gunakan gambar ini sebagai referensi visual utama untuk styling/slicing layout.`;
      }
      return `${idx + 1}. [Project Production Asset] File: \`${asset.relativeProjectPath || asset.fileName}\` (Import: \`${asset.importPath || asset.relativeProjectPath}\`). Instruksi: Aset ini sudah disimpan di project repo, gunakan langsung dalam import komponen kode.`;
    }).join("\n");
  }

  const agentConfig = resolveAgyConfig(process.env, "task-intake");
  const prompt = [
    "=== ATURAN INTAKE & TASK PLANNER ===",
    "1. Susun draft task software engineering dari permintaan user. Jangan mengubah file apa pun.",
    "2. Gunakan path relatif repository dan pilih allowedPaths paling sempit yang praktis.",
    "3. Verification hanya boleh menggunakan nama script package.json yang tersedia.",
    "4. Dependencies hanya diisi bila task benar-benar bergantung pada task existing.",
    "5. Set clarificationNeeded=true hanya jika implementasi aman tidak mungkin direncanakan tanpa jawaban user.",
    "6. Pertimbangkan standar arsitektur dan pola implementasi yang relevan dari Wiki jika sesuai.",
    "7. Jika terdapat UI Mockup atau Asset terlampir, sertakan implementasi komponen UI yang mereferensikan desain/aset tersebut.",
    "",
    `Project: ${project.id} (${project.repository})`,
    `Package scripts: ${JSON.stringify(scripts)}`,
    `Project verification defaults: ${JSON.stringify(project.verificationDefaults ?? [])}`,
    `Existing tasks: ${JSON.stringify(compactActiveTaskSummary(tasks))}`,
    "",
    "=== ATTACHED UI MOCKUPS & ASSETS ===",
    assetsContext,
    "",
    "=== RELEVANT WIKI ARCHITECTURE PATTERNS ===",
    knowledgeContext,
    "",
    "=== GRAPHIFY TARGETED CONTEXT ===",
    graphContext || "Tidak ada node relevan.",
    "",
    "=== USER NATURAL LANGUAGE REQUEST ===",
    request,
  ].join("\n");
  const result = await processRunner({
    command: "agy",
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      taskDraftSchema(),
      ...agyConfigArgs(agentConfig),
      "--mode",
      "plan",
      "--print-timeout",
      "10m",
    ],
    cwd: project.repository,
    stage: "task-intake-planner",
    eventLogPath,
  });
  const telemetry = createAgentTelemetryRecord({
    stage: "TASK_INTAKE",
    result,
    agentConfig,
    invocationId: intakeId,
    metadata: { intakeId, projectId: project.id },
  });
  persistIntakeTelemetry({ runsRoot, intakeId, record: telemetry, project });
  if (result.exitCode !== 0) {
    const errorTail = cleanErrorTail(result.stderrTail || result.stdoutTail || "");
    throw new Error(`Task planner gagal dengan exit code ${result.exitCode}${errorTail ? `: ${errorTail}` : "."}`);
  }
  return { draft: parsePlannerResult(result), agentConfig, intakeId, telemetry };
}

function normalizePath(value) {
  const normalized = String(value).trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`allowed path tidak aman: ${value}`);
  }
  return normalized;
}

function normalizeDraft(raw, project) {
  const scripts = packageScripts(project.repository);
  const configuredDefaults = (project.verificationDefaults ?? []).map(String).filter((name) => scripts[name]);
  const verification = configuredDefaults.length
    ? [...new Set(configuredDefaults)]
    : [...new Set((raw.verification ?? []).map(String).filter((name) => scripts[name]))];
  if (!verification.length) {
    for (const preferred of ["typecheck", "test", "build", "lint"]) {
      if (scripts[preferred]) verification.push(preferred);
    }
  }
  const draft = {
    title: String(raw.title ?? "").trim(),
    purpose: String(raw.purpose ?? "").trim(),
    expectedResult: String(raw.expectedResult ?? "").trim(),
    acceptanceCriteria: (raw.acceptanceCriteria ?? []).map(String).map((item) => item.trim()).filter(Boolean),
    dependencies: (raw.dependencies ?? []).map(String).map((item) => item.trim()).filter(Boolean),
    verification,
    allowedPaths: [...new Set((raw.allowedPaths ?? []).map(normalizePath))],
    requiresChanges: raw.requiresChanges !== false,
    risk: ["LOW", "MEDIUM", "HIGH"].includes(String(raw.risk).toUpperCase()) ? String(raw.risk).toUpperCase() : "MEDIUM",
    clarificationNeeded: raw.clarificationNeeded === true,
    clarificationQuestion: raw.clarificationQuestion ? String(raw.clarificationQuestion).trim() : null,
  };
  if (!draft.title || !draft.purpose || !draft.expectedResult || !draft.acceptanceCriteria.length) {
    throw new Error("Task planner menghasilkan draft yang belum substantif.");
  }
  if (!draft.verification.length) {
    draft.clarificationNeeded = true;
    draft.clarificationQuestion = draft.clarificationQuestion || "Project tidak memiliki verification script yang dapat dipilih.";
  }
  if (draft.requiresChanges && !draft.allowedPaths.length) {
    draft.clarificationNeeded = true;
    draft.clarificationQuestion = draft.clarificationQuestion || "Target file belum dapat ditentukan dengan aman.";
  }
  return draft;
}

function nextTaskIdentity(tasks) {
  const numbered = tasks
    .map((task) => String(task.id).match(/^([A-Z][A-Z0-9]*)-(\d+)$/))
    .filter(Boolean)
    .map((match) => ({ prefix: match[1], number: Number(match[2]), width: match[2].length }));
  const counts = new Map();
  for (const task of numbered) counts.set(task.prefix, (counts.get(task.prefix) ?? 0) + 1);
  const prefix = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? "TASK";
  const samePrefix = numbered.filter((task) => task.prefix === prefix);
  const number = Math.max(0, ...samePrefix.map((task) => task.number)) + 1;
  const width = Math.max(3, ...samePrefix.map((task) => task.width));
  return { taskId: `${prefix}-${String(number).padStart(width, "0")}`, fileName: `task-${String(number).padStart(width, "0")}.md` };
}

function yamlArray(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function taskDocument({ taskId, projectId, request, draft, requestedBy, attachedAssets = [] }) {
  const today = new Date().toISOString().slice(0, 10);
  const bugTask = /\bbug\b|bug fix|fixing bug/i.test(`${draft.title}\n${request}`);
  
  const sources = attachedAssets
    .filter((a) => a.type === "MOCKUP" && a.relativeVaultPath)
    .map((a) => a.relativeVaultPath);

  const mockupsSection = attachedAssets.filter((a) => a.type === "MOCKUP").length > 0
    ? [
        "## UI Mockup References",
        "",
        ...attachedAssets
          .filter((a) => a.type === "MOCKUP")
          .map((a) => `- ![[${a.relativeVaultPath || a.fileName}]]\n  - Path: \`${a.relativeVaultPath || a.fileName}\``),
        "",
      ]
    : [];

  const assetsSection = attachedAssets.filter((a) => a.type === "PROJECT_ASSET").length > 0
    ? [
        "## Project Production Assets",
        "",
        ...attachedAssets
          .filter((a) => a.type === "PROJECT_ASSET")
          .map((a) => `- File: \`${a.relativeProjectPath}\` (Import: \`${a.importPath || a.relativeProjectPath}\`)`),
        "",
      ]
    : [];

  return [
    "---",
    `title: ${JSON.stringify(draft.title)}`,
    "type: task",
    `task_id: ${taskId}`,
    `project: ${projectId}`,
    "status: BACKLOG",
    `tags: [task, ${projectId}, orchestrator-intake]`,
    `created: ${today}`,
    `updated: ${today}`,
    `dependencies: ${yamlArray(draft.dependencies)}`,
    `verification: ${yamlArray(draft.verification)}`,
    `allowed_paths: ${yamlArray(draft.allowedPaths)}`,
    `requires_changes: ${draft.requiresChanges}`,
    `risk: ${draft.risk}`,
    `sources: ${yamlArray(sources)}`,
    "---",
    "",
    `# ${draft.title}`,
    "",
    "## Permintaan User",
    "",
    request,
    "",
    ...mockupsSection,
    ...assetsSection,
    "## Tujuan",
    "",
    draft.purpose,
    "",
    "## Scope",
    "",
    ...draft.allowedPaths.map((filePath) => `- \`${filePath}\``),
    "",
    ...(bugTask ? [
      "## Detail Bug",
      "",
      `- Gejala Bug: ${request}`,
      `- Perilaku Yang Diharapkan: ${draft.expectedResult}`,
      `- Target Files: ${draft.allowedPaths.map((filePath) => `\`${filePath}\``).join(", ")}`,
      "",
    ] : []),
    "## Hasil Yang Diharapkan",
    "",
    draft.expectedResult,
    "",
    "## Acceptance Criteria",
    "",
    ...draft.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`),
    `${draft.acceptanceCriteria.length + 1}. Hanya file dalam \`allowed_paths\` yang berubah akibat task ini.`,
    `${draft.acceptanceCriteria.length + 2}. Verification ${draft.verification.map((item) => `\`${item}\``).join(" dan ")} berhasil.`,
    "",
    "## Knowledge Decision",
    "",
    "Belum ditentukan oleh retrospective orchestrator.",
    "",
    "## Error Log",
    "",
    "Tidak ada error log saat pembuatan task.",
    "",
    "## Log Perubahan",
    "",
    "🚀 [VERIFIED_BY_LLM_WIKI_SCHEMA]",
    `- [${today}] Task dibuat melalui orchestrator task intake oleh \`${requestedBy}\`.`,
    "",
  ].join("\n");
}

function updateIndex(vaultRoot, projectId, relativePath, title) {
  const indexPath = path.join(vaultRoot, "index.md");
  if (!fs.existsSync(indexPath)) return;
  let content = fs.readFileSync(indexPath, "utf8");
  const target = relativePath.replace(/\.md$/, "");
  if (content.includes(`[[${target}|`)) return;
  const heading = "## Orchestrator-created Tasks";
  const entry = `- [[${target}|${title}]] (${projectId})`;
  const headingIndex = content.indexOf(heading);
  if (headingIndex === -1) {
    content = `${content.trimEnd()}\n\n## Orchestrator-created Tasks\n\n${entry}\n`;
  } else {
    const sectionStart = headingIndex + heading.length;
    const nextHeading = content.slice(sectionStart).search(/\n#{2,3}\s+/);
    const insertionPoint = nextHeading === -1 ? content.length : sectionStart + nextHeading;
    content = `${content.slice(0, insertionPoint).trimEnd()}\n${entry}\n\n${content.slice(insertionPoint).replace(/^\s+/, "")}`;
  }
  fs.writeFileSync(indexPath, content, "utf8");
}

function appendWikiLog(vaultRoot, taskId, projectId, taskPath, requestedBy, autoStart) {
  const filePath = path.join(vaultRoot, "wiki-log.md");
  const entry = [
    `## [${new Date().toISOString().slice(0, 10)}] task-intake | ${taskId}`,
    `- Created \`${taskPath}\` from orchestrator conversational intake for project \`${projectId}\`.`,
    `- Requested by \`${requestedBy}\`; execution ${autoStart ? "queued" : "not requested"}.`,
  ].join("\n");
  fs.appendFileSync(filePath, `\n\n${entry}\n`, "utf8");
}

export async function requestTask({
  vaultRoot,
  runsRoot,
  project,
  request,
  requestedBy = "user",
  autoStart = false,
  attachedAssets = [],
  readMarkdown,
  validateTask = null,
  planner = planTaskWithAgy,
}) {
  const text = String(request).trim();
  if (!text) throw new Error("Permintaan task tidak boleh kosong.");

  // 1. Fast-Path Optimization: Try deterministic intake planning first (0 AI tokens)
  const fastPathDraft = tryDeterministicTaskDraft({ project, request: text, attachedAssets });
  let planned;
  let draft;

  if (fastPathDraft) {
    draft = fastPathDraft;
  } else {
    // 2. Normal Path: Call AI Planner with Graphify & Knowledge Context
    planned = await planner({ vaultRoot, runsRoot, project, request: text, attachedAssets, readMarkdown });
    draft = normalizeDraft(planned.draft ?? planned, project);
  }

  if (draft.clarificationNeeded) {
    return {
      schemaVersion: 1,
      action: "NEEDS_CLARIFICATION",
      project: project.id,
      question: draft.clarificationQuestion || "Detail task belum cukup untuk menentukan scope yang aman.",
      draft,
    };
  }

  const tasks = existingTaskSummary(vaultRoot, project.id, readMarkdown);
  const identity = nextTaskIdentity(tasks);
  const relativePath = path.join("02-Projects", project.id, "tasks", identity.fileName);
  const absolutePath = path.join(vaultRoot, relativePath);
  if (fs.existsSync(absolutePath)) throw new Error(`Task path sudah ada: ${relativePath}`);
  const content = taskDocument({
    taskId: identity.taskId,
    projectId: project.id,
    request: text,
    draft,
    requestedBy,
    attachedAssets,
  });
  const temporaryPath = `${absolutePath}.intake-${randomUUID().slice(0, 8)}.tmp`;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  let readiness = null;
  try {
    if (typeof validateTask === "function") {
      readiness = validateTask(project.id, temporaryPath);
      if (!readiness.ready) {
        return {
          schemaVersion: 1,
          action: "NEEDS_CLARIFICATION",
          project: project.id,
          question: readiness.nextActions?.join(" ") || "Draft task belum lolos readiness gate.",
          draft,
          readiness,
        };
      }
    }
    fs.renameSync(temporaryPath, absolutePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }

  const projectPage = readMarkdown(path.join(vaultRoot, project.projectPagePath), vaultRoot);
  updateIndex(vaultRoot, projectPage?.title ?? project.id, relativePath, identity.taskId, draft.title);
  appendWikiLog(vaultRoot, identity.taskId, project.id, relativePath, requestedBy, autoStart);
  if (planned.intakeId && planned.telemetry) {
    persistIntakeTelemetry({
      runsRoot,
      intakeId: planned.intakeId,
      record: planned.telemetry,
      task: { id: identity.taskId, path: relativePath },
      project,
    });
  }
  const queued = autoStart
    ? enqueueTaskJob({
      runsRoot,
      projectId: project.id,
      taskId: identity.taskId,
      taskPath: relativePath,
      requestedBy,
      intakeTelemetry: planned.telemetry ?? null,
    })
    : null;

  return {
    schemaVersion: 1,
    action: autoStart ? "TASK_CREATED_AND_QUEUED" : "TASK_CREATED",
    task: { id: identity.taskId, title: draft.title, path: relativePath, status: "BACKLOG", risk: draft.risk },
    job: queued?.job ?? null,
    readiness: readiness ? { verdict: readiness.verdict, summary: readiness.summary } : null,
    planner: {
      agentConfig: planned.agentConfig ?? null,
      intakeId: planned.intakeId ?? null,
      telemetry: planned.telemetry
        ? {
            totalTokens: planned.telemetry.usage?.totalTokens ?? null,
            durationSeconds: planned.telemetry.durationSeconds,
          }
        : null,
    },
    nextAction: autoStart ? "Gunakan status tanpa run-id untuk memantau hasil." : "Task menunggu instruksi execution.",
  };
}
