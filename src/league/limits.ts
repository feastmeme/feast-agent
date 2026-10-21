/** The hard risk limits (PLAN.md §3). Stub: the implementation lands after the red tests. */
export type LimitId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9" | "L10" | "L11" | "L12" | "L13" | "L14" | "L15" | "L16";
export type Limits = {
  maxTradeBnb: number;
  maxDailySpendBnb: number;
  budgetBnb: number;
  maxExposureBnb: number;
  maxOpenPositions: number;
  backstopStopLossPct: number;
  maxDailyLossBnb: number;
  maxDrawdownBnb: number;
  maxSlippagePct: number;
  maxPriceImpactPct: number;
  gasReserveBnb: number;
  maxTradesPerHour: number;
  coinCooldownSeconds: number;
  maxConsecutiveFailures: number;
};
export type LimitKey = keyof Limits;
export type LimitSpec = { id: LimitId; key: LimitKey; label: string; default: number; min: number | LimitKey; max: number | LimitKey; integer: boolean; looser: "higher" | "lower"; unit: string; onHit: string };
export const LIMIT_SPECS: readonly LimitSpec[] = [];
export const DEFAULT_LIMITS = {} as Limits;
export const MIN_TRADE_BNB = 0;
export const WARMUP_TRADES = 0;
export const WARMUP_SIZE_BNB = 0;
export function resolveLimits(_input: unknown): { ok: true; limits: Limits } | { ok: false; errors: string[] } {
  throw new Error("not implemented");
}
export function loosenedBeyond(_next: Limits, _envelope: Limits): string[] {
  throw new Error("not implemented");
}
export function bnbToWei(_bnb: number | string): bigint {
  throw new Error("not implemented");
}
export function weiToBnb(_wei: bigint): number {
  throw new Error("not implemented");
}
