import { join } from "node:path";

import { agentPaths, readJson, writeJsonAtomic } from "../store.ts";

/**
 * How often a prompt agent's runtime reads feast.meme's snapshot (task 975, addendum 6: poll by need). At 10,000
 * agents the 4.6 KB snapshot at a 4 s poll is about 1 TB a day of edge traffic; reading fast only when it matters cuts
 * it about tenfold. Fast (the `--poll` interval, 5–8 s by default) while the book holds a position (its stops, take-
 * profits and time stops are watched), within 60 s after a fill, and in the last 30 minutes before the dinner;
 * otherwise every 30–60 s, jittered; and once more right before each ask. The ETag stays: an unchanged snapshot is a
 * 304. A strategy that listens to events (a preset, a script) keeps its own cadence.
 */

export const SLOW_MIN_MS = 30_000;
export const SLOW_SPAN_MS = 30_000;
export const AFTER_FILL_MS = 60_000;
export const BEFORE_DINNER_MS = 30 * 60_000;

export type Cadence = { mode: "fast" | "slow"; why: string };

export function pollCadence(o: { now: number; positions: number; lastFillAt: number | null; dinnerAt: number }): Cadence {
  if (o.positions > 0) return { mode: "fast", why: "positions have stops" };
  if (o.lastFillAt !== null && o.now - o.lastFillAt >= 0 && o.now - o.lastFillAt < AFTER_FILL_MS) return { mode: "fast", why: "a fill in the last minute" };
  if (o.dinnerAt - o.now <= BEFORE_DINNER_MS) return { mode: "fast", why: "the last 30 minutes before dinner" };
  return { mode: "slow", why: "nothing to watch closely" };
}

/** The next slow read: 30–60 s from now. */
export const nextSlowRead = (now: number, random: () => number) => now + SLOW_MIN_MS + Math.floor(random() * SLOW_SPAN_MS);

export type CadenceState = Cadence & { fastSeconds: string; at: string };
const cadencePath = (home: string, name: string) => join(agentPaths(home, name).dir, "cadence.json");
export const writeCadence = (home: string, name: string, state: CadenceState) => writeJsonAtomic(cadencePath(home, name), state);
export const readCadence = (home: string, name: string) => readJson<CadenceState>(cadencePath(home, name));

/** What `FL status` says of the cadence. */
export function cadenceLine(state: CadenceState | null): string | null {
  if (!state) return null;
  return state.mode === "fast"
    ? `watching every ${state.fastSeconds} s now: ${state.why}; every 30–60 s otherwise`
    : `watching every 30–60 s; fast mode (every ${state.fastSeconds} s) while positions have stops, within a minute of a fill, and in the last 30 minutes before dinner`;
}
