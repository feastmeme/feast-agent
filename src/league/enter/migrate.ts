import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { saveAgent, type AgentConfig } from "../agent.ts";
import { recordedAgentId } from "../notes/session.ts";
import { pitLabel } from "../pit.ts";
import { readPrompt } from "../prompt/host.ts";
import type { Lang } from "../register/copy.ts";
import { agentPaths, appendJsonl, readJson, writeJsonAtomic } from "../store.ts";
import { keptPit } from "../support.ts";
import { SHIPPED_DEFAULTS, type ShippedDefault } from "./shipped.ts";
import { DEFAULT_STRATEGY_TITLE, DEFAULT_STRATEGY_VERSION, PERSONAS, PERSONA_TEXT, defaultStrategy, defaultStrategyPath, matchDefault, personaOf, type PersonaKey } from "./strategy.ts";

/**
 * Untouched defaults move to the new one (task 975, run 26; the owner's ruling 12:3x, amendment C). On start, a seat whose
 * strategy file is, byte for byte, a default an earlier runtime shipped (v1, v1.1, v1.2; either language; any style;
 * with this seat's own `<id>`, `<persona>` and any one line at `<pit>`) gets the current default in the same language
 * and style; the old file is kept beside it (`<file>.default-<version>`) and `FL strategy restore <name>` puts it back.
 * The seat's card follows the file (its prompt's sha256) only when the card was on the old file: that is the owner's
 * ruling standing in for a new yes, for an unedited default only. A file with any byte changed is the player's own: it
 * is never touched, and FL status says a new default is out. A running agent is never migrated under its loop.
 */

export type DefaultMatch = { version: string; lang: Lang; persona: PersonaKey | null; pit: string | null; agentId: string };

const currentDefault = (): ShippedDefault => ({ version: DEFAULT_STRATEGY_VERSION, template: { en: readFileSync(defaultStrategyPath("en"), "utf8"), zh: readFileSync(defaultStrategyPath("zh"), "utf8") }, personas: PERSONA_TEXT });

/** Which shipped default `text` is, for which of these Agent IDs: the current one first, then every earlier one; else null. */
export function shippedDefaultOf(text: string, agentIds: readonly string[], shipped: readonly ShippedDefault[] = [currentDefault(), ...SHIPPED_DEFAULTS]): DefaultMatch | null {
  for (const d of shipped)
    for (const lang of ["en", "zh"] as const)
      for (const agentId of agentIds) {
        const styles: [PersonaKey | null, string][] = d.personas ? Object.entries(d.personas).map(([k, t]) => [k as PersonaKey, t[lang]]) : [[null, ""]];
        for (const [persona, line] of styles) {
          const pit = matchDefault(text, d.template[lang], agentId, line);
          if (pit !== null) return { version: d.version, lang, persona, pit: pit === "" ? null : pit, agentId };
        }
      }
  return null;
}

/** What `FL strategy restore` needs, kept in the agent's folder. */
export type MigrationRecord = { path: string; from: string; to: string; at: string; backup: string; oldSha: string; newSha: string; fromPersona: PersonaKey | null; restored?: string | null };
export const migrationPath = (home: string, name: string) => join(agentPaths(home, name).dir, "strategy-migration.json");
export const readMigration = (home: string, name: string) => {
  try {
    return readJson<MigrationRecord>(migrationPath(home, name));
  } catch {
    return null;
  }
};

export type Migration =
  | { kind: "none" }
  /** Already the current default. */
  | { kind: "current" }
  /** A default once, edited since: never touched. */
  | { kind: "edited"; title: string }
  /** Put back by `FL strategy restore`: left on the old default. */
  | { kind: "kept"; from: string }
  | { kind: "migrated"; from: string; to: string; path: string; backup: string; agent: AgentConfig };

const DEFAULT_TITLE = /^# (Season-1 default strategy v[\d.]+|第一季默认策略 v[\d.]+)/;
const agentIdsOf = (home: string, agent: AgentConfig) => {
  let recorded: string | null = null;
  try {
    recorded = recordedAgentId(home);
  } catch {
    recorded = null;
  }
  return [...new Set([agent.name, ...(recorded ? [recorded] : [])])];
};

/** A file beside `path` that is not there yet (or holds these very bytes): `<file>.default-<version>`, then `-2`, `-3`… */
function backupPath(path: string, version: string, text: string): string {
  const base = join(dirname(path), `${basename(path)}.default-${version}`);
  for (let i = 1; ; i += 1) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!existsSync(candidate) || readFileSync(candidate, "utf8") === text) return candidate;
  }
}

/** The seat's strategy file, moved to the current default when it is an unedited earlier one (see above). */
export function migrateDefault(home: string, agent: AgentConfig, now = new Date()): Migration {
  if (agent.track !== "prompt" || !agent.prompt) return { kind: "none" };
  const read = readPrompt(agent.prompt.path);
  if (!read.ok) return { kind: "none" };
  const kept = readMigration(home, agent.name);
  if (kept?.restored && kept.path === read.path && kept.oldSha === read.sha256) return { kind: "kept", from: kept.from };
  const match = shippedDefaultOf(read.text, agentIdsOf(home, agent));
  if (!match) {
    const title = DEFAULT_TITLE.exec(read.text)?.[1] ?? null;
    return title && title !== DEFAULT_STRATEGY_TITLE.en && title !== DEFAULT_STRATEGY_TITLE.zh ? { kind: "edited", title } : { kind: "none" };
  }
  if (match.version === DEFAULT_STRATEGY_VERSION) return { kind: "current" };
  // The same style (v1 had none: the seat's recorded one, else its name's); the pit it named, else the one the page last named.
  const persona: PersonaKey = match.persona && PERSONAS.includes(match.persona) ? match.persona : (agent.persona ?? personaOf(match.agentId));
  const pit = match.pit ?? ((p) => (p ? pitLabel(p) : null))(keptPit(home));
  const text = defaultStrategy(match.agentId, match.lang, persona, pit);
  const backup = backupPath(read.path, match.version, read.text);
  copyFileSync(read.path, backup);
  writeFileSync(read.path, text, { mode: statSync(read.path).mode & 0o777 });
  const newSha = readPrompt(read.path);
  if (!newSha.ok) throw new Error(newSha.error);
  let next = agent;
  if (agent.prompt.sha256 === read.sha256) {
    next = { ...agent, prompt: { path: agent.prompt.path, sha256: newSha.sha256 }, persona };
    saveAgent(home, next);
  }
  const record: MigrationRecord = { path: read.path, from: match.version, to: DEFAULT_STRATEGY_VERSION, at: now.toISOString(), backup, oldSha: read.sha256, newSha: newSha.sha256, fromPersona: match.persona ?? agent.persona ?? null, restored: null };
  writeJsonAtomic(migrationPath(home, agent.name), record);
  appendJsonl(agentPaths(home, agent.name).log, { at: now.toISOString(), event: "strategy.migrated", from: match.version, to: DEFAULT_STRATEGY_VERSION, lang: match.lang, persona, pit: pit !== null, backup: basename(backup) });
  return { kind: "migrated", from: match.version, to: DEFAULT_STRATEGY_VERSION, path: read.path, backup, agent: next };
}

/**
 * `FL strategy restore <name>`: the file the migration replaced, put back, and the seat's card on it again (when the card
 * followed the migration). Refused when the file was changed since the migration, or its kept copy is gone. A seat put
 * back stays on its old default: the next start leaves it.
 */
export function restoreDefault(home: string, agent: AgentConfig, now = new Date()): { ok: true; from: string; path: string; agent: AgentConfig } | { ok: false; why: string } {
  const record = readMigration(home, agent.name);
  if (!record || record.restored) return { ok: false, why: "no default strategy was replaced for this agent" };
  if (!existsSync(record.backup)) return { ok: false, why: `the old file is gone (${record.backup}): nothing restored` };
  const read = readPrompt(record.path);
  if (read.ok && read.sha256 !== record.newSha) return { ok: false, why: `${record.path} was changed since the new default replaced it: nothing restored (the old file is ${record.backup})` };
  copyFileSync(record.backup, record.path);
  let next = agent;
  if (agent.prompt?.path === record.path && agent.prompt.sha256 === record.newSha) {
    const { persona: _was, ...rest } = agent;
    next = { ...rest, prompt: { path: record.path, sha256: record.oldSha }, ...(record.fromPersona ? { persona: record.fromPersona } : {}) };
    saveAgent(home, next);
  }
  writeJsonAtomic(migrationPath(home, agent.name), { ...record, restored: now.toISOString() } satisfies MigrationRecord);
  appendJsonl(agentPaths(home, agent.name).log, { at: now.toISOString(), event: "strategy.restored", from: record.from });
  return { ok: true, from: record.from, path: record.path, agent: next };
}

/** FL status's line on the default, or null: replaced (and how to put it back), kept by a restore, or edited with a new one out. */
export function migrationLine(home: string, agent: AgentConfig, lang: Lang = "en"): string | null {
  if (agent.track !== "prompt" || !agent.prompt) return null;
  const record = readMigration(home, agent.name);
  const zh = lang === "zh";
  const read = readPrompt(agent.prompt.path);
  if (record && record.path === (read.ok ? read.path : null)) {
    if (record.restored && read.ok && read.sha256 === record.oldSha) return zh ? `策略：按你的意思留在默认策略 ${record.from}（新的默认策略 ${DEFAULT_STRATEGY_VERSION} 已发布）` : `strategy: kept on the default ${record.from} by FL strategy restore (the new default ${DEFAULT_STRATEGY_VERSION} is out)`;
    if (!record.restored && read.ok && read.sha256 === record.newSha)
      return zh
        ? `策略：没改动过的默认策略 ${record.from} 已换成 ${record.to}（${record.at}）；旧文件留在 ${record.backup}，\`FL strategy restore ${agent.name}\` 可换回`
        : `strategy: the unedited default ${record.from} was replaced by ${record.to} (${record.at}); the old file is kept at ${record.backup}: \`FL strategy restore ${agent.name}\` puts it back`;
  }
  if (!read.ok) return null;
  const title = DEFAULT_TITLE.exec(read.text)?.[1] ?? null;
  if (title && title !== DEFAULT_STRATEGY_TITLE.en && title !== DEFAULT_STRATEGY_TITLE.zh && !shippedDefaultOf(read.text, agentIdsOf(home, agent)))
    return zh ? `策略：新的默认策略 ${DEFAULT_STRATEGY_VERSION} 已发布；你改过的 strategy.md 原样保留` : `strategy: a new default strategy ${DEFAULT_STRATEGY_VERSION} is out; your edited strategy file is left as it is`;
  return null;
}
