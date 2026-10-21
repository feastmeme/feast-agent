import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Address, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";

import { hookAbi, refusalErrorsAbi } from "./abi.ts";
import { innermostRefusal, venueErrorsAbi } from "./errors.ts";
import { hookFillsOf, nativeLegsOf } from "./receipts.ts";
import { mixedQuoterAbi, universalRouterAbi, wrappedNativeAbi } from "./venue-abi.ts";

const HOOK: Address = "0xABFB955e4582f49dc741DCf5354fbB0edaD0A7c5";
const ROUTER: Address = "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB";
const WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const COIN: Address = "0x00000000000000000000000000000000c0ffee01";
const OTHER_COIN: Address = "0x00000000000000000000000000000000c0ffee02";
// Synthetic traders: never real wallets.
const TRADER: Address = "0x000000000000000000000000000000000000a11c";
const STRANGER: Address = "0x000000000000000000000000000000000000b0b0";

function tradeLog(input: { address?: Address; coin?: Address; payer?: Address; buy: boolean; coinAmount: bigint; quoteAmount: bigint; fee: bigint }): Log {
  const topics = encodeEventTopics({
    abi: hookAbi,
    eventName: "Trade",
    args: { coin: input.coin ?? COIN, quote: WBNB, payer: input.payer ?? TRADER },
  });
  const data = encodeAbiParameters(
    [{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint160" }, { type: "uint256" }],
    [input.buy, input.coinAmount, input.quoteAmount, 79228162514264337593543950336n, input.fee],
  );
  return { address: input.address ?? HOOK, topics, data } as unknown as Log;
}

function wbnbLog(eventName: "Deposit" | "Withdrawal", who: Address, wad: bigint, address: Address = WBNB): Log {
  const args = eventName === "Deposit" ? { dst: who } : { src: who };
  const topics = encodeEventTopics({ abi: wrappedNativeAbi, eventName, args } as never);
  return { address, topics, data: encodeAbiParameters([{ type: "uint256" }], [wad]) } as unknown as Log;
}

describe("hookFillsOf", () => {
  it("sums this payer's fills of this coin, buys apart from sales", () => {
    const logs = [
      tradeLog({ buy: true, coinAmount: 100n, quoteAmount: 10n, fee: 1n }),
      tradeLog({ buy: true, coinAmount: 200n, quoteAmount: 20n, fee: 2n }),
      tradeLog({ buy: false, coinAmount: 50n, quoteAmount: 4n, fee: 0n }),
    ];
    const fills = hookFillsOf({ logs }, { hook: HOOK, payer: TRADER, coin: COIN });
    expect(fills.buy).toEqual({ coinAmount: 300n, quoteAmount: 30n, fee: 3n, fills: 2 });
    expect(fills.sell).toEqual({ coinAmount: 50n, quoteAmount: 4n, fee: 0n, fills: 1 });
  });

  it("ignores another emitter, another payer and another coin", () => {
    const logs = [
      tradeLog({ address: "0x000000000000000000000000000000000000dEaD", buy: true, coinAmount: 1n, quoteAmount: 1n, fee: 0n }),
      tradeLog({ payer: STRANGER, buy: true, coinAmount: 1n, quoteAmount: 1n, fee: 0n }),
      tradeLog({ coin: OTHER_COIN, buy: true, coinAmount: 1n, quoteAmount: 1n, fee: 0n }),
    ];
    const fills = hookFillsOf({ logs }, { hook: HOOK, payer: TRADER, coin: COIN });
    expect(fills.buy.fills).toBe(0);
    expect(fills.sell.fills).toBe(0);
  });
});

describe("nativeLegsOf", () => {
  it("reads the router's wrap and unwrap, and nobody else's", () => {
    const logs = [
      wbnbLog("Deposit", ROUTER, 2_000n),
      wbnbLog("Withdrawal", ROUTER, 1_500n),
      wbnbLog("Deposit", STRANGER, 9n),
      wbnbLog("Withdrawal", ROUTER, 7n, "0x000000000000000000000000000000000000dEaD"),
    ];
    expect(nativeLegsOf({ logs }, { wrappedNative: WBNB, router: ROUTER })).toEqual({ wrapped: 2_000n, unwrapped: 1_500n });
  });
});

describe("innermostRefusal", () => {
  const cap = encodeErrorResult({ abi: refusalErrorsAbi, errorName: "PurchaseCapExceeded" });
  const wrapped = encodeErrorResult({
    abi: venueErrorsAbi,
    errorName: "WrappedError",
    args: [HOOK, "0x12345678", cap, "0x"],
  });

  it("opens the quoter's envelope and the pool manager's down to the hook's refusal", () => {
    const quoter = encodeErrorResult({ abi: mixedQuoterAbi, errorName: "UnexpectedRevertBytes", args: [wrapped] });
    expect(innermostRefusal(quoter)?.errorName).toBe("PurchaseCapExceeded");
  });

  it("opens the router's ExecutionFailed", () => {
    const deadline = encodeErrorResult({ abi: universalRouterAbi, errorName: "TransactionDeadlinePassed" });
    const failed = encodeErrorResult({ abi: universalRouterAbi, errorName: "ExecutionFailed", args: [1n, deadline] });
    expect(innermostRefusal(failed)?.errorName).toBe("TransactionDeadlinePassed");
  });

  it("names the envelope when what it carries does not decode, and nothing when nothing does", () => {
    const opaque = encodeErrorResult({ abi: mixedQuoterAbi, errorName: "UnexpectedRevertBytes", args: ["0xdeadbeef" as Hex] });
    expect(innermostRefusal(opaque)?.errorName).toBe("UnexpectedRevertBytes");
    expect(innermostRefusal("0x12345678")).toBeNull();
    expect(innermostRefusal(undefined)).toBeNull();
  });
});
