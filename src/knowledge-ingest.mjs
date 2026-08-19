import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runProcess } from "./executor.mjs";
import { agyConfigArgs } from "./agent-config.mjs";
import { createAgentTelemetryRecord, persistKnowledgeTelemetry } from "./telemetry.mjs";

export const VALID_DOMAINS = new Set([
  "frontend",
  "backend",
  "mobile",
  "devops",
  "architecture",
  "general",
]);

export const VALID_KNOWLEDGE_TYPES = new Set([
  "concept",
  "pattern",
  "snippet",
  "decision",
  "debugging",
]);

export const VALID_DESTINATIONS = new Set(["WIKI", "CANDIDATE"]);

export const TYPE_FOLDERS = Object.freeze({
  concept: "concepts",
  pattern: "patterns",
  snippet: "snippets",
  decision: "decisions",
  debugging: "debugging",
});

export function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || `knowledge-${Date.now()}`;
}

export function knowledgeSynthesisSchema() {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "summary",
      "purpose",
      "keyPoints",
      "codeSnippets",
      "considerations",
      "tags",
      "relatedKnowledge",
    ],
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      purpose: { type: "string" },
      keyPoints: { type: "array", items: { type: "string" } },
      codeSnippets: {
        type: "array",
        items: {
          type: "object",
          required: ["language", "code", "description"],
          properties: {
            language: { type: "string" },
            code: { type: "string" },
            description: { type: "string" },
          },
        },
      },
      considerations: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      relatedKnowledge: { type: "array", items: { type: "string" } },
    },
  });
}

function unwrapSynthesis(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.title && (payload.summary || payload.purpose || payload.keyPoints)) return payload;
  if (payload.structured_output && typeof payload.structured_output === "object") {
    return unwrapSynthesis(payload.structured_output);
  }
  if (typeof payload.response === "string" && payload.response.trim()) {
    try {
      return unwrapSynthesis(JSON.parse(payload.response));
    } catch {
      return null;
    }
  }
  return null;
}

export function parseSynthesisOutput(result) {
  const candidates = [];
  if (result.finalResult && typeof result.finalResult === "object") {
    candidates.push(result.finalResult);
  }
  const stdout = String(result.stdoutTail ?? "").trim();
  if (stdout) {
    try {
      candidates.push(JSON.parse(stdout));
    } catch {
      const lines = stdout.split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        try {
          candidates.push(JSON.parse(line));
        } catch {}
      }
    }
  }
  for (const candidate of candidates) {
    const unwrap = unwrapSynthesis(candidate);
    if (unwrap) return unwrap;
  }
  throw new Error("Agy agent tidak menghasilkan JSON synthesis yang valid.");
}

export async function synthesizeWithAgy({
  rawContent,
  title,
  domain,
  type,
  runsRoot = null,
  processRunner = runProcess,
}) {
  const ingestId = `ingest-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const eventLogPath = runsRoot ? path.join(runsRoot, "events", `${ingestId}.jsonl`) : null;
  const agentConfig = {
    model: "gemini-3.7-flash",
    effort: "low",
  };

  const prompt = [
    "=== ATURAN KNOWLEDGE INGESTION ENGINE ===",
    "1. Sintesis ringkasan konsep, poin implementasi, dan snippet terstruktur yang bersih tanpa fluff dari raw markdown/text.",
    "2. Jangan menambahkan intro atau outro basa-basi.",
    "3. Pastikan poin implementasi jelas, akurat, dan dapat diaplikasikan.",
    `Domain: ${domain}`,
    `Knowledge Type: ${type}`,
    title ? `Requested Title: ${title}` : "",
    "",
    "=== RAW CONTENT ===",
    rawContent,
  ].filter(Boolean).join("\n");

  const result = await processRunner({
    command: "agy",
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      knowledgeSynthesisSchema(),
      ...agyConfigArgs(agentConfig),
      "--mode",
      "plan",
      "--print-timeout",
      "10m",
    ],
    cwd: process.cwd(),
    stage: "knowledge-ingest",
    ...(eventLogPath ? { eventLogPath } : {}),
  });

  if (result.exitCode !== 0) {
    throw new Error(`Knowledge ingestion synthesis agent gagal dengan exit code ${result.exitCode}.`);
  }

  const parsed = parseSynthesisOutput(result);

  if (runsRoot) {
    try {
      const telemetryRecord = createAgentTelemetryRecord({
        stage: "KNOWLEDGE_INGEST",
        result,
        agentConfig,
        invocationId: ingestId,
        metadata: {
          ingestId,
          domain,
          type,
          title: title || parsed.title,
        },
      });
      persistKnowledgeTelemetry({
        runsRoot,
        id: ingestId,
        record: telemetryRecord,
        metadata: {
          type: "raw-ingest",
          domain,
        },
      });
    } catch {
      // Telemetry recording is non-blocking
    }
  }

  return { synthesis: parsed, ingestId, agentConfig, result };
}

export function normalizeSynthesis(raw, defaultTitle = null, domain = "general", type = "concept") {
  const title = String(raw.title || defaultTitle || "Ingested Knowledge").trim();
  const summary = String(raw.summary || "").trim();
  const purpose = String(raw.purpose || "").trim();
  const keyPoints = Array.isArray(raw.keyPoints)
    ? raw.keyPoints.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  const codeSnippets = Array.isArray(raw.codeSnippets)
    ? raw.codeSnippets.map((item) => ({
        language: String(item.language || "text").trim(),
        code: String(item.code || "").trim(),
        description: String(item.description || "").trim(),
      })).filter((item) => item.code.length > 0)
    : [];
  const considerations = Array.isArray(raw.considerations)
    ? raw.considerations.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  const tags = Array.isArray(raw.tags)
    ? [...new Set([type, domain, ...raw.tags.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean)])]
    : [type, domain];
  const relatedKnowledge = Array.isArray(raw.relatedKnowledge)
    ? raw.relatedKnowledge.map(String).map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    title,
    summary,
    purpose,
    keyPoints,
    codeSnippets,
    considerations,
    tags,
    relatedKnowledge,
  };
}

function formatKnowledgeMarkdown({
  title,
  type,
  domain,
  destination,
  synthesis,
  sourcePath,
  ingestId,
}) {
  const today = new Date().toISOString().slice(0, 10);
  const docType = destination === "CANDIDATE" ? "candidate" : type;
  const tags = destination === "CANDIDATE"
    ? `[candidate, ${type}, ${domain}]`
    : `[${synthesis.tags.join(", ")}]`;

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `type: ${docType}`,
    `tags: ${tags}`,
    `created: ${today}`,
    `updated: ${today}`,
    `orchestrator_run: ${ingestId}`,
    `sources: ["[[${sourcePath}]]"]`,
    "---",
  ].join("\n");

  const keyPointsSection = synthesis.keyPoints.length > 0
    ? synthesis.keyPoints.map((point) => `- ${point}`).join("\n")
    : "- Direct knowledge ingestion.";

  const codeSnippetsSection = synthesis.codeSnippets.length > 0
    ? synthesis.codeSnippets.map((snippet) => [
        snippet.description ? `### ${snippet.description}\n` : "",
        `\`\`\`${snippet.language}`,
        snippet.code,
        "```",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "";

  const considerationsSection = synthesis.considerations.length > 0
    ? synthesis.considerations.map((item) => `- ${item}`).join("\n")
    : "- Memerlukan validasi pada kasus penggunaan spesifik.";

  const relatedKnowledgeSection = synthesis.relatedKnowledge.length > 0
    ? synthesis.relatedKnowledge.map((item) => `- ${item.startsWith("[[") ? item : `[[${item}]]`}`).join("\n")
    : "- Belum ada halaman terkait yang dihubungkan.";

  let body = "";
  if (destination === "CANDIDATE") {
    body = [
      `# ${title}`,
      "",
      "## Observation",
      "",
      synthesis.summary || "Pengetahuan baru dari ingestion mentah.",
      "",
      "## Purpose",
      "",
      synthesis.purpose || "Preserve learning dari sumber yang di-ingest.",
      "",
      "## Key Implementation Points",
      "",
      keyPointsSection,
      "",
      ...(codeSnippetsSection ? [
        "## Code Examples",
        "",
        codeSnippetsSection,
        "",
      ] : []),
      "## Why It Is Not Promoted Yet",
      "",
      "Disimpan sebagai candidate untuk validasi sebelum promosi ke Wiki global.",
      "",
      "## Promotion Criteria",
      "",
      "- Memerlukan review atau konfirmasi kebutuhan lintas project.",
      "",
      "## Considerations",
      "",
      considerationsSection,
      "",
      "## Related Knowledge",
      "",
      relatedKnowledgeSection,
      "",
      "## Source",
      "",
      `- [[${sourcePath}]]`,
      "",
    ].join("\n");
  } else {
    body = [
      `# ${title}`,
      "",
      "## Overview",
      "",
      synthesis.summary || "Pengetahuan baru dari ingestion mentah.",
      "",
      "## Purpose",
      "",
      synthesis.purpose || "Preserve learning dari sumber yang di-ingest.",
      "",
      "## Key Implementation Points",
      "",
      keyPointsSection,
      "",
      ...(codeSnippetsSection ? [
        "## Code Examples",
        "",
        codeSnippetsSection,
        "",
      ] : []),
      "## Considerations",
      "",
      considerationsSection,
      "",
      "## Related Knowledge",
      "",
      relatedKnowledgeSection,
      "",
      "## Source",
      "",
      `- [[${sourcePath}]]`,
      "",
    ].join("\n");
  }

  return `${frontmatter}\n\n${body}`;
}

function saveSourceArtifact(vaultRoot, ingestId, { rawContent, title, domain, type, destination, synthesis }) {
  const relativePath = path.join("03-Sources", "other", "orchestrator-runs", `${ingestId}.json`).split(path.sep).join("/");
  const absolutePath = path.join(vaultRoot, relativePath);
  const sourcePayload = {
    schemaVersion: 1,
    immutable: true,
    capturedAt: new Date().toISOString(),
    runId: ingestId,
    type: "knowledge-ingest",
    domain,
    knowledgeType: type,
    destination,
    rawContent,
    proposal: {
      title,
      type,
      classification: "NEW",
      confidence: 0.95,
      summary: synthesis.summary,
      rationale: synthesis.purpose,
      considerations: synthesis.considerations,
      relatedKnowledge: synthesis.relatedKnowledge,
    },
  };
  writeAtomic(absolutePath, `${JSON.stringify(sourcePayload, null, 2)}\n`);
  return relativePath;
}

export function updateIndexForIngest(vaultRoot, relativeTarget, title, summary) {
  const indexPath = path.join(vaultRoot, "index.md");
  let content = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "# Personal AI Software Engineering System Index\n";
  const target = relativeTarget.replace(/\.md$/, "");
  if (content.includes(`[[${target}|`) || content.includes(`[[${target}]]`)) return;
  const heading = "## Orchestrator Knowledge Ingestion";
  const entry = `- [[${target}|${title}]]: ${summary || title}`;
  content = content.includes(heading)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n${heading}\n\n${entry}\n`;
  writeAtomic(indexPath, content);
}

export function appendWikiLogForIngest(vaultRoot, { title, relativeTarget, sourcePath, destination, domain, type }) {
  const logPath = path.join(vaultRoot, "wiki-log.md");
  let content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Wiki Log\n";
  const marker = `ingest: ${relativeTarget}`;
  if (content.includes(marker)) return;
  const today = new Date().toISOString().slice(0, 10);
  const targetLink = relativeTarget.replace(/\.md$/, "");
  const sourceLink = sourcePath ? sourcePath.replace(/\.md$/, "") : null;
  const entry = [
    `## [${today}] ingest | ${title}`,
    `- ${marker}`,
    `- Domain: \`${domain}\`, Type: \`${type}\`, Destination: \`${destination}\`.`,
    `- Target: [[${targetLink}]].`,
    sourceLink ? `- Source: [[${sourceLink}]].` : null,
  ].filter(Boolean).join("\n");
  content = `${content.trimEnd()}\n\n${entry}\n`;
  writeAtomic(logPath, content);
}

export async function ingestRawKnowledge({
  vaultRoot,
  runsRoot = null,
  rawContent,
  content,
  title = null,
  domain,
  type,
  destination = "WIKI",
  processRunner = runProcess,
  synthesiser = null,
}) {
  if (!vaultRoot || typeof vaultRoot !== "string") {
    throw new Error("vaultRoot harus ditentukan.");
  }

  const rawText = String(rawContent ?? content ?? "").trim();
  if (!rawText) {
    const error = new Error("Parameter rawContent tidak boleh kosong.");
    error.statusCode = 400;
    throw error;
  }

  if (!domain || typeof domain !== "string" || !VALID_DOMAINS.has(domain.toLowerCase().trim())) {
    const error = new Error(`Domain tidak valid: '${domain}'. Domain yang didukung: ${[...VALID_DOMAINS].join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  const normalizedDomain = domain.toLowerCase().trim();

  if (!type || typeof type !== "string" || !VALID_KNOWLEDGE_TYPES.has(type.toLowerCase().trim())) {
    const error = new Error(`Type tidak valid: '${type}'. Type yang didukung: ${[...VALID_KNOWLEDGE_TYPES].join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  const normalizedType = type.toLowerCase().trim();

  const normalizedDestination = String(destination ?? "WIKI").toUpperCase().trim();
  if (!VALID_DESTINATIONS.has(normalizedDestination)) {
    const error = new Error(`Destination tidak valid: '${destination}'. Destination yang didukung: WIKI, CANDIDATE`);
    error.statusCode = 400;
    throw error;
  }

  // Synthesize content using provided synthesiser or synthesizeWithAgy
  let synthResult = null;
  if (typeof synthesiser === "function") {
    synthResult = await synthesiser({
      rawContent: rawText,
      title: title && typeof title === "string" ? title.trim() : null,
      domain: normalizedDomain,
      type: normalizedType,
      runsRoot,
      processRunner,
    });
  } else {
    synthResult = await synthesizeWithAgy({
      rawContent: rawText,
      title: title && typeof title === "string" ? title.trim() : null,
      domain: normalizedDomain,
      type: normalizedType,
      runsRoot,
      processRunner,
    });
  }

  const ingestId = synthResult.ingestId || `ingest-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const synthesis = normalizeSynthesis(
    synthResult.synthesis ?? synthResult,
    title,
    normalizedDomain,
    normalizedType,
  );
  const effectiveTitle = synthesis.title;
  const slug = slugify(effectiveTitle);

  // Determine target path
  let relativePath = "";
  if (normalizedDestination === "CANDIDATE") {
    relativePath = path.join("05-Knowledge-Candidates", `${slug}.md`).split(path.sep).join("/");
  } else {
    const typeFolder = TYPE_FOLDERS[normalizedType] || `${normalizedType}s`;
    relativePath = path.join("01-Knowledge", typeFolder, normalizedDomain, `${slug}.md`).split(path.sep).join("/");
  }

  // Save immutable source artifact
  const sourcePath = saveSourceArtifact(vaultRoot, ingestId, {
    rawContent: rawText,
    title: effectiveTitle,
    domain: normalizedDomain,
    type: normalizedType,
    destination: normalizedDestination,
    synthesis,
  });

  // Format and write Markdown page
  const markdownContent = formatKnowledgeMarkdown({
    title: effectiveTitle,
    type: normalizedType,
    domain: normalizedDomain,
    destination: normalizedDestination,
    synthesis,
    sourcePath,
    ingestId,
  });

  const absoluteTarget = path.join(vaultRoot, relativePath);
  writeAtomic(absoluteTarget, markdownContent);

  // Update index.md and wiki-log.md
  updateIndexForIngest(vaultRoot, relativePath, effectiveTitle, synthesis.summary);
  appendWikiLogForIngest(vaultRoot, {
    title: effectiveTitle,
    relativeTarget: relativePath,
    sourcePath,
    destination: normalizedDestination,
    domain: normalizedDomain,
    type: normalizedType,
  });

  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_INGESTED",
    ingestId,
    destination: normalizedDestination,
    target: {
      path: relativePath,
      title: effectiveTitle,
      domain: normalizedDomain,
      type: normalizedType,
    },
    source: {
      path: sourcePath,
    },
    synthesis,
    content: markdownContent,
  };
}
