import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildStageContext, contextBudget, selectBoundedKnowledge } from "../src/context-compactor.mjs";
import { captureWorkspaceDiff } from "../src/executor.mjs";

console.log("Running context-compactor.test.mjs...");

const knowledge = [
  { path: "01-Knowledge/relevant.md", title: "Relevant", summary: "Use the stable adapter contract." },
  { path: "01-Knowledge/unrelated.md", title: "Unrelated", summary: "This history must not be selected." },
];
const packed = buildStageContext({
  stage: "revision",
  acceptanceCriteria: ["Acceptance criterion: preserve the approval gate."],
  latestFeedback: "Latest feedback: retain the reviewer correction exactly.",
  latestDiff: "diff --git a/src/core.mjs b/src/core.mjs\n+const relevant = true;",
  revisionState: { iteration: 2, status: "CHANGES_REQUESTED" },
  allowedPaths: ["src/core.mjs"],
  graphifyContext: "Graphify delta: src/core.mjs depends on src/security.mjs.",
  knowledge,
});

assert.equal(packed.budgetTokens, contextBudget("revision"));
assert.ok(packed.estimatedTokens <= packed.budgetTokens);
assert.match(packed.text, /Acceptance criterion: preserve the approval gate/);
assert.match(packed.text, /Latest feedback: retain the reviewer correction exactly/);
assert.match(packed.text, /src\/core\.mjs/);
assert.match(packed.text, /Graphify delta/);
assert.doesNotMatch(packed.text, /This history must not be selected/);
assert.equal(selectBoundedKnowledge(knowledge, 1)[0].path, "01-Knowledge/relevant.md");
assert.equal(selectBoundedKnowledge([
  { path: "01-Knowledge/too-large.md", score: 99, summary: "x".repeat(900) },
  ...knowledge,
], 1, 500)[0].path, "01-Knowledge/relevant.md");

const tiny = buildStageContext({
  stage: "intake",
  acceptanceCriteria: ["MUST-RETAIN acceptance"],
  latestFeedback: "MUST-RETAIN latest feedback",
  latestDiff: "unrelated diff ".repeat(1000),
  allowedPaths: ["src/a.mjs"],
});
assert.ok(tiny.estimatedTokens <= contextBudget("intake"));
assert.match(tiny.text, /MUST-RETAIN acceptance/);
assert.match(tiny.text, /MUST-RETAIN latest feedback/);

const repository = fs.mkdtempSync(path.join(os.tmpdir(), "context-diff-"));
execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "context-test@example.invalid"], { cwd: repository });
execFileSync("git", ["config", "user.name", "Context Test"], { cwd: repository });
fs.writeFileSync(path.join(repository, "README.md"), "baseline\n");
execFileSync("git", ["add", "README.md"], { cwd: repository });
execFileSync("git", ["commit", "-m", "baseline"], { cwd: repository, stdio: "ignore" });
fs.writeFileSync(path.join(repository, "README.md"), "latest\n");
assert.match(captureWorkspaceDiff(repository, "HEAD", ["README.md"]), /\+latest/);

console.log("context-compactor.test.mjs: All tests passed!");
