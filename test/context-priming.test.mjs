import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  retrieveRelevantPastExperience,
  buildStageContext,
} from "../src/context-compactor.mjs";

test("retrieveRelevantPastExperience correctly matches debugging notes and constraints", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-priming-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const debugDir = path.join(vaultRoot, "01-Knowledge", "debugging");
  const decisionsDir = path.join(vaultRoot, "01-Knowledge", "decisions");
  fs.mkdirSync(debugDir, { recursive: true });
  fs.mkdirSync(decisionsDir, { recursive: true });

  // 1. Create a relevant debugging file
  fs.writeFileSync(
    path.join(debugDir, "fix-tailwind-error.md"),
    `---
title: "Fix Tailwind Directive Error"
type: debugging
tags: [debugging, tailwind, css]
---
# Fix Tailwind Directive Error
## 1. Gejala Error (Symptom)
@tailwind is not recognized.
## 4. Solusi Terverifikasi (Verified Fix)
Gunakan @import 'tailwindcss'; di src/index.css.
`,
    "utf8"
  );

  // 2. Create a relevant decision file
  fs.writeFileSync(
    path.join(decisionsDir, "starter-app-decision.md"),
    `---
title: "Operator Constraint for starter-app"
type: decision
tags: [decision, starter-app]
---
# Operator Constraint
## 2. Aturan & Batasan Wajib
Wajib gunakan React Query untuk state remote.
`,
    "utf8"
  );

  // 3. Create an unrelated file
  fs.writeFileSync(
    path.join(debugDir, "unrelated-golang-db.md"),
    `---
title: "Fix Golang GORM Postgres Connection"
type: debugging
tags: [golang, postgres, gorm]
---
# Golang GORM
## 4. Solusi Terverifikasi
Set max idle connections to 10.
`,
    "utf8"
  );

  const matched = retrieveRelevantPastExperience({
    task: {
      title: "Update Tailwind CSS Stylesheet",
      allowedPaths: ["src/index.css"],
    },
    project: {
      id: "starter-app",
      toolchain: "frontend-vite",
    },
    vaultRoot,
  });

  assert.ok(matched.length >= 1, "Should find at least 1 relevant past experience");
  const titles = matched.map((m) => m.title);
  assert.ok(titles.includes("Fix Tailwind Directive Error"), "Should match Tailwind debugging note");
  assert.ok(titles.includes("Operator Constraint for starter-app"), "Should match starter-app constraint");
  assert.ok(!titles.includes("Fix Golang GORM Postgres Connection"), "Should not match unrelated Golang note");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("buildStageContext injects VERIFIED LESSONS & PAST DEBUGGING when vaultRoot has matches", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-context-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const debugDir = path.join(vaultRoot, "01-Knowledge", "debugging");
  fs.mkdirSync(debugDir, { recursive: true });

  fs.writeFileSync(
    path.join(debugDir, "fix-jwt-cookie.md"),
    `---
title: "Fix JWT Cookie Flag"
type: debugging
tags: [jwt, cookie, auth]
---
# Fix JWT Cookie
## 4. Solusi Terverifikasi
Set SameSite to Lax for localhost cookie session.
`,
    "utf8"
  );

  const contextPack = buildStageContext({
    stage: "implementation",
    task: {
      title: "Setup JWT Auth Cookie Handler",
      allowedPaths: ["src/auth/cookie.ts"],
    },
    project: {
      id: "be-golang-app",
    },
    vaultRoot,
  });

  assert.match(contextPack.text, /=== VERIFIED LESSONS & PAST DEBUGGING ===/);
  assert.match(contextPack.text, /Fix JWT Cookie Flag/);
  assert.match(contextPack.text, /Set SameSite to Lax/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
