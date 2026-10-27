import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { bookView, emptyBook, markArmed, parseBook, pruned, recordBuy, recordClaim, recordFailure, recordSell, serializeBook, withEquity } from "./book.ts";
import { guard } from "./guard.ts";
import { DEFAULT_LIMITS, bnbToWei } from "./limits.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

const COIN: Address = "0x00000000000000000000000000000000c0ffee01";
const QUOTE: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const T = 1_800_000_000_000;
const HOUR = 3_600_000;
const wei = bnbToWei;

const buy = (book = emptyBook(), at = T, bnb = 0.01, coins = 1_000n, fundedBy: "wallet" | "claim" = "wallet") =>
  recordBuy(book, { coin: COIN, symbol: "TEST", quote: QUOTE, coinsOut: coins, bnbInWei: wei(bnb), gasWei: 10n, at, fundedBy, ownLaunch: false, source: "preset" });

describe("the book", () => {
  it("a buy opens a position and counts toward every window", () => {
    const book = buy();
    const view = bookView(book, COIN, T + 1);
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(view).toMatchObject({ openPositions: 1, hasPosition: true, exposureWei: wei(0.01), spent24hWei: wei(0.01), lastEntryAt: T });
    expect(view).not.toHaveProperty("trades1h");
    expect(book.lifetimeSpentWei).toBe(wei(0.01));
    expect(book.gasWei).toBe(10n);
  });

  it("windows forget what has aged out", () => {
    const book = buy();
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(pruned(book, T + HOUR).trades).toEqual([]);
    expect(bookView(book, COIN, T + 24 * HOUR).spent24hWei).toBe(0n);
    // The position itself stays open.
    expect(bookView(book, COIN, T + 24 * HOUR).openPositions).toBe(1);
  });

  it("a sale realizes the difference against the cost of the coins sold, in proportion", () => {
    const half = recordSell(buy(), { coin: COIN, coinsIn: 500n, bnbOutWei: wei(0.004), gasWei: 5n, at: T + 1 });
    expect(half.positions[COIN.toLowerCase()]).toMatchObject({ coins: 500n, costWei: wei(0.005) });
    expect(half.realizedTotalWei).toBe(-wei(0.001));
    expect(bookView(half, COIN, T + 2).realizedLoss24hWei).toBe(wei(0.001));
    const all = recordSell(half, { coin: COIN, coinsIn: 500n, bnbOutWei: wei(0.007), gasWei: 5n, at: T + 3 });
    expect(all.positions[COIN.toLowerCase()]).toBeUndefined();
    expect(all.realizedTotalWei).toBe(wei(0.001));
    // A loss earlier in the window still counts toward L7 after a later gain.
    expect(bookView(all, COIN, T + 4).realizedLoss24hWei).toBe(wei(0.001));
  });

  it("only wallet-funded buys draw on the lifetime spend; claim-funded ones spend claimed proceeds", () => {
    const claimed = recordClaim(emptyBook(), wei(0.002), 1n);
    const book = buy(claimed, T, 0.002, 10n, "claim");
    expect(book.lifetimeSpentWei).toBe(0n);
    expect(book.claimFundsWei).toBe(0n);
    expect(bookView(book, COIN, T).spent24hWei).toBe(wei(0.002));
  });

  it("failures pause entries at the limit; a success resets the streak", () => {
    let book = recordFailure(emptyBook(), "preview refused", 3);
    book = recordFailure(book, "preview refused", 3);
    expect(book.paused).toBeNull();
    expect(buy(book).failureStreak).toBe(0);
    book = recordFailure(book, "reverted", 3);
    expect(book.paused).toMatch(/3 consecutive failures/);
  });

  it("equity rises with marks; drawdown is the peak less today's", () => {
    const up = withEquity(buy(), { [COIN.toLowerCase()]: wei(0.015) });
    expect(up.peakEquityWei).toBe(wei(0.005));
    const down = withEquity(up, { [COIN.toLowerCase()]: wei(0.002) });
    expect(bookView(down, COIN, T).drawdownWei).toBe(wei(0.013));
    expect(down.positions[COIN.toLowerCase()]!.peakMarkWei).toBe(wei(0.015));
  });

  it("survives a restart exactly", () => {
    const book = markArmed(buy(), COIN);
    const back = parseBook(serializeBook(book));
    expect(back).toEqual(book);
    expect(back.positions[COIN.toLowerCase()]!.armed).toBe(true);
    expect(() => parseBook(JSON.stringify({ version: 2 }))).toThrow(/version/);
  });
});

describe("the book on disk", () => {
  it("reads bigints by field name, so a coin whose symbol looks like a number stays text", () => {
    const odd = recordBuy(emptyBook(), { coin: COIN, symbol: "420n", quote: QUOTE, coinsOut: 7n, bnbInWei: 5n, gasWei: 1n, at: T, fundedBy: "wallet", ownLaunch: false, source: "preset" });
    const back = parseBook(serializeBook(odd));
    expect(back.positions[COIN.toLowerCase()]!.symbol).toBe("420n");
    expect(back.positions[COIN.toLowerCase()]!.coins).toBe(7n);
  });

  it("still reads a book written in the earlier form", () => {
    const legacy = JSON.stringify({ ...JSON.parse(serializeBook(buy())), lifetimeSpentWei: "10000000000000000n" });
    expect(parseBook(legacy).lifetimeSpentWei).toBe(wei(0.01));
  });

  it("keeps an L14 pause and a pending transaction apart: neither clears the other", async () => {
    const { pauseReason, clearPause } = await import("./book.ts");
    const paused = recordFailure(recordFailure(recordFailure(emptyBook(), "x", 3), "x", 3), "x", 3);
    const pending = { ...paused, unresolved: [{ txHash: null, kind: "sell" as const, at: T, intentId: "i", source: "runtime", fundedBy: "wallet" as const, coin: COIN, symbol: "T", quote: QUOTE, payIn: "native" as const, sizeWei: 1n, balanceBefore: 1n, minCoins: 1n }] };
    expect(pauseReason(pending)).toMatch(/consecutive failures/);
    expect(pauseReason({ ...pending, unresolved: [] })).toMatch(/consecutive failures/);
    expect(pauseReason(clearPause(pending))).toMatch(/not known yet/);
    expect(pauseReason(clearPause({ ...pending, unresolved: [] }))).toBeNull();
  });
});

describe("run 26 (item 1): a quote-paid pending buy is at work", () => {
  const COIN2 = "0x00000000000000000000000000000000c0ffee02" as Address;
  const pendingQuoteBuy = (bnbWei?: bigint) => ({ txHash: null, kind: "buy" as const, at: T, intentId: "bb", source: "preset", fundedBy: "claim" as const, coin: COIN2, symbol: "B", quote: QUOTE, payIn: "quote" as const, sizeWei: 5n * 10n ** 18n, ...(bnbWei !== undefined ? { bnbWei } : {}), balanceBefore: 0n, minCoins: 1n });

  it("counted at the BNB size the guard approved, kept across a save; against the 0.15 at-work cap a buy that would cross it is refused (L3)", () => {
    const held = recordBuy(emptyBook(), { coin: COIN, symbol: "T", quote: QUOTE, coinsOut: 1_000n, bnbInWei: bnbToWei(0.12), gasWei: 0n, at: T, fundedBy: "wallet", ownLaunch: false, source: "manual" });
    const book = parseBook(serializeBook({ ...held, unresolved: [pendingQuoteBuy(bnbToWei(0.02))] }));
    expect(book.unresolved[0]!.bnbWei).toBe(bnbToWei(0.02));
    const view = bookView(book, COIN, T);
    expect(view.exposureWei).toBe(bnbToWei(0.14));
    // The pending record pauses entries anyway; with the pause aside, the exposure alone refuses a 0.02 BNB buy.
    const verdict = guard({ intent: { id: "x", kind: "buy", coin: COIN, bnb: 0.02, slippagePct: 3, reason: "t", source: "manual", createdAt: T }, limits: DEFAULT_LIMITS, now: T, wallet: { connected: true, devMode: true, quotaLeftUsd: 1_000, balanceWei: bnbToWei(1) }, bnbUsd: 600, stopped: false, coinIsFeast: true, book: { ...view, paused: null }, othersAtWorkWei: 0n, warmup: null });
    expect(verdict.ok ? "ok" : verdict.limit).toBe("L3");
    // A record from an older runtime (no BNB size): 0, as before.
    expect(bookView({ ...held, unresolved: [pendingQuoteBuy()] }, COIN, T).exposureWei).toBe(bnbToWei(0.12));
  });
});

