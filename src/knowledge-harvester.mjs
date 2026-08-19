import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runProcess } from "./executor.mjs";
import { agyConfigArgs } from "./agent-config.mjs";

export const VALID_DOMAINS = new Set([
  "frontend",
  "backend",
  "mobile",
  "devops",
  "architecture",
  "general",
]);

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
    .slice(0, 100) || `pattern-${Date.now()}`;
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "graphify-out",
  ".turbo",
  ".cache",
  ".vscode",
  ".idea",
]);

export function scanRepositoryArchitecture(repositoryPath) {
  const packageJsonPath = path.join(repositoryPath, "package.json");
  let packageJson = {};
  if (fs.existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    } catch {}
  }

  const allDependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  const detectedFiles = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(repositoryPath, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        detectedFiles.push({ path: relative, type: "dir" });
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        detectedFiles.push({ path: relative, type: "file" });
      }
    }
  };
  walk(repositoryPath, 0);

  const filePaths = detectedFiles.map((f) => f.path.toLowerCase());

  // 1. Auth Pattern Detection
  const authDeps = ["jsonwebtoken", "jwt", "passport", "bcrypt", "argon2", "express-session", "lucia", "auth0", "next-auth", "jose", "@clerk/"]
    .filter((dep) => Object.keys(allDependencies).some((d) => d.toLowerCase().includes(dep)));
  const authFiles = filePaths.filter((p) => p.includes("auth") || p.includes("jwt") || p.includes("passport") || p.includes("guard") || p.includes("session"));
  const authDetected = authDeps.length > 0 || authFiles.length > 0;

  // 2. Error Handling Pattern Detection
  const errorDeps = ["boom", "http-errors", "zod", "joi", "yup", "validator"]
    .filter((dep) => Object.keys(allDependencies).some((d) => d.toLowerCase().includes(dep)));
  const errorFiles = filePaths.filter((p) => p.includes("error") || p.includes("exception") || p.includes("handler") || p.includes("middleware"));
  const errorHandlingDetected = errorDeps.length > 0 || errorFiles.length > 0;

  // 3. Database & Transactions Pattern Detection
  const dbDeps = ["prisma", "@prisma/client", "typeorm", "mongoose", "sequelize", "drizzle-orm", "knex", "pg", "mysql2", "redis", "ioredis"]
    .filter((dep) => Object.keys(allDependencies).some((d) => d.toLowerCase().includes(dep)));
  const dbFiles = filePaths.filter((p) => p.includes("db") || p.includes("database") || p.includes("repository") || p.includes("model") || p.includes("schema") || p.includes("migration"));
  const dbDetected = dbDeps.length > 0 || dbFiles.length > 0;

  // 4. Folder Structure & Architectural Style
  let architecturalStyle = "Layered Architecture";
  if (filePaths.some((p) => p.includes("domain") || p.includes("application") || p.includes("infrastructure"))) {
    architecturalStyle = "Clean / Hexagonal Architecture";
  } else if (filePaths.some((p) => p.includes("modules/") || p.includes("features/"))) {
    architecturalStyle = "Modular Architecture";
  } else if (filePaths.some((p) => p.includes("controller") || p.includes("service") || p.includes("repository"))) {
    architecturalStyle = "Controller-Service-Repository Pattern";
  }

  // 5. Graphify summary if available
  let graphifySummary = null;
  const graphifyPath = path.join(repositoryPath, "graphify-out", "graph.json");
  if (fs.existsSync(graphifyPath)) {
    try {
      const graph = JSON.parse(fs.readFileSync(graphifyPath, "utf8"));
      graphifySummary = {
        nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
        linkCount: Array.isArray(graph.links) ? graph.links.length : 0,
      };
    } catch {}
  }

  return {
    repositoryPath,
    packageName: packageJson.name || path.basename(repositoryPath),
    packageVersion: packageJson.version || "0.0.0",
    dependencies: Object.keys(packageJson.dependencies || {}),
    devDependencies: Object.keys(packageJson.devDependencies || {}),
    scripts: Object.keys(packageJson.scripts || {}),
    detectedPatterns: {
      auth: {
        detected: authDetected,
        libraries: authDeps,
        relevantFiles: authFiles.slice(0, 10),
      },
      errorHandling: {
        detected: errorHandlingDetected,
        libraries: errorDeps,
        relevantFiles: errorFiles.slice(0, 10),
      },
      database: {
        detected: dbDetected,
        libraries: dbDeps,
        relevantFiles: dbFiles.slice(0, 10),
      },
      structure: {
        style: architecturalStyle,
        totalFilesScanned: detectedFiles.length,
        sampleDirectories: detectedFiles.filter((f) => f.type === "dir").map((f) => f.path).slice(0, 15),
      },
    },
    graphifySummary,
  };
}

export function knowledgeHarvestSchema() {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["patterns"],
    properties: {
      patterns: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          required: [
            "title",
            "summary",
            "confidence",
            "purpose",
            "overview",
            "codeStructure",
            "keyImplementationPoints",
            "codeSnippets",
            "considerations",
            "tags",
            "relatedKnowledge",
          ],
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            purpose: { type: "string" },
            overview: { type: "string" },
            codeStructure: { type: "string" },
            keyImplementationPoints: { type: "array", items: { type: "string" } },
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
        },
      },
    },
  });
}

function unwrapHarvest(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload.patterns) && payload.patterns.length > 0) return payload;
  if (payload.structured_output && typeof payload.structured_output === "object") {
    const unwrap = unwrapHarvest(payload.structured_output);
    if (unwrap) return unwrap;
  }
  if (typeof payload.response === "string" && payload.response.trim()) {
    try {
      const parsed = JSON.parse(payload.response);
      const unwrap = unwrapHarvest(parsed);
      if (unwrap) return unwrap;
    } catch {
      // Look for embedded JSON containing "patterns" in response text
      const match = payload.response.match(/\{[\s\S]*"patterns"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          const unwrap = unwrapHarvest(parsed);
          if (unwrap) return unwrap;
        } catch {}
      }
    }
  }
  return null;
}

export function parseHarvestOutput(result) {
  const candidates = [];
  if (result && typeof result === "object") {
    if (result.finalResult && typeof result.finalResult === "object") candidates.push(result.finalResult);
    if (result.payload && typeof result.payload === "object") candidates.push(result.payload);
    candidates.push(result);
  }
  const stdout = String(result.stdoutTail ?? result.stdout ?? "").trim();
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
    const unwrap = unwrapHarvest(candidate);
    if (unwrap) return unwrap;
  }
  throw new Error("Agy agent tidak menghasilkan JSON harvest patterns yang valid.");
}

export async function harvestWithAgy({
  scanSummary,
  templateContent,
  domain,
  runsRoot = null,
  processRunner = runProcess,
}) {
  const harvestId = `harvest-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const eventLogPath = runsRoot ? path.join(runsRoot, "events", `${harvestId}.jsonl`) : null;
  const agentConfig = {
    model: "gemini-3.7-flash",
    effort: "low",
  };

  const prompt = [
    "=== ATURAN CODEBASE KNOWLEDGE HARVESTER ===",
    "1. Ekstrak 2 sampai 4 best practice / pola arsitektur terbaik dari repositori lokal berikut.",
    "2. Fokus pada pola arsitektur autentikasi, error handling, transaksi database, atau struktur folder & modularitas.",
    "3. Format dokumen harus mengikuti pola template domain markdown terstruktur.",
    "4. Tentukan confidence score (0.0 - 1.0) untuk setiap pola; confidence >= 0.9 akan dipromosikan langsung ke Wiki, < 0.9 menjadi candidate.",
    `Domain: ${domain}`,
    "",
    "=== TEMPLATE DOMAIN SEBAGAI PANDUAN ===",
    templateContent || "Standard pattern structure: Overview, Implementation, Code Examples, Considerations, Related Knowledge.",
    "",
    "=== REPOSITORY SCAN & AST SUMMARY ===",
    JSON.stringify(scanSummary, null, 2),
  ].join("\n");

  const result = await processRunner({
    command: "agy",
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      knowledgeHarvestSchema(),
      ...agyConfigArgs(agentConfig),
      "--mode",
      "plan",
      "--print-timeout",
      "10m",
    ],
    cwd: scanSummary.repositoryPath || process.cwd(),
    stage: "knowledge-harvest",
    ...(eventLogPath ? { eventLogPath } : {}),
  });

  if (result.exitCode !== 0) {
    throw new Error(`Knowledge harvester agent gagal dengan exit code ${result.exitCode}.`);
  }

  const parsed = parseHarvestOutput(result);
  return { harvest: parsed, harvestId, agentConfig };
}

export function formatHarvestMarkdown({
  pattern,
  domain,
  destination,
  sourcePath,
  harvestId,
}) {
  const today = new Date().toISOString().slice(0, 10);
  const docType = destination === "CANDIDATE" ? "candidate" : "pattern";
  const tags = destination === "CANDIDATE"
    ? `[candidate, pattern, ${domain}]`
    : `[${(pattern.tags || ["pattern", domain]).join(", ")}]`;

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(pattern.title)}`,
    `type: ${docType}`,
    `tags: ${tags}`,
    `created: ${today}`,
    `updated: ${today}`,
    `orchestrator_run: ${harvestId}`,
    `sources: ["[[${sourcePath}]]"]`,
    "---",
  ].join("\n");

  const keyPointsSection = (pattern.keyImplementationPoints || []).length > 0
    ? pattern.keyImplementationPoints.map((point) => `- ${point}`).join("\n")
    : "- Pola arsitektur terverifikasi dari repositori.";

  const codeSnippetsSection = (pattern.codeSnippets || []).length > 0
    ? pattern.codeSnippets.map((snippet) => [
        snippet.description ? `### ${snippet.description}\n` : "",
        `\`\`\`${snippet.language || "typescript"}`,
        snippet.code,
        "```",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "";

  const considerationsSection = (pattern.considerations || []).length > 0
    ? pattern.considerations.map((item) => `- ${item}`).join("\n")
    : "- Memerlukan penyesuaian dependensi spesifik project.";

  const relatedKnowledgeSection = (pattern.relatedKnowledge || []).length > 0
    ? pattern.relatedKnowledge.map((item) => `- ${item.startsWith("[[") ? item : `[[${item}]]`}`).join("\n")
    : "- Belum ada halaman terkait yang dihubungkan.";

  let body = "";
  if (destination === "CANDIDATE") {
    body = [
      `# ${pattern.title}`,
      "",
      "## Observation",
      "",
      pattern.summary || pattern.overview || "Pola arsitektur hasil ekstraksi otomatis dari codebase.",
      "",
      "## Purpose",
      "",
      pattern.purpose || "Preserve best practice arsitektur codebase.",
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
      `Disimpan sebagai candidate karena confidence score (${pattern.confidence}) memerlukan review atau konfirmasi sebelum promosi ke Wiki global.`,
      "",
      "## Promotion Criteria",
      "",
      "- Memerlukan review arsitektur atau konfirmasi kebutuhan lintas project.",
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
      `# ${pattern.title}`,
      "",
      pattern.summary || "",
      "",
      "## 1. Overview & Architecture",
      "",
      pattern.overview || pattern.purpose || "Overview arsitektur dan pola implementasi.",
      "",
      ...(pattern.codeStructure ? [
        "## 2. Implementation & Code Structure",
        "",
        pattern.codeStructure,
        "",
      ] : []),
      "## 3. Key Implementation Points",
      "",
      keyPointsSection,
      "",
      ...(codeSnippetsSection ? [
        "## 4. Code Examples",
        "",
        codeSnippetsSection,
        "",
      ] : []),
      "## 5. Considerations & Best Practices",
      "",
      considerationsSection,
      "",
      "## 6. Related Knowledge",
      "",
      relatedKnowledgeSection,
      "",
      "## 7. Source",
      "",
      `- [[${sourcePath}]]`,
      "",
    ].join("\n");
  }

  return `${frontmatter}\n\n${body}`;
}

export function updateIndexForHarvest(vaultRoot, relativeTarget, title, summary) {
  const indexPath = path.join(vaultRoot, "index.md");
  let content = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "# Personal AI Software Engineering System Index\n";
  const target = relativeTarget.replace(/\.md$/, "");
  if (content.includes(`[[${target}|`) || content.includes(`[[${target}]]`)) return;
  const heading = "## Orchestrator Harvested Knowledge";
  const entry = `- [[${target}|${title}]]: ${summary || title}`;
  content = content.includes(heading)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n${heading}\n\n${entry}\n`;
  writeAtomic(indexPath, content);
}

export function appendWikiLogForHarvest(vaultRoot, { title, relativeTarget, sourcePath, destination, domain, confidence, repositoryPath }) {
  const logPath = path.join(vaultRoot, "wiki-log.md");
  let content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Wiki Log\n";
  const marker = `harvest: ${relativeTarget}`;
  if (content.includes(marker)) return;
  const today = new Date().toISOString().slice(0, 10);
  const targetLink = relativeTarget.replace(/\.md$/, "");
  const sourceLink = sourcePath ? sourcePath.replace(/\.md$/, "") : null;
  const entry = [
    `## [${today}] harvest | ${title}`,
    `- ${marker}`,
    `- Domain: \`${domain}\`, Type: \`pattern\`, Destination: \`${destination}\`, Confidence: \`${confidence}\`.`,
    `- Target: [[${targetLink}]].`,
    `- Repository: \`${repositoryPath}\`.`,
    sourceLink ? `- Source: [[${sourceLink}]].` : null,
  ].filter(Boolean).join("\n");
  content = `${content.trimEnd()}\n\n${entry}\n`;
  writeAtomic(logPath, content);
}

export async function harvestRepositoryKnowledge({
  vaultRoot,
  runsRoot = null,
  repositoryPath,
  domain = "backend",
  requestedBy = "user",
  processRunner = runProcess,
  harvester = null,
}) {
  if (!vaultRoot || typeof vaultRoot !== "string") {
    const error = new Error("vaultRoot harus ditentukan.");
    error.statusCode = 400;
    throw error;
  }

  if (!repositoryPath || typeof repositoryPath !== "string" || !repositoryPath.trim()) {
    const error = new Error("Parameter repositoryPath tidak boleh kosong.");
    error.statusCode = 400;
    throw error;
  }

  const resolvedRepoPath = path.resolve(repositoryPath.trim());
  if (!fs.existsSync(resolvedRepoPath)) {
    const error = new Error(`Repository path tidak ditemukan: ${resolvedRepoPath}`);
    error.statusCode = 400;
    throw error;
  }

  const normalizedDomain = String(domain || "backend").toLowerCase().trim();
  if (!VALID_DOMAINS.has(normalizedDomain)) {
    const error = new Error(`Domain tidak valid: '${domain}'. Domain yang didukung: ${[...VALID_DOMAINS].join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  // 1. Scan repository architecture / AST
  const scanSummary = scanRepositoryArchitecture(resolvedRepoPath);

  // 2. Load domain template from vault if available
  let templateContent = "";
  const templateCandidatePath = path.join(vaultRoot, "01-Knowledge", "_templates", `${normalizedDomain}-pattern-template.md`);
  if (fs.existsSync(templateCandidatePath)) {
    templateContent = fs.readFileSync(templateCandidatePath, "utf8");
  }

  // 3. Harvest with AGY or custom harvester
  let harvestResult = null;
  if (typeof harvester === "function") {
    harvestResult = await harvester({
      vaultRoot,
      runsRoot,
      repositoryPath: resolvedRepoPath,
      scanSummary,
      templateContent,
      domain: normalizedDomain,
      requestedBy,
      processRunner,
    });
  } else {
    harvestResult = await harvestWithAgy({
      scanSummary,
      templateContent,
      domain: normalizedDomain,
      runsRoot,
      processRunner,
    });
  }

  const harvestId = harvestResult.harvestId || `harvest-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const patterns = harvestResult.harvest?.patterns || harvestResult.patterns || [];

  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error("Harvester tidak menghasilkan pattern arsitektur.");
  }

  // 4. Save immutable source artifact
  const sourcePayload = {
    schemaVersion: 1,
    immutable: true,
    capturedAt: new Date().toISOString(),
    harvestId,
    type: "codebase-harvest",
    domain: normalizedDomain,
    repositoryPath: resolvedRepoPath,
    requestedBy,
    scanSummary,
    patterns,
  };
  const sourceRelativePath = path.join("03-Sources", "other", "orchestrator-runs", `${harvestId}.json`).split(path.sep).join("/");
  const sourceAbsolutePath = path.join(vaultRoot, sourceRelativePath);
  writeAtomic(sourceAbsolutePath, `${JSON.stringify(sourcePayload, null, 2)}\n`);

  // 5. Process each pattern: determine destination, format markdown, write file, update index and wiki-log
  const harvestedItems = [];
  for (const rawPattern of patterns) {
    const pattern = {
      title: String(rawPattern.title || "Harvested Pattern").trim(),
      summary: String(rawPattern.summary || "").trim(),
      confidence: typeof rawPattern.confidence === "number" ? rawPattern.confidence : 0.95,
      purpose: String(rawPattern.purpose || "").trim(),
      overview: String(rawPattern.overview || "").trim(),
      codeStructure: String(rawPattern.codeStructure || "").trim(),
      keyImplementationPoints: Array.isArray(rawPattern.keyImplementationPoints)
        ? rawPattern.keyImplementationPoints.map(String)
        : [],
      codeSnippets: Array.isArray(rawPattern.codeSnippets) ? rawPattern.codeSnippets : [],
      considerations: Array.isArray(rawPattern.considerations) ? rawPattern.considerations.map(String) : [],
      tags: Array.isArray(rawPattern.tags)
        ? [...new Set(["pattern", normalizedDomain, ...rawPattern.tags.map((t) => String(t).toLowerCase().trim())])]
        : ["pattern", normalizedDomain],
      relatedKnowledge: Array.isArray(rawPattern.relatedKnowledge) ? rawPattern.relatedKnowledge.map(String) : [],
    };

    const isPromoted = pattern.confidence >= 0.9;
    const destination = isPromoted ? "WIKI" : "CANDIDATE";
    const slug = slugify(pattern.title);

    let relativePath = "";
    if (destination === "CANDIDATE") {
      relativePath = path.join("05-Knowledge-Candidates", `${slug}.md`).split(path.sep).join("/");
    } else {
      relativePath = path.join("01-Knowledge", "patterns", normalizedDomain, `${slug}.md`).split(path.sep).join("/");
    }

    const markdownContent = formatHarvestMarkdown({
      pattern,
      domain: normalizedDomain,
      destination,
      sourcePath: sourceRelativePath,
      harvestId,
    });

    const absoluteTarget = path.join(vaultRoot, relativePath);
    writeAtomic(absoluteTarget, markdownContent);

    // Update index.md and wiki-log.md
    updateIndexForHarvest(vaultRoot, relativePath, pattern.title, pattern.summary);
    appendWikiLogForHarvest(vaultRoot, {
      title: pattern.title,
      relativeTarget: relativePath,
      sourcePath: sourceRelativePath,
      destination,
      domain: normalizedDomain,
      confidence: pattern.confidence,
      repositoryPath: resolvedRepoPath,
    });

    harvestedItems.push({
      title: pattern.title,
      path: relativePath,
      destination,
      confidence: pattern.confidence,
      type: destination === "CANDIDATE" ? "candidate" : "pattern",
      domain: normalizedDomain,
      summary: pattern.summary,
    });
  }

  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_HARVESTED",
    harvestId,
    repositoryPath: resolvedRepoPath,
    domain: normalizedDomain,
    count: harvestedItems.length,
    harvested: harvestedItems,
    source: {
      path: sourceRelativePath,
    },
    scan: {
      packageName: scanSummary.packageName,
      detectedPatterns: scanSummary.detectedPatterns,
    },
  };
}
