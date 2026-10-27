import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody } from "../feed/fakes.ts";
import { leagueWire } from "../register/fakes.ts";
import { noteCommand } from "../notes/queue.ts";
import { parseLeague } from "../register/site.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths, writeJsonAtomic } from "../store.ts";
import { DEFAULT_IDLE_MINUTES } from "./constants.ts";
import { FEAST, fakeClock, marketWorld } from "./fakes.ts";
import { dayCount } from "./floor.ts";
import { recordHostAction } from "./host.ts";

/**
 * Task 975: the autopilot backup in the real loop. A prompt agent planned as FL enter plans it (steady, after 30
 * minutes with no trade from the host), on fakes: a made-up wallet, a chain of several coins whose sales pay their
 * mark, feast.meme's snapshot in process, and a clock the loop's sleep moves.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Thursday 10/29, 14:00 UTC+8: the season's day 2. */
const T0 = Date.parse("2026-10-29T06:00:00Z");
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const COINS = [coin(0xc0e1), coin(0xc0e2), coin(0xc0e3), coin(0xc0e4)];
const OWN = coin(0xb0d1e);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup(o: { confirmedAt?: number; waitForSeason?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-loop-"));
  dirs.push(dir);
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, "Keep the floor early, small sizes in BNB.\n");
  // As FL enter plans it: the default autopilot, its default idle.
  const planned = planAgent({ name: "demo", promptPath, preset: "steady" });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  expect(planned.agent.autopilot).toEqual({ idleMinutes: DEFAULT_IDLE_MINUTES });
  const home = join(dir, "home");
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(o.confirmedAt ?? T0 - 3 * 24 * HOUR)), league: o.waitForSeason === false ? null : { waitForSeason: true } });
  // The wallet's own coin, from FL enter: never bought by steady, never in the day's count.
  writeJsonAtomic(join(agentPaths(home, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: OWN, launchTx: null });
  return { home };
}

function market(c: ReturnType<typeof fakeClock>, league: () => unknown = () => leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } })) {
  const rows = [coinRow(OWN, { volume24hBnb: 50, launchedAt: "2026-10-20T00:00:00.000Z" }), ...COINS.map((k, i) => coinRow(k, { volume24hBnb: 9 - i, trades24h: 90 - i, launchedAt: "2026-10-20T00:00:00.000Z" }))];
  const feed = new FakeFeed(c.now, () => ({ status: 200, body: snapshotBody({ coins: rows }), etag: '"day2"' }));
  feed.other = (url) => (url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: league() } : null);
  return feed;
}

const lines = (h: string) =>
  existsSync(agentPaths(h, "demo").log)
    ? readFileSync(agentPaths(h, "demo").log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string })
    : [];
const fills = (h: string) => lines(h).filter((l) => l.event === "buy.filled" || l.event === "sell.filled");

async function run(home: string, c: ReturnType<typeof fakeClock>, feed: FakeFeed, w: ReturnType<typeof marketWorld>, untilMs: number) {
  return runAgent({ home, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(1), noJitter: true, loopMs: 15_000, pollMs: 30_000, maxRuntimeMs: untilMs - c.now(), out: () => {} });
}

describe("the backup takes over after 30 minutes with no trade from the host", () => {
  it("nothing before T0 + 30 min; autopilot.on once; in the next 60 minutes at least 3 fills and 0.02 BNB counted, the day passed", async () => {
    const { home } = setup();
    const c = fakeClock(T0 - 10 * MIN);
    const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    // The host's last trade at 14:00, then a note at 14:20, which does not hold the backup back (ruling C6).
    recordHostAction(home, "demo", "buy", T0);
    const feed = market(c);
    c.at(T0 + 20 * MIN, () => void noteCommand({ home, name: "demo", site: SITE, fetch: feed.fetch, wallet: async () => null, now: c.now }, { text: "watching the board" }));
    await run(home, c, feed, w, T0 + 2 * HOUR);
    expect(lines(home).some((l) => l.event === "autopilot.off")).toBe(false);
    const log = lines(home);
    const on = log.filter((l) => l.event === "autopilot.on");
    expect(on).toHaveLength(1);
    const onAt = Date.parse(on[0]!.at);
    expect(onAt).toBeGreaterThanOrEqual(T0 + 30 * MIN);
    expect(onAt).toBeLessThan(T0 + 31 * MIN);
    for (const q of log.filter((l) => l.event === "intent.queued" && l.source === "preset")) expect(Date.parse(q.at)).toBeGreaterThanOrEqual(onAt);
    const hour = fills(home).filter((f) => Date.parse(f.at) >= onAt && Date.parse(f.at) <= onAt + HOUR);
    expect(hour.length).toBeGreaterThanOrEqual(3);
    const count = dayCount(home, "demo", onAt + HOUR, [OWN.toLowerCase(), FEAST.toLowerCase()]);
    expect(count.trades).toBeGreaterThanOrEqual(3);
    expect(count.volumeBnb).toBeGreaterThanOrEqual(0.02);
    expect(count.passed).toBe(true);
    // Never the own coin; nothing bought once the projected day met the floor.
    expect(fills(home).some((f) => String(f.coin).toLowerCase() === OWN.toLowerCase())).toBe(false);
    expect(fills(home).filter((f) => f.event === "buy.filled")).toHaveLength(2);
  }, 60_000);

  it("the host trades 20 minutes after the takeover: autopilot.off, no buy for 30 minutes, and steady's own exits stay armed (ruling C7)", async () => {
    const { home } = setup();
    const c = fakeClock(T0);
    const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    recordHostAction(home, "demo", "buy", T0);
    const host = T0 + 50 * MIN;
    const HOSTS = coin(0xc0e9);
    c.at(host, () => {
      mkdirSync(agentPaths(home, "demo").inbox, { recursive: true });
      writeJsonAtomic(join(agentPaths(home, "demo").inbox, "1-buy.json"), { type: "intent", requestId: "req-1", request: { kind: "buy", coin: HOSTS, bnb: 0.003, reason: "manual buy" } });
    });
    await run(home, c, market(c), w, T0 + 2 * HOUR);
    const log = lines(home);
    const off = log.filter((l) => l.event === "autopilot.off");
    expect(off).toHaveLength(1);
    const offAt = Date.parse(off[0]!.at);
    expect(offAt - host).toBeLessThan(2 * MIN);
    const presetBuys = log.filter((l) => l.event === "intent.queued" && l.source === "preset" && l.kind === "buy").map((l) => Date.parse(l.at));
    expect(presetBuys.filter((at) => at > offAt && at < host + 30 * MIN)).toEqual([]);
    // Run 26 (item 12): a floor round's sale comes at its next tick, so every buy it made before it stood by is sold
    // on its own (its exits stay armed), none left open by the host's trade.
    const keeperBuys = fills(home).filter((f) => f.event === "buy.filled" && Date.parse(f.at) < offAt && String(f.coin).toLowerCase() !== HOSTS.toLowerCase());
    expect(keeperBuys.length).toBeGreaterThanOrEqual(1);
    for (const b of keeperBuys) expect(fills(home).some((f) => f.event === "sell.filled" && String(f.coin).toLowerCase() === String(b.coin).toLowerCase() && Date.parse(f.at) > Date.parse(b.at))).toBe(true);
    // The host's own coin is never steady's to sell.
    expect(fills(home).filter((f) => f.event === "sell.filled" && String(f.coin).toLowerCase() === HOSTS.toLowerCase())).toEqual([]);
    expect(log.filter((l) => l.event === "autopilot.on").length).toBe(2);
  }, 60_000);

  it("the next day starts at 21:00 UTC+8, and it keeps that day's floor too", async () => {
    const { home } = setup();
    const c = fakeClock(DINNER - 2 * HOUR);
    const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    recordHostAction(home, "demo", "buy", DINNER - 3 * HOUR);
    await run(home, c, market(c), w, DINNER + 2 * HOUR);
    const own = [OWN.toLowerCase(), FEAST.toLowerCase()];
    expect(dayCount(home, "demo", DINNER - 1, own).passed).toBe(true);
    // Everything it opened was sold before the dinner: the sales count on the day they belong to.
    const before = fills(home).filter((f) => Date.parse(f.at) < DINNER);
    expect(before.filter((f) => f.event === "buy.filled").length).toBe(before.filter((f) => f.event === "sell.filled").length);
    expect(fills(home).filter((f) => Date.parse(f.at) >= DINNER - 15 * MIN && Date.parse(f.at) < DINNER && f.event === "buy.filled")).toEqual([]);
    const next = dayCount(home, "demo", DINNER + 2 * HOUR, own);
    expect(next.startsAt).toBe(DINNER);
    expect(next.passed).toBe(true);
  }, 60_000);

  it("before the season gate opens: nothing, though the host has been quiet for days", async () => {
    const { home } = setup();
    const c = fakeClock(T0);
    const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    const start = T0 + 6 * HOUR;
    const feed = market(c, () => leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(start).toISOString() } }));
    expect(parseLeague(leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(start).toISOString() } }))).not.toBeNull();
    await run(home, c, feed, w, T0 + HOUR);
    const log = lines(home);
    expect(log.filter((l) => l.event === "autopilot.on")).toEqual([]);
    expect(log.filter((l) => l.event === "intent.queued")).toEqual([]);
    expect(w.calls).not.toContain("execute");
  }, 60_000);
});

describe("task 975, addendum 3: the machine slept", () => {
  it("a jump of more than 10 minutes across one of the loop's rests is logged once and notified, with when and how long", async () => {
    const { home } = setup();
    const c = fakeClock(T0);
    const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    recordHostAction(home, "demo", "buy", T0);
    // The lid closes at T0 + 5 min for 45 minutes: the loop's next rest ends 45 minutes late.
    c.at(T0 + 5 * MIN, () => (c.clock.t += 45 * MIN));
    await run(home, c, market(c), w, T0 + 70 * MIN);
    const slept = lines(home).filter((l) => l.event === "slept");
    expect(slept).toHaveLength(1);
    expect(slept[0]).toMatchObject({ minutes: 45, from: new Date(T0 + 5 * MIN).toISOString() });
    const { lastSleep } = await import("./host.ts");
    expect(lastSleep(home, "demo")).toEqual({ at: T0 + 5 * MIN, minutes: 45 });
    const notes = readFileSync(agentPaths(home, "demo").notifications, "utf8");
    expect(notes).toContain("slept 45 minutes at 2026-10-29 14:05 UTC+8: nothing traded while it slept. Keep this machine awake");
  }, 60_000);

  it("an ordinary run logs no sleep", async () => {
    const { home } = setup();
    const c = fakeClock(T0);
    const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    recordHostAction(home, "demo", "buy", T0);
    await run(home, c, market(c), w, T0 + 70 * MIN);
    expect(lines(home).filter((l) => l.event === "slept")).toEqual([]);
  }, 60_000);
});

describe("run 24 (item 17, amendment E): the floor keeper's trades in the pit", () => {
  const PIT = coin(0x9171);
  // The fake chain pairs every coin with WBNB; the page's pit says the same quote, so the check on chain agrees.
  const pitWire = { coin: PIT, symbol: "PITC", name: "The pit", quote: getAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"), poolId: `0x${"ab".repeat(32)}` };
  const league = () => leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() }, pit: pitWire });

  it("with a pit named, the keeper's floor buy and its sale are in the pit, round after round, though the pit has no row on the board", async () => {
    const { home } = setup();
    const c = fakeClock(T0 - 10 * MIN);
    const w = marketWorld({ coins: [OWN, ...COINS, PIT].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    recordHostAction(home, "demo", "buy", T0);
    await run(home, c, market(c, league), w, T0 + 2 * HOUR);
    const trades = fills(home).map((f) => [f.event, String(f.coin).toLowerCase()]);
    expect(trades.length).toBeGreaterThanOrEqual(4);
    expect(trades.every(([, k]) => k === PIT.toLowerCase())).toBe(true);
    // Each round: a buy, then its sale.
    expect(trades.slice(0, 4).map(([e]) => e)).toEqual(["buy.filled", "sell.filled", "buy.filled", "sell.filled"]);
    expect(lines(home).find((l) => l.event === "keeper.pit")).toMatchObject({ pit: "PITC 0x0000…9171", state: "in the pit", why: "ok" });
    const onAt = Date.parse(lines(home).find((l) => l.event === "autopilot.on")!.at);
    expect(dayCount(home, "demo", onAt + HOUR, [OWN.toLowerCase(), FEAST.toLowerCase()]).passed).toBe(true);
  }, 60_000);

  it("the pit refuses (its pool's opening cap): the keeper falls back to its usual coin, said once; the floor is still kept", async () => {
    const { home } = setup();
    const c = fakeClock(T0 - 10 * MIN);
    const w = marketWorld({ coins: [OWN, ...COINS, PIT].map((k, i) => ({ coin: k, symbol: `S${i}` })), now: c.now });
    const chain = w.chain as unknown as { poolKey: (c: Address) => Promise<unknown>; client: { simulateContract: (a: unknown) => Promise<unknown> } };
    let keyed: string | null = null;
    const poolKey = chain.poolKey;
    chain.poolKey = async (k: Address) => ((keyed = k.toLowerCase()), poolKey(k));
    const simulate = chain.client.simulateContract;
    chain.client.simulateContract = async (a: unknown) => {
      if (keyed === PIT.toLowerCase()) throw new Error("PurchaseCapExceeded(): the pool is in its opening window");
      return simulate(a);
    };
    recordHostAction(home, "demo", "buy", T0);
    await run(home, c, market(c, league), w, T0 + 2 * HOUR);
    expect(fills(home).some((f) => String(f.coin).toLowerCase() === PIT.toLowerCase())).toBe(false);
    // Run 26 (item 12): its usual coin is one of the board's most-held WBNB pairs, drawn at random.
    expect(COINS.map((k) => k.toLowerCase())).toContain(fills(home).filter((f) => f.event === "buy.filled").map((f) => String(f.coin).toLowerCase())[0]);
    const said = lines(home).filter((l) => l.event === "keeper.pit");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ state: "elsewhere", why: "the pool's opening cap refuses a 0.006 BNB buy" });
    const onAt = Date.parse(lines(home).find((l) => l.event === "autopilot.on")!.at);
    expect(dayCount(home, "demo", onAt + HOUR, [OWN.toLowerCase(), FEAST.toLowerCase()]).passed).toBe(true);
  }, 60_000);
});
