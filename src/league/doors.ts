import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { agentPaths, readJson, writeJsonAtomic } from "./store.ts";

/**
 * feast.meme's write doors at scale (task 975, addendum 6; lane 978's contract). The function routes (register,
 * the notes session, a note's POST, the prompt) answer `429` with `Retry-After` from per-wallet buckets (register 3 a
 * minute, the session 5, notes 20, the prompt 6), and tell callers apart by a `feast_rl` cookie: 32 hex digits.
 *
 * So, on those routes only, this fetch:
 * - sends the agent's own `feast_rl` (minted once, kept in the agent's folder), so N agents behind one IP are N
 *   identities;
 * - while a door has asked to wait, answers a local 429 at once and asks nothing (no hot retry);
 * - records a 429's `Retry-After` (seconds or a date; 60 s when absent), says it once, and leaves it for `FL status`.
 *
 * Every other request passes untouched, and the CDN-cached GETs (the snapshot, the pools, the candles, the league's
 * board, the public notes feed) never carry the cookie: a cookie there could split the edge cache.
 */

export type Door = "register" | "session" | "notes" | "prompt";
export const RATE_COOKIE = "feast_rl";
const DEFAULT_WAIT_MS = 60_000;

/** The door a request is, or null: the function routes only, never a cached GET. */
export function doorOf(method: string, path: string): Door | null {
  const m = method.toUpperCase();
  if (path === "/api/league/notes/session") return "session";
  if (path.startsWith("/api/league/register")) return "register";
  if (path.startsWith("/api/league/prompt")) return "prompt";
  // The notes feed's GET is public and cached: only a note's POST is the door.
  if (path === "/api/league/notes" && m === "POST") return "notes";
  return null;
}

export const mintRateId = () => randomBytes(16).toString("hex");
export const RATE_ID = /^[0-9a-f]{32}$/;

/** The agent's own `feast_rl`, minted on first use and kept in its folder. */
export function rateIdFor(home: string, name: string): string {
  const path = join(agentPaths(home, name).dir, "feast_rl.json");
  const kept = readJson<{ id?: unknown }>(path);
  if (typeof kept?.id === "string" && RATE_ID.test(kept.id)) return kept.id;
  const id = mintRateId();
  writeJsonAtomic(path, { id });
  return id;
}

type Waits = Partial<Record<Door, { until: number; at: number; status: number }>>;
const waitsPath = (home: string, name: string) => join(agentPaths(home, name).dir, "doors.json");
export const readWaits = (home: string, name: string): Waits => readJson<Waits>(waitsPath(home, name)) ?? {};

/** `Retry-After` as the wait's end: seconds, or an HTTP date; 60 s when it says nothing a client can use. */
export function retryAfterUntil(header: string | null, now: number): number {
  const v = header?.trim() ?? "";
  if (/^\d{1,6}$/.test(v)) return now + Number(v) * 1_000;
  const at = Date.parse(v);
  return Number.isFinite(at) && at > now ? at : now + DEFAULT_WAIT_MS;
}

/** The doors still waiting, for `FL status`: which, and until when. */
export function activeWaits(home: string, name: string, now: number): { door: Door; until: number }[] {
  return Object.entries(readWaits(home, name))
    .filter(([, w]) => w && w.until > now)
    .map(([door, w]) => ({ door: door as Door, until: w!.until }));
}

export function withDoors(fetchImpl: typeof fetch, o: { site: string; home: string; name: string; now?: () => number; log?: (event: string, fields: Record<string, unknown>) => void }): typeof fetch {
  const origin = (() => {
    try {
      return new URL(o.site).origin;
    } catch {
      return null;
    }
  })();
  const now = o.now ?? Date.now;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const door = url.origin === origin ? doorOf(method, url.pathname) : null;
    if (!door) return fetchImpl(input, init);
    const waits = readWaits(o.home, o.name);
    const wait = waits[door];
    if (wait && wait.until > now()) {
      // Asked to wait: nothing goes out until then.
      return new Response(JSON.stringify({ error: { code: "rate-limited", retryAt: new Date(wait.until).toISOString() } }), { status: 429, headers: { "retry-after": String(Math.ceil((wait.until - now()) / 1_000)), "content-type": "application/json" } });
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const cookie = `${RATE_COOKIE}=${rateIdFor(o.home, o.name)}`;
    headers.set("cookie", headers.get("cookie") ? `${headers.get("cookie")}; ${cookie}` : cookie);
    const response = await fetchImpl(input, { ...init, headers });
    if (response.status === 429) {
      const until = retryAfterUntil(response.headers.get("retry-after"), now());
      const known = waits[door];
      writeJsonAtomic(waitsPath(o.home, o.name), { ...waits, [door]: { until, at: now(), status: 429 } });
      // Said once a wait: a second 429 inside the same wait (a refreshed one) is not logged again.
      if (!known || known.until <= now()) o.log?.("door.wait", { door, until: new Date(until).toISOString() });
    }
    return response;
  }) as typeof fetch;
}
