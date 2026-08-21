import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export function apiTokenPath(runsRoot) {
  return path.join(runsRoot, "runtime", "api-token.json");
}

export function idempotencyPath(runsRoot) {
  return path.join(runsRoot, "runtime", "idempotency.json");
}

function writeNewApiToken(filePath, previousRecord = null) {
  const token = randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  const record = {
    schemaVersion: 1,
    token,
    createdAt,
    ...(previousRecord?.createdAt ? { rotatedAt: createdAt } : {}),
    description: "Personal AI Orchestrator Local API Token",
  };

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}

  return token;
}

export function ensureApiToken(runsRoot) {
  const filePath = apiTokenPath(runsRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const existing = readExistingApiToken(runsRoot);
  if (existing) {
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return existing;
  }

  return writeNewApiToken(filePath);
}

export function readExistingApiToken(runsRoot) {
  const filePath = apiTokenPath(runsRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data?.token && typeof data.token === "string" && data.token.length >= 32 ? data.token : null;
  } catch {
    return null;
  }
}

export function rotateApiToken(runsRoot) {
  const filePath = apiTokenPath(runsRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let previousRecord = null;
  try {
    previousRecord = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {}
  const token = writeNewApiToken(filePath, previousRecord);
  return {
    rotated: true,
    filePath,
    rotatedAt: new Date().toISOString(),
    fingerprint: createHash("sha256").update(token).digest("hex").slice(0, 12),
    restartRequired: true,
  };
}

export function extractTokenFromRequest(req) {
  const authHeader = req.headers["authorization"];
  if (authHeader && typeof authHeader === "string") {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      return parts[1];
    }
  }

  const customHeader = req.headers["x-api-token"];
  if (customHeader && typeof customHeader === "string") {
    return customHeader.trim();
  }

  return null;
}

export function authenticateRequest(req, expectedToken) {
  if (!expectedToken || typeof expectedToken !== "string") {
    return { authenticated: false, reason: "Server API token not configured" };
  }

  const extracted = extractTokenFromRequest(req);
  if (!extracted) {
    return { authenticated: false, reason: "Missing Authorization header or x-api-token" };
  }

  try {
    const expectedBuffer = Buffer.from(expectedToken, "utf8");
    const actualBuffer = Buffer.from(extracted, "utf8");
    if (expectedBuffer.length !== actualBuffer.length) {
      return { authenticated: false, reason: "Invalid API token" };
    }
    const matches = timingSafeEqual(expectedBuffer, actualBuffer);
    return matches
      ? { authenticated: true, reason: null }
      : { authenticated: false, reason: "Invalid API token" };
  } catch {
    return { authenticated: false, reason: "Token validation error" };
  }
}

export function validateOrigin(req) {
  const origin = req.headers["origin"] || req.headers["referer"];
  if (!origin || typeof origin !== "string") {
    return { valid: true, reason: null };
  }

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]") {
      return { valid: true, reason: null };
    }
    return { valid: false, reason: `Origin ${parsed.origin} is not allowed. Only localhost/127.0.0.1 is permitted.` };
  } catch {
    return { valid: false, reason: "Malformed Origin or Referer header" };
  }
}

export class IdempotencyStore {
  constructor(runsRoot, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.runsRoot = runsRoot;
    this.filePath = idempotencyPath(runsRoot);
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const now = Date.now();
      if (data && typeof data === "object") {
        for (const [key, item] of Object.entries(data)) {
          if (item?.createdAt && (now - new Date(item.createdAt).getTime()) < this.ttlMs) {
            this.entries.set(key, item);
          }
        }
      }
    } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = Object.fromEntries(this.entries.entries());
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }

  get(key) {
    if (!key || typeof key !== "string") return null;
    const item = this.entries.get(key);
    if (!item) return null;
    if ((Date.now() - new Date(item.createdAt).getTime()) >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return item;
  }

  set(key, { statusCode = 200, body }) {
    if (!key || typeof key !== "string") return;
    const now = new Date().toISOString();
    this.entries.set(key, {
      key,
      statusCode,
      body,
      createdAt: now,
    });
    try {
      this.save();
    } catch {}
  }
}
