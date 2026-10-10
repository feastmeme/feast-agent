/**
 * Prices from square-root prices, in exact integer arithmetic where it matters.
 *
 * A pool's `sqrtPriceX96` is sqrt(token1 / token0) in Q64.96. Every token this SDK
 * prices has 18 decimals (Feast coins, bStocks, WBNB and BSC's USDT), so raw and
 * whole-unit ratios are the same number.
 */

const Q192 = 1n << 192n;
export const E18 = 10n ** 18n;

/** token1 per token0, scaled by 1e18. */
export function price1Per0E18(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * E18) / Q192;
}

/** token0 per token1, scaled by 1e18. */
export function price0Per1E18(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  return (Q192 * E18) / (sqrtPriceX96 * sqrtPriceX96);
}

/** Quote per coin, scaled by 1e18, for a Feast pool in either orientation. */
export function coinPriceE18(sqrtPriceX96: bigint, coinIsCurrency0: boolean): bigint {
  return coinIsCurrency0 ? price1Per0E18(sqrtPriceX96) : price0Per1E18(sqrtPriceX96);
}

/** A 1e18-scaled figure as a JavaScript number, for display and ratios only. */
export function e18ToNumber(value: bigint): number {
  const whole = value / E18;
  const fraction = value % E18;
  return Number(whole) + Number(fraction) / 1e18;
}

/** The price of `token` in the other token of a two-token pool, as a number. */
export function priceInPool(
  sqrtPriceX96: bigint,
  token0: string,
  token: string,
): number {
  const isToken0 = token0.toLowerCase() === token.toLowerCase();
  // Floats here: a v3 price of a stock in USDT is a few hundred, well inside a double.
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const p = s * s;
  if (!(p > 0)) return 0;
  return isToken0 ? p : 1 / p;
}

/** (a − b) / b, as a fraction; null when b is not a positive number. */
export function gap(a: number, b: number): number | null {
  if (!(b > 0) || !Number.isFinite(a)) return null;
  return (a - b) / b;
}
