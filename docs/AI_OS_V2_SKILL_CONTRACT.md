# Personal AI OS v2 Skill Contract

Status: **V2-100 CONTRACT**  
Source plan: [AI OS v2 Orchestration Implementation Plan](./AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md)

## 1. Purpose

A skill is a human-managed, versioned instruction package that may be selected
for a later orchestration node. It is not an agent, approval, connector, or
permission grant. V2-100 defines the package and registry boundary; selection
and routing are implemented by V2-101 and V2-102.

The registry may be empty. An empty registry is a valid state and must not
block the existing general role agent fallback.

## 2. Skill package

Every skill has the following fields:

| Field | Contract |
|---|---|
| `skillId` | Stable lowercase identifier matching `^[a-z0-9][a-z0-9._-]{1,127}$`. |
| `version` | Strict semantic version, for example `1.0.0` or `1.2.0-beta.1`. |
| `purpose` | Human-readable purpose. |
| `supportedRoles` | Non-empty role identifiers. |
| `supportedTaskTypes` | Non-empty task type identifiers. |
| `requiredContextTypes` | Context classes the skill expects. |
| `requiredCapabilities` | Known capability identifiers only. Unknown tools fail closed. |
| `compatibleProjectSignals` | Project signal labels used by later compatibility routing. |
| `riskLevel` | `LOW`, `MEDIUM`, `HIGH`, or `UNKNOWN`. |
| `instructions` | Relative resource path plus lowercase SHA-256 checksum. |
| `verificationRequirements` | Non-empty verification labels/commands. |
| `enabled` | Human-controlled eligibility flag. |
| `provenance` | Source, human installer, install timestamp, and source reference. |

The canonical machine schemas are `schemas/skill.schema.json` and
`schemas/skill-registry.schema.json`.

## 3. Registry boundary

The registry has `agentWritable: false`, a monotonic revision, and a list of
unique `skillId@version` entries. The runtime loader validates the complete
registry before returning any skill. A malformed registry, unsupported schema
version, invalid semver, missing instruction resource, or checksum mismatch
is rejected fail-closed.

The V2-100 module exports read and verification operations only. It does not
install, edit, enable, disable, update, or delete skills. Those actions require
a separate human-confirmed workflow.

## 4. Capability and instruction rules

The accepted capability vocabulary is deliberately bounded:

`context.read`, `repository.read`, `repository.write`, `verification.run`,
`preview.read`, `browser.capture`, `knowledge.read`, and `knowledge.propose`.

A request for an unknown capability, or a capability not declared by the
selected skill, is rejected. A skill checksum is verified immediately before
instructions are loaded. The resource must be a regular file inside the
registry root; absolute paths, traversal, and symlink escapes are rejected.

Skills cannot broaden the node's approved paths, tools, model tier,
verification, budget, or approval authority. Those constraints remain owned by
the orchestrator and later plan/router gates.

## 5. Provenance and Wiki boundary

Allowed skill sources are `BUNDLED` and `LOCAL_HUMAN`. The installer must be a
human identity; `agent`, `model`, `system`, and `skill-router` identities are
rejected. Wiki/knowledge content is context only. A Wiki page, knowledge
candidate, or knowledge reference cannot be registered as a skill source or
reclassified by adding skill metadata.

## 6. Empty registry behavior

An empty registry is valid. V2-102 will return `NO_COMPATIBLE_SKILL` and use the
existing general role agent fallback, or create a human decision when policy
requires a specialized skill. The system never installs a skill automatically
and never lowers safety constraints to compensate for an empty registry.
