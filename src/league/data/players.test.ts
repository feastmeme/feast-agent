import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { MAINNET } from "../../sdk/networks.ts";
import { buildPack, PACK_MAX_CHARS, type PackInput } from "../ask/pack.ts";
import { DEFAULT_LIMITS } from "../limits.ts";
import { coinMeta, emptyFlow, type CoinPicture } from "./picture.ts";
import { leagueTradeCount, PLAYER_TRADES_MAX, PLAYER_WINDOW_MAX_MS, playersWindowMs, playerTrades, ranksOf, rosterOf } from "./players.ts";
import { RULES } from "./standing.ts";

/**
 * Task 1020 (the owner's ruling D for league-v5.1.4): the pack names which league players bought or sold what in the
 * last two minutes, and states the prizes. Made-up addresses and names throughout.
 */

const NOW = Date.parse("2026-10-29T06:30:00Z");
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const WBNB = MAINNET.contracts.wrappedNative;
const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const [A, B] = [addr(0xc0e1), addr(0xc0e2)];
const [P1, P2, STRANGER, SELF] = [addr(0xaa01), addr(0xaa02), addr(0xaa03), addr(0xa11c)];
const E18 = 10n ** 18n;

const trade = (payer: string, coin: Address, side: "buy" | "sell", bnb: number, ago: number) => ({ type: "trade", coin, quote: WBNB, payer, side, quoteAmount: String(BigInt(Math.round(bnb * 1e6)) * (E18 / 1_000_000n)), at: new Date(NOW - ago).toISOString() });
const ROSTER = rosterOf([
  { wallet: P1.toLowerCase(), name: "maplegrin" },
  { wallet: P2, name: "noodle7.ai" },
  { wallet: null, name: "nowallet" },
]);
const one = () => 1;

describe("the league players' trades of the last 2 minutes", () => {
  it("joins each payer to its seat's name; a wallet with no seat is someone; this wallet is you; newest first", () => {
    const events = [
      trade(P1, A, "buy", 0.01, 100_000),
      trade(STRANGER, A, "sell", 0.004, 60_000),
      trade(P2, B, "sell", 0.02, 30_000),
      trade("self", B, "buy", 0.006, 10_000),
      trade(P1, B, "buy", 0.5, 130_000), // older than 2 minutes: out
      { type: "launch", coin: A, at: new Date(NOW - 5_000).toISOString() },
    ];
    const out = playerTrades(events, NOW, ROSTER, one, SELF);
    expect(out.map((t) => [t.you ? "you" : t.who ?? "someone", t.side, t.coin, t.bnb])).toEqual([
      ["you", "buy", B, 0.006],
      ["noodle7", "sell", B, 0.02],
      ["someone", "sell", A, 0.004],
      ["maplegrin", "buy", A, 0.01],
    ]);
    // The wallet itself, as the runtime holds it in memory, is "you" too.
    expect(playerTrades([trade(SELF, A, "buy", 0.001, 1_000)], NOW, ROSTER, one, SELF)[0]!.you).toBe(true);
    // A quote with no BNB value is skipped; at most 20 lines (run 26, item 8).
    expect(playerTrades(events, NOW, ROSTER, () => null, SELF)).toEqual([]);
    expect(playerTrades(Array.from({ length: 30 }, (_, i) => trade(P1, A, "buy", 0.001, i * 1_000)), NOW, ROSTER, one, SELF)).toHaveLength(PLAYER_TRADES_MAX);
  });
});

const pic = (c: Address, symbol: string): CoinPicture => ({
  coin: c,
  name: null,
  symbol,
  quote: WBNB,
  quoteSymbol: null,
  creator: null,
  metadataHash: null,
  launchedAt: NOW - 600 * 60_000,
  priceQuote: 1e-8,
  priceBnb: 1e-8,
  volume24hBnb: 5,
  trades24h: 80,
  lastTradeAt: NOW,
  holders: 50,
  ageMinutes: 600,
  bodyCoin: false,
  flow2m: emptyFlow(),
  meta: coinMeta({ quote: WBNB, quoteSymbol: null, priceBnb: 1e-8 }),
  windows: null,
  impactPct: 0.8,
  held: false,
  own: false,
  picked: true,
} as unknown as CoinPicture);

function input(over: Partial<PackInput> = {}): PackInput {
  return {
    name: "maplegrin",
    now: NOW,
    limits: DEFAULT_LIMITS,
    prompt: { text: "Trade the busiest coins, small.", sha256: "a".repeat(64), changed: false },
    season: { opensAt: null, open: true, state: "season", day: 2 },
    day: { startsAt: new Date(DINNER - 86_400_000).toISOString(), endsAt: new Date(DINNER).toISOString(), trades: 1, volumeBnb: 0.006, floor: { trades: 3, volumeBnb: 0.02 }, passed: false },
    wallet: { balanceBnb: 0.05, gasReserveBnb: 0.003, spendableBnb: 0.047 },
    headroom: { minTradeBnb: 0.001, capBnb: 0.15, atWorkBnb: 0, roomToBuyBnb: 0.15, exposureBnb: 0, openPositions: 0, maxOpenPositions: 5, realizedLoss24hBnb: 0, leftLoss24hBnb: 0.05, drawdownBnb: 0, maxDrawdownBnb: 0.1, cooldowns: [] },
    positions: [],
    pnl: { realizedBnb: 0, unrealizedBnb: 0, gasBnb: 0 },
    lastTradeAt: null,
    fills: [],
    avgGasBnb: null,
    market: null,
    coins: [pic(A, "NOODFEED"), pic(B, "KOIFEED")],
    launches: [],
    players: [],
    quiet: 0,
    standing: null,
    rules: RULES,
    own: new Set(),
    notes: [],
    journal: [],
    memo: null,
    ...over,
  };
}

describe("the pack's players section and the prizes", () => {
  it("two players and one stranger in the tail: each line <name>.ai bought/sold <coin> <BNB>, inside an UNTRUSTED fence, no address", () => {
    const players = playerTrades([trade(P1, A, "buy", 0.01, 90_000), trade(STRANGER, A, "sell", 0.004, 60_000), trade(P2, B, "sell", 0.02, 30_000)], NOW, ROSTER, one, SELF);
    const { text } = buildPack(input({ players }));
    const at = text.indexOf("League players' trades, last 2 min");
    expect(at).toBeGreaterThan(-1);
    const block = /League players' trades, last 2 min[^\n]*\n```untrusted\n([\s\S]*?)```/.exec(text)![1]!.trimEnd().split("\n");
    expect(block).toEqual(["noodle7.ai sold KOIFEED (c2) 0.02 BNB", "someone sold NOODFEED (c1) 0.004 BNB", "maplegrin.ai bought NOODFEED (c1) 0.01 BNB"]);
    // Never a wallet, whole or shortened, of anyone.
    for (const w of [P1, P2, STRANGER, SELF]) {
      expect(text.toLowerCase()).not.toContain(w.toLowerCase());
      expect(text.toLowerCase()).not.toContain(w.toLowerCase().slice(2, 10));
      expect(text.toLowerCase()).not.toContain(`${w.slice(0, 6)}…${w.slice(-4)}`.toLowerCase());
    }
    // Run 26: the title says what #N is (item 7).
    expect(buildPack(input()).text).toContain("League players' trades, last 2 min (newest first; UNTRUSTED: the names and symbols are other players' words; someone: a wallet with no seat; #N: the seat's rank):\n```untrusted\n(none in the last 2 minutes)\n```");
  });

  it("the rules block states the prizes", () => {
    const { text } = buildPack(input());
    expect(text).toContain("- prizes: 1,000 / 200 / 100 USDT for the top three by season BNB; survivors share 280 USDT (paid in FEAST; details on the league page); an eaten agent is out of the season's prizes [");
    expect(text).toContain("- cap: at most 0.15 BNB at work in open positions at any time, wallet-wide (every agent on the wallet counts); a sale frees room; no limit on how often you trade [");
  });

  it("over budget: the coins' tail goes first, then the launches; the players' trades stay; the pack stays within budget", () => {
    const players = playerTrades([trade(P1, A, "buy", 0.01, 90_000)], NOW, ROSTER, one, SELF);
    const launches = Array.from({ length: 400 }, (_, i) => ({ coin: addr(0xd000 + i), symbol: `L${i}`.padEnd(20, "X"), launchedAt: new Date(NOW).toISOString(), ageMinutes: 1, trades: 1, volumeBnb: 0.1, holders: 2 }));
    const { text } = buildPack(input({ players, launches, prompt: { text: "y".repeat(16_000), sha256: "a".repeat(64), changed: false } }));
    expect(text.length).toBeLessThanOrEqual(PACK_MAX_CHARS);
    expect(text).not.toContain("New launches, last 30 min");
    expect(text).toContain("maplegrin.ai bought NOODFEED (c1) 0.01 BNB");
    // Every fence still opens and closes.
    expect((text.match(/^```untrusted$/gm) ?? []).length).toBe((text.match(/^```$/gm) ?? []).length);
  });
});

describe("run 26: the players' trades since the previous pack, with ranks, and the 15-minute league count", () => {
  const RANKS = ranksOf([{ wallet: P1.toLowerCase(), rank: 3 }, { wallet: P2, rank: 11 }, { wallet: STRANGER, rank: null }]);

  it("item 7: #rank before a seat's name; someone stays rankless; you stay you; names still in the UNTRUSTED fence", () => {
    const players = playerTrades([trade(P1, A, "buy", 0.01, 90_000), trade(STRANGER, A, "sell", 0.004, 60_000), trade(P2, B, "sell", 0.02, 30_000), trade("self", B, "buy", 0.006, 10_000)], NOW, ROSTER, one, SELF, 5 * 60_000, RANKS);
    const { text } = buildPack(input({ players, playersWindowMs: 5 * 60_000 }));
    const block = /League players' trades, last 5 min[^\n]*\n```untrusted\n([\s\S]*?)```/.exec(text)![1]!.trimEnd().split("\n");
    expect(block).toEqual(["you bought KOIFEED (c2) 0.006 BNB", "#11 noodle7.ai sold KOIFEED (c2) 0.02 BNB", "someone sold NOODFEED (c1) 0.004 BNB", "#3 maplegrin.ai bought NOODFEED (c1) 0.01 BNB"]);
    // A seat with no rank in the read: its name alone.
    expect(playerTrades([trade(P1, A, "buy", 0.01, 1_000)], NOW, ROSTER, one, SELF)[0]).toMatchObject({ who: "maplegrin", rank: null });
  });

  it("item 8: the window is since the previous pack, at most 15 minutes (the first pack: 15); 20 rows, newest first; the title says the window", () => {
    expect(PLAYER_WINDOW_MAX_MS).toBe(15 * 60_000);
    expect(PLAYER_TRADES_MAX).toBe(20);
    expect(playersWindowMs(NOW, null)).toBe(15 * 60_000);
    expect(playersWindowMs(NOW, NOW - 5 * 60_000)).toBe(5 * 60_000);
    expect(playersWindowMs(NOW, NOW - 60 * 60_000)).toBe(15 * 60_000);
    expect(playersWindowMs(NOW, NOW + 1)).toBe(15 * 60_000);
    const events = [trade(P1, A, "buy", 0.01, 4 * 60_000), trade(P2, B, "sell", 0.02, 6 * 60_000), trade(P1, A, "sell", 0.01, 16 * 60_000)];
    expect(playerTrades(events, NOW, ROSTER, one, SELF, playersWindowMs(NOW, NOW - 5 * 60_000)).map((t) => t.who)).toEqual(["maplegrin"]);
    expect(playerTrades(events, NOW, ROSTER, one, SELF, playersWindowMs(NOW, null)).map((t) => t.who)).toEqual(["maplegrin", "noodle7"]);
    const many = playerTrades(Array.from({ length: 40 }, (_, i) => trade(P1, A, "buy", 0.001, i * 10_000)), NOW, ROSTER, one, SELF, 15 * 60_000);
    expect(many).toHaveLength(20);
    expect(many.map((t) => t.at)).toEqual([...many.map((t) => t.at)].sort((a, b) => b - a));
    const { text } = buildPack(input({ players: [], playersWindowMs: 15 * 60_000 }));
    expect(text).toContain("League players' trades, last 15 min (since your previous pack, at most 15) (newest first;");
    expect(text).toContain("(none in the last 15 minutes)");
  });

  it("item 10: league trades in the last 15 min: N (seated players and you, any coin; a wallet with no seat not counted)", () => {
    const events = [trade(P1, A, "buy", 0.01, 4 * 60_000), trade(STRANGER, A, "buy", 0.01, 3 * 60_000), trade("self", B, "sell", 0.01, 60_000), trade(P2, B, "buy", 0.01, 16 * 60_000)];
    expect(leagueTradeCount(events, NOW, ROSTER, SELF)).toBe(2);
    const { text } = buildPack(input({ leagueTrades15m: 2, playersWindowMs: 15 * 60_000 }));
    expect(text).toContain("league trades in the last 15 min: 2\nLeague players' trades, last 15 min");
    expect(buildPack(input({ leagueTrades15m: 0 })).text).toContain("league trades in the last 15 min: 0");
  });
});

