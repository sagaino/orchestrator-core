import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  formatDebuggingMarkdown,
  harvestRecoveryDebuggingKnowledge,
  harvestFeedbackConstraints,
} from "../src/knowledge-harvester.mjs";

test("formatDebuggingMarkdown formats markdown with valid YAML frontmatter and sections", () => {
  const debugging = {
    title: "Fix Tailwind Directives in Vite",
    symptom: "@tailwind base; is not recognized in postcss",
    rootCause: "Tailwind v4 deprecates @tailwind directives in favor of @import 'tailwindcss';",
    targetedFiles: ["src/index.css", "vite.config.ts"],
    verifiedFix: "Replaced @tailwind with @import 'tailwindcss';",
    diffSnippet: "-@tailwind base;\n+@import 'tailwindcss';",
    tags: ["debugging", "tailwind", "vite"],
    confidence: 0.95,
  };

  const md = formatDebuggingMarkdown({
    debugging,
    destination: "WIKI",
    sourcePath: "03-Sources/other/test.json",
    harvestId: "harvest-test-1",
  });

  assert.match(md, /^---/);
  assert.match(md, /title: "Fix Tailwind Directives in Vite"/);
  assert.match(md, /type: debugging/);
  assert.match(md, /tags: \[debugging, tailwind, vite\]/);
  assert.match(md, /## 1\. Gejala Error \(Symptom\)/);
  assert.match(md, /## 2\. Akar Masalah \(Root Cause\)/);
  assert.match(md, /## 4\. Solusi Terverifikasi \(Verified Fix\)/);
  assert.match(md, /## Verified Diff \/ Patch Snippet/);
});

test("harvestRecoveryDebuggingKnowledge generates and persists debugging knowledge from recovered manifest", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-debug-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  fs.mkdirSync(path.join(vaultRoot, "01-Knowledge", "debugging"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "03-Sources", "other", "orchestrator-runs"), { recursive: true });

  const manifest = {
    runId: "run-test-recovery-1",
    task: {
      id: "FE-001",
      title: "Update Tailwind Styles",
      allowedPaths: ["src/index.css"],
    },
    project: {
      id: "starter-app",
      toolchain: "frontend-vite",
      repository: "/path/to/repo",
    },
    execution: {
      automaticRecovery: {
        status: "SUCCESS",
        strategy: "AI_REPAIR",
        trigger: "Build failed: Tailwind directive error",
        attempts: [{ attempt: 1 }],
      },
      latestDiff: "-@tailwind base;\n+@import 'tailwindcss';",
      scopeAudit: {
        changedPaths: ["src/index.css"],
      },
    },
  };

  const result = harvestRecoveryDebuggingKnowledge({
    manifest,
    vaultRoot,
  });

  assert.ok(result, "Harvester should return a result object");
  assert.equal(result.destination, "WIKI");
  assert.ok(result.relativePath.startsWith("01-Knowledge/debugging/"));

  const fullTarget = path.join(vaultRoot, result.relativePath);
  assert.ok(fs.existsSync(fullTarget), "Debugging markdown file should be written to disk");

  const fileContent = fs.readFileSync(fullTarget, "utf8");
  assert.match(fileContent, /type: debugging/);
  assert.match(fileContent, /Build failed: Tailwind directive error/);
  assert.match(fileContent, /src\/index\.css/);

  // Check index.md and wiki-log.md
  const indexContent = fs.readFileSync(path.join(vaultRoot, "index.md"), "utf8");
  assert.match(indexContent, /## Orchestrator Harvested Knowledge/);

  const wikiLogContent = fs.readFileSync(path.join(vaultRoot, "wiki-log.md"), "utf8");
  assert.match(wikiLogContent, /harvest: 01-Knowledge\/debugging\//);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("harvestFeedbackConstraints persists operator constraints into decisions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-feedback-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  fs.mkdirSync(path.join(vaultRoot, "01-Knowledge", "decisions"), { recursive: true });

  const result = harvestFeedbackConstraints({
    feedback: "Jangan gunakan useEffect untuk data fetching, selalu gunakan React Query.",
    task: { id: "FE-002", title: "Fetch User Profile" },
    project: { id: "starter-app" },
    vaultRoot,
    requestedBy: "local:sagaino",
  });

  assert.ok(result, "Feedback harvester should return a result object");
  assert.ok(result.relativePath.startsWith("01-Knowledge/decisions/"));

  const fullTarget = path.join(vaultRoot, result.relativePath);
  assert.ok(fs.existsSync(fullTarget), "Decision file should be created");

  const content = fs.readFileSync(fullTarget, "utf8");
  assert.match(content, /type: decision/);
  assert.match(content, /Jangan gunakan useEffect untuk data fetching/);
  assert.match(content, /Operator Constraint for starter-app/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
