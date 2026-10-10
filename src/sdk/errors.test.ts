import { describe, expect, it } from "vitest";
import { encodeErrorResult, type Hex } from "viem";

import { REFUSALS_ABI, decodeRefusalData } from "./errors.ts";

const HOOK = "0x632261E397351C35f0605dc4FdD83F8dc0f09e44" as Hex;

describe("decodeRefusalData", () => {
  it("names a Feast refusal directly", () => {
    const data = encodeErrorResult({ abi: REFUSALS_ABI, errorName: "TooLittleOut", args: [10n, 9n] });
    const refusal = decodeRefusalData(data);
    expect(refusal.errorName).toBe("TooLittleOut");
    expect(refusal.message).toMatch(/^TooLittleOut\(10, 9\): the price moved/);
  });
  it("unwraps the venue's WrappedError (0x90bfb865) to the hook's own refusal", () => {
    const inner = encodeErrorResult({ abi: REFUSALS_ABI, errorName: "PurchaseCapExceeded" });
    const data = encodeErrorResult({
      abi: REFUSALS_ABI,
      errorName: "WrappedError",
      args: [HOOK, "0x575e24b4", inner, "0x"],
    });
    expect(data.slice(0, 10)).toBe("0x90bfb865");
    const refusal = decodeRefusalData(data);
    expect(refusal.errorName).toBe("PurchaseCapExceeded");
    expect(refusal.raisedBy).toBe(HOOK);
    expect(refusal.message).toMatch(/opening window/);
  });
  it("says so when it cannot decode", () => {
    expect(decodeRefusalData("0xdeadbeef").errorName).toBeNull();
    expect(decodeRefusalData("0x").message).toBe("reverted without a reason");
  });
});
