import { describe, expect, it } from "vitest";
import { encodeErrorResult, type Hex } from "viem";

import { REFUSALS_ABI, decodeRefusalData, safeMessage } from "./errors.ts";

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

describe("safeMessage", () => {
  it("keeps viem's short message and redacts a keyed RPC URL", async () => {
    const { createPublicClient, http } = await import("viem");
    const url = "http://127.0.0.1:9/v1/SECRETKEY123";
    const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
    const error = await client.getBlockNumber().catch((e: unknown) => e);
    // viem's own message carries the URL; ours never does.
    expect(String((error as Error).message)).toContain("SECRETKEY123");
    expect(safeMessage(error, [url])).not.toContain("SECRETKEY123");
  });
  it("replaces every occurrence of a secret", () => {
    expect(safeMessage(new Error("a https://x/KEY b https://x/KEY"), ["https://x/KEY"])).toBe("a <redacted> b <redacted>");
  });
});
