import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { MAINNET } from "../../sdk/networks.ts";
import { LeagueChain } from "../chain.ts";
import { DEFAULT_LIMITS } from "../limits.ts";
import type { DayCount } from "../prompt/floor.ts";
import { makeApi, type CoinRow, type PositionRow, type PresetExtras, type Snapshot } from "../strategy.ts";
import { FLOOR_TOP_HOLDERS, floorDraw, presetStrategy } from "./logic.ts";
import { PRESETS, resolveParams } from "./specs.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/**
 * `steady` (task 975), the floor keeper: small, spaced buys of the busiest Feast coins, each sold by a take-profit,
 * a stop-loss or a time stop, so the day's activity floor (3 trades and 0.02 BNB, own coin left out) is met early.
 */

const MIN = 60_000;
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const WBNB = MAINNET.contracts.wrappedNative;
const FEAST = MAINNET.platformCoin!.address;
const STOCK = MAINNET.stocks[0]!.address;
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const OWN = coin(0xb0d1e);
const DEFAULTS = (() => {
  const r = resolveParams("steady", {}, DEFAULT_LIMITS);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.params;
})();

function row(c: Address, over: Partial<CoinRow> = {}): CoinRow {
  return { coin: c, symbol: `C${c.slice(-2)}`, quote: WBNB, creator: coin(0xb0b0), launchedAt: 0, ageSeconds: 6 * 3_600, holders: 40, volume24hBnb: 3, trades24h: 50, priceBnb: 1e-6, hasMetadata: true, ...over };
}
function position(c: Address, over: Partial<PositionRow> = {}): PositionRow {
  return { coin: c, symbol: "X", coins: 5_940, costBnb: 0.006, markBnb: 0.00594, pnlPct: -1, peakBnb: 0.00594, openedAt: 0, ageSeconds: 60, ownLaunch: false, armed: true, ...over };
}
function day(over: Partial<DayCount> = {}): DayCount {
  const endsAt = over.endsAt ?? DINNER;
  const trades = over.trades ?? 0;
  const volumeBnb = over.volumeBnb ?? 0;
  return { startsAt: endsAt - 24 * 60 * MIN, endsAt, trades, volumeWei: BigInt(Math.round(volumeBnb * 1e18)), volumeBnb, passed: trades >= 3 && volumeBnb >= 0.02, ...over };
}

type World = { now: number; coins: CoinRow[]; positions: PositionRow[]; day: DayCount | null; standingBy: boolean; launched: Address | null; state: Record<string, unknown>; params: Record<string, unknown>; pit?: { coin: Address; symbol: string } | null };

function world(over: Partial<World> = {}): World {
  return { now: DINNER - 6 * 60 * MIN, coins: [row(coin(0xc1), { volume24hBnb: 9 }), row(coin(0xc2), { volume24hBnb: 5 }), row(coin(0xc3), { volume24hBnb: 2 })], positions: [], day: day(), standingBy: false, launched: OWN, state: {}, params: { ...DEFAULTS }, ...over };
}

/** One tick of steady on the world as it is; the world's state is kept. */
function tick(w: World) {
  const snapshot: Snapshot = { now: w.now, balanceBnb: 1, limits: DEFAULT_LIMITS, warmup: null, coins: w.coins, positions: w.positions, trades: [], holders: {}, launchesByCreator: {}, feast: FEAST, launched: w.launched ? { coin: w.launched, at: 0 } : null };
  const logs: string[] = [];
  const { api, intents } = makeApi(snapshot, { params: w.params, state: w.state, source: "preset", ttlMs: 60_000, log: (t) => logs.push(t) });
  const extras: PresetExtras = { claimAndBuyBack: () => null, day: () => w.day, standingBy: () => w.standingBy, pit: () => w.pit ?? null };
  presetStrategy("steady").onTick(api, extras);
  return { intents, logs, buys: intents.filter((i) => i.kind === "buy"), sells: intents.filter((i) => i.kind === "sell") };
}

/** Fill every buy as a position at its cost (flat, the 1 % fee inside), as the runtime would. */
function fill(w: World, out: ReturnType<typeof tick>) {
  for (const b of out.buys) w.positions.push(position(b.coin!, { costBnb: b.bnb!, markBnb: b.bnb! * 0.99, openedAt: w.now, ageSeconds: 0 }));
}

// --- the arithmetic (Design 2e) -----------------------------------------------------------------------

const FEE = 0.01;
const roundTrip = (buy: number, move: number) => buy + buy * (1 - FEE) * (1 + move) * (1 - FEE);

describe("steady: its parameters", () => {
  it("is the sixth preset, on the shared interface, tick 60 s, no events; it never launches", () => {
    expect(Object.keys(PRESETS)).toEqual(["sniper", "momentum", "copy", "launch", "dca", "steady"]);
    expect(PRESETS.steady).toMatchObject({ id: "steady", tickSeconds: 60, events: [] });
    expect(PRESETS.steady.does).toBe("keeps the league's daily activity floor with small buys of the busiest Feast coins (never your own coin), spaced out and done early in the day, each sold by a take-profit, a stop-loss or a time stop");
    expect(presetStrategy("steady").meta).toMatchObject({ name: "steady", tickSeconds: 60, events: [] });
  });

  it("its defaults resolve, as the table says", () => {
    expect(DEFAULTS).toEqual({ buyBnb: 0.006, topN: 5, minVolumeBnb: 0.5, minAgeMinutes: 60, minDailyTrades: 4, minDailyVolumeBnb: 0.022, maxEntriesPerDay: 3, spacingMinutes: 15, rushMinutes: 60, takeProfitPct: 15, stopLossPct: 10, timeStopMinutes: 30, maxPositions: 2, slippagePct: 5 });
  });

  it("L3, L5, L6 and L9 bound its keys", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const bad = (given: Record<string, unknown>) => {
      const r = resolveParams("steady", given, DEFAULT_LIMITS);
      return r.ok ? [] : r.errors;
    };
    expect(bad({ buyBnb: 0.021 }).join()).toBe("");
    expect(bad({ buyBnb: 0.151 }).join()).toMatch(/bounded by L3/);
    expect(bad({ maxPositions: 6 }).join()).toMatch(/bounded by L5/);
    expect(bad({ stopLossPct: 51 }).join()).toMatch(/bounded by L6/);
    expect(bad({ slippagePct: 21 }).join()).toMatch(/bounded by L9/);
    expect(bad({ minDailyTrades: 2 }).join()).toMatch(/minDailyTrades 2 is outside 3–20/);
    expect(bad({ minDailyVolumeBnb: 0.019 }).join()).toMatch(/minDailyVolumeBnb 0.019 is outside 0.02–0.15/);
  });

  it("the cross-checks: no L2 any more (its day's buys are not limited); its own targets reachable", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const errors = (given: Record<string, unknown>) => {
      const r = resolveParams("steady", given, DEFAULT_LIMITS);
      return r.ok ? [] : r.errors;
    };
    expect(errors({ maxEntriesPerDay: 12, buyBnb: 0.01 })).toEqual([]);
    expect(errors({ maxEntriesPerDay: 1, buyBnb: 0.006, minDailyTrades: 3 })).toContain("2 × maxEntriesPerDay × buyBnb (0.012 BNB) cannot reach minDailyVolumeBnb (0.022 BNB)");
    expect(errors({ maxEntriesPerDay: 1, buyBnb: 0.02 })).toContain("minDailyTrades 4 needs at least 2 buys a day (a buy and its sale are two trades); maxEntriesPerDay is 1");
  });

  it("the floor's arithmetic at the defaults: flat, both stopped out, one dump; the season's spend under the cap", () => {
    const b = PRESETS.steady.params.find((p) => p.key === "buyBnb")!.default as number;
    const target = DEFAULTS.minDailyVolumeBnb as number;
    const entries = DEFAULTS.maxEntriesPerDay as number;
    const stop = DEFAULTS.stopLossPct as number;
    expect(roundTrip(b, 0)).toBeCloseTo(0.0118806, 6);
    expect(2 * roundTrip(b, 0)).toBeGreaterThanOrEqual(target);
    expect(2 * roundTrip(b, -stop / 100)).toBeGreaterThanOrEqual(target);
    expect(2 * roundTrip(b, -stop / 100)).toBeGreaterThanOrEqual(0.02);
    expect(roundTrip(b, -0.5) + roundTrip(b, 0)).toBeLessThan(target);
    expect(roundTrip(b, -0.5) + 2 * roundTrip(b, 0)).toBeGreaterThanOrEqual(target);
    // Two buys a typical day, three at most.
    expect(2 * b).toBeCloseTo(0.012, 9);
    expect(entries * b).toBeCloseTo(0.018, 9);
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    // What it holds at once (its positions × its size) sits well inside the cap on BNB at work.
    expect((DEFAULTS.maxPositions as number) * b).toBeLessThanOrEqual(0.15);
  });
});

// Run 26 (item 12, the owner's 08:1x ruling): the floor round's coin is one of the 10 with the most holders, at random,
// never the same twice in a row, and a round is the buy and its sale at the next tick. The tests below were the
// busiest-by-volume pick and its 30-minute holds; they now pin the new rule.
describe("steady: the coin (run 26, item 12)", () => {
  const ten = Array.from({ length: 14 }, (_, i) => row(coin(0xbe00 + i), { holders: 100 - i, volume24hBnb: 1 + i }));

  it("one of the 10 with the most holders: never the own coin, FEAST, a coin held, a stock pair or one younger than minAgeMinutes", () => {
    const board = [
      row(OWN, { holders: 999 }),
      row(FEAST, { holders: 998, symbol: "FEAST" }),
      row(coin(0xa1), { holders: 997 }),
      row(coin(0xa2), { holders: 996, quote: STOCK }),
      row(coin(0xa3), { holders: 995, ageSeconds: 59 * 60 }),
      row(coin(0xa4), { holders: 994, volume24hBnb: 0 }),
      ...ten,
    ];
    const allowed = new Set(ten.slice(0, FLOOR_TOP_HOLDERS).map((r) => r.coin));
    for (let i = 0; i < 40; i += 1) {
      const w = world({ coins: board, positions: [position(coin(0xa1), { costBnb: 0.001, markBnb: 0.001 })], now: DINNER - 6 * 60 * MIN + i * 7 * MIN });
      // The host's position is not its own: it may still buy (its own round is what waits).
      const out = tick(w);
      expect(out.buys).toHaveLength(1);
      expect(allowed.has(out.buys[0]!.coin!)).toBe(true);
      expect(out.buys[0]).toMatchObject({ bnb: 0.006, source: "preset", slippagePct: 5 });
      expect(out.buys[0]!.reason).toMatch(/^steady: .*one of the 10 with the most/);
    }
    expect(FLOOR_TOP_HOLDERS).toBe(10);
  });

  it("at random, never the same coin twice in a row; the draws spread over the ten", () => {
    const w = world({ coins: ten });
    const picks: Address[] = [];
    for (let i = 0; i < 30; i += 1) {
      const out = tick(w);
      expect(out.buys).toHaveLength(1);
      picks.push(out.buys[0]!.coin!);
      // The round's sale is done; the next one 15 minutes later, a new day's count so the floor never closes.
      w.positions = [];
      w.now += 15 * MIN;
      w.day = day({ endsAt: DINNER + Math.floor(i / 2) * 24 * 60 * MIN, trades: 0, volumeBnb: 0 });
      if (w.now > w.day.endsAt - 20 * MIN) w.now = w.day.endsAt - 6 * 60 * MIN;
      w.state.buys = [];
    }
    for (let i = 1; i < picks.length; i += 1) expect(picks[i]).not.toBe(picks[i - 1]);
    expect(new Set(picks).size).toBeGreaterThanOrEqual(5);
    expect(floorDraw(1, 0, 10)).toBe(floorDraw(1, 0, 10));
  });

  it("one coin only: it may come again; none at all: no buy, said once", () => {
    const solo = world({ coins: [row(coin(0xd1))] });
    expect(tick(solo).buys.map((b) => b.coin)).toEqual([coin(0xd1)]);
    const none = world({ coins: [row(coin(0xd3), { volume24hBnb: 0 }), row(OWN, { volume24hBnb: 9 })] });
    const first = tick(none);
    expect(first.buys).toEqual([]);
    expect(first.logs.filter((l) => l.startsWith("steady: no coin it may buy"))).toHaveLength(1);
    none.now += 20 * MIN;
    const again = tick(none);
    expect(again.buys).toEqual([]);
    expect(again.logs).toEqual([]);
  });
});

describe("steady: the rhythm", () => {
  it("a round is the buy and its sale at the next tick; two rounds 15 minutes apart, then none while the day meets the floor", () => {
    const w = world();
    const first = tick(w);
    expect(first.buys).toHaveLength(1);
    fill(w, first);
    // The next tick: its sale, and no other buy while it is pending.
    w.now += MIN;
    const sale = tick(w);
    expect(sale.sells).toMatchObject([{ coin: first.buys[0]!.coin, fraction: 1, reason: "steady: time stop after 1 min" }]);
    expect(sale.buys).toEqual([]);
    w.positions = [];
    w.day = day({ trades: 2, volumeBnb: 0.0119 });
    w.now += 5 * MIN;
    expect(tick(w).buys).toEqual([]);
    w.now += 9 * MIN;
    const second = tick(w);
    expect(second.buys).toHaveLength(1);
    expect(second.buys[0]!.coin).not.toBe(first.buys[0]!.coin);
    // Two rounds: 4 trades, 0.006 × 2 + their sales ≈ 0.0238 BNB.
    w.day = day({ trades: 4, volumeBnb: 0.0238 });
    w.now += 15 * MIN;
    expect(tick(w).buys).toEqual([]);
  });

  it("no buy while the day already meets the floor its parameters ask for", () => {
    expect(tick(world({ day: day({ trades: 4, volumeBnb: 0.023 }) })).buys).toEqual([]);
    expect(tick(world({ day: day({ trades: 4, volumeBnb: 0.021 }) })).buys).toHaveLength(1);
    expect(tick(world({ day: day({ trades: 3, volumeBnb: 0.03 }) })).buys).toHaveLength(1);
  });

  it("one round at a time (its sale before the next buy), at most maxEntriesPerDay bought", () => {
    const w = world();
    fill(w, tick(w));
    w.now += 15 * MIN;
    // Its sale still pending (it was not filled): no second buy.
    w.positions[0]!.ageSeconds = 900;
    expect(tick(w).buys).toEqual([]);
    for (let i = 0; i < 2; i += 1) {
      w.positions = [];
      w.now += 15 * MIN;
      w.day = day({ trades: 2 * (i + 1), volumeBnb: 0.0100 * (i + 1) });
      expect(tick(w).buys).toHaveLength(1);
    }
    w.positions = [];
    w.now += 15 * MIN;
    w.day = day({ trades: 6, volumeBnb: 0.0209 });
    expect(tick(w).buys).toEqual([]);
  });

  it("the rush: in the last rushMinutes, with the floor not met, rounds 3 minutes apart; nothing in the last 15 minutes", () => {
    const w = world({ now: DINNER - 40 * MIN });
    const first = tick(w);
    expect(first.buys).toHaveLength(1);
    fill(w, first);
    w.now += MIN;
    expect(tick(w).sells).toHaveLength(1);
    w.positions = [];
    w.now += MIN;
    expect(tick(w).buys).toEqual([]);
    w.now += MIN;
    expect(tick(w).buys).toHaveLength(1);
    const late = world({ now: DINNER - 14 * MIN });
    expect(tick(late).buys).toEqual([]);
  });

  it("no buy without a day count (fail closed), said once", () => {
    const w = world({ day: null });
    const out = tick(w);
    expect(out.buys).toEqual([]);
    expect(out.logs).toEqual(["steady: the day's count is not known, so no buy (it fails closed)"]);
    w.now += MIN;
    expect(tick(w).logs).toEqual([]);
  });

  it("standing by (the host traded): no buy, its own exits only", () => {
    const w = world();
    fill(w, tick(w));
    w.standingBy = true;
    w.positions[0]!.pnlPct = -12;
    const out = tick(w);
    expect(out.buys).toEqual([]);
    expect(out.sells.map((s) => s.reason)).toEqual([expect.stringMatching(/^steady: stop-loss at -12\.0%/)]);
    w.positions = [];
    w.now += 15 * MIN;
    expect(tick(w).buys).toEqual([]);
  });
});

describe("steady: the exits", () => {
  const bought = () => {
    const w = world();
    fill(w, tick(w));
    return w;
  };

  it("the stop-loss, the take-profit, and the round's sale at the next tick", () => {
    const sl = bought();
    sl.positions[0]!.pnlPct = -10;
    expect(tick(sl).sells).toMatchObject([{ coin: sl.positions[0]!.coin, fraction: 1, reason: expect.stringMatching(/^steady: stop-loss/) }]);
    const tp = bought();
    tp.positions[0]!.pnlPct = 15;
    expect(tick(tp).sells).toMatchObject([{ coin: tp.positions[0]!.coin, fraction: 1, reason: expect.stringMatching(/^steady: take-profit/) }]);
    const ts = bought();
    ts.now += 59_000;
    expect(tick(ts).sells).toEqual([]);
    ts.now += 1_000;
    expect(tick(ts).sells).toMatchObject([{ coin: ts.positions[0]!.coin, reason: "steady: time stop after 1 min" }]);
  });

  it("every position it opened is sold by dinner − 5 min, so the sale counts the same day", () => {
    const w = world({ now: DINNER - 90 * MIN, params: { ...DEFAULTS, rushMinutes: 0 } });
    const out = tick(w);
    fill(w, out);
    // Its round's sale never went through (no fill): the dinner's sale is the last word.
    const k = out.buys[0]!.coin!.toLowerCase();
    (w.state.stops as Record<string, number>)[k] = DINNER + 60 * MIN;
    w.now = DINNER - 6 * MIN;
    expect(tick(w).sells).toEqual([]);
    w.now = DINNER - 5 * MIN;
    expect(tick(w).sells).toMatchObject([{ coin: out.buys[0]!.coin, reason: "steady: sold before the dinner, so the sale counts today" }]);
  });

  it("never a position it did not open: the host's, the own coin", () => {
    const w = world({ positions: [position(coin(0xe1), { pnlPct: -40, ageSeconds: 99_999 }), position(OWN, { pnlPct: -40, ownLaunch: true })], now: DINNER - 4 * MIN });
    expect(tick(w).sells).toEqual([]);
  });
});

describe("task 975, addendum 8: the warm-up dinner", () => {
  it("a day with no floor (noFloor): no buy, said once; a day with one: it buys", () => {
    const held = coin(0xc1);
    const w = world({ day: day({ noFloor: true, passed: true }), positions: [position(held, { markBnb: 0.0072, pnlPct: 20, peakBnb: 0.0072 })], state: { mine: { [held.toLowerCase()]: DINNER - 6 * 60 * MIN - 10 * MIN } } });
    const out = tick(w);
    expect(out.buys).toEqual([]);
    expect(out.logs).toContain("steady: tonight's dinner is the warm-up, which asks no floor: no buy");
    expect(tick(w).logs).not.toContain("steady: tonight's dinner is the warm-up, which asks no floor: no buy");
    // The same world on a day with a floor: it buys.
    expect(tick(world()).buys.length).toBe(1);
  });
});

describe("run 24 (item 17, amendment E): the floor keeper in the pit", () => {
  // The pit is paired with a stock token, not WBNB, and need not be on the board at all.
  const PIT = { coin: coin(0x9171), symbol: "PITC" };

  it("with the pit named and buyable, the floor buy is in the pit, though its pair is not WBNB and it is not on the board; booked in BNB at the keeper's size", () => {
    const w = world({ pit: PIT });
    const out = tick(w);
    expect(out.buys.map((b) => [b.coin, b.bnb, b.payIn ?? "native"])).toEqual([[PIT.coin, 0.006, "native"]]);
    expect(out.buys[0]!.reason).toBe("steady: for the day's floor (0 trades, 0.0000 BNB so far), in the league's pit");
  });

  it("its sale is in the pit at the next tick (a floor round: the buy and its sale); no other buy while it is pending; two rounds keep the floor", () => {
    const w = world({ pit: PIT });
    fill(w, tick(w));
    const pending = tick(world({ ...w, now: w.now + 30_000 }));
    expect(pending.buys).toEqual([]);
    w.now += MIN;
    const sold = tick(w);
    expect(sold.sells.map((x) => [x.coin, x.fraction])).toEqual([[PIT.coin, 1]]);
    expect(sold.buys).toEqual([]);
    w.positions = [];
    w.day = day({ trades: 2, volumeBnb: 0.012 });
    w.now += 14 * MIN;
    expect(tick(w).buys.map((b) => b.coin)).toEqual([PIT.coin]);
  });

  it("the pit refused or not named (extras.pit() null): the busiest WBNB pair, as before; a pit the host holds is never bought into", () => {
    for (const pit of [null, undefined]) expect(tick(world({ pit })).buys.map((b) => b.coin)).toEqual([coin(0xc1)]);
    // A pit position the host holds is never bought into: the keeper buys its usual coin.
    const host = world({ pit: PIT, positions: [position(PIT.coin)] });
    expect(tick(host).buys.map((b) => b.coin)).toEqual([coin(0xc1)]);
    // Never the agent's own coin, even named as the pit.
    expect(tick(world({ pit: { coin: OWN, symbol: "OWN" } })).buys.map((b) => b.coin)).toEqual([coin(0xc1)]);
  });

  it("every other coin's filter is unchanged: a stock pair that is not the pit is still never bought", () => {
    const w = world({ pit: null, coins: [row(coin(0xc4), { quote: STOCK, volume24hBnb: 20 }), row(coin(0xc1), { volume24hBnb: 9 })] });
    expect(tick(w).buys.map((b) => b.coin)).toEqual([coin(0xc1)]);
  });
});

describe("run 24 (amendment E): the pit's two-hop route is the address book's", () => {
  it("a BNCB-paired pit is bought BNB → BNCB → the pit and sold back the same way; a quote the book lacks has no route", () => {
    const chain = new LeagueChain(MAINNET, "http://127.0.0.1:9");
    const bncb = MAINNET.stocks.find((x) => x.symbol === "BNCB")!;
    expect(chain.hops(bncb.address, "buy")).toEqual([{ tokenOut: bncb.address, fee: 2500 }]);
    expect(chain.hops(bncb.address, "sell")).toEqual([{ tokenOut: WBNB, fee: 2500 }]);
    expect(chain.hops(WBNB, "buy")).toEqual([]);
    expect(() => chain.hops(coin(0x5170c), "buy")).toThrow(/no route for quote/);
  });
});
