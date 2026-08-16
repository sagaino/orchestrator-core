import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function collectRtkAnalytics() {
  try {
    const { stdout } = await execFileAsync("rtk", ["gain", "-f", "json"], {
      encoding: "utf8",
      timeout: 5000,
    });

    const parsed = JSON.parse(stdout);
    const summary = parsed.summary || {};

    const totalInputTokens = summary.total_input ?? 0;
    const totalOutputTokens = summary.total_output ?? 0;
    const totalSavedTokens = summary.total_saved ?? 0;
    const savingsPercentage = summary.avg_savings_pct ? Number(summary.avg_savings_pct.toFixed(1)) : 0;
    const totalCommands = summary.total_commands ?? 0;
    const totalTimeMs = summary.total_time_ms ?? 0;

    return {
      available: true,
      service: "rtk-rust-token-killer",
      summary: {
        totalCommands,
        totalInputTokens,
        totalOutputTokens,
        totalSavedTokens,
        savingsPercentage,
        totalTimeMs,
        avgTimeMs: summary.avg_time_ms ?? 0,
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      available: false,
      service: "rtk-rust-token-killer",
      summary: {
        totalCommands: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalSavedTokens: 0,
        savingsPercentage: 0,
        totalTimeMs: 0,
        avgTimeMs: 0,
      },
      error: err.message,
      generatedAt: new Date().toISOString(),
    };
  }
}
