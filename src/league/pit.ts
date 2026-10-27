import type { Address } from "viem";

import { coinMeta, emptyFlow, IMPACT_SIZE_BNB, type CoinPicture } from "./data/picture.ts";
import { clean } from "./enter/copy.ts";
import { RECENT_WINDOW_MS } from "./feed/recent.ts";
import { plainReason } from "./feed/snapshot.ts";
import type { Pit } from "./register/site.ts";

/**
 * The league's pit (task 975, run 24): one permanent coin the page names in `GET /api/league` → `pit`, where the
 * league is asked to trade. The runtime never names it itself and never hard-codes it: it takes the page's, checks the
 * coin's quote token on chain against the page's (a mismatch is no pit, said once per process), and prices it from the
 * pool's own state and the quoter, so a pit with no trades yet still has a price and a buy's impact (the owner's
 * amendment A: a pit with "no price, no trades yet" was held off).
 */

/**
 * The pit's symbol as it is printed. Its line is the pack's first, outside the UNTRUSTED fences, so only letters and
 * digits (any script: 蛐蛐 and QUQU alike), at most 16, are printed there; anything else (a space, punctuation, a fence)
 * prints as `?`, and the address's ends still name the coin.
 */
export const pitSymbol = (symbol: string) => {
  const s = clean(symbol, 16);
  return /^[\p{L}\p{N}]{1,16}$/u.test(s) ? s : "?";
};
/** `<symbol> <0x and 4 hex>…<last 4>`: never the full address. */
export const pitLabel = (pit: Pick<Pit, "symbol" | "coin">) => `${pitSymbol(pit.symbol)} ${pit.coin.slice(0, 6)}…${pit.coin.slice(-4)}`;

/**
 * A 0.01 BNB buy's impact, as the quoter answered: a figure; or the pool's opening cap refused that size (each wallet's
 * buy is capped until its first blocks with trades have passed), with the largest smaller size that fits; or no quote.
 */
export type PitImpact = { pct: number } | { capped: true; fits: { sizeBnb: number; pct: number } | null } | { error: string };
/** What the pack says of a quote that failed for any other reason: a fixed phrase, never the quoter's own text. */
export const NO_QUOTE = "? (the quoter gave no quote)";

export type PitView = Pit & {
  label: string;
  /** BNB per coin from the pool's spot price (or the snapshot's, when the chain cannot say); null when neither can. */
  priceBnb: number | null;
  /** null when no quoter was given (a read without impacts). */
  impact: PitImpact | null;
  /** The league players' trades in the pit (yours included; a wallet with no seat is not counted) in the last 15 minutes. */
  leagueTrades15m: number;
};

export type PitChain = {
  coinInfo?(coin: Address): Promise<{ quote: Address } | null>;
  spotQuotePerCoinE18?(coin: Address): Promise<bigint>;
  quoteBnbE18(quote: Address): Promise<bigint>;
};

/** The smaller sizes tried, largest first, when the opening cap refuses 0.01 BNB. */
export const CAPPED_SIZES_BNB = [0.005, 0.002, 0.001];

const warned = new Set<string>();

/**
 * The page's pit, once the chain agrees: its coin's quote token is the page's `quote`. A mismatch is no pit, logged once
 * per process (`pit.mismatch`); a chain that cannot be read, or cannot be asked, is no pit for this read.
 */
export async function checkedPit(pit: Pit | null | undefined, chain: Pick<PitChain, "coinInfo">, log?: (event: string, data: Record<string, unknown>) => void): Promise<Pit | null> {
  if (!pit || !chain.coinInfo) return null;
  const info = await chain.coinInfo(pit.coin).catch(() => undefined);
  if (info === undefined) return null;
  if (!info || info.quote.toLowerCase() !== pit.quote.toLowerCase()) {
    const key = `${pit.coin.toLowerCase()}:${pit.quote.toLowerCase()}`;
    if (!warned.has(key)) {
      warned.add(key);
      log?.("pit.mismatch", { coin: pit.coin, named: pit.quote, onChain: info?.quote ?? null });
    }
    return null;
  }
  return pit;
}

/** The quoter's refusal by the pool's opening cap (each wallet's buy capped in its first blocks with trades). */
export const capRefusal = (reason: string) => /PurchaseCapExceeded|opening window/i.test(reason);

/** A 0.01 BNB buy's impact from the quoter; refused by the opening cap, the largest of the smaller sizes that fits. */
export async function pitImpact(coin: Address, quote: (coin: Address, bnb: number) => Promise<{ impactPct: number | null } | { error: string }>): Promise<PitImpact> {
  const first = await quote(coin, IMPACT_SIZE_BNB).catch((error: unknown) => ({ error: String((error as Error)?.message ?? error) }));
  if (!("error" in first)) return first.impactPct === null ? { error: "the quoter gave no impact" } : { pct: first.impactPct };
  // The quoter's reason goes into the pack: its first line, no URL (an RPC's key lives in its URL), at most 120.
  if (!capRefusal(first.error)) return { error: clean(plainReason(first.error), 120) };
  for (const size of CAPPED_SIZES_BNB) {
    const q = await quote(coin, size).catch(() => null);
    if (q && !("error" in q) && q.impactPct !== null) return { capped: true, fits: { sizeBnb: size, pct: q.impactPct } };
  }
  return { capped: true, fits: null };
}

/** The league's trades in one coin within `windowMs`: a trade whose payer has a seat, or is this wallet. */
export function leagueTradesIn(coin: Address, events: readonly Record<string, unknown>[], now: number, roster: Map<string, string>, self: string | null, windowMs = RECENT_WINDOW_MS): number {
  const k = coin.toLowerCase();
  let n = 0;
  for (const e of events) {
    if (e.type !== "trade" || String(e.coin ?? "").toLowerCase() !== k || typeof e.payer !== "string") continue;
    const at = Date.parse(String(e.at));
    if (!Number.isFinite(at) || at > now || now - at > windowMs) continue;
    const payer = e.payer.toLowerCase();
    if (payer === "self" || (self !== null && payer === self.toLowerCase()) || roster.has(payer)) n += 1;
  }
  return n;
}

/** The pit's price, impact and league trades, read now. */
export async function viewPit(
  pit: Pit,
  d: { chain: PitChain; snapshotPriceBnb: number | null; quote?: (coin: Address, bnb: number) => Promise<{ impactPct: number | null } | { error: string }>; events: readonly Record<string, unknown>[]; roster: Map<string, string>; self: string | null; now: number },
): Promise<PitView> {
  const spot = d.chain.spotQuotePerCoinE18
    ? await Promise.all([d.chain.spotQuotePerCoinE18(pit.coin), d.chain.quoteBnbE18(pit.quote)])
        .then(([perCoin, bnbPerQuote]) => (Number(perCoin) / 1e18) * (Number(bnbPerQuote) / 1e18))
        .catch(() => null)
    : null;
  const priceBnb = spot !== null && Number.isFinite(spot) && spot > 0 ? spot : d.snapshotPriceBnb;
  return {
    ...pit,
    label: pitLabel(pit),
    priceBnb,
    impact: d.quote ? await pitImpact(pit.coin, d.quote) : null,
    leagueTrades15m: leagueTradesIn(pit.coin, d.events, d.now, d.roster, d.self),
  };
}

/** The impact as the pack and `FL data` say it. */
export function impactText(impact: PitImpact | null): string {
  if (impact === null) return "?";
  if ("pct" in impact) return `${impact.pct}%`;
  if ("capped" in impact) return `refused: the pool's opening cap still binds each wallet's buy${impact.fits ? ` (a ${impact.fits.sizeBnb} BNB buy fits: ${impact.fits.pct}%)` : " (no smaller size quoted either)"}`;
  return NO_QUOTE;
}

/** The pit's one line, the pack's first (`id`: its coin id in that pack, when it has one). */
export function pitLine(pit: PitView | null | undefined, id: string | null): string {
  if (!pit) return "The pit: none named today.";
  const price = pit.priceBnb === null ? "?" : pit.priceBnb.toPrecision(4);
  return `The pit: ${pit.label} (${id ? `id ${id} in this pack` : "not in this pack's coins list"}; price ${price} BNB; impact of a 0.01 BNB buy ${impactText(pit.impact)}; league trades in the pit in the last 15 min: ${pit.leagueTrades15m})`;
}

/**
 * The pit's coin row when the snapshot has none (amendment B: the pit is pinned, outside the 30-minute and 15-minute
 * inclusion rules): what the chain said of it, every market figure the snapshot would give unknown.
 */
export function pitPicture(pit: PitView, held: boolean, own: boolean): CoinPicture {
  return {
    coin: pit.coin,
    name: pit.name,
    symbol: pit.symbol,
    quote: pit.quote,
    quoteSymbol: null,
    creator: null,
    metadataHash: null,
    launchedAt: null,
    priceQuote: null,
    priceBnb: pit.priceBnb,
    volume24hBnb: null,
    trades24h: null,
    lastTradeAt: null,
    holders: null,
    meta: coinMeta({ quote: pit.quote, quoteSymbol: null, priceBnb: pit.priceBnb }),
    ageMinutes: null,
    flow2m: emptyFlow(),
    windows: null,
    impactPct: pit.impact && "pct" in pit.impact ? pit.impact.pct : null,
    held,
    own,
    picked: true,
  };
}
