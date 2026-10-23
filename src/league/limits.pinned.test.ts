import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, LIMIT_SPECS, MIN_TRADE_BNB } from "./limits.ts";

/**
 * The hard limits as they stood when `FL enter` was added (task 961, at
 * 0ae9af5). The entry runs under these, unchanged: a change here is a change
 * to every agent's limits, and must be made on purpose, never by the entry.
 */

describe("the hard limits are unchanged (task 961)", () => {
  it("the defaults", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxTradeBnb: 0.02,
      maxDailySpendBnb: 0.1,
      budgetBnb: 0.25,
      maxExposureBnb: 0.1,
      maxOpenPositions: 5,
      backstopStopLossPct: 50,
      maxDailyLossBnb: 0.05,
      maxDrawdownBnb: 0.1,
      maxSlippagePct: 10,
      maxPriceImpactPct: 8,
      gasReserveBnb: 0.003,
      maxTradesPerHour: 12,
      coinCooldownSeconds: 60,
      maxConsecutiveFailures: 3,
    });
    expect(MIN_TRADE_BNB).toBe(0.001);
  });

  it("every row: id, key, default, min and max", () => {
    expect(LIMIT_SPECS.map((s) => [s.id, s.key, s.default, s.min, s.max])).toEqual([
      ["L1", "maxTradeBnb", 0.02, 0.001, 0.25],
      ["L2", "maxDailySpendBnb", 0.1, "maxTradeBnb", 1],
      ["L3", "budgetBnb", 0.25, "maxDailySpendBnb", 10],
      ["L4", "maxExposureBnb", 0.1, "maxTradeBnb", 2],
      ["L5", "maxOpenPositions", 5, 1, 20],
      ["L6", "backstopStopLossPct", 50, 5, 90],
      ["L7", "maxDailyLossBnb", 0.05, 0.001, 0.5],
      ["L8", "maxDrawdownBnb", 0.1, 0.001, "budgetBnb"],
      ["L9", "maxSlippagePct", 10, 0.1, 20],
      ["L10", "maxPriceImpactPct", 8, 0.5, 25],
      ["L11", "gasReserveBnb", 0.003, 0.001, 0.1],
      ["L12", "maxTradesPerHour", 12, 1, 60],
      ["L13", "coinCooldownSeconds", 60, 15, 3600],
      ["L14", "maxConsecutiveFailures", 3, 2, 10],
    ]);
  });
});
