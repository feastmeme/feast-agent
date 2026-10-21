/** Runtime exits the strategy cannot override (PLAN.md §3 L6). Stub: the implementation lands after the red tests. */
import type { Address } from "viem";

import type { Intent } from "./guard.ts";
import type { Limits } from "./limits.ts";

export type PositionMark = { coin: Address; costWei: bigint; coins: bigint; markWei: bigint | null; ownLaunch: boolean };
export function backstopExits(_positions: readonly PositionMark[], _limits: Limits, _now: number): Intent[] {
  throw new Error("not implemented");
}
