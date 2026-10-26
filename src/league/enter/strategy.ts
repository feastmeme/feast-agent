import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Lang } from "../register/copy.ts";

/**
 * The season-1 default strategy (the owner's rulings of 2026-10-24 04:5x and 05:2x; v1.1, task 1020): seven short
 * lines that `FL enter` copies to the player's `strategy.md` when no `--prompt` is given, with `<id>` replaced by
 * the bare Agent ID and `<persona>` by one of six styles, so the player can edit it. It never overwrites a
 * `strategy.md` that is there. The copied text is the player's from then on: it is not sent anywhere.
 */

export const DEFAULT_STRATEGY_TITLE = { en: "Season-1 default strategy v1.1", zh: "第一季默认策略 v1.1" } as const;

/** The six styles, in the order the Agent ID's hash picks them. */
export const PERSONAS = ["momentum", "dip", "contrarian", "follower", "hunter", "closer"] as const;
export type PersonaKey = (typeof PERSONAS)[number];

export const PERSONA_TEXT: Record<PersonaKey, Record<Lang, string>> = {
  momentum: {
    en: "Chase strength: buy the coin with the strongest inflow over the last 15 minutes and sell as soon as the flow fades.",
    zh: "追涨：买最近 15 分钟流入最强的币，流向一弱就卖。",
  },
  dip: {
    en: "Buy the dip: buy the coin that pulled back most over the last 15 minutes while people still trade it, and sell into the bounce.",
    zh: "抄底：买最近 15 分钟回撤最深、但仍有人在交易的币，反弹就卖。",
  },
  contrarian: {
    en: "Fade the crowd: sell what everyone is buying and buy, in small pieces, what everyone is dumping.",
    zh: "反向：大家都在买的你卖，大家都在砸的你小口买。",
  },
  follower: {
    en: "Follow the leaders: watch what the top-ranked agents just bought, buy the same early, and get out before they do.",
    zh: "跟强者：看排名靠前的 agent 刚买了什么，早点跟着买，赶在他们前面出。",
  },
  hunter: {
    en: "Hunt the drop zone: watch what the agents in danger hold; they must act before dinner, so take your position first and sell into their buying.",
    zh: "打淘汰区：盯着淘汰区 agent 的持仓，他们开饭前必须动，你先站好位，在他们买的时候卖给他们。",
  },
  closer: {
    en: "Strike late: stay small for most of the day and do most of your trading in the last two hours before dinner, when the others are forced to move.",
    zh: "开饭前发力：白天小打小闹，开饭前最后两小时集中交易，那时别人被迫动。",
  },
};

/** The style an Agent ID gets: the first byte of the sha256 of its bare, lowercased name, modulo six. The same name, the same style. */
export function personaOf(agentId: string): PersonaKey {
  const bare = agentId.trim().toLowerCase().replace(/\.ai$/, "");
  return PERSONAS[createHash("sha256").update(bare).digest()[0]! % PERSONAS.length]!;
}

/** The shipped files, in the runtime's checkout. */
export const defaultStrategyPath = (lang: Lang) => fileURLToPath(new URL(`../../../docs/prompts/default-s1${lang === "zh" ? "" : ".en"}.md`, import.meta.url));

/** The default, for this Agent ID, in its own style unless another is named. */
export function defaultStrategy(agentId: string, lang: Lang, persona: PersonaKey = personaOf(agentId)): string {
  return readFileSync(defaultStrategyPath(lang), "utf8").replaceAll("<id>", agentId).replaceAll("<persona>", PERSONA_TEXT[persona][lang]);
}

/** The six English renderings of the default for this Agent ID, one per style, in PERSONAS' order (to tell a strategy still on the default). */
export function defaultStrategyVariants(agentId: string): string[] {
  return PERSONAS.map((persona) => defaultStrategy(agentId, "en", persona));
}

/** Which style's default this text is, word for word, in either language; null when it is the player's own. */
export function defaultPersonaOf(text: string, agentId: string): PersonaKey | null {
  for (const persona of PERSONAS) for (const lang of ["en", "zh"] as const) if (text === defaultStrategy(agentId, lang, persona)) return persona;
  return null;
}

/** `persona`: the style of the default copied now, or of a default copied before and left as it was; null otherwise. */
export type StrategyFile = { path: string; copied: boolean; persona: PersonaKey | null };

/** `./strategy.md` in `cwd`: the player's own when it exists, else the default copied there (mode 0644). */
export function ensureStrategy(cwd: string, agentId: string, lang: Lang): StrategyFile {
  const path = resolve(cwd, "strategy.md");
  if (existsSync(path)) return { path, copied: false, persona: defaultPersonaOf(readFileSync(path, "utf8"), agentId) };
  const persona = personaOf(agentId);
  writeFileSync(path, defaultStrategy(agentId, lang, persona), { mode: 0o644, flag: "wx" });
  return { path, copied: true, persona };
}
