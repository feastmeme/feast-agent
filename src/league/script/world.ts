import { getAddress, type Address } from "viem";

import { MAINNET } from "../../sdk/networks.ts";
import type { CoinRow, StrategyEvent, TradeRow } from "../strategy.ts";

/**
 * The stub world `FL script check` runs a script in (task 963): eight coins —
 * FEAST and seven made up — over 36 snapshots five minutes apart, built from a
 * fixed seed, so the same script always meets the same market. Prices rise,
 * fall and stall; holder counts move; a coin is launched part-way, trades run
 * all along, and one price move is announced. Nothing here is read from a
 * network or the chain, and no address in it is anyone's.
 */

export type Frame = {
  now: number;
  coins: CoinRow[];
  trades: TradeRow[];
  holders: Record<string, { at: number; holders: number }[]>;
  launchesByCreator: Record<string, number[]>;
  events: StrategyEvent[];
};

export type StubWorld = { seed: number; start: number; stepMs: number; balanceBnb: number; feast: Address; coins: Address[]; frames: Frame[] };

const WBNB = MAINNET.contracts.wrappedNative;
const FEAST = MAINNET.platformCoin!.address;
const made = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
/** The seven made-up coins, and made-up creators and traders. */
const COINS: { coin: Address; symbol: string; trend: number }[] = [
  { coin: FEAST, symbol: "FEAST", trend: 0.003 },
  { coin: made(0xc5701), symbol: "RISEA", trend: 0.02 },
  { coin: made(0xc5702), symbol: "RISEB", trend: 0.015 },
  { coin: made(0xc5703), symbol: "FALLA", trend: -0.02 },
  { coin: made(0xc5704), symbol: "FALLB", trend: -0.012 },
  { coin: made(0xc5705), symbol: "FLATA", trend: 0 },
  { coin: made(0xc5706), symbol: "FLATB", trend: 0 },
  { coin: made(0xc5707), symbol: "NEWB", trend: 0.05 },
];
/** The last coin is launched at this snapshot. */
const LAUNCH_AT = 12;
const MOVE_AT = 20;
const HOUR = 3_600_000;

/** A small fixed-seed generator (mulberry32): the same seed, the same world. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (n: number, digits = 12) => Number(n.toPrecision(digits));

export function stubWorld(seed = 963, count = 36): StubWorld {
  const rand = random(seed);
  // A FIXTURE clock for the stub world FL script check runs on: never a season date the player is told.
  const start = Date.parse("2026-10-26T12:00:00Z");
  const stepMs = 5 * 60_000;
  const creators = COINS.map((_, i) => made(0xc4ea70 + i));
  const traders = Array.from({ length: 6 }, (_, i) => made(0x7a0de0 + i));
  const prices = COINS.map((_, i) => 1e-6 * (1 + i * 0.3));
  const holders = COINS.map((_, i) => 20 + i * 5);
  const launchedAt = COINS.map((_, i) => (i === COINS.length - 1 ? start + LAUNCH_AT * stepMs : start - (i + 1) * 6 * HOUR));
  const history: Record<string, { at: number; holders: number }[]> = {};
  const trades: TradeRow[] = [];
  const frames: Frame[] = [];
  let moveFrom = 0;
  for (let f = 0; f < count; f += 1) {
    const now = start + f * stepMs;
    const live = COINS.map((c, i) => ({ ...c, i })).filter((c) => launchedAt[c.i]! <= now);
    const events: StrategyEvent[] = [];
    for (const c of live) {
      prices[c.i] = prices[c.i]! * (1 + c.trend + (rand() - 0.5) * 0.01);
      holders[c.i] = Math.max(1, holders[c.i]! + (c.trend > 0 ? 1 + Math.floor(rand() * 3) : c.trend < 0 ? -Math.floor(rand() * 2) : 0));
      const k = c.coin.toLowerCase();
      history[k] = [...(history[k] ?? []), { at: now, holders: holders[c.i]! }];
    }
    if (f === LAUNCH_AT) {
      const c = COINS[COINS.length - 1]!;
      events.push({ type: "coin.created", coin: c.coin, creator: creators[COINS.length - 1]!, quote: WBNB, hasMetadata: true, at: now });
    }
    for (let t = 0; t < 3; t += 1) {
      const c = live[Math.floor(rand() * live.length)]!;
      const bnb = round(0.002 + rand() * 0.03, 6);
      const side = rand() < (c.trend >= 0 ? 0.7 : 0.35) ? "buy" : "sell";
      const row: TradeRow = { coin: c.coin, side, payer: traders[Math.floor(rand() * traders.length)]!, bnb, coins: round(bnb / prices[c.i]!), priceBnb: round(prices[c.i]!), at: now - t * 1_000, txHash: `0x${(f * 10 + t + 1).toString(16).padStart(64, "0")}` };
      trades.push(row);
      events.push({ type: "trade", coin: row.coin, side: row.side, payer: row.payer, bnb: row.bnb, coins: row.coins, priceBnb: row.priceBnb, at: row.at });
    }
    if (f === MOVE_AT - 4) moveFrom = prices[1]!;
    if (f === MOVE_AT) events.push({ type: "price.move", coin: COINS[1]!.coin, fromBnb: round(moveFrom), toBnb: round(prices[1]!), movePct: round(((prices[1]! - moveFrom) / moveFrom) * 100, 6), at: now });
    const recent = trades.filter((t) => now - t.at < 2 * HOUR);
    const coins: CoinRow[] = live.map((c) => {
      const day = trades.filter((t) => t.coin === c.coin && now - t.at < 24 * HOUR);
      return {
        coin: c.coin,
        symbol: c.symbol,
        quote: WBNB,
        creator: creators[c.i]!,
        launchedAt: launchedAt[c.i]!,
        ageSeconds: Math.floor((now - launchedAt[c.i]!) / 1_000),
        holders: holders[c.i]!,
        volume24hBnb: round(day.reduce((sum, t) => sum + (t.bnb ?? 0), 0), 9),
        trades24h: day.length,
        priceBnb: round(prices[c.i]!),
        hasMetadata: true,
      };
    });
    const launchesByCreator: Record<string, number[]> = {};
    for (const c of live) launchesByCreator[creators[c.i]!.toLowerCase()] = [launchedAt[c.i]!];
    frames.push({ now, coins, trades: recent, holders: Object.fromEntries(Object.entries(history).map(([k, v]) => [k, v.filter((s) => now - s.at < 4 * HOUR)])), launchesByCreator, events });
  }
  return { seed, start, stepMs, balanceBnb: 0.2, feast: FEAST, coins: COINS.map((c) => c.coin), frames };
}
