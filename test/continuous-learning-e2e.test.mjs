import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createAiOsE2eHarness } from "./helpers/ai-os-e2e-fixture.mjs";
import { executeRun } from "../src/executor.mjs";
import { startTaskRun, requestChangesTaskRun } from "../src/task-workflow.mjs";
import { acceptRun, retrospectRun } from "../src/knowledge-workflow.mjs";
import { getRun, RUN_STATES } from "../src/run-manager.mjs";
import { readMarkdown, buildContext, buildPlan } from "../src/core.mjs";
import { validateTaskReadiness } from "../src/task-readiness.mjs";
import { buildStageContext } from "../src/context-compactor.mjs";
import { synthesizeSkillFromCompletedTask } from "../src/skill-synthesizer.mjs";
import { readSkillRegistry } from "../src/skill-registry.mjs";

console.log("Running continuous-learning-e2e.test.mjs (End-to-End Self-Learning Lifecycle)...");

const harness = await createAiOsE2eHarness();
const taskServices = { readMarkdown, buildContext, buildPlan, validateTaskReadiness };

async function localProcessRunner(invocation) {
  try {
    const stdout = execFileSync(invocation.command, invocation.args ?? [], {
      cwd: invocation.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdoutTail: stdout ?? "", stderrTail: "", finalResult: null };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.status) ? error.status : 1,
      stdoutTail: String(error.stdout ?? ""),
      stderrTail: String(error.stderr ?? error.message ?? ""),
      finalResult: null,
    };
  }
}

try {
  // =========================================================================
  // SCENARIO 1: TASK WITH RECOVERY -> AUTO-HARVESTING -> OBSIDIAN WIKI SYNC
  // =========================================================================
  console.log("  [E2E Step 1] Creating task with verification error and automatic recovery...");
  const task1RelPath = "src/components/button.tsx";
  let verificationAttempt = 0;

  const recoveryExecutor = (options) => executeRun({
    ...options,
    maxAutomaticRecoveryAttempts: 1,
    workspaceProcessRunner: localProcessRunner,
    dependencyReconciler: async () => ({ skipped: true, reason: "Fixture dependencies are frozen." }),
    agentInvocationBuilder: () => ({ command: "fixture-agent", args: [] }),
    recoveryInvocationBuilder: (manifest, vaultRoot, { repository }) => {
      const target = path.join(repository, task1RelPath);
      fs.writeFileSync(target, "export const Button = () => <button>Fixed Button</button>;\n");
      return { command: "fixture-recovery-agent", args: [] };
    },
    processRunner: async (invocation) => {
      if (String(invocation.stage).includes("coding-agent")) {
        const target = path.join(invocation.cwd, task1RelPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Initial agent introduces a broken syntax
        fs.writeFileSync(target, "export const Button = () => <button broken syntax;\n");
        return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: { status: "ok" } };
      }
      if (String(invocation.stage).includes("automatic-recovery")) {
        return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: { status: "recovered", fixed: true } };
      }
      if (String(invocation.stage).startsWith("baseline-verification")) {
        return { exitCode: 0, stdoutTail: "[]", stderrTail: "", finalResult: null };
      }
      if (String(invocation.stage).startsWith("verification:")) {
        verificationAttempt += 1;
        // First verification fails (triggering recovery), second passes
        if (verificationAttempt === 1) {
          const findings = [{
            filePath: path.join(invocation.cwd, task1RelPath),
            messages: [{ ruleId: "syntax/unexpected-token", severity: 2, line: 1, column: 1, message: "TS1005: Unexpected token in button.tsx" }],
          }];
          return { exitCode: 1, stdoutTail: JSON.stringify(findings), stderrTail: "TS1005: Unexpected token in button.tsx", finalResult: null };
        }
        return { exitCode: 0, stdoutTail: "[]", stderrTail: "", finalResult: null };
      }
      return { exitCode: 0, stdoutTail: "", stderrTail: "", finalResult: null };
    },
  });

  const task1VaultDir = path.join(harness.vaultRoot, "02-Projects", "frontend-app", "tasks");
  fs.mkdirSync(task1VaultDir, { recursive: true });
  fs.writeFileSync(
    path.join(task1VaultDir, "FE-001.md"),
    `---
title: "Create Button Component"
type: task
tags: [task, frontend]
created: 2026-08-14
updated: 2026-08-14
task_id: FE-001
project: frontend-app
status: BACKLOG
dependencies: []
verification: [lint]
allowed_paths: [src/components/button.tsx]
requires_changes: true
---

# Create Button Component

## Instruksi
Implementasikan komponen button UI yang reusable di file \`src/components/button.tsx\`.

## Hasil yang Diharapkan
Komponen Button dapat dirender dengan benar dan mengekspor variabel Button.

## Acceptance Criteria
- File \`src/components/button.tsx\` dibuat dan tervalidasi.
- Seluruh verifikasi linting lolos tanpa error.
`,
    "utf8"
  );

  const task1Result = await startTaskRun({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    projectId: "frontend-app",
    taskInput: "FE-001",
    approvedBy: "local:sagaino",
    services: taskServices,
    executor: recoveryExecutor,
    retrospective: (retrospectiveOptions) => retrospectRun({
      ...retrospectiveOptions,
      proposalGenerator: async () => ({
        classification: "PROJECT_ONLY",
        confidence: 0.95,
        title: "Button Component Fix",
        type: "snippet",
        targetPath: null,
        summary: "Button component recovered successfully.",
        rationale: "Self-learning verification.",
        considerations: [],
        relatedKnowledge: [],
      }),
    }),
  });

  assert.equal(task1Result.state, RUN_STATES.RETROSPECTIVE, "Task 1 should complete to RETROSPECTIVE");
  assert.equal(task1Result.execution?.automaticRecovery?.status, "SUCCESS", "Automatic recovery must succeed");

  // Accept task 1 and sync to wiki
  console.log("  [E2E Step 2] Accepting Task 1 to trigger Closed-Loop Knowledge Sync...");
  const task1Accepted = await acceptRun({
    vaultRoot: harness.vaultRoot,
    runsRoot: harness.runsRoot,
    runId: task1Result.runId,
    approvedBy: "local:sagaino",
  });

  assert.equal(task1Accepted.state, RUN_STATES.DONE, "Task 1 must transition to DONE");

  // Verify that Debugging Knowledge was automatically created in Obsidian Vault
  const debugDir = path.join(harness.vaultRoot, "01-Knowledge", "debugging");
  assert.ok(fs.existsSync(debugDir), "01-Knowledge/debugging directory must exist");
  const debugFiles = fs.readdirSync(debugDir).filter((f) => f.endsWith(".md"));
  assert.ok(debugFiles.length >= 1, "A new debugging knowledge file must be automatically harvested");

  const debugContent = fs.readFileSync(path.join(debugDir, debugFiles[0]), "utf8");
  assert.match(debugContent, /type: debugging/);
  assert.match(debugContent, /TS1005: Unexpected token/);
  assert.match(debugContent, /src\/components\/button\.tsx/);
  console.log(`  ✓ Debugging note automatically created: 01-Knowledge/debugging/${debugFiles[0]}`);

  // Check index.md and wiki-log.md
  const indexContent = fs.readFileSync(path.join(harness.vaultRoot, "index.md"), "utf8");
  assert.match(indexContent, /## Orchestrator Harvested Knowledge/);
  const wikiLogContent = fs.readFileSync(path.join(harness.vaultRoot, "wiki-log.md"), "utf8");
  assert.match(wikiLogContent, /harvest: 01-Knowledge\/debugging\//);
  console.log("  ✓ Wiki index and log updated with provenance trail");

  // =========================================================================
  // SCENARIO 2: OPERATOR REQUEST CHANGES -> DECISION CONSTRAINT HARVESTING
  // =========================================================================
  console.log("  [E2E Step 3] Testing Operator Feedback Constraint Distillation...");
  const { harvestFeedbackConstraints } = await import("../src/knowledge-harvester.mjs");
  const decisionResult = harvestFeedbackConstraints({
    feedback: "Wajib gunakan ButtonProps interface dan Tailwind cva helper.",
    task: task1Accepted.task,
    project: task1Accepted.project,
    vaultRoot: harness.vaultRoot,
    requestedBy: "local:sagaino",
  });

  assert.ok(decisionResult, "Operator feedback constraint must be returned");
  const decisionsDir = path.join(harness.vaultRoot, "01-Knowledge", "decisions");
  assert.ok(fs.existsSync(decisionsDir), "01-Knowledge/decisions directory must exist");
  const decisionFiles = fs.readdirSync(decisionsDir).filter((f) => f.endsWith(".md"));
  assert.ok(decisionFiles.length >= 1, "Operator constraint decision file must be created");

  const decisionContent = fs.readFileSync(path.join(decisionsDir, decisionFiles[0]), "utf8");
  assert.match(decisionContent, /type: decision/);
  assert.match(decisionContent, /Wajib gunakan ButtonProps interface/);
  console.log(`  ✓ Operator constraint captured in 01-Knowledge/decisions/${decisionFiles[0]}`);

  // =========================================================================
  // SCENARIO 3: PRE-FLIGHT CONTEXT PRIMING (RECALL ON SUBSEQUENT TASK)
  // =========================================================================
  console.log("  [E2E Step 4] Testing Pre-Flight Context Priming on new incoming task...");
  const task2Context = buildStageContext({
    stage: "implementation",
    task: {
      id: "FE-002",
      title: "Refactor Button Component Styles",
      allowedPaths: ["src/components/button.tsx"],
    },
    project: {
      id: "frontend-app",
      toolchain: "frontend-vite",
    },
    vaultRoot: harness.vaultRoot,
  });

  assert.match(task2Context.text, /=== VERIFIED LESSONS & PAST DEBUGGING ===/, "Context must contain self-learning section");
  assert.match(task2Context.text, /TS1005: Unexpected token|Button/i, "Context must recall button debugging lesson");
  assert.match(task2Context.text, /Operator Constraint for frontend-app/i, "Context must recall operator decision constraint");
  console.log("  ✓ Pre-flight primer successfully injected past lessons & constraints into prompt!");

  // =========================================================================
  // SCENARIO 4: AUTO-SKILL SYNTHESIS & REGISTRY INTEGRATION
  // =========================================================================
  console.log("  [E2E Step 5] Testing Auto-Skill Synthesis and Registry validation...");
  const skillSynthesisResult = synthesizeSkillFromCompletedTask({
    manifest: task1Accepted,
    runsRoot: harness.runsRoot,
    humanInstaller: "local:sagaino",
  });

  assert.ok(skillSynthesisResult, "Skill synthesis must return valid result");
  assert.ok(fs.existsSync(skillSynthesisResult.instructionPath), "Synthesized SKILL.md instruction must exist");

  const registry = readSkillRegistry({
    registryPath: skillSynthesisResult.registryPath,
    checkInstructions: true,
  });

  assert.ok(registry.skills.length >= 1, "Registry must contain synthesized skill");
  const registeredSkill = registry.skills.find((s) => s.skillId === skillSynthesisResult.skill.skillId);
  assert.ok(registeredSkill, "Synthesized skill must be present in registry.json");
  assert.equal(registeredSkill.enabled, true);
  assert.equal(registeredSkill.instructions.sha256, skillSynthesisResult.checksum);
  console.log(`  ✓ Auto-Skill ${registeredSkill.skillId} registered with verified SHA-256: ${registeredSkill.instructions.sha256.slice(0, 16)}...`);

  console.log("\n🎉 ALL CONTINUOUS LEARNING E2E TESTS PASSED SUCCESSFULLY!\n");
} finally {
  await harness.cleanup();
}
