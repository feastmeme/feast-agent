import { describe, expect, it } from "vitest";

import { opening, OPENING_FDV_STOCK, SUPPLY } from "./launch-params.ts";
import { coinPriceE18, e18ToNumber, gap, priceInPool } from "./price.ts";

describe("coinPriceE18", () => {
  it("prices a fresh stock pair at its opening valuation (5 shares / 1e9 coins) in either orientation", () => {
    for (const c0 of [true, false]) {
      const { sqrtPriceX96 } = opening(c0, OPENING_FDV_STOCK, SUPPLY);
      const price = e18ToNumber(coinPriceE18(sqrtPriceX96, c0));
      // Opens a hair under the target: the start tick is rounded toward the cheaper side.
      expect(price).toBeGreaterThan(4.9e-9);
      expect(price).toBeLessThanOrEqual(5e-9 * 1.0001);
    }
  });
});

describe("priceInPool", () => {
  it("inverts for token1", () => {
    const sqrt = 2n ** 96n * 10n; // token1/token0 = 100
    expect(priceInPool(sqrt, "0xA", "0xa")).toBeCloseTo(100);
    expect(priceInPool(sqrt, "0xA", "0xB")).toBeCloseTo(0.01);
  });
});

describe("gap", () => {
  it("is a signed fraction of the reference", () => {
    expect(gap(101, 100)).toBeCloseTo(0.01);
    expect(gap(99, 100)).toBeCloseTo(-0.01);
    expect(gap(1, 0)).toBeNull();
  });
});
