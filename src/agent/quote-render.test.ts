import { describe, expect, it } from "vitest";

import { SANDBOX } from "../sdk/networks.ts";
import { renderQuote, type QuoteView } from "./commands.ts";

const AAPLB = SANDBOX.stocks.find((s) => s.symbol === "AAPLB")!;

const base: QuoteView = {
  network: "mainnet",
  chainId: 56,
  coin: { address: "0x0b222c5A2E82189411972295C38c4fE649b587A5", name: "Bell", symbol: "BELL", supply: 10n ** 27n, priceInQuote: 5e-9, quoteSymbol: "AAPLB" },
  stock: AAPLB,
  dex: { usd: 250, via: [AAPLB.pricePool] },
  binance: {
    state: "ok",
    tokenAddress: AAPLB.address,
    platformId: "bstock",
    tokenPriceUsd: 251.4,
    referencePriceUsd: 250.15,
    underlyingReferenceUsd: 250.15,
    gap: (251.4 - 250.15) / 250.15,
    marketStatus: "closed",
    marketOpen: false,
    tokenPriceUpdatedAt: 1791594000000,
    endpoints: ["/api/v1/dex/market/rwa/price", "/api/v1/dex/market/rwa/underlying-market"],
  },
  skill: null,
  coinUsd: 5e-9 * 251.4,
  coinUsdSource: "binance-rwa",
  marketCapUsd: 1e9 * 5e-9 * 251.4,
  dexVsBinance: (250 - 251.4) / 251.4,
};

describe("renderQuote", () => {
  it("shows the coin in stock units and USD, Binance's token and reference prices, and both gaps", () => {
    const text = renderQuote(base);
    expect(text).toContain("0.000000005 AAPLB per coin");
    expect(text).toContain("$0.000001257  via binance-rwa");
    expect(text).toContain("Binance RWA token price:         $251.4 (bstock");
    expect(text).toContain("reference (AAPL share): $250.15");
    expect(text).toContain("gap, token vs reference:         +0.500%");
    expect(text).toContain("gap, pool vs Binance token price: -0.557%");
    expect(text).toContain("AAPL market: closed (closed)");
  });
  it("says 'not configured' in the API's terms when there are no credentials", () => {
    const text = renderQuote({
      ...base,
      binance: { state: "not_configured", missing: ["BINANCE_WEB3_API_KEY", "BINANCE_WEB3_API_SECRET"], message: "Binance Web3 API not configured: set BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET." },
      coinUsdSource: "dex",
    });
    expect(text).toContain("Binance Web3 API not configured: set BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET.");
    expect(text).not.toContain("Binance RWA token price");
  });
});
