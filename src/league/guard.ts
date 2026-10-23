import type { Address } from "viem";

import { MIN_TRADE_BNB, WARMUP_SIZE_BNB, WARMUP_TRADES, bnbToWei, weiToBnb, type LimitId, type Limits } from "./limits.ts";

/**
 * The risk guard (PLAN.md §3, §5.4): one pure function between every strategy
 * and the executor. It sees an intent and the state around it, and answers
 * "approved, at this size" or "refused, by this limit". Nothing reaches the
 * wallet without passing here.
 *
 * The order is the plan's — L16 → L15 → L11 → L1 → L9 → L10 → L5 → L4 → L2 →
 * L3 → L12 → L13 → L7/L8/L14 (pause state) → warm-up forcing — and the first
 * refusal is the one reported. Exits are never blocked by a limit on entries: a
 * sale needs only the wallet, the stop file, a Feast coin and a sane slippage.
 */

export type IntentKind = "buy" | "sell" | "launch" | "arm" | "claim";

export type Intent = {
  id: string;
  kind: IntentKind;
  coin?: Address;
  /** A buy's size, in BNB, as the strategy asked for it. */
  bnb?: number;
  /** A sale's share of the position, 0 < fraction ≤ 1. */
  fraction?: number;
  slippagePct?: number;
  /** A buyback paid with claimed creator fees, not the wallet's BNB (does not draw on L3). */
  fundedBy?: "wallet" | "claim";
  reason: string;
  source: "preset" | "script" | "manual" | "runtime";
  createdAt: number;
  /** A buy signal goes stale: past this it is dropped, never traded late. */
  expiresAt?: number;
  launch?: { name: string; symbol: string; quote: string; description?: string; burn?: number; referrer?: number; image?: { path: string; sha256: string } };
  /** A buy paid in the pool's quote token (a buyback from claimed fees): how much of it, raw units. */
  payIn?: "native" | "quote";
  quoteAmount?: bigint;
  /** A creator claim, and what share of it to spend buying the coin back. */
  claim?: { buybackPct: number; minClaimBnb: number };
};

export type WalletState = { connected: boolean; devMode: boolean; quotaLeftUsd: number; balanceWei: bigint };

/** The figures of the book the guard needs, derived for one intent (`bookView` in book.ts). */
export type BookView = {
  openPositions: number;
  /** The wallet already holds the intent's coin (adding to it is not a new position). */
  hasPosition: boolean;
  exposureWei: bigint;
  spent24hWei: bigint;
  realizedLoss24hWei: bigint;
  trades1h: number;
  /** The last entry into the intent's coin, epoch ms. */
  lastEntryAt: number | null;
  /** Why entries are paused (L14), when they are. */
  paused: string | null;
  drawdownWei: bigint;
};

/** A script's progress through the warm-up tier, by the hash of the file it was audited as. */
export type WarmupState = { sha: string; trades: number; consecutiveFailures: number; launches: number };

export type GuardInput = {
  intent: Intent;
  limits: Limits;
  now: number;
  wallet: WalletState;
  bnbUsd: number;
  /** A stop file is present (the agent's or the global one). */
  stopped: boolean;
  /** The intent's coin was made by the Feast factory, or is FEAST: checked on chain by the caller. */
  coinIsFeast: boolean;
  book: BookView;
  /** The league's lifetime gross spend from this wallet, every agent (the ledger). */
  walletSpentWei: bigint;
  /**
   * Claimed creator fees the agent holds and has not yet spent on buybacks, BNB in
   * wei, filled by the runtime from its own receipts. A buy labelled claim-funded
   * is exempt from the budget only up to this, and never when a script asks.
   */
  claimFundsWei: bigint;
  /** The script's warm-up state; null for presets and graduated scripts. */
  warmup: WarmupState | null;
  /** A buy's price impact once it is quoted (L10); absent before quoting. */
  impactPct?: number;
};

export type GuardVerdict =
  | { ok: true; intent: Intent; sizeWei: bigint | null; forced: string | null }
  | { ok: false; limit: LimitId | "W"; message: string; halt: boolean };

export function warmupActive(w: WarmupState | null): boolean {
  return w !== null && w.trades < WARMUP_TRADES;
}

/** The warm-up state after an outcome, and the reason to halt when there is one. */
export function warmupAfter(w: WarmupState, outcome: "trade" | "failure" | "launch"): { next: WarmupState; halt: string | null } {
  if (outcome === "failure") {
    const next = { ...w, consecutiveFailures: w.consecutiveFailures + 1 };
    return { next, halt: next.consecutiveFailures >= 2 && warmupActive(w) ? "warm-up: two consecutive failures" : null };
  }
  if (outcome === "launch") return { next: { ...w, launches: w.launches + 1, consecutiveFailures: 0 }, halt: null };
  return { next: { ...w, trades: w.trades + 1, consecutiveFailures: 0 }, halt: null };
}

const bnb = (wei: bigint) => `${weiToBnb(wei)} BNB`;

export function guard(input: GuardInput): GuardVerdict {
  const { intent, limits, book, wallet } = input;
  const inWarmup = warmupActive(input.warmup);
  // In warm-up any refusal halts the script (§5.4); outside it only L8 does.
  const refuse = (limit: LimitId | "W", message: string, halt = false): GuardVerdict => ({ ok: false, limit, message, halt: halt || inWarmup });
  const approve = (approved: Intent, sizeWei: bigint | null = null, forced: string | null = null): GuardVerdict => ({
    ok: true,
    intent: approved,
    sizeWei,
    forced,
  });

  // L16: the wallet's state and the stop file.
  if (input.stopped) return refuse("L16", "a stop file is present: nothing is sent");
  if (!wallet.connected) return refuse("L16", "the wallet is not connected: sign in again");
  if (!wallet.devMode) return refuse("L16", "Developer Mode is off or has expired: turn it on in the Binance App");

  if (intent.kind === "arm" || intent.kind === "claim") {
    if (intent.coin !== undefined && !input.coinIsFeast) return refuse("L15", `${intent.coin} is not a coin the Feast factory made`);
    return approve(intent);
  }

  if (intent.kind === "launch") {
    if (book.trades1h >= limits.maxTradesPerHour) return refuse("L12", `${book.trades1h} trades in the last hour; the limit is ${limits.maxTradesPerHour}`);
    if (inWarmup && input.warmup!.launches >= 1) return refuse("W", "warm-up allows one launch, and this script has made it", true);
    return approve(intent);
  }

  // L15: only Feast coins.
  if (!intent.coin || !input.coinIsFeast) return refuse("L15", `${intent.coin ?? "no coin"} is not a coin the Feast factory made`);

  const slippage = intent.slippagePct;
  const slippageOk = typeof slippage === "number" && Number.isFinite(slippage) && slippage > 0 && slippage <= limits.maxSlippagePct;

  if (intent.kind === "sell") {
    if (!slippageOk) return refuse("L9", `a slippage bound of ${String(slippage)}% is outside 0–${limits.maxSlippagePct}%`);
    const fraction = intent.fraction ?? 1;
    if (!(fraction > 0 && fraction <= 1)) return refuse("L1", `a sale's share of the position must be above 0 and at most 1 (got ${fraction})`);
    if (inWarmup && fraction !== 1) return approve({ ...intent, fraction: 1 }, null, `warm-up: sells the whole position, not ${fraction}`);
    return approve(intent);
  }

  // A buy.
  const asked = intent.bnb;
  const sized = typeof asked === "number" && Number.isFinite(asked) && asked > 0;
  const sizeWei = sized ? bnbToWei(asked) : 0n;

  if (sized && asked * input.bnbUsd > wallet.quotaLeftUsd + 1e-9) {
    return refuse("L16", `this buy is worth $${(asked * input.bnbUsd).toFixed(2)}; Developer Mode has $${wallet.quotaLeftUsd.toFixed(2)} of today's quota left`);
  }
  // L11: the gas reserve.
  const reserve = bnbToWei(limits.gasReserveBnb);
  // A buy paid in the quote token spends no BNB but gas: only the reserve itself must be there.
  const bnbSpent = intent.payIn === "quote" ? 0n : sizeWei;
  if (sized && wallet.balanceWei - bnbSpent < reserve) {
    return refuse("L11", `buying ${bnb(sizeWei)} would leave ${bnb(wallet.balanceWei - bnbSpent > 0n ? wallet.balanceWei - bnbSpent : 0n)}; the gas reserve is ${bnb(reserve)}`);
  }
  // L1: one trade.
  if (!sized) return refuse("L1", "a buy needs a size in BNB above zero");
  if (sizeWei > bnbToWei(limits.maxTradeBnb)) return refuse("L1", `a buy of ${asked} BNB is over the per-trade limit of ${limits.maxTradeBnb} BNB`);
  if (sizeWei < bnbToWei(MIN_TRADE_BNB)) return refuse("L1", `a buy of ${asked} BNB is under the smallest trade, ${MIN_TRADE_BNB} BNB`);
  // L9, L10.
  if (!slippageOk) return refuse("L9", `a slippage bound of ${String(slippage)}% is outside 0–${limits.maxSlippagePct}%`);
  if (input.impactPct !== undefined && input.impactPct > limits.maxPriceImpactPct) {
    return refuse("L10", `this buy would move the price ${input.impactPct.toFixed(2)}%; the limit is ${limits.maxPriceImpactPct}%`);
  }
  // L5, L4, L2, L3.
  if (!book.hasPosition && book.openPositions >= limits.maxOpenPositions) {
    return refuse("L5", `${book.openPositions} positions are open; the limit is ${limits.maxOpenPositions}`);
  }
  if (book.exposureWei + sizeWei > bnbToWei(limits.maxExposureBnb)) {
    return refuse("L4", `open exposure would be ${bnb(book.exposureWei + sizeWei)}; the limit is ${limits.maxExposureBnb} BNB`);
  }
  if (book.spent24hWei + sizeWei > bnbToWei(limits.maxDailySpendBnb)) {
    return refuse("L2", `${bnb(book.spent24hWei)} spent in the last 24 h; ${asked} BNB more would pass the ${limits.maxDailySpendBnb} BNB limit`);
  }
  // The label alone exempts nothing: only claimed proceeds the runtime has recorded, and never a script's or a manual buy.
  const claimFunded = intent.fundedBy === "claim" && intent.source !== "script" && intent.source !== "manual" && sizeWei <= input.claimFundsWei;
  if (!claimFunded && input.walletSpentWei + sizeWei > bnbToWei(limits.budgetBnb)) {
    return refuse("L3", `the league has put ${bnb(input.walletSpentWei)} in from this wallet; ${asked} BNB more would pass the ${limits.budgetBnb} BNB budget`);
  }
  // L12, L13.
  if (book.trades1h >= limits.maxTradesPerHour) return refuse("L12", `${book.trades1h} trades in the last hour; the limit is ${limits.maxTradesPerHour}`);
  if (book.lastEntryAt !== null && input.now - book.lastEntryAt < limits.coinCooldownSeconds * 1_000) {
    return refuse("L13", `the last entry into this coin was ${Math.floor((input.now - book.lastEntryAt) / 1_000)} s ago; the cooldown is ${limits.coinCooldownSeconds} s`);
  }
  // The pause state: L7, L8, L14.
  if (book.realizedLoss24hWei >= bnbToWei(limits.maxDailyLossBnb)) {
    return refuse("L7", `${bnb(book.realizedLoss24hWei)} lost in the last 24 h; entries pause at ${limits.maxDailyLossBnb} BNB`);
  }
  if (book.drawdownWei >= bnbToWei(limits.maxDrawdownBnb)) {
    return refuse("L8", `the agent is ${bnb(book.drawdownWei)} below its peak; it halts at ${limits.maxDrawdownBnb} BNB`, true);
  }
  if (book.paused) return refuse("L14", `entries are paused: ${book.paused}`);

  // The warm-up tier forces the size; nothing else ever resizes a trade.
  if (inWarmup) {
    const forcedWei = bnbToWei(Math.min(WARMUP_SIZE_BNB, limits.maxTradeBnb));
    return approve(intent, forcedWei, `warm-up: ${asked} BNB → ${weiToBnb(forcedWei)} BNB`);
  }
  return approve(intent, sizeWei);
}
