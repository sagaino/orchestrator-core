import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runMacOsNotifier } from "./macos-notifier.mjs";

const DELIVERY_MODES = new Set(["auto", "desktop", "inbox"]);

function notificationsRoot(runsRoot) {
  return path.join(runsRoot, "notifications");
}

function notificationId(dedupeKey) {
  return createHash("sha256").update(String(dedupeKey)).digest("hex").slice(0, 24);
}

function notificationPath(runsRoot, id) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error(`Notification ID tidak valid: ${id}`);
  return path.join(notificationsRoot(runsRoot), `${id}.json`);
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function readNotification(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function compactText(value, maximumLength) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maximumLength ? `${normalized.slice(0, maximumLength - 1)}…` : normalized;
}

export function configuredNotificationDelivery(env = process.env) {
  const mode = String(env.ORCHESTRATOR_NOTIFICATION_DELIVERY ?? "inbox").trim().toLowerCase();
  if (!DELIVERY_MODES.has(mode)) {
    throw new Error("ORCHESTRATOR_NOTIFICATION_DELIVERY harus auto, desktop, atau inbox.");
  }
  return mode;
}

export async function deliverDesktopNotification(
  notification,
  {
    env = process.env,
    platform = process.platform,
    runsRoot,
    nativeNotifier = runMacOsNotifier,
  } = {},
) {
  const mode = configuredNotificationDelivery(env);
  const attemptedAt = new Date().toISOString();
  if (mode === "inbox") {
    return { channel: "inbox", status: "SKIPPED", attemptedAt, reason: "Desktop delivery disabled." };
  }
  if (platform !== "darwin") {
    return { channel: "desktop", status: "SKIPPED", attemptedAt, reason: `Platform ${platform} belum didukung.` };
  }

  try {
    const result = await nativeNotifier({
      ...notification,
      title: compactText(notification.title, 80),
      subtitle: compactText(notification.subtitle || notification.source?.projectId || "Personal AI Orchestrator", 80),
      message: compactText(notification.message, 240),
    }, { runsRoot });
    const delivery = {
      channel: "desktop",
      status: result.status === "ACCEPTED" ? "ACCEPTED_BY_MACOS" : String(result.status),
      attemptedAt,
      app: "Personal AI Orchestrator",
    };
    if (result.reason) delivery.reason = compactText(result.reason, 1_000);
    return delivery;
  } catch (error) {
    return {
      channel: "desktop",
      status: "FAILED",
      attemptedAt,
      error: compactText(error.stderr || error.message, 1_000),
    };
  }
}

export function listNotifications({ runsRoot, unreadOnly = false, limit = 50 }) {
  const root = notificationsRoot(runsRoot);
  const notifications = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readNotification(path.join(root, entry.name)))
      .filter(Boolean)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    : [];
  const unread = notifications.filter((item) => !item.readAt);
  const selected = (unreadOnly ? unread : notifications).slice(0, Math.max(1, Number(limit) || 50));
  return {
    schemaVersion: 1,
    mode: "notification-inbox",
    total: notifications.length,
    unreadCount: unread.length,
    notifications: selected,
    nextAction: unread.length
      ? "Gunakan notification-read <notification-id|task-id|all> untuk menandai sudah dibaca."
      : "Tidak ada notification yang belum dibaca.",
  };
}

export function notificationSummary(runsRoot) {
  const inbox = listNotifications({ runsRoot, limit: 5 });
  return {
    total: inbox.total,
    unreadCount: inbox.unreadCount,
    latest: inbox.notifications.map((item) => ({
      id: item.notificationId,
      type: item.type,
      title: item.title,
      taskId: item.source?.taskId ?? null,
      createdAt: item.createdAt,
      readAt: item.readAt,
      delivery: item.delivery?.status ?? "PENDING",
    })),
  };
}

export async function emitNotification({
  runsRoot,
  dedupeKey,
  type,
  severity = "INFO",
  title,
  subtitle = null,
  message,
  source = {},
  action = null,
  deliverer = deliverDesktopNotification,
}) {
  const key = String(dedupeKey ?? `${type}:${source.runId ?? source.taskId ?? title}`).trim();
  const id = notificationId(key);
  const filePath = notificationPath(runsRoot, id);
  if (fs.existsSync(filePath)) {
    return { created: false, notification: readNotification(filePath) };
  }

  const createdAt = new Date().toISOString();
  const notification = {
    schemaVersion: 1,
    notificationId: id,
    dedupeKey: key,
    type: String(type),
    severity: String(severity).toUpperCase(),
    title: compactText(title, 120),
    subtitle: subtitle ? compactText(subtitle, 120) : null,
    message: compactText(message, 2_000),
    source,
    action,
    createdAt,
    updatedAt: createdAt,
    readAt: null,
    readBy: null,
    delivery: { channel: null, status: "PENDING", attemptedAt: null },
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(notification, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return { created: false, notification: readNotification(filePath) };
    throw error;
  }

  let delivery;
  try {
    delivery = await deliverer(notification, { runsRoot });
  } catch (error) {
    delivery = {
      channel: "unknown",
      status: "FAILED",
      attemptedAt: new Date().toISOString(),
      error: compactText(error.message, 1_000),
    };
  }
  const delivered = { ...notification, delivery, updatedAt: new Date().toISOString() };
  writeAtomic(filePath, delivered);
  return { created: true, notification: delivered };
}

export function acknowledgeNotifications({ runsRoot, selector = "all", readBy = "user" }) {
  const normalized = String(selector || "all").trim().toLowerCase();
  const inbox = listNotifications({ runsRoot, limit: Number.MAX_SAFE_INTEGER });
  const matches = inbox.notifications.filter((item) => {
    if (normalized === "all") return !item.readAt;
    return item.notificationId === normalized
      || item.notificationId.startsWith(normalized)
      || String(item.source?.taskId ?? "").toLowerCase() === normalized;
  });
  if (!matches.length && normalized === "all") {
    return {
      schemaVersion: 1,
      action: "NOTIFICATIONS_READ",
      selector,
      count: 0,
      notificationIds: [],
      readAt: new Date().toISOString(),
      unreadCount: 0,
    };
  }
  if (!matches.length) throw new Error(`Notification tidak ditemukan: ${selector}`);
  const readAt = new Date().toISOString();
  for (const item of matches) {
    writeAtomic(notificationPath(runsRoot, item.notificationId), {
      ...item,
      readAt,
      readBy: String(readBy).trim() || "user",
      updatedAt: readAt,
    });
  }
  return {
    schemaVersion: 1,
    action: "NOTIFICATIONS_READ",
    selector,
    count: matches.length,
    notificationIds: matches.map((item) => item.notificationId),
    readAt,
    unreadCount: notificationSummary(runsRoot).unreadCount,
  };
}

export async function notifyTaskOutcome({ runsRoot, job, manifest = null, error = null, deliverer }) {
  const runId = manifest?.runId ?? job?.runId ?? null;
  const taskId = manifest?.task?.id ?? job?.taskId ?? null;
  const projectId = manifest?.project?.id ?? job?.projectId ?? null;
  const automaticRecovery = manifest?.execution?.automaticRecovery ?? null;
  const reviewReady = ["REVIEW", "RETROSPECTIVE"].includes(manifest?.state) || job?.state === "REVIEW";
  let type;
  let severity;
  let title;
  let message;
  let action;

  if (reviewReady && automaticRecovery?.status === "SUCCESS") {
    type = "AUTOMATIC_RECOVERY_SUCCEEDED";
    severity = "SUCCESS";
    title = `${taskId ?? "Task"} dipulihkan dan siap direview`;
    message = automaticRecovery.strategy === "DETERMINISTIC_RETRY"
      ? "Verification pulih melalui retry tanpa AI. Hasil task siap direview."
      : `Recovery agent berhasil pada attempt ${automaticRecovery.successfulAttempt}. Hasil task siap direview.`;
    action = { command: `npm run review -- ${taskId}` };
  } else if (reviewReady) {
    type = "TASK_REVIEW_READY";
    severity = "SUCCESS";
    title = `${taskId ?? "Task"} siap direview`;
    message = "Implementation, scope audit, verification, Graphify, dan retrospective sudah selesai.";
    action = { command: `npm run review -- ${taskId}` };
  } else if (automaticRecovery?.status === "EXHAUSTED") {
    type = "AUTOMATIC_RECOVERY_EXHAUSTED";
    severity = "ERROR";
    title = `${taskId ?? "Task"} gagal setelah automatic recovery`;
    message = compactText(
      automaticRecovery.finalError || error?.message || manifest?.execution?.result?.error || "Recovery attempts exhausted.",
      500,
    );
    action = { command: `npm run status -- ${taskId}` };
  } else {
    type = "TASK_FAILED";
    severity = "ERROR";
    title = `${taskId ?? "Task"} gagal`;
    message = compactText(error?.message || manifest?.execution?.result?.error || job?.error || "Task execution failed.", 500);
    action = { command: taskId ? `npm run status -- ${taskId}` : "npm run status" };
  }

  return emitNotification({
    runsRoot,
    dedupeKey: `${type}:${runId ?? job?.jobId ?? taskId}`,
    type,
    severity,
    title,
    subtitle: projectId,
    message,
    source: { runId, jobId: job?.jobId ?? null, taskId, projectId },
    action,
    ...(deliverer ? { deliverer } : {}),
  });
}

export async function notifyKnowledgeCandidateReady({ runsRoot, manifest, deliverer }) {
  const targetPath = manifest.knowledge?.sync?.targetPath ?? null;
  return emitNotification({
    runsRoot,
    dedupeKey: `KNOWLEDGE_CANDIDATE_READY:${manifest.runId}:${targetPath}`,
    type: "KNOWLEDGE_CANDIDATE_READY",
    severity: "ACTION_REQUIRED",
    title: "Knowledge Candidate menunggu keputusan",
    subtitle: manifest.project?.id ?? "Personal AI Orchestrator",
    message: `${manifest.knowledge?.proposal?.title ?? "Candidate"} disimpan sebagai Candidate dan belum menjadi global Wiki knowledge.`,
    source: {
      runId: manifest.runId,
      taskId: manifest.task?.id ?? null,
      projectId: manifest.project?.id ?? null,
      targetPath,
    },
    action: { command: "npm run knowledge-candidates" },
    ...(deliverer ? { deliverer } : {}),
  });
}

export async function emitTestNotification({ runsRoot, deliverer }) {
  return emitNotification({
    runsRoot,
    dedupeKey: `SYSTEM_TEST:${new Date().toISOString()}:${randomUUID()}`,
    type: "SYSTEM_TEST",
    severity: "INFO",
    title: "Personal AI Orchestrator aktif",
    subtitle: "Notification Test",
    message: "Desktop notification dan persistent inbox berfungsi.",
    source: { system: "personal-ai-orchestrator" },
    action: { command: "npm run notifications" },
    ...(deliverer ? { deliverer } : {}),
  });
}
