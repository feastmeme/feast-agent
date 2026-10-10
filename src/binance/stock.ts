import {
  BinanceApiError,
  BinanceNotConfigured,
  type BinanceWeb3Client,
  type MarketStatus,
} from "./client.ts";

/**
 * What the Binance Web3 API says about one bStock, in the shape `feast-agent quote`
 * prints: the token's on-chain USD price, the underlying share's reference price,
 * the market's status, and the gap between token and reference.
 *
 * Never throws for the two expected absences: no credentials ("not configured")
 * and an API refusal ("unavailable", with the API's own words).
 */
export type StockReference =
  | { state: "not_configured"; missing: string[]; message: string }
  | { state: "unavailable"; message: string; endpoint: string; httpStatus: number | null; code: number | null }
  | {
      state: "ok";
      tokenAddress: string;
      platformId: string;
      /** /rwa/price `tokenPrice`: the token's on-chain price, USD. */
      tokenPriceUsd: number;
      /** /rwa/price `referencePrice`: per-share reference price, USD. */
      referencePriceUsd: number;
      /** /rwa/underlying-market `marketData.referencePrice`, when that call answered. */
      underlyingReferenceUsd: number | null;
      /** (token − reference) / reference: the token's premium (+) or discount (−) to the share. */
      gap: number | null;
      marketStatus: MarketStatus | null;
      marketOpen: boolean | null;
      tokenPriceUpdatedAt: number;
      /** The endpoints this answer was assembled from. */
      endpoints: string[];
    };

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function stockReference(client: BinanceWeb3Client, tokenAddress: string): Promise<StockReference> {
  if (!client.configured) {
    const missing = client.missingVariables;
    return { state: "not_configured", missing, message: new BinanceNotConfigured(missing).message };
  }
  try {
    const prices = await client.rwaPrice([tokenAddress]);
    const row = prices.find((p) => p.tokenContractAddress.toLowerCase() === tokenAddress.toLowerCase());
    if (!row) {
      return {
        state: "unavailable",
        message: `the RWA price endpoint returned no row for ${tokenAddress}`,
        endpoint: "/api/v1/dex/market/rwa/price",
        httpStatus: 200,
        code: 0,
      };
    }
    const endpoints = ["/api/v1/dex/market/rwa/price"];
    let underlyingReferenceUsd: number | null = null;
    let marketStatus: MarketStatus | null = null;
    let marketOpen: boolean | null = null;
    try {
      const market = await client.rwaUnderlyingMarket(tokenAddress);
      underlyingReferenceUsd = num(market.marketData?.referencePrice);
      marketStatus = market.statusInfo?.marketStatus ?? null;
      marketOpen = market.statusInfo?.openState ?? null;
      endpoints.push("/api/v1/dex/market/rwa/underlying-market");
    } catch (error) {
      // The price is still worth showing without the market status.
      if (!(error instanceof BinanceApiError)) throw error;
    }
    const token = num(row.tokenPrice);
    const reference = num(row.referencePrice) ?? 0;
    if (token === null || token <= 0) {
      return {
        state: "unavailable",
        message: `the RWA price endpoint returned no usable tokenPrice for ${tokenAddress} (got ${JSON.stringify(row.tokenPrice)})`,
        endpoint: "/api/v1/dex/market/rwa/price",
        httpStatus: 200,
        code: 0,
      };
    }
    return {
      state: "ok",
      tokenAddress: row.tokenContractAddress,
      platformId: row.platformId,
      tokenPriceUsd: token,
      referencePriceUsd: reference,
      underlyingReferenceUsd,
      gap: reference > 0 ? (token - reference) / reference : null,
      marketStatus,
      marketOpen,
      tokenPriceUpdatedAt: Number(row.tokenPriceUpdatedAt),
      endpoints,
    };
  } catch (error) {
    if (error instanceof BinanceApiError) {
      return { state: "unavailable", message: error.message, endpoint: error.endpoint, httpStatus: error.httpStatus, code: error.code };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unavailable", message: `network: ${message}`, endpoint: "/api/v1/dex/market/rwa/price", httpStatus: null, code: null };
  }
}
