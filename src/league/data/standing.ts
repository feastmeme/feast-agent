import type { ArenaRow, FieldRow, LeagueRead, LeagueSite } from "../register/site.ts";
import { untrusted, type Untrusted } from "./untrusted.ts";

/**
 * Where the agent stands in the league, in the league's own units (task 975, addendum 5): its rank by today's
 * profit in BNB among the agents still alive, the gaps to the next above and below, and tonight's cutoff under the
 * page's elimination rule, computed from the arena `/api/league` sends. The rule is the site's (feast-app
 * src/lib/league/score.ts, ELIMINATION and DROP_SHARE, at 40ebae81); it is codified here once, and only estimated:
 * the arena carries each agent's trades but not its volume, so "over the floor" is read as at least 3 trades.
 */

export const DROP_SHARE = 0.2;
export const FLOOR_TRADES = 3;
/** What the floor counts, the published rule's words (addendum 7): the pack and `FL data` say it the same way. */
export const FLOOR_COUNTS = "buys and sells of any Feast coin count, your own coin left out";

/** The league's rules as the pack and `FL data` state them, each with where it comes from. */
export const RULES: { rule: string; text: string; source: string }[] = [
  { rule: "floor", text: `each day, dinner to dinner, at least 3 trades and 0.02 BNB of volume (${FLOOR_COUNTS}); an agent under it at the dinner is eaten (idle)`, source: "feast-app src/lib/league/score.ts ACTIVITY_FLOOR_TRADES, ACTIVITY_FLOOR_BNB (40ebae81); the published rules and the settlement engine's dayActivity" },
  { rule: "dinner", text: "every day at 21:00 UTC+8 (13:00 UTC); dinner 1 eats nobody", source: "feast-app src/lib/league/season.ts DINNER_HOUR_UTC (40ebae81)" },
  { rule: "drop", text: "of the N agents over the floor, the bottom floor(N/5) by the day's profit in BNB whose day lost money are eaten (drop); a day that made money is never eaten; one life a season", source: "feast-app src/lib/league/score.ts ELIMINATION, DROP_SHARE 0.2 (40ebae81)" },
  { rule: "prizes", text: "paid by Feast in FEAST, valued in USDT at settlement; an eaten agent is out of the season's prizes; the amounts are the league page's and are not in this data", source: "skills/feast-league/SKILL.md, Before you take part and §9 Status" },
  { rule: "cap", text: "at most 0.15 BNB of capital, wallet-wide: every agent on the wallet counts", source: "src/league/prompt/constants.ts LEAGUE_CAP_BNB" },
];

export type Standing = {
  alive: number;
  /** 1 = the best day; null when this wallet is not in the arena. */
  rank: number | null;
  pnlBnb: number | null;
  gapUpBnb: number | null;
  gapDownBnb: number | null;
  cutoff: {
    /** Alive agents with at least 3 trades: the page's N, estimated. */
    passing: number;
    /** floor(N/5): how many of them the drop may eat. */
    bottom: number;
    /** The best day inside the bottom (eaten only if it lost): below this and under 0, an agent is in the drop zone. */
    cutoffPnlBnb: number | null;
    /** Whether this agent is under the floor's trades, in the drop zone, or neither. */
    me: "under-floor" | "drop-zone" | "safe" | "unknown";
    /** BNB more profit today that would take this agent out of the drop zone (to 0, or above the cutoff). */
    toSafetyBnb: number | null;
  };
  danger: { name: Untrusted; pnlBnb: number; trades: number | null }[];
  /** Where it was computed from: the whole field (`field=1`), or the arena's 40 (an older site). */
  from?: "field" | "arena";
};

const r6 = (x: number) => Number(x.toFixed(6));

/** One agent as the standing reads it: from the field (addendum 6), or the arena (addendum 5). `trades` null: unknown. */
export type StandingRow = { name: string; wallet: string | null; pnlBnb: number; trades: number | null; danger: boolean; eaten: boolean; viewer: boolean };

export const fromField = (rows: FieldRow[]): StandingRow[] => rows.map((r) => ({ name: r.name, wallet: r.wallet, pnlBnb: r.pnlBnb, trades: r.trades, danger: r.danger, eaten: r.eaten !== null, viewer: false }));
export const fromArena = (rows: ArenaRow[]): StandingRow[] => rows.map((r) => ({ name: r.name, wallet: r.wallet, pnlBnb: r.pnlBnb, trades: r.trades, danger: r.danger, eaten: r.eaten, viewer: r.viewer }));

export function standing(input: StandingRow[] | ArenaRow[], me: string | null): Standing {
  const rows: StandingRow[] = input as StandingRow[];
  const alive = rows.filter((r) => !r.eaten);
  const mine = alive.find((r) => r.viewer || (me !== null && r.wallet === me.toLowerCase())) ?? null;
  // Without trades (the field may not carry them) every living agent is counted as over the floor: an estimate.
  const tradesKnown = alive.some((r) => r.trades !== null && r.trades !== undefined);
  const best = [...alive].sort((a, b) => b.pnlBnb - a.pnlBnb);
  const rank = mine ? best.indexOf(mine) + 1 : null;
  const passing = alive.filter((r) => !tradesKnown || (r.trades ?? 0) >= FLOOR_TRADES).sort((a, b) => a.pnlBnb - b.pnlBnb);
  const bottom = Math.floor(passing.length * DROP_SHARE);
  const cutoffPnlBnb = bottom > 0 ? passing[bottom - 1]!.pnlBnb : null;
  let state: Standing["cutoff"]["me"] = "unknown";
  let toSafety: number | null = null;
  if (mine) {
    if (tradesKnown && (mine.trades ?? 0) < FLOOR_TRADES) state = "under-floor";
    else {
      const inBottom = bottom > 0 && passing.indexOf(mine) < bottom;
      state = inBottom && mine.pnlBnb < 0 ? "drop-zone" : "safe";
      if (state === "drop-zone") {
        // Out of it: a day back to 0, or past the best of those just above the bottom.
        const above = passing[bottom]?.pnlBnb ?? 0;
        toSafety = r6(Math.max(0, Math.min(0 - mine.pnlBnb, above - mine.pnlBnb)));
      }
    }
  }
  return {
    alive: alive.length,
    rank,
    pnlBnb: mine ? mine.pnlBnb : null,
    gapUpBnb: mine && rank !== null && rank > 1 ? r6(best[rank - 2]!.pnlBnb - mine.pnlBnb) : null,
    gapDownBnb: mine && rank !== null && rank < best.length ? r6(mine.pnlBnb - best[rank]!.pnlBnb) : null,
    cutoff: { passing: passing.length, bottom, cutoffPnlBnb, me: state, toSafetyBnb: toSafety },
    danger: alive.filter((r) => r.danger).slice(0, 10).map((r) => ({ name: untrusted(r.name), pnlBnb: r.pnlBnb, trades: r.trades ?? null })),
  };
}

/**
 * The league's read for a standing (addendum 6): the cached `field=1` board with no `me=`, and this wallet's rows
 * derived from it (its board rows when it is on the top-10 boards; its eaten day from the field). Only when the site
 * sends no field (an older deploy) the uncached `me=` read is asked instead: the fallback, to be removed once the
 * coordinator says every site has `field=1`.
 */
export async function readStanding(site: Pick<LeagueSite, "field" | "league">, wallet: string | null): Promise<{ read: LeagueRead | null; from: "field" | "me" | "arena" | null; standing: Standing | null }> {
  const read = await site.field().catch(() => null);
  if (read?.field) {
    const me = wallet?.toLowerCase() ?? null;
    const row = me ? read.field.find((r) => r.wallet === me) ?? null : null;
    const derived: LeagueRead = read.me !== undefined || !me ? read : { ...read, me: { earners: read.earners.find((r) => r.wallet.toLowerCase() === me) ?? null, backed: read.backed.find((r) => r.wallet.toLowerCase() === me) ?? null, eaten: row?.eaten && row.eaten.day !== null ? { day: row.eaten.day, reason: row.eaten.reason } : null } };
    return { read: derived, from: "field", standing: { ...standing(fromField(read.field), me), from: "field" } };
  }
  const fallback = wallet ? await site.league("today", wallet as `0x${string}`).catch(() => null) : null;
  const best = fallback ?? read;
  return { read: best, from: fallback ? "me" : best ? "arena" : null, standing: best?.arena ? { ...standing(fromArena(best.arena), wallet), from: "arena" } : null };
}
