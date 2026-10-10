import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from "viem";

import { factoryAbi } from "./abi.ts";
import {
  LaunchParamsError,
  MAX_USABLE_TICK,
  OPENING_FDV_NATIVE,
  OPENING_FDV_STOCK,
  Q96,
  SUPPLY,
  createParams,
  opening,
  sqrtAtTick,
  type LaunchChoice,
} from "./launch-params.ts";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address;
const AAPLB = "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A" as Address;
const LOW_COIN = "0x0000000000000000000000000000000000000001" as Address;
const HIGH_COIN = "0xffffffffffffffffffffffffffffffffffffffff" as Address;

const choice: LaunchChoice = {
  name: "Dinner Bell",
  symbol: "BELL",
  quote: AAPLB,
  creator: "0x1111111111111111111111111111111111111111",
  burn: 20,
  referrer: 10,
  salt: `0x${"a7".repeat(32)}` as Hex,
  metadataHash: `0x${"ab".repeat(32)}` as Hex,
};

describe("sqrtAtTick", () => {
  it("is 2^96 at tick zero and monotonic", () => {
    expect(sqrtAtTick(0)).toBe(Q96);
    expect(sqrtAtTick(200) > sqrtAtTick(0)).toBe(true);
    expect(sqrtAtTick(-200) < sqrtAtTick(0)).toBe(true);
  });
  it("refuses a tick outside the usable range", () => {
    expect(() => sqrtAtTick(MAX_USABLE_TICK + 1)).toThrow(LaunchParamsError);
  });
});

describe("opening", () => {
  // Vectors pinned by the Feast app's own suite, which holds them to the contracts' launch library.
  it("opens a stock pair with the coin as currency0 at the pinned vector", () => {
    expect(opening(true, OPENING_FDV_STOCK, SUPPLY)).toEqual({
      startTick: -191_200,
      sqrtPriceX96: 5587685005705662088715208n,
      liquidity: 70526429500623989137788n,
    });
  });
  it("opens a stock pair with the coin as currency1 at the pinned vector", () => {
    expect(opening(false, OPENING_FDV_STOCK, SUPPLY)).toEqual({
      startTick: 191_200,
      sqrtPriceX96: 1123381459222745333851674512836410n,
      liquidity: 70526429500623989137788n,
    });
  });
  it("opens at a tick-spacing multiple, on the single-sided side of it", () => {
    for (const c0 of [true, false]) {
      const { startTick, sqrtPriceX96 } = opening(c0, OPENING_FDV_NATIVE, SUPPLY);
      expect(Math.abs(startTick % 200)).toBe(0);
      if (c0) expect(sqrtPriceX96 < sqrtAtTick(startTick)).toBe(true);
      else expect(sqrtPriceX96 > sqrtAtTick(startTick)).toBe(true);
    }
  });
});

describe("createParams", () => {
  it("encodes the split as basis points and seeds the whole supply", () => {
    const p = createParams(choice, HIGH_COIN, WBNB);
    expect(p.selfBurnBps).toBe(2_000);
    expect(p.referrerBps).toBe(1_000);
    expect(p.supply).toBe(SUPPLY);
    expect([p.prebuyQuoteIn, p.minCoinsOut, p.vestingDuration]).toEqual([0n, 0n, 0n]);
    expect(p.startTick).toBe(191_200);
  });
  it("orients the pool by the predicted coin address", () => {
    // A coin that sorts below its quote is currency0 and opens at a negative tick, and vice versa.
    expect(createParams(choice, LOW_COIN, WBNB).startTick).toBe(-191_200);
    expect(createParams(choice, HIGH_COIN, WBNB).startTick).toBe(191_200);
    // Two WBNB is a cheaper opening than five shares, so a WBNB-paired currency0 coin opens lower.
    expect(createParams({ ...choice, quote: WBNB }, LOW_COIN, WBNB).startTick).toBeLessThan(-191_200);
  });
  it("refuses the contract's out-of-band splits and an unpinned digest before anything is signed", () => {
    expect(() => createParams({ ...choice, burn: 31 }, HIGH_COIN, WBNB)).toThrow(/burn/);
    expect(() => createParams({ ...choice, referrer: -1 }, HIGH_COIN, WBNB)).toThrow(/referrer/);
    expect(() => createParams({ ...choice, metadataHash: "0x1234" }, HIGH_COIN, WBNB)).toThrow(/32 bytes/);
    expect(() => createParams({ ...choice, openingValuation: 0n }, HIGH_COIN, WBNB)).toThrow(/above zero/);
    expect(() =>
      createParams({ ...choice, prebuy: { quoteIn: 1n, minCoinsOut: 0n, vestingDuration: 60n } }, HIGH_COIN, WBNB),
    ).toThrow(/seven days/);
  });
  it("round-trips through the factory ABI's create(tuple)", () => {
    const p = createParams(choice, HIGH_COIN, WBNB);
    const data = encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [p] });
    expect(data.slice(0, 10)).toBe(encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [p] }).slice(0, 10));
    const decoded = decodeFunctionData({ abi: factoryAbi, data });
    expect(decoded.functionName).toBe("create");
    const [arg] = decoded.args as unknown as [typeof p];
    expect(arg.metadataHash).toBe(p.metadataHash);
    expect(arg.liquidity).toBe(p.liquidity);
    expect(arg.quote).toBe(AAPLB);
  });
});
