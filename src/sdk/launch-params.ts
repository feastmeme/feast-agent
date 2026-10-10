import type { Address, Hex } from "viem";

/**
 * The factory's `CreateParams`, built exactly as the feast.meme launch form builds them.
 *
 * Three numbers must agree or `create` reverts: `startTick` (a multiple of the
 * pool's tick spacing, 200), `sqrtPriceX96` (just past that tick, on the side that
 * keeps the opening position single-sided — else `SeedWouldNeedQuote()`) and
 * `liquidity` (sized so the position uses all but a sliver of the supply — else
 * `PoolTooShallow()`). The whole supply goes into the pool; a creator who wants a
 * stake buys it in the same transaction (the pre-buy).
 *
 * sqrt(1.0001)^tick is computed independently in integer arithmetic and the price
 * is nudged to the safe side of its tick by far more than any rounding difference.
 */

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;

/** floor(sqrt(10001 / 10000) * 2^128). */
export const SQRT_1_0001_Q128 = 340_299_380_613_952_818_054_172_298_683_778_356_828n;

export const TICK_SPACING = 200;
export const MAX_USABLE_TICK = 887_200;

/** Every Feast coin: one billion, 18 decimals. */
export const SUPPLY = 1_000_000_000n * 10n ** 18n;

/** Default opening valuation of the whole supply, in the quote: five shares of the stock for a bStock pair. */
export const OPENING_FDV_STOCK = 5n * 10n ** 18n;
/** Default opening valuation for a WBNB pair: two BNB. */
export const OPENING_FDV_NATIVE = 2n * 10n ** 18n;

/** Points of the 1% fee: the platform's 20 is a contract constant; the creator divides the other 80. */
export const PLATFORM_POINTS = 20;
export const CREATOR_SIDE_POINTS = 80;
export const MAX_BURN_POINTS = 30;
export const MAX_REFERRER_POINTS = 30;

/** `FeastFactory.MIN_PREBUY_VESTING`: seven days, in seconds. */
export const MIN_PREBUY_VESTING = 604_800n;

const PRICE_MARGIN = 10n ** 12n;
const LIQUIDITY_MARGIN = 10n ** 6n;

export class LaunchParamsError extends Error {
  override name = "LaunchParamsError";
}

function isqrt(value: bigint): bigint {
  if (value < 0n) throw new LaunchParamsError("square root of a negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (value / y + y) / 2n;
  }
  return x;
}

/** sqrt(1.0001^tick) in Q64.96, floored. */
export function sqrtAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick > MAX_USABLE_TICK || tick < -MAX_USABLE_TICK) {
    throw new LaunchParamsError(`tick ${tick} is outside the usable range`);
  }
  let e = BigInt(Math.abs(tick));
  let result = Q128;
  let base = SQRT_1_0001_Q128;
  while (e !== 0n) {
    if (e & 1n) result = (result * base) / Q128;
    e >>= 1n;
    if (e !== 0n) base = (base * base) / Q128;
  }
  if (tick >= 0) return result >> 32n;
  return (Q96 * Q128) / result;
}

/** The opening tick, rounded to the spacing in the direction that opens cheaper. */
export function openingTick(coinIsCurrency0: boolean, fdv: bigint, poolAmount: bigint): number {
  const target = coinIsCurrency0 ? isqrt((fdv * Q96 * Q96) / poolAmount) : isqrt((poolAmount * Q96 * Q96) / fdv);
  let lo = -(MAX_USABLE_TICK / TICK_SPACING);
  let hi = MAX_USABLE_TICK / TICK_SPACING;
  if (coinIsCurrency0) {
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (sqrtAtTick(mid * TICK_SPACING) <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo * TICK_SPACING;
  }
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (sqrtAtTick(mid * TICK_SPACING) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo * TICK_SPACING;
}

export function openingSqrtPrice(coinIsCurrency0: boolean, startTick: number): bigint {
  const s = sqrtAtTick(startTick);
  return coinIsCurrency0 ? s - s / PRICE_MARGIN - 1n : s + s / PRICE_MARGIN + 1n;
}

export function openingLiquidity(coinIsCurrency0: boolean, startTick: number, poolAmount: bigint): bigint {
  let l: bigint;
  if (coinIsCurrency0) {
    const a = sqrtAtTick(startTick);
    const b = sqrtAtTick(MAX_USABLE_TICK);
    l = (((poolAmount * a) / Q96) * b) / (b - a);
  } else {
    const a = sqrtAtTick(-MAX_USABLE_TICK);
    const b = sqrtAtTick(startTick);
    l = (poolAmount * Q96) / (b - a);
  }
  return l - (l / LIQUIDITY_MARGIN + 1n);
}

export function opening(coinIsCurrency0: boolean, fdv: bigint, poolAmount: bigint) {
  const startTick = openingTick(coinIsCurrency0, fdv, poolAmount);
  return {
    startTick,
    sqrtPriceX96: openingSqrtPrice(coinIsCurrency0, startTick),
    liquidity: openingLiquidity(coinIsCurrency0, startTick, poolAmount),
  };
}

/** The factory's `CreateParams`, field for field. */
export type CreateParams = {
  name: string;
  symbol: string;
  supply: bigint;
  quote: Address;
  creator: Address;
  selfBurnBps: number;
  referrerBps: number;
  prebuyQuoteIn: bigint;
  minCoinsOut: bigint;
  vestingDuration: bigint;
  sqrtPriceX96: bigint;
  startTick: number;
  liquidity: bigint;
  salt: Hex;
  metadataHash: Hex;
};

export type LaunchChoice = {
  name: string;
  symbol: string;
  quote: Address;
  creator: Address;
  /** Points of the 1% fee burned (bought back and burned), 0–30. */
  burn: number;
  /** Points of the 1% fee paid to whoever referred a trade, 0–30. */
  referrer: number;
  salt: Hex;
  /** sha256 digest of the pinned metadata JSON (the CIDv1 raw digest); zero means a coin with no metadata. */
  metadataHash: Hex;
  /** The whole supply's opening worth in raw quote units; absent takes the default for the quote. */
  openingValuation?: bigint;
  /** An optional creator pre-buy inside `create`; the quote is pulled from the creator. */
  prebuy?: { quoteIn: bigint; minCoinsOut: bigint; vestingDuration: bigint };
};

/** The contract's own bands, refused before anything is signed. */
export function launchBandIssue(burn: number, referrer: number): string | null {
  if (!Number.isInteger(burn) || burn < 0 || burn > MAX_BURN_POINTS) {
    return `burn must be a whole number of points between 0 and ${MAX_BURN_POINTS}`;
  }
  if (!Number.isInteger(referrer) || referrer < 0 || referrer > MAX_REFERRER_POINTS) {
    return `referrer must be a whole number of points between 0 and ${MAX_REFERRER_POINTS}`;
  }
  return null;
}

/** The valuation a launch opens at: the creator's, else the default for the quote. */
export function openingFdv(openingValuation: bigint | undefined, quote: Address, wrappedNative: Address): bigint {
  if (openingValuation !== undefined) return openingValuation;
  return quote.toLowerCase() === wrappedNative.toLowerCase() ? OPENING_FDV_NATIVE : OPENING_FDV_STOCK;
}

/**
 * Build `CreateParams`. `predictedCoin` is `factory.predictCoin(salt, name, symbol, SUPPLY)`
 * read from the chain: which side of the pool the coin sorts to decides the
 * orientation of every number here.
 */
export function createParams(choice: LaunchChoice, predictedCoin: Address, wrappedNative: Address): CreateParams {
  const issue = launchBandIssue(choice.burn, choice.referrer);
  if (issue) throw new LaunchParamsError(issue);
  if (!/^0x[0-9a-fA-F]{64}$/.test(choice.metadataHash)) {
    throw new LaunchParamsError("metadataHash must be 32 bytes of hex");
  }
  if (choice.openingValuation !== undefined && choice.openingValuation <= 0n) {
    throw new LaunchParamsError("the opening valuation must be above zero");
  }
  const coinIsCurrency0 = BigInt(predictedCoin) < BigInt(choice.quote);
  const fdv = openingFdv(choice.openingValuation, choice.quote, wrappedNative);
  const { startTick, sqrtPriceX96, liquidity } = opening(coinIsCurrency0, fdv, SUPPLY);
  const prebuy = choice.prebuy ?? { quoteIn: 0n, minCoinsOut: 0n, vestingDuration: 0n };
  if (prebuy.quoteIn < 0n || prebuy.minCoinsOut < 0n || prebuy.vestingDuration < 0n) {
    throw new LaunchParamsError("pre-buy figures cannot be negative");
  }
  if (prebuy.quoteIn === 0n && prebuy.minCoinsOut !== 0n) {
    throw new LaunchParamsError("a pre-buy bound needs a pre-buy amount");
  }
  if (prebuy.quoteIn > 0n && prebuy.vestingDuration < MIN_PREBUY_VESTING) {
    throw new LaunchParamsError("a pre-buy must vest for at least seven days");
  }
  return {
    name: choice.name,
    symbol: choice.symbol,
    supply: SUPPLY,
    quote: choice.quote,
    creator: choice.creator,
    selfBurnBps: choice.burn * 100,
    referrerBps: choice.referrer * 100,
    prebuyQuoteIn: prebuy.quoteIn,
    minCoinsOut: prebuy.minCoinsOut,
    vestingDuration: prebuy.vestingDuration,
    sqrtPriceX96,
    startTick,
    liquidity,
    salt: choice.salt,
    metadataHash: choice.metadataHash,
  };
}

/** A fresh CREATE2 salt. Random, so two launchers never collide on one address. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}
