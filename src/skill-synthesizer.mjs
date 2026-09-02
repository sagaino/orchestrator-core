import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  SKILL_SCHEMA_VERSION,
  SKILL_KIND,
  SKILL_REGISTRY_SCHEMA_VERSION,
  SKILL_REGISTRY_KIND,
  validateSkill,
  validateSkillRegistry,
  defaultSkillRegistryPath,
} from "./skill-registry.mjs";
import { redactText } from "./redaction.mjs";

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, redactText(content), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function sha256Content(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function synthesizeSkillInstructions({
  title = "Skill Procedure",
  purpose = "Automated skill synthesized from verified task execution",
  steps = [],
  guidelines = [],
  codeSnippets = [],
}) {
  const stepsSection = steps.length > 0
    ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "1. Inspect the target file and apply verified architectural patterns.";

  const guidelinesSection = guidelines.length > 0
    ? guidelines.map((g) => `- ${g}`).join("\n")
    : "- Always ensure all project-defined verification gates pass.";

  const snippetsSection = codeSnippets.length > 0
    ? codeSnippets.map((s) => `\`\`\`${s.language || "typescript"}\n${s.code}\n\`\`\``).join("\n\n")
    : "";

  return `# ${title}

## Purpose
${purpose}

## Execution Steps
${stepsSection}

## Guidelines & Constraints
${guidelinesSection}

${snippetsSection ? `## Code Examples\n${snippetsSection}\n` : ""}
`;
}

export function registerSynthesizedSkill({
  runsRoot,
  skillId,
  version = "1.0.0",
  purpose = "Automated skill procedure",
  instructionsText = "",
  supportedRoles = ["GENERAL"],
  supportedTaskTypes = ["TASK", "FEATURE"],
  requiredCapabilities = ["repository.write", "verification.run"],
  verificationRequirements = ["typecheck", "build"],
  compatibleProjectSignals = [],
  riskLevel = "LOW",
  humanInstaller = "local:sagaino",
  sourceRef = "auto-synthesis:task-execution",
}) {
  if (!runsRoot) throw new Error("runsRoot wajib diisi untuk registerSynthesizedSkill.");
  if (!skillId || typeof skillId !== "string") throw new Error("skillId wajib diisi.");

  const normalizedSkillId = skillId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 100);
  const registryPath = defaultSkillRegistryPath(runsRoot);
  const registryRoot = path.dirname(registryPath);

  // 1. Write instruction file
  const relativeInstructionPath = path.join("instructions", `${normalizedSkillId}.md`).split(path.sep).join("/");
  const absoluteInstructionPath = path.join(registryRoot, relativeInstructionPath);
  writeAtomic(absoluteInstructionPath, instructionsText);

  const checksum = sha256Content(instructionsText);

  // 2. Build skill document
  const skill = {
    schemaVersion: SKILL_SCHEMA_VERSION,
    kind: SKILL_KIND,
    skillId: normalizedSkillId,
    version,
    purpose,
    supportedRoles,
    supportedTaskTypes,
    requiredContextTypes: ["repository.ast"],
    requiredCapabilities,
    compatibleProjectSignals,
    riskLevel,
    instructions: {
      resourcePath: relativeInstructionPath,
      sha256: checksum,
    },
    verificationRequirements,
    enabled: true,
    provenance: {
      source: "LOCAL_HUMAN",
      humanInstaller,
      installedAt: new Date().toISOString(),
      sourceRef,
    },
  };

  const skillValidation = validateSkill(skill, { registryRoot, checkInstructions: true });
  if (!skillValidation.valid) {
    throw new Error(`Synthesized skill tidak valid: ${skillValidation.errors.join("; ")}`);
  }

  // 3. Load or initialize registry
  let registry = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    kind: SKILL_REGISTRY_KIND,
    revision: 1,
    agentWritable: false,
    updatedAt: new Date().toISOString(),
    skills: [],
  };

  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    } catch {}
  }

  const existingIndex = (registry.skills || []).findIndex(
    (s) => s.skillId === normalizedSkillId && s.version === version
  );

  if (existingIndex >= 0) {
    registry.skills[existingIndex] = skill;
  } else {
    registry.skills = [...(registry.skills || []), skill];
  }

  registry.revision = (Number(registry.revision) || 0) + 1;
  registry.updatedAt = new Date().toISOString();

  const registryValidation = validateSkillRegistry(registry, { registryRoot, checkInstructions: true });
  if (!registryValidation.valid) {
    throw new Error(`Skill registry tidak valid setelah registrasi skill: ${registryValidation.errors.join("; ")}`);
  }

  writeAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  return {
    skill,
    registryPath,
    instructionPath: absoluteInstructionPath,
    checksum,
  };
}

export function synthesizeSkillFromCompletedTask({
  manifest,
  runsRoot,
  humanInstaller = "local:sagaino",
}) {
  if (!manifest || !runsRoot) return null;
  const taskId = manifest.task?.id || "TASK";
  const taskTitle = manifest.task?.title || "Task Execution";
  const toolchain = manifest.project?.toolchain || manifest.project?.blueprint || "general";
  const changedPaths = manifest.execution?.scopeAudit?.changedPaths || manifest.task?.allowedPaths || [];

  if (changedPaths.length === 0) return null;

  const skillId = `skill-${toolchain}-${taskId.toLowerCase()}`;
  const purpose = `Synthesized procedural skill from successful task ${taskId}: ${taskTitle}`;
  const instructions = synthesizeSkillInstructions({
    title: `Skill: ${taskTitle}`,
    purpose,
    steps: [
      `Review target files: ${changedPaths.join(", ")}`,
      `Apply verified modifications following project standards (${toolchain})`,
      "Run verification suite and confirm zero regressions",
    ],
    guidelines: [
      `Scope must remain restricted to ${changedPaths.join(", ") || "allowed paths"}`,
      "Do not modify orchestrator lifecycle or runtime files",
    ],
  });

  return registerSynthesizedSkill({
    runsRoot,
    skillId,
    purpose,
    instructionsText: instructions,
    supportedRoles: [manifest.execution?.agent?.role || "GENERAL"],
    supportedTaskTypes: ["TASK", "FEATURE"],
    verificationRequirements: ["typecheck", "build"],
    humanInstaller,
    sourceRef: `run:${manifest.runId}`,
  });
}
