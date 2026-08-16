import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const REQUIRED_FIELDS = ["title", "type", "tags", "created", "updated", "sources"];
const VALID_TYPES = new Set([
  "concept",
  "pattern",
  "snippet",
  "decision",
  "debugging",
  "candidate",
  "project",
  "task",
  "task-template",
  "registry",
  "schema",
  "project-snapshot",
]);
const STOP_WORDS = new Set([
  "yang", "untuk", "dengan", "dari", "pada", "dalam", "atau", "adalah", "dan", "ini", "itu",
  "the", "and", "for", "with", "from", "this", "that", "into", "using", "use", "knowledge",
]);
const NEAR_DUPLICATE_THRESHOLD = 0.82;

function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function walkFiles(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", ".obsidian", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && predicate(absolute)) files.push(absolute);
    }
  };
  walk(root);
  return files.sort();
}

function parseScalar(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item));
  }
  return trimmed;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { metadata: {}, hasFrontmatter: false, body: content };
  const metadata = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([^\s:#][^:]*):(?:\s*(.*))?$/);
    if (!field) continue;
    const key = field[1].trim();
    const inline = field[2] ?? "";
    if (inline.trim()) {
      metadata[key] = parseScalar(inline);
      continue;
    }
    const items = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const item = lines[cursor].match(/^\s+-\s+(.*)$/);
      if (!item) break;
      items.push(parseScalar(item[1]));
      cursor += 1;
    }
    metadata[key] = items.length > 0 ? items : "";
    if (items.length > 0) index = cursor - 1;
  }
  return { metadata, hasFrontmatter: true, body: content.slice(match[0].length) };
}

function loadDocument(vaultRoot, absolute) {
  const content = fs.readFileSync(absolute, "utf8");
  const parsed = parseFrontmatter(content);
  const heading = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    absolute,
    path: toPosix(path.relative(vaultRoot, absolute)),
    content,
    body: parsed.body,
    metadata: parsed.metadata,
    hasFrontmatter: parsed.hasFrontmatter,
    title: String(parsed.metadata.title ?? heading ?? path.basename(absolute, ".md")),
    template: path.basename(absolute).startsWith("_Template"),
  };
}

function normalizeTitle(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value) {
  return [...new Set(
    normalizeTitle(value)
      .split(" ")
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  )];
}

function jaccard(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function trigrams(value) {
  const normalized = `  ${normalizeTitle(value)}  `;
  const result = [];
  for (let index = 0; index <= normalized.length - 3; index += 1) result.push(normalized.slice(index, index + 3));
  return result;
}

function dice(left, right) {
  const leftParts = trigrams(left);
  const remaining = [...trigrams(right)];
  if (leftParts.length === 0 || remaining.length === 0) return 0;
  let overlap = 0;
  for (const part of leftParts) {
    const index = remaining.indexOf(part);
    if (index === -1) continue;
    overlap += 1;
    remaining.splice(index, 1);
  }
  return (2 * overlap) / (leftParts.length + trigrams(right).length);
}

function similarity(left, right) {
  const titleScore = Math.max(dice(left.title, right.title), jaccard(tokens(left.title), tokens(right.title)));
  const leftBody = tokens(left.body).slice(0, 500);
  const rightBody = tokens(right.body).slice(0, 500);
  const contentScore = leftBody.length >= 30 && rightBody.length >= 30 ? jaccard(leftBody, rightBody) : 0;
  return {
    score: Math.max(titleScore, contentScore),
    titleScore,
    contentScore,
  };
}

function stripCode(content) {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function wikiLinks(content) {
  const links = [];
  for (const match of stripCode(content).matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    const raw = match[1].split("|")[0].trim();
    const target = raw.split("#")[0].split("^")[0].trim();
    if (target) links.push({ raw, target });
  }
  return links;
}

function buildFileResolver(vaultRoot) {
  const files = walkFiles(vaultRoot);
  const relativeFiles = new Map(files.map((absolute) => [toPosix(path.relative(vaultRoot, absolute)).toLowerCase(), absolute]));
  const archivedProjectAliases = walkFiles(path.join(vaultRoot, "03-Sources", "other", "removed-projects"), (absolute) => (
    path.basename(absolute) === "removal-manifest.json"
  )).flatMap((absolute) => {
    try {
      const manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
      const from = String(manifest.archive?.sourcePath ?? "").replace(/\.md$/, "").replace(/\/$/, "");
      const to = String(manifest.archive?.path ?? "").replace(/\/$/, "");
      return from && to ? [{ from, to }] : [];
    } catch {
      return [];
    }
  });
  const byStem = new Map();
  for (const absolute of files) {
    const stem = path.basename(absolute, path.extname(absolute)).toLowerCase();
    const matches = byStem.get(stem) ?? [];
    matches.push(absolute);
    byStem.set(stem, matches);
  }
  const resolve = (target) => {
    const clean = String(target).replace(/^\//, "").replaceAll("\\", "/");
    if (/^[a-z]+:\/\//i.test(clean)) return { exists: true, external: true, path: clean };
    const candidates = path.extname(clean) ? [clean] : [clean, `${clean}.md`];
    for (const candidate of candidates) {
      const match = relativeFiles.get(candidate.toLowerCase());
      if (match) return { exists: true, ambiguous: false, path: toPosix(path.relative(vaultRoot, match)) };
    }
    for (const alias of archivedProjectAliases) {
      if (clean !== alias.from && !clean.startsWith(`${alias.from}/`)) continue;
      const archived = `${alias.to}${clean.slice(alias.from.length)}`;
      for (const candidate of path.extname(archived) ? [archived] : [archived, `${archived}.md`]) {
        const match = relativeFiles.get(candidate.toLowerCase());
        if (match) return {
          exists: true,
          ambiguous: false,
          path: toPosix(path.relative(vaultRoot, match)),
          archivedAlias: true,
        };
      }
    }
    if (!clean.includes("/")) {
      const stemMatches = byStem.get(path.basename(clean, path.extname(clean)).toLowerCase()) ?? [];
      if (stemMatches.length === 1) {
        return { exists: true, ambiguous: false, path: toPosix(path.relative(vaultRoot, stemMatches[0])) };
      }
      if (stemMatches.length > 1) {
        return { exists: true, ambiguous: true, matches: stemMatches.map((item) => toPosix(path.relative(vaultRoot, item))) };
      }
    }
    return { exists: false, ambiguous: false, path: clean };
  };
  return { files, resolve };
}

function finding(severity, check, filePath, message, details = null, safeFix = null) {
  return {
    id: `${check}:${filePath}:${message}`,
    severity,
    check,
    path: filePath,
    message,
    ...(details ? { details } : {}),
    ...(safeFix ? { safeFix } : {}),
  };
}

function managedMarkdown(vaultRoot) {
  return ["01-Knowledge", "02-Projects", "05-Knowledge-Candidates"]
    .flatMap((directory) => walkFiles(path.join(vaultRoot, directory), (filePath) => filePath.endsWith(".md")));
}

function metadataFindings(documents) {
  const findings = [];
  for (const document of documents) {
    if (!document.hasFrontmatter) {
      findings.push(finding("ERROR", "FRONTMATTER", document.path, "Frontmatter tidak ditemukan."));
      continue;
    }
    const missing = REQUIRED_FIELDS.filter((field) => document.metadata[field] === undefined || document.metadata[field] === "");
    if (missing.length > 0) {
      findings.push(finding("ERROR", "FRONTMATTER", document.path, "Frontmatter wajib belum lengkap.", { missing }));
    }
    const type = String(document.metadata.type ?? "").toLowerCase();
    if (type && !VALID_TYPES.has(type)) {
      findings.push(finding("ERROR", "FRONTMATTER", document.path, `Type tidak valid: ${type}.`));
    }
    for (const field of ["created", "updated"]) {
      const value = String(document.metadata[field] ?? "");
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        findings.push(finding("WARNING", "FRONTMATTER", document.path, `${field} harus berformat YYYY-MM-DD.`, { value }));
      }
    }
    for (const field of ["tags", "sources"]) {
      if (document.metadata[field] !== undefined && !Array.isArray(document.metadata[field])) {
        findings.push(finding("ERROR", "FRONTMATTER", document.path, `${field} harus berupa array.`));
      }
    }
  }
  return findings;
}

function linkFindings(documents, resolver) {
  const findings = [];
  for (const document of documents) {
    for (const link of wikiLinks(document.content)) {
      const resolved = resolver.resolve(link.target);
      if (!resolved.exists) {
        findings.push(finding("ERROR", "BROKEN_WIKILINK", document.path, `Wikilink tidak dapat ditemukan: [[${link.raw}]].`));
      } else if (resolved.ambiguous) {
        findings.push(finding("WARNING", "AMBIGUOUS_WIKILINK", document.path, `Wikilink ambigu: [[${link.raw}]].`, { matches: resolved.matches }));
      }
    }
  }
  return findings;
}

function indexedPaths(indexContent, resolver) {
  const indexed = new Set();
  for (const link of wikiLinks(indexContent)) {
    const resolved = resolver.resolve(link.target);
    if (resolved.exists && !resolved.ambiguous && resolved.path) indexed.add(resolved.path.toLowerCase());
  }
  return indexed;
}

function indexFindings(vaultRoot, documents, resolver) {
  const indexPath = path.join(vaultRoot, "index.md");
  if (!fs.existsSync(indexPath)) return [finding("ERROR", "INDEX", "index.md", "Index utama tidak ditemukan.")];
  const indexed = indexedPaths(fs.readFileSync(indexPath, "utf8"), resolver);
  return documents
    .filter((document) => !document.template && (document.path.startsWith("01-Knowledge/") || document.path.startsWith("05-Knowledge-Candidates/")))
    .filter((document) => !indexed.has(document.path.toLowerCase()))
    .map((document) => finding(
      "WARNING",
      "UNINDEXED_PAGE",
      document.path,
      "Halaman belum tercantum di index.md.",
      { title: document.title },
      "ADD_TO_INDEX",
    ));
}

function candidateFindings(documents, resolver) {
  const findings = [];
  for (const document of documents.filter((item) => item.path.startsWith("05-Knowledge-Candidates/") && !item.template)) {
    const sources = Array.isArray(document.metadata.sources) ? document.metadata.sources : [];
    const sourceLinks = sources.flatMap((source) => wikiLinks(String(source)));
    const sourceAvailable = sourceLinks.some((link) => resolver.resolve(link.target).exists);
    if (!document.metadata.orchestrator_run) {
      findings.push(finding("ERROR", "ORPHAN_CANDIDATE", document.path, "Candidate tidak memiliki orchestrator_run."));
    }
    if (!sourceAvailable) {
      findings.push(finding("ERROR", "ORPHAN_CANDIDATE", document.path, "Candidate tidak memiliki immutable source yang dapat ditemukan."));
    }
  }
  return findings;
}

function oppositePolarity(left, right) {
  const negative = /\b(must not|never|forbidden|tidak boleh|jangan|dilarang)\b/i;
  const positive = /\b(must|always|required|harus|wajib|selalu|boleh)\b/i;
  return (negative.test(left) && positive.test(right) && !negative.test(right))
    || (negative.test(right) && positive.test(left) && !negative.test(left));
}

function duplicateFindings(documents) {
  const findings = [];
  const knowledge = documents.filter((document) => !document.template
    && (document.path.startsWith("01-Knowledge/") || document.path.startsWith("05-Knowledge-Candidates/")));
  for (let leftIndex = 0; leftIndex < knowledge.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < knowledge.length; rightIndex += 1) {
      const left = knowledge[leftIndex];
      const right = knowledge[rightIndex];
      if (normalizeTitle(left.title) === normalizeTitle(right.title)) {
        findings.push(finding("ERROR", "DUPLICATE_KNOWLEDGE", right.path, `Judul knowledge sama dengan ${left.path}.`, { duplicateOf: left.path, score: 1 }));
        continue;
      }
      const score = similarity(left, right);
      if (score.score < NEAR_DUPLICATE_THRESHOLD) continue;
      findings.push(finding("WARNING", "NEAR_DUPLICATE", right.path, `Knowledge sangat mirip dengan ${left.path}.`, {
        similarTo: left.path,
        score: Number(score.score.toFixed(3)),
        titleScore: Number(score.titleScore.toFixed(3)),
        contentScore: Number(score.contentScore.toFixed(3)),
      }));
      if (oppositePolarity(left.body, right.body)) {
        findings.push(finding("WARNING", "CONTRADICTION_CANDIDATE", right.path, `Klaim berpotensi bertentangan dengan ${left.path}; perlu review manusia.`));
      }
    }
  }
  return findings;
}

function cleanTableCell(value) {
  return String(value).trim().replace(/^`|`$/g, "").replace(/^<|>$/g, "");
}

function projectRegistryRows(content) {
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanTableCell);
    if (cells.length < 6 || cells[0] === "project_id" || /^-+$/.test(cells[0])) continue;
    const projectLink = cells[1].match(/\[\[([^\]|#]+)/)?.[1] ?? cells[1];
    rows.push({ id: cells[0], projectPage: projectLink, repository: cells[2], graphify: cells[4] === "true", graphifyOutput: cells[5] });
  }
  return rows;
}

function projectFindings(vaultRoot) {
  const registryPath = path.join(vaultRoot, "project-registry.md");
  if (!fs.existsSync(registryPath)) return [finding("ERROR", "PROJECT_METADATA", "project-registry.md", "Project registry tidak ditemukan.")];
  const rows = projectRegistryRows(fs.readFileSync(registryPath, "utf8"));
  const findings = [];
  const seen = new Set();
  for (const project of rows) {
    if (seen.has(project.id)) findings.push(finding("ERROR", "PROJECT_METADATA", "project-registry.md", `project_id duplikat: ${project.id}.`));
    seen.add(project.id);
    const projectPage = path.join(vaultRoot, project.projectPage.endsWith(".md") ? project.projectPage : `${project.projectPage}.md`);
    if (!fs.existsSync(projectPage)) {
      findings.push(finding("ERROR", "PROJECT_METADATA", "project-registry.md", `Project page tidak ditemukan untuk ${project.id}.`, { projectPage: project.projectPage }));
      continue;
    }
    const document = loadDocument(vaultRoot, projectPage);
    const mismatches = [];
    if (document.metadata.project_id !== project.id) mismatches.push("project_id");
    if (document.metadata.repository !== project.repository) mismatches.push("repository");
    if (Boolean(document.metadata.graphify) !== project.graphify) mismatches.push("graphify");
    if (project.graphify && document.metadata.graphify_output !== project.graphifyOutput) mismatches.push("graphify_output");
    if (mismatches.length > 0) {
      findings.push(finding("ERROR", "PROJECT_METADATA", document.path, "Metadata project tidak sinkron dengan registry.", { mismatches }));
    }
    if (!fs.existsSync(project.repository)) {
      findings.push(finding("ERROR", "STALE_PROJECT", document.path, "Repository project tidak dapat ditemukan.", { repository: project.repository }));
    }
    if (project.graphify && !fs.existsSync(project.graphifyOutput)) {
      findings.push(finding("WARNING", "STALE_PROJECT", document.path, "Graphify output tidak dapat ditemukan.", { graphifyOutput: project.graphifyOutput }));
    }
  }
  return findings;
}

function addAutoIndexEntries(vaultRoot, findings) {
  const additions = findings.filter((item) => item.safeFix === "ADD_TO_INDEX");
  if (additions.length === 0) return [];
  const indexPath = path.join(vaultRoot, "index.md");
  let content = fs.readFileSync(indexPath, "utf8").trimEnd();
  const lines = additions.map((item) => {
    const target = item.path.replace(/\.md$/, "");
    return `- [[${target}|${item.details.title}]]`;
  });
  const heading = "## Knowledge Health Auto-index";
  if (!content.includes(heading)) {
    content = `${content}\n\n${heading}\n\n${lines.join("\n")}\n`;
  } else {
    const start = content.indexOf(heading) + heading.length;
    const nextHeading = content.indexOf("\n## ", start);
    const insertion = nextHeading === -1 ? content.length : nextHeading;
    content = `${content.slice(0, insertion).trimEnd()}\n${lines.join("\n")}\n${content.slice(insertion).replace(/^\n*/, "\n")}`;
  }
  writeAtomic(indexPath, content);
  return additions.map((item) => ({ action: "ADD_TO_INDEX", path: item.path }));
}

function appendLintLog(vaultRoot, report, fixedBy) {
  const logPath = path.join(vaultRoot, "wiki-log.md");
  if (!fs.existsSync(logPath)) return null;
  const date = report.generatedAt.slice(0, 10);
  const entry = [
    `## [${date}] lint | Knowledge Quality`,
    `- Checked by: \`${fixedBy}\`.`,
    `- Result before safe fix: ${report.verdict}; errors: \`${report.summary.errors}\`, warnings: \`${report.summary.warnings}\`.`,
    `- Safe fixes applied: \`${report.fixes.length}\`.`,
    "- Content merge, deletion, and contradiction resolution were not automated.",
  ].join("\n");
  const content = fs.readFileSync(logPath, "utf8");
  writeAtomic(logPath, `${content.trimEnd()}\n\n${entry}\n`);
  return "wiki-log.md";
}

function summarize(findings, documents, fixes = []) {
  return {
    pagesScanned: documents.length,
    errors: findings.filter((item) => item.severity === "ERROR").length,
    warnings: findings.filter((item) => item.severity === "WARNING").length,
    info: findings.filter((item) => item.severity === "INFO").length,
    safeFixesAvailable: findings.filter((item) => item.safeFix).length,
    safeFixesApplied: fixes.length,
  };
}

export function knowledgeHealth({ vaultRoot, fixSafe = false, fixedBy = "user" }) {
  const generatedAt = new Date().toISOString();
  const resolver = buildFileResolver(vaultRoot);
  const managed = managedMarkdown(vaultRoot).map((absolute) => loadDocument(vaultRoot, absolute));
  const linkedDocuments = walkFiles(vaultRoot, (filePath) => filePath.endsWith(".md"))
    .map((absolute) => loadDocument(vaultRoot, absolute));
  const findings = [
    ...metadataFindings(managed),
    ...linkFindings(linkedDocuments, resolver),
    ...indexFindings(vaultRoot, managed, resolver),
    ...candidateFindings(managed, resolver),
    ...duplicateFindings(managed),
    ...projectFindings(vaultRoot),
  ];
  const provisionalSummary = summarize(findings, linkedDocuments);
  const report = {
    schemaVersion: 1,
    action: "KNOWLEDGE_HEALTH",
    generatedAt,
    mode: fixSafe ? "safe-fix" : "read-only",
    verdict: provisionalSummary.errors > 0 ? "FAIL" : provisionalSummary.warnings > 0 ? "WARN" : "PASS",
    summary: provisionalSummary,
    findings,
    fixes: [],
    auditLog: null,
    nextActions: [],
    guardrail: "Safe fix hanya menambah halaman yang hilang ke index. Isi knowledge, source, merge, dan deletion tidak diubah otomatis.",
  };
  if (fixSafe) {
    report.fixes = addAutoIndexEntries(vaultRoot, findings);
    report.summary = summarize(findings, linkedDocuments, report.fixes);
    report.auditLog = appendLintLog(vaultRoot, report, fixedBy);
  }
  if (report.summary.errors > 0) report.nextActions.push("Perbaiki ERROR metadata, wikilink, provenance, atau project registry secara terarah.");
  if (findings.some((item) => ["DUPLICATE_KNOWLEDGE", "NEAR_DUPLICATE", "CONTRADICTION_CANDIDATE"].includes(item.check))) {
    report.nextActions.push("Review duplicate/contradiction candidate; jangan menggabungkan atau menghapus otomatis.");
  }
  if (!fixSafe && report.summary.safeFixesAvailable > 0) report.nextActions.push("Jalankan knowledge-health --fix-safe untuk memperbarui index secara aman.");
  return report;
}

export function findSimilarKnowledge({ vaultRoot, title, body = "", excludePath = null }) {
  const input = { title: String(title), body: String(body) };
  return walkFiles(path.join(vaultRoot, "01-Knowledge"), (filePath) => filePath.endsWith(".md"))
    .map((absolute) => loadDocument(vaultRoot, absolute))
    .filter((document) => !document.template && document.path !== excludePath)
    .map((document) => {
      const scores = similarity(input, document);
      return {
        path: document.path,
        title: document.title,
        score: Number(scores.score.toFixed(3)),
        titleScore: Number(scores.titleScore.toFixed(3)),
        contentScore: Number(scores.contentScore.toFixed(3)),
        exactTitle: normalizeTitle(document.title) === normalizeTitle(title),
      };
    })
    .filter((match) => match.exactTitle || match.score >= NEAR_DUPLICATE_THRESHOLD)
    .sort((left, right) => Number(right.exactTitle) - Number(left.exactTitle) || right.score - left.score);
}

function findCandidate(vaultRoot, selector) {
  const root = path.join(vaultRoot, "05-Knowledge-Candidates");
  const input = String(selector).replaceAll("\\", "/").replace(/\.md$/, "");
  const candidates = walkFiles(root, (filePath) => filePath.endsWith(".md"))
    .map((absolute) => loadDocument(vaultRoot, absolute))
    .filter((document) => !document.template);
  const match = candidates.find((document) => document.path.replace(/\.md$/, "") === input
    || path.basename(document.path, ".md") === path.basename(input)
    || normalizeTitle(document.title) === normalizeTitle(input));
  if (!match) throw new Error(`Knowledge candidate tidak ditemukan: ${selector}`);
  return match;
}

export function reviewKnowledgeCandidate({ vaultRoot, selector }) {
  const resolver = buildFileResolver(vaultRoot);
  const candidate = findCandidate(vaultRoot, selector);
  const sources = Array.isArray(candidate.metadata.sources) ? candidate.metadata.sources : [];
  const sourceLinks = sources.flatMap((source) => wikiLinks(String(source)));
  const resolvedSources = sourceLinks.map((link) => ({ target: link.target, ...resolver.resolve(link.target) }));
  let proposal = null;
  for (const source of resolvedSources) {
    if (!source.exists || source.ambiguous || !source.path?.endsWith(".json")) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(vaultRoot, source.path), "utf8"));
      if (payload.proposal) proposal = payload.proposal;
    } catch {
      // Invalid JSON is reported as unavailable proposal below.
    }
  }
  const body = [candidate.body, proposal?.summary, proposal?.rationale].filter(Boolean).join("\n");
  const similarKnowledge = findSimilarKnowledge({ vaultRoot, title: proposal?.title ?? candidate.title, body });
  const blockers = [];
  const warnings = [];
  if (!candidate.metadata.orchestrator_run) blockers.push("orchestrator_run tidak tersedia");
  if (!resolvedSources.some((source) => source.exists && !source.ambiguous)) blockers.push("immutable source tidak tersedia");
  if (!proposal) blockers.push("proposal retrospective tidak dapat diverifikasi dari source");
  if (similarKnowledge.length > 0) warnings.push("Ada knowledge existing yang mirip; promosi CREATE memerlukan target existing.");
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_REVIEW",
    mode: "read-only",
    candidate: { id: path.basename(candidate.path, ".md"), title: candidate.title, path: candidate.path },
    verdict: blockers.length > 0 ? "BLOCKED" : similarKnowledge.length > 0 ? "NEEDS_TARGET" : "READY",
    blockers,
    warnings,
    provenance: { orchestratorRun: candidate.metadata.orchestrator_run ?? null, sources: resolvedSources },
    similarKnowledge,
    recommendedAction: blockers.length > 0
      ? "Perbaiki provenance Candidate sebelum promosi."
      : similarKnowledge.length > 0
        ? `Review lalu gunakan --target ${similarKnowledge[0].path} untuk UPDATE jika memang topiknya sama.`
        : "Candidate dapat dipromosikan sebagai knowledge baru setelah approval user.",
  };
}

export const KNOWLEDGE_NEAR_DUPLICATE_THRESHOLD = NEAR_DUPLICATE_THRESHOLD;
