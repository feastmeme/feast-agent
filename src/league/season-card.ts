import { seasonLine, seatLine, shortUsd, type Lang } from "./register/copy.ts";
import { AGENT_ID, shownName } from "./register/message.ts";
import type { BackedRow, EarnerRow, LeagueRead, Seating } from "./register/site.ts";

/**
 * The league in the status card (docs/PLAN-941.md §6): the season's state,
 * this agent's seat, its ranks today and this season, and whether it was
 * eaten — said plainly. The runtime never reads the league: whatever it says,
 * the preset keeps running, and the card ends by saying so.
 *
 * Its own rows come from the page's `me` (927 API.md §3: from the whole
 * boards, past the top 100); without one, from the top 100 by its Agent ID,
 * and "outside the top 100" when it is not there.
 *
 * In season it also gives the agent's battle card for the day, and one line
 * asking the user to post it on X (the owner's ruling, 2026-10-24). Nothing is
 * posted for the user.
 */

export type StandingInput = {
  /** From the registration record: null when this wallet never registered from here. */
  agentId: string | null;
  seating: Seating | null;
  today: LeagueRead | null;
  /** Read during and after the season only. */
  season: LeagueRead | null;
  now: number;
  /** feast.meme, for the battle card's link; without it, no card line. */
  site?: string;
  /** The wallet entered with `FL enter` (a body coin on record), with or without a registration. */
  entered?: boolean;
};

type Mine = { earner: EarnerRow | null; backed: BackedRow | null; earnerCut: boolean; backedCut: boolean; eaten: number | null };

function mine(read: LeagueRead, agentId: string): Mine {
  if (read.me !== undefined && read.me !== null) {
    const eaten = read.me.eaten?.day ?? read.me.earners?.eatenDay ?? read.me.backed?.eatenDay ?? null;
    return { earner: read.me.earners, backed: read.me.backed, earnerCut: false, backedCut: false, eaten };
  }
  const earner = read.earners.find((r) => r.name === agentId) ?? null;
  const backed = read.backed.find((r) => r.name === agentId) ?? null;
  return {
    earner,
    backed,
    earnerCut: !earner && read.counts.earners > read.earners.length,
    backedCut: !backed && read.counts.backed > read.backed.length,
    eaten: earner?.eatenDay ?? backed?.eatenDay ?? null,
  };
}

function ranksLine(read: LeagueRead, m: Mine, when: "today" | "season", lang: Lang): string {
  const zh = lang === "zh";
  const parts: string[] = [];
  if (m.earner && m.earner.rank !== null) {
    parts.push(
      zh
        ? `${when === "today" ? "今日" : "本季至今"}最赚钱：第 ${m.earner.rank} 名（共 ${read.counts.earners}，${shortUsd(m.earner.pnlUsd)} USDT，${m.earner.trades} 笔）。`
        : `${when === "today" ? "Top earners today" : "Season so far, Top earners"}: #${m.earner.rank} of ${read.counts.earners} (${shortUsd(m.earner.pnlUsd)} USDT, ${m.earner.trades} trades).`,
    );
  } else if (m.earnerCut) parts.push(zh ? "「最赚钱」榜前 100 名以外。" : "Outside the top 100 on Top earners.");
  else if (when === "today") parts.push(zh ? "还没上「最赚钱」榜：当天满 5 笔交易才上榜。" : "Not on Top earners yet: an agent needs 5 trades in the day.");
  if (m.backed && m.backed.rank !== null) {
    parts.push(zh ? `${when === "today" ? "今日" : "本季"}最多人押：第 ${m.backed.rank} 名（血量 ${m.backed.hp}）。` : `${when === "today" ? "Most backed today" : "Most backed"}: #${m.backed.rank} (HP ${m.backed.hp}).`);
  } else if (m.backedCut) parts.push(zh ? "「最多人押」榜前 100 名以外。" : "Outside the top 100 on Most backed.");
  return parts.join(zh ? "" : " ");
}

export function eatenLine(day: number, lang: Lang): string {
  return lang === "zh"
    ? `第 ${day} 天开饭时被吃掉了：本季奖金资格没了。它的币照常交易，你的 agent 照常跑它的策略，下一季可以重新参赛。`
    : `Eaten at dinner on day ${day}: out of this season's prizes. Its coin keeps trading, your agent keeps running its preset, and it can enter the next season.`;
}

/** The day's battle card: its link, and the one line asking the user to post it. Only for a real Agent ID and a season day. */
export function battleCardLines(site: string, agentId: string, day: number, lang: Lang): string[] {
  if (!AGENT_ID.test(agentId) || !Number.isInteger(day) || day < 1 || day > 99) return [];
  const url = `${site.replace(/\/+$/, "")}/league/agent/${agentId}/card?day=${day}`;
  return lang === "zh" ? [`今日战报卡：${url}`, "今天把它发到 X 上，就能参加今晚的空投"] : [`Battle card: ${url}`, "Post it on X today to be in tonight's airdrop"];
}

/** The league block of `feast-league status`. */
export function standingLines(input: StandingInput, lang: Lang): string[] {
  const zh = lang === "zh";
  const lines = [`${zh ? "联赛" : "League"} · ${seasonLine(input.today, input.now, lang)}`];
  if (input.agentId && !input.seating && input.entered) {
    lines.push(zh ? `${shownName(input.agentId)} · 已用 FL enter 报名` : `${shownName(input.agentId)} · entered with FL enter`);
  } else if (!input.agentId || !input.seating) {
    lines.push(zh ? "还没报名联赛。说「报名」即可参加。" : 'Not in the league yet. Say "register" to join.');
  } else {
    const seat = seatLine(input.seating, lang);
    lines.push(`${shownName(input.agentId)} · ${seat}`);
    const today = input.today && input.today.state !== "unavailable" && input.today.state !== "coming-soon" ? input.today : null;
    if (today && input.seating.kind === "seated") {
      const m = mine(today, input.agentId);
      const seasonal = input.season && input.season.state !== "unavailable" ? mine(input.season, input.agentId) : null;
      const eaten = m.eaten ?? seasonal?.eaten ?? null;
      if (eaten !== null) lines.push(eatenLine(eaten, lang));
      else {
        const ranks = ranksLine(today, m, "today", lang);
        if (ranks) lines.push(ranks);
        if (seasonal && (today.state === "season" || today.state === "over")) {
          const season = ranksLine(input.season!, seasonal, "season", lang);
          if (season) lines.push(season);
        }
        if (today.state === "warm-up") lines.push(zh ? "热身期的名次不发奖，也不淘汰。" : "Warm-up ranks don't pay and don't eat.");
      }
    }
  }
  const day = input.today?.state === "season" ? input.today.season.day : null;
  if (input.site && input.agentId && day !== null && (input.seating || input.entered)) lines.push(...battleCardLines(input.site, input.agentId, day, lang));
  lines.push(zh ? "不管联赛怎样，你的 agent 都照常跑它的策略。" : "Your agent runs its preset whatever the league says.");
  return lines;
}
