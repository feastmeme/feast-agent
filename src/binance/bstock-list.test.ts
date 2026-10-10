import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MAINNET, SANDBOX } from "../sdk/networks.ts";

/** Binance's own bStock list (recorded live, keyless) against every stock Feast pairs coins with. */
const list = JSON.parse(readFileSync(new URL("./fixtures/skill-bstock-list.bsc.live.json", import.meta.url), "utf8")) as {
  totalItems: number;
  bstocksOnBsc: Array<{ symbol: string; ticker: string; contractAddress: string }>;
};

describe("Feast's stocks in Binance's bStock list", () => {
  it("lists every stock either Feast deployment pairs with, under the same symbol", () => {
    const byAddress = new Map(list.bstocksOnBsc.map((b) => [b.contractAddress.toLowerCase(), b]));
    const stocks = [...MAINNET.stocks, ...SANDBOX.stocks];
    expect(new Set(stocks.map((s) => s.symbol)).size).toBe(12);
    for (const stock of stocks) {
      const listed = byAddress.get(stock.address.toLowerCase());
      expect(listed, stock.symbol).toBeDefined();
      expect(listed?.symbol).toBe(stock.symbol);
      expect(listed?.ticker).toBe(stock.underlying);
    }
  });
  it("records how many bStocks Binance listed on BSC when it was read", () => {
    expect(list.bstocksOnBsc).toHaveLength(91);
    expect(list.totalItems).toBe(1938);
  });
});
