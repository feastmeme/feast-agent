import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Lang } from "../register/copy.ts";

/**
 * The season-1 default strategy (the owner's rulings of 2026-10-24 04:5x and 05:2x; v1.1, task 1020; v1.3, task 975
 * run 26, the owner's approval of v1.3): seven short lines that `FL enter` copies to the player's `strategy.md` when no
 * `--prompt` is given, with `<id>` replaced by the bare Agent ID, `<persona>` by one of seven styles and `<pit>` by the
 * league's pit as the page names it at entry, so the player can edit it. It never overwrites a `strategy.md` that is
 * there. The copied text is the player's from then on: it is not sent anywhere. The template is a data file
 * (`docs/prompts/default-s1*.md`): a new version is the two files, the title below and the styles' lines.
 */

export const DEFAULT_STRATEGY_VERSION = "v1.3";
export const DEFAULT_STRATEGY_TITLE = { en: `Season-1 default strategy ${DEFAULT_STRATEGY_VERSION}`, zh: `第一季默认策略 ${DEFAULT_STRATEGY_VERSION}` } as const;

/**
 * The seven styles. The first six keep the order the Agent ID's hash has picked them in since v1.1, so no seated
 * player's style moves; `instigator` (run 24, item 11) is last, picked only in a small arena (`personaOf`).
 */
export const PERSONAS = ["momentum", "dip", "contrarian", "follower", "hunter", "closer", "instigator"] as const;
export type PersonaKey = (typeof PERSONAS)[number];
/** The six the hash picks from in a full arena, in their v1.1 order. */
const SIX = PERSONAS.slice(0, 6) as readonly PersonaKey[];

/** Each style's line in v1.3 (the notes' §五): an opening idea, a pace and a voice; a suggestion, not a rule. */
export const PERSONA_TEXT: Record<PersonaKey, Record<Lang, string>> = {
  momentum: {
    en: "Ride the flow. Opening idea: buy the pit's pullbacks while the inflow is still strong, and sell the moment it fades. Pace: several rounds a day, busiest in the middle of the day once the first fight is on. Talk like: \"the flow is still here, one more round\".",
    zh: "追涨。起手思路：流入还强时买擂台币的回调，流一弱就卖。频率：一天几轮，白天中段、第一架打起来之后最忙。口吻像「流还在，再来一轮」。",
  },
  dip: {
    en: "Buy the dip. Opening idea: buy the pit at its deepest pullback of the last 15 minutes while people still trade it, and sell into the bounce. Pace: one round after each small peak, a few a day. Talk like: \"you dump, I catch\".",
    zh: "抄底。起手思路：在擂台币最近 15 分钟回撤最深、但仍有人交易时买进，反弹就卖。频率：每个小高潮过后一轮，一天几轮。口吻像「你们砸，我接」。",
  },
  contrarian: {
    en: "Fade the crowd. Opening idea: at the top of each rise sell to the ones piling in, and buy back when they dump. Pace: one round per wave, patient between waves, never a whole day on the bench. Talk like: \"sold it to you who chased\".",
    zh: "反向。起手思路：每波涨势的顶上卖给往里冲的人，大家砸的时候买回来。频率：每波一轮，波与波之间耐心等，但不整天干坐。口吻像「卖给追高的你们了」。",
  },
  follower: {
    en: "Follow the leaders. Opening idea: when a top-ranked agent buys the pit, buy right behind it and get out before it does. Pace: move when they move; if they are quiet for an hour, open a round of your own. Talk like: \"in behind number one\".",
    zh: "跟强者。起手思路：排名靠前的 agent 一买擂台币你就紧跟着买，赶在他们前面出。频率：他们动你就动；他们一小时没动，你就自己开一轮。口吻像「跟着第一名进了」。",
  },
  hunter: {
    en: "Hunt the drop zone. Opening idea: the agents in danger must act before dinner, so take your place in the pit before they move and sell into their buying. Pace: a few rounds in the day to stay sharp, the main one in the stretch before the final rush. Talk like: \"you have to move before dinner, I am already seated\".",
    zh: "打淘汰区。起手思路：淘汰区的 agent 开饭前必须动，你先在擂台里站好位，等他们买的时候卖给他们。频率：白天几轮保持手感，主战在收官冲刺之前那一段。口吻像「你们开饭前必须动，我已经坐好了」。",
  },
  closer: {
    en: "Strike late. Opening idea: do most of your fighting in the last two hours before dinner, when the others are forced to move. Pace: light during the day (a few real rounds, not just the floor), heavy in the last two hours. Talk like: \"last two hours, now we fight\".",
    zh: "开饭前发力。起手思路：开饭前最后两小时集中开打，那时别人被迫动。频率：白天轻（真打几轮，不只是保命单），最后两小时重。口吻像「最后两小时，开打」。",
  },
  instigator: {
    en: "Lead the charge. Opening idea: when the pit is quiet (few holders so far, little bought in the last 15 minutes, fewer than 3 league trades), go in first, say so, and sell to the ones who follow. Pace: the earliest and the most often; never sit out a quiet pit. Talk like: \"in first, the rest is on you\".",
    zh: "带头。起手思路：擂台安静时（持币人还少、最近 15 分钟没什么人买、联赛不到 3 笔），你先进，公开说你先进了，卖给跟进的人。频率：最早、最勤，安静的擂台也不干坐。口吻像「我先进了，后面的自己看」。",
  },
};

/** Below this many seats taken at entry the arena is small, and a third of the names get `instigator`. */
export const SMALL_ARENA_SEATS = 50;

/**
 * The style an Agent ID gets, from the first byte of the sha256 of its bare, lowercased name: in a small arena (the
 * league read at entry shows fewer than 50 seats taken) a byte that is a multiple of 3 is `instigator`; otherwise the
 * byte modulo six picks one of the first six, as since v1.1. The same name in the same arena, the same style.
 */
export function personaOf(agentId: string, seatsTaken: number | null = null): PersonaKey {
  const bare = agentId.trim().toLowerCase().replace(/\.ai$/, "");
  const byte = createHash("sha256").update(bare).digest()[0]!;
  if (seatsTaken !== null && seatsTaken < SMALL_ARENA_SEATS && byte % 3 === 0) return "instigator";
  return SIX[byte % SIX.length]!;
}

/** What `<pit>` reads when the page names no pit at entry. */
export const NO_PIT: Record<Lang, string> = { en: "still to be launched", zh: "（待发）" };

/** The shipped files, in the runtime's checkout. */
export const defaultStrategyPath = (lang: Lang) => fileURLToPath(new URL(`../../../docs/prompts/default-s1${lang === "zh" ? "" : ".en"}.md`, import.meta.url));

/**
 * The default, for this Agent ID, in its own style unless another is named; `pit` is the pit's label as the pack prints
 * it (`pit.ts` pitLabel: `<symbol> <0x and 4 hex>…<last 4>`, never the whole address), or null for none named.
 */
export function defaultStrategy(agentId: string, lang: Lang, persona: PersonaKey = personaOf(agentId), pit: string | null = null): string {
  return renderDefault(readFileSync(defaultStrategyPath(lang), "utf8"), agentId, PERSONA_TEXT[persona][lang], pit ?? NO_PIT[lang]);
}

/** A template with its three places filled. `<pit>` last: a pit's label never holds `<id>` or `<persona>`. */
export function renderDefault(template: string, agentId: string, persona: string, pit: string): string {
  return template.replaceAll("<id>", agentId).replaceAll("<persona>", persona).replaceAll("<pit>", pit);
}

/** The seven English renderings of the default for this Agent ID, one per style, in PERSONAS' order (to tell a strategy still on the default). */
export function defaultStrategyVariants(agentId: string, pit: string | null = null): string[] {
  return PERSONAS.map((persona) => defaultStrategy(agentId, "en", persona, pit));
}

/**
 * Whether `text` is `template` with `<id>` and `<persona>` filled as given and anything at `<pit>`: the whole file,
 * byte for byte, with `<pit>` standing for one or more characters of a single line (the label rendered at entry, which
 * this runtime cannot know afterwards). Returns the text at `<pit>` ("" for a template without one), or null.
 */
export function matchDefault(text: string, template: string, agentId: string, persona: string): string | null {
  const filled = template.replaceAll("<id>", agentId).replaceAll("<persona>", persona);
  const at = filled.indexOf("<pit>");
  if (at < 0) return text === filled ? "" : null;
  const head = filled.slice(0, at);
  const tail = filled.slice(at + "<pit>".length);
  if (tail.includes("<pit>") || text.length <= head.length + tail.length || !text.startsWith(head) || !text.endsWith(tail)) return null;
  const pit = text.slice(head.length, text.length - tail.length);
  return /[\r\n]/.test(pit) ? null : pit;
}

/**
 * Which style's default this text is, word for word, in either language; null when it is the player's own. The pit is
 * matched as any one line's worth of text (`matchDefault`), so the label rendered at entry need not be known.
 */
export function defaultPersonaOf(text: string, agentId: string): PersonaKey | null {
  for (const lang of ["en", "zh"] as const) {
    const template = readFileSync(defaultStrategyPath(lang), "utf8");
    for (const persona of PERSONAS) if (matchDefault(text, template, agentId, PERSONA_TEXT[persona][lang]) !== null) return persona;
  }
  return null;
}

/** `persona`: the style of the default copied now, or of a default copied before and left as it was; null otherwise. */
export type StrategyFile = { path: string; copied: boolean; persona: PersonaKey | null };

/**
 * `./strategy.md` in `cwd`: the player's own when it exists, else the default copied there (mode 0644), its style picked
 * with the seats the league read at entry shows taken, and the pit it names.
 */
export function ensureStrategy(cwd: string, agentId: string, lang: Lang, entry: { seatsTaken?: number | null; pit?: string | null } = {}): StrategyFile {
  const path = resolve(cwd, "strategy.md");
  if (existsSync(path)) return { path, copied: false, persona: defaultPersonaOf(readFileSync(path, "utf8"), agentId) };
  const persona = personaOf(agentId, entry.seatsTaken ?? null);
  writeFileSync(path, defaultStrategy(agentId, lang, persona, entry.pit ?? null), { mode: 0o644, flag: "wx" });
  return { path, copied: true, persona };
}
