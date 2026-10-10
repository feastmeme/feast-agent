import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";

import { FeastClient } from "./client.ts";
import { SUPPLY } from "./launch-params.ts";
import { MAINNET } from "./networks.ts";
import { coinInitCodeHash, predictCoinAddress } from "./predict.ts";

/**
 * BNB Smart Chain, read only: the factory has code, the pricer's quote list
 * resolves to the address book's stocks, and the factory's predictCoin agrees
 * with the local CREATE2 port. Skipped unless FEAST_AGENT_MAINNET=1. Sends nothing.
 */
const live = process.env.FEAST_AGENT_MAINNET === "1";

describe.skipIf(!live)("mainnet read path, live", () => {
  const client = new FeastClient({ network: MAINNET });

  it("finds the factory deployed on chain 56", async () => {
    expect(await client.publicClient.getChainId()).toBe(56);
    const code = await client.publicClient.getCode({ address: MAINNET.contracts.factory });
    expect((code?.length ?? 0) > 2).toBe(true);
  });

  it("resolves every pricer quote to WBNB or a bStock the book names", async () => {
    const quotes = await client.quotes();
    expect(quotes[0]?.symbol).toBe("WBNB");
    const book = new Set(MAINNET.stocks.map((s) => getAddress(s.address)));
    for (const q of quotes.slice(1)) expect(book.has(q.address), q.symbol).toBe(true);
  });

  it("predicts the same coin address as the factory", async () => {
    const salt = `0x${"a7".repeat(32)}` as Hex;
    const onChain = await client.predictCoin({ salt, name: "Dinner Bell", symbol: "BELL" });
    const local = predictCoinAddress(MAINNET.contracts.factory, salt, coinInitCodeHash(MAINNET.contracts.factory, "Dinner Bell", "BELL", SUPPLY));
    expect(onChain).toBe(local);
  });

  it("prepares a launch without sending it, and refuses to send one", async () => {
    const prepared = await client.prepareLaunch(
      { name: "Dry Run", symbol: "DRY", quote: "AAPLB", metadataHash: `0x${"00".repeat(32)}` },
      "0x000000000000000000000000000000000000fea5",
    );
    expect(prepared.request.to).toBe(MAINNET.contracts.factory);
    expect(prepared.request.data.startsWith("0x7fd96fff")).toBe(true);
    await expect(client.launch({ name: "No", symbol: "NO", quote: "AAPLB" })).rejects.toThrow(/refusing to send/);
  });
});
