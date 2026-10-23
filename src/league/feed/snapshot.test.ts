import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { LeagueChain } from "../chain.ts";
import { cursorAt } from "../events.ts";
import { Market } from "../market.ts";
import { MarketFeed } from "./feed.ts";
import { BOB, C1, coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody, tradeRow, WALLET } from "./fakes.ts";
import { parsePoll, readSnapshotCache, snapshotCachePath, SnapshotClient } from "./snapshot.ts";

const T0 = Date.parse("2026-10-26T13:00:00Z");
let homes: string[] = [];
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});
const tmpHome = () => {
  const h = mkdtempSync(join(tmpdir(), "feast-league-feed-"));
  homes.push(h);
  return h;
};

function clock(start = T0) {
  const c = { t: start };
  return { c, now: () => c.t };
}

describe("--poll", () => {
  it("defaults to 5 s; 3 s is the floor; below it is refused with one line, never clamped", () => {
    expect(parsePoll(undefined)).toEqual({ ok: true, seconds: 5 });
    expect(parsePoll("3")).toEqual({ ok: true, seconds: 3 });
    expect(parsePoll("12.5")).toEqual({ ok: true, seconds: 12.5 });
    expect(parsePoll("2")).toEqual({ ok: false, error: "the poll is at least 3 s" });
    expect(parsePoll("0")).toEqual({ ok: false, error: "the poll is at least 3 s" });
    for (const bad of ["fast", "", "5s", "-4", "Infinity"]) expect(parsePoll(bad).ok, bad).toBe(false);
  });
});

describe("the snapshot client", () => {
  it("sends If-None-Match with the last ETag; a 304 keeps what it holds, unparsed", async () => {
    const { c, now } = clock();
    let parsed = 0;
    const sent: (string | null)[] = [];
    const body = JSON.stringify(snapshotBody());
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const inm = new Headers(init?.headers).get("if-none-match");
      sent.push(inm);
      if (inm === '"g1"') {
        // A 304 whose body would throw if anyone read it.
        return { status: 304, headers: new Headers({ etag: '"g1"' }), text: async () => ((parsed += 1), "{"), json: async () => ((parsed += 1), {}) } as unknown as Response;
      }
      return { status: 200, headers: new Headers({ etag: '"g1"' }), text: async () => ((parsed += 1), body) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new SnapshotClient({ site: SITE, fetch: fetchImpl, now, random: seeded(1) });
    expect((await client.read()).kind).toBe("new");
    const held = client.held;
    expect(parsed).toBe(1);
    c.t = client.nextAt;
    expect((await client.read()).kind).toBe("same");
    expect(client.held).toBe(held);
    expect(parsed).toBe(1);
    expect(sent).toEqual([null, '"g1"']);
  });

  it("a 200 after a 304 replaces the snapshot; an older copy served after a newer one never replaces it", async () => {
    const { c, now } = clock();
    let block = 100;
    const feed = new FakeFeed(now, () => ({ status: 200, body: snapshotBody({ block }), etag: `"s${block}"` }));
    const client = new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(2) });
    await client.read();
    c.t = client.nextAt;
    expect((await client.read()).kind).toBe("same");
    block = 105;
    c.t = client.nextAt;
    expect((await client.read()).kind).toBe("new");
    expect(client.held?.block).toBe(105);
    // A CDN copy from before: a fresh ETag, an older cursor.
    block = 101;
    c.t = client.nextAt;
    expect((await client.read()).kind).toBe("same");
    expect(client.held?.block).toBe(105);
  });

  it("asks nothing with a wallet header, a token or a cookie: the CDN keeps one copy (ruling C4)", async () => {
    const { now } = clock();
    const feed = new FakeFeed(now);
    await new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(3) }).read();
    expect(Object.keys(feed.snapshots()[0]!.headers).sort()).toEqual(["accept"]);
  });

  it("the interval is poll × 1000 + U(0, 3000), drawn afresh: within [5 s, 8 s] by default and [3 s, 6 s] at --poll 3", async () => {
    for (const [poll, low, high] of [
      [5, 5_000, 8_000],
      [3, 3_000, 6_000],
    ] as const) {
      const { c, now } = clock();
      const feed = new FakeFeed(now);
      const client = new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(poll), pollSeconds: poll });
      const gaps: number[] = [];
      for (let i = 0; i < 400; i += 1) {
        const at = c.t;
        await client.read();
        gaps.push(client.nextAt - at);
        c.t = client.nextAt;
      }
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(low);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(high);
      // Drawn afresh: spread across the window, not one value.
      expect(new Set(gaps.map((g) => Math.floor(g / 500))).size).toBeGreaterThanOrEqual(5);
    }
  });

  it("never asks early, never two at once", async () => {
    const { c, now } = clock();
    const feed = new FakeFeed(now);
    const client = new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(4) });
    const [a, b] = await Promise.all([client.read(), client.read()]);
    expect([a.kind, b.kind].sort()).toEqual(["new", "wait"]);
    c.t += 1_000;
    expect((await client.read()).kind).toBe("wait");
    expect(feed.snapshots()).toHaveLength(1);
  });

  it("a 429 backs off from 2 s, never under 3 s between two asks; the held snapshot stays, marked stale", async () => {
    const { c, now } = clock();
    let down = false;
    const feed = new FakeFeed(now, () => (down ? { status: 429, body: {}, headers: { "retry-after": "1" } } : { status: 200, body: snapshotBody(), etag: '"a"' }));
    const lines: string[] = [];
    const client = new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(5), log: (e) => lines.push(e) });
    await client.read();
    down = true;
    for (let i = 0; i < 6; i += 1) {
      c.t = client.nextAt;
      expect((await client.read()).kind).toBe("failed");
    }
    const at = feed.snapshots().map((s) => s.at);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(3_000);
    expect(client.held).not.toBeNull();
    expect(client.stale()).toMatchObject({ sinceMs: T0, reason: "HTTP 429" });
    expect(lines).toEqual(["feed.backoff", "feed.stale"]);
    down = false;
    c.t = client.nextAt;
    await client.read();
    expect(client.stale()).toBeNull();
    expect(lines).toEqual(["feed.backoff", "feed.stale", "feed.ok"]);
  });

  it("a malformed 200 is a failure, not a snapshot: nothing it says is taken", async () => {
    const { now } = clock();
    const feed = new FakeFeed(now, () => ({ status: 200, body: { coins: "lots", events: null } }));
    const client = new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(6) });
    expect((await client.read()).kind).toBe("failed");
    expect(client.held).toBeNull();
  });
});

describe("the home's one snapshot cache", () => {
  it("holds the newest good snapshot and its ETag, with the wallet's address written as self; a second reader asks with that ETag", async () => {
    const home = tmpHome();
    const { c, now } = clock();
    const own = coinRow(C1, { creator: WALLET.toUpperCase().replace("0X", "0x") });
    const feed = new FakeFeed(now, () => ({ status: 200, body: snapshotBody({ coins: [own, coinRow(BOB)], events: [tradeRow(100, 1, { payer: WALLET.toLowerCase() })] }), etag: '"c1"' }));
    const runtime = new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(7), cache: { home, wallet: WALLET } });
    await runtime.read();
    const hex = WALLET.slice(2).toLowerCase();
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    expect(walk(home)).toEqual([snapshotCachePath(home)]);
    for (const f of walk(home)) expect(readFileSync(f, "utf8").toLowerCase().includes(hex), f).toBe(false);
    expect(readFileSync(snapshotCachePath(home), "utf8")).toContain('"self"');
    // In memory only, "self" is the wallet again.
    const cached = readSnapshotCache(home, WALLET);
    expect(cached).toMatchObject({ at: T0, etag: '"c1"' });
    expect(cached!.snapshot.coins[0]).toMatchObject({ creator: WALLET.toLowerCase() });
    // FL data, a second later: the same ETag, so a 304 and no parse.
    c.t += 6_000;
    const data = new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(8), cache: { home, wallet: WALLET }, seed: cached });
    expect((await data.read()).kind).toBe("same");
    expect(feed.snapshots().at(-1)!.headers["if-none-match"]).toBe('"c1"');
    expect(readSnapshotCache(home, WALLET)!.at).toBe(T0 + 6_000);
  });

  it("without the wallet's address nothing is written: the scrub could not be done", async () => {
    const home = tmpHome();
    const { now } = clock();
    const feed = new FakeFeed(now);
    await new SnapshotClient({ site: SITE, fetch: feed.fetch, now, random: seeded(9), cache: { home, wallet: null } }).read();
    expect(readSnapshotCache(home, null)).toBeNull();
  });
});

describe("before tasks 965 and 966 deploy: the 404 fallback", () => {
  const chain = { coinInfo: async () => null, quoteBnbE18: async () => 10n ** 18n, markWei: async () => 0n } as unknown as LeagueChain;

  it("a 404 logs snapshot.unavailable once and falls back to the legacy reads at the same 5–8 s; the route is asked again after 10 min", async () => {
    const { c, now } = clock();
    let live = false;
    const feed = new FakeFeed(now, () => (live ? { status: 200, body: snapshotBody({ block: 400, events: [tradeRow(401, 0)] , cursor: cursorAt(401, 0) }), etag: '"live"' } : { status: 404, body: { error: "not-found" } }));
    let polled = 0;
    feed.events = (_at, url) => {
      if (url.searchParams.get("limit") === "1") return { status: 200, body: { asOf: { block: 300 }, data: [] } };
      polled += 1;
      return { status: 200, body: { data: polled === 2 ? [tradeRow(300 + polled, 0)] : [] } };
    };
    const lines: string[] = [];
    const market = new Market(chain, { indexer: INDEXER, fetch: feed.fetch, log: () => {} });
    const mf = new MarketFeed({ site: SITE, indexer: INDEXER, fetch: feed.fetch, now, random: seeded(10), market, log: (e) => lines.push(e) });
    const seen: number[] = [];
    while (c.t < T0 + 11 * 60_000) {
      // Deployed while the runtime is on the legacy reads: seen at the first recheck.
      if (c.t >= T0 + 9 * 60_000) live = true;
      for (const e of await mf.step({ events: true })) seen.push(e.block);
      c.t = mf.nextAt;
    }
    expect(lines.filter((l) => l === "snapshot.unavailable")).toHaveLength(1);
    const snaps = feed.snapshots().map((s) => s.at - T0);
    expect(snaps[0]).toBe(0);
    // Asked again once the 10 minutes are up, and not before.
    expect(snaps[1]).toBeGreaterThanOrEqual(10 * 60_000);
    const legacy = feed.asked.filter((a) => a.url.includes("/v1/events?types=launch,trade")).map((a) => a.at);
    expect(legacy.length).toBeGreaterThan(60);
    for (let i = 1; i < legacy.length; i += 1) {
      const gap = legacy[i]! - legacy[i - 1]!;
      // 5–8 s, or one interval more where a recheck of the route took the slot.
      expect(gap).toBeGreaterThanOrEqual(5_000);
      expect(gap).toBeLessThanOrEqual(16_000);
    }
    // The legacy poller still cycles its limit, so no query repeats inside the indexer's 30 s cache.
    const limits = feed.asked.filter((a) => a.url.includes("types=launch,trade")).slice(0, 15).map((a) => new URL(a.url).searchParams.get("limit"));
    expect(new Set(limits).size).toBe(15);
    expect(seen).toContain(302);
    // Once the route answers, the runtime is back on it, and says so once.
    expect(mf.mode).toBe("snapshot");
    expect(lines.filter((l) => l === "snapshot.available")).toHaveLength(1);
  });

  it("--live forces the legacy reads, at the same interval, and never asks the snapshot route", async () => {
    const { c, now } = clock();
    const feed = new FakeFeed(now);
    const market = new Market(chain, { indexer: INDEXER, fetch: feed.fetch, log: () => {} });
    const mf = new MarketFeed({ site: SITE, indexer: INDEXER, fetch: feed.fetch, now, random: seeded(11), market, log: () => {}, live: true });
    while (c.t < T0 + 15 * 60_000) {
      await mf.step({ events: true });
      c.t = mf.nextAt;
    }
    expect(feed.snapshots()).toEqual([]);
    expect(mf.mode).toBe("legacy");
    const at = feed.asked.filter((a) => a.url.includes("types=launch,trade")).map((a) => a.at);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(5_000);
  });
});
