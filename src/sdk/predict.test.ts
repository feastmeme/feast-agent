import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hexToBytes, maxUint256, type Address, type Hex } from "viem";

import { SUPPLY } from "./launch-params.ts";
import {
  FEAST_TOKEN_CREATION_CODE,
  FEAST_TOKEN_CREATION_CODE_SHA256,
  coinInitCodeHash,
  predictCoinAddress,
} from "./predict.ts";

/** The sandbox factory; every vector below is that deployed factory's own `predictCoin` answer. */
const FACTORY = "0x0c68E97F14D6f934Fef6126a149508fA67B56C3f" as Address;
const ZERO = `0x${"00".repeat(32)}` as Hex;
const ONES = `0x${"ff".repeat(32)}` as Hex;
const MID = `0x${"a7".repeat(32)}` as Hex;

const VECTORS: Array<{ salt: Hex; name: string; symbol: string; supply: bigint; coin: Address }> = [
  { salt: ZERO, name: "", symbol: "", supply: 0n, coin: "0x607BeDb4d42804460E9166f59002995B0b370EF2" },
  { salt: ZERO, name: "Dinner Bell", symbol: "BELL", supply: SUPPLY, coin: "0xc1C43aD2B89aaA5d841cA75619ebb31fB827e460" },
  { salt: ONES, name: "Dinner Bell", symbol: "BELL", supply: SUPPLY, coin: "0x8546960cD2E702047090A5461c0247C7Dce463B2" },
  { salt: MID, name: "Dinner Bell", symbol: "BELL", supply: SUPPLY, coin: "0x37a00c54Cb8cA63D6b58929A948B2b0270D61944" },
  { salt: MID, name: "Dinner Bell", symbol: "BELL", supply: maxUint256, coin: "0xE430802e23337d5c49621Dc0238a4835d2eca87b" },
  { salt: MID, name: "晚餐铃 🔔", symbol: "BELL", supply: SUPPLY, coin: "0x3E3D086AF49b2a9496aBf3BAB971AA65B4012699" },
];

describe("predictCoinAddress", () => {
  it("agrees with the deployed factory's predictCoin, byte for byte", () => {
    for (const v of VECTORS) {
      const hash = coinInitCodeHash(FACTORY, v.name, v.symbol, v.supply);
      expect(predictCoinAddress(FACTORY, v.salt, hash)).toBe(v.coin);
    }
  });
  it("carries the creation code it says it does", () => {
    const bytes = hexToBytes(FEAST_TOKEN_CREATION_CODE);
    expect(bytes.length).toBe(4847);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FEAST_TOKEN_CREATION_CODE_SHA256);
  });
});
