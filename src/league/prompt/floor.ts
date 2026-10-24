import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { ENTRY_AGENT } from "../enter/constants.ts";
import { agentPaths, readJson } from "../store.ts";
import { ACTIVITY_FLOOR_BNB, ACTIVITY_FLOOR_TRADES, DINNER_HOUR_UTC } from "./constants.ts";

/**
 * The day's count (task 975): this agent's trades and volume since the last dinner, counted the way the league page
 * scores its activity floor (feast-app score.ts `agentTotals`): every buy and every sale is one trade, the volume is
 * the BNB paid on a buy and received on a sale, and the agent's own coin is left out. A day runs dinner to dinner,
 * 21:00 UTC+8 (13:00 UTC) to the next.
 *
 * It is read from the agent's own log (`buy.filled` and `sell.filled`, a late fill's included), so a restart in the
 * middle of a day keeps the count. A refusal, a failure or an intent is never a trade. Buys and sells of any Feast coin
 * count, FEAST's included: only the agent's own coin is left out, as the published rule and the settlement engine's
 * `dayActivity` count it (addendum 7; until then FEAST was left out here too, and the count fell short of the engine's).
 * It sees this machine's runtime only, so it can only be lower than the page's count, never higher: `steady` may
 * trade more than it needs, never less.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A day of even a busy agent's log is far less than this; past it, older lines are not read (the count is then a lower bound). */
const TAIL_BYTES = 8 * 1024 * 1024;

/** The first dinner (13:00:00 UTC) strictly after `now`. */
export function nextDinner(now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DINNER_HOUR_UTC);
  return today > now ? today : today + DAY;
}

export type DayCount = { startsAt: number; endsAt: number; trades: number; volumeWei: bigint; volumeBnb: number; passed: boolean };

export const passesFloor = (trades: number, volumeBnb: number) => trades >= ACTIVITY_FLOOR_TRADES && volumeBnb >= ACTIVITY_FLOOR_BNB;

const toBnb = (wei: bigint) => Number(wei) / 1e18;

const weiOf = (value: unknown): bigint | null => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,40}$/.test(value)) return BigInt(value);
  return null;
};

/** The log's tail, as lines; the first (possibly torn) line is dropped when the file is longer than the tail. */
export function tailLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const from = Math.max(0, size - TAIL_BYTES);
  const buffer = Buffer.alloc(size - from);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  return from > 0 ? lines.slice(1) : lines;
}

/**
 * The day's count for agent `name` at `now`: its fills in `[nextDinner(now) − 24 h, nextDinner(now))`, the coins in
 * `own` (lowercase addresses: its own coin, `leftOut`) left out.
 */
export function dayCount(home: string, name: string, now: number, own: Iterable<string>): DayCount {
  const endsAt = nextDinner(now);
  const startsAt = endsAt - DAY;
  const left = new Set([...own].map((c) => c.toLowerCase()));
  let trades = 0;
  let volumeWei = 0n;
  for (const line of tailLines(agentPaths(home, name).log)) {
    if (!line.includes(".filled")) continue;
    let entry: { at?: unknown; event?: unknown; coin?: unknown; bnbInWei?: unknown; bnbOutWei?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.event !== "buy.filled" && entry.event !== "sell.filled") continue;
    const at = Date.parse(String(entry.at));
    if (!Number.isFinite(at) || at < startsAt || at >= endsAt || at > now) continue;
    // A fill with no coin (a line from before league-v5's late fills) cannot be told apart from the own coin: not counted.
    if (typeof entry.coin !== "string" || left.has(entry.coin.toLowerCase())) continue;
    const wei = weiOf(entry.event === "buy.filled" ? entry.bnbInWei : entry.bnbOutWei);
    if (wei === null) continue;
    trades += 1;
    volumeWei += wei;
  }
  const volumeBnb = toBnb(volumeWei);
  return { startsAt, endsAt, trades, volumeWei, volumeBnb, passed: passesFloor(trades, volumeBnb) };
}

/** The coins the count leaves out for an agent: its own, that is its launch and the coin FL enter made or found for this wallet. FEAST counts. */
export function leftOut(home: string, launched: string | null | undefined): Set<string> {
  const body = readJson<{ bodyCoin?: unknown }>(join(agentPaths(home, ENTRY_AGENT).dir, "entry.json"))?.bodyCoin;
  return new Set([launched, typeof body === "string" ? body : null].filter((c): c is string => typeof c === "string" && c.length > 0).map((c) => c.toLowerCase()));
}

export type DayView = { startsAt: string; endsAt: string; trades: number; volumeBnb: number; floor: { trades: number; volumeBnb: number }; passed: boolean };

export function dayView(count: DayCount): DayView {
  return {
    startsAt: new Date(count.startsAt).toISOString(),
    endsAt: new Date(count.endsAt).toISOString(),
    trades: count.trades,
    volumeBnb: Number(count.volumeBnb.toFixed(6)),
    floor: { trades: ACTIVITY_FLOOR_TRADES, volumeBnb: ACTIVITY_FLOOR_BNB },
    passed: count.passed,
  };
}

const until = (ms: number) => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h} h ${minutes % 60} min` : `${minutes} min`;
};

/** What `FL status` and `FL data` say of the day. */
export function dayLine(view: DayView, now: number): string {
  return `today: ${view.trades} trade${view.trades === 1 ? "" : "s"}, ${view.volumeBnb} BNB of volume (the floor: ${view.floor.trades} and ${view.floor.volumeBnb} BNB, own coin left out): ${view.passed ? "passed" : "not yet"}; dinner at 21:00 UTC+8, in ${until(Date.parse(view.endsAt) - now)}`;
}
