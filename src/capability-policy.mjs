import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_ENV = Object.freeze([
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "SHELL", "USER", "LOGNAME", "NO_COLOR",
]);
const PROVIDER_ENV = Object.freeze([
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
]);

export const CAPABILITY_PROFILES = Object.freeze({
  agent: { network: "provider", deadlineMs: 35 * 60_000, maxOutputBytes: 2_000_000, env: [...BASE_ENV, ...PROVIDER_ENV] },
  verification: { network: "deny", deadlineMs: 15 * 60_000, maxOutputBytes: 1_000_000, env: BASE_ENV },
  graphify: { network: "deny", deadlineMs: 10 * 60_000, maxOutputBytes: 1_000_000, env: BASE_ENV },
  updater: { network: "deny", deadlineMs: 5 * 60_000, maxOutputBytes: 500_000, env: BASE_ENV },
  preview: { network: "deny", deadlineMs: 30_000, maxOutputBytes: 100_000, env: BASE_ENV },
});

export function capabilityForStage(stage = "") {
  const value = String(stage).toLowerCase();
  if (value.includes("agent") || value === "implementation" || value === "review_revision" || value === "automatic_recovery") return "agent";
  if (value.includes("graphify")) return "graphify";
  if (value.includes("preview")) return "preview";
  if (value.includes("updat")) return "updater";
  return "verification";
}

export function allowlistedEnvironment(source = process.env, profileName = "verification", overrides = {}) {
  const profile = CAPABILITY_PROFILES[profileName];
  if (!profile) throw new Error(`Capability profile tidak dikenal: ${profileName}`);
  const result = {};
  for (const name of profile.env) if (source[name] !== undefined) result[name] = String(source[name]);
  for (const [name, value] of Object.entries(overrides)) {
    if (!profile.env.includes(name)) throw new Error(`Environment ${name} tidak diizinkan untuk capability ${profileName}.`);
    result[name] = String(value);
  }
  return result;
}

function canonicalRoot(root) {
  const absolute = path.resolve(root);
  try { return fs.realpathSync(absolute); } catch { return absolute; }
}

function sbplString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function sandboxPolicy({ profileName, cwd, writableRoots = [cwd], readableRoots = [cwd], home = os.homedir(), deniedReadRoots = [] }) {
  const profile = CAPABILITY_PROFILES[profileName];
  if (!profile) throw new Error(`Capability profile tidak dikenal: ${profileName}`);
  const reads = [...new Set(readableRoots.filter(Boolean).map(canonicalRoot))];
  const writes = [...new Set(writableRoots.filter(Boolean).map(canonicalRoot))];
  const sensitiveRoots = [
    ...[".ssh", ".aws", ".gnupg", ".kube", ".docker", "Library/Keychains"].map((item) => path.join(home, item)),
    ...deniedReadRoots,
  ].map(canonicalRoot);
  const forms = ["(version 1)", "(allow default)"];
  for (const root of sensitiveRoots) forms.push(`(deny file-read* (subpath ${sbplString(root)}))`);
  for (const root of reads) forms.push(`(allow file-read* (subpath ${sbplString(root)}))`);
  forms.push("(deny file-write*)");
  for (const root of writes) forms.push(`(allow file-write* (subpath ${sbplString(root)}))`);
  for (const root of ["/dev/null", "/dev/tty"]) forms.push(`(allow file-write* (literal ${sbplString(root)}))`);
  if (profile.network === "deny") forms.push("(deny network*)");
  return forms.join(" ");
}

export function prepareCapabilitySpawn({ command, args = [], cwd, env = process.env, capabilityProfile, writableRoots, readableRoots, home, deniedReadRoots }) {
  const profileName = capabilityProfile || "verification";
  const profile = CAPABILITY_PROFILES[profileName];
  if (!profile) throw new Error(`Capability profile tidak dikenal: ${profileName}`);
  const sanitizedEnv = allowlistedEnvironment(env, profileName);
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
    const error = new Error("OS capability sandbox tidak tersedia; child process ditolak fail-closed.");
    error.code = "CAPABILITY_SANDBOX_UNAVAILABLE";
    throw error;
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `orchestrator-${profileName}-`));
  fs.chmodSync(temporaryRoot, 0o700);
  sanitizedEnv.TMPDIR = temporaryRoot;
  const effectiveWritableRoots = [...(writableRoots ?? [cwd]), temporaryRoot];
  const effectiveReadableRoots = [...(readableRoots ?? [cwd]), temporaryRoot];
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", sandboxPolicy({ profileName, cwd, writableRoots: effectiveWritableRoots, readableRoots: effectiveReadableRoots, home, deniedReadRoots }), command, ...args],
    env: sanitizedEnv,
    deadlineMs: profile.deadlineMs,
    maxOutputBytes: profile.maxOutputBytes,
    profileName,
    temporaryRoot,
  };
}
