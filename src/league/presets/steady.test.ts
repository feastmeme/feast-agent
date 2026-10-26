import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { MAINNET } from "../../sdk/networks.ts";
import { DEFAULT_LIMITS } from "../limits.ts";
import type { DayCount } from "../prompt/floor.ts";
import { makeApi, type CoinRow, type PositionRow, type PresetExtras, type Snapshot } from "../strategy.ts";
import { presetStrategy } from "./logic.ts";
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

type World = { now: number; coins: CoinRow[]; positions: PositionRow[]; day: DayCount | null; standingBy: boolean; launched: Address | null; state: Record<string, unknown>; params: Record<string, unknown> };

function world(over: Partial<World> = {}): World {
  return { now: DINNER - 6 * 60 * MIN, coins: [row(coin(0xc1), { volume24hBnb: 9 }), row(coin(0xc2), { volume24hBnb: 5 }), row(coin(0xc3), { volume24hBnb: 2 })], positions: [], day: day(), standingBy: false, launched: OWN, state: {}, params: { ...DEFAULTS }, ...over };
}

/** One tick of steady on the world as it is; the world's state is kept. */
function tick(w: World) {
  const snapshot: Snapshot = { now: w.now, balanceBnb: 1, limits: DEFAULT_LIMITS, warmup: null, coins: w.coins, positions: w.positions, trades: [], holders: {}, launchesByCreator: {}, feast: FEAST, launched: w.launched ? { coin: w.launched, at: 0 } : null };
  const logs: string[] = [];
  const { api, intents } = makeApi(snapshot, { params: w.params, state: w.state, source: "preset", ttlMs: 60_000, log: (t) => logs.push(t) });
  const extras: PresetExtras = { claimAndBuyBack: () => null, day: () => w.day, standingBy: () => w.standingBy };
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

describe("steady: the coin", () => {
  it("the busiest eligible by 24 h volume: never the own coin, FEAST, a coin held, a stock pair or one younger than minAgeMinutes", () => {
    const busiest = [
      row(OWN, { volume24hBnb: 99 }),
      row(FEAST, { volume24hBnb: 98, symbol: "FEAST" }),
      row(coin(0xa1), { volume24hBnb: 97 }),
      row(coin(0xa2), { volume24hBnb: 96, quote: STOCK }),
      row(coin(0xa3), { volume24hBnb: 95, ageSeconds: 59 * 60 }),
      row(coin(0xa4), { volume24hBnb: 4 }),
      row(coin(0xa5), { volume24hBnb: 4, trades24h: 80 }),
    ];
    const w = world({ coins: busiest, positions: [position(coin(0xa1), { costBnb: 0.001, markBnb: 0.001 })] });
    const out = tick(w);
    expect(out.buys).toHaveLength(1);
    // Ties on volume: more trades first.
    expect(out.buys[0]).toMatchObject({ coin: coin(0xa5), bnb: 0.006, source: "preset", slippagePct: 5 });
    expect(out.buys[0]!.reason).toMatch(/^steady: /);
  });

  it("spreads its buys over the busiest topN: a coin it bought today is taken after the others", () => {
    const w = world();
    fill(w, tick(w));
    expect(w.positions.map((p) => p.coin)).toEqual([coin(0xc1)]);
    // Sold 15 minutes later: the busiest is free again, and steady takes the next one.
    w.positions = [];
    w.day = day({ trades: 2, volumeBnb: 0.0119 });
    w.now += 15 * MIN;
    expect(tick(w).buys.map((b) => b.coin)).toEqual([coin(0xc2)]);
  });

  it("when no coin clears minVolumeBnb: the busiest eligible coin with any volume, said once that day; none at all: no buy, said once", () => {
    const thin = world({ coins: [row(coin(0xd1), { volume24hBnb: 0.2 }), row(coin(0xd2), { volume24hBnb: 0.3 }), row(coin(0xd3), { volume24hBnb: 0 })] });
    const out = tick(thin);
    expect(out.buys.map((b) => b.coin)).toEqual([coin(0xd2)]);
    expect(out.logs.filter((l) => l.includes("for the floor"))).toHaveLength(1);
    const none = world({ coins: [row(coin(0xd3), { volume24hBnb: 0 }), row(OWN, { volume24hBnb: 9 })] });
    expect(tick(none).buys).toEqual([]);
    none.now += 20 * MIN;
    const again = tick(none);
    expect(again.buys).toEqual([]);
    expect(again.logs).toEqual([]);
  });
});

describe("steady: the rhythm", () => {
  it("two buys 15 minutes apart, then none while the projected day meets the floor", () => {
    const w = world();
    const first = tick(w);
    expect(first.buys).toHaveLength(1);
    fill(w, first);
    w.now += 5 * MIN;
    expect(tick(w).buys).toEqual([]);
    w.now += 10 * MIN;
    const second = tick(w);
    expect(second.buys).toHaveLength(1);
    fill(w, second);
    // Projected: 2 buys + 2 sales to come = 4 trades; 0.012 + the marks ≈ 0.0239 BNB.
    w.day = day({ trades: 2, volumeBnb: 0.012 });
    w.now += 15 * MIN;
    expect(tick(w).buys).toEqual([]);
  });

  it("no buy while the day already meets the floor its parameters ask for", () => {
    expect(tick(world({ day: day({ trades: 4, volumeBnb: 0.023 }) })).buys).toEqual([]);
    expect(tick(world({ day: day({ trades: 4, volumeBnb: 0.021 }) })).buys).toHaveLength(1);
    expect(tick(world({ day: day({ trades: 3, volumeBnb: 0.03 }) })).buys).toHaveLength(1);
  });

  it("at most maxPositions of its own open, at most maxEntriesPerDay bought", () => {
    const w = world();
    for (let i = 0; i < 2; i += 1) {
      fill(w, tick(w));
      w.now += 15 * MIN;
    }
    expect(w.positions).toHaveLength(2);
    expect(tick(w).buys).toEqual([]);
    // Both sold at a loss: the day still short, a third buy; then the day's buys are used up.
    w.positions = [];
    w.day = day({ trades: 4, volumeBnb: 0.0208 });
    const third = tick(w);
    expect(third.buys).toHaveLength(1);
    w.positions = [];
    w.now += 15 * MIN;
    w.day = day({ trades: 6, volumeBnb: 0.0209 });
    expect(tick(w).buys).toEqual([]);
  });

  it("the rush: in the last rushMinutes, with the floor not met, buys 3 minutes apart and a 3-minute time stop; nothing in the last 15 minutes", () => {
    const w = world({ now: DINNER - 40 * MIN });
    const first = tick(w);
    expect(first.buys).toHaveLength(1);
    fill(w, first);
    w.now += 3 * MIN;
    w.positions[0]!.ageSeconds = 180;
    const out = tick(w);
    expect(out.sells.map((s) => s.reason)).toEqual([expect.stringMatching(/^steady: time stop/)]);
    expect(out.buys).toHaveLength(1);
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
    w.now += 15 * MIN;
    expect(tick(w).buys).toEqual([]);
    w.positions[0]!.pnlPct = -12;
    expect(tick(w).sells.map((s) => s.reason)).toEqual([expect.stringMatching(/^steady: stop-loss at -12\.0%/)]);
  });
});

describe("steady: the exits", () => {
  const bought = () => {
    const w = world();
    fill(w, tick(w));
    return w;
  };

  it("the stop-loss, the take-profit, the time stop set at the buy", () => {
    const sl = bought();
    sl.positions[0]!.pnlPct = -10;
    expect(tick(sl).sells).toMatchObject([{ coin: coin(0xc1), fraction: 1, reason: expect.stringMatching(/^steady: stop-loss/) }]);
    const tp = bought();
    tp.positions[0]!.pnlPct = 15;
    expect(tick(tp).sells).toMatchObject([{ coin: coin(0xc1), fraction: 1, reason: expect.stringMatching(/^steady: take-profit/) }]);
    const ts = bought();
    ts.now += 29 * MIN;
    expect(tick(ts).sells).toEqual([]);
    ts.now += MIN;
    expect(tick(ts).sells).toMatchObject([{ coin: coin(0xc1), reason: "steady: time stop after 30 min" }]);
  });

  it("every position it opened is sold by dinner − 5 min, so the sale counts the same day", () => {
    const w = world({ now: DINNER - 90 * MIN, params: { ...DEFAULTS, timeStopMinutes: 720, rushMinutes: 0 } });
    fill(w, tick(w));
    w.now = DINNER - 6 * MIN;
    expect(tick(w).sells).toEqual([]);
    w.now = DINNER - 5 * MIN;
    expect(tick(w).sells).toMatchObject([{ coin: coin(0xc1), reason: "steady: sold before the dinner, so the sale counts today" }]);
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
