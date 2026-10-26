import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { emptyBook, recordBuy, serializeBook } from "../book.ts";
import { DEFAULT_LIMITS } from "../limits.ts";
import { addToLedger, agentPaths, appendJsonl, writeFileAtomic } from "../store.ts";
import { othersAtWorkWei } from "../runtime.ts";
import { headroomOf, recentFillsOf, selfView } from "./self.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/**
 * Task 975, addendum 5: where the agent stands, from its book, its limits and its log: the headroom, the wallet's
 * spendable BNB, each position's pnl, age, peak and exit impact, the fills' slippage and gas. Made-up addresses.
 */

const NOW = Date.parse("2026-10-29T06:00:00Z");
const MIN = 60_000;
const E18 = 10n ** 18n;
const C1 = getAddress("0x00000000000000000000000000000000000c0e01");
// Synthetic: never a real wallet.
const WALLET = getAddress("0x000000000000000000000000000000000000a11c");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const bought = (at: number, wei: bigint) => recordBuy(emptyBook(), { coin: C1, symbol: "C01", quote: C1, coinsOut: 1_000n * E18, bnbInWei: wei, gasWei: 0n, at, fundedBy: "wallet", ownLaunch: false, source: "manual" });

describe("headroom", () => {
  it("the room to buy now (the cap less the BNB at work, every agent on the wallet), positions, loss, drawdown, and the cooldowns", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const book = bought(NOW - 30_000, 6n * 10n ** 15n);
    const h = headroomOf(book, DEFAULT_LIMITS, 3n * 10n ** 16n, NOW);
    expect(h).toMatchObject({ minTradeBnb: 0.001, capBnb: 0.15, atWorkBnb: 0.036, roomToBuyBnb: 0.114, exposureBnb: 0.006, openPositions: 1 });
    expect(h).not.toHaveProperty("maxTradeBnb");
    expect(h).not.toHaveProperty("leftTodayBnb");
    expect(h).not.toHaveProperty("leftSeasonBnb");
    expect(h).not.toHaveProperty("trades1h");
    expect(h.cooldowns).toEqual([{ coin: C1, until: new Date(NOW - 30_000 + DEFAULT_LIMITS.coinCooldownSeconds * 1_000).toISOString() }]);
    expect(headroomOf(book, DEFAULT_LIMITS, 0n, NOW + 10 * MIN).cooldowns).toEqual([]);
  });
});

describe("the BNB at work in the other agents' books (L3 is wallet-wide)", () => {
  it("sums the cost of their open positions; an unreadable book counts as the whole cap (fail closed)", () => {
    const h = mkdtempSync(join(tmpdir(), "feast-league-1020-atwork-"));
    dirs.push(h);
    writeFileAtomic(agentPaths(h, "one").state, serializeBook(bought(NOW, 2n * 10n ** 16n)));
    writeFileAtomic(agentPaths(h, "self").state, serializeBook(bought(NOW, 5n * 10n ** 16n)));
    expect(othersAtWorkWei(h, "self")).toBe(2n * 10n ** 16n);
    writeFileAtomic(agentPaths(h, "two").state, "{ not a book");
    expect(othersAtWorkWei(h, "self")).toBe(2n * 10n ** 16n + 15n * 10n ** 16n);
  });
});

describe("the agent's own figures", () => {
  function home() {
    const dir = mkdtempSync(join(tmpdir(), "feast-league-975-self-"));
    dirs.push(dir);
    const promptPath = join(dir, "strategy.md");
    writeFileAtomic(promptPath, "Small trades.\n");
    const planned = planAgent({ name: "demo", promptPath, preset: "steady" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const h = join(dir, "home");
    saveAgent(h, confirmAgent(planned.agent));
    return h;
  }

  it("recent fills: the quote of the same id against the fill gives the slippage; the gas in BNB", () => {
    const h = home();
    const log = (fields: Record<string, unknown>) => appendJsonl(agentPaths(h, "demo").log, { at: new Date(NOW).toISOString(), ...fields });
    log({ event: "buy.prepared", id: "b1", coin: C1, quotedOut: "1000000" });
    log({ event: "buy.filled", id: "b1", coin: C1, coinsOut: "990000", bnbInWei: "6000000000000000", gasWei: "100000000000000", txHash: `0x${"ab".repeat(32)}` });
    log({ event: "sell.prepared", id: "s1", coin: C1, quotedOut: "6000000000000000" });
    log({ event: "sell.filled", id: "s1", coin: C1, bnbOutWei: "6060000000000000", gasWei: "200000000000000" });
    const fills = recentFillsOf(h, "demo");
    expect(fills.map((f) => [f.side, f.bnb, f.slippagePct, f.gasBnb])).toEqual([
      ["buy", 0.006, 1, 0.0001],
      ["sell", 0.00606, -1, 0.0002],
    ]);
  });

  it("selfView: the wallet's spendable BNB, the headroom, and each position's pnl, age, peak and exit impact", async () => {
    const h = home();
    const book = { ...bought(NOW - 30 * MIN, 6n * 10n ** 15n) };
    const k = C1.toLowerCase();
    book.positions[k] = { ...book.positions[k]!, peakMarkWei: 9n * 10n ** 15n };
    writeFileAtomic(agentPaths(h, "demo").state, serializeBook(book));
    addToLedger(h, { at: NOW, agent: "demo", wei: 6n * 10n ** 15n, tx: "0x01" });
    const chain = { markWei: async () => 3n * 10n ** 15n, balance: async () => 5n * 10n ** 16n };
    const v = await selfView(h, "demo", { chain, now: NOW, wallet: WALLET, exitImpact: async () => 4.25 });
    expect(v.wallet).toEqual({ balanceBnb: 0.05, gasReserveBnb: DEFAULT_LIMITS.gasReserveBnb, spendableBnb: Number((0.05 - DEFAULT_LIMITS.gasReserveBnb).toFixed(6)) });
    expect(v.positions[0]).toMatchObject({ coin: C1, pnlPct: -50, ageMinutes: 30, peakPnlPct: 50, exitImpactPct: 4.25 });
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    // The ledger's lifetime 0.006 refuses nothing: the room is the cap less what is at work now.
    expect(v.headroom.roomToBuyBnb).toBe(0.144);
    expect(v.capital).toEqual({ atWorkBnb: 0.006, capBnb: 0.15, roomToBuyBnb: 0.144, spentBnb: 0.006 });
    // No wallet, no balance: nothing is guessed.
    expect((await selfView(h, "demo", { chain, now: NOW })).wallet).toBeNull();
  });
});
