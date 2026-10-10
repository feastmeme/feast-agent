import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { allowanceSlot, permitTypedData, splitPermitSignature } from "./permit.ts";
import { withSlippage } from "./client.ts";

// A key made for this run and never stored.
const account = privateKeyToAccount(generatePrivateKey());
const COIN = "0x8a44135C84ac1AdA0A8f0ffDC24369Fe6325F7B6" as Address;
const ROUTER = "0xa8c7180912D4464fa66713758Fa7eB3418b81D01" as Address;

describe("permit", () => {
  it("signs an EIP-2612 permit in the coin's own domain and splits it into v, r, s", async () => {
    const typed = permitTypedData({ coin: COIN, coinName: "Bell", chainId: 56096, owner: account.address, spender: ROUTER, value: 5n, nonce: 0n, deadline: 1n });
    expect(typed.domain).toEqual({ name: "Bell", version: "1", chainId: 56096, verifyingContract: COIN });
    const signature = await account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(account.address);
    const { v, r, s } = splitPermitSignature(signature);
    expect([27, 28]).toContain(v);
    expect(r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("finds the allowance slot of OpenZeppelin v5's _allowances mapping", () => {
    expect(allowanceSlot(account.address, ROUTER)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(allowanceSlot(account.address, ROUTER)).not.toBe(allowanceSlot(ROUTER, account.address));
  });
});

describe("withSlippage", () => {
  it("floors the minimum out", () => {
    expect(withSlippage(10_000n, 100)).toBe(9_900n);
    expect(withSlippage(999n, 100)).toBe(989n);
    expect(() => withSlippage(1n, 10_001)).toThrow();
  });
});
