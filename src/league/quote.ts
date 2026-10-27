import type { Address } from "viem";

import { HOOK_FEE, POOL_FEE } from "./data/picture.ts";
import type { Executor } from "./executor.ts";
import { bnbToWei, weiToBnb } from "./limits.ts";

/**
 * A quote, and nothing else (task 975, addendum 5): what a buy of `bnb` or a sale of a held amount would get now,
 * through the executor's own preparation (`prepareBuy`, `prepareSell`), which reads the venue's quoter and the spot
 * price and builds a call that is never sent. `FL quote`, the positions' exit impact and the pack's standard-size
 * impact all come from here. No preview, no signature, no transaction: the wallet is asked nothing.
 */

export type QuoteOut = {
  side: "buy" | "sell";
  coin: Address;
  /** BNB in (a buy) or coins in (a sale, whole coins). */
  amountIn: number;
  /** Coins out (a buy, whole coins) or BNB out (a sale). */
  expectedOut: number;
  minOut: number;
  /** Against spot after the hook's fee; null when it cannot be told. */
  impactPct: number | null;
  /** The two hook fees and the two pool fees of a buy and its sale. */
  roundTripFeePct: number;
  quotedBy: "quoter" | "spot";
  slippagePct: number;
  /** Addendum 6: the call's gas at today's gas price, BNB (`eth_estimateGas`, once a quote); null when not estimated. */
  gasBnbEstimate?: number | null;
};

/** The gas a prepared call would cost now, BNB; null when it cannot be estimated (a simulation that reverts, no wallet). */
export type GasEstimator = (call: { to: Address; data: `0x${string}`; value: bigint }) => Promise<number | null>;

export const ROUND_TRIP_FEE_PCT = Number(((1 - (1 - HOOK_FEE) ** 2 * (1 - POOL_FEE) ** 2) * 100).toFixed(4));

type Prep = Pick<Executor, "prepareBuy" | "prepareSell">;
type Marks = { markWei(coin: Address, coins: bigint): Promise<bigint> };

export async function quoteBuy(executor: Prep, coin: Address, bnb: number, slippagePct = 3, gas?: GasEstimator): Promise<QuoteOut | { error: string }> {
  const prepared = await executor.prepareBuy(coin, bnbToWei(bnb), slippagePct);
  if (!prepared.ok) return { error: prepared.reason };
  const v = prepared.value;
  const gasBnbEstimate = gas && v.call ? await gas(v.call).catch(() => null) : null;
  return { side: "buy", coin, amountIn: bnb, expectedOut: weiToBnb(v.quotedOut), minOut: weiToBnb(v.minOut), impactPct: Number(v.impactPct.toFixed(3)), roundTripFeePct: ROUND_TRIP_FEE_PCT, quotedBy: "quoter", slippagePct, ...(gas ? { gasBnbEstimate } : {}) };
}

/** A sale of `coins` (wei; the executor caps it at what the wallet holds), its impact against spot after the hook's fee. */
export async function quoteSell(executor: Prep, chain: Marks, coin: Address, coins: bigint, slippagePct = 3, gas?: GasEstimator): Promise<QuoteOut | { error: string }> {
  const prepared = await executor.prepareSell(coin, coins, slippagePct);
  if (!prepared.ok) return { error: prepared.reason };
  const v = prepared.value;
  const spot = await chain.markWei(coin, v.coinsIn).catch(() => null);
  const fair = spot === null ? 0 : weiToBnb(spot) * (1 - HOOK_FEE);
  const impact = fair > 0 ? Math.max(0, (1 - weiToBnb(v.quotedOut) / fair) * 100) : null;
  const gasBnbEstimate = gas && v.call ? await gas(v.call).catch(() => null) : null;
  return { side: "sell", coin, amountIn: weiToBnb(v.coinsIn), expectedOut: weiToBnb(v.quotedOut), minOut: weiToBnb(v.minOut), impactPct: impact === null ? null : Number(impact.toFixed(3)), roundTripFeePct: ROUND_TRIP_FEE_PCT, quotedBy: v.quotedBy, slippagePct, ...(gas ? { gasBnbEstimate } : {}) };
}

/** The impact functions `picture` and `selfView` take, from one executor. */
export function impacts(executor: Prep, chain: Marks): { buy: (coin: Address, bnb: number) => Promise<number | null>; exit: (coin: Address, coins: bigint) => Promise<number | null>; buyQuote: (coin: Address, bnb: number) => Promise<QuoteOut | { error: string }> } {
  return {
    // Run 24: the pit's quote, with the quoter's reason when it refuses (the pool's opening cap).
    buyQuote: (coin, bnb) => quoteBuy(executor, coin, bnb).catch((error: unknown) => ({ error: String((error as Error)?.message ?? error) })),
    buy: async (coin, bnb) => {
      const q = await quoteBuy(executor, coin, bnb).catch(() => null);
      return q && !("error" in q) ? q.impactPct : null;
    },
    exit: async (coin, coins) => {
      const q = await quoteSell(executor, chain, coin, coins).catch(() => null);
      return q && !("error" in q) ? q.impactPct : null;
    },
  };
}
