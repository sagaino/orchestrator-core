import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runProcess } from "./executor.mjs";
import { getRun, RUN_STATES, transitionRun, updateRunExecution } from "./run-manager.mjs";
import { agyConfigArgs, resolveAgyConfig } from "./agent-config.mjs";
import { applyIsolatedWorkspace, cleanupIsolatedWorkspace } from "./workspace-manager.mjs";
import { notifyKnowledgeCandidateReady } from "./notification-service.mjs";
import { appendRunTelemetry, createAgentTelemetryRecord } from "./telemetry.mjs";
import { findSimilarKnowledge } from "./knowledge-quality.mjs";

const CLASSIFICATIONS = new Set(["NEW", "UPDATE", "PROJECT_ONLY", "IGNORE"]);
const DESTINATIONS = new Set(["WIKI", "CANDIDATE", "PROJECT", "NONE"]);
const KNOWLEDGE_TYPES = new Set(["concept", "pattern", "snippet", "decision", "debugging"]);

const TYPE_FOLDERS = Object.freeze({
  concept: "concepts",
  pattern: "patterns",
  snippet: "snippets",
  decision: "decisions",
  debugging: "debugging",
});

const DEFAULT_AUTO_PROMOTE_CONFIDENCE = 0.9;

function configuredAutoPromoteConfidence(env = process.env) {
  const value = Number(env.ORCHESTRATOR_KNOWLEDGE_AUTO_PROMOTE_CONFIDENCE);
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_AUTO_PROMOTE_CONFIDENCE;
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "knowledge-from-task";
}

function markdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
    }
  };
  walk(root);
  return files;
}

function frontmatterValue(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) return null;
  const raw = match[1].trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function normalizedTitle(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findTitleMatch(root, title) {
  const expected = normalizedTitle(title);
  if (!expected) return null;
  return markdownFiles(root).find((filePath) => {
    if (path.basename(filePath).startsWith("_Template")) return false;
    const content = fs.readFileSync(filePath, "utf8");
    return normalizedTitle(frontmatterValue(content, "title")) === expected;
  }) ?? null;
}

function ensureInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Target berada di luar root yang diizinkan: ${target}`);
  }
  return resolvedTarget;
}

function normalizeProposal(proposal) {
  const classification = String(proposal?.classification ?? "").toUpperCase();
  if (!CLASSIFICATIONS.has(classification)) {
    throw new Error(`Klasifikasi retrospective tidak valid: ${classification || "EMPTY"}`);
  }
  const type = KNOWLEDGE_TYPES.has(String(proposal.type).toLowerCase())
    ? String(proposal.type).toLowerCase()
    : "concept";
  const confidenceValue = Number(proposal.confidence);
  return {
    classification,
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0.5,
    title: String(proposal.title ?? "Knowledge from task").trim(),
    type,
    targetPath: proposal.targetPath ? String(proposal.targetPath).trim() : null,
    summary: String(proposal.summary ?? "").trim(),
    rationale: String(proposal.rationale ?? "").trim(),
    considerations: Array.isArray(proposal.considerations) ? proposal.considerations.map(String) : [],
    relatedKnowledge: Array.isArray(proposal.relatedKnowledge) ? proposal.relatedKnowledge.map(String) : [],
  };
}

function unwrapProposal(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.classification) return payload;
  if (payload.structured_output && typeof payload.structured_output === "object") {
    return unwrapProposal(payload.structured_output);
  }
  if (typeof payload.response === "string" && payload.response.trim()) {
    try {
      return unwrapProposal(JSON.parse(payload.response));
    } catch {
      return null;
    }
  }
  return null;
}

export function parseRetrospectiveOutput(result) {
  const candidates = [];
  if (result.finalResult && typeof result.finalResult === "object") candidates.push(result.finalResult);

  const output = String(result.stdoutTail ?? "").trim();
  if (output) {
    try {
      candidates.push(JSON.parse(output));
    } catch {
      const lines = output.split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        try {
          candidates.push(JSON.parse(line));
        } catch {
          // Continue to the previous line.
        }
      }
    }
  }

  for (const candidate of candidates) {
    const proposal = unwrapProposal(candidate);
    if (proposal) return proposal;
  }
  throw new Error("Coding agent tidak menghasilkan JSON retrospective yang valid.");
}

function retrospectiveSchema() {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["classification", "confidence", "title", "type", "summary", "rationale", "considerations", "relatedKnowledge"],
    properties: {
      classification: { type: "string", enum: ["NEW", "UPDATE", "PROJECT_ONLY", "IGNORE"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      title: { type: "string" },
      type: { type: "string", enum: [...KNOWLEDGE_TYPES] },
      targetPath: { type: ["string", "null"] },
      summary: { type: "string" },
      rationale: { type: "string" },
      considerations: { type: "array", items: { type: "string" } },
      relatedKnowledge: { type: "array", items: { type: "string" } },
    },
  });
}

export function compactRetrospectiveContext(manifest) {
  const verification = (manifest.execution?.verification ?? []).map((v) => ({
    command: v.command,
    exitCode: v.exitCode,
  }));

  let agentSummary = null;
  const rawAgent = manifest.execution?.agent?.finalResult;
  if (rawAgent) {
    if (typeof rawAgent === "object") {
      agentSummary = {
        summary: rawAgent.summary || rawAgent.description || rawAgent.message || undefined,
        changedFiles: rawAgent.changedFiles || rawAgent.files || undefined,
        status: rawAgent.status || undefined,
      };
      if (!agentSummary.summary && !agentSummary.changedFiles && !agentSummary.status) {
        const serialized = JSON.stringify(rawAgent);
        agentSummary = serialized.length > 500 ? `${serialized.slice(0, 500)}…` : rawAgent;
      }
    } else {
      const str = String(rawAgent).trim();
      agentSummary = str.length > 500 ? `${str.slice(0, 500)}…` : str;
    }
  }

  const recovery = manifest.execution?.automaticRecovery
    ? {
        attempts: manifest.execution.automaticRecovery.attempts,
        succeeded: manifest.execution.automaticRecovery.succeeded,
      }
    : null;

  const changedPaths = manifest.execution?.scopeAudit?.changedPaths?.length
    ? manifest.execution.scopeAudit.changedPaths
    : undefined;

  return {
    taskId: manifest.task?.id ?? undefined,
    verification: verification.length > 0 ? verification : undefined,
    recovery: recovery || undefined,
    agent: agentSummary || undefined,
    changedPaths,
  };
}

export function buildCompressedRetrospectivePrompt({ manifest, vaultRoot, projectRepository }) {
  const compactContext = compactRetrospectiveContext(manifest);
  return [
    "Retrospective read-only untuk task software engineering terverifikasi.",
    `Task: ${path.join(vaultRoot, manifest.task.path)} (${manifest.task.id || "TASK"})`,
    `Project: ${projectRepository}`,
    `Index: ${path.join(vaultRoot, "index.md")}`,
    "",
    "Instruksi: Klasifikasikan insight reusable (NEW|UPDATE|PROJECT_ONLY|IGNORE) dan hasilkan JSON payload kompak.",
    "- NEW: Reusable lintas project; cari existing Wiki page sebelum memilih NEW.",
    "- UPDATE: Update halaman existing jika konsep/snippet sudah ada.",
    "- PROJECT_ONLY: Khusus project ini saja.",
    "- IGNORE: Tidak ada insight/knowledge durable yang perlu disimpan.",
    "",
    `Context: ${JSON.stringify(compactContext)}`,
  ].join("\n");
}

async function generateProposalWithAgy({ manifest, vaultRoot, runsRoot, processRunner = runProcess }) {
  const eventLogPath = path.join(runsRoot, "events", `${manifest.runId}.jsonl`);
  const agentConfig = resolveAgyConfig(process.env, "retrospective");
  const projectRepository = manifest.execution?.workspace?.path ?? manifest.project.repository;
  const prompt = buildCompressedRetrospectivePrompt({ manifest, vaultRoot, projectRepository });
  const result = await processRunner({
    command: "agy",
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      retrospectiveSchema(),
      ...agyConfigArgs(agentConfig),
      "--mode",
      "plan",
      "--print-timeout",
      "10m",
    ],
    cwd: projectRepository,
    stage: "retrospective",
    eventLogPath,
  });
  const telemetry = createAgentTelemetryRecord({
    stage: "RETROSPECTIVE",
    result,
    agentConfig,
    invocationId: `${manifest.runId}:retrospective`,
    metadata: {
      runId: manifest.runId,
      taskId: manifest.task?.id ?? null,
      projectId: manifest.project?.id ?? null,
    },
  });
  appendRunTelemetry({ runsRoot, runId: manifest.runId, record: telemetry });
  if (result.exitCode !== 0) throw new Error(`Retrospective agent gagal dengan exit code ${result.exitCode}.`);
  return { proposal: parseRetrospectiveOutput(result), agentConfig };
}

export async function retrospectRun({
  vaultRoot,
  runsRoot,
  runId,
  proposalGenerator = generateProposalWithAgy,
}) {
  let manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.RETROSPECTIVE) return manifest;
  if (manifest.state !== RUN_STATES.REVIEW) {
    throw new Error(`Run ${runId} harus REVIEW sebelum retrospective; state ${manifest.state}.`);
  }
  const generated = await proposalGenerator({ manifest, vaultRoot, runsRoot });
  const proposal = normalizeProposal(generated?.proposal ?? generated);
  const retrospectiveAgent = generated?.agentConfig ?? null;
  if (generated?.telemetry) {
    manifest = appendRunTelemetry({ runsRoot, runId, record: generated.telemetry });
  }
  return transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.RETROSPECTIVE,
    knowledgePatch: {
      proposal,
      proposedAt: new Date().toISOString(),
      ...(retrospectiveAgent ? { retrospectiveAgent } : {}),
    },
    message: `retrospective menghasilkan klasifikasi ${proposal.classification}.`,
  });
}

function defaultWikiTarget(proposal) {
  return path.join("01-Knowledge", TYPE_FOLDERS[proposal.type], `${slugify(proposal.title)}.md`)
    .split(path.sep)
    .join("/");
}

function validRelativeWikiTarget(targetPath) {
  const normalized = String(targetPath ?? "").replaceAll("\\", "/");
  return normalized.startsWith("01-Knowledge/")
    && normalized.endsWith(".md")
    && !normalized.split("/").includes("..");
}

export function resolveKnowledgeRouting({
  vaultRoot,
  manifest,
  decision = null,
  destination = null,
  targetPath = null,
  minimumConfidence = configuredAutoPromoteConfidence(),
}) {
  const proposal = manifest.knowledge.proposal;
  let classification = String(decision ?? proposal.classification).toUpperCase();
  if (!CLASSIFICATIONS.has(classification)) {
    throw new Error(`Knowledge decision tidak valid: ${classification}.`);
  }

  if (destination) {
    const resolvedDestination = String(destination).toUpperCase();
    const explicitTarget = targetPath
      ?? (resolvedDestination === "WIKI" ? proposal.targetPath || defaultWikiTarget(proposal) : null);
    return {
      classification,
      destination: resolvedDestination,
      targetPath: explicitTarget,
      automatic: false,
      reason: "Destination ditentukan secara eksplisit oleh user.",
      checks: { userOverride: true },
    };
  }

  if (classification === "UPDATE") {
    return {
      classification,
      destination: "WIKI",
      targetPath: targetPath ?? proposal.targetPath,
      automatic: true,
      reason: "Knowledge UPDATE diarahkan ke Wiki existing.",
      checks: { classification: "UPDATE" },
    };
  }
  if (classification === "PROJECT_ONLY") {
    return {
      classification,
      destination: "PROJECT",
      targetPath: null,
      automatic: true,
      reason: "Knowledge hanya berlaku untuk project.",
      checks: { classification: "PROJECT_ONLY" },
    };
  }
  if (classification === "IGNORE") {
    return {
      classification,
      destination: "NONE",
      targetPath: null,
      automatic: true,
      reason: "Tidak ada durable knowledge yang perlu disimpan.",
      checks: { classification: "IGNORE" },
    };
  }

  const proposedTarget = targetPath ?? proposal.targetPath;
  const targetValid = proposedTarget ? validRelativeWikiTarget(proposedTarget) : true;
  const wikiTarget = targetValid ? proposedTarget || defaultWikiTarget(proposal) : defaultWikiTarget(proposal);
  const wikiRoot = path.join(vaultRoot, "01-Knowledge");
  const candidateRoot = path.join(vaultRoot, "05-Knowledge-Candidates");
  const requestedWikiAbsolute = path.join(vaultRoot, wikiTarget);
  const wikiDuplicate = fs.existsSync(requestedWikiAbsolute)
    ? requestedWikiAbsolute
    : findTitleMatch(wikiRoot, proposal.title);
  const candidateDuplicate = findTitleMatch(candidateRoot, proposal.title);
  const similarKnowledge = findSimilarKnowledge({
    vaultRoot,
    title: proposal.title,
    body: [proposal.summary, proposal.rationale, ...proposal.considerations].join("\n"),
  }).slice(0, 3);
  const nearDuplicate = similarKnowledge.find((match) => !match.exactTitle) ?? null;
  const verification = manifest.execution?.verification ?? [];
  const checks = {
    confidence: proposal.confidence,
    minimumConfidence,
    confidencePassed: proposal.confidence >= minimumConfidence,
    targetValid,
    proposalComplete: proposal.summary.length >= 20 && proposal.rationale.length >= 20,
    verified: verification.length > 0 && verification.every((item) => item.exitCode === 0),
    sourceAvailable: Boolean(manifest.runId && manifest.task?.id),
    wikiDuplicate: wikiDuplicate ? path.relative(vaultRoot, wikiDuplicate).split(path.sep).join("/") : null,
    candidateDuplicate: candidateDuplicate ? path.relative(vaultRoot, candidateDuplicate).split(path.sep).join("/") : null,
    similarKnowledge,
  };
  const promotionPassed = checks.confidencePassed
    && checks.targetValid
    && checks.proposalComplete
    && checks.verified
    && checks.sourceAvailable;

  if (promotionPassed && wikiDuplicate) {
    classification = "UPDATE";
    return {
      classification,
      destination: "WIKI",
      targetPath: checks.wikiDuplicate,
      automatic: true,
      reason: "Knowledge baru cocok dengan halaman existing dan otomatis diperlakukan sebagai UPDATE.",
      checks,
      originalClassification: "NEW",
    };
  }
  if (promotionPassed && !candidateDuplicate && !nearDuplicate) {
    return {
      classification,
      destination: "WIKI",
      targetPath: wikiTarget,
      automatic: true,
      reason: `NEW knowledge memenuhi auto-promotion gate dengan confidence ${proposal.confidence}.`,
      checks,
    };
  }

  return {
    classification,
    destination: "CANDIDATE",
    targetPath: checks.candidateDuplicate,
    automatic: true,
    reason: candidateDuplicate
      ? "Candidate dengan judul yang sama sudah ada dan menunggu approval manual."
      : nearDuplicate
        ? `Knowledge mirip ditemukan di ${nearDuplicate.path}; perlu review target sebelum promosi.`
        : "NEW knowledge belum memenuhi seluruh auto-promotion gate.",
    checks,
  };
}

export function approveKnowledgeRun({
  vaultRoot,
  runsRoot,
  runId,
  approvedBy = "user",
  decision = null,
  destination = null,
  targetPath = null,
}) {
  const manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.KNOWLEDGE_APPROVAL) return manifest;
  if (manifest.state !== RUN_STATES.RETROSPECTIVE) {
    throw new Error(`Run ${runId} harus RETROSPECTIVE sebelum knowledge approval; state ${manifest.state}.`);
  }

  const routing = resolveKnowledgeRouting({
    vaultRoot,
    manifest,
    decision,
    destination,
    targetPath,
  });
  const classification = routing.classification;
  const resolvedDestination = String(routing.destination).toUpperCase();
  if (!DESTINATIONS.has(resolvedDestination)) throw new Error(`Knowledge destination tidak valid: ${resolvedDestination}.`);

  const expected = {
    UPDATE: ["WIKI"],
    PROJECT_ONLY: ["PROJECT"],
    IGNORE: ["NONE"],
    NEW: ["WIKI", "CANDIDATE"],
  };
  if (!expected[classification].includes(resolvedDestination)) {
    throw new Error(`Decision ${classification} tidak kompatibel dengan destination ${resolvedDestination}.`);
  }

  const at = new Date().toISOString();
  return transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.KNOWLEDGE_APPROVAL,
    knowledgePatch: {
      approval: {
        approvedAt: at,
        approvedBy: String(approvedBy).trim() || "user",
        classification,
        destination: resolvedDestination,
        targetPath: routing.targetPath,
        routing,
      },
    },
    message: `knowledge ${classification} disetujui untuk ${resolvedDestination}.`,
  });
}

function sourceArtifact(vaultRoot, manifest) {
  const relative = path.join("03-Sources", "other", "orchestrator-runs", `${manifest.runId}.json`);
  const absolute = ensureInside(vaultRoot, path.join(vaultRoot, relative));
  if (!fs.existsSync(absolute)) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify({
      schemaVersion: 1,
      immutable: true,
      capturedAt: new Date().toISOString(),
      runId: manifest.runId,
      task: manifest.task,
      project: manifest.project,
      graph: manifest.graph,
      verification: manifest.execution.verification ?? [],
      agentResult: manifest.execution.agent?.finalResult ?? null,
      telemetry: manifest.execution.telemetry ?? null,
      proposal: manifest.knowledge.proposal,
      approval: manifest.knowledge.approval,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  return relative;
}

function sourceLink(sourcePath) {
  return `[[${sourcePath}]]`;
}

function relatedLinks(vaultRoot, items) {
  return items
    .map((item) => item.trim())
    .filter((item) => item && !item.includes("<") && !item.includes(">"))
    .map((item) => item.replace(/^\[\[|\]\]$/g, "").split("|")[0])
    .filter((target) => {
      const direct = path.join(vaultRoot, target);
      return fs.existsSync(direct) || fs.existsSync(`${direct}.md`);
    })
    .map((item) => `[[${item.replace(/\.md$/, "")}]]`);
}

function newKnowledgePage({ vaultRoot, manifest, proposal, type, sourcePath }) {
  const links = relatedLinks(vaultRoot, proposal.relatedKnowledge);
  return [
    "---",
    `title: ${JSON.stringify(proposal.title)}`,
    `type: ${type}`,
    `tags: [${type}, orchestrator-promotion]`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    `orchestrator_run: ${manifest.runId}`,
    `sources: ["${sourceLink(sourcePath)}"]`,
    "---",
    "",
    `# ${proposal.title}`,
    "",
    "## Overview",
    "",
    proposal.summary || "Knowledge extracted from a verified task.",
    "",
    "## Purpose",
    "",
    proposal.rationale || "Preserve reusable learning from task execution.",
    "",
    "## Considerations",
    "",
    ...(proposal.considerations.length ? proposal.considerations.map((item) => `- ${item}`) : ["- Requires validation in future usage."]),
    "",
    "## Related Knowledge",
    "",
    ...(links.length ? links.map((item) => `- ${item}`) : ["- No related page identified yet."]),
    "",
    "## Source",
    "",
    `- ${sourceLink(sourcePath)}`,
    "",
  ].join("\n");
}

function updateExistingKnowledge(content, manifest, proposal, sourcePath) {
  if (content.includes(`orchestrator-run:${manifest.runId}`)) return content;
  const today = new Date().toISOString().slice(0, 10);
  let updated = content.replace(/^updated:\s*.*$/m, `updated: ${today}`);
  const link = sourceLink(sourcePath);
  if (!updated.includes(link)) {
    if (/^sources:\s*\[\s*\]\s*$/m.test(updated)) {
      updated = updated.replace(/^sources:\s*\[\s*\]\s*$/m, `sources: ["${link}"]`);
    } else if (/^sources:\s*\[[^\]]*\]\s*$/m.test(updated)) {
      updated = updated.replace(/^(sources:\s*\[)([^\]]*)(\]\s*)$/m, (_, open, values, close) => {
        const separator = values.trim() ? ", " : "";
        return `${open}${values}${separator}"${link}"${close}`;
      });
    }
  }
  return `${updated.trimEnd()}\n\n## Update from ${manifest.task.id} — ${today}\n\n<!-- orchestrator-run:${manifest.runId} -->\n${proposal.summary}\n\n- Rationale: ${proposal.rationale}\n- Source: ${link}\n`;
}

function appendProjectRetrospective(taskPath, manifest, proposal, sourcePath) {
  let content = fs.readFileSync(taskPath, "utf8");
  if (content.includes(`orchestrator-run:${manifest.runId}`)) return;
  content = `${content.trimEnd()}\n\n## Knowledge Retrospective\n\n<!-- orchestrator-run:${manifest.runId} -->\n- Classification: \`PROJECT_ONLY\`\n- Summary: ${proposal.summary}\n- Rationale: ${proposal.rationale}\n- Source: ${sourceLink(sourcePath)}\n`;
  writeAtomic(taskPath, content);
}

function updateTaskKnowledgeDecision(taskPath, manifest, sourcePath) {
  let content = fs.readFileSync(taskPath, "utf8");
  const approval = manifest.knowledge.approval;
  const section = [
    "## Knowledge Decision",
    "",
    `- Classification: \`${approval.classification}\``,
    `- Destination: \`${approval.destination}\``,
    `- Source: ${sourceLink(sourcePath)}`,
    "",
  ].join("\n");
  const pattern = /^## Knowledge Decision\s*\n[\s\S]*?(?=^##\s|\s*$)/m;
  content = pattern.test(content)
    ? content.replace(pattern, section)
    : `${content.trimEnd()}\n\n${section}`;
  writeAtomic(taskPath, content);
}

function updateIndex(vaultRoot, relativeTarget, proposal) {
  const indexPath = path.join(vaultRoot, "index.md");
  let content = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "# Wiki Index\n";
  const target = relativeTarget.replace(/\.md$/, "");
  if (content.includes(`[[${target}|`)) return;
  const heading = "## Orchestrator Knowledge Promotions";
  const entry = `- [[${target}|${proposal.title}]]: ${proposal.summary}`;
  content = content.includes(heading)
    ? `${content.trimEnd()}\n${entry}\n`
    : `${content.trimEnd()}\n\n${heading}\n\n${entry}\n`;
  writeAtomic(indexPath, content);
}

function appendWikiLog(vaultRoot, manifest, detail, event = "knowledge-sync") {
  const logPath = path.join(vaultRoot, "wiki-log.md");
  let content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Wiki Log\n";
  const marker = `run_id: ${manifest.runId} | ${event}`;
  if (content.includes(marker)) return;
  content = `${content.trimEnd()}\n\n## [${new Date().toISOString().slice(0, 10)}] ${event} | ${manifest.task.title}\n- ${marker}\n- ${detail}\n`;
  writeAtomic(logPath, content);
}

function resolveCandidatePath(vaultRoot, selector) {
  const candidateRoot = path.join(vaultRoot, "05-Knowledge-Candidates");
  let relative = String(selector ?? "").trim().replaceAll("\\", "/");
  if (!relative) throw new Error("Candidate knowledge harus ditentukan.");
  relative = relative.replace(/^05-Knowledge-Candidates\//, "");
  if (!relative.endsWith(".md")) relative = `${relative}.md`;
  const absolute = ensureInside(candidateRoot, path.join(candidateRoot, relative));
  if (!fs.existsSync(absolute)) throw new Error(`Knowledge candidate tidak ditemukan: ${selector}`);
  if (path.basename(absolute).startsWith("_Template")) throw new Error("Template candidate tidak dapat dipromosikan atau ditolak.");
  return {
    absolute,
    relative: path.relative(vaultRoot, absolute).split(path.sep).join("/"),
    slug: path.basename(absolute, ".md"),
  };
}

function loadCandidate(vaultRoot, selector) {
  const candidate = resolveCandidatePath(vaultRoot, selector);
  const content = fs.readFileSync(candidate.absolute, "utf8");
  if (String(frontmatterValue(content, "type")).toLowerCase() !== "candidate") {
    throw new Error(`File bukan knowledge candidate: ${candidate.relative}`);
  }
  const runId = frontmatterValue(content, "orchestrator_run");
  const sourcePath = runId
    ? path.join("03-Sources", "other", "orchestrator-runs", `${runId}.json`).split(path.sep).join("/")
    : null;
  const sourceAbsolute = sourcePath ? path.join(vaultRoot, sourcePath) : null;
  let source = null;
  if (sourceAbsolute && fs.existsSync(sourceAbsolute)) {
    source = JSON.parse(fs.readFileSync(sourceAbsolute, "utf8"));
  }
  return {
    ...candidate,
    content,
    title: frontmatterValue(content, "title") ?? candidate.slug,
    runId,
    sourcePath,
    source,
  };
}

function removeIndexEntry(vaultRoot, relativePath) {
  const indexPath = path.join(vaultRoot, "index.md");
  if (!fs.existsSync(indexPath)) return;
  const target = relativePath.replace(/\.md$/, "");
  const content = fs.readFileSync(indexPath, "utf8");
  const updated = content
    .split(/\r?\n/)
    .filter((line) => !line.includes(`[[${target}|`) && !line.includes(`[[${target}]]`))
    .join("\n");
  if (updated !== content) writeAtomic(indexPath, `${updated.trimEnd()}\n`);
}

function writeCandidateDecisionArtifact(vaultRoot, decision) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const relative = path.join(
    "03-Sources",
    "other",
    "knowledge-decisions",
    `${slugify(decision.title)}-${timestamp}-${randomUUID().slice(0, 8)}.json`,
  ).split(path.sep).join("/");
  const absolute = ensureInside(vaultRoot, path.join(vaultRoot, relative));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify({
    schemaVersion: 1,
    immutable: true,
    ...decision,
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return relative;
}

function appendCandidateDecisionLog(vaultRoot, { candidate, action, by, targetPath = null, reason = null, auditPath }) {
  const logPath = path.join(vaultRoot, "wiki-log.md");
  let content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "# Wiki Log\n";
  const marker = `candidate: ${candidate.relative} | ${action}`;
  if (content.includes(marker)) return;
  const detail = targetPath
    ? `- Target Wiki: \`${targetPath}\`.`
    : `- Reason: ${reason || "Tidak ada alasan tambahan."}`;
  content = `${content.trimEnd()}\n\n## [${new Date().toISOString().slice(0, 10)}] ${action} | ${candidate.title}\n- ${marker}\n- Approved by: \`${by}\`.\n${detail}\n- Audit: [[${auditPath}]]\n`;
  writeAtomic(logPath, content);
}

export function listKnowledgeCandidates({ vaultRoot }) {
  const root = path.join(vaultRoot, "05-Knowledge-Candidates");
  const candidates = markdownFiles(root)
    .filter((filePath) => !path.basename(filePath).startsWith("_Template"))
    .map((filePath) => {
      const relative = path.relative(vaultRoot, filePath).split(path.sep).join("/");
      const loaded = loadCandidate(vaultRoot, relative);
      const proposal = loaded.source?.proposal ? normalizeProposal(loaded.source.proposal) : null;
      return {
        id: loaded.slug,
        title: loaded.title,
        path: loaded.relative,
        confidence: proposal?.confidence ?? null,
        recommendedTarget: proposal?.targetPath ?? (proposal ? defaultWikiTarget(proposal) : null),
        runId: loaded.runId,
      };
    });
  return { schemaVersion: 1, mode: "read-only", count: candidates.length, candidates };
}

export function promoteKnowledgeCandidate({
  vaultRoot,
  selector,
  approvedBy = "user",
  targetPath = null,
}) {
  const candidate = loadCandidate(vaultRoot, selector);
  if (!candidate.source?.proposal || !candidate.runId || !candidate.sourcePath) {
    throw new Error("Candidate tidak memiliki immutable orchestrator source yang dapat diverifikasi.");
  }
  const proposal = normalizeProposal(candidate.source.proposal);
  const requestedTarget = targetPath ?? proposal.targetPath ?? defaultWikiTarget(proposal);
  if (!validRelativeWikiTarget(requestedTarget)) {
    throw new Error(`Target promosi harus berada di 01-Knowledge dan berformat Markdown: ${requestedTarget}`);
  }

  const titleDuplicate = findTitleMatch(path.join(vaultRoot, "01-Knowledge"), proposal.title);
  const requestedAbsolute = ensureInside(
    path.join(vaultRoot, "01-Knowledge"),
    path.join(vaultRoot, requestedTarget),
  );
  const similarKnowledge = findSimilarKnowledge({
    vaultRoot,
    title: proposal.title,
    body: [proposal.summary, proposal.rationale, ...proposal.considerations].join("\n"),
  });
  const nearDuplicate = similarKnowledge.find((match) => !match.exactTitle) ?? null;
  const explicitExistingTarget = Boolean(
    targetPath
    && nearDuplicate
    && fs.existsSync(requestedAbsolute)
    && path.resolve(requestedAbsolute) === path.resolve(vaultRoot, nearDuplicate.path),
  );
  if (!titleDuplicate && nearDuplicate && !explicitExistingTarget) {
    throw new Error(
      `Candidate mirip dengan ${nearDuplicate.path} (score ${nearDuplicate.score}). `
      + `Review lebih dulu lalu gunakan --target ${nearDuplicate.path} untuk UPDATE jika topiknya sama.`,
    );
  }
  const targetAbsolute = titleDuplicate ?? requestedAbsolute;
  const targetRelative = path.relative(vaultRoot, targetAbsolute).split(path.sep).join("/");
  const existed = fs.existsSync(targetAbsolute);
  const manifest = {
    runId: candidate.runId,
    task: candidate.source.task ?? { id: "CANDIDATE", title: candidate.title },
  };

  if (existed) {
    const existing = fs.readFileSync(targetAbsolute, "utf8");
    writeAtomic(targetAbsolute, updateExistingKnowledge(existing, manifest, proposal, candidate.sourcePath));
  } else {
    writeAtomic(targetAbsolute, newKnowledgePage({
      vaultRoot,
      manifest,
      proposal,
      type: proposal.type,
      sourcePath: candidate.sourcePath,
    }));
  }
  removeIndexEntry(vaultRoot, candidate.relative);
  updateIndex(vaultRoot, targetRelative, proposal);

  const by = String(approvedBy).trim() || "user";
  const promotedAt = new Date().toISOString();
  const auditPath = writeCandidateDecisionArtifact(vaultRoot, {
    action: "PROMOTE",
    decidedAt: promotedAt,
    decidedBy: by,
    title: candidate.title,
    candidatePath: candidate.relative,
    targetPath: targetRelative,
    sourcePath: candidate.sourcePath,
    runId: candidate.runId,
    mergedIntoExisting: existed,
  });
  appendCandidateDecisionLog(vaultRoot, {
    candidate,
    action: "knowledge-promotion",
    by,
    targetPath: targetRelative,
    auditPath,
  });
  fs.unlinkSync(candidate.absolute);
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_PROMOTED",
    candidate: { id: candidate.slug, path: candidate.relative, removed: true },
    target: { path: targetRelative, mode: existed ? "UPDATE" : "CREATE" },
    approval: { approvedBy: by, approvedAt: promotedAt },
    quality: { similarKnowledge, explicitExistingTarget },
    auditPath,
  };
}

export function rejectKnowledgeCandidate({
  vaultRoot,
  selector,
  rejectedBy = "user",
  reason = "Knowledge belum layak dipromosikan.",
}) {
  const candidate = loadCandidate(vaultRoot, selector);
  const by = String(rejectedBy).trim() || "user";
  const rejectionReason = String(reason).trim() || "Knowledge belum layak dipromosikan.";
  const rejectedAt = new Date().toISOString();
  const stamp = rejectedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const archiveRelative = path.join(
    "03-Sources",
    "other",
    "rejected-knowledge-candidates",
    `${candidate.slug}-${stamp}-${randomUUID().slice(0, 8)}.md`,
  ).split(path.sep).join("/");
  const archiveAbsolute = ensureInside(vaultRoot, path.join(vaultRoot, archiveRelative));
  fs.mkdirSync(path.dirname(archiveAbsolute), { recursive: true });
  fs.writeFileSync(
    archiveAbsolute,
    `${candidate.content.trimEnd()}\n\n## Rejection Decision\n\n- Rejected at: ${rejectedAt}\n- Rejected by: ${by}\n- Reason: ${rejectionReason}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const auditPath = writeCandidateDecisionArtifact(vaultRoot, {
    action: "REJECT",
    decidedAt: rejectedAt,
    decidedBy: by,
    title: candidate.title,
    candidatePath: candidate.relative,
    archivedPath: archiveRelative,
    reason: rejectionReason,
    runId: candidate.runId,
  });
  removeIndexEntry(vaultRoot, candidate.relative);
  appendCandidateDecisionLog(vaultRoot, {
    candidate,
    action: "knowledge-rejection",
    by,
    reason: rejectionReason,
    auditPath,
  });
  fs.unlinkSync(candidate.absolute);
  return {
    schemaVersion: 1,
    action: "KNOWLEDGE_REJECTED",
    candidate: { id: candidate.slug, path: candidate.relative, removed: true },
    archivePath: archiveRelative,
    rejection: { rejectedBy: by, rejectedAt, reason: rejectionReason },
    auditPath,
  };
}

function resolveSyncTarget(vaultRoot, manifest) {
  const proposal = manifest.knowledge.proposal;
  const approval = manifest.knowledge.approval;
  if (approval.destination === "PROJECT" || approval.destination === "NONE") return null;

  if (approval.classification === "UPDATE") {
    if (!approval.targetPath) throw new Error("UPDATE membutuhkan targetPath existing Wiki page.");
    const target = ensureInside(path.join(vaultRoot, "01-Knowledge"), path.join(vaultRoot, approval.targetPath));
    if (!fs.existsSync(target)) throw new Error(`Target UPDATE tidak ditemukan: ${approval.targetPath}`);
    return { absolute: target, relative: path.relative(vaultRoot, target), type: proposal.type, existing: true };
  }

  const defaultRelative = approval.destination === "CANDIDATE"
    ? path.join("05-Knowledge-Candidates", `${slugify(proposal.title)}.md`)
    : path.join("01-Knowledge", TYPE_FOLDERS[proposal.type], `${slugify(proposal.title)}.md`);
  const requested = approval.targetPath || defaultRelative;
  const allowedRoot = approval.destination === "CANDIDATE"
    ? path.join(vaultRoot, "05-Knowledge-Candidates")
    : path.join(vaultRoot, "01-Knowledge");
  const target = ensureInside(allowedRoot, path.join(vaultRoot, requested));
  return {
    absolute: target,
    relative: path.relative(vaultRoot, target),
    type: approval.destination === "CANDIDATE" ? "candidate" : proposal.type,
    existing: fs.existsSync(target),
  };
}

export function syncWikiRun({ vaultRoot, runsRoot, runId }) {
  const manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.WIKI_SYNCED) return manifest;
  if (manifest.state !== RUN_STATES.KNOWLEDGE_APPROVAL) {
    throw new Error(`Run ${runId} harus KNOWLEDGE_APPROVAL sebelum Wiki sync; state ${manifest.state}.`);
  }

  const proposal = manifest.knowledge.proposal;
  const approval = manifest.knowledge.approval;
  const sourcePath = sourceArtifact(vaultRoot, manifest);
  const target = resolveSyncTarget(vaultRoot, manifest);
  const taskPath = path.join(vaultRoot, manifest.task.path);
  updateTaskKnowledgeDecision(taskPath, manifest, sourcePath);
  let detail;

  if (approval.destination === "NONE") {
    detail = `Knowledge decision ${approval.classification}; tidak ada Wiki page yang dibuat.`;
  } else if (approval.destination === "PROJECT") {
    appendProjectRetrospective(taskPath, manifest, proposal, sourcePath);
    detail = `Knowledge dicatat sebagai PROJECT_ONLY pada ${manifest.task.path}.`;
  } else if (approval.classification === "UPDATE") {
    const content = fs.readFileSync(target.absolute, "utf8");
    writeAtomic(target.absolute, updateExistingKnowledge(content, manifest, proposal, sourcePath));
    detail = `Knowledge page diperbarui: ${target.relative}.`;
  } else {
    if (target.existing) {
      const existing = fs.readFileSync(target.absolute, "utf8");
      if (approval.destination === "CANDIDATE" && !existing.includes(`orchestrator_run: ${manifest.runId}`)) {
        writeAtomic(target.absolute, updateExistingKnowledge(existing, manifest, proposal, sourcePath));
        updateIndex(vaultRoot, target.relative, proposal);
        detail = `Knowledge candidate diperbarui: ${target.relative}.`;
      } else if (!existing.includes(`orchestrator_run: ${manifest.runId}`)) {
        throw new Error(`Target NEW sudah ada; gunakan UPDATE: ${target.relative}`);
      }
    } else {
      writeAtomic(target.absolute, newKnowledgePage({ vaultRoot, manifest, proposal, type: target.type, sourcePath }));
      updateIndex(vaultRoot, target.relative, proposal);
    }
    detail ??= `Knowledge page dibuat: ${target.relative}.`;
  }

  appendWikiLog(vaultRoot, manifest, detail);
  return transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.WIKI_SYNCED,
    knowledgePatch: {
      sync: {
        syncedAt: new Date().toISOString(),
        destination: approval.destination,
        sourcePath,
        targetPath: target?.relative ?? null,
      },
    },
    message: detail,
  });
}

async function applyWorkspaceForAcceptance({ vaultRoot, runsRoot, runId }) {
  let manifest = getRun(runsRoot, runId);
  const workspace = manifest.execution?.workspace;
  if (!workspace || ["APPLIED", "CLEANED"].includes(workspace.state)) return manifest;
  const eventLogPath = path.join(runsRoot, "events", `${runId}.jsonl`);
  try {
    const result = await applyIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
    });
    if (result.workspace) {
      manifest = updateRunExecution({
        runsRoot,
        runId,
        executionPatch: { workspace: result.workspace },
        event: "WORKSPACE_APPLIED",
        message: `Isolated workspace diterapkan ke repository utama (${result.workspace.appliedPaths.length} path).`,
      });
    }
    return manifest;
  } catch (error) {
    manifest = getRun(runsRoot, runId);
    if ([RUN_STATES.REVIEW, RUN_STATES.RETROSPECTIVE].includes(manifest.state)) {
      transitionRun({
        vaultRoot,
        runsRoot,
        runId,
        toState: RUN_STATES.FAILED,
        executionPatch: {
          result: { status: "FAILED", error: `Workspace apply gagal: ${error.message}` },
          workspace: {
            ...manifest.execution.workspace,
            state: "APPLY_FAILED",
            applyError: error.message,
          },
        },
        message: `isolated workspace gagal diterapkan: ${error.message}`,
      });
    } else {
      updateRunExecution({
        runsRoot,
        runId,
        executionPatch: {
          workspace: {
            ...manifest.execution.workspace,
            state: "APPLY_FAILED",
            applyError: error.message,
          },
        },
        event: "WORKSPACE_APPLY_FAILED",
        message: error.message,
      });
    }
    throw error;
  }
}

async function cleanupWorkspaceAfterCompletion({ runsRoot, manifest }) {
  const workspace = manifest.execution?.workspace;
  if (!workspace || ["CLEANED", "DISCARDED"].includes(workspace.state)) return manifest;
  const eventLogPath = path.join(runsRoot, "events", `${manifest.runId}.jsonl`);
  try {
    const result = await cleanupIsolatedWorkspace({
      manifest,
      runsRoot,
      eventLogPath,
      processRunner: runProcess,
      outcome: "CLEANED",
    });
    if (!result.workspace) return manifest;
    return updateRunExecution({
      runsRoot,
      runId: manifest.runId,
      executionPatch: { workspace: result.workspace },
      event: "WORKSPACE_CLEANED",
      message: "Isolated workspace sudah diarsipkan dan dibersihkan.",
    });
  } catch (error) {
    return updateRunExecution({
      runsRoot,
      runId: manifest.runId,
      executionPatch: {
        workspace: {
          ...workspace,
          state: "CLEANUP_FAILED",
          cleanupError: error.message,
        },
      },
      event: "WORKSPACE_CLEANUP_FAILED",
      message: error.message,
    });
  }
}

async function finalizeCompletionNotifications({ runsRoot, manifest }) {
  if (manifest.knowledge?.approval?.destination !== "CANDIDATE") return manifest;
  try {
    const emitted = await notifyKnowledgeCandidateReady({ runsRoot, manifest });
    return updateRunExecution({
      runsRoot,
      runId: manifest.runId,
      executionPatch: {
        notification: {
          notificationId: emitted.notification?.notificationId ?? null,
          type: "KNOWLEDGE_CANDIDATE_READY",
          delivery: emitted.notification?.delivery ?? null,
        },
      },
      event: "KNOWLEDGE_CANDIDATE_NOTIFICATION",
      message: emitted.created ? "Knowledge Candidate notification dibuat." : "Knowledge Candidate notification sudah ada.",
    });
  } catch (error) {
    return updateRunExecution({
      runsRoot,
      runId: manifest.runId,
      executionPatch: {
        notification: { type: "KNOWLEDGE_CANDIDATE_READY", status: "FAILED", error: error.message },
      },
      event: "KNOWLEDGE_CANDIDATE_NOTIFICATION_FAILED",
      message: error.message,
    });
  }
}

export async function completeRun({ vaultRoot, runsRoot, runId, completedBy = "user" }) {
  let manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.DONE) {
    manifest = await cleanupWorkspaceAfterCompletion({ runsRoot, manifest });
    return finalizeCompletionNotifications({ runsRoot, manifest });
  }
  if (manifest.state !== RUN_STATES.WIKI_SYNCED) {
    throw new Error(`Run ${runId} harus WIKI_SYNCED sebelum DONE; state ${manifest.state}.`);
  }
  manifest = await applyWorkspaceForAcceptance({ vaultRoot, runsRoot, runId });
  const completed = transitionRun({
    vaultRoot,
    runsRoot,
    runId,
    toState: RUN_STATES.DONE,
    executionPatch: {
      result: {
        ...(manifest.execution.result ?? {}),
        knowledgeDecision: manifest.knowledge.approval.classification,
      },
    },
    completionPatch: {
      completedAt: new Date().toISOString(),
      completedBy: String(completedBy).trim() || "user",
      humanApproved: true,
    },
    message: "human approval, verification, dan knowledge decision lengkap; task ditutup sebagai DONE.",
  });
  appendWikiLog(vaultRoot, completed, "Task dan run selesai dengan human approval.", "task-completion");
  manifest = await cleanupWorkspaceAfterCompletion({ runsRoot, manifest: completed });
  return finalizeCompletionNotifications({ runsRoot, manifest });
}

export async function acceptRun({
  vaultRoot,
  runsRoot,
  runId,
  approvedBy = "user",
  decision = null,
  destination = null,
  targetPath = null,
  proposalGenerator = generateProposalWithAgy,
}) {
  let manifest = getRun(runsRoot, runId);
  if (manifest.state === RUN_STATES.DONE) {
    return cleanupWorkspaceAfterCompletion({ runsRoot, manifest });
  }

  if (manifest.state === RUN_STATES.REVIEW) {
    manifest = await retrospectRun({ vaultRoot, runsRoot, runId, proposalGenerator });
  }
  if (manifest.state === RUN_STATES.RETROSPECTIVE) {
    manifest = await applyWorkspaceForAcceptance({ vaultRoot, runsRoot, runId });
    manifest = approveKnowledgeRun({
      vaultRoot,
      runsRoot,
      runId,
      approvedBy,
      decision,
      destination,
      targetPath,
    });
  }
  if (manifest.state === RUN_STATES.KNOWLEDGE_APPROVAL) {
    manifest = syncWikiRun({ vaultRoot, runsRoot, runId });
  }
  if (manifest.state === RUN_STATES.WIKI_SYNCED) {
    manifest = await completeRun({ vaultRoot, runsRoot, runId, completedBy: approvedBy });
  }

  if (manifest.state !== RUN_STATES.DONE) {
    throw new Error(`accept hanya dapat melanjutkan run REVIEW sampai DONE; state saat ini ${manifest.state}.`);
  }
  return manifest;
}
