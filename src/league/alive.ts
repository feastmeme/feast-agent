import { join } from "node:path";

import { utc8 } from "./register/copy.ts";
import { agentPaths, readJson } from "./store.ts";

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

/** "alive since … · last tick …" while running; "not running · last tick …" after. */
export function aliveLine(a: Alive | null, running: boolean, now: number): string {
  const tick = a?.lastTick ? `last tick ${utc8(Date.parse(a.lastTick))} UTC+8 (${ago(now - Date.parse(a.lastTick))})` : "no tick yet";
  if (running && a) return `alive since ${utc8(Date.parse(a.since))} UTC+8 · ${tick}`;
  return `not running · ${tick}`;
}
