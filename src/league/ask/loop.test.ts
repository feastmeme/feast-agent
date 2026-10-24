import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody } from "../feed/fakes.ts";
import { FEAST, fakeClock, marketWorld } from "../prompt/fakes.ts";
import { dayCount } from "../prompt/floor.ts";
import { lastHostAction, recordHostAction } from "../prompt/host.ts";
import { leagueWire } from "../register/fakes.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths, writeJsonAtomic } from "../store.ts";
import type { HostCall } from "./host.ts";
import { readAskState, readJournal } from "./journal.ts";

/**
 * Task 975, addendum 4: the ask loop in the real runtime, on fakes. The host's CLI is a function here (`askHost`) that
 * sees the pack and answers as the test says; the wallet, the chain and feast.meme are the loop's own fakes.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-29T06:00:00Z");
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const COINS = [coin(0xc0e1), coin(0xc0e2), coin(0xc0e3)];
const SYMBOLS = ["NOODFEED", "KOIFEED", "MOTHFEED"];
const OWN = coin(0xb0d1e);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup(every = 5) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-ask-"));
  dirs.push(dir);
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, "Trade the busiest coin small; keep the floor early.\n");
  const planned = planAgent({ name: "demo", promptPath, preset: "steady", ask: { every, with: "claude", model: null } });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  const home = join(dir, "home");
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(T0 - 2 * 86_400_000)), league: { waitForSeason: true } });
  writeJsonAtomic(join(agentPaths(home, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: OWN, launchTx: null });
  return { home };
}

function world(c: ReturnType<typeof fakeClock>) {
  const rows = COINS.map((k, i) => coinRow(k, { symbol: SYMBOLS[i], volume24hBnb: 9 - i, trades24h: 90 - i, launchedAt: "2026-10-20T00:00:00.000Z" }));
  const feed = new FakeFeed(c.now, () => ({ status: 200, body: snapshotBody({ coins: rows }), etag: '"d2"' }));
  feed.other = (url) => (url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } }) } : null);
  const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: i === 0 ? "MAPLEFEED" : SYMBOLS[i - 1]! })), now: c.now });
  return { feed, w };
}

/** A coin's id in the pack, by its symbol (its row in the coins list). */
const idOf = (pack: string, symbol: string) => new RegExp(`^(c\\d+) \\| ${symbol} \\|`, "m").exec(pack)?.[1] ?? null;
const heldId = (pack: string) => /## Your positions[^\n]*\n- (c\d+) \|/.exec(pack)?.[1] ?? null;
const answer = (a: Record<string, unknown>): HostCall => ({ ok: true, answer: { action: "hold", coin: null, amountBnb: null, fraction: null, reason: "", memo: "", ...a } });

const lines = (h: string) =>
  existsSync(agentPaths(h, "demo").log)
    ? readFileSync(agentPaths(h, "demo").log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string })
    : [];

async function run(home: string, c: ReturnType<typeof fakeClock>, feed: FakeFeed, w: ReturnType<typeof marketWorld>, until: number, askHost: (o: { pack: string }) => Promise<HostCall>) {
  return runAgent({ home, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(1), noJitter: true, loopMs: 15_000, pollMs: 30_000, maxRuntimeMs: until - c.now(), out: () => {}, askHost: askHost as never });
}

describe("the ask loop", () => {
  it("asks once an interval of the host's silence has passed; a host trade resets the timer; the asks' own trades never do", async () => {
    const { home } = setup(5);
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    const asked: number[] = [];
    // The host trades at T0 + 12 min (an FL buy into the inbox).
    c.at(T0 + 12 * MIN, () => {
      mkdirSync(agentPaths(home, "demo").inbox, { recursive: true });
      writeJsonAtomic(join(agentPaths(home, "demo").inbox, "1-buy.json"), { type: "intent", requestId: "host-1", request: { kind: "buy", coin: COINS[2], bnb: 0.003, reason: "manual buy" } });
    });
    let n = 0;
    await run(home, c, feed, w, T0 + 30 * MIN, async ({ pack }) => {
      asked.push(c.now());
      n += 1;
      return n === 1 ? answer({ action: "buy", coin: idOf(pack, "NOODFEED"), amountBnb: 0.006, reason: "the busiest", memo: "bought NOODFEED" }) : answer({ reason: "nothing to do" });
    });
    const at = asked.map((t) => Math.round((t - T0) / MIN));
    // T0+5 and T0+10; the host's trade at 12 moves the next to 17, then 22 and 27.
    expect(at).toEqual([5, 10, 17, 22, 27]);
    // The ask's buy filled through the runtime, and it did not count as the host's action.
    expect(lines(home).filter((l) => l.event === "buy.filled").length).toBe(2);
    expect(Math.round((lastHostAction(home, "demo")!.at - T0) / MIN)).toBe(12);
    const journal = readJournal(home, "demo");
    expect(journal.map((j) => [j.action, j.result])).toEqual([["buy", "filled"], ["hold", "hold"], ["hold", "hold"], ["hold", "hold"], ["hold", "hold"]]);
    expect(journal[0]).toMatchObject({ symbol: "NOODFEED", amountBnb: 0.006, reason: "the busiest", pack: expect.stringMatching(/^sha256:[0-9a-f]{16}$/) });
  }, 60_000);

  it("the memo comes back in the next pack; the journal row and the position are in it; a refused buy is journaled as rejected", async () => {
    const { home } = setup(5);
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    w.notFeast.add(COINS[1]!.toLowerCase());
    recordHostAction(home, "demo", "buy", T0);
    const packs: string[] = [];
    await run(home, c, feed, w, T0 + 16 * MIN, async ({ pack }) => {
      packs.push(pack);
      if (packs.length === 1) return answer({ action: "buy", coin: idOf(pack, "NOODFEED"), amountBnb: 0.006, reason: "first", memo: "MEMO-ONE: watch KOIFEED" });
      if (packs.length === 2) return answer({ action: "buy", coin: idOf(pack, "KOIFEED"), amountBnb: 0.006, reason: "second", memo: "MEMO-TWO" });
      return answer({ action: "sell", coin: heldId(pack), fraction: 1, reason: "out", memo: "MEMO-THREE" });
    });
    expect(packs[1]).toContain("## Your memo from last time\nMEMO-ONE: watch KOIFEED");
    expect(packs[1]).toMatch(/- \S+ buy NOODFEED 0\.006 BNB: first → filled/);
    expect(heldId(packs[1]!)).toBe("c1");
    const journal = readJournal(home, "demo");
    expect(journal[1]!.result).toMatch(/^rejected: L15/);
    expect(journal[2]).toMatchObject({ action: "sell", result: "filled" });
    expect(readAskState(home, "demo").memo).toBe("MEMO-THREE");
  }, 60_000);

  it("two failed asks put the floor keeper on, said once with the cause; an answer again takes it off, said once", async () => {
    const { home } = setup(5);
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    let n = 0;
    await run(home, c, feed, w, T0 + 50 * MIN, async () => {
      n += 1;
      if (n <= 4) return { ok: false, cause: n % 2 ? "Claude Code exited 1: You have hit your usage limit." : "Claude Code's answer was not JSON" };
      return answer({ reason: "back" });
    });
    const log = lines(home);
    const notices = readFileSync(agentPaths(home, "demo").notifications, "utf8");
    expect(notices.match(/could not be reached: Claude Code exited 1: You have hit your usage limit\.; trading on the floor keeper until it answers/g)).toHaveLength(1);
    expect(notices.match(/answers again: the floor keeper steps back/g)).toHaveLength(1);
    const on = log.find((l) => l.event === "autopilot.on");
    expect(on).toMatchObject({ why: "asks failing" });
    // The floor keeper traded while the asks failed (T0+10 to T0+25).
    const keeperBuys = log.filter((l) => l.event === "intent.queued" && l.source === "preset" && l.kind === "buy");
    expect(keeperBuys.length).toBeGreaterThan(0);
    expect(log.some((l) => l.event === "autopilot.off")).toBe(true);
    expect(readAskState(home, "demo")).toMatchObject({ streak: 0, floorKeeperSince: null });
    expect(readJournal(home, "demo").filter((j) => j.result.startsWith("error:")).length).toBe(4);
  }, 60_000);

  it("the dinner guard: with an AI that only holds, the floor keeper fills the floor from dinner − 20, 2 minutes apart, flat by dinner − 5", async () => {
    const { home } = setup(5);
    const c = fakeClock(DINNER - 70 * MIN);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", DINNER - 75 * MIN);
    await run(home, c, feed, w, DINNER, async () => answer({ reason: "waiting" }));
    const log = lines(home);
    const on = log.find((l) => l.event === "autopilot.on")!;
    expect(on).toMatchObject({ why: "floor guard" });
    expect(Date.parse(on.at)).toBeGreaterThanOrEqual(DINNER - 20 * MIN);
    const buys = log.filter((l) => l.event === "buy.filled").map((l) => Date.parse(l.at));
    expect(buys.length).toBeGreaterThanOrEqual(2);
    expect(buys.every((t) => t >= DINNER - 20 * MIN && t < DINNER - 10 * MIN)).toBe(true);
    expect(buys[1]! - buys[0]!).toBeGreaterThanOrEqual(2 * MIN);
    expect(dayCount(home, "demo", DINNER - 5 * MIN, [OWN.toLowerCase(), FEAST.toLowerCase()]).passed).toBe(true);
    const lastFill = Math.max(...log.filter((l) => l.event.endsWith(".filled")).map((l) => Date.parse(l.at)));
    expect(lastFill).toBeLessThanOrEqual(DINNER - 5 * MIN);
  }, 60_000);

  it("the dinner guard stays off when the AI met the floor first (from dinner − 60 the pack says it is unmet)", async () => {
    const { home } = setup(5);
    const c = fakeClock(DINNER - 70 * MIN);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", DINNER - 75 * MIN);
    const said: string[] = [];
    await run(home, c, feed, w, DINNER, async ({ pack }) => {
      if (pack.includes("FLOOR UNMET")) said.push("unmet");
      const held = heldId(pack);
      if (held) return answer({ action: "sell", coin: held, fraction: 1, reason: "round trip" });
      const sym = SYMBOLS[said.length % SYMBOLS.length]!;
      return pack.includes("NOT met yet") ? answer({ action: "buy", coin: idOf(pack, sym), amountBnb: 0.006, reason: "the floor" }) : answer({ reason: "met" });
    });
    expect(said.length).toBeGreaterThan(0);
    expect(lines(home).some((l) => l.event === "autopilot.on")).toBe(false);
    expect(dayCount(home, "demo", DINNER - 1, [OWN.toLowerCase(), FEAST.toLowerCase()]).passed).toBe(true);
  }, 60_000);
});

describe("task 975, addendum 6: the snapshot by need", () => {
  async function reads(holding: boolean) {
    const { home } = setup(5);
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    if (holding) {
      // The host's own buy at the start: a position, so its stops are watched closely.
      mkdirSync(agentPaths(home, "demo").inbox, { recursive: true });
      writeJsonAtomic(join(agentPaths(home, "demo").inbox, "1-buy.json"), { type: "intent", requestId: "h", request: { kind: "buy", coin: COINS[0], bnb: 0.003, reason: "manual buy" } });
    }
    await runAgent({ home, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(3), noJitter: true, loopMs: 1_000, pollMs: 5_000, maxRuntimeMs: 10 * MIN, out: () => {}, askHost: (async () => answer({ reason: "hold" })) as never });
    const cadence = JSON.parse(readFileSync(join(agentPaths(home, "demo").dir, "cadence.json"), "utf8")) as { mode: string; why: string };
    return { count: feed.snapshots().length, cadence };
  }

  it("flat: every 30–60 s (and once before each ask); holding: every 5–8 s", async () => {
    const flat = await reads(false);
    const held = await reads(true);
    // 10 minutes at 30–60 s, plus a read before each of the two asks: at most about 22.
    expect(flat.count).toBeLessThanOrEqual(25);
    expect(flat.count).toBeGreaterThanOrEqual(10);
    expect(flat.cadence).toMatchObject({ mode: "slow" });
    expect(held.count).toBeGreaterThan(60);
    expect(held.cadence).toMatchObject({ mode: "fast", why: "positions have stops" });
  }, 60_000);
});
