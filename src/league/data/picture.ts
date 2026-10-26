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
export type CoinMeta = { type: "bnb" | "stock-paired"; quoteSymbol: string; underlyingTicker: string | null; marketCapBnb: number | null; openingCapBnb: number | null; /** Lane 976: whether the opening window still caps a wallet's buy; null when not known (the local path). */ openingCapBinding: boolean | null; roundTripFeePct: number };

export type MarketMeta = { generatedAt: string | null; ageSeconds: number | null; blocksBehind: number | null; coinsTotal: number | null; coinsListed: number | null; coinsOmitted: number | null; mostActive: Address[]; freshness?: Record<string, unknown> | null };

export type CoinPicture = SnapshotCoin & {
  meta: CoinMeta;
  ageMinutes: number | null;
  flow2m: Flow;
  windows: Windows | null;
  /** Price impact of a 0.01 BNB buy, %; null when not quoted this tick (the server's table, or the local quoter). */
  impactPct: number | null;
  /** The server's sale impacts by size, `[BNB, %]` ascending (addendum 6); null without the `impact` feature. */
  impactSell?: [number, number][] | null;
  /** A stock-paired coin's underlying, from the server (lane 976): its price, moves and US market hours. */
  underlying?: Underlying | null;
  /** Lane 977's measured holder shares and moves; null without the feature. */
  holdersLedger?: HoldersLedger | null;
  held: boolean;
  own: boolean;
  picked: boolean;
};

export type Launch = { coin: Address; symbol: string | null; launchedAt: string; ageMinutes: number; trades: number | null; volumeBnb: number | null; holders: number | null };

export type Picture = {
  market: MarketMeta;
  coins: CoinPicture[];
  launches: Launch[];
  quiet: number;
  /** Candle requests to feast.meme this read. */
  requests: number;
  /** Local quoter calls this read (the server's impact table spares them). */
  quotes?: number;
  /** Task 1020: BNB per quote token (lowercase), as this read valued the events (1 for WBNB; null: unknown). */
  bnbPerQuote?: Record<string, number | null>;
  /** Where each part came from: the snapshot's own field, the local computation, or neither. */
  from?: { windows: "server" | "local" | null; flow2m: "server" | "local"; impact: "server" | "local" | null; meta: "server" | "local"; launches: "server" | "local" };
};

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
    type: q === WBNB ? "bnb" : "stock-paired",
    // Only the address book's names (WBNB, the listed stocks): never the snapshot's own text for a quote it does not know.
    quoteSymbol: q === WBNB ? "WBNB" : stock?.symbol ?? "?",
    underlyingTicker: (stock as { underlying?: string } | undefined)?.underlying ?? null,
    marketCapBnb: coin.priceBnb === null ? null : round(coin.priceBnb * COIN_SUPPLY, 4),
    // The pool's opening cap needs the pools route: only the server's meta gives it.
    openingCapBnb: null,
    openingCapBinding: null,
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

// --- the server's picture (task 975, addendum 6; lane 976, lane 977): used when `features` names it -------------

/** The fields of the server's picture the runtime reads. */
export const FEATURES = ["windows", "flow2m", "impact", "meta", "underlying", "holdersLedger", "launches", "freshness", "mostActive15m"] as const;
export type Feature = (typeof FEATURES)[number];
/**
 * The snapshot's `features` as lane 976 implements them (docs/api/snapshot.md, the contract; addendum 7): six flags,
 * not the field names. `flow` gates the rows' `flow2m`, `clock` the market-hours fields of `underlying`; `meta`,
 * `underlying`'s mark and `mostActive15m` have no flag and come with the market part, which is there when any flag
 * but `freshness` is. A build whose market picture failed says `["freshness"]` alone: no server picture then.
 */
export const SNAPSHOT_FLAGS = ["windows", "flow", "impact", "launches", "freshness", "clock"] as const;
const FLAG_OF: Partial<Record<Feature, (typeof SNAPSHOT_FLAGS)[number]>> = { windows: "windows", flow2m: "flow", impact: "impact", launches: "launches", freshness: "freshness" };
const WITH_MARKET: readonly Feature[] = ["meta", "underlying", "mostActive15m"];
const marketPart = (features: readonly string[]) => features.some((f) => f !== "freshness" && (SNAPSHOT_FLAGS as readonly string[]).includes(f));
/** Whether the snapshot carries `f`: by the contract's flag, or (the fallback, addendum 6's reading) by the field's own name. */
export const hasFeature = (snapshot: Pick<FeastSnapshot, "features"> | null, f: Feature) => {
  const features = snapshot?.features ?? [];
  if (features.includes(f)) return true;
  const flag = FLAG_OF[f];
  if (flag) return features.includes(flag);
  return WITH_MARKET.includes(f) && marketPart(features);
};
/** `underlying`'s market-hours fields: under the `clock` flag (or the field-name fallback). */
const hasClock = (snapshot: Pick<FeastSnapshot, "features"> | null) => Boolean(snapshot?.features?.includes("clock") || snapshot?.features?.includes("underlying"));

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The server's `windows` in the local shape: change and volume over 5 m, 15 m, 1 h (and 24 h for the change). */
export function serverWindows(raw: unknown): Windows | null {
  const w = obj(raw);
  if (!w) return null;
  // The contract's keys ("5m", "15m", "1h", "24h"), or addendum 6's (m5, m15, h1, h24).
  const at = (k: string) => obj(w[{ m5: "5m", m15: "15m", h1: "1h", h24: "24h" }[k]!]) ?? obj(w[k]);
  return {
    change: { m5: n(at("m5")?.changePct), m15: n(at("m15")?.changePct), h1: n(at("h1")?.changePct), h24: n(at("h24")?.changePct) },
    volume: { m5: n(at("m5")?.volumeBnb), m15: n(at("m15")?.volumeBnb), h1: n(at("h1")?.volumeBnb) },
  };
}

export function serverFlow(raw: unknown): Flow | null {
  const f = obj(raw);
  if (!f) return null;
  const buyBnb = n(f.buyBnb) ?? 0;
  const sellBnb = n(f.sellBnb) ?? 0;
  return { buys: n(f.buys) ?? 0, sells: n(f.sells) ?? 0, buyBnb, sellBnb, netBnb: n(f.netBnb) ?? round(buyBnb - sellBnb)!, largestBnb: n(f.largestTradeBnb) ?? n(f.largestBnb) ?? 0 };
}

/**
 * The server's impact table, `[size BNB, impact %]` per side, sizes ascending; accepted as `{ "0.01": 1.2 }` or
 * `[{ bnb, pct }]`; a size the pool refuses (null) is left out. `asOf` is when it was quoted and `movedPct` the coin's
 * price move since (the contract re-quotes past 0.5% or 5 minutes).
 */
export type ImpactTable = { buy: [number, number][]; sell: [number, number][]; roundTripFeePct: number | null; asOf: string | null; movedPct: number | null };
export function serverImpact(raw: unknown): ImpactTable | null {
  const i = obj(raw);
  if (!i) return null;
  const side = (v: unknown): [number, number][] => {
    const pairs: [number, number][] = [];
    if (Array.isArray(v)) for (const e of v) {
      const r = obj(e);
      const size = n(r?.bnb ?? r?.sizeBnb);
      const pct = n(r?.impactPct ?? r?.pct);
      if (size !== null && pct !== null) pairs.push([size, pct]);
    }
    else if (obj(v)) for (const [k, pct] of Object.entries(obj(v)!)) if (Number.isFinite(Number(k)) && n(pct) !== null) pairs.push([Number(k), n(pct)!]);
    return pairs.sort((a, b) => a[0] - b[0]);
  };
  const asOf = typeof i.asOf === "string" && Number.isFinite(Date.parse(i.asOf)) ? new Date(Date.parse(i.asOf)).toISOString() : null;
  return { buy: side(i.buy), sell: side(i.sell), roundTripFeePct: n(i.roundTripFeePct), asOf, movedPct: n(i.movedPct) };
}

/** An impact at `size` from a table: exact, or linear between the two nearest sizes; null outside the table's sizes. */
export function interpolate(table: [number, number][], size: number): number | null {
  if (table.length === 0 || size < table[0]![0] || size > table.at(-1)![0]) return null;
  for (let k = 0; k < table.length; k += 1) {
    const [s, p] = table[k]!;
    if (s === size) return p;
    const next = table[k + 1];
    if (next && size > s && size < next[0]) return round(p + ((next[1] - p) * (size - s)) / (next[0] - s), 3);
  }
  return null;
}

export type Underlying = { priceBnb: number | null; change1hPct: number | null; change24hPct: number | null; usMarketOpen: boolean | null; nextOpenAt: string | null; nextCloseAt: string | null };
export function serverUnderlying(raw: unknown, clock = true): Underlying | null {
  const u = obj(raw);
  if (!u) return null;
  const iso = (v: unknown) => (clock && typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
  return { priceBnb: n(u.priceBnb), change1hPct: n(u.change1hPct), change24hPct: n(u.change24hPct), usMarketOpen: clock && typeof u.usMarketOpen === "boolean" ? u.usMarketOpen : null, nextOpenAt: iso(u.nextOpenAt), nextCloseAt: iso(u.nextCloseAt) };
}

/** Lane 977's ledger of holders: measured shares, server-computed. */
export type HoldersLedger = { holdersChange: { m15: number | null; h1: number | null; h24: number | null }; holdersNew1h: number | null; top1SharePct: number | null; top10SharePct: number | null; protocolSharePct: number | null; creatorSharePct: number | null; creatorInitialSharePct: number | null; creatorHeldOfInitialPct: number | null; creatorSold: boolean | null; sampledAt: string | null };
export function serverHolders(raw: unknown): HoldersLedger | null {
  const h = obj(raw);
  if (!h) return null;
  const c = obj(h.holdersChange) ?? {};
  return {
    holdersChange: { m15: n(c.m15), h1: n(c.h1), h24: n(c.h24) },
    holdersNew1h: n(h.holdersNew1h),
    top1SharePct: n(h.top1SharePct),
    top10SharePct: n(h.top10SharePct),
    protocolSharePct: n(h.protocolSharePct),
    creatorSharePct: n(h.creatorSharePct),
    creatorInitialSharePct: n(h.creatorInitialSharePct),
    creatorHeldOfInitialPct: n(h.creatorHeldOfInitialPct),
    creatorSold: typeof h.creatorSold === "boolean" ? h.creatorSold : null,
    sampledAt: typeof h.sampledAt === "string" && Number.isFinite(Date.parse(h.sampledAt)) ? new Date(Date.parse(h.sampledAt)).toISOString() : null,
  };
}

export async function picture(deps: PictureDeps): Promise<Picture> {
  const now = deps.now;
  const snap = deps.snapshot;
  const market = marketMeta(snap, now);
  const coins = snap ? snapshotCoins(snap) : [];
  const rawOf = new Map((snap?.coins ?? []).map((r) => [String(r.address ?? r.coin ?? "").toLowerCase(), r]));
  const held = new Set(deps.held.map((c) => c.toLowerCase()));
  const from: Picture["from"] = { windows: hasFeature(snap, "windows") ? "server" : deps.get ? "local" : null, flow2m: hasFeature(snap, "flow2m") ? "server" : "local", impact: hasFeature(snap, "impact") ? "server" : deps.impact ? "local" : null, meta: hasFeature(snap, "meta") ? "server" : "local", launches: hasFeature(snap, "launches") ? "server" : "local" };
  // BNB per quote, read once per quote: the events are converted from the quote's amount.
  const quotes = new Map<string, number | null>();
  for (const q of new Set([...coins.map((c) => c.quote.toLowerCase()), ...(snap?.events ?? []).map((e) => String(e.quote ?? "").toLowerCase())])) {
    if (!isAddress(q, { strict: false })) continue;
    quotes.set(q, q === WBNB ? 1 : await deps.quoteBnb(getAddress(q)).catch(() => null));
  }
  const localFlow = flowFromEvents(snap?.events ?? [], now, (q) => quotes.get(q) ?? null);
  const flowOf = (k: string) => (from.flow2m === "server" ? serverFlow(rawOf.get(k)?.flow2m) : null) ?? localFlow.get(k) ?? emptyFlow();
  const serverRanked = hasFeature(snap, "mostActive15m") && Array.isArray(snap?.server?.mostActive15m) ? snap!.server!.mostActive15m!.filter((a): a is string => typeof a === "string" && isAddress(a, { strict: false })).map((a) => getAddress(a)) : null;
  let requests = 0;
  const windowsOf = new Map<string, Windows>();
  // The server's windows when it has them: the candles are asked for nothing then.
  if (from.windows === "server") for (const [k, r] of rawOf) {
    const w = serverWindows(r.windows);
    if (w) windowsOf.set(k, w);
  }
  if (deps.get) {
    const flows = new Map(coins.map((c) => [c.coin.toLowerCase(), flowOf(c.coin.toLowerCase())]));
    for (const c of candidates(coins, flows, serverRanked ?? market.mostActive, held)) {
      const k = c.coin.toLowerCase();
      if (windowsOf.has(k)) continue;
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
    const raw = rawOf.get(k);
    // The snapshot leaves the price null (its index reads logs only): the quote's price at the quote's BNB value.
    const q = quotes.get(c.quote.toLowerCase()) ?? null;
    const priceBnb = c.priceBnb ?? (c.priceQuote !== null && q !== null ? c.priceQuote * q : null);
    const withPrice = { ...c, priceBnb };
    const local = coinMeta(withPrice);
    const sm = from.meta === "server" ? obj(raw?.meta) : null;
    const meta: CoinMeta = sm
      ? { type: sm.type === "stock-paired" || sm.type === "stock" ? "stock-paired" : "bnb", quoteSymbol: local.quoteSymbol, underlyingTicker: local.underlyingTicker, marketCapBnb: n(sm.marketCapBnb) ?? local.marketCapBnb, openingCapBnb: n(sm.openingCapBnb), openingCapBinding: typeof sm.openingCapBinding === "boolean" ? sm.openingCapBinding : null, roundTripFeePct: n(sm.roundTripFeePct) ?? local.roundTripFeePct }
      : local;
    const ageMinutes = (sm ? n(sm.ageMinutes) : null) ?? (c.launchedAt === null ? null : Math.max(0, Math.round((now - c.launchedAt) / 60_000)));
    const impact = from.impact === "server" ? serverImpact(raw?.impact) : null;
    return {
      ...withPrice,
      meta,
      ageMinutes,
      flow2m: flowOf(k),
      windows: windowsOf.get(k) ?? null,
      impactPct: impact ? interpolate(impact.buy, IMPACT_SIZE_BNB) : null,
      impactSell: impact?.sell ?? null,
      underlying: hasFeature(snap, "underlying") ? serverUnderlying(raw?.underlying, hasClock(snap)) : null,
      holdersLedger: hasFeature(snap, "holdersLedger") ? serverHolders(raw?.holdersLedger) : null,
      held: held.has(k),
      own: deps.own.has(k),
      picked: false,
    };
  });
  const serverLaunches = from.launches === "server" && Array.isArray(snap?.server?.launches)
    ? snap!.server!.launches!.flatMap((l): Launch[] => {
        const r = obj(l);
        const a = typeof r?.coin === "string" && isAddress(r.coin, { strict: false }) ? getAddress(r.coin) : typeof r?.address === "string" && isAddress(r.address, { strict: false }) ? getAddress(r.address) : null;
        const at = typeof r?.launchedAt === "string" ? Date.parse(r.launchedAt) : Number.NaN;
        if (!a || !Number.isFinite(at)) return [];
        // The contract's figures are the launch's life so far, under `firstMinutes`; addendum 6 read them flat.
        const f = obj(r!.firstMinutes) ?? r!;
        return [{ coin: a, symbol: typeof r!.symbol === "string" ? r!.symbol : null, launchedAt: new Date(at).toISOString(), ageMinutes: Math.max(0, Math.round((now - at) / 60_000)), trades: n(f.trades), volumeBnb: n(f.volumeBnb), holders: n(f.holders) }];
      }).slice(0, 5)
    : null;
  const launches: Launch[] =
    serverLaunches ??
    all
      .filter((c) => c.launchedAt !== null && now - c.launchedAt >= 0 && now - c.launchedAt <= LAUNCH_WINDOW_MS)
      .sort((a, b) => b.launchedAt! - a.launchedAt!)
      .slice(0, 5)
      .map((c) => ({ coin: c.coin, symbol: c.symbol, launchedAt: new Date(c.launchedAt!).toISOString(), ageMinutes: c.ageMinutes ?? 0, trades: c.trades24h, volumeBnb: c.volume24hBnb, holders: c.holders }));
  // The busiest by 15 minutes: the server's own ranking when it sends one, else ours.
  const pool = all.filter((c) => !c.held);
  const busiest = serverRanked ? serverRanked.map((a) => pool.find((c) => c.coin === a)).filter((c): c is CoinPicture => Boolean(c)).slice(0, PICK_BUSIEST) : pickBusiest(pool);
  const picked = new Set([...all.filter((c) => c.held), ...busiest, ...all.filter((c) => launches.some((l) => l.coin === c.coin))].map((c) => c.coin.toLowerCase()));
  let quoted = 0;
  for (const c of all) {
    if (!picked.has(c.coin.toLowerCase())) continue;
    c.picked = true;
    // The quoter only where the server gave no impact: one call less for every coin it covers.
    if (from.impact !== "server" && deps.impact && !c.held && quoted < (deps.maxImpacts ?? PICK_BUSIEST)) {
      quoted += 1;
      c.impactPct = round(await deps.impact(c.coin, IMPACT_SIZE_BNB).catch(() => null), 3);
    }
  }
  return { market: { ...market, freshness: hasFeature(snap, "freshness") ? (obj(snap?.server?.freshness) ?? null) : null }, coins: all, launches, quiet: all.length - picked.size, requests, quotes: quoted, from, bnbPerQuote: Object.fromEntries(quotes) };
}

/**
 * Each position's exit impact (addendum 6): from the server's sale-impact table when it covers the position's value
 * (interpolated between the two nearest sizes, so `exitImpactPctEstimate`), else from the local quoter (at most 10).
 */
export async function exitImpacts(positions: { coin: Address; coins: number; markBnb: number | null; costBnb: number; exitImpactPct: number | null; exitImpactPctEstimate?: number | null }[], pic: Picture | null, local?: (coin: Address, coins: bigint) => Promise<number | null>): Promise<{ estimated: number; quoted: number }> {
  let estimated = 0;
  let quoted = 0;
  for (const p of [...positions].sort((a, b) => b.costBnb - a.costBnb)) {
    const table = pic?.coins.find((c) => c.coin.toLowerCase() === p.coin.toLowerCase())?.impactSell ?? null;
    const est = table && p.markBnb !== null ? interpolate(table, p.markBnb) : null;
    if (est !== null) {
      p.exitImpactPctEstimate = est;
      estimated += 1;
    } else if (local && quoted < 10) {
      quoted += 1;
      const pct = await local(p.coin, BigInt(Math.floor(p.coins * 1e6)) * 10n ** 12n).catch(() => null);
      p.exitImpactPct = pct === null ? null : Number(pct.toFixed(3));
    }
  }
  return { estimated, quoted };
}
