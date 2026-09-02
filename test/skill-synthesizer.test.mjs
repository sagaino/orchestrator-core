import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  synthesizeSkillInstructions,
  registerSynthesizedSkill,
  synthesizeSkillFromCompletedTask,
} from "../src/skill-synthesizer.mjs";
import { readSkillRegistry } from "../src/skill-registry.mjs";

test("synthesizeSkillInstructions formats markdown correctly", () => {
  const md = synthesizeSkillInstructions({
    title: "Vite Tailwind Setup",
    purpose: "Setup Tailwind v4 with Vite",
    steps: ["Install @tailwindcss/vite", "Update vite.config.ts with tailwindcss plugin"],
    guidelines: ["Do not use deprecated postcss config"],
  });

  assert.match(md, /# Vite Tailwind Setup/);
  assert.match(md, /## Purpose/);
  assert.match(md, /## Execution Steps/);
  assert.match(md, /1\. Install @tailwindcss\/vite/);
  assert.match(md, /## Guidelines & Constraints/);
});

test("registerSynthesizedSkill registers a skill and updates registry.json atomically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-synth-test-"));
  const runsRoot = path.join(tempDir, "runs");
  fs.mkdirSync(path.join(runsRoot, "runtime", "skills"), { recursive: true });

  const instructionsText = synthesizeSkillInstructions({
    title: "Golang Fiber Auth Setup",
    purpose: "Middleware setup for JWT in Fiber",
    steps: ["Add middleware/jwt.go", "Wire into app.go"],
  });

  const result = registerSynthesizedSkill({
    runsRoot,
    skillId: "golang-fiber-jwt-auth",
    version: "1.0.0",
    purpose: "Middleware setup for JWT in Fiber",
    instructionsText,
    supportedRoles: ["BACKEND", "GENERAL"],
    humanInstaller: "local:sagaino",
  });

  assert.ok(result, "Should return registration result");
  assert.equal(result.skill.skillId, "golang-fiber-jwt-auth");
  assert.ok(fs.existsSync(result.instructionPath), "Instruction file must exist on disk");

  const registry = readSkillRegistry({ registryPath: result.registryPath, checkInstructions: true });
  assert.equal(registry.skills.length, 1);
  assert.equal(registry.skills[0].skillId, "golang-fiber-jwt-auth");
  assert.equal(registry.skills[0].instructions.sha256, result.checksum);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("synthesizeSkillFromCompletedTask synthesizes and registers skill from manifest", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-from-task-test-"));
  const runsRoot = path.join(tempDir, "runs");
  fs.mkdirSync(path.join(runsRoot, "runtime", "skills"), { recursive: true });

  const manifest = {
    runId: "run-complete-1",
    task: {
      id: "BE-001",
      title: "Implement User Authentication Endpoint",
      allowedPaths: ["src/auth/auth.go", "src/auth/jwt.go"],
    },
    project: {
      id: "be-golang-app",
      toolchain: "backend-golang",
    },
    execution: {
      agent: { role: "BACKEND" },
      scopeAudit: {
        changedPaths: ["src/auth/auth.go", "src/auth/jwt.go"],
      },
    },
  };

  const result = synthesizeSkillFromCompletedTask({
    manifest,
    runsRoot,
    humanInstaller: "local:sagaino",
  });

  assert.ok(result, "Should synthesize and register skill");
  assert.ok(result.skill.skillId.includes("be-001"));

  const registry = readSkillRegistry({ registryPath: result.registryPath, checkInstructions: true });
  assert.equal(registry.skills.length, 1);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
