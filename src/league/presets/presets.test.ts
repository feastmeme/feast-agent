import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { MAINNET } from "../../sdk/networks.ts";
import { DEFAULT_LIMITS } from "../limits.ts";
import { makeApi, type CoinRow, type PositionRow, type Snapshot, type StrategyEvent } from "../strategy.ts";
import { leaderWallets, leaderboardUrl, parseLeaderboard } from "./leaderboard.ts";
import { presetStrategy } from "./logic.ts";
import { PRESETS, PRESET_IDS, resolveParams, type PresetId } from "./specs.ts";

const FEAST = MAINNET.platformCoin!.address;
const COIN: Address = getAddress("0x00000000000000000000000000000000c0ffee01");
const LEADER: Address = getAddress("0x000000000000000000000000000000000000beef");
const CREATOR: Address = getAddress("0x000000000000000000000000000000000000c0de");
const T = 1_800_000_000_000;
const MIN = 60_000;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    now: T,
    balanceBnb: 1,
    limits: DEFAULT_LIMITS,
    warmup: null,
    coins: [],
    positions: [],
    trades: [],
    holders: {},
    launchesByCreator: {},
    feast: FEAST,
    launched: null,
    ...over,
  };
}
const row = (over: Partial<CoinRow> = {}): CoinRow => ({
  coin: COIN,
  symbol: "TEST",
  quote: MAINNET.contracts.wrappedNative,
  creator: CREATOR,
  launchedAt: T - 60 * MIN,
  ageSeconds: 3_600,
  holders: 50,
  volume24hBnb: 5,
  trades24h: 100,
  priceBnb: 0.000001,
  hasMetadata: true,
  ...over,
});
const position = (over: Partial<PositionRow> = {}): PositionRow => ({
  coin: COIN,
  symbol: "TEST",
  coins: 1_000,
  costBnb: 0.005,
  markBnb: 0.005,
  pnlPct: 0,
  peakBnb: 0.005,
  openedAt: T - MIN,
  ageSeconds: 60,
  ownLaunch: false,
  armed: true,
  ...over,
});

function params(id: PresetId, given: Record<string, unknown> = {}) {
  const r = resolveParams(id, given, DEFAULT_LIMITS);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.params;
}

/** One strategy call over a snapshot; the state carries over between calls. */
function run(id: PresetId, snapshot: Snapshot, state: Record<string, unknown>, given: Record<string, unknown> = {}, event?: StrategyEvent, extras?: { claims: string[] }) {
  const strategy = presetStrategy(id);
  const { api, intents } = makeApi(snapshot, { params: params(id, given), state, source: "preset", ttlMs: 30_000, log: () => {} });
  const ext = extras ? { claimAndBuyBack: (coin: Address) => (extras.claims.push(coin), "claim-1") } : undefined;
  if (event) strategy.onEvent?.(api, event, ext);
  else strategy.onTick(api, ext);
  return intents;
}

describe("preset parameters", () => {
  it("every preset resolves its defaults, except the parameters only the user can give", () => {
    for (const id of PRESET_IDS) {
      const r = resolveParams(id, {}, DEFAULT_LIMITS);
      if (id === "copy") expect(r.ok).toBe(false);
      else if (id === "launch") expect(r.ok).toBe(false);
      else expect(r.ok, id).toBe(true);
    }
    expect(resolveParams("copy", { wallets: [LEADER] }, DEFAULT_LIMITS).ok).toBe(true);
    expect(resolveParams("launch", { name: "Dinner Bell", symbol: "BELL" }, DEFAULT_LIMITS).ok).toBe(true);
  });

  it("a size is bounded by L1, a stop-loss by L6, a slippage by L9", () => {
    const lane = { ...DEFAULT_LIMITS, maxTradeBnb: 0.005 };
    expect(resolveParams("dca", { buyBnb: 0.006 }, lane).ok).toBe(false);
    expect(resolveParams("dca", { buyBnb: 0.005 }, lane).ok).toBe(true);
    expect(resolveParams("sniper", { stopLossPct: 60 }, DEFAULT_LIMITS).ok).toBe(false);
    expect(resolveParams("sniper", { slippagePct: 11 }, DEFAULT_LIMITS).ok).toBe(false);
    expect(resolveParams("dca", { nonsense: 1 }, DEFAULT_LIMITS).ok).toBe(false);
  });

  it("copy follows a wallet list in v1; the leaderboard source is refused until it exists", () => {
    const r = resolveParams("copy", { source: "leaderboard", wallets: [LEADER] }, DEFAULT_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/not open yet/);
    expect(resolveParams("copy", { wallets: "not-an-address" }, DEFAULT_LIMITS).ok).toBe(false);
  });

  it("launch holds the ticker to 1–10 letters or digits; dca's take-profit is off unless set", () => {
    expect(resolveParams("launch", { name: "x", symbol: "bad ticker" }, DEFAULT_LIMITS).ok).toBe(false);
    expect(params("dca").takeProfitPct).toBeNull();
    expect(params("dca", { takeProfitPct: 50 }).takeProfitPct).toBe(50);
    expect(PRESETS.dca.tickSeconds).toBe(3600);
  });
});

describe("⑤ dca", () => {
  const feastRow = (price: number) => row({ coin: FEAST, symbol: "FEAST", priceBnb: price });

  it("buys on start, then once per interval, within the daily cap", () => {
    const state = {};
    const first = run("dca", snap({ coins: [feastRow(1)] }), state, { buyBnb: 0.002 });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "buy", coin: FEAST, bnb: 0.002, source: "preset", slippagePct: 1 });
    expect(run("dca", snap({ now: T + 60 * MIN, coins: [feastRow(1)] }), state, { buyBnb: 0.002 })).toHaveLength(0);
    expect(run("dca", snap({ now: T + 1_440 * MIN, coins: [feastRow(1)] }), state, { buyBnb: 0.002 })).toHaveLength(1);
  });

  it("adds a dip buy at 15 % below the 24 h high", () => {
    const state = {};
    run("dca", snap({ coins: [feastRow(1)] }), state, { buyBnb: 0.002, dipBuyBnb: 0.002 });
    expect(run("dca", snap({ now: T + 60 * MIN, coins: [feastRow(0.9)] }), state, { buyBnb: 0.002, dipBuyBnb: 0.002 })).toHaveLength(0);
    const dip = run("dca", snap({ now: T + 120 * MIN, coins: [feastRow(0.84)] }), state, { buyBnb: 0.002, dipBuyBnb: 0.002 });
    expect(dip).toHaveLength(1);
    expect(dip[0]!.reason).toMatch(/dip/);
    // The daily cap of two holds the next one back.
    expect(run("dca", snap({ now: T + 500 * MIN, coins: [feastRow(0.5)] }), state, { buyBnb: 0.002, dipBuyBnb: 0.002 })).toHaveLength(0);
  });
});

describe("① sniper", () => {
  const launched = (over: Partial<Extract<StrategyEvent, { type: "coin.created" }>> = {}): StrategyEvent => ({
    type: "coin.created",
    coin: COIN,
    creator: CREATOR,
    quote: MAINNET.contracts.wrappedNative,
    hasMetadata: true,
    at: T - 5_000,
    ...over,
  });

  it("buys a fresh coin with metadata within its age window", () => {
    const intents = run("sniper", snap(), {}, {}, launched());
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: "buy", coin: COIN, bnb: 0.005, slippagePct: 8 });
  });

  it("skips an old coin, a coin with no metadata, a serial launcher, a pair it was not asked for", () => {
    expect(run("sniper", snap(), {}, {}, launched({ at: T - 91_000 }))).toHaveLength(0);
    expect(run("sniper", snap(), {}, {}, launched({ hasMetadata: false }))).toHaveLength(0);
    const busy = snap({ launchesByCreator: { [CREATOR.toLowerCase()]: [T - 1, T - 2, T - 3, T - 4] } });
    expect(run("sniper", busy, {}, {}, launched())).toHaveLength(0);
    expect(run("sniper", snap(), {}, { quotes: "BNCB" }, launched())).toHaveLength(0);
  });

  it("holds to its snipes per hour", () => {
    const state = {};
    for (let i = 0; i < 3; i += 1) run("sniper", snap(), state, {}, launched({ coin: `0x00000000000000000000000000000000c0ffee0${i + 2}` as Address }));
    expect(run("sniper", snap(), state, {}, launched())).toHaveLength(0);
  });

  it("exits only its own snipes: stop-loss, take-profit once, time stop", () => {
    const state: Record<string, unknown> = { mine: { [COIN.toLowerCase()]: T - MIN } };
    const loss = run("sniper", snap({ positions: [position({ pnlPct: -26 })] }), state);
    expect(loss).toMatchObject([{ kind: "sell", coin: COIN, fraction: 1 }]);
    expect(loss[0]!.reason).toMatch(/stop-loss/);
    const s2: Record<string, unknown> = { mine: { [COIN.toLowerCase()]: T - MIN } };
    const tp = run("sniper", snap({ positions: [position({ pnlPct: 120 })] }), s2, { takeProfitSellPct: 50 });
    expect(tp).toMatchObject([{ kind: "sell", fraction: 0.5 }]);
    expect(run("sniper", snap({ now: T + 2 * MIN, positions: [position({ pnlPct: 130 })] }), s2, { takeProfitSellPct: 50 })).toHaveLength(0);
    const s3: Record<string, unknown> = { mine: { [COIN.toLowerCase()]: T - MIN } };
    expect(run("sniper", snap({ positions: [position({ ageSeconds: 31 * 60 })] }), s3)[0]!.reason).toMatch(/time stop/);
    // Not its own: left to the runtime's backstop.
    expect(run("sniper", snap({ positions: [position({ pnlPct: -40 })] }), {})).toHaveLength(0);
  });
});

describe("② momentum", () => {
  it("enters on volume, holder growth and price, and exits on a trailing stop", () => {
    const trades = [0, 1, 2, 3, 4].map((i) => ({ coin: COIN, side: "buy" as const, payer: LEADER, bnb: 0.2, coins: 1, priceBnb: 1 + i * 0.05, at: T - (10 - i) * MIN, txHash: "0x" }));
    const holders = { [COIN.toLowerCase()]: [{ at: T - 14 * MIN, holders: 40 }, { at: T, holders: 55 }] };
    const state = {};
    const entry = run("momentum", snap({ coins: [row()], trades, holders }), state);
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ kind: "buy", coin: COIN, bnb: 0.01 });
    const trailing = run("momentum", snap({ now: T + 10 * MIN, positions: [position({ markBnb: 0.008, peakBnb: 0.01, pnlPct: 60, ageSeconds: 600 })], trades }), state);
    expect(trailing[0]!.reason).toMatch(/trailing/);
  });

  it("does not enter a coin without holder growth", () => {
    const trades = [0, 1, 2].map((i) => ({ coin: COIN, side: "buy" as const, payer: LEADER, bnb: 0.5, coins: 1, priceBnb: 1 + i * 0.1, at: T - (5 - i) * MIN, txHash: "0x" }));
    const holders = { [COIN.toLowerCase()]: [{ at: T - 14 * MIN, holders: 50 }, { at: T, holders: 52 }] };
    expect(run("momentum", snap({ coins: [row()], trades, holders }), {})).toHaveLength(0);
  });
});

describe("③ copy", () => {
  const leaderTrade = (side: "buy" | "sell", bnb = 0.05, at = T): StrategyEvent => ({ type: "trade", coin: COIN, side, payer: LEADER, bnb, coins: 10, priceBnb: 1, at });

  it("copies a followed wallet's buy after the delay, at the fixed size", () => {
    const state = {};
    expect(run("copy", snap({ coins: [row({ priceBnb: 1 })] }), state, { wallets: [LEADER], delaySeconds: 5 }, leaderTrade("buy"))).toHaveLength(0);
    const copied = run("copy", snap({ now: T + 6_000, coins: [row({ priceBnb: 1.05 })] }), state, { wallets: [LEADER], delaySeconds: 5 });
    expect(copied).toMatchObject([{ kind: "buy", coin: COIN, bnb: 0.005 }]);
  });

  it("skips dust, a price that ran past the chase limit, and anyone not followed", () => {
    const s1 = {};
    run("copy", snap(), s1, { wallets: [LEADER] }, leaderTrade("buy", 0.001));
    expect(run("copy", snap({ now: T + 6_000 }), s1, { wallets: [LEADER] })).toHaveLength(0);
    const s2 = {};
    run("copy", snap(), s2, { wallets: [LEADER] }, leaderTrade("buy"));
    expect(run("copy", snap({ now: T + 6_000, coins: [row({ priceBnb: 1.2 })] }), s2, { wallets: [LEADER] })).toHaveLength(0);
    const stranger: StrategyEvent = { ...(leaderTrade("buy") as Extract<StrategyEvent, { type: "trade" }>), payer: CREATOR };
    const s3 = {};
    run("copy", snap(), s3, { wallets: [LEADER] }, stranger);
    expect(run("copy", snap({ now: T + 6_000 }), s3, { wallets: [LEADER] })).toHaveLength(0);
  });

  it("fails closed: no copy when the chase cannot be measured (either price unknown)", () => {
    const s1 = {};
    const noLeaderPrice: StrategyEvent = { ...(leaderTrade("buy") as Extract<StrategyEvent, { type: "trade" }>), priceBnb: null };
    run("copy", snap(), s1, { wallets: [LEADER] }, noLeaderPrice);
    expect(run("copy", snap({ now: T + 6_000, coins: [row({ priceBnb: 1 })] }), s1, { wallets: [LEADER] })).toHaveLength(0);
    const s2 = {};
    run("copy", snap(), s2, { wallets: [LEADER] }, leaderTrade("buy"));
    expect(run("copy", snap({ now: T + 6_000, coins: [row({ priceBnb: null })] }), s2, { wallets: [LEADER] })).toHaveLength(0);
    const s3 = {};
    run("copy", snap(), s3, { wallets: [LEADER] }, leaderTrade("buy"));
    expect(run("copy", snap({ now: T + 6_000 }), s3, { wallets: [LEADER] })).toHaveLength(0);
  });

  it("sells a copied coin when its leader sells", () => {
    const state: Record<string, unknown> = { mine: { [COIN.toLowerCase()]: T - MIN } };
    const out = run("copy", snap({ positions: [position()] }), state, { wallets: [LEADER] }, leaderTrade("sell"));
    expect(out).toMatchObject([{ kind: "sell", coin: COIN, fraction: 1 }]);
  });
});

describe("④ launch-and-run", () => {
  const given = { name: "Dinner Bell", symbol: "BELL", openingBuyBnb: 0.002 };

  it("launches once, then makes the opening buy, then claims and buys back on its schedule", () => {
    const state = {};
    const first = run("launch", snap(), state, given);
    expect(first).toMatchObject([{ kind: "launch", launch: { name: "Dinner Bell", symbol: "BELL", quote: "WBNB", burn: 20, referrer: 10 } }]);
    expect(run("launch", snap({ now: T + MIN }), state, given)).toHaveLength(0);
    const launched = { coin: COIN, at: T + 2 * MIN };
    expect(run("launch", snap({ now: T + 3 * MIN, launched }), state, given)).toMatchObject([{ kind: "buy", coin: COIN, bnb: 0.002 }]);
    const claims: string[] = [];
    expect(run("launch", snap({ now: T + 30 * MIN, launched }), state, given, undefined, { claims })).toHaveLength(0);
    expect(claims).toHaveLength(0);
    run("launch", snap({ now: T + 63 * MIN, launched }), state, given, undefined, { claims });
    expect(claims).toEqual([COIN]);
  });
});

describe("the leaderboard reader (stub for the league page's /api/league)", () => {
  const rows = [
    { rank: 2, wallet: CREATOR, name: "b", figures: { pnl: 1 }, window: "season", asOf: "2026-10-21T00:00:00Z" },
    { rank: 1, wallet: LEADER, name: "a", figures: { pnl: 2 }, window: "season", asOf: "2026-10-21T00:00:00Z" },
  ];

  it("builds the agreed URL and reads the agreed rows, by rank", async () => {
    expect(leaderboardUrl("https://feast.meme/", "season", 5)).toBe("https://feast.meme/api/league?w=season&limit=5");
    expect(leaderboardUrl("https://feast.meme", "2026-10-21", 5)).toContain("w=2026-10-21");
    expect(() => leaderboardUrl("https://feast.meme", "week" as never, 5)).toThrow();
    const fake = (async () => new Response(JSON.stringify(rows))) as unknown as typeof fetch;
    expect(await leaderWallets("https://feast.meme", "season", 1, fake)).toEqual([LEADER]);
    expect(parseLeaderboard({ rows })).toHaveLength(2);
  });

  it("refuses rows of another shape", () => {
    expect(() => parseLeaderboard([{ rank: 1, wallet: "nope", name: "a", figures: {}, window: "season", asOf: "x" }])).toThrow(/row 0/);
    expect(() => parseLeaderboard({ data: [] })).toThrow(/without rows/);
  });
});
