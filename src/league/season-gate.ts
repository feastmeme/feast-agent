import { join } from "node:path";

import { utc8 } from "./register/copy.ts";
import type { LeagueRead } from "./register/site.ts";
import { agentPaths, readJson, writeJsonAtomic } from "./store.ts";

/**
 * When an agent `FL enter` started may trade (task 968; the coordinator's ruling C8). feast.meme's season starts at
 * 21:00 UTC+8 (the start, not a dinner: addendum 9), and the clients learn it only as `/api/league`'s countdown: the
 * start before it, the next dinner during the season. Trading opens at the start itself (addendum 12, the owner's
 * ruling of 2026-10-25 14:4x: no wait of 23 hours). The start is the site's: the runtime reads it from `/api/league`,
 * never from here (run 22: the owner moved season 1's start the night before, and only the site's clock moved). The first dinner, a day after the start, is still the warm-up (no floor,
 * eats nobody). An explicit `season.tradingOpensAt` from the page, when it sends one, is taken over the countdown.
 * Until then the waiting agent trades nothing; with no start announced it waits until told. The gate only holds
 * trading back: it loosens nothing.
 */

/** How often a closed gate reads the league again. */
export const GATE_READ_MS = 5 * 60_000;

export type Opening = { kind: "open" } | { kind: "at"; at: number } | { kind: "unknown" };

/** The instant trading opens, from one read of `/api/league`; `unknown` when the page names no start (or cannot be read). */
export function tradingOpens(read: LeagueRead | null): Opening {
  if (!read) return { kind: "unknown" };
  if (read.state === "over") return { kind: "open" };
  // The page's own instant, when it names one (addendum 12): it is the rule.
  if (read.season.tradingOpensAt !== undefined && read.season.tradingOpensAt !== null) return { kind: "at", at: read.season.tradingOpensAt };
  // The season has started: trading is open, from day 1 on.
  if (read.state === "season") return { kind: "open" };
  // Before it: the countdown is the start, and trading opens at that instant.
  const countdown = read.season.countdownTo;
  if ((read.state === "warm-up" || read.state === "coming-soon") && countdown !== null) return { kind: "at", at: countdown };
  return { kind: "unknown" };
}

/** "Ddd MM/DD HH:MM", the copy's short form of an instant in UTC+8 (addendum 12), always from the site's instant. */
export function utc8Day(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${day} ${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** `FL status` while the gate waits (addendum 12): the start and the opening are one instant. */
export function waitingStatusLine(opensAt: number | null): string {
  return opensAt === null ? "waiting for the season: it trades nothing until feast.meme announces the start" : `waiting for the season: season starts and trading opens ${utc8Day(opensAt)} UTC+8; it trades nothing before`;
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

/** Does `FL start` say "waits for the season" (addendum 10)? Only for an agent that waits, and only while its gate is not open. */
export const startSaysWaiting = (waitForSeason: boolean, g: GateState | null) => waitForSeason && g?.state !== "open" && g?.state !== "over";

/** The line a refused request and `FL status` say while the gate is closed. */
export function seasonClosedLine(opensAt: number | null): string {
  return opensAt === null ? "the season has not started; it opens when feast.meme announces the start" : `the season has not started; it opens at ${utc8(opensAt)} (UTC+8)`;
}
