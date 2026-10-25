import { join } from "node:path";

import { utc8 } from "./register/copy.ts";
import { agentPaths, pidAlive, readJson, writeJsonAtomic } from "./store.ts";

/**
 * Is the agent alive, and when did it last work (task 975, addendum 11)? The runtime writes `alive.json` at its start,
 * once a minute, and after each safety pass that worked (`lastTick`: the balance, the marks and the exits read).
 * `FL status` and `FL card` say it; a stopped runtime leaves its last one, so the last tick still shows.
 */

export type Alive = { since: string; lastTick: string | null; lastLoop: string; pid: number };
export const alivePath = (home: string, name: string) => join(agentPaths(home, name).dir, "alive.json");
export const readAlive = (home: string, name: string) => readJson<Alive>(alivePath(home, name));

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1_440)} days ago`;
};

/**
 * Run 21 (the Grok cloud rehearsal): right after a start, `FL status` said "not running" for the seconds the runtime
 * takes to boot. The start writes this marker; until the first tick after it, or 30 s, the agent is "starting".
 */
export const STARTING_MS = 30_000;
const startingPath = (home: string, name: string) => join(agentPaths(home, name).dir, "starting.json");
export function markStarting(home: string, name: string, pid: number | null, now = Date.now()): void {
  writeJsonAtomic(startingPath(home, name), { at: new Date(now).toISOString(), pid });
}
export function startingNow(home: string, name: string, now = Date.now()): boolean {
  const m = readJson<{ at?: string; pid?: number | null }>(startingPath(home, name));
  const at = m?.at ? Date.parse(m.at) : Number.NaN;
  if (!Number.isFinite(at) || now - at > STARTING_MS || now < at - 60_000) return false;
  const tick = readAlive(home, name)?.lastTick;
  if (tick && Date.parse(tick) >= at) return false;
  return !m?.pid || pidAlive(m.pid);
}

/** "alive since … · last tick …" while running; "starting" just after a start; "not running · last tick …" after. */
export function aliveLine(a: Alive | null, running: boolean, now: number, starting = false): string {
  const tick = a?.lastTick ? `last tick ${utc8(Date.parse(a.lastTick))} UTC+8 (${ago(now - Date.parse(a.lastTick))})` : "no tick yet";
  if (starting) return `starting · ${tick}`;
  if (running && a) return `alive since ${utc8(Date.parse(a.since))} UTC+8 · ${tick}`;
  return `not running · ${tick}`;
}
