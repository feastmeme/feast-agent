import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { bookView, emptyBook as emptyAgentBook, recordBuy, recordSell, type Book } from "./book.ts";
import { backstopExits, type PositionMark } from "./exits.ts";
import { guard, warmupActive, warmupAfter, type BookView, type GuardInput, type Intent, type WarmupState } from "./guard.ts";
import { DEFAULT_LIMITS, bnbToWei } from "./limits.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

const COIN: Address = "0x00000000000000000000000000000000c0ffee01";
const NOW = 1_800_000_000_000;
const wei = (bnb: number) => bnbToWei(bnb);

const emptyBook: BookView = {
  openPositions: 0,
  hasPosition: false,
  exposureWei: 0n,
  spent24hWei: 0n,
  realizedLoss24hWei: 0n,
  lastEntryAt: null,
  paused: null,
  drawdownWei: 0n,
};

function buy(bnb: number, extra: Partial<Intent> = {}): Intent {
  return { id: "i1", kind: "buy", coin: COIN, bnb, slippagePct: 3, reason: "test", source: "preset", createdAt: NOW, ...extra };
}
function sell(extra: Partial<Intent> = {}): Intent {
  return { id: "s1", kind: "sell", coin: COIN, fraction: 1, slippagePct: 3, reason: "test", source: "preset", createdAt: NOW, ...extra };
}
function input(intent: Intent, over: Partial<GuardInput> = {}, book: Partial<BookView> = {}): GuardInput {
  return {
    intent,
    limits: DEFAULT_LIMITS,
    now: NOW,
    wallet: { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: wei(1) },
    bnbUsd: 600,
    stopped: false,
    coinIsFeast: true,
    book: { ...emptyBook, ...book },
    othersAtWorkWei: 0n,
    warmup: null,
    ...over,
  };
}
const refusedBy = (i: GuardInput) => {
  const v = guard(i);
  return v.ok ? "ok" : v.limit;
};

describe("a buy within every limit", () => {
  it("is approved at the requested size", () => {
    const v = guard(input(buy(0.02)));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.sizeWei).toBe(wei(0.02));
      expect(v.forced).toBeNull();
    }
  });
});

describe("each limit refuses a buy that breaks it, at its edge", () => {
  it("L16 wallet state and the stop file", () => {
    expect(refusedBy(input(buy(0.01), { wallet: { connected: false, devMode: true, quotaLeftUsd: 1_000, balanceWei: wei(1) } }))).toBe("L16");
    expect(refusedBy(input(buy(0.01), { wallet: { connected: true, devMode: false, quotaLeftUsd: 1_000, balanceWei: wei(1) } }))).toBe("L16");
    expect(refusedBy(input(buy(0.01), { stopped: true }))).toBe("L16");
    // 0.02 BNB at $600 is $12: a quota of $11.99 left cannot carry it, $12 can.
    expect(refusedBy(input(buy(0.02), { wallet: { connected: true, devMode: true, quotaLeftUsd: 11.99, balanceWei: wei(1) } }))).toBe("L16");
    expect(refusedBy(input(buy(0.02), { wallet: { connected: true, devMode: true, quotaLeftUsd: 12, balanceWei: wei(1) } }))).toBe("ok");
  });

  it("L15 only Feast coins", () => {
    expect(refusedBy(input(buy(0.01), { coinIsFeast: false }))).toBe("L15");
    expect(refusedBy(input(buy(0.01, { coin: undefined })))).toBe("L15");
  });

  it("L11 the gas reserve stays untouched", () => {
    expect(refusedBy(input(buy(0.02), { wallet: { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: wei(0.0229) } }))).toBe("L11");
    expect(refusedBy(input(buy(0.02), { wallet: { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: wei(0.023) } }))).toBe("ok");
  });

  it("L11 a buy paid in the quote token spends no BNB: only the reserve itself must be there", () => {
    const thin = { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: wei(0.003) };
    expect(refusedBy(input(buy(0.02, { payIn: "quote", fundedBy: "claim" }), { wallet: thin }))).toBe("ok");
    expect(refusedBy(input(buy(0.02), { wallet: thin }))).toBe("L11");
    expect(refusedBy(input(buy(0.02, { payIn: "quote" }), { wallet: { ...thin, balanceWei: wei(0.0029) } }))).toBe("L11");
  });

  it("no limit on the size of one trade (L1 is gone), but the smallest trade stays", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(refusedBy(input(buy(0.0201)))).toBe("ok");
    expect(refusedBy(input(buy(0.05)))).toBe("ok");
    expect(refusedBy(input(buy(0.15)))).toBe("ok");
    expect(refusedBy(input(buy(0.0009)))).toBe("size");
    expect(refusedBy(input(buy(Number.NaN)))).toBe("size");
    expect(refusedBy(input(buy(0.01, { bnb: undefined })))).toBe("size");
  });

  it("L9 slippage", () => {
    expect(refusedBy(input(buy(0.01, { slippagePct: 10.01 })))).toBe("L9");
    expect(refusedBy(input(buy(0.01, { slippagePct: 10 })))).toBe("ok");
    expect(refusedBy(input(buy(0.01, { slippagePct: 0 })))).toBe("L9");
  });

  it("L10 price impact, once the buy is quoted", () => {
    expect(refusedBy(input(buy(0.01), { impactPct: 8.01 }))).toBe("L10");
    expect(refusedBy(input(buy(0.01), { impactPct: 8 }))).toBe("ok");
  });

  it("L5 open positions: a new coin past the count, but adding to a held coin is fine", () => {
    expect(refusedBy(input(buy(0.01), {}, { openPositions: 5 }))).toBe("L5");
    expect(refusedBy(input(buy(0.01), {}, { openPositions: 5, hasPosition: true }))).toBe("ok");
    expect(refusedBy(input(buy(0.01), {}, { openPositions: 4 }))).toBe("ok");
  });

  it("L3 the cap on BNB at work: the cost of open positions, at most 0.15 BNB", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(refusedBy(input(buy(0.02), {}, { exposureWei: wei(0.1301) }))).toBe("L3");
    expect(refusedBy(input(buy(0.02), {}, { exposureWei: wei(0.13) }))).toBe("ok");
    // An agent may set its own cap lower.
    expect(refusedBy(input(buy(0.02), { limits: { ...DEFAULT_LIMITS, maxAtWorkBnb: 0.05 } }, { exposureWei: wei(0.0301) }))).toBe("L3");
    expect(refusedBy(input(buy(0.02), { limits: { ...DEFAULT_LIMITS, maxAtWorkBnb: 0.05 } }, { exposureWei: wei(0.03) }))).toBe("ok");
  });

  it("L3 is wallet-wide: the open positions of every other agent on the wallet count", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(refusedBy(input(buy(0.02), { othersAtWorkWei: wei(0.1001) }, { exposureWei: wei(0.03) }))).toBe("L3");
    expect(refusedBy(input(buy(0.02), { othersAtWorkWei: wei(0.1) }, { exposureWei: wei(0.03) }))).toBe("ok");
  });

  it("no limit on BNB bought in 24 h (L2 is gone): only what is at work counts", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(refusedBy(input(buy(0.02), {}, { spent24hWei: wei(5) }))).toBe("ok");
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim" }), {}, { spent24hWei: wei(5) }))).toBe("ok");
  });

  it("a buyback paid from claims is at work like any other buy: the label exempts nothing from L3", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim" }), {}, { exposureWei: wei(0.1301) }))).toBe("L3");
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim", source: "script" }), {}, { exposureWei: wei(0.1301) }))).toBe("L3");
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim", source: "manual" }), {}, { exposureWei: wei(0.1301) }))).toBe("L3");
  });

  it("L13 the per-coin cooldown", () => {
    expect(refusedBy(input(buy(0.01), {}, { lastEntryAt: NOW - 59_999 }))).toBe("L13");
    expect(refusedBy(input(buy(0.01), {}, { lastEntryAt: NOW - 60_000 }))).toBe("ok");
  });

  it("L7 realized loss in 24 h pauses entries", () => {
    expect(refusedBy(input(buy(0.01), {}, { realizedLoss24hWei: wei(0.05) }))).toBe("L7");
    expect(refusedBy(input(buy(0.01), {}, { realizedLoss24hWei: wei(0.0499) }))).toBe("ok");
  });

  it("L8 drawdown halts the agent", () => {
    const v = guard(input(buy(0.01), {}, { drawdownWei: wei(0.1) }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.limit).toBe("L8");
      expect(v.halt).toBe(true);
    }
  });

  it("L14 a paused agent opens nothing", () => {
    expect(refusedBy(input(buy(0.01), {}, { paused: "3 consecutive failures" }))).toBe("L14");
  });
});

describe("the evaluation order (PLAN.md §3): the first refusal wins", () => {
  it("L16 before L15 before L11 before the smallest trade", () => {
    const broke = { connected: false, devMode: true, quotaLeftUsd: 1_000, balanceWei: 0n };
    expect(refusedBy(input(buy(0.5), { wallet: broke, coinIsFeast: false }))).toBe("L16");
    expect(refusedBy(input(buy(0.5), { coinIsFeast: false, wallet: { ...broke, connected: true } }))).toBe("L15");
    expect(refusedBy(input(buy(0.5), { wallet: { ...broke, connected: true } }))).toBe("L11");
  });

  it("the smallest trade before L9 before L5 before L3 before L13", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const all: Partial<BookView> = { openPositions: 5, exposureWei: wei(0.15), lastEntryAt: NOW };
    expect(refusedBy(input(buy(0.0005, { slippagePct: 50 }), {}, all))).toBe("size");
    expect(refusedBy(input(buy(0.01, { slippagePct: 50 }), {}, all))).toBe("L9");
    expect(refusedBy(input(buy(0.01), {}, all))).toBe("L5");
    expect(refusedBy(input(buy(0.01), {}, { ...all, openPositions: 0 }))).toBe("L3");
    expect(refusedBy(input(buy(0.01), {}, { lastEntryAt: NOW }))).toBe("L13");
  });

  it("names the limit, its value and the figure that broke it", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const v = guard(input(buy(0.006), { limits: { ...DEFAULT_LIMITS, maxAtWorkBnb: 0.005 } }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.limit).toBe("L3");
      expect(v.message).toMatch(/0\.006.*0\.005|0\.005.*0\.006/);
      expect(v.message).toContain("a sale frees room");
    }
  });
});

describe("exits are never blocked by entry limits", () => {
  const everythingSpent: Partial<BookView> = {
    openPositions: 20,
    hasPosition: true,
    exposureWei: wei(5),
    spent24hWei: wei(5),
    realizedLoss24hWei: wei(5),
    lastEntryAt: NOW,
    paused: "3 consecutive failures",
    drawdownWei: wei(5),
  };

  it("a sale passes with every entry limit spent and no BNB above the reserve", () => {
    const poor = { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: wei(0.001) };
    expect(refusedBy(input(sell(), { wallet: poor, othersAtWorkWei: wei(10) }, everythingSpent))).toBe("ok");
  });

  it("a sale still needs the wallet, Developer Mode, no stop file, a Feast coin and a sane slippage", () => {
    expect(refusedBy(input(sell(), { stopped: true }))).toBe("L16");
    expect(refusedBy(input(sell(), { wallet: { connected: true, devMode: false, quotaLeftUsd: 1_000, balanceWei: wei(1) } }))).toBe("L16");
    expect(refusedBy(input(sell(), { coinIsFeast: false }))).toBe("L15");
    expect(refusedBy(input(sell({ slippagePct: 25 })))).toBe("L9");
  });

  it("arming and claiming need only the wallet and the stop file", () => {
    const arm: Intent = { id: "a", kind: "arm", coin: COIN, reason: "arm the exit", source: "runtime", createdAt: NOW };
    const claim: Intent = { id: "c", kind: "claim", coin: COIN, reason: "claim", source: "preset", createdAt: NOW };
    expect(refusedBy(input(arm, {}, everythingSpent))).toBe("ok");
    expect(refusedBy(input(claim, {}, everythingSpent))).toBe("ok");
    expect(refusedBy(input(arm, { stopped: true }))).toBe("L16");
    expect(refusedBy(input(arm, { coinIsFeast: false }))).toBe("L15");
  });

  it("a launch counts against no trade count (L12 is gone): only the wallet and the stop file", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const launch: Intent = { id: "l", kind: "launch", reason: "launch", source: "preset", createdAt: NOW, launch: { name: "A", symbol: "A", quote: "WBNB" } };
    expect(refusedBy(input(launch))).toBe("ok");
    expect(refusedBy(input(launch, {}, everythingSpent))).toBe("ok");
    expect(refusedBy(input(launch, { stopped: true }))).toBe("L16");
  });
});

describe("refusals outside warm-up do not halt (except L8)", () => {
  it("L3 refuses but does not halt", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const v = guard(input(buy(0.03), {}, { exposureWei: wei(0.14) }));
    expect(v.ok || v.halt).toBe(false);
  });
});

describe("the warm-up tier (PLAN.md §5.4)", () => {
  const fresh: WarmupState = { sha: "abc", trades: 0, consecutiveFailures: 0, launches: 0 };

  it("is active for the first five trades", () => {
    expect(warmupActive(fresh)).toBe(true);
    expect(warmupActive({ ...fresh, trades: 4 })).toBe(true);
    expect(warmupActive({ ...fresh, trades: 5 })).toBe(false);
    expect(warmupActive(null)).toBe(false);
  });

  it("forces every buy to 0.001 BNB and says so", () => {
    const v = guard(input(buy(0.002, { source: "script" }), { warmup: fresh }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.sizeWei).toBe(wei(0.001));
      expect(v.forced).toMatch(/0\.002.*0\.001/);
    }
  });

  it("a sale in warm-up sells the whole warm-up position", () => {
    const v = guard(input(sell({ fraction: 0.4, source: "script" }), { warmup: fresh }, { hasPosition: true }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.intent.fraction).toBe(1);
  });

  it("any limit hit in warm-up halts the script", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const v = guard(input(buy(0.03, { source: "script" }), { warmup: fresh }, { exposureWei: wei(0.15) }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.limit).toBe("L3");
      expect(v.halt).toBe(true);
    }
    const w = guard(input(buy(0.002, { source: "script" }), { warmup: fresh }, { lastEntryAt: NOW }));
    expect(w.ok || w.halt).toBe(true);
  });

  it("one launch at most in warm-up; the second halts", () => {
    const launch: Intent = { id: "l", kind: "launch", reason: "launch", source: "script", createdAt: NOW, launch: { name: "A", symbol: "A", quote: "WBNB" } };
    expect(guard(input(launch, { warmup: fresh })).ok).toBe(true);
    const v = guard(input(launch, { warmup: { ...fresh, launches: 1 } }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.limit).toBe("W");
      expect(v.halt).toBe(true);
    }
  });

  it("counts trades, resets the failure streak on a success, halts on the second failure in a row", () => {
    const one = warmupAfter(fresh, "trade");
    expect(one.next.trades).toBe(1);
    expect(one.halt).toBeNull();
    const failed = warmupAfter(one.next, "failure");
    expect(failed.next.consecutiveFailures).toBe(1);
    expect(failed.halt).toBeNull();
    const recovered = warmupAfter(failed.next, "trade");
    expect(recovered.next.consecutiveFailures).toBe(0);
    const twice = warmupAfter(warmupAfter(recovered.next, "failure").next, "failure");
    expect(twice.halt).toMatch(/two consecutive failures/i);
    expect(warmupAfter(fresh, "launch").next.launches).toBe(1);
  });

  it("graduates after five clean trades: sizes are the script's again", () => {
    let w = fresh;
    for (let i = 0; i < 5; i += 1) w = warmupAfter(w, "trade").next;
    expect(warmupActive(w)).toBe(false);
    const v = guard(input(buy(0.002, { source: "script" }), { warmup: w }));
    expect(v.ok && v.sizeWei).toBe(wei(0.002));
  });
});

describe("the backstop stop-loss (L6)", () => {
  const pos = (markBnb: number | null, extra: Partial<PositionMark> = {}): PositionMark => ({
    coin: COIN,
    costWei: wei(0.01),
    coins: 1_000n,
    markWei: markBnb === null ? null : wei(markBnb),
    ownLaunch: false,
    ...extra,
  });

  it("sells the whole position at or below entry × (1 − 50 %), whatever the strategy says", () => {
    const exits = backstopExits([pos(0.005)], DEFAULT_LIMITS, NOW);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ kind: "sell", coin: COIN, fraction: 1, source: "runtime" });
    expect(exits[0]!.reason).toContain("L6");
    expect(backstopExits([pos(0.0051)], DEFAULT_LIMITS, NOW)).toHaveLength(0);
  });

  it("never sells the agent's own launch (Q3), and never judges without a price", () => {
    expect(backstopExits([pos(0, { ownLaunch: true })], DEFAULT_LIMITS, NOW)).toHaveLength(0);
    expect(backstopExits([pos(null)], DEFAULT_LIMITS, NOW)).toHaveLength(0);
  });

  it("follows a tightened limit", () => {
    expect(backstopExits([pos(0.008)], { ...DEFAULT_LIMITS, backstopStopLossPct: 20 }, NOW)).toHaveLength(1);
  });
});

describe("the cap on capital at work, with a real book (league-v5.1.4)", () => {
  // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
  const coin = (n: number) => `0x00000000000000000000000000000000c0ffee${String(n).padStart(2, "0")}` as Address;
  const bought = (book: Book, c: Address, bnb: number, at: number) =>
    recordBuy(book, { coin: c, symbol: "C", quote: COIN, coinsOut: wei(bnb) * 1_000n, bnbInWei: wei(bnb), gasWei: 0n, at, fundedBy: "wallet", ownLaunch: false, source: "manual" });
  const sold = (book: Book, c: Address, share: bigint, at: number) => {
    const held = book.positions[c.toLowerCase()]!;
    return recordSell(book, { coin: c, coinsIn: (held.coins * share) / 100n, bnbOutWei: (held.costWei * share) / 100n, gasWei: 0n, at });
  };
  const verdictOn = (book: Book, c: Address, bnb: number, at: number) => guard(input(buy(bnb, { coin: c }), { now: at }, bookView(book, c, at)));

  it("a sale frees room, and the next buy is accepted", () => {
    let book = bought(emptyAgentBook(), coin(1), 0.15, NOW);
    const full = verdictOn(book, coin(2), 0.01, NOW + 120_000);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.limit).toBe("L3");
    book = sold(book, coin(1), 50n, NOW + 180_000);
    expect(verdictOn(book, coin(2), 0.05, NOW + 240_000).ok).toBe(true);
    expect(verdictOn(book, coin(2), 0.0751, NOW + 240_000).ok).toBe(false);
  });

  it("a buy that pushes the cost of open positions over 0.15 BNB is refused", () => {
    const book = bought(bought(emptyAgentBook(), coin(1), 0.07, NOW), coin(2), 0.05, NOW + 1_000);
    const over = verdictOn(book, coin(3), 0.0301, NOW + 120_000);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.limit).toBe("L3");
      expect(over.message).toMatch(/0\.12 BNB is at work/);
    }
    expect(verdictOn(book, coin(3), 0.03, NOW + 120_000).ok).toBe(true);
  });

  it("a single 0.05 BNB buy, and 20 trades within an hour, are accepted while under the cap", () => {
    expect(verdictOn(emptyAgentBook(), coin(1), 0.05, NOW).ok).toBe(true);
    let book = emptyAgentBook();
    let trades = 0;
    for (let i = 0; i < 10; i += 1) {
      // Ten round trips across five coins, every entry past L13's cooldown: twenty trades in under an hour.
      const c = coin(i % 5);
      const at = NOW + i * 5 * 60_000;
      const v = verdictOn(book, c, 0.01, at);
      expect(v.ok, `buy ${i}`).toBe(true);
      book = bought(book, c, 0.01, at);
      book = sold(book, c, 100n, at + 30_000);
      trades += 2;
    }
    expect(trades).toBe(20);
    expect(book.trades.filter((t) => t > NOW + 50 * 60_000 - 60 * 60_000).length).toBe(20);
    expect(verdictOn(book, coin(9), 0.05, NOW + 50 * 60_000).ok).toBe(true);
  });
});
