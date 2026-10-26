import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, LIMIT_SPECS, MIN_TRADE_BNB } from "./limits.ts";

/**
 * The hard limits as they stood when `FL enter` was added (task 961, at
 * 0ae9af5). The entry runs under these, unchanged: a change here is a change
 * to every agent's limits, and must be made on purpose, never by the entry.
 * League-v5.1.4 made one on purpose: the owner's ruling below.
 */

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

describe("the hard limits are unchanged (task 961)", () => {
  it("the defaults", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(DEFAULT_LIMITS).toEqual({
      maxAtWorkBnb: 0.15,
      maxOpenPositions: 5,
      backstopStopLossPct: 50,
      maxDailyLossBnb: 0.05,
      maxDrawdownBnb: 0.1,
      maxSlippagePct: 10,
      maxPriceImpactPct: 8,
      gasReserveBnb: 0.003,
      coinCooldownSeconds: 60,
      maxConsecutiveFailures: 3,
    });
    expect(MIN_TRADE_BNB).toBe(0.001);
  });

  it("every row: id, key, default, min and max", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(LIMIT_SPECS.map((s) => [s.id, s.key, s.default, s.min, s.max])).toEqual([
      ["L3", "maxAtWorkBnb", 0.15, 0.001, 0.15],
      ["L5", "maxOpenPositions", 5, 1, 20],
      ["L6", "backstopStopLossPct", 50, 5, 90],
      ["L7", "maxDailyLossBnb", 0.05, 0.001, 0.5],
      ["L8", "maxDrawdownBnb", 0.1, 0.001, 0.15],
      ["L9", "maxSlippagePct", 10, 0.1, 20],
      ["L10", "maxPriceImpactPct", 8, 0.5, 25],
      ["L11", "gasReserveBnb", 0.003, 0.001, 0.1],
      ["L13", "coinCooldownSeconds", 60, 15, 3600],
      ["L14", "maxConsecutiveFailures", 3, 2, 10],
    ]);
  });
});
