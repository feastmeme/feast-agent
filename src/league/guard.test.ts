import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { backstopExits, type PositionMark } from "./exits.ts";
import { guard, warmupActive, warmupAfter, type BookView, type GuardInput, type Intent, type WarmupState } from "./guard.ts";
import { DEFAULT_LIMITS, bnbToWei } from "./limits.ts";

const COIN: Address = "0x00000000000000000000000000000000c0ffee01";
const NOW = 1_800_000_000_000;
const wei = (bnb: number) => bnbToWei(bnb);

const emptyBook: BookView = {
  openPositions: 0,
  hasPosition: false,
  exposureWei: 0n,
  spent24hWei: 0n,
  realizedLoss24hWei: 0n,
  trades1h: 0,
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
    walletSpentWei: 0n,
    claimFundsWei: 0n,
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

  it("L1 the size of one trade, and the minimum trade", () => {
    expect(refusedBy(input(buy(0.0201)))).toBe("L1");
    expect(refusedBy(input(buy(0.02)))).toBe("ok");
    expect(refusedBy(input(buy(0.0009)))).toBe("L1");
    expect(refusedBy(input(buy(0.006), { limits: { ...DEFAULT_LIMITS, maxTradeBnb: 0.005 } }))).toBe("L1");
    expect(refusedBy(input(buy(Number.NaN)))).toBe("L1");
    expect(refusedBy(input(buy(0.01, { bnb: undefined })))).toBe("L1");
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

  it("L4 open exposure", () => {
    expect(refusedBy(input(buy(0.02), {}, { exposureWei: wei(0.0801) }))).toBe("L4");
    expect(refusedBy(input(buy(0.02), {}, { exposureWei: wei(0.08) }))).toBe("ok");
  });

  it("L2 spend in any 24 h, buybacks from claims included", () => {
    expect(refusedBy(input(buy(0.02), {}, { spent24hWei: wei(0.0801) }))).toBe("L2");
    expect(refusedBy(input(buy(0.02), {}, { spent24hWei: wei(0.08) }))).toBe("ok");
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim" }), {}, { spent24hWei: wei(0.0801) }))).toBe("L2");
  });

  it("L3 the budget, across the wallet; a buyback paid from claims does not draw on it", () => {
    expect(refusedBy(input(buy(0.02), { walletSpentWei: wei(0.2301) }))).toBe("L3");
    expect(refusedBy(input(buy(0.02), { walletSpentWei: wei(0.23) }))).toBe("ok");
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim" }), { walletSpentWei: wei(0.25), claimFundsWei: wei(0.02) }))).toBe("ok");
  });

  it("L3 cannot be dodged by calling a buy claim-funded: only claimed proceeds actually held count, and never for a script", () => {
    // No claimed proceeds held: the label buys nothing.
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim" }), { walletSpentWei: wei(0.25) }))).toBe("L3");
    // More than the claimed proceeds held: counted against the budget.
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim" }), { walletSpentWei: wei(0.25), claimFundsWei: wei(0.0199) }))).toBe("L3");
    // A script's intent never carries the exemption, whatever it says.
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim", source: "script" }), { walletSpentWei: wei(0.25), claimFundsWei: wei(1) }))).toBe("L3");
    expect(refusedBy(input(buy(0.02, { fundedBy: "claim", source: "manual" }), { walletSpentWei: wei(0.25), claimFundsWei: wei(1) }))).toBe("L3");
  });

  it("L12 trades per hour", () => {
    expect(refusedBy(input(buy(0.01), {}, { trades1h: 12 }))).toBe("L12");
    expect(refusedBy(input(buy(0.01), {}, { trades1h: 11 }))).toBe("ok");
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
  it("L16 before L15 before L11 before L1", () => {
    const broke = { connected: false, devMode: true, quotaLeftUsd: 1_000, balanceWei: 0n };
    expect(refusedBy(input(buy(0.5), { wallet: broke, coinIsFeast: false }))).toBe("L16");
    expect(refusedBy(input(buy(0.5), { coinIsFeast: false, wallet: { ...broke, connected: true } }))).toBe("L15");
    expect(refusedBy(input(buy(0.5), { wallet: { ...broke, connected: true } }))).toBe("L11");
  });

  it("L1 before L9 before L5 before L4 before L2 before L3", () => {
    const all: Partial<BookView> = { openPositions: 5, exposureWei: wei(0.1), spent24hWei: wei(0.1) };
    expect(refusedBy(input(buy(0.03, { slippagePct: 50 }), { walletSpentWei: wei(0.25) }, all))).toBe("L1");
    expect(refusedBy(input(buy(0.01, { slippagePct: 50 }), { walletSpentWei: wei(0.25) }, all))).toBe("L9");
    expect(refusedBy(input(buy(0.01), { walletSpentWei: wei(0.25) }, all))).toBe("L5");
    expect(refusedBy(input(buy(0.01), { walletSpentWei: wei(0.25) }, { ...all, openPositions: 0 }))).toBe("L4");
    expect(refusedBy(input(buy(0.01), { walletSpentWei: wei(0.25) }, { spent24hWei: wei(0.1) }))).toBe("L2");
    expect(refusedBy(input(buy(0.01), { walletSpentWei: wei(0.25) }))).toBe("L3");
  });

  it("names the limit, its value and the figure that broke it", () => {
    const v = guard(input(buy(0.006), { limits: { ...DEFAULT_LIMITS, maxTradeBnb: 0.005 } }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/0\.006.*0\.005|0\.005.*0\.006/);
  });
});

describe("exits are never blocked by entry limits", () => {
  const everythingSpent: Partial<BookView> = {
    openPositions: 20,
    hasPosition: true,
    exposureWei: wei(5),
    spent24hWei: wei(5),
    realizedLoss24hWei: wei(5),
    trades1h: 60,
    lastEntryAt: NOW,
    paused: "3 consecutive failures",
    drawdownWei: wei(5),
  };

  it("a sale passes with every entry limit spent and no BNB above the reserve", () => {
    const poor = { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: wei(0.001) };
    expect(refusedBy(input(sell(), { wallet: poor, walletSpentWei: wei(10) }, everythingSpent))).toBe("ok");
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

  it("a launch counts against trades per hour", () => {
    const launch: Intent = { id: "l", kind: "launch", reason: "launch", source: "preset", createdAt: NOW, launch: { name: "A", symbol: "A", quote: "WBNB" } };
    expect(refusedBy(input(launch))).toBe("ok");
    expect(refusedBy(input(launch, {}, { trades1h: 12 }))).toBe("L12");
    expect(refusedBy(input(launch, { stopped: true }))).toBe("L16");
  });
});

describe("refusals outside warm-up do not halt (except L8)", () => {
  it("L1 refuses but does not halt", () => {
    const v = guard(input(buy(0.03)));
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
    const v = guard(input(buy(0.03, { source: "script" }), { warmup: fresh }));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.limit).toBe("L1");
      expect(v.halt).toBe(true);
    }
    const w = guard(input(buy(0.002, { source: "script" }), { warmup: fresh }, { trades1h: 12 }));
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
