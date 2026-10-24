import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, type Address } from "viem";

import { MAINNET } from "../../sdk/networks.ts";
import { snapshotCoins, type FeastSnapshot, type SnapshotCoin } from "../feed/snapshot.ts";
import { readJson, writeJsonAtomic } from "../store.ts";
import { candles, type Candle } from "./ohlcv.ts";

/**
 * What is moving now (task 975, addendum 5): one picture of the market, for `FL data --json` and for the ask's pack
 * alike, built from feast.meme's snapshot (its coins, its 120-second events tail and what it says of itself) and, for
 * the coins that matter this tick, 5-minute candles (`/api/v1/ohlcv?timeframe=minute&aggregate=5`, 60 s cache) and a
 * standard-size price impact from the chain's quoter. Read-only; nothing here touches a limit, the wallet or a trade.
 *
 * Coins in the pick: the agent's positions, the 12 busiest by 15-minute activity (trades in the tail, then volume),
 * and the coins launched in the last 30 minutes. The candles are fetched for the positions and the 20 busiest by the
 * cheap signals (the tail's trades, the snapshot's own most-active list, 24 h trades) so the 15-minute ranking is
 * real; with the league's read that keeps a tick under 30 requests.
 */

export const PICK_BUSIEST = 12;
export const CANDLE_CANDIDATES = 20;
export const LAUNCH_WINDOW_MS = 30 * 60_000;
export const FLOW_WINDOW_MS = 2 * 60_000;
export const CANDLE_TTL_MS = 60_000;
/** Every Feast coin has the factory's fixed supply: 1,000,000,000 coins (`/api/v1/pools` totalSupply 1e27 wei, 2026-10-24). */
export const COIN_SUPPLY = 1_000_000_000;
/** The hook's fee, each way (hookFeeBps 100 on `/api/v1/pools`); the pool's own fee is `poolKey.fee` pips (100 = 0.01 %). */
export const HOOK_FEE = 0.01;
export const POOL_FEE = 0.0001;
export const IMPACT_SIZE_BNB = 0.01;

const MIN5 = 5 * 60_000;
const WBNB = MAINNET.contracts.wrappedNative.toLowerCase();

export type Flow = { buys: number; sells: number; buyBnb: number; sellBnb: number; netBnb: number; largestBnb: number };
export type Windows = { change: { m5: number | null; m15: number | null; h1: number | null; h24: number | null }; volume: { m5: number | null; m15: number | null; h1: number | null } };
export type CoinMeta = { type: "bnb" | "stock"; quoteSymbol: string; underlying: string | null; marketCapBnb: number | null; roundTripFeePct: number };

export type MarketMeta = { generatedAt: string | null; ageSeconds: number | null; blocksBehind: number | null; coinsTotal: number | null; coinsListed: number | null; coinsOmitted: number | null; mostActive: Address[] };

export type CoinPicture = SnapshotCoin & {
  meta: CoinMeta;
  ageMinutes: number | null;
  flow2m: Flow;
  windows: Windows | null;
  /** Price impact of a 0.01 BNB buy, %; null when not quoted this tick. */
  impactPct: number | null;
  held: boolean;
  own: boolean;
  picked: boolean;
};

export type Launch = { coin: Address; symbol: string | null; launchedAt: string; ageMinutes: number; trades: number | null; volumeBnb: number | null; holders: number | null };

export type Picture = { market: MarketMeta; coins: CoinPicture[]; launches: Launch[]; quiet: number; requests: number };

const round = (x: number | null, d = 6) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const wei = (raw: unknown) => (typeof raw === "string" && /^\d{1,80}$/.test(raw) ? BigInt(raw) : null);
const toBnb = (w: bigint, bnbPerQuote: number) => (Number(w) / 1e18) * bnbPerQuote;

/** The snapshot's word on itself: when it was made, how far behind, how many coins it has and lists, its busiest. */
export function marketMeta(snapshot: Pick<FeastSnapshot, "generatedAt" | "meta"> | null, now: number): MarketMeta {
  const m = snapshot?.meta ?? null;
  const at = snapshot?.generatedAt ?? null;
  return {
    generatedAt: at === null ? null : new Date(at).toISOString(),
    ageSeconds: at === null ? null : Math.max(0, Math.round((now - at) / 1_000)),
    blocksBehind: m?.blocksBehind ?? null,
    coinsTotal: m?.coinsTotal ?? null,
    coinsListed: m?.coinsListed ?? null,
    coinsOmitted: m?.coinsOmitted ?? null,
    mostActive: m?.mostActive ?? [],
  };
}

/**
 * The tail's trades of the last `windowMs`, per coin (lowercase): buys, sells, their BNB, the net and the largest.
 * A trade's BNB is its quote amount at the quote's BNB value (`bnbPerQuote`: 1 for WBNB; null skips the trade).
 */
export function flowFromEvents(events: Record<string, unknown>[], now: number, bnbPerQuote: (quote: string) => number | null, windowMs = FLOW_WINDOW_MS): Map<string, Flow> {
  const out = new Map<string, Flow>();
  for (const e of events) {
    if (e.type !== "trade" || typeof e.coin !== "string" || typeof e.quote !== "string") continue;
    const at = Date.parse(String(e.at));
    if (!Number.isFinite(at) || at > now || now - at > windowMs) continue;
    const q = bnbPerQuote(e.quote.toLowerCase());
    const amount = wei(e.quoteAmount);
    if (q === null || amount === null) continue;
    const bnb = toBnb(amount, q);
    const buy = e.buy === true || e.side === "buy";
    const k = e.coin.toLowerCase();
    const f = out.get(k) ?? { buys: 0, sells: 0, buyBnb: 0, sellBnb: 0, netBnb: 0, largestBnb: 0 };
    if (buy) {
      f.buys += 1;
      f.buyBnb += bnb;
    } else {
      f.sells += 1;
      f.sellBnb += bnb;
    }
    f.netBnb = f.buyBnb - f.sellBnb;
    f.largestBnb = Math.max(f.largestBnb, bnb);
    out.set(k, f);
  }
  for (const f of out.values()) for (const key of ["buyBnb", "sellBnb", "netBnb", "largestBnb"] as const) f[key] = round(f[key])!;
  return out;
}

export const emptyFlow = (): Flow => ({ buys: 0, sells: 0, buyBnb: 0, sellBnb: 0, netBnb: 0, largestBnb: 0 });

/**
 * Price change and volume over 5 min, 15 min, 1 h (and 24 h for the change) from 5-minute candles (oldest first,
 * each starting at `t`). A window's change is the newest close against the last close of a candle that ended by the
 * window's start; null when the candles do not reach back that far, or a close is missing.
 */
export function windowsFrom(rows: Candle[], now: number): Windows {
  const bars = rows.map((c) => ({ start: Date.parse(c.t), close: c.close, volume: c.volumeBnb })).filter((b) => Number.isFinite(b.start) && b.start <= now);
  const last = [...bars].reverse().find((b) => b.close !== null)?.close ?? null;
  const change = (ms: number) => {
    const then = [...bars].reverse().find((b) => b.start + MIN5 <= now - ms && b.close !== null)?.close ?? null;
    return last === null || then === null || then === 0 ? null : round(((last - then) / then) * 100, 2);
  };
  const volume = (ms: number) => (bars.length === 0 ? null : round(bars.filter((b) => b.start + MIN5 > now - ms).reduce((s, b) => s + b.volume, 0)));
  return { change: { m5: change(MIN5), m15: change(3 * MIN5), h1: change(12 * MIN5), h24: change(288 * MIN5) }, volume: { m5: volume(MIN5), m15: volume(3 * MIN5), h1: volume(12 * MIN5) } };
}

/** BNB-quoted or stock-paired; the quote spelled out; the market cap at the fixed supply; the round trip's fees. */
export function coinMeta(coin: Pick<SnapshotCoin, "quote" | "quoteSymbol" | "priceBnb">): CoinMeta {
  const q = coin.quote.toLowerCase();
  const stock = MAINNET.stocks.find((s) => s.address.toLowerCase() === q);
  const roundTrip = (1 - (1 - HOOK_FEE) ** 2 * (1 - POOL_FEE) ** 2) * 100;
  return {
    type: q === WBNB ? "bnb" : "stock",
    quoteSymbol: q === WBNB ? "WBNB" : stock?.symbol ?? coin.quoteSymbol ?? "?",
    underlying: (stock as { underlying?: string } | undefined)?.underlying ?? null,
    marketCapBnb: coin.priceBnb === null ? null : round(coin.priceBnb * COIN_SUPPLY, 4),
    roundTripFeePct: round(roundTrip, 4)!,
  };
}

/** Which coins get candles: the held ones, then the busiest by the tail's trades, the snapshot's own ranking, 24 h trades. */
export function candidates(coins: SnapshotCoin[], flow: Map<string, Flow>, mostActive: Address[], held: Set<string>, max = CANDLE_CANDIDATES): SnapshotCoin[] {
  const rank = new Map(mostActive.map((c, i) => [c.toLowerCase(), i]));
  const score = (c: SnapshotCoin) => {
    const f = flow.get(c.coin.toLowerCase());
    return [(f?.buys ?? 0) + (f?.sells ?? 0), -(rank.get(c.coin.toLowerCase()) ?? 99), c.trades24h ?? 0, c.volume24hBnb ?? 0];
  };
  const busy = coins
    .filter((c) => !held.has(c.coin.toLowerCase()))
    .sort((a, b) => {
      const [x, y] = [score(a), score(b)];
      for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i]! - x[i]!;
      return 0;
    });
  return [...coins.filter((c) => held.has(c.coin.toLowerCase())), ...busy.slice(0, max)];
}

/** The 12 busiest by 15-minute activity: the tail's trades, then the 15-minute volume, then 24 h trades. */
export function pickBusiest(coins: CoinPicture[], max = PICK_BUSIEST): CoinPicture[] {
  const trades = (c: CoinPicture) => c.flow2m.buys + c.flow2m.sells;
  return [...coins].sort((a, b) => trades(b) - trades(a) || (b.windows?.volume.m15 ?? 0) - (a.windows?.volume.m15 ?? 0) || (b.trades24h ?? 0) - (a.trades24h ?? 0)).slice(0, max);
}

export type PictureDeps = {
  now: number;
  snapshot: FeastSnapshot | null;
  /** BNB per one quote token (1 for WBNB, a stock's from its price pool); null when unknown. */
  quoteBnb: (quote: Address) => Promise<number | null>;
  /** One GET of feast.meme, as `FL data`'s `get` (counted); absent: no candles. */
  get?: (url: string) => Promise<{ status: number; body: unknown } | { error: string }>;
  site: string;
  /** Where the candles are cached (60 s); null: no cache. */
  cacheDir: string | null;
  /** A 0.01 BNB buy's price impact, %; absent: no impacts. */
  impact?: (coin: Address, bnb: number) => Promise<number | null>;
  held: Address[];
  own: Set<string>;
  /** At most this many impact quotes a tick (default 12). */
  maxImpacts?: number;
};

export async function picture(deps: PictureDeps): Promise<Picture> {
  const now = deps.now;
  const market = marketMeta(deps.snapshot, now);
  const coins = deps.snapshot ? snapshotCoins(deps.snapshot) : [];
  const held = new Set(deps.held.map((c) => c.toLowerCase()));
  // BNB per quote, read once per quote: the events are converted from the quote's amount.
  const quotes = new Map<string, number | null>();
  for (const q of new Set([...coins.map((c) => c.quote.toLowerCase()), ...(deps.snapshot?.events ?? []).map((e) => String(e.quote ?? "").toLowerCase())])) {
    if (!isAddress(q, { strict: false })) continue;
    quotes.set(q, q === WBNB ? 1 : await deps.quoteBnb(getAddress(q)).catch(() => null));
  }
  const flow = flowFromEvents(deps.snapshot?.events ?? [], now, (q) => quotes.get(q) ?? null);
  let requests = 0;
  const windowsOf = new Map<string, Windows>();
  if (deps.get) {
    for (const c of candidates(coins, flow, market.mostActive, held)) {
      const k = c.coin.toLowerCase();
      const q = quotes.get(c.quote.toLowerCase()) ?? null;
      if (q === null) continue;
      const path = deps.cacheDir ? join(deps.cacheDir, `ohlcv5-${k}.json`) : null;
      const cached = path && existsSync(path) ? readJson<{ at: number; rows: unknown[] }>(path) : null;
      let rows = cached && now - cached.at >= 0 && now - cached.at < CANDLE_TTL_MS ? cached.rows : null;
      if (!rows) {
        requests += 1;
        const got = await deps.get(`${deps.site.replace(/\/+$/, "")}/api/v1/ohlcv?coin=${k}&timeframe=minute&aggregate=5`);
        if ("error" in got || got.status !== 200 || !Array.isArray((got.body as { rows?: unknown })?.rows)) continue;
        rows = (got.body as { rows: unknown[] }).rows;
        if (path) writeJsonAtomic(path, { at: now, rows });
      }
      // In a v4 pool currency0 is the lower address: the coin is currency0 when its address sorts first.
      const bars = candles(rows, { coinIsCurrency0: k < c.quote.toLowerCase(), quoteBnbE18: BigInt(Math.round(q * 1e18)), sinceMs: now - 25 * 3_600_000 });
      windowsOf.set(k, windowsFrom(bars, now));
    }
  }
  const all: CoinPicture[] = coins.map((c) => {
    const k = c.coin.toLowerCase();
    // The snapshot leaves the price null (its index reads logs only): the quote's price at the quote's BNB value.
    const q = quotes.get(c.quote.toLowerCase()) ?? null;
    const priceBnb = c.priceBnb ?? (c.priceQuote !== null && q !== null ? c.priceQuote * q : null);
    const withPrice = { ...c, priceBnb };
    return { ...withPrice, meta: coinMeta(withPrice), ageMinutes: c.launchedAt === null ? null : Math.max(0, Math.round((now - c.launchedAt) / 60_000)), flow2m: flow.get(k) ?? emptyFlow(), windows: windowsOf.get(k) ?? null, impactPct: null, held: held.has(k), own: deps.own.has(k), picked: false };
  });
  const launches: Launch[] = all
    .filter((c) => c.launchedAt !== null && now - c.launchedAt >= 0 && now - c.launchedAt <= LAUNCH_WINDOW_MS)
    .sort((a, b) => b.launchedAt! - a.launchedAt!)
    .slice(0, 5)
    .map((c) => ({ coin: c.coin, symbol: c.symbol, launchedAt: new Date(c.launchedAt!).toISOString(), ageMinutes: c.ageMinutes ?? 0, trades: c.trades24h, volumeBnb: c.volume24hBnb, holders: c.holders }));
  const busiest = pickBusiest(all.filter((c) => !c.held));
  const picked = new Set([...all.filter((c) => c.held), ...busiest, ...all.filter((c) => launches.some((l) => l.coin === c.coin))].map((c) => c.coin.toLowerCase()));
  let quoted = 0;
  for (const c of all) {
    if (!picked.has(c.coin.toLowerCase())) continue;
    c.picked = true;
    if (deps.impact && !c.held && quoted < (deps.maxImpacts ?? PICK_BUSIEST)) {
      quoted += 1;
      c.impactPct = round(await deps.impact(c.coin, IMPACT_SIZE_BNB).catch(() => null), 3);
    }
  }
  return { market, coins: all, launches, quiet: all.length - picked.size, requests };
}
