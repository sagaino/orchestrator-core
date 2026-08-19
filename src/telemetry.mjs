import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRun, listRuns, updateRunExecution } from "./run-manager.mjs";

const DEFAULT_TOKEN_WARNING_THRESHOLD = 250_000;
const MAX_TOKEN_WARNING_THRESHOLD = 100_000_000;

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function rounded(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(nonNegativeNumber(value) * factor) / factor;
}

function safeTelemetryId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`Telemetry ID tidak valid: ${value}`);
  return normalized;
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function intakeTelemetryRoot(runsRoot) {
  return path.join(runsRoot, "telemetry", "intakes");
}

function intakeTelemetryPath(runsRoot, intakeId) {
  return path.join(intakeTelemetryRoot(runsRoot), `${safeTelemetryId(intakeId)}.json`);
}

function parseJsonLines(output) {
  return String(output ?? "").split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function finalAgentPayload(result) {
  if (result?.finalResult && typeof result.finalResult === "object") return result.finalResult;
  const candidates = parseJsonLines(result?.stdoutTail).reverse();
  for (const candidate of candidates) {
    if (candidate?.event === "result" && candidate.result) return candidate.result;
    if (candidate?.usage || candidate?.duration_seconds !== undefined) return candidate;
  }
  return null;
}

function normalizedUsage(payload) {
  const raw = payload?.usage;
  if (!raw || typeof raw !== "object") return null;
  const inputTokens = nonNegativeNumber(raw.input_tokens ?? raw.inputTokens);
  const outputTokens = nonNegativeNumber(raw.output_tokens ?? raw.outputTokens);
  const thinkingTokens = nonNegativeNumber(raw.thinking_tokens ?? raw.thinkingTokens);
  const cacheReadTokens = nonNegativeNumber(raw.cache_read_tokens ?? raw.cacheReadTokens);
  const totalTokens = nonNegativeNumber(raw.total_tokens ?? raw.totalTokens) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    totalTokens,
    contextTokens: inputTokens + cacheReadTokens,
  };
}

function recordIdFor({ stage, conversationId, invocationId, usage, durationSeconds }) {
  const identity = invocationId
    ? `${conversationId ?? "no-conversation"}:${invocationId}`
    : conversationId || JSON.stringify({ stage, usage, durationSeconds });
  return createHash("sha256").update(`${stage}:${identity}`).digest("hex").slice(0, 24);
}

export function configuredTokenWarningThreshold(env = process.env) {
  const raw = env.ORCHESTRATOR_TOKEN_WARNING_THRESHOLD;
  if (raw === undefined || raw === "") return DEFAULT_TOKEN_WARNING_THRESHOLD;
  const threshold = Number(raw);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > MAX_TOKEN_WARNING_THRESHOLD) {
    throw new Error(`ORCHESTRATOR_TOKEN_WARNING_THRESHOLD harus integer 0-${MAX_TOKEN_WARNING_THRESHOLD}.`);
  }
  return threshold;
}

export function normalizeTelemetryStage(stage) {
  const value = String(stage ?? "").trim();
  if (value === "task-intake-planner" || value === "TASK_INTAKE") return "TASK_INTAKE";
  if (value === "coding-agent" || value === "IMPLEMENTATION") return "IMPLEMENTATION";
  if (value.startsWith("automatic-recovery-agent:") || value === "AUTOMATIC_RECOVERY") return "AUTOMATIC_RECOVERY";
  if (value === "retrospective" || value === "RETROSPECTIVE") return "RETROSPECTIVE";
  if (value === "knowledge-harvest" || value === "KNOWLEDGE_HARVEST") return "KNOWLEDGE_HARVEST";
  if (value === "knowledge-ingest" || value === "KNOWLEDGE_INGEST") return "KNOWLEDGE_INGEST";
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_") || "UNKNOWN";
}

export function createAgentTelemetryRecord({
  stage,
  result,
  agentConfig = null,
  invocationId = null,
  metadata = {},
  recordedAt = new Date().toISOString(),
  source = "explicit",
}) {
  const normalizedStage = normalizeTelemetryStage(stage);
  const payload = finalAgentPayload(result);
  const usage = normalizedUsage(payload);
  const durationSeconds = rounded(payload?.duration_seconds ?? payload?.durationSeconds);
  const conversationId = payload?.conversation_id ?? payload?.conversationId ?? null;
  const status = String(payload?.status ?? (result?.exitCode === 0 ? "SUCCESS" : "FAILED")).toUpperCase();
  return {
    schemaVersion: 1,
    recordId: recordIdFor({ stage: normalizedStage, conversationId, invocationId, usage, durationSeconds }),
    source,
    stage: normalizedStage,
    provider: "ANTIGRAVITY",
    model: agentConfig?.model ?? null,
    effort: agentConfig?.effort ?? null,
    status,
    conversationId,
    durationSeconds,
    usage,
    measured: Boolean(usage),
    recordedAt,
    metadata,
  };
}

function stageAggregate(records) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
  };
  let durationSeconds = 0;
  let measuredCalls = 0;
  for (const record of records) {
    durationSeconds += nonNegativeNumber(record.durationSeconds);
    if (record.usage) {
      measuredCalls += 1;
      for (const key of Object.keys(usage)) usage[key] += nonNegativeNumber(record.usage[key]);
    }
  }
  return {
    calls: records.length,
    measuredCalls,
    unmeasuredCalls: records.length - measuredCalls,
    durationSeconds: rounded(durationSeconds),
    usage,
  };
}

export function buildTelemetry(records = [], { threshold = configuredTokenWarningThreshold() } = {}) {
  const unique = new Map();
  for (const record of records.filter(Boolean)) unique.set(record.recordId, record);
  const normalizedRecords = [...unique.values()].sort((left, right) => (
    String(left.recordedAt).localeCompare(String(right.recordedAt))
  ));
  const byStage = {};
  for (const stage of [...new Set(normalizedRecords.map((record) => record.stage))]) {
    byStage[stage] = stageAggregate(normalizedRecords.filter((record) => record.stage === stage));
  }
  const totals = stageAggregate(normalizedRecords);
  const enabled = threshold > 0;
  const exceeded = enabled && totals.usage.totalTokens >= threshold;
  const warnings = exceeded
    ? [{
        id: "TOKEN_WARNING_THRESHOLD",
        severity: "WARNING",
        thresholdTokens: threshold,
        observedTokens: totals.usage.totalTokens,
        message: `Penggunaan AI mencapai ${totals.usage.totalTokens} token dan melewati warning threshold ${threshold}.`,
      }]
    : [];
  return {
    schemaVersion: 1,
    records: normalizedRecords,
    summary: {
      ...totals,
      usageCoveragePercent: totals.calls ? rounded((totals.measuredCalls / totals.calls) * 100, 1) : 0,
      byStage,
    },
    budget: {
      mode: "WARNING_ONLY",
      thresholdTokens: threshold,
      enabled,
      exceeded,
      warnings,
      guardrail: "Telemetry tidak menghentikan task atau mengubah approval state.",
    },
    updatedAt: new Date().toISOString(),
  };
}

export function appendRunTelemetry({ runsRoot, runId, record, env = process.env }) {
  if (!record) return getRun(runsRoot, runId);
  const manifest = getRun(runsRoot, runId);
  const existing = manifest.telemetry?.records ?? manifest.execution?.telemetry?.records ?? [];
  if (existing.some((r) => r.recordId === record.recordId)) {
    return { deduplicated: true, existingRecordId: record.recordId };
  }
  const currentRecords = manifest.execution?.telemetry?.records ?? [];
  const telemetry = buildTelemetry([...currentRecords, record], {
    threshold: configuredTokenWarningThreshold(env),
  });
  return updateRunExecution({
    runsRoot,
    runId,
    executionPatch: { telemetry },
    event: "AI_TELEMETRY_RECORDED",
    message: `${record.stage} mencatat ${record.usage?.totalTokens ?? "unknown"} token.`,
  });
}

export function persistIntakeTelemetry({ runsRoot, intakeId, record, task = null, project = null }) {
  const filePath = intakeTelemetryPath(runsRoot, intakeId);
  const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
  const value = {
    schemaVersion: 1,
    intakeId,
    record: {
      ...(existing?.record ?? {}),
      ...record,
      metadata: {
        ...(existing?.record?.metadata ?? {}),
        ...(record?.metadata ?? {}),
        ...(task ? { taskId: task.id, taskPath: task.path } : {}),
        ...(project ? { projectId: project.id ?? project } : {}),
      },
    },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeAtomic(filePath, value);
  return value;
}

export function listIntakeTelemetry(runsRoot) {
  const root = intakeTelemetryRoot(runsRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function knowledgeTelemetryRoot(runsRoot) {
  return path.join(runsRoot, "telemetry", "knowledge");
}

function knowledgeTelemetryPath(runsRoot, id) {
  return path.join(knowledgeTelemetryRoot(runsRoot), `${safeTelemetryId(id)}.json`);
}

export function persistKnowledgeTelemetry({ runsRoot, id, record, metadata = {} }) {
  const filePath = knowledgeTelemetryPath(runsRoot, id);
  const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
  const value = {
    schemaVersion: 1,
    id,
    record: {
      ...(existing?.record ?? {}),
      ...record,
      metadata: {
        ...(existing?.record?.metadata ?? {}),
        ...(record?.metadata ?? {}),
        ...metadata,
      },
    },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeAtomic(filePath, value);
  return value;
}

export function listKnowledgeTelemetry(runsRoot) {
  const root = knowledgeTelemetryRoot(runsRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function inferredIntakeTelemetry(runsRoot) {
  const root = path.join(runsRoot, "intake");
  if (!fs.existsSync(root)) return [];
  const records = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const intakeId = entry.name.replace(/\.jsonl$/, "");
    let projectId = null;
    for (const line of fs.readFileSync(path.join(root, entry.name), "utf8").split("\n").filter(Boolean)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event === "PROCESS_STARTED" && event.stage === "task-intake-planner") {
        const prompt = Array.isArray(event.args) ? String(event.args[event.args.indexOf("-p") + 1] ?? "") : "";
        projectId = prompt.match(/^Project:\s*(.+)$/m)?.[1]?.trim() ?? projectId;
      }
      if (event.event !== "PROCESS_OUTPUT" || event.stage !== "task-intake-planner") continue;
      const payload = event.payload?.event === "result" ? event.payload.result : event.payload;
      if (!payload?.usage || !payload?.conversation_id) continue;
      records.push(createAgentTelemetryRecord({
        stage: "TASK_INTAKE",
        result: { exitCode: payload.status === "SUCCESS" ? 0 : 1, finalResult: payload },
        invocationId: intakeId,
        metadata: { intakeId, projectId, inferred: true },
        recordedAt: event.at,
        source: "inferred",
      }));
    }
  }
  return records;
}

function inferredKnowledgeTelemetry(runsRoot) {
  const root = path.join(runsRoot, "events");
  if (!fs.existsSync(root)) return [];
  const records = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    if (!entry.name.startsWith("harvest-") && !entry.name.startsWith("ingest-")) continue;

    const id = entry.name.replace(/\.jsonl$/, "");
    const isHarvest = entry.name.startsWith("harvest-");
    const stage = isHarvest ? "KNOWLEDGE_HARVEST" : "KNOWLEDGE_INGEST";

    for (const line of fs.readFileSync(path.join(root, entry.name), "utf8").split("\n").filter(Boolean)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.event !== "PROCESS_OUTPUT" || !event.payload) continue;
      const payload = event.payload?.event === "result" ? event.payload.result : event.payload;
      if (!payload?.usage || !payload?.conversation_id) continue;
      records.push(createAgentTelemetryRecord({
        stage,
        result: { exitCode: payload.status === "SUCCESS" ? 0 : 1, finalResult: payload },
        invocationId: id,
        metadata: { id, inferred: true, type: isHarvest ? "codebase-harvest" : "raw-ingest" },
        recordedAt: event.at,
        source: "inferred",
      }));
    }
  }
  return records;
}

function agentConfigFromArguments(args = []) {
  if (!Array.isArray(args)) return null;
  const modelIndex = args.indexOf("--model");
  const effortIndex = args.indexOf("--effort");
  const model = modelIndex >= 0 ? args[modelIndex + 1] : null;
  const effort = effortIndex >= 0 ? args[effortIndex + 1] : null;
  return model || effort ? { model: model ?? null, effort: effort ?? null } : null;
}

function agentConfigForStage(run, processStage, index = null) {
  if (processStage === "coding-agent") return run.execution?.agent?.configuration ?? null;
  if (processStage === "retrospective") return run.knowledge?.retrospectiveAgent ?? null;
  if (processStage.startsWith("automatic-recovery-agent:")) {
    const attempt = Number(processStage.split(":")[1] ?? index);
    return run.execution?.automaticRecovery?.attempts?.find((item) => item.attempt === attempt)?.agent?.configuration ?? null;
  }
  return null;
}

function recordsFromEventLog(runsRoot, run) {
  const eventPath = path.join(runsRoot, run.execution?.eventLog ?? path.join("events", `${run.runId}.jsonl`));
  if (!fs.existsSync(eventPath)) return [];
  const records = [];
  const configs = new Map();
  for (const line of fs.readFileSync(eventPath, "utf8").split("\n").filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.event === "PROCESS_STARTED") {
      const config = agentConfigFromArguments(event.args);
      if (config) configs.set(String(event.stage), config);
      continue;
    }
    if (event.event !== "PROCESS_OUTPUT" || !event.payload) continue;
    const payload = event.payload?.event === "result" ? event.payload.result : event.payload;
    if (!payload?.usage || !payload?.conversation_id) continue;
    const processStage = String(event.stage ?? "");
    if (!["coding-agent", "retrospective"].includes(processStage)
      && !processStage.startsWith("automatic-recovery-agent:")) continue;
    records.push(createAgentTelemetryRecord({
      stage: processStage,
      result: { exitCode: payload.status === "SUCCESS" ? 0 : 1, finalResult: payload },
      agentConfig: agentConfigForStage(run, processStage) ?? configs.get(processStage) ?? null,
      invocationId: `${run.runId}:${processStage}`,
      metadata: { runId: run.runId, taskId: run.task?.id ?? null, projectId: run.project?.id ?? null, inferred: true },
      recordedAt: event.at,
      source: "inferred",
    }));
  }
  return records;
}

export function collectRunTelemetry({ runsRoot, run, env = process.env }) {
  const explicit = run.execution?.telemetry?.records ?? [];
  const inferred = recordsFromEventLog(runsRoot, run);
  const explicitIds = new Set(explicit.map((r) => r.recordId));
  let inferredSkipped = 0;
  const filteredInferred = [];
  for (const record of inferred) {
    if (explicitIds.has(record.recordId)) {
      inferredSkipped++;
    } else {
      filteredInferred.push(record);
    }
  }
  const telemetry = buildTelemetry([...filteredInferred, ...explicit], {
    threshold: run.execution?.telemetry?.budget?.thresholdTokens ?? configuredTokenWarningThreshold(env),
  });
  telemetry.summary.inferredSkipped = inferredSkipped;
  return telemetry;
}

export function compactTelemetry(telemetry) {
  if (!telemetry) return null;
  return {
    schemaVersion: telemetry.schemaVersion,
    summary: telemetry.summary,
    budget: telemetry.budget,
    updatedAt: telemetry.updatedAt,
  };
}

function matchesRun(run, selector, projectId) {
  if (projectId && run.project?.id !== projectId) return false;
  if (!selector) return true;
  const normalized = String(selector).toLowerCase();
  return String(run.runId).toLowerCase() === normalized
    || String(run.task?.id ?? "").toLowerCase() === normalized
    || String(run.task?.path ?? "").toLowerCase().includes(normalized);
}

export function telemetryReport({ runsRoot, selector = null, projectId = null, env = process.env }) {
  const runs = listRuns(runsRoot).filter((run) => matchesRun(run, selector, projectId));
  if (selector) {
    const run = runs[0];
    if (!run) throw new Error(`Telemetry run atau task tidak ditemukan: ${selector}`);
    const collectedTelemetry = collectRunTelemetry({ runsRoot, run, env });
    return {
      schemaVersion: 1,
      mode: "run-token-telemetry",
      generatedAt: new Date().toISOString(),
      run: { runId: run.runId, taskId: run.task?.id ?? null, projectId: run.project?.id ?? null, state: run.state },
      telemetry: collectedTelemetry,
      summary: {
        explicitRecords: collectedTelemetry.records.filter((r) => r.source === "explicit").length,
        inferredRecords: collectedTelemetry.records.filter((r) => r.source === "inferred").length,
        inferredSkippedByExplicit: collectedTelemetry.summary.inferredSkipped ?? 0,
      },
      cost: { status: "NOT_ESTIMATED", reason: "Pricing provider tidak tersedia pada result Antigravity." },
    };
  }

  const runReports = runs.map((run) => ({
    run,
    telemetry: collectRunTelemetry({ runsRoot, run, env }),
  }));
  const records = runReports.flatMap((item) => item.telemetry.records);
  for (const intake of listIntakeTelemetry(runsRoot)) {
    const recordProject = intake.record?.metadata?.projectId;
    if (!projectId || recordProject === projectId) records.push(intake.record);
  }
  for (const record of inferredIntakeTelemetry(runsRoot)) {
    if (!projectId || record.metadata?.projectId === projectId) records.push(record);
  }
  for (const knowledge of listKnowledgeTelemetry(runsRoot)) {
    const recordProject = knowledge.record?.metadata?.projectId;
    if (!projectId || recordProject === projectId) records.push(knowledge.record);
  }
  for (const record of inferredKnowledgeTelemetry(runsRoot)) {
    if (!projectId || record.metadata?.projectId === projectId) records.push(record);
  }
  const telemetry = buildTelemetry(records, { threshold: 0 });
  telemetry.budget = {
    mode: "AGGREGATE_REPORT_ONLY",
    thresholdTokens: null,
    enabled: false,
    exceeded: false,
    warnings: [],
    guardrail: "Warning threshold diterapkan per run; agregat global hanya untuk observasi.",
  };
  return {
    schemaVersion: 1,
    mode: "global-token-telemetry",
    generatedAt: new Date().toISOString(),
    projectId,
    runCount: runs.length,
    telemetry,
    summary: {
      explicitRecords: telemetry.records.filter((r) => r.source === "explicit").length,
      inferredRecords: telemetry.records.filter((r) => r.source === "inferred").length,
      inferredSkippedByExplicit: runReports.reduce((sum, { telemetry: t }) => sum + (t.summary.inferredSkipped ?? 0), 0),
    },
    latestRuns: runReports.slice(0, 10).map(({ run, telemetry: current }) => ({
      runId: run.runId,
      taskId: run.task?.id ?? null,
      projectId: run.project?.id ?? null,
      state: run.state,
      calls: current.summary.calls,
      totalTokens: current.summary.usage.totalTokens,
      durationSeconds: current.summary.durationSeconds,
      warning: current.budget.exceeded,
    })),
    cost: { status: "NOT_ESTIMATED", reason: "Pricing provider tidak tersedia pada result Antigravity." },
  };
}
