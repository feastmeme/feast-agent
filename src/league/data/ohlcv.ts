import { E18, coinPriceE18 } from "../../sdk/price.ts";

/**
 * Prices as feast.meme's public API gives them, in BNB per coin (task 963).
 *
 * `/api/v1/pools` and `/api/v1/ohlcv` carry `sqrtPriceX96` strings, not prices,
 * and volumes in the quote's wei. A sqrt price is sqrt(currency1 / currency0):
 * the coin's price in its quote is the square when the coin is currency0, and
 * its inverse when the coin is currency1 — where a higher sqrt is a LOWER coin
 * price, so an hourly row's high and low swap. The quote's BNB value (1 for
 * WBNB, a stock's from its price pool) is read on the chain and passed in.
 */

export type Candle = { t: string; open: number | null; high: number | null; low: number | null; close: number | null; volumeBnb: number };

const toNumber = (value: bigint) => Number(value / E18) + Number(value % E18) / 1e18;
const sqrtOf = (raw: unknown): bigint | null => (typeof raw === "string" && /^\d{1,80}$/.test(raw) ? BigInt(raw) : typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null);

/** BNB per whole coin at a sqrt price; null for a pool with no price. Every Feast coin and quote has 18 decimals. */
export function sqrtToBnb(sqrtX96: bigint, coinIsCurrency0: boolean, quoteBnbE18: bigint): number | null {
  if (sqrtX96 <= 0n) return null;
  return toNumber((coinPriceE18(sqrtX96, coinIsCurrency0) * quoteBnbE18) / E18);
}

/** A quote-token amount in wei (a decimal string), as BNB. */
export function quoteWeiToBnb(raw: unknown, quoteBnbE18: bigint): number {
  const wei = sqrtOf(raw) ?? 0n;
  return toNumber((wei * quoteBnbE18) / E18);
}

/**
 * The hourly rows `[tsSeconds, open, high, low, close, volume]` at or after `sinceMs`, in BNB. The route
 * ignores every time filter (measured 2026-10-24), so the filter is ours.
 */
export function candles(rows: unknown, options: { coinIsCurrency0: boolean; quoteBnbE18: bigint; sinceMs: number }): Candle[] {
  if (!Array.isArray(rows)) return [];
  const out: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const seconds = Number(row[0]);
    if (!Number.isFinite(seconds) || seconds * 1_000 < options.sinceMs) continue;
    const price = (raw: unknown) => {
      const sqrt = sqrtOf(raw);
      return sqrt === null ? null : sqrtToBnb(sqrt, options.coinIsCurrency0, options.quoteBnbE18);
    };
    const [open, high, low, close] = [price(row[1]), price(row[2]), price(row[3]), price(row[4])];
    out.push({
      t: new Date(seconds * 1_000).toISOString(),
      open,
      high: options.coinIsCurrency0 ? high : low,
      low: options.coinIsCurrency0 ? low : high,
      close,
      volumeBnb: quoteWeiToBnb(row[5], options.quoteBnbE18),
    });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

/** `--since`: a duration back from now (90m, 24h, 7d) or an ISO time. */
export function parseSince(text: string, now: number): { ok: true; at: number } | { ok: false; error: string } {
  const error = "--since is a duration (90m, 24h, 7d) or an ISO time (2026-10-28T12:00:00Z)";
  const value = text.trim();
  const span = /^(\d{1,5})(m|h|d)$/.exec(value);
  if (span) {
    const ms = Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as "m" | "h" | "d"];
    return ms > 0 ? { ok: true, at: now - ms } : { ok: false, error };
  }
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return { ok: true, at };
  }
  return { ok: false, error };
}
