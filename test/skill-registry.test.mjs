import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  SKILL_KIND,
  SKILL_REGISTRY_KIND,
  getInstalledSkill,
  listInstalledSkills,
  loadSkillInstructions,
  readSkillRegistry,
  resolveSkillRequest,
  validateSkill,
  validateSkillRegistry,
} from "../src/skill-registry.mjs";

console.log("Running skill-registry.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-"));
const registryPath = path.join(root, "runtime", "skills", "registry.json");
const instructionPath = path.join(root, "skills", "ui-review", "instructions.md");
const instructionText = "Review the UI evidence without changing the approved scope.\n";
fs.mkdirSync(path.dirname(registryPath), { recursive: true });
fs.mkdirSync(path.dirname(instructionPath), { recursive: true });
fs.writeFileSync(instructionPath, instructionText);
const instructionSha256 = createHash("sha256").update(instructionText).digest("hex");

const skill = {
  schemaVersion: 1,
  kind: SKILL_KIND,
  skillId: "ui-review",
  version: "1.2.0",
  purpose: "Review visual evidence and report bounded findings.",
  supportedRoles: ["REVIEW"],
  supportedTaskTypes: ["VISUAL_REVIEW"],
  requiredContextTypes: ["OBJECTIVE_EVIDENCE", "VISUAL_EVIDENCE"],
  requiredCapabilities: ["context.read", "repository.read"],
  compatibleProjectSignals: ["frontend", "browser"],
  riskLevel: "LOW",
  instructions: { resourcePath: "skills/ui-review/instructions.md", sha256: instructionSha256 },
  verificationRequirements: ["visual-evidence-present"],
  enabled: true,
  provenance: { source: "LOCAL_HUMAN", humanInstaller: "local:skill-admin", installedAt: "2026-08-23T00:00:00.000Z", sourceRef: "git:skill-ui-review@1.2.0" },
};

const registry = {
  schemaVersion: 1,
  kind: SKILL_REGISTRY_KIND,
  revision: 1,
  updatedAt: "2026-08-23T00:00:00.000Z",
  agentWritable: false,
  skills: [skill],
};

try {
  const emptyValidation = validateSkillRegistry({ ...registry, skills: [] }, { registryRoot: root });
  assert.equal(emptyValidation.valid, true);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  const loaded = readSkillRegistry({ registryPath, registryRoot: root });
  assert.equal(loaded.kind, SKILL_REGISTRY_KIND);
  assert.equal(listInstalledSkills({ registryPath, registryRoot: root }).length, 1);
  assert.equal(getInstalledSkill({ registryPath, registryRoot: root, skillId: "ui-review" }).version, "1.2.0");
  assert.equal(loadSkillInstructions({ registryPath, registryRoot: root, skillId: "ui-review" }).instructions, instructionText);
  assert.equal(resolveSkillRequest({ registryPath, registryRoot: root, skillId: "ui-review", requestedCapabilities: ["context.read"] }).skill.skillId, "ui-review");

  assert.throws(
    () => resolveSkillRequest({ registryPath, registryRoot: root, skillId: "ui-review", requestedCapabilities: ["network.outbound"] }),
    (error) => error.code === "SKILL_REQUEST_INVALID" && /unsupported requested capability/.test(error.message),
  );
  assert.throws(
    () => resolveSkillRequest({ registryPath, registryRoot: root, skillId: "ui-review", requestedCapabilities: ["verification.run"] }),
    (error) => error.code === "SKILL_REQUEST_INVALID" && /not declared/.test(error.message),
  );

  const disabled = { ...skill, enabled: false };
  fs.writeFileSync(registryPath, JSON.stringify({ ...registry, skills: [disabled] }, null, 2));
  assert.throws(
    () => resolveSkillRequest({ registryPath, registryRoot: root, skillId: "ui-review", requestedCapabilities: [], checkInstructions: false }),
    (error) => error.code === "SKILL_REQUEST_INVALID" && /disabled/.test(error.message),
  );
  assert.equal(readSkillRegistry({ registryPath, registryRoot: root }).skills[0].enabled, false);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  fs.writeFileSync(instructionPath, "tampered instructions\n");
  assert.throws(
    () => readSkillRegistry({ registryPath, registryRoot: root }),
    (error) => error.code === "SKILL_REGISTRY_INVALID" && /checksum mismatch/.test(error.message),
  );
  fs.writeFileSync(instructionPath, instructionText);

  assert.equal(validateSkill({ ...skill, version: "1.2" }, { registryRoot: root, checkInstructions: false }).valid, false);
  assert.equal(validateSkill({ ...skill, requiredCapabilities: ["tool.unknown"] }, { registryRoot: root, checkInstructions: false }).valid, false);
  assert.equal(validateSkill({ ...skill, provenance: { ...skill.provenance, source: "WIKI" } }, { registryRoot: root, checkInstructions: false }).valid, false);
  assert.equal(validateSkill({ ...skill, instructions: { resourcePath: "../outside.md", sha256: instructionSha256 } }, { registryRoot: root, checkInstructions: false }).valid, false);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-outside-"));
  const outsideInstructions = path.join(outsideRoot, "outside-instructions.md");
  fs.writeFileSync(outsideInstructions, instructionText);
  const symlinkPath = path.join(root, "skills", "ui-review", "symlink.md");
  try {
    fs.symlinkSync(outsideInstructions, symlinkPath);
    assert.equal(validateSkill({ ...skill, instructions: { resourcePath: "skills/ui-review/symlink.md", sha256: instructionSha256 } }, { registryRoot: root }).valid, false);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
  }
  fs.rmSync(outsideRoot, { recursive: true, force: true });
  assert.equal(validateSkillRegistry({ ...registry, agentWritable: true }, { registryRoot: root, checkInstructions: false }).valid, false);
  assert.equal(validateSkillRegistry({ ...registry, skills: [{ ...skill, skillId: "ui-review", version: "1.2.0" }, { ...skill, skillId: "ui-review", version: "1.2.0" }] }, { registryRoot: root, checkInstructions: false }).valid, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("skill-registry.test.mjs: All tests passed!");
