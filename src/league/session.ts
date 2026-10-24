import type { WalletSettings } from "./baw.ts";
import type { SessionCode } from "./register/copy.ts";
import { agentPaths, readJson } from "./store.ts";

/**
 * The wallet's sign-in, and the reminder to scan again (docs/PLAN-941.md §7).
 *
 * Measured on 2026-10-22: `sessionExpireTime` and `inactiveSignOutTime` are
 * both "now + 48 h" on every read — an inactivity timeout that each wallet read
 * pushes forward — while `signInMaxTime` is the fixed end of the sign-in,
 * about 7 days after the scan. A running agent reads the wallet every 5
 * minutes, so only `signInMaxTime` ever comes near. The end is the earliest of
 * the three that are known.
 *
 * The reminder speaks once per sign-in: at 24 h (task 975, addendum 8), at 6 h,
 * at 1 h, when it ends, and once more when the user has scanned again. A step
 * first seen late is said once, and the earlier ones are counted as said. What it has said is kept on disk,
 * keyed by the sign-in, so a restart never repeats it.
 *
 * THE WALLET IS THE AUTHORITY. The known end only says when to ask: once it has
 * passed, the runtime asks the wallet at once, and only a wallet that says it is
 * not connected (or cannot be read past the end) counts as signed out. A wallet
 * that still says CONNECTED with its settings read is believed over its own
 * end time and over this machine's clock, so a wrong field or a fast clock can
 * never hold the agent's exits.
 */

export type SessionView = { key: string | null; end: number | null; source: "sign-in limit" | "inactivity" | null };

const at = (v: string | null | undefined) => (v ? Date.parse(v) : Number.NaN);

export function sessionView(settings: Pick<WalletSettings, "sessionExpireTime" | "inactiveSignOutTime" | "signInMaxTime">): SessionView {
  const limit = at(settings.signInMaxTime);
  const idle = Math.min(...[at(settings.sessionExpireTime), at(settings.inactiveSignOutTime)].filter(Number.isFinite));
  const key = settings.signInMaxTime ?? null;
  if (Number.isFinite(limit) && (!Number.isFinite(idle) || limit <= idle)) return { key, end: limit, source: "sign-in limit" };
  if (Number.isFinite(idle)) return { key, end: idle, source: "inactivity" };
  return { key, end: null, source: null };
}

export type SessionMemory = { key: string | null; end: number | null; said: SessionCode[] };

export const freshMemory = (): SessionMemory => ({ key: null, end: null, said: [] });

/**
 * One reading of the wallet. `connected` is `wallet status`; `view` is null
 * when the settings could not be read (then the last known end stands).
 * Returns what to say now, the memory to keep, and whether the wallet counts
 * as signed out.
 */
export function sessionStep(memory: SessionMemory, reading: { connected: boolean; view: SessionView | null }, now: number): { say: SessionCode[]; memory: SessionMemory; signedOut: boolean } {
  let next: SessionMemory = { ...memory, said: [...memory.said] };
  const say: SessionCode[] = [];
  if (reading.view) {
    // A new sign-in: everything is said afresh, after one "back" if the last one had ended.
    if (reading.view.key !== null && reading.view.key !== memory.key) {
      if (memory.said.includes("ended") && reading.connected) say.push("back");
      next = { key: reading.view.key, end: reading.view.end, said: [] };
    } else next.end = reading.view.end;
    // Connected, settings read, yet past the end it gave: the wallet is believed, and that end is not one.
    if (reading.connected && next.end !== null && now >= next.end) next.end = null;
  }
  const signedOut = !reading.connected || (next.end !== null && now >= next.end);
  if (signedOut) {
    if (!next.said.includes("ended")) {
      say.push("ended");
      next.said.push("ended");
    }
    return { say, memory: next, signedOut };
  }
  if (next.said.includes("ended")) {
    // Signed in again on the same key (the wallet gives no new sign-in time): say so once, and re-arm.
    say.push("back");
    next.said = [];
  }
  if (next.end !== null) {
    const left = next.end - now;
    // The nearest step the time left is under: said once; the ones before it count as said.
    const step = SESSION_STEPS.find((s) => left < s.ms);
    if (step && !next.said.includes(step.code)) {
      say.push(step.code);
      for (const s of SESSION_STEPS) if (s.ms >= step.ms && !next.said.includes(s.code)) next.said.push(s.code);
    }
  }
  return { say, memory: next, signedOut };
}

/** The reminder's steps before the end, nearest first. */
export const SESSION_STEPS: { code: SessionCode; ms: number }[] = [
  { code: "1h", ms: 3_600_000 },
  { code: "6h", ms: 6 * 3_600_000 },
  { code: "24h", ms: 24 * 3_600_000 },
];

/** The pack's one line in the sign-in's last 24 h (addendum 8), so the host can tell the player; null before. */
export function signInWarning(end: number | null, now: number): string | null {
  if (end === null || end - now >= 24 * 3_600_000) return null;
  if (end <= now) return "WALLET SIGN-IN ENDED: the agent cannot trade or exit until the player scans again; tell the player to run FL login.";
  const hours = Math.max(1, Math.ceil((end - now) / 3_600_000));
  return `WALLET SIGN-IN EXPIRES IN ${hours} H: the agent will stop; tell the player to run FL login.`;
}

/** The re-scan line for the entry card and `FL status` (addendum 8). */
export function signInLine(end: number | null, utc8: (ms: number) => string): string | null {
  return end === null ? null : `wallet sign-in valid until ${utc8(end)} UTC+8; re-scan before then or the agent stops trading (FL login says how)`;
}

/** The sign-in's end as the running agent last read it (its `session.json`); null when not known. */
export function signInEndOf(home: string, name: string): number | null {
  const end = readJson<SessionMemory>(agentPaths(home, name).session)?.end;
  return typeof end === "number" && Number.isFinite(end) ? end : null;
}

/** Between two readings: has the known end passed? */
export const pastEnd = (memory: SessionMemory, now: number) => memory.end !== null && now >= memory.end;
