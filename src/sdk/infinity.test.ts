import { readFileSync } from "node:fs";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { coinAbi, hookAbi } from "./abi.ts";
import {
  ADDRESS_THIS,
  CONTRACT_BALANCE,
  MAX_UINT160,
  approveCall,
  buyCall,
  claimCreatorCall,
  encodeExecute,
  buyCommands,
  hookDataFor,
  permit2ApproveCall,
  poolIdOf,
  quoteOfKey,
  sellCall,
  sellCommands,
  v3Path,
  type PoolKey,
  type TradePlan,
} from "./infinity.ts";
import { MAINNET } from "./networks.ts";
import { permit2Abi, universalRouterAbi } from "./venue-abi.ts";

/**
 * The fixture is the feast.meme site's own encoder run on fixed inputs
 * (synthetic coins, real venue contracts), plus the probe tool's recorded buy of
 * FEAST. Every case must come out of this SDK byte for byte.
 */
type Case = { input: Record<string, unknown>; deadline: string; data: Hex };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/infinity.site.json", import.meta.url), "utf8")) as {
  poolIds: { feast: Hex };
  cases: Record<string, Case>;
  probe: { input: { amountIn: string; minOut: string; hookData: Hex }; deadline: string; data: Hex };
};

function planOf(input: Record<string, unknown>): TradePlan {
  const key = input.poolKey as PoolKey;
  const permit = input.permit as { permit: { details: Record<string, string>; spender: Address; sigDeadline: string }; signature: Hex } | null | undefined;
  return {
    wrappedNative: input.wrappedNative as Address,
    quote: input.quote as Address,
    coin: input.coin as Address,
    hops: input.hops as TradePlan["hops"],
    poolKey: key,
    amountIn: BigInt(input.amountIn as string),
    minOut: BigInt(input.minOut as string),
    hookData: input.hookData as Hex,
    payIn: input.payIn as TradePlan["payIn"],
    permit: permit
      ? {
          permit: {
            details: {
              token: permit.permit.details.token as Address,
              amount: BigInt(permit.permit.details.amount as string),
              expiration: BigInt(permit.permit.details.expiration as string),
              nonce: BigInt(permit.permit.details.nonce as string),
            },
            spender: permit.permit.spender,
            sigDeadline: BigInt(permit.permit.sigDeadline),
          },
          signature: permit.signature,
        }
      : null,
  };
}

describe("Universal Router calldata, against the feast.meme site's encoder", () => {
  for (const [name, c] of Object.entries(fixture.cases)) {
    it(name, () => {
      const plan = planOf(c.input);
      const steps = name.startsWith("buy") ? buyCommands(plan) : sellCommands(plan);
      expect(encodeExecute(steps, BigInt(c.deadline))).toBe(c.data);
    });
  }

  it("the probe tool's recorded FEAST buy", () => {
    const feast = fixture.cases["buy-feast-native"]!;
    const plan = { ...planOf(feast.input), amountIn: BigInt(fixture.probe.input.amountIn), minOut: BigInt(fixture.probe.input.minOut) };
    expect(encodeExecute(buyCommands(plan), BigInt(fixture.probe.deadline))).toBe(fixture.probe.data);
  });

  it("FEAST's pool key hashes to the address book's pool id", () => {
    const key = fixture.cases["buy-feast-native"]!.input.poolKey as PoolKey;
    expect(poolIdOf(key)).toBe(fixture.poolIds.feast);
    expect(poolIdOf(key)).toBe(MAINNET.platformCoin?.poolId);
  });
});

describe("the calls around a trade", () => {
  const router = MAINNET.trade.kind === "infinity" ? MAINNET.trade.router : ("0x" as Address);
  const permit2 = MAINNET.trade.kind === "infinity" ? MAINNET.trade.permit2 : ("0x" as Address);
  const plan = planOf(fixture.cases["buy-feast-native"]!.input);

  it("a native buy sends its amount as value; a buy paid in the quote and a sale send none", () => {
    expect(buyCall(router, plan, 1n).value).toBe(plan.amountIn);
    expect(buyCall(router, { ...plan, payIn: "quote" }, 1n).value).toBe(0n);
    expect(sellCall(router, plan, 1n).value).toBe(0n);
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: buyCall(router, plan, 7n).data });
    expect(decoded.functionName).toBe("execute");
    expect(decoded.args[0]).toBe("0x0b10"); // WRAP_ETH, INFI_SWAP: no hops for a WBNB pool
    expect(decoded.args[2]).toBe(7n);
  });

  it("approve and Permit2.approve encode what they say", () => {
    const coin = plan.coin;
    const a = decodeFunctionData({ abi: coinAbi, data: approveCall(coin, permit2).data });
    expect(a.functionName).toBe("approve");
    expect(a.args).toEqual([permit2, 2n ** 256n - 1n]);
    const p = permit2ApproveCall(permit2, coin, router, MAX_UINT160, 1795142719n);
    expect(p.to).toBe(permit2);
    const d = decodeFunctionData({ abi: permit2Abi, data: p.data });
    expect(d.functionName).toBe("approve");
    expect(d.args).toEqual([coin, router, MAX_UINT160, 1795142719]);
    expect(() => permit2ApproveCall(permit2, coin, router, MAX_UINT160 + 1n, 1n)).toThrow(/uint160/);
    expect(() => permit2ApproveCall(permit2, coin, router, 1n, 1n << 48n)).toThrow(/uint48/);
  });

  it("claimCreator takes the pool key", () => {
    const key = plan.poolKey;
    const call = claimCreatorCall(MAINNET.contracts.hook, key);
    const d = decodeFunctionData({ abi: hookAbi, data: call.data });
    expect(d.functionName).toBe("claimCreator");
    expect(d.args[0]).toEqual(key);
  });

  it("hookData is one word naming the referrer, or nothing", () => {
    expect(hookDataFor(null)).toBe("0x");
    expect(hookDataFor("0x0000000000000000000000000000000000000000")).toBe("0x");
    expect(hookDataFor("0x000000000000000000000000000000000000bEEF")).toBe(
      "0x000000000000000000000000000000000000000000000000000000000000beef",
    );
  });

  it("v3Path walks the hops; quoteOfKey picks the other currency", () => {
    const usdt = MAINNET.contracts.usdt;
    const aaplb = MAINNET.stocks.find((s) => s.symbol === "AAPLB")!;
    expect(v3Path(MAINNET.contracts.wrappedNative, aaplb.buy)).toBe(
      `${MAINNET.contracts.wrappedNative}000064${usdt.slice(2)}0009c4${aaplb.address.slice(2)}`.toLowerCase(),
    );
    expect(quoteOfKey(plan.poolKey, plan.coin)).toBe(plan.poolKey.currency1);
    expect(ADDRESS_THIS).toMatch(/2$/);
    expect(CONTRACT_BALANCE).toBe(1n << 255n);
  });
});
