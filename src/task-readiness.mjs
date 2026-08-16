import fs from "node:fs";
import path from "node:path";

const VALID_TASK_STATES = new Set([
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
  "FAILED",
  "BLOCKED",
]);
const TERMINAL_TASK_STATES = new Set(["DONE", "FAILED", "BLOCKED"]);
const OPERATIONAL_SECTIONS = /error log|log perubahan|orchestrator run log|knowledge retrospective/i;
const PLACEHOLDER_PATTERNS = [
  /\*?\(\s*(?:jelaskan|tuliskan|contoh|isi)[^)]+\)[.*_\s]*/i,
  /\[(?:nomor|judul(?:\s+[^\]]*)?|nama(?:\s+[^\]]*)?|project-id|nama-proyek-anda|path\/ke\/[^\]]+)\]/i,
  /<project-id>/i,
  /\b(?:todo|tbd)\b/i,
];

function check(id, status, message, details = []) {
  return { id, status, message, ...(details.length ? { details } : {}) };
}

function stripOperationalSections(body) {
  const kept = [];
  let skippedLevel = null;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const heading = line.match(/^(#{2,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      if (skippedLevel !== null && level <= skippedLevel) skippedLevel = null;
      if (OPERATIONAL_SECTIONS.test(heading[2])) skippedLevel = level;
    }
    if (skippedLevel === null) kept.push(line);
  }
  return kept.join("\n");
}

function hasPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(String(value ?? "")));
}

function substantive(value, minimumLength = 12) {
  const normalized = String(value ?? "")
    .replace(/[*_`#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length >= minimumLength && !hasPlaceholder(value);
}

function sectionBodies(body) {
  const sections = [];
  let current = null;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const heading = line.match(/^(#{2,6})\s+(.+)$/);
    if (heading) {
      current = { title: heading[2].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections.map((section) => ({ ...section, body: section.lines.join("\n").trim() }));
}

function findSection(sections, pattern) {
  return sections.find((section) => pattern.test(section.title));
}

function labeledValue(body, labelPattern) {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1 || !labelPattern.test(line.slice(0, separator))) continue;
    return line.slice(separator + 1).trim();
  }
  return "";
}

function normalizeDependencies(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return null;
}

function dependencyStatuses(context, dependencies, readMarkdown) {
  const taskDirectory = path.dirname(path.join(context.vault, context.task.path));
  const statuses = new Map();
  if (!fs.existsSync(taskDirectory)) return statuses;
  for (const entry of fs.readdirSync(taskDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const document = readMarkdown(path.join(taskDirectory, entry.name), context.vault);
    const id = String(document?.metadata?.task_id ?? "").trim();
    if (id) statuses.set(id.toUpperCase(), String(document.metadata.status ?? "UNKNOWN").toUpperCase());
  }
  return new Map(dependencies.map((dependency) => [dependency, statuses.get(dependency.toUpperCase()) ?? null]));
}

function extractTargetPaths(body) {
  const targets = new Set();
  const codeSpans = String(body ?? "").matchAll(/`([^`\n]+)`/g);
  for (const match of codeSpans) {
    const candidate = match[1].trim();
    if (/\s/.test(candidate)) continue;
    if (!/\.[A-Za-z0-9]{1,10}$/.test(candidate)) continue;
    if (/^(?:https?:|npm |npx |pnpm |yarn )/i.test(candidate)) continue;
    const rootFile = /^(?:README(?:\.[A-Za-z0-9]+)?|package(?:-lock)?\.json|vite\.config\.[A-Za-z0-9]+|tsconfig(?:\.[A-Za-z0-9_-]+)?\.json)$/i.test(candidate);
    if (!/[\\/]/.test(candidate) && !rootFile) continue;
    targets.add(candidate);
  }
  return [...targets];
}

function inspectTargets(repository, targets) {
  const resolvedRepository = path.resolve(repository);
  return targets.map((target) => {
    const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(repository, target);
    const relative = path.relative(resolvedRepository, absolute);
    const insideRepository = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    return {
      path: target,
      insideRepository,
      exists: insideRepository && fs.existsSync(absolute),
    };
  });
}

function verificationCheck(context, metadata) {
  const requested = metadata.verification;
  const body = context.task.instruction;
  const scripts = context.project.packageScripts ?? {};
  if (Array.isArray(requested) && requested.length > 0) {
    const unknown = requested.map(String).filter((name) => !scripts[name]);
    return unknown.length
      ? check("VERIFICATION", "FAIL", "Verification frontmatter merujuk script yang tidak tersedia.", unknown)
      : check("VERIFICATION", "PASS", "Verification eksplisit tersedia di frontmatter.", requested.map(String));
  }
  if (requested !== undefined && !Array.isArray(requested)) {
    return check("VERIFICATION", "FAIL", "Field verification harus berupa array, misalnya [typecheck, build].");
  }
  const commands = String(body ?? "").match(/(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:typecheck|test|lint|build)|npx\s+tsc\s+--noEmit/gi) ?? [];
  return commands.length
    ? check("VERIFICATION", "PASS", "Command verification ditemukan pada task.", [...new Set(commands)])
    : check("VERIFICATION", "FAIL", "Task belum menentukan verification yang harus lulus.");
}

export function validateTaskReadiness(context, { readMarkdown } = {}) {
  if (!context?.task || !context?.project || !context?.vault) {
    throw new Error("Task readiness membutuhkan context project dan task yang lengkap.");
  }
  if (typeof readMarkdown !== "function") {
    throw new Error("Task readiness membutuhkan service readMarkdown untuk memeriksa dependency.");
  }

  const checks = [];
  const metadata = context.task.metadata ?? {};
  const status = String(metadata.status ?? "UNKNOWN").toUpperCase();
  const semanticBody = stripOperationalSections(context.task.instruction);
  const sections = sectionBodies(semanticBody);
  const isBugTask = /\bbug\b|bug fix|fixing bug/i.test(`${context.task.title}\n${semanticBody}`);

  const requiredMetadata = ["title", "type", "task_id", "project", "status", "dependencies"];
  const missingMetadata = requiredMetadata.filter((field) => metadata[field] === undefined || metadata[field] === "");
  checks.push(missingMetadata.length
    ? check("METADATA", "FAIL", "Frontmatter task belum lengkap.", missingMetadata)
    : check("METADATA", "PASS", "Frontmatter wajib tersedia."));

  if (!VALID_TASK_STATES.has(status)) {
    checks.push(check("STATUS", "FAIL", `Status task tidak valid: ${status}.`));
  } else if (TERMINAL_TASK_STATES.has(status)) {
    checks.push(check("STATUS", "WARN", `Task berstatus terminal ${status}; readiness gate tidak mempromosikannya.`));
  } else {
    checks.push(check("STATUS", "PASS", `Status ${status} dapat diperiksa oleh readiness gate.`));
  }

  const projectMatches = String(metadata.project ?? "") === String(context.project.id ?? "");
  checks.push(projectMatches
    ? check("PROJECT", "PASS", "Project task sesuai dengan project registry.")
    : check("PROJECT", "FAIL", "Field project task tidak sesuai dengan project registry."));
  checks.push(context.project.repositoryExists
    ? check("REPOSITORY", "PASS", "Repository project dapat ditemukan.")
    : check("REPOSITORY", "FAIL", "Repository project tidak dapat ditemukan."));

  const placeholderLines = semanticBody
    .split(/\r?\n/)
    .filter((line) => hasPlaceholder(line))
    .map((line) => line.trim())
    .slice(0, 8);
  const metadataPlaceholder = hasPlaceholder(`${metadata.title ?? ""}\n${metadata.task_id ?? ""}\n${metadata.project ?? ""}`);
  checks.push(placeholderLines.length || metadataPlaceholder
    ? check("PLACEHOLDERS", "FAIL", "Task masih mengandung placeholder template.", [
      ...(metadataPlaceholder ? ["Frontmatter masih mengandung placeholder."] : []),
      ...placeholderLines,
    ])
    : check("PLACEHOLDERS", "PASS", "Tidak ada placeholder template pada instruksi aktif."));

  const instruction = findSection(sections, /apa yang ingin dikerjakan|instruksi|tujuan utama|^tujuan$/i);
  checks.push(instruction && substantive(instruction.body)
    ? check("INSTRUCTION", "PASS", "Tujuan atau instruksi task cukup jelas.")
    : check("INSTRUCTION", "FAIL", "Task membutuhkan tujuan atau instruksi yang substantif."));

  const expectedSection = findSection(sections, /hasil yang diharapkan|expected result|acceptance criteria/i);
  const bugDetail = findSection(sections, /detail bug|bug context|reproduksi/i);
  const expectedValue = labeledValue(bugDetail?.body, /perilaku yang diharapkan|expected behavior/i);
  const expectedIsSubstantive = substantive(expectedSection?.body) || substantive(expectedValue);
  checks.push(expectedIsSubstantive
    ? check("EXPECTED_BEHAVIOR", "PASS", "Expected behavior atau hasil akhir sudah jelas.")
    : check("EXPECTED_BEHAVIOR", "FAIL", "Expected behavior atau hasil akhir belum dijelaskan secara konkret."));

  if (isBugTask) {
    const symptom = labeledValue(bugDetail?.body, /gejala bug|actual behavior|perilaku salah/i);
    checks.push(substantive(symptom)
      ? check("BUG_SYMPTOM", "PASS", "Gejala bug sudah dijelaskan.")
      : check("BUG_SYMPTOM", "FAIL", "Bug task membutuhkan gejala atau actual behavior yang dapat diamati."));
  }

  const acceptanceSection = findSection(sections, /acceptance criteria|definition of done|hasil yang diharapkan|testing.*verifikasi/i);
  checks.push(acceptanceSection && substantive(acceptanceSection.body)
    ? check("ACCEPTANCE_CRITERIA", "PASS", "Acceptance criteria atau Definition of Done tersedia.")
    : check("ACCEPTANCE_CRITERIA", "FAIL", "Task belum memiliki acceptance criteria atau Definition of Done yang konkret."));

  checks.push(verificationCheck(context, metadata));

  const dependencies = normalizeDependencies(metadata.dependencies);
  if (dependencies === null) {
    checks.push(check("DEPENDENCIES", "FAIL", "Field dependencies harus berupa array."));
  } else if (dependencies.length === 0) {
    checks.push(check("DEPENDENCIES", "PASS", "Task tidak memiliki dependency."));
  } else {
    const statuses = dependencyStatuses(context, dependencies, readMarkdown);
    const unresolved = [...statuses].filter(([, dependencyStatus]) => dependencyStatus !== "DONE");
    checks.push(unresolved.length
      ? check("DEPENDENCIES", "FAIL", "Dependency task belum selesai atau tidak ditemukan.", unresolved.map(([id, value]) => `${id}: ${value ?? "NOT_FOUND"}`))
      : check("DEPENDENCIES", "PASS", "Seluruh dependency task berstatus DONE.", dependencies));
  }

  const targets = extractTargetPaths(semanticBody);
  const inspectedTargets = inspectTargets(context.project.repository, targets);
  const unsafeTargets = inspectedTargets.filter((target) => !target.insideRepository);
  const missingTargets = inspectedTargets.filter((target) => target.insideRepository && !target.exists);
  if (unsafeTargets.length) {
    checks.push(check("TARGET_FILES", "FAIL", "Target file berada di luar repository.", unsafeTargets.map((target) => target.path)));
  } else if (isBugTask && targets.length === 0) {
    checks.push(check("TARGET_FILES", "FAIL", "Bug task membutuhkan minimal satu target file yang eksplisit."));
  } else if (isBugTask && missingTargets.length) {
    checks.push(check("TARGET_FILES", "FAIL", "Target file bug tidak ditemukan di repository.", missingTargets.map((target) => target.path)));
  } else if (targets.length === 0) {
    checks.push(check("TARGET_FILES", "WARN", "Task tidak menyebut target file; agent harus menentukannya saat planning."));
  } else {
    checks.push(check("TARGET_FILES", "PASS", "Target file berada di dalam repository.", inspectedTargets.map((target) => `${target.path}: ${target.exists ? "EXISTS" : "NEW"}`)));
  }

  const blockers = checks.filter((item) => item.status === "FAIL");
  const warnings = checks.filter((item) => item.status === "WARN");
  const activeStatus = status === "BACKLOG" || status === "READY";
  const ready = blockers.length === 0 && activeStatus;
  const verdict = TERMINAL_TASK_STATES.has(status) ? "NOT_APPLICABLE" : ready ? "PASS" : "BLOCKED";

  return {
    schemaVersion: 1,
    gate: "TASK_READINESS",
    gateVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    verdict,
    ready,
    task: {
      id: metadata.task_id ?? null,
      title: context.task.title,
      path: context.task.path,
      project: metadata.project ?? null,
      status,
    },
    project: {
      id: context.project.id,
      repository: context.project.repository,
    },
    summary: {
      passed: checks.filter((item) => item.status === "PASS").length,
      blockers: blockers.length,
      warnings: warnings.length,
    },
    checks,
    blockers,
    warnings,
    nextActions: ready
      ? [status === "BACKLOG" ? "Minta human approval untuk mengubah status BACKLOG menjadi READY." : "Task dapat masuk prepare dan approval pipeline."]
      : blockers.map((item) => item.message),
    guardrail: "Readiness gate hanya membaca task dan repository; command ini tidak mengubah status atau file.",
  };
}
