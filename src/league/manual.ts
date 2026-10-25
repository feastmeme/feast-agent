import { join } from "node:path";

import { withHostHeaders } from "./headers.ts";
import { liveToken } from "./notes/session.ts";
import { agentPaths, readJson, writeJsonAtomic } from "./store.ts";

/**
 * Manual mode (task 975, run 21; the owner's ruling of 2026-10-25): a host whose background processes die when the
 * command returns (Binance AI Pro's sandbox, which has no scheduler either) cannot keep the loop. The player drives the
 * agent from the chat, one command at a time. Each command does what the loop would, within the same limits and gate;
 * what the loop did between commands is either done by the command itself (the seat's heartbeat) or not at all (the
 * autopilot, the floor keeper, the stop-loss watcher), and the copy says so.
 */

/** The last thing the player did by hand, for `FL status`: when, and in one line what became of it. */
export type ManualAction = { at: string; what: string };
export const manualPath = (home: string, name: string) => join(agentPaths(home, name).dir, "manual-last.json");
export const readManual = (home: string, name: string) => readJson<ManualAction>(manualPath(home, name));
export function recordManual(home: string, name: string, what: string, now = Date.now()): void {
  writeJsonAtomic(manualPath(home, name), { at: new Date(now).toISOString(), what: what.slice(0, 200) } satisfies ManualAction);
}

/**
 * The seat's heartbeat on a manual command: the v5.1.1 beacon (`/api/league?me=<wallet>` with the notes session's
 * bearer token), once per command, at most once per 2 minutes per agent, so a manual player's seat stays lit. Never
 * the answer read; the token never logged or printed. The command does not wait for it, but the process waits a
 * moment for it before it exits (`settleBeats`), or the request would die with the process.
 */
export const MANUAL_BEAT_MS = 2 * 60_000;
const beatsPath = (home: string) => join(home, "cache", "manual-beat.json");
const pending: Promise<unknown>[] = [];

export type BeatResult = "sent" | "throttled" | "no-session" | "no-wallet" | "failed";

export function manualBeat(o: { home: string; name: string; site: string; fetch: typeof fetch; wallet: () => Promise<string | null>; now?: number; timeoutMs?: number }): Promise<BeatResult> {
  const run = (async (): Promise<BeatResult> => {
    const now = o.now ?? Date.now();
    const token = liveToken(o.home);
    if (!token) return "no-session";
    const kept = readJson<Record<string, number>>(beatsPath(o.home)) ?? {};
    if (typeof kept[o.name] === "number" && now - kept[o.name]! < MANUAL_BEAT_MS) return "throttled";
    const wallet = await Promise.race([o.wallet().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 5_000).unref())]);
    if (!wallet) return "no-wallet";
    // Kept before the read: two commands at once send one.
    writeJsonAtomic(beatsPath(o.home), { ...kept, [o.name]: now });
    const site = o.site.replace(/\/+$/, "");
    try {
      const r = await withHostHeaders(o.fetch, [site])(`${site}/api/league?view=today&limit=1&me=${wallet.toLowerCase()}`, { headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(o.timeoutMs ?? 5_000) });
      await r.body?.cancel().catch(() => undefined);
      return r.status === 200 ? "sent" : "failed";
    } catch {
      return "failed";
    }
  })();
  pending.push(run);
  return run;
}

/** Before the CLI exits: the heartbeats in flight get up to `maxMs` to go out. */
export async function settleBeats(maxMs = 3_000): Promise<void> {
  if (pending.length === 0) return;
  await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, maxMs).unref())]);
}
