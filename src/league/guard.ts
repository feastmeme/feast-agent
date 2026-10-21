/** The risk guard (PLAN.md §3, §5.4). Stub: the implementation lands after the red tests. */
import type { Address } from "viem";

import type { LimitId, Limits } from "./limits.ts";

export type IntentKind = "buy" | "sell" | "launch" | "arm" | "claim";
export type Intent = {
  id: string;
  kind: IntentKind;
  coin?: Address;
  bnb?: number;
  fraction?: number;
  slippagePct?: number;
  fundedBy?: "wallet" | "claim";
  reason: string;
  source: "preset" | "script" | "manual" | "runtime";
  createdAt: number;
  expiresAt?: number;
  launch?: { name: string; symbol: string; quote: string; description?: string; burn?: number; referrer?: number };
};
export type WalletState = { connected: boolean; devMode: boolean; quotaLeftUsd: number; balanceWei: bigint };
export type BookView = {
  openPositions: number;
  hasPosition: boolean;
  exposureWei: bigint;
  spent24hWei: bigint;
  realizedLoss24hWei: bigint;
  trades1h: number;
  lastEntryAt: number | null;
  paused: string | null;
  drawdownWei: bigint;
};
export type WarmupState = { sha: string; trades: number; consecutiveFailures: number; launches: number };
export type GuardInput = {
  intent: Intent;
  limits: Limits;
  now: number;
  wallet: WalletState;
  bnbUsd: number;
  stopped: boolean;
  coinIsFeast: boolean;
  book: BookView;
  walletSpentWei: bigint;
  warmup: WarmupState | null;
  impactPct?: number;
};
export type GuardVerdict =
  | { ok: true; intent: Intent; sizeWei: bigint | null; forced: string | null }
  | { ok: false; limit: LimitId | "W"; message: string; halt: boolean };
export function guard(_input: GuardInput): GuardVerdict {
  throw new Error("not implemented");
}
export function warmupActive(_w: WarmupState | null): boolean {
  throw new Error("not implemented");
}
export function warmupAfter(_w: WarmupState, _outcome: "trade" | "failure" | "launch"): { next: WarmupState; halt: string | null } {
  throw new Error("not implemented");
}
