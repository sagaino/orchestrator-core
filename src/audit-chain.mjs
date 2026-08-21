import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactSensitive } from "./redaction.mjs";

export function auditChainPath(runsRoot) { return path.join(runsRoot, "runtime", "operator-audit.jsonl"); }
function hashRecord(record) { return createHash("sha256").update(JSON.stringify(record)).digest("hex"); }

export function verifyAuditChain(runsRoot) {
  const filePath = auditChainPath(runsRoot);
  if (!fs.existsSync(filePath)) return { valid: true, entries: 0, head: null };
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let previousHash = null;
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try { record = JSON.parse(lines[index]); } catch { return { valid: false, entries: index, reason: `Invalid JSON at entry ${index + 1}` }; }
    const { hash, ...unsigned } = record;
    if (record.sequence !== index + 1 || record.previousHash !== previousHash || hash !== hashRecord(unsigned)) {
      return { valid: false, entries: index, reason: `Audit chain mismatch at entry ${index + 1}` };
    }
    previousHash = hash;
  }
  return { valid: true, entries: lines.length, head: previousHash };
}

export function appendAuditEntry(runsRoot, entry) {
  const state = verifyAuditChain(runsRoot);
  if (!state.valid) throw new Error(`Audit chain rusak: ${state.reason}`);
  const unsigned = redactSensitive({
    schemaVersion: 1,
    sequence: state.entries + 1,
    auditId: randomUUID(),
    at: new Date().toISOString(),
    previousHash: state.head,
    ...entry,
  });
  const record = { ...unsigned, hash: hashRecord(unsigned) };
  const filePath = auditChainPath(runsRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return record;
}
