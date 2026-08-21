const SECRET_NAME = /(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE[_-]?KEY)/i;
const SECRET_FIELD = /^(?:api[_-]?key|apiKey|token|secret|password|passwd|credential|authorization|cookie|auth[_-]?token|authToken|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|private[_-]?key|privateKey)$/i;
const BENIGN_NAME = /^(?:PATH|SSH_AUTH_SOCK)$/i;
const REDACTED = "[REDACTED]";

export function sensitiveEnvironmentValues(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && !BENIGN_NAME.test(name) && String(value ?? "").length >= 8)
    .map(([, value]) => String(value))
    .sort((a, b) => b.length - a.length);
}

export function redactText(value, { env = process.env } = {}) {
  let text = String(value ?? "");
  for (const secret of sensitiveEnvironmentValues(env)) text = text.split(secret).join(REDACTED);
  return text
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b((?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie)\s*[:=]\s*)[^\s,;"']+/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

export function redactSensitive(value, options = {}, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value, options);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => redactSensitive(item, options, seen));
    seen.delete(value);
    return result;
  }
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_FIELD.test(key) ? REDACTED : redactSensitive(item, options, seen),
  ]));
  seen.delete(value);
  return result;
}

export function privateJsonLine(value, options = {}) {
  return `${JSON.stringify(redactSensitive(value, options))}\n`;
}
