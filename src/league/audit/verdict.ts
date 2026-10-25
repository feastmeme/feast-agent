import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readJson, writeJsonAtomic } from "../store.ts";
import { auditSource, sha256Of, type StaticAudit } from "./static.ts";

/**
 * The audit's record for one exact file (PLAN.md §5.3): the static result, and
 * the model read the user's own agent made against the checklist. A script runs
 * only when both passed for the file's current sha256; any edit is a new file
 * and needs a new audit (and a new warm-up).
 *
 *   $FEAST_LEAGUE_HOME/audits/<sha256>.json
 */

export type ModelVerdict = { verdict: "pass" | "refuse"; notes: string; at: string };
export type AuditRecord = { sha256: string; file: string; static: StaticAudit; model: ModelVerdict | null };

export const auditPath = (home: string, sha256: string) => join(home, "audits", `${sha256}.json`);

export function auditFile(home: string, path: string, options: { maxTradeBnb?: number } = {}): AuditRecord {
  const file = resolve(path);
  const source = readFileSync(file, "utf8");
  const sha256 = sha256Of(source);
  const previous = readJson<AuditRecord>(auditPath(home, sha256));
  const record: AuditRecord = { sha256, file, static: auditSource(source, options), model: previous?.model ?? null };
  writeJsonAtomic(auditPath(home, sha256), record);
  return record;
}

/** The model read's verdict. It can only be recorded on a file that passed the static rules. */
export function recordModelVerdict(home: string, path: string, verdict: "pass" | "refuse", notes: string, options: { maxTradeBnb?: number } = {}): AuditRecord {
  const record = auditFile(home, path, options);
  if (record.static.verdict !== "pass" && verdict === "pass") throw new Error("the static rules refused this file: a model read cannot pass it");
  if (!notes.trim()) throw new Error("a model verdict needs its notes: the answers to the checklist");
  const next = { ...record, model: { verdict, notes: notes.trim().slice(0, 4_000), at: new Date().toISOString() } };
  writeJsonAtomic(auditPath(home, record.sha256), next);
  return next;
}

/** Why a script may not run, or null when its current bytes passed both stages. */
export function auditRefusal(home: string, path: string, alreadyRead?: string): string | null {
  let source: string;
  try {
    source = alreadyRead ?? readFileSync(resolve(path), "utf8");
  } catch {
    return `no script at ${path}`;
  }
  const record = readJson<AuditRecord>(auditPath(home, sha256Of(source)));
  if (!record) return "no audit for this file: run FL audit first";
  if (record.static.verdict !== "pass") return `the static rules refused this file (${record.static.hits.filter((h) => h.severity === "refuse").map((h) => `${h.rule} line ${h.line}`).join(", ")})`;
  if (!record.model) return "the static rules passed, but no model read is recorded for this file";
  if (record.model.verdict !== "pass") return "the model read refused this file";
  return null;
}
