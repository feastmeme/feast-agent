import type { Address } from "viem";

import { MIN_TRADE_BNB, WARMUP_SIZE_BNB, WARMUP_TRADES, bnbToWei, weiToBnb, type LimitId, type Limits } from "./limits.ts";

/**
 * The risk guard (PLAN.md §3, §5.4): one pure function between every strategy
 * and the executor. It sees an intent and the state around it, and answers
 * "approved, at this size" or "refused, by this limit". Nothing reaches the
 * wallet without passing here.
 *
 * The order is the plan's — L16 → L15 → L11 → the smallest trade → L9 → L10 →
 * L5 → L3 → L13 → L7/L8/L14 (pause state) → warm-up forcing — and the first
 * refusal is the one reported. Exits are never blocked by a limit on entries: a
 * sale needs only the wallet, the stop file, a Feast coin and a sane slippage.
 *
 * The owner's ruling for league-v5.1.4: L3 is the league's cap on
 * capital at work (the cost of open positions, every agent on this wallet, at most
 * 0.15 BNB; a sale frees room), and nothing limits the size of one trade, the BNB
 * bought in 24 h or the trades in an hour (L1, L2, L12 and L4 are gone).
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
  /** A buyback paid with claimed creator fees, not the wallet's BNB. Its cost is at work like any other (L3). */
  fundedBy?: "wallet" | "claim";
  reason: string;
  /** Task 1020: the player's AI's one line on why (an answer's `why`, `--why`): the trade's public note says it. */
  why?: string;
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
  /** The cost of this agent's open positions and of its pending buys: its BNB at work (L3). */
  exposureWei: bigint;
  /** BNB bought in the last 24 h: a figure for the status, no limit reads it. */
  spent24hWei: bigint;
  realizedLoss24hWei: bigint;
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
  /** The cost of the open positions (and pending buys) in every other agent's book on this wallet: L3 is wallet-wide. */
  othersAtWorkWei: bigint;
  /** The script's warm-up state; null for presets and graduated scripts. */
  warmup: WarmupState | null;
  /** A buy's price impact once it is quoted (L10); absent before quoting. */
  impactPct?: number;
  /**
   * Run 26 (item 3, the v5.1.4 review): a launch's prepared transaction's BNB value, once prepared. A launch sends 0
   * today; one that would send BNB (a buy folded into the launch) is at work like a buy and checked against L3.
   */
  launchValueWei?: bigint;
};

export type GuardVerdict =
  | { ok: true; intent: Intent; sizeWei: bigint | null; forced: string | null }
  | { ok: false; limit: Refusal; message: string; halt: boolean };

/** What refused: a limit, the warm-up tier ("W"), or the shape of the trade itself ("size": no size, under the smallest trade, a sale's share outside 0–1). */
export type Refusal = LimitId | "W" | "size";

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
  const refuse = (limit: Refusal, message: string, halt = false): GuardVerdict => ({ ok: false, limit, message, halt: halt || inWarmup });
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
    if (inWarmup && input.warmup!.launches >= 1) return refuse("W", "warm-up allows one launch, and this script has made it", true);
    // Run 26 (item 3): a launch that sends BNB puts it at work: it must fit the cap like a buy (L3).
    const value = input.launchValueWei ?? 0n;
    if (value > 0n) {
      const atWork = book.exposureWei + input.othersAtWorkWei;
      if (atWork + value > bnbToWei(limits.maxAtWorkBnb)) return refuse("L3", `${bnb(atWork)} is at work in open positions; this launch sends ${bnb(value)} more, past the ${limits.maxAtWorkBnb} BNB cap`);
    }
    return approve(intent, value > 0n ? value : null);
  }

  // L15: only Feast coins.
  if (!intent.coin || !input.coinIsFeast) return refuse("L15", `${intent.coin ?? "no coin"} is not a coin the Feast factory made`);

  const slippage = intent.slippagePct;
  const slippageOk = typeof slippage === "number" && Number.isFinite(slippage) && slippage > 0 && slippage <= limits.maxSlippagePct;

  if (intent.kind === "sell") {
    if (!slippageOk) return refuse("L9", `a slippage bound of ${String(slippage)}% is outside 0–${limits.maxSlippagePct}%`);
    const fraction = intent.fraction ?? 1;
    if (!(fraction > 0 && fraction <= 1)) return refuse("size", `a sale's share of the position must be above 0 and at most 1 (got ${fraction})`);
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
  // The smallest trade (there is no largest but L3).
  if (!sized) return refuse("size", "a buy needs a size in BNB above zero");
  if (sizeWei < bnbToWei(MIN_TRADE_BNB)) return refuse("size", `a buy of ${asked} BNB is under the smallest trade, ${MIN_TRADE_BNB} BNB`);
  // L9, L10.
  if (!slippageOk) return refuse("L9", `a slippage bound of ${String(slippage)}% is outside 0–${limits.maxSlippagePct}%`);
  if (input.impactPct !== undefined && input.impactPct > limits.maxPriceImpactPct) {
    return refuse("L10", `this buy would move the price ${input.impactPct.toFixed(2)}%; the limit is ${limits.maxPriceImpactPct}%`);
  }
  // L5, L3.
  if (!book.hasPosition && book.openPositions >= limits.maxOpenPositions) {
    return refuse("L5", `${book.openPositions} positions are open; the limit is ${limits.maxOpenPositions}`);
  }
  const atWorkWei = book.exposureWei + input.othersAtWorkWei;
  if (atWorkWei + sizeWei > bnbToWei(limits.maxAtWorkBnb)) {
    const room = bnbToWei(limits.maxAtWorkBnb) - atWorkWei;
    return refuse("L3", `${bnb(atWorkWei)} is at work in open positions; ${asked} BNB more would pass the ${limits.maxAtWorkBnb} BNB cap (room to buy now: ${bnb(room > 0n ? room : 0n)}; a sale frees room)`);
  }
  // L13.
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
    const forcedWei = bnbToWei(WARMUP_SIZE_BNB);
    return approve(intent, forcedWei, `warm-up: ${asked} BNB → ${weiToBnb(forcedWei)} BNB`);
  }
  return approve(intent, sizeWei);
}
