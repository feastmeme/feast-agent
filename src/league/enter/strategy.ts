import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Lang } from "../register/copy.ts";

/**
 * The season-1 default strategy (the owner's rulings of 2026-10-24 04:5x and 05:2x): six short lines that
 * `FL enter` copies to the player's `strategy.md` when no `--prompt` is given, with `<id>` replaced by the bare
 * Agent ID, so the player can edit it. It never overwrites a `strategy.md` that is there. The copied text is
 * the player's from then on: it is not sent anywhere.
 */

export const DEFAULT_STRATEGY_TITLE = "Season-1 default strategy v1";

/** The shipped files, in the runtime's checkout. */
export const defaultStrategyPath = (lang: Lang) => fileURLToPath(new URL(`../../../docs/prompts/default-s1${lang === "zh" ? "" : ".en"}.md`, import.meta.url));

/** The default, for this Agent ID. */
export function defaultStrategy(agentId: string, lang: Lang): string {
  return readFileSync(defaultStrategyPath(lang), "utf8").replaceAll("<id>", agentId);
}

export type StrategyFile = { path: string; copied: boolean };

/** `./strategy.md` in `cwd`: the player's own when it exists, else the default copied there (mode 0644). */
export function ensureStrategy(cwd: string, agentId: string, lang: Lang): StrategyFile {
  const path = resolve(cwd, "strategy.md");
  if (existsSync(path)) return { path, copied: false };
  writeFileSync(path, defaultStrategy(agentId, lang), { mode: 0o644, flag: "wx" });
  return { path, copied: true };
}
