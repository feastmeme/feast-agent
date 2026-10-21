import type { Address } from "viem";

import type { Intent } from "./guard.ts";
import type { Limits } from "./limits.ts";

/**
 * Exits the runtime makes on its own, whatever the strategy says (PLAN.md §3 L6).
 *
 * The backstop stop-loss: a position whose mark has fallen to entry × (1 − L6)
 * or below is sold whole. It never sells the agent's own launch — selling one's
 * own coin is an explicit user action — and never judges a position it has no
 * price for.
 */

export type PositionMark = {
  coin: Address;
  /** What the position cost, BNB in wei. */
  costWei: bigint;
  coins: bigint;
  /** What it is worth at spot, BNB in wei; null when no price could be read. */
  markWei: bigint | null;
  ownLaunch: boolean;
};

export function backstopExits(positions: readonly PositionMark[], limits: Limits, now: number): Intent[] {
  const keepBps = BigInt(10_000 - Math.round(limits.backstopStopLossPct * 100));
  const exits: Intent[] = [];
  for (const position of positions) {
    if (position.ownLaunch || position.markWei === null || position.costWei <= 0n || position.coins <= 0n) continue;
    const floor = (position.costWei * keepBps) / 10_000n;
    if (position.markWei > floor) continue;
    exits.push({
      id: `backstop-${position.coin.toLowerCase()}-${now}`,
      kind: "sell",
      coin: position.coin,
      fraction: 1,
      slippagePct: limits.maxSlippagePct,
      reason: `backstop stop-loss L6: the mark is at or below entry × (1 − ${limits.backstopStopLossPct}%)`,
      source: "runtime",
      createdAt: now,
    });
  }
  return exits;
}
