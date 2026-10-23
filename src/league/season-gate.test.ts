import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent, type PlanInput } from "./agent.ts";
import { FakeFeed, INDEXER, seeded, SITE } from "./feed/fakes.ts";
import { FEAST, fakeClock, tradeWorld } from "./prompt/fakes.ts";
import { leagueWire } from "./register/fakes.ts";
import { parseLeague, type LeagueRead } from "./register/site.ts";
import { runAgent } from "./runtime.ts";
import { OPENS_AFTER_START_MS, readGate, tradingOpens } from "./season-gate.ts";
import { agentPaths, writeJsonAtomic } from "./store.ts";

/**
 * The season gate (task 968; ruling C8): an agent `FL enter` started trades nothing until one hour before dinner 1,
 * then runs as `FL start` would. The loop's own fakes: a made-up wallet, a chain that fills a trade end to end, a
 * clock the loop's sleep moves, feast.meme's snapshot and its league page served in process.
 */

const T0 = Date.parse("2026-10-26T10:00:00Z");
const S = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const read = (state: LeagueRead["state"], countdownTo: number | null, day: number | null = null): LeagueRead => parseLeague(leagueWire({ state, season: { number: 1, day, countdownTo: countdownTo === null ? null : new Date(countdownTo).toISOString() } }))!;

describe("when trading opens, from /api/league", () => {
  it("before the start: the start plus 23 hours (season 1: Monday 20:00 UTC+8)", () => {
    const start = Date.parse("2026-10-25T13:00:00Z");
    expect(tradingOpens(read("warm-up", start))).toEqual({ kind: "at", at: Date.parse("2026-10-26T12:00:00Z") });
    expect(tradingOpens(read("coming-soon", start))).toEqual({ kind: "at", at: start + OPENS_AFTER_START_MS });
  });
  it("on day 1, an hour before dinner 1; from day 2, and when it is over: open", () => {
    const dinner1 = Date.parse("2026-10-26T13:00:00Z");
    expect(tradingOpens(read("season", dinner1, 1))).toEqual({ kind: "at", at: Date.parse("2026-10-26T12:00:00Z") });
    expect(tradingOpens(read("season", dinner1 + 86_400_000, 2))).toEqual({ kind: "open" });
    expect(tradingOpens(read("over", null))).toEqual({ kind: "open" });
  });
  it("no start announced, or no page: unknown, so it waits until told", () => {
    expect(tradingOpens(read("coming-soon", null))).toEqual({ kind: "unknown" });
    expect(tradingOpens(read("unavailable", null))).toEqual({ kind: "unknown" });
    expect(tradingOpens(null)).toEqual({ kind: "unknown" });
  });
});

function agent(plan: Omit<PlanInput, "name">, wait = true) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-968-gate-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const planned = planAgent({ name: "maplegrin", ...plan });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(T0 - HOUR)), league: wait ? { waitForSeason: true } : null });
  return { home, dir };
}

const lines = (home: string) =>
  existsSync(agentPaths(home, "maplegrin").log)
    ? readFileSync(agentPaths(home, "maplegrin").log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string })
    : [];

const inbox = (home: string, file: string, body: unknown) => {
  mkdirSync(agentPaths(home, "maplegrin").inbox, { recursive: true });
  writeJsonAtomic(join(agentPaths(home, "maplegrin").inbox, file), body);
};

/** feast.meme: the snapshot, and the league page as `league(at)` says (a raw answer, or the page's body). */
function site(c: { now: () => number }, league: (at: number) => Record<string, unknown> | "down") {
  const feed = new FakeFeed(c.now);
  feed.other = (url) => {
    if (url.origin !== SITE || url.pathname !== "/api/league") return null;
    const body = league(c.now());
    return body === "down" ? { status: 503, body: { error: { code: "unavailable" } } } : { status: 200, body };
  };
  const leagueReads = () => feed.asked.filter((a) => a.url.startsWith(`${SITE}/api/league?`)).map((a) => a.at);
  const marketReads = () => feed.asked.filter((a) => !a.url.startsWith(`${SITE}/api/league?`));
  return { feed, leagueReads, marketReads };
}

describe("the waiting agent trades nothing", () => {
  it("a prompt agent with an autopilot, over a simulated hour before the start: no market read, no strategy, no autopilot, no wallet call; a queued FL buy is refused with the season line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feast-league-968-prompt-"));
    dirs.push(dir);
    writeFileSync(join(dir, "strategy.md"), "Trade new Feast coins for me.\n");
    const { home } = agent({ promptPath: join(dir, "strategy.md"), preset: "sniper", idleMinutes: 1 });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    // The start is tomorrow's dinner 0, so trading opens 23 hours after it: far past this hour.
    const start = T0 + 4 * HOUR;
    const s = site(c, () => leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(start).toISOString() } }));
    c.at(T0 + 20 * MIN, () => inbox(home, "1-buy.json", { type: "intent", requestId: "req-1", request: { kind: "buy", coin: FEAST, bnb: 0.002, reason: "manual buy" } }));
    await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(1), loopMs: S, maxRuntimeMs: HOUR, out: () => {} });
    expect(s.marketReads()).toEqual([]);
    const log = lines(home);
    expect(log.filter((l) => l.event.startsWith("autopilot.") || l.event.startsWith("strategy.") || l.event === "season.open")).toEqual([]);
    expect(w.calls.filter((call) => call === "preview" || call === "execute")).toEqual([]);
    const refused = log.find((l) => l.event === "request.outcome" && l.requestId === "req-1");
    expect(refused).toMatchObject({ outcome: "refused", kind: "buy", message: "the season has not started; it opens at 2026-10-27 21:00 (UTC+8)" });
    expect(Date.parse(refused!.at) - T0).toBeLessThan(21 * MIN);
    // It read the league every 5 minutes, no more.
    expect(s.leagueReads().length).toBeGreaterThanOrEqual(12);
    expect(s.leagueReads().length).toBeLessThanOrEqual(13);
    expect(readGate(home, "maplegrin")).toMatchObject({ state: "waiting", opensAt: new Date(start + OPENS_AFTER_START_MS).toISOString() });
  });

  it("FL buy into a stopped waiting agent (the one-shot) is refused before the wallet is asked to trade", async () => {
    const { home } = agent({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const s = site(c, () => leagueWire({ state: "coming-soon" }));
    const out = await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(2), only: [{ kind: "buy", coin: FEAST, bnb: 0.002, reason: "manual buy" }], out: () => {} });
    expect(out).toEqual({ exit: "refused", reason: "the season has not started; it opens when feast.meme announces the start" });
    expect(w.calls.filter((call) => call === "preview" || call === "execute")).toEqual([]);
  });
});

describe("it opens at the instant, then runs as FL start would", () => {
  it("at the opening (and not before): season.open once, the jitter drawn, then the first market read", async () => {
    const { home } = agent({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const opens = T0 + 3 * MIN;
    const s = site(c, () => leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(opens - OPENS_AFTER_START_MS).toISOString() } }));
    const said: string[] = [];
    await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(3), loopMs: S, maxRuntimeMs: 8 * MIN, out: (l) => said.push(l) });
    const log = lines(home);
    const open = log.filter((l) => l.event === "season.open");
    expect(open).toHaveLength(1);
    const openedAt = Date.parse(open[0]!.at);
    expect(openedAt).toBeGreaterThanOrEqual(opens);
    expect(openedAt - opens).toBeLessThanOrEqual(S);
    const jitter = open[0]!.jitterMs as number;
    expect(jitter).toBeGreaterThan(0);
    expect(jitter).toBeLessThanOrEqual(120 * S);
    const first = s.marketReads()[0]!;
    expect(first.at).toBeGreaterThanOrEqual(openedAt + jitter);
    expect(first.at - (openedAt + jitter)).toBeLessThanOrEqual(2 * S);
    // A read exactly at the instant, as well as every 5 minutes before it.
    expect(s.leagueReads()).toContain(opens);
    expect(said.filter((l) => l.includes("the season is open"))).toHaveLength(1);
    expect(readGate(home, "maplegrin")).toMatchObject({ state: "open" });
  });

  it("--no-jitter: the first read is at the opening itself", async () => {
    const { home } = agent({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const opens = T0 + 2 * MIN;
    const s = site(c, () => leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(opens - OPENS_AFTER_START_MS).toISOString() } }));
    await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(4), loopMs: S, maxRuntimeMs: 4 * MIN, noJitter: true, out: () => {} });
    expect(lines(home).find((l) => l.event === "season.open")).toMatchObject({ jitterMs: 0 });
    expect(s.marketReads()[0]!.at - opens).toBeLessThanOrEqual(S);
  });

  it("a restart in season (day 2): it opens at once; a queued FL buy fills", async () => {
    const { home } = agent({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const s = site(c, () => leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(T0 + 3 * HOUR).toISOString() } }));
    inbox(home, "1-buy.json", { type: "intent", requestId: "req-2", request: { kind: "buy", coin: FEAST, bnb: 0.002, reason: "manual buy" } });
    await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(5), loopMs: S, maxRuntimeMs: 3 * MIN, noJitter: true, out: () => {} });
    const log = lines(home);
    expect(Date.parse(log.find((l) => l.event === "season.open")!.at)).toBe(T0);
    expect(log.find((l) => l.event === "request.outcome" && l.requestId === "req-2")).toMatchObject({ outcome: "filled" });
  });

  it("an agent planned with plain FL start has no gate: no league read, no season line", async () => {
    const { home } = agent({ preset: "sniper" }, false);
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const s = site(c, () => leagueWire({ state: "coming-soon" }));
    await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(6), loopMs: S, maxRuntimeMs: MIN, out: () => {} });
    expect(s.leagueReads()).toEqual([]);
    expect(s.marketReads().length).toBeGreaterThan(0);
  });
});

describe("no start announced, or no page", () => {
  it("an unknown start keeps it closed, and the league is read again every 5 minutes", async () => {
    const { home } = agent({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const s = site(c, () => leagueWire({ state: "coming-soon" }));
    await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(7), loopMs: S, maxRuntimeMs: 16 * MIN, out: () => {} });
    expect(s.leagueReads()).toEqual([T0, T0 + 5 * MIN, T0 + 10 * MIN, T0 + 15 * MIN]);
    expect(s.marketReads()).toEqual([]);
    expect(lines(home).some((l) => l.event === "season.open")).toBe(false);
    expect(readGate(home, "maplegrin")).toMatchObject({ state: "waiting", opensAt: null });
  });

  it("a page that cannot be read keeps it closed, and is asked again under the backoff (2 s doubling, at most 60 s)", async () => {
    const { home } = agent({ preset: "sniper" });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const s = site(c, () => "down");
    await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(8), loopMs: S, maxRuntimeMs: 6 * MIN, out: () => {} });
    const at = s.leagueReads();
    expect(s.marketReads()).toEqual([]);
    expect(at.length).toBeGreaterThan(5);
    for (let i = 1; i < at.length; i += 1) {
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(S);
      expect(at[i]! - at[i - 1]!).toBeLessThanOrEqual(61 * S);
    }
    // It gets slower, not faster.
    expect(at.at(-1)! - at.at(-2)!).toBeGreaterThan(at[1]! - at[0]!);
  });
});
