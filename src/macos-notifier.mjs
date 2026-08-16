import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..");
const sourcePath = path.join(projectRoot, "native", "macos-notifier", "main.swift");
const infoPlistPath = path.join(projectRoot, "native", "macos-notifier", "Info.plist");
const executableName = "personal-ai-orchestrator-notifier";

export function macOsNotifierPaths(runsRoot) {
  const appPath = path.join(runsRoot, "runtime", "Personal AI Orchestrator.app");
  return {
    appPath,
    executablePath: path.join(appPath, "Contents", "MacOS", executableName),
    infoPlistPath: path.join(appPath, "Contents", "Info.plist"),
  };
}

function sourceModifiedAt() {
  return Math.max(fs.statSync(sourcePath).mtimeMs, fs.statSync(infoPlistPath).mtimeMs);
}

function installedNotifierIsCurrent(paths) {
  if (!fs.existsSync(paths.executablePath) || !fs.existsSync(paths.infoPlistPath)) return false;
  return Math.min(
    fs.statSync(paths.executablePath).mtimeMs,
    fs.statSync(paths.infoPlistPath).mtimeMs,
  ) >= sourceModifiedAt();
}

export async function ensureMacOsNotifierApp({ runsRoot, runner = execFileAsync } = {}) {
  if (!runsRoot) throw new Error("runsRoot diperlukan untuk membangun macOS notifier.");
  const paths = macOsNotifierPaths(runsRoot);
  if (installedNotifierIsCurrent(paths)) return { ...paths, built: false };

  const runtimeRoot = path.dirname(paths.appPath);
  const temporaryAppPath = path.join(runtimeRoot, `.Personal AI Orchestrator.${randomUUID()}.app`);
  const temporaryExecutable = path.join(temporaryAppPath, "Contents", "MacOS", executableName);
  fs.mkdirSync(path.dirname(temporaryExecutable), { recursive: true });
  fs.copyFileSync(infoPlistPath, path.join(temporaryAppPath, "Contents", "Info.plist"));
  try {
    await runner("xcrun", [
      "swiftc",
      sourcePath,
      "-o",
      temporaryExecutable,
      "-framework",
      "AppKit",
      "-framework",
      "UserNotifications",
    ], { encoding: "utf8", timeout: 60_000 });
    await runner("codesign", ["--force", "--sign", "-", temporaryAppPath], {
      encoding: "utf8",
      timeout: 30_000,
    });

    fs.mkdirSync(runtimeRoot, { recursive: true });
    if (fs.existsSync(paths.appPath)) {
      const previousPath = `${paths.appPath}.previous`;
      if (fs.existsSync(previousPath)) fs.rmSync(previousPath, { recursive: true });
      fs.renameSync(paths.appPath, previousPath);
    }
    fs.renameSync(temporaryAppPath, paths.appPath);
    return { ...paths, built: true };
  } catch (error) {
    if (fs.existsSync(temporaryAppPath)) fs.rmSync(temporaryAppPath, { recursive: true });
    throw error;
  }
}

export async function runMacOsNotifier(notification, {
  runsRoot,
  runner = execFileAsync,
  appBuilder = ensureMacOsNotifierApp,
} = {}) {
  const notifier = await appBuilder({ runsRoot });
  if (notifier.built) {
    await runner("open", ["-W", "-n", "-g", notifier.appPath, "--args", "--register-only"], {
      encoding: "utf8",
      timeout: 120_000,
    });
  }
  try {
    const { stdout = "" } = await runner(notifier.executablePath, [
      "--identifier", notification.notificationId,
      "--title", notification.title,
      "--subtitle", notification.subtitle || "Personal AI Orchestrator",
      "--message", notification.message,
    ], { encoding: "utf8", timeout: 30_000 });
    const lastLine = String(stdout).trim().split("\n").filter(Boolean).at(-1);
    const result = lastLine ? JSON.parse(lastLine) : { status: "ACCEPTED" };
    return { ...result, appPath: notifier.appPath };
  } catch (error) {
    const lastLine = String(error.stdout ?? "").trim().split("\n").filter(Boolean).at(-1);
    if (lastLine) {
      try {
        const result = JSON.parse(lastLine);
        throw Object.assign(new Error(result.reason || "macOS notification ditolak."), { code: result.status });
      } catch (parseError) {
        if (parseError.code) throw parseError;
      }
    }
    throw error;
  }
}
