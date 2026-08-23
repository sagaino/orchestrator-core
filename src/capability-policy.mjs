import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_ENV = Object.freeze([
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "SHELL", "USER", "LOGNAME", "NO_COLOR", "ORCHESTRATOR_PROJECT_URLS",
]);
const PROVIDER_ENV = Object.freeze([
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
]);

export const CAPABILITY_PROFILES = Object.freeze({
  agent: { network: "provider", deadlineMs: 35 * 60_000, maxOutputBytes: 2_000_000, env: [...BASE_ENV, ...PROVIDER_ENV] },
  diagnostic: { network: "provider", deadlineMs: 15 * 60_000, maxOutputBytes: 1_000_000, env: [...BASE_ENV, ...PROVIDER_ENV] },
  verification: { network: "deny", deadlineMs: 15 * 60_000, maxOutputBytes: 1_000_000, env: BASE_ENV },
  graphify: { network: "deny", deadlineMs: 10 * 60_000, maxOutputBytes: 1_000_000, env: BASE_ENV },
  updater: { network: "deny", deadlineMs: 5 * 60_000, maxOutputBytes: 500_000, env: BASE_ENV },
  preview: { network: "deny", deadlineMs: 30_000, maxOutputBytes: 100_000, env: BASE_ENV },
});

export function capabilityForStage(stage = "") {
  const value = String(stage).toLowerCase();
  if (value === "cross-project-diagnostic") return "diagnostic";
  if (
    value.includes("agent")
    || value === "implementation"
    || value === "review_revision"
    || value === "automatic_recovery"
    || value === "task-intake-planner"
    || value === "project-decomposition"
    || value === "retrospective"
    || value === "knowledge-classification"
    || value === "knowledge-ingest"
    || value.startsWith("knowledge-harvest")
  ) return "agent";
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

function rootAliases(root) {
  const absolute = path.resolve(root);
  return [...new Set([absolute, canonicalRoot(absolute)])];
}

function sbplString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function sandboxPolicy({ profileName, cwd, writableRoots = [cwd], readableRoots = [cwd], home = os.homedir(), deniedReadRoots = [], providerManagedSandbox = false, enforceWriteBoundary = !providerManagedSandbox, allowLoopback = false }) {
  const profile = CAPABILITY_PROFILES[profileName];
  if (!profile) throw new Error(`Capability profile tidak dikenal: ${profileName}`);
  const reads = [...new Set(readableRoots.filter(Boolean).flatMap(rootAliases))];
  const writes = [...new Set(writableRoots.filter(Boolean).flatMap(rootAliases))];
  const sensitiveHomeRoots = [".ssh", ".aws", ".gnupg", ".kube", ".docker"];
  if (profileName !== "agent" && profileName !== "diagnostic") sensitiveHomeRoots.push("Library/Keychains");
  const sensitiveRoots = [
    ...sensitiveHomeRoots.map((item) => path.join(home, item)),
    ...deniedReadRoots,
  ].map(canonicalRoot);
  const forms = ["(version 1)", "(allow default)"];
  for (const root of sensitiveRoots) {
    forms.push(`(deny file-read* (subpath ${sbplString(root)}))`);
    forms.push(`(deny file-write* (subpath ${sbplString(root)}))`);
  }
  for (const root of reads) forms.push(`(allow file-read* (subpath ${sbplString(root)}))`);
  if (enforceWriteBoundary) {
    const permittedWrites = [
      ...writes.map((root) => `(require-not (subpath ${sbplString(root)}))`),
      ...["/dev/null", "/dev/tty"].map((root) => `(require-not (literal ${sbplString(root)}))`),
      "(require-not (vnode-type SOCKET))",
    ];
    forms.push(`(deny file-write* (require-all ${permittedWrites.join(" ")}))`);
  }
  if (profile.network === "deny" && allowLoopback) {
    forms.push('(deny network-outbound (require-not (remote ip "localhost:*")))');
    forms.push('(deny network-inbound (require-not (local ip "localhost:*")))');
  } else if (profile.network === "deny") forms.push("(deny network*)");
  else if (profile.network === "provider") forms.push("(allow network*)");
  return forms.join(" ");
}

export function prepareCapabilitySpawn({ command, args = [], cwd, env = process.env, capabilityProfile, writableRoots, readableRoots, home, deniedReadRoots, allowLoopback = false }) {
  const profileName = capabilityProfile || "verification";
  const profile = CAPABILITY_PROFILES[profileName];
  if (!profile) throw new Error(`Capability profile tidak dikenal: ${profileName}`);
  const sanitizedEnv = allowlistedEnvironment(env, profileName);
  const effectiveHome = path.resolve(home ?? sanitizedEnv.HOME ?? os.homedir());
  sanitizedEnv.HOME = effectiveHome;
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
    const error = new Error("OS capability sandbox tidak tersedia; child process ditolak fail-closed.");
    error.code = "CAPABILITY_SANDBOX_UNAVAILABLE";
    throw error;
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `orchestrator-${profileName}-`));
  fs.chmodSync(temporaryRoot, 0o700);
  sanitizedEnv.TMPDIR = temporaryRoot;
  const effectiveWritableRoots = [...(writableRoots ?? [cwd]), temporaryRoot];
  const providerManagedSandbox = ["agent", "diagnostic"].includes(profileName) && path.basename(command) === "agy";
  if (profileName === "agent" || profileName === "diagnostic") {
    effectiveWritableRoots.push(path.join(effectiveHome, ".gemini", "antigravity-cli"));
  }
  const effectiveReadableRoots = [...(readableRoots ?? [cwd]), temporaryRoot];
  const effectiveArgs = providerManagedSandbox && !args.includes("--sandbox") ? [...args, "--sandbox"] : args;
  const enforceWriteBoundary = !providerManagedSandbox;
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", sandboxPolicy({ profileName, cwd, writableRoots: effectiveWritableRoots, readableRoots: effectiveReadableRoots, home: effectiveHome, deniedReadRoots, providerManagedSandbox, enforceWriteBoundary, allowLoopback }), command, ...effectiveArgs],
    env: sanitizedEnv,
    deadlineMs: profile.deadlineMs,
    maxOutputBytes: profile.maxOutputBytes,
    profileName,
    temporaryRoot,
  };
}
