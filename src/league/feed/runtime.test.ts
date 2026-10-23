import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent, type PlanInput } from "../agent.ts";
import { auditFile, recordModelVerdict } from "../audit/verdict.ts";
import { emptyBook, recordBuy, serializeBook } from "../book.ts";
import type { LeagueChain } from "../chain.ts";
import { FEAST, fakeClock, tradeWorld } from "../prompt/fakes.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths, writeFileAtomic, writeJsonAtomic } from "../store.ts";
import { C1, C2, coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody } from "./fakes.ts";

/**
 * The runtime on the snapshot feed (task 967), with the loop's own fakes: a made-up wallet, the fake chain that fills a
 * trade end to end, a clock the loop's sleep moves, and feast.meme's snapshot served in process.
 */

const T0 = Date.parse("2026-10-26T13:00:00Z");
const S = 1_000;
const MIN = 60_000;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function home(plan: Omit<PlanInput, "name">) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-967-"));
  dirs.push(dir);
  const h = join(dir, "home");
  const planned = planAgent({ name: "demo", ...plan });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(h, confirmAgent(planned.agent, new Date(T0)));
  return { home: h, dir };
}

const lines = (h: string) =>
  existsSync(agentPaths(h, "demo").log)
    ? readFileSync(agentPaths(h, "demo").log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string })
    : [];

/** The chain's reads, counted by name. */
function counted(chain: LeagueChain) {
  const reads: string[] = [];
  const wrapped = new Proxy(chain as unknown as Record<string, unknown>, {
    get(target, key) {
      const value = target[key as string];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => (reads.push(String(key)), (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  }) as unknown as LeagueChain;
  return { chain: wrapped, reads };
}

const inbox = (h: string, file: string, body: unknown) => {
  mkdirSync(agentPaths(h, "demo").inbox, { recursive: true });
  writeJsonAtomic(join(agentPaths(h, "demo").inbox, file), body);
};

describe("the board from the held snapshot", () => {
  it("a momentum agent's tick fetches nothing and makes no per-row chain read: its rows are the newest snapshot's", async () => {
    const { home: h } = home({ preset: "momentum" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const { chain, reads } = counted(w.chain);
    const feed = new FakeFeed(c.now, () => ({ status: 200, body: snapshotBody({ coins: [coinRow(C1), coinRow(C2)] }), etag: '"one"' }));
    await runAgent({ home: h, name: "demo", signer: w.signer, chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(1), loopMs: S, maxRuntimeMs: 3 * MIN, out: () => {} });
    // Every request was a snapshot read, at the feed's own 5–8 s; none came from the three ticks.
    expect(feed.asked.every((a) => a.url === `${SITE}/api/v1/snapshot`)).toBe(true);
    expect(feed.asked.length).toBeGreaterThanOrEqual(Math.floor(180 / 9));
    expect(feed.asked.length).toBeLessThanOrEqual(Math.ceil(180 / 5) + 1);
    // One parse (the first 200); every later read a 304.
    expect(reads.filter((r) => r === "coinInfo" || r === "quoteBnbE18")).toEqual([]);
    const log = lines(h);
    expect(log.filter((l) => l.event === "tick.failed")).toEqual([]);
    expect(log.filter((l) => l.event === "board.failed" || l.event === "events.failed")).toEqual([]);
  });

  it("a prompt agent without an autopilot makes no snapshot request at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feast-league-967-"));
    dirs.push(dir);
    const promptPath = join(dir, "strategy.md");
    writeFileSync(promptPath, "Buy what moves.\n");
    const { home: h } = home({ promptPath });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const feed = new FakeFeed(c.now);
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(2), loopMs: S, maxRuntimeMs: 10 * MIN, out: () => {} });
    expect(feed.asked).toEqual([]);
  });
});

describe("the loop under 429s", () => {
  const outage = (c: { now: () => number }, from: number) =>
    new FakeFeed(c.now, (at) => (at >= T0 + from ? { status: 429, body: { error: "rate-limited" }, headers: { "retry-after": "5" } } : { status: 200, body: snapshotBody(), etag: '"g"' }));

  it("a queued manual buy is processed, and the feed logs one line each way, never one per failed read", async () => {
    const { home: h } = home({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const feed = outage(c, 10 * S);
    c.at(T0 + 60 * S, () => inbox(h, "1-buy.json", { type: "intent", requestId: "req-1", request: { kind: "buy", coin: FEAST, bnb: 0.002, reason: "manual buy" } }));
    const said: string[] = [];
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(3), loopMs: S, maxRuntimeMs: 5 * MIN, out: (l) => said.push(l) });
    const log = lines(h);
    expect(log.find((l) => l.event === "request.outcome" && l.requestId === "req-1")).toMatchObject({ outcome: "filled", kind: "buy" });
    expect(log.filter((l) => l.event === "feed.backoff")).toHaveLength(1);
    expect(log.filter((l) => l.event === "feed.stale")).toHaveLength(1);
    expect(log.filter((l) => l.event === "events.failed")).toEqual([]);
    // One notice for the outage, not one per read.
    expect(said.filter((s) => s.includes("market"))).toHaveLength(1);
    // Never hammered: no two asks within 3 s.
    const at = feed.snapshots().map((s) => s.at);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(3 * S);
  });

  it("L6 sells under the backstop while the feed is down: the mark is the chain's", async () => {
    const { home: h } = home({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ sellBnbWei: 4n * 10n ** 15n, now: c.now });
    const book = recordBuy(emptyBook(), { coin: FEAST, symbol: "FEAST", quote: FEAST, coinsOut: 10_000n * 10n ** 18n, bnbInWei: 10n ** 16n, gasWei: 0n, at: T0 - 60 * MIN, fundedBy: "wallet", ownLaunch: false, source: "manual" });
    book.positions[FEAST.toLowerCase()]!.armed = true;
    writeFileAtomic(agentPaths(h, "demo").state, serializeBook(book));
    const feed = outage(c, 0);
    c.at(T0 + 90 * S, () => (w.marks.wei = 4n * 10n ** 15n));
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(4), loopMs: S, maxRuntimeMs: 4 * MIN, out: () => {} });
    const sold = lines(h).find((l) => l.event === "sell.filled");
    expect(sold).toMatchObject({ coin: FEAST });
    expect(Date.parse(sold!.at) - T0).toBeLessThanOrEqual(2 * MIN);
  });

  it("the strategy sees stale while the feed backs off, and null once it is back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feast-league-967-"));
    dirs.push(dir);
    const h = join(dir, "home");
    const file = join(dir, "watch.mjs");
    writeFileSync(
      file,
      `export const meta = { name: "watch", tickSeconds: 15, events: ["trade"] };
export function onTick(api) {
  api.log(JSON.stringify({ stale: api.read.stale(), coins: api.read.coins().length }));
}
export function onEvent() {}
`,
    );
    auditFile(h, file);
    recordModelVerdict(h, file, "pass", "read against the checklist: it only logs");
    const planned = planAgent({ name: "demo", scriptPath: file });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(h, confirmAgent(planned.agent, new Date(T0)));
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const feed = new FakeFeed(c.now, (at) => (at >= T0 + 40 * S && at < T0 + 120 * S ? { status: 503, body: {} } : { status: 200, body: snapshotBody(), etag: '"g"' }));
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(5), loopMs: S, maxRuntimeMs: 4 * MIN, out: () => {} });
    const seen = lines(h)
      .filter((l) => l.event === "strategy.log")
      .map((l) => ({ at: Date.parse(l.at) - T0, ...(JSON.parse(String(l.text)) as { stale: { sinceMs: number; reason: string } | null; coins: number }) }));
    expect(seen.length).toBeGreaterThan(8);
    expect(seen[0]).toMatchObject({ stale: null, coins: 2 });
    const during = seen.filter((s) => s.at > 60 * S && s.at < 120 * S);
    expect(during.length).toBeGreaterThan(0);
    // The board rows stay in use, marked.
    for (const s of during) expect(s).toMatchObject({ coins: 2, stale: { reason: "HTTP 503" } });
    expect(during[0]!.stale!.sinceMs).toBeLessThan(T0 + 40 * S);
    expect(seen.at(-1)).toMatchObject({ stale: null });
  });
});

describe("the start jitter", () => {
  it("delays the first read of the site, never a queued manual buy; the loop's safety runs from the start", async () => {
    const { home: h } = home({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const feed = new FakeFeed(c.now);
    inbox(h, "1-buy.json", { type: "intent", requestId: "req-1", request: { kind: "buy", coin: FEAST, bnb: 0.002, reason: "manual buy" } });
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(6), loopMs: S, maxRuntimeMs: 3 * MIN, startJitterMs: 90 * S, out: () => {} });
    const log = lines(h);
    const filled = log.find((l) => l.event === "request.outcome" && l.requestId === "req-1");
    expect(filled).toMatchObject({ outcome: "filled" });
    expect(Date.parse(filled!.at) - T0).toBeLessThan(10 * S);
    expect(feed.asked[0]!.at - T0).toBeGreaterThanOrEqual(90 * S);
    expect(log.find((l) => l.event === "started")).toMatchObject({ startJitterMs: 90 * S });
  });

  it("a stop during the wait stops at once, having read nothing", async () => {
    const { home: h } = home({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const feed = new FakeFeed(c.now);
    c.at(T0 + 30 * S, () => writeFileSync(agentPaths(h, "demo").stop, "stop requested by the user\n"));
    const outcome = await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(7), loopMs: S, maxRuntimeMs: 5 * MIN, startJitterMs: 100 * S, out: () => {} });
    expect(outcome.exit).toBe("stopped");
    expect(c.clock.t - T0).toBeLessThanOrEqual(32 * S);
    expect(feed.asked).toEqual([]);
  });

  it("no jitter given (run without the dep, or --no-jitter): the first read is at once", async () => {
    for (const startJitterMs of [undefined, 0]) {
      const { home: h } = home({ preset: "sniper" });
      const c = fakeClock(T0);
      const w = tradeWorld({ now: c.now });
      const feed = new FakeFeed(c.now);
      await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(8), loopMs: S, maxRuntimeMs: 20 * S, startJitterMs, out: () => {} });
      expect(feed.asked[0]!.at).toBe(T0);
    }
  });
});
