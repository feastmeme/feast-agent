import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { activeWaits, doorOf, RATE_ID, rateIdFor, retryAfterUntil, withDoors } from "./doors.ts";

/**
 * Task 975, addendum 6 (lane 978): the write doors. The `feast_rl` cookie on the function routes only, never on a
 * CDN-cached GET; a 429's Retry-After honoured with no hot retry, said once, shown in FL status.
 */

const SITE = "https://feast.test";
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "feast-league-975-doors-"));
  dirs.push(d);
  return d;
};

function recorder(status = 200, retryAfter?: string) {
  const seen: { method: string; path: string; cookie: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ method: init?.method ?? "GET", path: url.pathname, cookie: new Headers(init?.headers).get("cookie") });
    return new Response("{}", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("which routes are doors", () => {
  it("register, the notes session, a note's POST, the prompt; never the snapshot, pools, candles, the board or the notes feed", () => {
    expect(doorOf("POST", "/api/league/register")).toBe("register");
    expect(doorOf("GET", "/api/league/register")).toBe("register");
    expect(doorOf("POST", "/api/league/notes/session")).toBe("session");
    expect(doorOf("POST", "/api/league/notes")).toBe("notes");
    expect(doorOf("POST", "/api/league/prompt")).toBe("prompt");
    for (const path of ["/api/v1/snapshot", "/api/v1/pools", "/api/v1/ohlcv", "/api/league", "/api/league/agent-id"]) expect(doorOf("GET", path), path).toBeNull();
    expect(doorOf("GET", "/api/league/notes")).toBeNull();
  });
});

describe("the identity cookie", () => {
  it("each agent's own feast_rl, 32 hex digits, minted once; sent on the doors only", async () => {
    const h = home();
    const a = rateIdFor(h, "demo");
    expect(a).toMatch(RATE_ID);
    expect(rateIdFor(h, "demo")).toBe(a);
    expect(rateIdFor(h, "other")).not.toBe(a);
    const r = recorder();
    const f = withDoors(r.fetchImpl, { site: SITE, home: h, name: "demo" });
    await f(`${SITE}/api/league/notes`, { method: "POST", headers: { "content-type": "application/json" } });
    await f(`${SITE}/api/league/notes?since=x`);
    await f(`${SITE}/api/v1/snapshot`, { headers: { "if-none-match": '"e"' } });
    await f(`${SITE}/api/league?view=today&field=1&limit=10000`);
    await f(`https://indexer.test/api/league/notes`, { method: "POST" });
    expect(r.seen.map((s) => [s.path, s.cookie])).toEqual([
      ["/api/league/notes", `feast_rl=${a}`],
      ["/api/league/notes", null],
      ["/api/v1/snapshot", null],
      ["/api/league", null],
      ["/api/league/notes", null],
    ]);
  });
});

describe("Retry-After", () => {
  it("as seconds or a date; 60 s when it says nothing usable", () => {
    expect(retryAfterUntil("30", 1_000)).toBe(31_000);
    expect(retryAfterUntil(new Date(500_000).toUTCString(), 1_000)).toBe(500_000);
    expect(retryAfterUntil(null, 1_000)).toBe(61_000);
  });

  it("a 429 is recorded and said once; inside the wait nothing goes out (a local 429); after it, the door opens again", async () => {
    const h = home();
    let t = 1_000_000;
    const logs: string[] = [];
    const limited = recorder(429, "120");
    const f = withDoors(limited.fetchImpl, { site: SITE, home: h, name: "demo", now: () => t, log: (e) => logs.push(e) });
    expect((await f(`${SITE}/api/league/notes`, { method: "POST" })).status).toBe(429);
    expect(activeWaits(h, "demo", t)).toEqual([{ door: "notes", until: t + 120_000 }]);
    t += 60_000;
    const local = await f(`${SITE}/api/league/notes`, { method: "POST" });
    expect(local.status).toBe(429);
    expect(limited.seen).toHaveLength(1);
    // Other doors are their own buckets.
    await f(`${SITE}/api/league/notes/session`, { method: "POST" });
    expect(limited.seen).toHaveLength(2);
    expect(logs).toEqual(["door.wait", "door.wait"]);
    t += 61_000;
    const ok = recorder(201);
    const g = withDoors(ok.fetchImpl, { site: SITE, home: h, name: "demo", now: () => t });
    expect((await g(`${SITE}/api/league/notes`, { method: "POST" })).status).toBe(201);
    expect(activeWaits(h, "demo", t).map((w) => w.door)).toEqual(["session"]);
  });
});
