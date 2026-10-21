import type { Address, Hex } from "viem";

import type { BookView, WarmupState } from "./guard.ts";

/**
 * The agent's book: what it holds, what it has spent and made, and the counters
 * the guard reads. Pure updates only — every change returns a new book, built
 * from receipts the executor has already checked, never from a strategy's say-so.
 * Persisted as `state.json` (bigints as decimal strings).
 */

export type Position = {
  coin: Address;
  symbol: string;
  quote: Address;
  /** Coins held, raw units (18 decimals). */
  coins: bigint;
  /** What the coins held cost, BNB in wei (gas apart). */
  costWei: bigint;
  openedAt: number;
  /** The highest mark seen since the position opened, for trailing exits. */
  peakMarkWei: bigint;
  entries: number;
  /** Permit2 can move this coin for the router: an exit is one transaction. */
  armed: boolean;
  /** The coin this agent launched: never sold by the runtime on its own. */
  ownLaunch: boolean;
  source: string;
};

export type Book = {
  version: 1;
  positions: Record<string, Position>;
  /** Buys in the last 24 h, for L2. */
  spends: { at: number; wei: bigint; fundedBy: "wallet" | "claim" }[];
  /** Everything this agent has put in from the wallet, gross. */
  lifetimeSpentWei: bigint;
  /** Realized PnL entries in the last 24 h, for L7. */
  realized: { at: number; pnlWei: bigint }[];
  realizedTotalWei: bigint;
  gasWei: bigint;
  /** Trade times in the last hour, for L12. */
  trades: number[];
  lastEntryAt: Record<string, number>;
  failureStreak: number;
  /** Why entries are paused (L14), or null. */
  paused: string | null;
  peakEquityWei: bigint;
  lastEquityWei: bigint;
  /** Claimed creator fees not yet spent on buybacks, BNB in wei. */
  claimFundsWei: bigint;
  warmup: WarmupState | null;
  launched: { coin: Address; poolId: Hex; at: number; txHash: Hex } | null;
  /** The event stream's cursor. */
  cursor: string | null;
  /**
   * Transactions sent whose receipt has not come: kept across restarts, re-checked until they
   * resolve, and a pending buy's size counts against the spend limits meanwhile.
   */
  unresolved: Unresolved[];
  counters: { buys: number; sells: number; launches: number; claims: number; arms: number; refusals: number; failures: number };
};

export type Unresolved = {
  /** Null when the wallet's execute failed or waited for an App confirmation: it may have been sent, with no hash known. */
  txHash: Hex | null;
  kind: "buy" | "sell" | "launch" | "claim" | "arm";
  at: number;
  intentId: string;
  source: string;
  fundedBy: "wallet" | "claim";
  coin: Address;
  symbol: string;
  quote: Address;
  payIn: "native" | "quote";
  /** A buy's size, BNB in wei (or the quote paid, for a buy paid in the quote); a sale's coins. */
  sizeWei: bigint;
  /** The wallet's balance of the coin before it was sent, and the least a fill moves it by: an unknown outcome is read from these. */
  balanceBefore: bigint | null;
  minCoins: bigint;
};

const DAY = 24 * 60 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;
const key = (coin: Address) => coin.toLowerCase();

export function emptyBook(): Book {
  return {
    version: 1,
    positions: {},
    spends: [],
    lifetimeSpentWei: 0n,
    realized: [],
    realizedTotalWei: 0n,
    gasWei: 0n,
    trades: [],
    lastEntryAt: {},
    failureStreak: 0,
    paused: null,
    peakEquityWei: 0n,
    lastEquityWei: 0n,
    claimFundsWei: 0n,
    warmup: null,
    launched: null,
    cursor: null,
    unresolved: [],
    counters: { buys: 0, sells: 0, launches: 0, claims: 0, arms: 0, refusals: 0, failures: 0 },
  };
}

/** Drop window entries that have aged out. */
export function pruned(book: Book, now: number): Book {
  return {
    ...book,
    spends: book.spends.filter((s) => now - s.at < DAY),
    realized: book.realized.filter((r) => now - r.at < DAY),
    trades: book.trades.filter((t) => now - t < HOUR),
  };
}

export function positionOf(book: Book, coin: Address): Position | null {
  return book.positions[key(coin)] ?? null;
}

export type BuyFill = {
  coin: Address;
  symbol: string;
  quote: Address;
  coinsOut: bigint;
  /** What the buy cost in BNB: the native leg, or the quote paid converted to BNB for a buy paid in the quote. */
  bnbInWei: bigint;
  gasWei: bigint;
  at: number;
  fundedBy: "wallet" | "claim";
  ownLaunch: boolean;
  source: string;
};

export function recordBuy(book: Book, fill: BuyFill): Book {
  const k = key(fill.coin);
  const held = book.positions[k];
  const position: Position = held
    ? { ...held, coins: held.coins + fill.coinsOut, costWei: held.costWei + fill.bnbInWei, entries: held.entries + 1, ownLaunch: held.ownLaunch || fill.ownLaunch }
    : {
        coin: fill.coin,
        symbol: fill.symbol,
        quote: fill.quote,
        coins: fill.coinsOut,
        costWei: fill.bnbInWei,
        openedAt: fill.at,
        peakMarkWei: fill.bnbInWei,
        entries: 1,
        armed: false,
        ownLaunch: fill.ownLaunch,
        source: fill.source,
      };
  const claimSpent = fill.fundedBy === "claim" ? (fill.bnbInWei > book.claimFundsWei ? book.claimFundsWei : fill.bnbInWei) : 0n;
  return {
    ...book,
    positions: { ...book.positions, [k]: position },
    spends: [...book.spends, { at: fill.at, wei: fill.bnbInWei, fundedBy: fill.fundedBy }],
    lifetimeSpentWei: book.lifetimeSpentWei + (fill.fundedBy === "wallet" ? fill.bnbInWei : 0n),
    gasWei: book.gasWei + fill.gasWei,
    trades: [...book.trades, fill.at],
    lastEntryAt: { ...book.lastEntryAt, [k]: fill.at },
    claimFundsWei: book.claimFundsWei - claimSpent,
    failureStreak: 0,
    counters: { ...book.counters, buys: book.counters.buys + 1 },
  };
}

export type SellFill = { coin: Address; coinsIn: bigint; bnbOutWei: bigint; gasWei: bigint; at: number };

/** A sale: the cost of the coins sold leaves the position in proportion, and the difference is realized. */
export function recordSell(book: Book, fill: SellFill): Book {
  const k = key(fill.coin);
  const held = book.positions[k];
  const positions = { ...book.positions };
  let costSold = 0n;
  if (held && held.coins > 0n) {
    const coinsSold = fill.coinsIn > held.coins ? held.coins : fill.coinsIn;
    costSold = (held.costWei * coinsSold) / held.coins;
    const coinsLeft = held.coins - coinsSold;
    if (coinsLeft === 0n) delete positions[k];
    else positions[k] = { ...held, coins: coinsLeft, costWei: held.costWei - costSold };
  }
  const pnl = fill.bnbOutWei - costSold;
  return {
    ...book,
    positions,
    realized: [...book.realized, { at: fill.at, pnlWei: pnl }],
    realizedTotalWei: book.realizedTotalWei + pnl,
    gasWei: book.gasWei + fill.gasWei,
    trades: [...book.trades, fill.at],
    failureStreak: 0,
    counters: { ...book.counters, sells: book.counters.sells + 1 },
  };
}

/** A transaction that moved no position: an approval, a claim, a launch. */
export function recordGas(book: Book, gasWei: bigint, what: "arms" | "claims" | "launches"): Book {
  return { ...book, gasWei: book.gasWei + gasWei, failureStreak: 0, counters: { ...book.counters, [what]: book.counters[what] + 1 } };
}

export function recordClaim(book: Book, valueWei: bigint, gasWei: bigint): Book {
  return { ...recordGas(book, gasWei, "claims"), claimFundsWei: book.claimFundsWei + valueWei };
}

export function markArmed(book: Book, coin: Address): Book {
  const k = key(coin);
  const held = book.positions[k];
  return held ? { ...book, positions: { ...book.positions, [k]: { ...held, armed: true } } } : book;
}

/** A failure: the streak grows, and at L14 entries pause. */
export function recordFailure(book: Book, reason: string, maxConsecutiveFailures: number): Book {
  const streak = book.failureStreak + 1;
  const paused = streak >= maxConsecutiveFailures ? `${streak} consecutive failures (last: ${reason})` : book.paused;
  return { ...book, failureStreak: streak, paused, counters: { ...book.counters, failures: book.counters.failures + 1 } };
}

export function recordRefusal(book: Book): Book {
  return { ...book, counters: { ...book.counters, refusals: book.counters.refusals + 1 } };
}

/**
 * Equity: realized PnL plus every open position's mark less its cost. The peak
 * only rises; drawdown (L8) is the peak less today's equity. A position with no
 * mark counts at cost.
 */
export function withEquity(book: Book, marks: Record<string, bigint | null>): Book {
  let unrealized = 0n;
  const positions = { ...book.positions };
  for (const [k, position] of Object.entries(book.positions)) {
    const mark = marks[k];
    if (mark === undefined || mark === null) continue;
    unrealized += mark - position.costWei;
    if (mark > position.peakMarkWei) positions[k] = { ...position, peakMarkWei: mark };
  }
  const equity = book.realizedTotalWei + unrealized;
  return { ...book, positions, lastEquityWei: equity, peakEquityWei: equity > book.peakEquityWei ? equity : book.peakEquityWei };
}

/** The figures the guard needs for one intent's coin. */
/** What pending (unresolved) buys may have spent, BNB in wei: counted as spent until they resolve. */
export function pendingBuysWei(book: Book, fundedBy?: "wallet" | "claim"): bigint {
  return (book.unresolved ?? []).filter((u) => u.kind === "buy" && u.payIn === "native" && (fundedBy === undefined || u.fundedBy === fundedBy)).reduce((sum, u) => sum + u.sizeWei, 0n);
}

/** Why entries are paused: an L14 failure pause, or else a transaction whose outcome is not known yet. The two never overwrite each other. */
export function pauseReason(book: Book): string | null {
  if (book.paused) return book.paused;
  const pending = book.unresolved ?? [];
  if (pending.length === 0) return null;
  return `${pending.length} transaction(s) whose outcome is not known yet (${pending.map((u) => u.txHash ?? "no hash: the wallet's answer was lost").join(", ")})`;
}

/** The user's resume: the L14 pause and the failure streak are cleared. */
export function clearPause(book: Book): Book {
  return { ...book, paused: null, failureStreak: 0 };
}

export function bookView(book: Book, coin: Address | undefined, now: number): BookView {
  const live = pruned(book, now);
  const positions = Object.values(live.positions);
  const lossWei = live.realized.reduce((sum, r) => (r.pnlWei < 0n ? sum - r.pnlWei : sum), 0n);
  const pending = pendingBuysWei(live);
  return {
    openPositions: positions.length,
    hasPosition: coin !== undefined && live.positions[key(coin)] !== undefined,
    exposureWei: positions.reduce((sum, p) => sum + p.costWei, 0n) + pending,
    spent24hWei: live.spends.reduce((sum, s) => sum + s.wei, 0n) + pending,
    realizedLoss24hWei: lossWei,
    trades1h: live.trades.length,
    lastEntryAt: coin !== undefined ? live.lastEntryAt[key(coin)] ?? null : null,
    paused: pauseReason(live),
    drawdownWei: live.peakEquityWei > live.lastEquityWei ? live.peakEquityWei - live.lastEquityWei : 0n,
  };
}

// --- persistence ---------------------------------------------------------------------

/**
 * The fields that hold bigints. They are written as decimal strings and read back by NAME,
 * never by the look of a string — a coin whose symbol is "420n" stays text.
 */
const BIGINT_FIELDS = new Set([
  "coins",
  "costWei",
  "peakMarkWei",
  "wei",
  "lifetimeSpentWei",
  "pnlWei",
  "realizedTotalWei",
  "gasWei",
  "peakEquityWei",
  "lastEquityWei",
  "claimFundsWei",
  "sizeWei",
  "balanceBefore",
  "minCoins",
]);

/** JSON with every bigint as a decimal string, so a book survives a restart exactly. */
export function serializeBook(book: Book): string {
  return JSON.stringify(book, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export function parseBook(text: string): Book {
  // Earlier books wrote "123n"; both forms are read, for the bigint fields only.
  const parsed = JSON.parse(text, (k, v) => (BIGINT_FIELDS.has(k) && typeof v === "string" && /^-?\d+n?$/.test(v) ? BigInt(v.replace(/n$/, "")) : v)) as Book;
  if (parsed.version !== 1) throw new Error(`state.json version ${String(parsed.version)} is not one this runtime reads`);
  return { ...emptyBook(), ...parsed, unresolved: parsed.unresolved ?? [], counters: { ...emptyBook().counters, ...parsed.counters } };
}
