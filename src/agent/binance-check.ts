import { BinanceApiError, BinanceWeb3Client, credentialsFromEnv } from "../binance/index.ts";
import type { AgentContext } from "./commands.ts";

/**
 * One call to each RWA Data endpoint the agent uses, with the configured
 * credentials, timed — the live check to run once a key exists. With `record`,
 * every response is written (without credentials) to src/binance/fixtures/live/.
 */
export async function binanceCheck(ctx: AgentContext, options: { record?: boolean } = {}) {
  const lines: string[] = [];
  const { credentials, missing } = credentialsFromEnv(ctx.env);
  if (!credentials) {
    lines.push(`Binance Web3 API not configured: set ${missing.join(" and ")}.`);
    return { ok: false, lines, calls: [] as Array<Record<string, unknown>> };
  }
  const client = new BinanceWeb3Client({
    credentials,
    baseUrl: ctx.env.BINANCE_WEB3_BASE_URL?.trim() || undefined,
    recordDir: options.record ? "src/binance/fixtures/live" : ctx.env.BINANCE_WEB3_RECORD_DIR?.trim() || undefined,
  });
  const stocks = ctx.feast.network.stocks;
  const first = stocks[0];
  const calls: Array<Record<string, unknown>> = [];
  const attempt = async (endpoint: string, run: () => Promise<unknown>, summarise: (data: never) => string) => {
    const started = Date.now();
    try {
      const data = await run();
      const ms = Date.now() - started;
      calls.push({ endpoint, ok: true, ms });
      lines.push(`ok    ${endpoint} (${ms} ms): ${summarise(data as never)}`);
    } catch (error) {
      const ms = Date.now() - started;
      const detail = error instanceof BinanceApiError ? { httpStatus: error.httpStatus, code: error.code, message: error.apiMessage } : { message: String(error) };
      calls.push({ endpoint, ok: false, ms, ...detail });
      lines.push(`FAIL  ${endpoint} (${ms} ms): ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await attempt("/api/v1/dex/market/rwa/platforms", () => client.rwaPlatforms("bstock"), (d: Array<{ platformId: string; tickerCount: number }>) =>
    d.map((p) => `${p.platformId}: ${p.tickerCount} tickers`).join(", "),
  );
  await attempt("/api/v1/dex/market/rwa/tokens", () => client.rwaTokens({ binanceChainId: "56", platformId: "bstock" }), (d: Array<{ tokenContractAddress: string; tokenSymbol: string }>) => {
    const listed = new Set(d.map((t) => t.tokenContractAddress.toLowerCase()));
    const ours = stocks.map((s) => `${s.symbol}${listed.has(s.address.toLowerCase()) ? "" : " (NOT LISTED)"}`);
    return `${d.length} bStock tokens on BSC; Feast's quotes: ${ours.join(", ")}`;
  });
  await attempt("/api/v1/dex/market/rwa/price", () => client.rwaPrice(stocks.map((s) => s.address)), (d: Array<{ tokenContractAddress: string; tokenPrice: string; referencePrice: string }>) =>
    d.map((p) => `${stocks.find((s) => s.address.toLowerCase() === p.tokenContractAddress.toLowerCase())?.symbol ?? p.tokenContractAddress} $${p.tokenPrice} (ref $${p.referencePrice})`).join("; "),
  );
  if (first) {
    await attempt("/api/v1/dex/market/rwa/underlying-market", () => client.rwaUnderlyingMarket(first.address), (d: { statusInfo?: { marketStatus?: string }; marketData?: { referencePrice?: string } }) =>
      `${first.symbol}: ${d.statusInfo?.marketStatus ?? "?"}, reference $${d.marketData?.referencePrice ?? "?"}`,
    );
    await attempt("/api/v1/dex/market/rwa/underlying-profile", () => client.rwaUnderlyingProfile(first.address), (d: { underlyingTicker?: string; tokenToShareRatio?: string }) =>
      `${first.symbol}: ${d.underlyingTicker ?? "?"}, ${d.tokenToShareRatio ?? "?"} shares per token`,
    );
    await attempt("/api/v1/dex/market/rwa/search", () => client.rwaSearch(first.underlying, "bstock"), (d: Array<{ ticker: string; assets: unknown[] }>) =>
      d.map((h) => `${h.ticker} (${h.assets.length} assets)`).join(", "),
    );
  }
  return { ok: calls.every((c) => c.ok), lines, calls };
}
