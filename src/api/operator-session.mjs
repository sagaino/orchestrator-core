import os from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

function equal(left, right) {
  const a = Buffer.from(String(left ?? "")); const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}
function nonce() { return randomBytes(32).toString("base64url"); }

export class OperatorSessionStore {
  constructor({ ttlMs = 8 * 60 * 60_000, identity = `local:${os.userInfo().username}` } = {}) {
    this.ttlMs = ttlMs; this.identity = identity; this.sessions = new Map();
  }
  issue(existingSessionId = null) {
    const existing = existingSessionId ? this.sessions.get(existingSessionId) : null;
    if (existing && existing.expiresAt > Date.now()) return { ...existing, expiresAt: new Date(existing.expiresAt).toISOString() };
    const record = { sessionId: randomUUID(), actor: this.identity, actionNonce: nonce(), expiresAt: Date.now() + this.ttlMs };
    this.sessions.set(record.sessionId, record);
    return { ...record, expiresAt: new Date(record.expiresAt).toISOString() };
  }
  authorize(sessionId, actionNonce) {
    const record = this.sessions.get(String(sessionId ?? ""));
    if (!record || record.expiresAt <= Date.now()) return { authorized: false, reason: "Operator session tidak valid atau kedaluwarsa." };
    if (!equal(record.actionNonce, actionNonce)) return { authorized: false, reason: "Action nonce tidak valid atau sudah digunakan." };
    const usedNonceHash = createHash("sha256").update(record.actionNonce).digest("hex");
    record.actionNonce = nonce();
    return { authorized: true, actor: record.actor, sessionId: record.sessionId, usedNonceHash, nextNonce: record.actionNonce };
  }
}
