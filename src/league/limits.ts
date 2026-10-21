import { formatEther, parseEther } from "viem";

/**
 * The hard risk limits (PLAN.md §3).
 *
 * They live in the runtime and apply to every intent from every strategy:
 * presets, scripts and manual trades. A user may tighten any of them and loosen
 * it only up to its ceiling; none can be switched off — zero, a negative, an
 * empty value, NaN or Infinity is refused, never read as "no limit". Two more
 * limits are not configurable at all and live in the guard: L15 (Feast coins and
 * our own call targets only) and L16 (the wallet's state and the stop file).
 */

export type LimitId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9" | "L10" | "L11" | "L12" | "L13" | "L14" | "L15" | "L16";

export type Limits = {
  /** L1: the size of one trade, BNB. */
  maxTradeBnb: number;
  /** L2: BNB spent on buys in any 24 hours. */
  maxDailySpendBnb: number;
  /** L3: the budget, BNB the league may ever put in from this wallet (gross, every agent). */
  budgetBnb: number;
  /** L4: open exposure, the cost basis of open positions, BNB. */
  maxExposureBnb: number;
  /** L5: open positions. */
  maxOpenPositions: number;
  /** L6: the backstop stop-loss, percent below entry. */
  backstopStopLossPct: number;
  /** L7: realized loss in any 24 hours, BNB. */
  maxDailyLossBnb: number;
  /** L8: drawdown from the agent's peak equity, BNB. */
  maxDrawdownBnb: number;
  /** L9: the slippage bound a trade may carry, percent. */
  maxSlippagePct: number;
  /** L10: a buy's price impact, quote against spot, percent. */
  maxPriceImpactPct: number;
  /** L11: BNB never spent, kept for gas. */
  gasReserveBnb: number;
  /** L12: trades per hour. */
  maxTradesPerHour: number;
  /** L13: seconds between two entries into one coin. */
  coinCooldownSeconds: number;
  /** L14: consecutive failures before the agent pauses. */
  maxConsecutiveFailures: number;
};

export type LimitKey = keyof Limits;

export type LimitSpec = {
  id: LimitId;
  key: LimitKey;
  label: string;
  default: number;
  /** A number, or the key of the limit that bounds this one. */
  min: number | LimitKey;
  max: number | LimitKey;
  integer: boolean;
  /** Which way is looser: a ceiling loosens upward, a reserve or a cooldown downward. */
  looser: "higher" | "lower";
  unit: "BNB" | "%" | "s" | "";
  onHit: string;
};

export const LIMIT_SPECS: readonly LimitSpec[] = [
  { id: "L1", key: "maxTradeBnb", label: "Size of one trade", default: 0.02, min: 0.001, max: 0.25, integer: false, looser: "higher", unit: "BNB", onHit: "that trade is refused" },
  { id: "L2", key: "maxDailySpendBnb", label: "BNB spent on buys in any 24 h", default: 0.1, min: "maxTradeBnb", max: 1, integer: false, looser: "higher", unit: "BNB", onHit: "buys are refused until the window frees room" },
  { id: "L3", key: "budgetBnb", label: "Budget: BNB the league may ever put in from this wallet", default: 0.25, min: "maxDailySpendBnb", max: 10, integer: false, looser: "higher", unit: "BNB", onHit: "buys are refused; you are told the budget is used" },
  { id: "L4", key: "maxExposureBnb", label: "Open exposure (cost of open positions)", default: 0.1, min: "maxTradeBnb", max: 2, integer: false, looser: "higher", unit: "BNB", onHit: "buys are refused" },
  { id: "L5", key: "maxOpenPositions", label: "Open positions", default: 5, min: 1, max: 20, integer: true, looser: "higher", unit: "", onHit: "buys into new coins are refused" },
  { id: "L6", key: "backstopStopLossPct", label: "Backstop stop-loss per position", default: 50, min: 5, max: 90, integer: false, looser: "higher", unit: "%", onHit: "the runtime sells the position, whatever the strategy says (never the agent's own launch)" },
  { id: "L7", key: "maxDailyLossBnb", label: "Realized loss in any 24 h", default: 0.05, min: 0.001, max: 0.5, integer: false, looser: "higher", unit: "BNB", onHit: "entries pause until the loss leaves the 24 h window" },
  { id: "L8", key: "maxDrawdownBnb", label: "Drawdown from the agent's peak equity", default: 0.1, min: 0.001, max: "budgetBnb", integer: false, looser: "higher", unit: "BNB", onHit: "the agent halts and writes its stop file" },
  { id: "L9", key: "maxSlippagePct", label: "Slippage bound on a trade", default: 10, min: 0.1, max: 20, integer: false, looser: "higher", unit: "%", onHit: "a trade asking for more is refused" },
  { id: "L10", key: "maxPriceImpactPct", label: "Price impact of a buy (quote against spot)", default: 8, min: 0.5, max: 25, integer: false, looser: "higher", unit: "%", onHit: "that buy is refused" },
  { id: "L11", key: "gasReserveBnb", label: "Gas reserve: BNB never spent", default: 0.003, min: 0.001, max: 0.1, integer: false, looser: "lower", unit: "BNB", onHit: "a buy that would dip into it is refused" },
  { id: "L12", key: "maxTradesPerHour", label: "Trades per hour", default: 12, min: 1, max: 60, integer: true, looser: "higher", unit: "", onHit: "the trade is refused" },
  { id: "L13", key: "coinCooldownSeconds", label: "Cooldown between entries into one coin", default: 60, min: 15, max: 3600, integer: true, looser: "lower", unit: "s", onHit: "the buy is refused" },
  { id: "L14", key: "maxConsecutiveFailures", label: "Consecutive failures", default: 3, min: 2, max: 10, integer: true, looser: "higher", unit: "", onHit: "the agent pauses and tells you (in warm-up: two, then it stops)" },
];

export const DEFAULT_LIMITS: Limits = Object.fromEntries(LIMIT_SPECS.map((spec) => [spec.key, spec.default])) as Limits;

/** The smallest trade the league makes, and the floor of L1. */
export const MIN_TRADE_BNB = 0.001;
/** The warm-up tier: a new script's first five trades … */
export const WARMUP_TRADES = 5;
/** … at this size. */
export const WARMUP_SIZE_BNB = 0.001;

const OFF = new Set(["", "off", "none", "no", "false", "unlimited", "infinity", "-1"]);

function parseValue(spec: LimitSpec, raw: unknown): { value: number } | { error: string } {
  const name = `${spec.id} ${spec.key}`;
  if (raw === null || raw === false || raw === true) return { error: `${name} cannot be switched off (got ${String(raw)})` };
  if (typeof raw === "string") {
    const text = raw.trim().toLowerCase();
    if (OFF.has(text)) return { error: `${name} cannot be switched off (got "${raw}")` };
    if (!/^\d+(\.\d+)?$/.test(text)) return { error: `${name} must be a number (got "${raw}")` };
    raw = Number(text);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { error: `${name} must be a finite number (got ${String(raw)})` };
  if (raw <= 0) return { error: `${name} cannot be switched off: it must be above zero (got ${raw})` };
  if (spec.integer && !Number.isInteger(raw)) return { error: `${name} must be a whole number (got ${raw})` };
  return { value: raw };
}

/** Defaults filled in, every value validated: the limits a runtime may run with, or every reason it may not. */
export function resolveLimits(input: unknown): { ok: true; limits: Limits } | { ok: false; errors: string[] } {
  const given = input === undefined || input === null ? {} : input;
  if (typeof given !== "object" || Array.isArray(given)) return { ok: false, errors: ["limits must be an object of limit names to values"] };
  const errors: string[] = [];
  const known = new Set<string>(LIMIT_SPECS.map((spec) => spec.key));
  for (const key of Object.keys(given)) {
    if (!known.has(key)) errors.push(`unknown limit "${key}"; the limits are ${[...known].join(", ")}`);
  }
  const values = { ...DEFAULT_LIMITS };
  for (const spec of LIMIT_SPECS) {
    if (!(spec.key in given)) continue;
    const parsed = parseValue(spec, (given as Record<string, unknown>)[spec.key]);
    if ("error" in parsed) errors.push(parsed.error);
    else values[spec.key] = parsed.value;
  }
  if (errors.length === 0) {
    const bound = (b: number | LimitKey) => (typeof b === "number" ? b : values[b]);
    for (const spec of LIMIT_SPECS) {
      const value = values[spec.key];
      const lo = bound(spec.min);
      const hi = bound(spec.max);
      const name = `${spec.id} ${spec.key}`;
      const loName = typeof spec.min === "number" ? `${spec.min}` : `${spec.min} (${lo})`;
      const hiName = typeof spec.max === "number" ? `${spec.max}` : `${spec.max} (${hi})`;
      if (value < lo) errors.push(`${name} ${value} is below its floor ${loName}`);
      if (value > hi) errors.push(`${name} ${value} is above its ceiling ${hiName}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, limits: values };
}

/**
 * Every limit `next` loosens past the envelope the user confirmed: a later change
 * (say, the hourly review) may tighten anything, never loosen.
 */
export function loosenedBeyond(next: Limits, envelope: Limits): string[] {
  const said: string[] = [];
  for (const spec of LIMIT_SPECS) {
    const now = next[spec.key];
    const confirmed = envelope[spec.key];
    const looser = spec.looser === "higher" ? now > confirmed : now < confirmed;
    if (looser) said.push(`${spec.id} ${spec.key} ${now} is looser than the ${confirmed} you confirmed`);
  }
  return said;
}

/**
 * BNB as wei, exactly. A number is taken to the gwei (nine decimals), so binary
 * float residue never becomes wei; a decimal string is exact.
 */
export function bnbToWei(bnb: number | string): bigint {
  if (typeof bnb === "string") {
    const text = bnb.trim();
    if (!/^\d+(\.\d{1,18})?$/.test(text)) throw new RangeError(`"${bnb}" is not an amount of BNB`);
    return parseEther(text);
  }
  if (!Number.isFinite(bnb) || bnb < 0 || bnb > 1e9) throw new RangeError(`${bnb} is not an amount of BNB`);
  return BigInt(Math.round(bnb * 1e9)) * 1_000_000_000n;
}

/** Wei as BNB, for display and comparisons only. */
export function weiToBnb(wei: bigint): number {
  return Number(formatEther(wei));
}

/** The spec of one limit. */
export function specOf(id: LimitId): LimitSpec | undefined {
  return LIMIT_SPECS.find((spec) => spec.id === id);
}
