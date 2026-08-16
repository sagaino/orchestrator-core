import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agyConfigArgs, resolveAgyConfig } from "./agent-config.mjs";
import { runProcess } from "./executor.mjs";
import { enqueueTaskJob } from "./job-queue.mjs";
import { createAgentTelemetryRecord, persistIntakeTelemetry } from "./telemetry.mjs";

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

function parsePlannerResult(result) {
  const candidates = [result.finalResult];
  for (const line of String(result.stdoutTail ?? "").split("\n").reverse()) {
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

async function graphifyContext(project, request, eventLogPath, processRunner) {
  if (!project.graphify) return "Graphify disabled for this project.";
  const result = await processRunner({
    command: "graphify",
    args: ["query", request, "--budget", "1200"],
    cwd: project.repository,
    stage: "task-intake-graphify",
    eventLogPath,
  });
  if (result.exitCode !== 0) return `Graphify query unavailable: ${result.stderrTail.trim()}`;
  return result.stdoutTail.trim();
}

export async function planTaskWithAgy({
  vaultRoot,
  runsRoot,
  project,
  request,
  readMarkdown,
  processRunner = runProcess,
}) {
  const intakeId = `intake-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const eventLogPath = path.join(runsRoot, "intake", `${intakeId}.jsonl`);
  const scripts = packageScripts(project.repository);
  const tasks = existingTaskSummary(vaultRoot, project.id, readMarkdown);
  const graphContext = await graphifyContext(project, request, eventLogPath, processRunner);
  const agentConfig = resolveAgyConfig();
  const prompt = [
    "Susun draft task software engineering dari permintaan user. Jangan mengubah file apa pun.",
    `Permintaan: ${request}`,
    `Project: ${project.id}`,
    `Repository: ${project.repository}`,
    `Package scripts: ${JSON.stringify(scripts)}`,
    `Project verification defaults: ${JSON.stringify(project.verificationDefaults ?? [])}`,
    `Existing tasks: ${JSON.stringify(tasks)}`,
    `Graphify context: ${graphContext || "Tidak ada node relevan."}`,
    "Gunakan path relatif repository dan pilih allowedPaths paling sempit yang praktis.",
    "Verification hanya boleh menggunakan nama script package.json yang tersedia.",
    "Dependencies hanya diisi bila task benar-benar bergantung pada task existing.",
    "Set clarificationNeeded=true hanya jika implementasi aman tidak mungkin direncanakan tanpa jawaban user.",
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
  if (result.exitCode !== 0) throw new Error(`Task planner gagal dengan exit code ${result.exitCode}.`);
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

function taskDocument({ taskId, projectId, request, draft, requestedBy }) {
  const today = new Date().toISOString().slice(0, 10);
  const bugTask = /\bbug\b|bug fix|fixing bug/i.test(`${draft.title}\n${request}`);
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
    "sources: []",
    "---",
    "",
    `# ${draft.title}`,
    "",
    "## Permintaan User",
    "",
    request,
    "",
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
    "## Log Perubahan",
    "",
    "---",
    "",
    "## Orchestrator Intake Log",
    `- [${new Date().toISOString()}] Task dibuat dari conversational intake oleh \`${requestedBy}\`; risk \`${draft.risk}\`.`,
    "",
  ].join("\n");
}

function updateIndex(vaultRoot, projectTitle, taskPath, taskId, title) {
  const indexPath = path.join(vaultRoot, "index.md");
  let content = fs.readFileSync(indexPath, "utf8");
  const link = taskPath.replace(/\.md$/, "");
  if (content.includes(`[[${link}|`)) return;
  const entry = `- [[${link}|${taskId}]]: ${title}`;
  const heading = `### ${projectTitle} Tasks`;
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
  readMarkdown,
  validateTask = null,
  planner = planTaskWithAgy,
}) {
  const text = String(request).trim();
  if (!text) throw new Error("Permintaan task tidak boleh kosong.");
  const planned = await planner({ vaultRoot, runsRoot, project, request: text, readMarkdown });
  const draft = normalizeDraft(planned.draft ?? planned, project);
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
  });
  const temporaryPath = `${absolutePath}.intake-${randomUUID().slice(0, 8)}.tmp`;
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
