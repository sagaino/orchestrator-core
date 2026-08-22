import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { daemonStatus } from "./daemon.mjs";
import { listJobs, JOB_STATES } from "./job-queue.mjs";
import { listRuns } from "./run-manager.mjs";
import { verifyAuditChain } from "./audit-chain.mjs";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const RETENTION_ROOTS = ["workspace-artifacts", "workspace-backups"];
const PLAN_TTL_MS = 60 * 60 * 1000;
const ALERT_HISTORY_SCHEMA_VERSION = 2;
const DEFAULT_ALERT_DEDUPE_WINDOW_MINUTES = 60;
const DEFAULT_ALERT_SNOOZE_MAX_HOURS = 24 * 7;

const ALERT_RUNBOOKS = Object.freeze({
  OPS_DISK: { ownerRole: "operations", steps: ["Periksa free disk pada volume runtime.", "Buat retention preview.", "Pindahkan artefak ke trash hanya setelah konfirmasi operator."] },
  OPS_BACKUP: { ownerRole: "recovery-operator", steps: ["Jalankan dr-backup saat daemon quiescent.", "Verifikasi backup.", "Register backup terverifikasi sebelum admission dibuka."] },
  OPS_RUNTIME_STORAGE: { ownerRole: "operations", steps: ["Buat retention preview.", "Review kandidat dan ukuran artefak.", "Pulihkan dari trash bila perubahan tidak sesuai."] },
  OPS_ARTIFACT_GROWTH: { ownerRole: "operations", steps: ["Tinjau tren pertumbuhan artefak.", "Buat retention preview.", "Catat keputusan retensi."] },
  OPS_EVIDENCE_INTEGRITY: { ownerRole: "security-operator", steps: ["Hentikan eksekusi baru.", "Verifikasi audit chain.", "Ikuti evidence recovery runbook sebelum resume."] },
  OPS_QUEUE_AGE: { ownerRole: "operations", steps: ["Periksa blocker readiness.", "Tinjau worker dan job gagal.", "Dokumentasikan drain atau recovery action."] },
  OPS_DEADLINE_FAILURES: { ownerRole: "task-operator", steps: ["Tinjau run yang timeout.", "Periksa context/output limit.", "Jalankan retry hanya setelah evidence lengkap."] },
  OPS_PROVIDER_FAILURES: { ownerRole: "provider-operator", steps: ["Periksa provider/model error.", "Validasi rate limit dan routing.", "Catat evidence provider sebelum retry."] },
  OPS_DAEMON: { ownerRole: "runtime-operator", steps: ["Periksa heartbeat dan log daemon.", "Restart daemon melalui runbook.", "Verifikasi health sebelum resume."] },
});

function configuredInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} harus integer antara ${min} dan ${max}.`);
  }
  return value;
}

export function operationsConfig() {
  return {
    minFreeDiskBytes: configuredInteger("ORCHESTRATOR_MIN_FREE_DISK_MB", 1024, { min: 64, max: 1024 * 1024 }) * MiB,
    maxRuntimeBytes: configuredInteger("ORCHESTRATOR_MAX_RUNTIME_BYTES", 10 * GiB, { min: 100 * MiB }),
    maxArtifactBytes: configuredInteger("ORCHESTRATOR_MAX_ARTIFACT_BYTES", 2 * GiB, { min: 100 * MiB }),
    maxBackupAgeHours: configuredInteger("ORCHESTRATOR_MAX_BACKUP_AGE_HOURS", 24, { min: 1, max: 24 * 365 }),
    maxQueueAgeMinutes: configuredInteger("ORCHESTRATOR_MAX_QUEUE_AGE_MINUTES", 240, { min: 1, max: 60 * 24 * 365 }),
    signalWindowHours: configuredInteger("ORCHESTRATOR_SIGNAL_WINDOW_HOURS", 24, { min: 1, max: 24 * 365 }),
    alertTtlHours: configuredInteger("ORCHESTRATOR_ALERT_TTL_HOURS", 24, { min: 1, max: 24 * 365 }),
    alertDeduplicationWindowMinutes: configuredInteger("ORCHESTRATOR_ALERT_DEDUPE_WINDOW_MINUTES", DEFAULT_ALERT_DEDUPE_WINDOW_MINUTES, { min: 1, max: 24 * 365 * 60 }),
    alertSnoozeMaxHours: configuredInteger("ORCHESTRATOR_ALERT_SNOOZE_MAX_HOURS", DEFAULT_ALERT_SNOOZE_MAX_HOURS, { min: 1, max: 24 * 365 }),
  };
}

function runtimePath(runsRoot, ...parts) {
  return path.join(runsRoot, "runtime", "operations", ...parts);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function writePrivateJson(filePath, data) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function operationsAlertHistoryPath(runsRoot) { return runtimePath(runsRoot, "alert-acknowledgements.json"); }

function readAlertHistory(runsRoot) {
  const value = readJson(operationsAlertHistoryPath(runsRoot));
  if (![1, ALERT_HISTORY_SCHEMA_VERSION].includes(value?.schemaVersion) || !Array.isArray(value.entries)) return { schemaVersion: ALERT_HISTORY_SCHEMA_VERSION, entries: [] };
  return {
    schemaVersion: ALERT_HISTORY_SCHEMA_VERSION,
    entries: value.entries.map((entry) => ({
      ...entry,
      kind: entry.kind ?? "ACKNOWLEDGEMENT",
      owner: entry.owner ?? entry.acknowledgedBy ?? null,
      dedupeKey: entry.dedupeKey ?? entry.alertId ?? null,
    })),
  };
}

function alertRunbook(alertId, fallback = null) {
  return ALERT_RUNBOOKS[alertId] ?? { ownerRole: "operations", steps: fallback ? [fallback] : ["Tinjau alert dan ikuti runbook terkait."] };
}

function parseSnoozeUntil({ now, snoozeUntil = null, snoozeMinutes = null, maxHours = DEFAULT_ALERT_SNOOZE_MAX_HOURS } = {}) {
  if (snoozeUntil && Number.isFinite(Date.parse(String(snoozeUntil)))) {
    const value = new Date(String(snoozeUntil));
    if (value.getTime() <= now.getTime()) throw new Error("snoozeUntil harus berada di masa depan.");
    if (value.getTime() > now.getTime() + maxHours * 60 * 60 * 1000) throw new Error(`Snooze tidak boleh lebih dari ${maxHours} jam.`);
    return value.toISOString();
  }
  if (snoozeMinutes !== null && snoozeMinutes !== undefined) {
    const minutes = Number(snoozeMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxHours * 60) throw new Error(`snoozeMinutes harus integer 1-${maxHours * 60}.`);
    return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
  }
  return null;
}

export function acknowledgeOperationsAlert({ runsRoot, alertId, acknowledgedBy, owner = null, dedupeKey = null, now = new Date(), note = null, snoozeUntil = null, snoozeMinutes = null, config = operationsConfig() } = {}) {
  if (!String(alertId ?? "").trim() || !String(acknowledgedBy ?? "").trim()) throw new Error("Acknowledgement membutuhkan alertId dan operator teridentifikasi.");
  const history = readAlertHistory(runsRoot);
  const normalizedAlertId = String(alertId).trim();
  const normalizedDedupeKey = String(dedupeKey ?? normalizedAlertId).trim() || normalizedAlertId;
  const windowMs = config.alertDeduplicationWindowMinutes * 60 * 1000;
  const recent = [...history.entries].reverse().find((item) => item.kind === "ACKNOWLEDGEMENT" && item.alertId === normalizedAlertId && item.dedupeKey === normalizedDedupeKey && now.getTime() - Date.parse(item.acknowledgedAt) < windowMs);
  if (recent) return { ...recent, deduplicated: true, history: history.entries.filter((item) => item.alertId === normalizedAlertId) };
  const resolvedSnooze = parseSnoozeUntil({ now, snoozeUntil, snoozeMinutes, maxHours: config.alertSnoozeMaxHours });
  const runbook = alertRunbook(normalizedAlertId);
  const entry = {
    kind: "ACKNOWLEDGEMENT",
    alertId: normalizedAlertId,
    dedupeKey: normalizedDedupeKey,
    acknowledgedBy: String(acknowledgedBy).trim(),
    owner: String(owner ?? acknowledgedBy).trim() || String(acknowledgedBy).trim(),
    acknowledgedAt: now.toISOString(),
    dedupeWindowMinutes: config.alertDeduplicationWindowMinutes,
    snoozeUntil: resolvedSnooze,
    runbookOwnerRole: runbook.ownerRole,
    ...(note ? { note: String(note).slice(0, 2000) } : {}),
  };
  history.entries.push(entry);
  writePrivateJson(operationsAlertHistoryPath(runsRoot), history);
  return { ...entry, history: history.entries.filter((item) => item.alertId === entry.alertId) };
}

export function resolveOperationsAlert({ runsRoot, alertId, resolvedBy, evidence, note = null, now = new Date() } = {}) {
  if (!String(alertId ?? "").trim() || !String(resolvedBy ?? "").trim()) throw new Error("Resolution membutuhkan alertId dan operator teridentifikasi.");
  const normalizedEvidence = typeof evidence === "string" ? { summary: evidence.trim() } : evidence;
  if (!normalizedEvidence || typeof normalizedEvidence !== "object" || (!String(normalizedEvidence.summary ?? "").trim() && !String(normalizedEvidence.reference ?? normalizedEvidence.path ?? normalizedEvidence.runId ?? "").trim())) {
    throw new Error("Resolution membutuhkan evidence summary, reference, path, atau runId.");
  }
  const history = readAlertHistory(runsRoot);
  const entry = {
    kind: "RESOLUTION",
    alertId: String(alertId).trim(),
    resolvedBy: String(resolvedBy).trim(),
    resolvedAt: now.toISOString(),
    evidence: normalizedEvidence,
    ...(note ? { note: String(note).slice(0, 2000) } : {}),
  };
  history.entries.push(entry);
  writePrivateJson(operationsAlertHistoryPath(runsRoot), history);
  return { ...entry, history: history.entries.filter((item) => item.alertId === entry.alertId) };
}

export function listOperationsAlertAcknowledgements({ runsRoot, alertId = null } = {}) {
  const entries = readAlertHistory(runsRoot).entries;
  const filtered = alertId ? entries.filter((entry) => entry.alertId === alertId) : entries;
  return filtered.filter((entry) => entry.kind === "ACKNOWLEDGEMENT");
}

export function listOperationsAlertResolutions({ runsRoot, alertId = null } = {}) {
  const entries = readAlertHistory(runsRoot).entries.filter((entry) => entry.kind === "RESOLUTION");
  return alertId ? entries.filter((entry) => entry.alertId === alertId) : entries;
}

export function backupStatusPath(runsRoot) {
  return runtimePath(runsRoot, "backup-status.json");
}

export function recordVerifiedBackup({ runsRoot, backupPath, verification, manifest }) {
  if (!runsRoot || !backupPath || !verification?.verifiedAt || !manifest?.backupId) {
    throw new Error("Record backup membutuhkan runsRoot, backupPath, verification, dan manifest valid.");
  }
  const record = {
    schemaVersion: 1,
    backupId: manifest.backupId,
    backupPath: path.resolve(backupPath),
    verifiedAt: verification.verifiedAt,
    createdAt: manifest.createdAt,
    completedAt: manifest.completedAt,
    fileCount: verification.fileCount,
    totalBytes: verification.totalBytes,
  };
  writePrivateJson(backupStatusPath(runsRoot), record);
  return record;
}

export function readBackupStatus(runsRoot) {
  return readJson(backupStatusPath(runsRoot));
}

function measureTree(root) {
  if (!fs.existsSync(root)) return { bytes: 0, files: 0, directories: 0 };
  let bytes = 0; let files = 0; let directories = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { directories += 1; walk(absolute); }
      else if (entry.isFile()) { files += 1; bytes += fs.statSync(absolute).size; }
    }
  };
  walk(root);
  return { bytes, files, directories };
}

function safeDiskFreeBytes(root) {
  try {
    const stat = fs.statfsSync(root);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch { return null; }
}

function check({ id, status, severity, message, action, runbook, metrics = null }) {
  return { id, status, severity, message, action, runbook, ...(metrics ? { metrics } : {}) };
}

export function operationsReadiness({ runsRoot, now = new Date(), config = operationsConfig(), daemon = null } = {}) {
  const checkedAt = now.toISOString();
  const checks = [];
  const freeBytes = safeDiskFreeBytes(runsRoot);
  checks.push(freeBytes === null
    ? check({ id: "disk", status: "WARN", severity: "WARNING", message: "Kapasitas disk tidak dapat dibaca.", action: "Periksa volume runtime.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#operations-center" })
    : freeBytes < config.minFreeDiskBytes
      ? check({ id: "disk", status: "FAIL", severity: "CRITICAL", message: "Ruang disk di bawah batas operasi aman.", action: "Kosongkan ruang atau pindahkan artefak melalui retention preview.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#operations-center", metrics: { freeBytes, minimumBytes: config.minFreeDiskBytes } })
      : check({ id: "disk", status: "PASS", severity: "INFO", message: "Ruang disk memenuhi batas operasi.", action: "Tidak ada tindakan.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#operations-center", metrics: { freeBytes, minimumBytes: config.minFreeDiskBytes } }));

  const backup = readBackupStatus(runsRoot);
  const backupAgeMs = backup?.verifiedAt ? Math.max(0, now.getTime() - Date.parse(backup.verifiedAt)) : null;
  const backupMaxAgeMs = config.maxBackupAgeHours * 60 * 60 * 1000;
  checks.push(!backup || !Number.isFinite(backupAgeMs)
    ? check({ id: "backup", status: "FAIL", severity: "CRITICAL", message: "Belum ada disaster-recovery backup yang terverifikasi.", action: "Jalankan dr-backup ketika daemon quiescent, lalu dr-register-verified.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#backup-and-restore" })
    : backupAgeMs > backupMaxAgeMs
      ? check({ id: "backup", status: "FAIL", severity: "CRITICAL", message: "Backup terverifikasi sudah melewati target RPO.", action: "Buat dan verifikasi backup baru sebelum menerima pekerjaan.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#backup-and-restore", metrics: { ageMs: backupAgeMs, maximumAgeMs: backupMaxAgeMs, backupId: backup.backupId } })
      : check({ id: "backup", status: "PASS", severity: "INFO", message: "Backup terverifikasi masih memenuhi target RPO.", action: "Tidak ada tindakan.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#backup-and-restore", metrics: { ageMs: backupAgeMs, maximumAgeMs: backupMaxAgeMs, backupId: backup.backupId } }));

  const runtime = measureTree(runsRoot);
  const artifacts = measureTree(path.join(runsRoot, "workspace-artifacts"));
  checks.push(runtime.bytes > config.maxRuntimeBytes
    ? check({ id: "runtime-storage", status: "FAIL", severity: "CRITICAL", message: "Ukuran runtime melewati kuota operasi.", action: "Buat retention preview dan pindahkan artefak yang disetujui ke trash.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#retention", metrics: { bytes: runtime.bytes, maximumBytes: config.maxRuntimeBytes } })
    : artifacts.bytes > config.maxArtifactBytes
      ? check({ id: "artifact-growth", status: "WARN", severity: "WARNING", message: "Artefak tumbuh melewati ambang observasi.", action: "Tinjau retention preview; data belum akan dihapus otomatis.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#retention", metrics: { bytes: artifacts.bytes, maximumBytes: config.maxArtifactBytes } })
      : check({ id: "runtime-storage", status: "PASS", severity: "INFO", message: "Ukuran runtime dan artefak dalam batas.", action: "Tidak ada tindakan.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#retention", metrics: { runtimeBytes: runtime.bytes, artifactBytes: artifacts.bytes } }));

  const audit = verifyAuditChain(runsRoot);
  checks.push(audit.valid
    ? check({ id: "evidence-integrity", status: "PASS", severity: "INFO", message: "Rantai audit dan evidence valid.", action: "Tidak ada tindakan.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#evidence-contract" })
    : check({ id: "evidence-integrity", status: "FAIL", severity: "CRITICAL", message: "Rantai audit/evidence tidak valid.", action: "Hentikan eksekusi dan ikuti runbook investigasi evidence.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#evidence-contract", metrics: { errors: audit.errors ?? [] } }));

  const jobs = listJobs(runsRoot);
  const queued = jobs.filter((job) => job.state === JOB_STATES.QUEUED);
  const oldestQueuedAt = queued.map((job) => Date.parse(job.queuedAt ?? job.createdAt ?? "")).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const queueAgeMs = oldestQueuedAt ? Math.max(0, now.getTime() - oldestQueuedAt) : 0;
  checks.push(queueAgeMs > config.maxQueueAgeMinutes * 60 * 1000
    ? check({ id: "queue-age", status: "WARN", severity: "WARNING", message: "Antrian pekerjaan melebihi target waktu tunggu.", action: "Tinjau blocker readiness, kapasitas worker, dan job gagal.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#operations-center", metrics: { queued: queued.length, oldestAgeMs: queueAgeMs } })
    : check({ id: "queue-age", status: "PASS", severity: "INFO", message: "Usia antrian dalam target.", action: "Tidak ada tindakan.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#operations-center", metrics: { queued: queued.length, oldestAgeMs: queueAgeMs } }));

  const signalWindowMs = config.signalWindowHours * 60 * 60 * 1000;
  const recentRuns = listRuns(runsRoot).filter((run) => Date.parse(run.updatedAt ?? run.createdAt ?? "") > now.getTime() - signalWindowMs);
  const deadlineFailures = recentRuns.filter((run) => /deadline|timeout|output limit/i.test(JSON.stringify(run.execution ?? run.error ?? ""))).length;
  const providerFailures = recentRuns.filter((run) => /provider|model|rate limit|429/i.test(JSON.stringify(run.execution ?? run.error ?? ""))).length;
  checks.push(check({ id: "failure-signals", status: deadlineFailures || providerFailures ? "WARN" : "PASS", severity: deadlineFailures || providerFailures ? "WARNING" : "INFO", message: deadlineFailures || providerFailures ? "Kegagalan deadline/provider terdeteksi dalam 24 jam terakhir." : "Tidak ada kegagalan deadline/provider terbaru.", action: deadlineFailures || providerFailures ? "Tinjau run gagal dan jalankan runbook reliability." : "Tidak ada tindakan.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#reliability", metrics: { deadlineFailures, providerFailures } }));

  const daemonState = daemon ?? daemonStatus({ runsRoot });
  checks.push(check({ id: "daemon", status: daemonState.running || !daemonState.heartbeatAt ? "PASS" : "WARN", severity: daemonState.running || !daemonState.heartbeatAt ? "INFO" : "WARNING", message: daemonState.running || !daemonState.heartbeatAt ? "Status daemon dapat diinspeksi." : "Daemon heartbeat tidak sehat.", action: daemonState.running || !daemonState.heartbeatAt ? "Tidak ada tindakan." : "Restart daemon setelah memeriksa log.", runbook: "PHASE_4_PRODUCTION_HARDENING.md#operations-center", metrics: { running: Boolean(daemonState.running), heartbeatAt: daemonState.heartbeatAt ?? null } }));

  const blockers = checks.filter((item) => item.status === "FAIL");
  const warnings = checks.filter((item) => item.status === "WARN");
  const history = readAlertHistory(runsRoot);
  const expiresAt = new Date(now.getTime() + config.alertTtlHours * 60 * 60 * 1000).toISOString();
  const baseAlerts = [...blockers, ...warnings].map((item) => ({ alertId: `OPS_${item.id.replace(/-/g, "_").toUpperCase()}`, severity: item.severity, dedupeKey: `${item.id}:${item.status}`, acknowledgement: "Acknowledgement hanya mencatat kepemilikan; tidak membuka admission yang diblokir.", runbook: item.runbook, message: item.message }));
  const alerts = baseAlerts.flatMap((alert) => {
    if (alert.alertId !== "OPS_FAILURE_SIGNALS") return [alert];
    const signals = [];
    if (deadlineFailures) signals.push({ ...alert, alertId: "OPS_DEADLINE_FAILURES", dedupeKey: "deadline-failures" });
    if (providerFailures) signals.push({ ...alert, alertId: "OPS_PROVIDER_FAILURES", dedupeKey: "provider-failures" });
    return signals;
  }).map((alert) => {
    const alertHistory = history.entries.filter((entry) => entry.alertId === alert.alertId);
    const acknowledgement = [...alertHistory].reverse().find((entry) => entry.kind === "ACKNOWLEDGEMENT" && entry.dedupeKey === alert.dedupeKey) ?? [...alertHistory].reverse().find((entry) => entry.kind === "ACKNOWLEDGEMENT");
    const resolution = [...alertHistory].reverse().find((entry) => entry.kind === "RESOLUTION");
    const snoozed = Boolean(acknowledgement?.snoozeUntil && Date.parse(acknowledgement.snoozeUntil) > now.getTime());
    const runbook = alertRunbook(alert.alertId, alert.runbook);
    return {
      ...alert,
      observedAt: checkedAt,
      expiresAt,
      owner: acknowledgement?.owner ?? null,
      ownerRole: acknowledgement?.runbookOwnerRole ?? runbook.ownerRole,
      runbookSteps: runbook.steps,
      acknowledgementState: snoozed ? "SNOOZED" : acknowledgement ? "ACKNOWLEDGED" : "UNACKNOWLEDGED",
      acknowledgementHistory: alertHistory.filter((entry) => entry.kind === "ACKNOWLEDGEMENT"),
      acknowledgement,
      snoozeUntil: acknowledgement?.snoozeUntil ?? null,
      resolution: resolution ?? null,
      resolutionEvidenceRequired: true,
    };
  });
  return { schemaVersion: 1, checkedAt, status: blockers.length ? "BLOCKED" : warnings.length ? "DEGRADED" : "READY", admission: { allowed: blockers.length === 0, blockers: blockers.map(({ id, message, action }) => ({ id, message, action })) }, checks, alerts, signals: { disk: { freeBytes }, backup, runtime, artifacts, queue: { queued: queued.length, oldestAgeMs: queueAgeMs }, failures: { deadlineFailures, providerFailures } } };
}

export function assertOperationalReadiness({ runsRoot, now, config } = {}) {
  const readiness = operationsReadiness({ runsRoot, now, config });
  if (!readiness.admission.allowed) {
    const error = new Error("Eksekusi diblokir oleh Operations Center.");
    error.code = "OPERATIONS_NOT_READY";
    error.details = readiness;
    throw error;
  }
  return readiness;
}

function retentionPlanPath(runsRoot, planId) { return runtimePath(runsRoot, "retention-plans", `${planId}.json`); }
function retentionTrashRoot(runsRoot) { return path.join(runsRoot, "trash", "retention"); }
function safeCandidateRoot(runsRoot, category) {
  if (!RETENTION_ROOTS.includes(category)) throw new Error("Kategori retention tidak diizinkan.");
  return path.join(runsRoot, category);
}

export function previewRetention({ runsRoot, olderThanDays = 30, now = new Date() } = {}) {
  const days = Number(olderThanDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("olderThanDays harus integer 1-3650.");
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const category of RETENTION_ROOTS) {
    const root = safeCandidateRoot(runsRoot, category);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const absolute = path.join(root, entry.name);
      const stat = fs.statSync(absolute);
      if (stat.mtimeMs > cutoffMs) continue;
      const measured = measureTree(absolute);
      candidates.push({ category, name: entry.name, relativePath: entry.name, modifiedAt: stat.mtime.toISOString(), bytes: measured.bytes, fileCount: measured.files });
    }
  }
  const plan = { schemaVersion: 1, planId: `retention-${randomUUID()}`, status: "PREVIEWED", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(), olderThanDays: days, candidates, summary: { candidateCount: candidates.length, bytes: candidates.reduce((sum, item) => sum + item.bytes, 0), fileCount: candidates.reduce((sum, item) => sum + item.fileCount, 0) } };
  writePrivateJson(retentionPlanPath(runsRoot, plan.planId), plan);
  return plan;
}

export function applyRetentionPlan({ runsRoot, planId, confirmed = false, confirmedBy = null, now = new Date() } = {}) {
  if (!confirmed || !String(confirmedBy ?? "").trim()) throw new Error("Purge retention membutuhkan confirm=true dan operator teridentifikasi.");
  const planPath = retentionPlanPath(runsRoot, planId);
  const plan = readJson(planPath);
  if (!plan || plan.status !== "PREVIEWED") throw new Error("Retention plan tidak ditemukan atau sudah dieksekusi.");
  if (Date.parse(plan.expiresAt) < now.getTime()) throw new Error("Retention plan kedaluwarsa; buat preview baru.");
  const trashId = plan.planId;
  const moved = [];
  for (const candidate of plan.candidates) {
    const sourceRoot = safeCandidateRoot(runsRoot, candidate.category);
    const source = path.join(sourceRoot, candidate.relativePath);
    const destination = path.join(retentionTrashRoot(runsRoot), trashId, candidate.category, candidate.name);
    if (!fs.existsSync(source)) continue;
    ensurePrivateDirectory(path.dirname(destination));
    if (fs.existsSync(destination)) throw new Error(`Trash destination sudah ada: ${candidate.name}`);
    fs.renameSync(source, destination);
    moved.push({ ...candidate, trashPath: path.relative(runsRoot, destination) });
  }
  const executed = { ...plan, status: "MOVED_TO_TRASH", trashId, confirmedBy: String(confirmedBy), confirmedAt: now.toISOString(), moved };
  writePrivateJson(planPath, executed);
  return executed;
}

export function listRetentionTrash({ runsRoot } = {}) {
  const directory = runtimePath(runsRoot, "retention-plans");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(directory, name))).filter((plan) => plan?.status === "MOVED_TO_TRASH").sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
}

export function restoreRetentionTrash({ runsRoot, trashId, confirmed = false, confirmedBy = null, now = new Date() } = {}) {
  if (!confirmed || !String(confirmedBy ?? "").trim()) throw new Error("Restore retention membutuhkan confirm=true dan operator teridentifikasi.");
  const planPath = retentionPlanPath(runsRoot, trashId);
  const plan = readJson(planPath);
  if (!plan || plan.status !== "MOVED_TO_TRASH") throw new Error("Trash retention tidak ditemukan atau sudah direstore.");
  const restored = [];
  for (const item of plan.moved ?? []) {
    const source = path.join(runsRoot, item.trashPath);
    const destination = path.join(safeCandidateRoot(runsRoot, item.category), item.relativePath);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(destination)) throw new Error(`Restore ditolak karena target sudah ada: ${item.relativePath}`);
    ensurePrivateDirectory(path.dirname(destination));
    fs.renameSync(source, destination);
    restored.push(item);
  }
  const completed = { ...plan, status: "RESTORED", restored, restoredBy: String(confirmedBy), restoredAt: now.toISOString() };
  writePrivateJson(planPath, completed);
  return completed;
}

export class RequestRateLimiter {
  constructor({ readLimit = 240, mutationLimit = 120, windowMs = 60_000, now = () => Date.now() } = {}) {
    this.readLimit = readLimit; this.mutationLimit = mutationLimit; this.windowMs = windowMs; this.now = now; this.buckets = new Map();
  }
  check({ key, mutation = false } = {}) {
    const now = this.now(); const limit = mutation ? this.mutationLimit : this.readLimit; const bucketKey = `${mutation ? "m" : "r"}:${key || "anonymous"}`;
    const current = this.buckets.get(bucketKey);
    const bucket = !current || now - current.startedAt >= this.windowMs ? { startedAt: now, count: 0 } : current;
    bucket.count += 1; this.buckets.set(bucketKey, bucket);
    return { allowed: bucket.count <= limit, limit, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + this.windowMs - now) / 1000)) };
  }
}
