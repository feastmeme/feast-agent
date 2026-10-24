import { join } from "node:path";

import { utc8 } from "./register/copy.ts";
import type { LeagueRead } from "./register/site.ts";
import { agentPaths, readJson, writeJsonAtomic } from "./store.ts";

/**
 * When an agent `FL enter` started may trade (task 968; the coordinator's ruling C8). feast.meme's season starts at
 * 21:00 UTC+8 (the start, not a dinner: addendum 9), and the clients learn it only as `/api/league`'s countdown: the
 * start before it, the next dinner during the season. The first dinner, dinner 1, is a day after the start and is the
 * warm-up (no floor, eats nobody). Trading opens one hour before it: the start plus 23 hours (season 1: Wednesday
 * 10/28, 20:00 UTC+8, as the owner moved it on 2026-10-24; the runtime reads it from `/api/league`, never from here). Until then the waiting agent trades nothing; with no start announced it waits until
 * told. The gate only holds trading back: it loosens nothing.
 */

export const OPENS_AFTER_START_MS = 23 * 3_600_000;
export const OPENS_BEFORE_DINNER_MS = 3_600_000;
/** How often a closed gate reads the league again. */
export const GATE_READ_MS = 5 * 60_000;

export type Opening = { kind: "open" } | { kind: "at"; at: number } | { kind: "unknown" };

/** The instant trading opens, from one read of `/api/league`; `unknown` when the page names no start (or cannot be read). */
export function tradingOpens(read: LeagueRead | null): Opening {
  if (!read) return { kind: "unknown" };
  if (read.state === "over") return { kind: "open" };
  const countdown = read.season.countdownTo;
  if (read.state === "season") {
    // Day 2 on, dinner 1 is behind: open. On day 1 the countdown is dinner 1.
    if ((read.season.day !== null && read.season.day >= 2) || countdown === null) return { kind: "open" };
    return { kind: "at", at: countdown - OPENS_BEFORE_DINNER_MS };
  }
  if ((read.state === "warm-up" || read.state === "coming-soon") && countdown !== null) return { kind: "at", at: countdown + OPENS_AFTER_START_MS };
  return { kind: "unknown" };
}

/**
 * The season is over (task 975, addendum 8, gap G6): `/api/league` says `over`. The gate closes again: no autopilot,
 * no ask, no strategy trades; the hard stop-loss stays, and the player may still sell (never buy). `tradingOpens`
 * still answers "open" for it (the season did open); this is the one that closes.
 */
export const seasonOver = (read: LeagueRead | null) => read?.state === "over";

/**
 * The dinner that asks no floor (addendum 8): the site's warm-up dinner, dinner 1 (`WARM_UP_DINNER = 1` in the site's
 * season.ts), the one that ends the season's day 1. Read from the league's clock, never from a date: on day 1 it is
 * the countdown; before the start (the countdown is the season's start, which is not a dinner) it is a day after it.
 * Null otherwise.
 */
export const WARM_UP_DINNER_DAY = 1;
const DAY_MS = 24 * 3_600_000;
export function warmUpDinner(read: LeagueRead | null): number | null {
  const countdown = read?.season.countdownTo ?? null;
  if (!read || countdown === null) return null;
  if (read.state === "season" && read.season.day === WARM_UP_DINNER_DAY) return countdown;
  if (read.state === "warm-up" || read.state === "coming-soon") return countdown + WARM_UP_DINNER_DAY * DAY_MS;
  return null;
}

/** What the runtime last knew of its gate, for `FL status` (no address in it). */
export type GateState = { state: "waiting" | "open" | "over"; opensAt: string | null; at: string; warmUpDinnerAt?: string | null; day?: number | null };

/** The line a request refused after the season and `FL status` say. */
export const SEASON_OVER_LINE = "season over: nothing trades on its own but the hard stop-loss, and no buy is taken; FL sell still sells what is left";

export const gatePath = (home: string, name: string) => join(agentPaths(home, name).dir, "season.json");
export const readGate = (home: string, name: string) => readJson<GateState>(gatePath(home, name));
export const writeGate = (home: string, name: string, state: GateState) => writeJsonAtomic(gatePath(home, name), state);

/** From the gate's file (`FL ask --print`, `FL status`): is tonight's dinner the warm-up's? */
export function noFloorTonight(g: GateState | null, now: number): boolean {
  const at = g?.warmUpDinnerAt ? Date.parse(g.warmUpDinnerAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13);
  return (today > now ? today : today + DAY_MS) === at;
}

/** The line a refused request and `FL status` say while the gate is closed. */
export function seasonClosedLine(opensAt: number | null): string {
  return opensAt === null ? "the season has not started; it opens when feast.meme announces the start" : `the season has not started; it opens at ${utc8(opensAt)} (UTC+8)`;
}
