import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { impacts, quoteBuy, quoteSell, ROUND_TRIP_FEE_PCT } from "./quote.ts";

/**
 * Task 975, addendum 5: `FL quote` and the impacts, through the executor's own preparation (a fake one here): a call is
 * built and never sent; nothing asks the wallet.
 */

const C1 = getAddress("0x00000000000000000000000000000000000c0e01");
const E18 = 10n ** 18n;

const executor = {
  prepareBuy: async (_coin: unknown, sizeWei: bigint) => ({ ok: true as const, value: { quotedOut: 990n * E18, minOut: 960n * E18, impactPct: 1.23456, sizeWei } as never }),
  prepareSell: async (_coin: unknown, coins: bigint) => ({ ok: true as const, value: { coinsIn: coins, quotedOut: 9n * 10n ** 15n, minOut: 8n * 10n ** 15n, quotedBy: "quoter" } as never }),
};
const chain = { markWei: async () => 10n ** 16n };

describe("the quote", () => {
  it("a buy: expected coins, the minimum at the slippage, its impact, the round trip's fees", async () => {
    expect(await quoteBuy(executor as never, C1, 0.01)).toEqual({ side: "buy", coin: C1, amountIn: 0.01, expectedOut: 990, minOut: 960, impactPct: 1.235, roundTripFeePct: ROUND_TRIP_FEE_PCT, quotedBy: "quoter", slippagePct: 3 });
  });

  it("a sale: its impact against spot after the hook's 1 %", async () => {
    // Spot 0.01 BNB, less the hook's 1 %: 0.0099; the quote 0.009: about 9.09 % below.
    const q = await quoteSell(executor as never, chain, C1, 1_000n * E18);
    expect(q).toMatchObject({ side: "sell", amountIn: 1000, expectedOut: 0.009, minOut: 0.008 });
    expect((q as { impactPct: number }).impactPct).toBeCloseTo(9.091, 3);
  });

  it("a refusal is an error, and the impacts read null", async () => {
    const refusing = { prepareBuy: async () => ({ ok: false as const, reason: "not a Feast coin" }), prepareSell: async () => ({ ok: false as const, reason: "the wallet holds none of this coin" }) };
    expect(await quoteBuy(refusing as never, C1, 0.01)).toEqual({ error: "not a Feast coin" });
    const i = impacts(refusing as never, chain);
    expect(await i.buy(C1, 0.01)).toBeNull();
    expect(await i.exit(C1, E18)).toBeNull();
  });
});
