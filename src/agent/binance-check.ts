import { BinanceApiError, BinanceWeb3Client, credentialsFromEnv } from "../binance/index.ts";
import type { AgentContext } from "./commands.ts";

/**
 * One call to each RWA Data endpoint the agent uses, with the configured
 * credentials, timed — the live check to run once a key exists. The client paces
 * calls 250 ms apart and retries a 429 once after its Retry-After. With `record`,
 * every response is written (without credentials) to src/binance/fixtures/live/.
 * Fields the API returns as null are printed as null, never as a guess.
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
  let tickerCount: number | null = null;
  let listed: Set<string> | null = null;
  await attempt("/api/v1/dex/market/rwa/platforms", () => client.rwaPlatforms("bstock"), (d: Array<{ platformId: string; tickerCount: number }>) => {
    tickerCount = d.find((p) => p.platformId === "bstock")?.tickerCount ?? null;
    return d.map((p) => `${p.platformId}: ${p.tickerCount} tickers`).join(", ");
  });
  await attempt("/api/v1/dex/market/rwa/tokens", () => client.rwaTokens({ binanceChainId: "56", platformId: "bstock" }), (d: Array<{ tokenContractAddress: string; tokenSymbol: string }>) => {
    listed = new Set(d.map((t) => t.tokenContractAddress.toLowerCase()));
    const seen = listed;
    const missing = stocks.filter((s) => !seen.has(s.address.toLowerCase())).map((s) => s.symbol);
    return (
      `${d.length} bStock tokens on BSC${tickerCount !== null ? ` (platforms reported ${tickerCount} tickers)` : ""}; ` +
      `Feast quotes not in this list: ${missing.length ? missing.join(", ") : "none"}`
    );
  });
  await attempt("/api/v1/dex/market/rwa/price", () => client.rwaPrice(stocks.map((s) => s.address)), (d: Array<{ tokenContractAddress: string; tokenPrice: string; referencePrice: string }>) =>
    d
      .map((p) => {
        const symbol = stocks.find((s) => s.address.toLowerCase() === p.tokenContractAddress.toLowerCase())?.symbol ?? p.tokenContractAddress;
        const unlisted = listed && !listed.has(p.tokenContractAddress.toLowerCase()) ? " [priced, but absent from /rwa/tokens]" : "";
        return `${symbol} $${p.tokenPrice} (ref $${p.referencePrice})${unlisted}`;
      })
      .join("; "),
  );
  if (first) {
    await attempt(
      "/api/v1/dex/market/rwa/underlying-market",
      () => client.rwaUnderlyingMarket(first.address),
      (d: { statusInfo?: { marketStatus?: string | null; openState?: boolean | null; reasonCode?: string | null }; marketData?: { referencePrice?: string | null } }) =>
        `${first.symbol}: marketStatus ${String(d.statusInfo?.marketStatus ?? null)}, openState ${String(d.statusInfo?.openState ?? null)}, ` +
        `reasonCode ${String(d.statusInfo?.reasonCode ?? null)}; marketData.referencePrice ${String(d.marketData?.referencePrice ?? null)}`,
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
