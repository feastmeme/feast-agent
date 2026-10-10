import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A small client for the Binance Web3 API's RWA Data endpoints.
 *
 * Docs: https://web3.binance.com/en/dev-docs/authentication and
 * https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data
 *
 * Every request is signed: X-OC-APIKEY, X-OC-TIMESTAMP (ISO 8601 with
 * milliseconds) and X-OC-SIGN = Base64(HMAC-SHA256(timestamp + METHOD +
 * requestPath + body, secretKey)), where requestPath carries the `/build`
 * prefix and the query string exactly as sent. So the API needs BOTH an API key
 * and its secret key; without them every call here answers "not configured"
 * instead of failing somewhere deeper.
 */

export const DEFAULT_BASE_URL = "https://web3.binance.com/build";
/** BNB Smart Chain, as the RWA endpoints spell a chain: a string. */
export const BSC_CHAIN_ID = "56";

export type PlatformId = "ondo" | "bstock";

/** The envelope every Binance Web3 API response uses (`OCResult<T>`). */
export type Envelope<T> = { code: number; msg: string; data: T; timestamp?: number; success?: boolean };

export type MarketStatus = "premarket" | "regular" | "postmarket" | "overnight" | "closed" | "pause";

/** As documented, `marketStatus` is never null; live (2026-10-10, a Saturday) it was null on every bStock. */
export type StatusInfo = {
  openState: boolean | null;
  marketStatus: MarketStatus | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  nextOpenTime: number | null;
  nextCloseTime: number | null;
};

/** GET /api/v1/dex/market/rwa/price → data[] */
export type RwaPrice = {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId: string;
  /** On-chain token price, USD, as a decimal string. */
  tokenPrice: string;
  /** Per-share reference price, USD: documented as converted from the on-chain price, not an exchange quote. */
  referencePrice: string;
  tokenPriceUpdatedAt: number;
};

/** GET /api/v1/dex/market/rwa/tokens → data[] */
export type RwaToken = {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId: string;
  assetType: number;
  tokenName: string;
  tokenSymbol: string;
  tokenLogoUrl: string;
  decimals: string | number;
  underlyingTicker: string;
  underlyingName: string;
  underlyingNameZh: string | null;
  tokenToShareRatio: string;
  tags: string[] | null;
  statusInfo: StatusInfo;
  tokenPrice: string;
  referencePrice: string;
  volume24H: string;
  marketCap: string;
  peRatioTTM: string | null;
};

/** GET /api/v1/dex/market/rwa/underlying-market → data */
export type RwaUnderlyingMarket = {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId: string;
  assetType: number;
  statusInfo: StatusInfo;
  marketData: {
    /** Documented as a string; live it was null for AAPLB (2026-10-10). */
    referencePrice: string | null;
    high52W?: string;
    low52W?: string;
    volumeShares24H?: string;
    avgDailyVolume1Y?: string;
    totalShares?: string;
    marketCap?: string;
    turnoverRate?: string;
    amplitude?: string | null;
    peRatioTTM?: string | null;
    pbRatio?: string | null;
    dividendYield?: string | null;
    latestDividend?: string | null;
  };
};

/** GET /api/v1/dex/market/rwa/underlying-profile → data */
export type RwaUnderlyingProfile = {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId: string;
  underlyingTicker: string;
  underlyingFullName: string;
  assetType: number;
  tokenToShareRatio: string;
  /** Live entries also carry `description` (undocumented). */
  protections: Record<string, { supported: boolean; url: string | null; description?: string | null }>;
  companyInfo: Record<string, unknown> | null;
};

/** GET /api/v1/dex/market/rwa/search → data[] */
export type RwaSearchHit = {
  ticker: string;
  companyName: string;
  assets: Array<{ platformId: string; binanceChainId: string; tokenContractAddress: string; tokenSymbol: string; assetType: number }>;
};

/** GET /api/v1/dex/market/rwa/platforms → data[] */
export type RwaPlatform = {
  platformId: string;
  tickerCount: number;
  chainDistribution: Array<{ binanceChainId: string; tokenCount: number }>;
  website: string | null;
  logoUrl: string | null;
};

/** The credentials are absent: every Binance-backed figure is "not configured", never a guess. */
export class BinanceNotConfigured extends Error {
  override name = "BinanceNotConfigured";
  constructor(readonly missing: string[]) {
    super(
      `Binance Web3 API not configured: set ${missing.join(" and ")} (create a project at https://web3.binance.com/en/dev-portal).`,
    );
  }
}

/** The API answered, and said no. `code` is the envelope's business code (40101, 40102, 42900, …). */
export class BinanceApiError extends Error {
  override name = "BinanceApiError";
  constructor(
    readonly endpoint: string,
    readonly httpStatus: number,
    readonly code: number | null,
    readonly apiMessage: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Binance Web3 API ${endpoint} → HTTP ${httpStatus}${code !== null ? `, code ${code}` : ""}: ${apiMessage}`);
  }
}

export type BinanceCredentials = { apiKey: string; secretKey: string };

export type BinanceClientOptions = {
  credentials: BinanceCredentials | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Clock for X-OC-TIMESTAMP; injectable for tests. */
  now?: () => Date;
  /** `X-OC-RECV-WINDOW`, milliseconds (the API's default is 5000, its maximum 60000). */
  recvWindowMs?: number;
  /** When set, every response is written here as JSON (no credentials), for fixtures and for the DX log. */
  recordDir?: string;
  /**
   * Minimum spacing between any two calls, whatever the endpoint. The docs give 5 requests a second
   * PER ENDPOINT; live, `x-oc-ratelimit-limit: 5` counted down across five different endpoints and the
   * sixth call got 429 (see docs/dx-log.md), so the budget is treated as shared. Default 250 ms.
   */
  minSpacingMs?: number;
  /** Retry an HTTP 429 once, after its Retry-After (capped at 10 s). Default true. */
  retryRateLimited?: boolean;
};

/** Read credentials from the environment; null fields name what is missing. */
export function credentialsFromEnv(env: Record<string, string | undefined> = process.env): {
  credentials: BinanceCredentials | null;
  missing: string[];
} {
  const apiKey = env.BINANCE_WEB3_API_KEY?.trim() ?? "";
  const secretKey = env.BINANCE_WEB3_API_SECRET?.trim() ?? "";
  const missing = [...(apiKey ? [] : ["BINANCE_WEB3_API_KEY"]), ...(secretKey ? [] : ["BINANCE_WEB3_API_SECRET"])];
  return { credentials: missing.length === 0 ? { apiKey, secretKey } : null, missing };
}

/** The documented pre-hash: timestamp + METHOD + requestPath (with /build and the raw query) + body. */
export function preHash(input: { timestamp: string; method: string; requestPath: string; body?: string }): string {
  return `${input.timestamp}${input.method.toUpperCase()}${input.requestPath}${input.body ?? ""}`;
}

/** Base64(HMAC-SHA256(preHash, secretKey)). */
export function sign(preHashString: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(preHashString, "utf8").digest("base64");
}

/** encodeURIComponent, plus the five characters it leaves alone that a URL parser may re-encode on the wire. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `k=v&k=v` percent-encoded (spaces as %20, never +), in the order given — the exact string is both signed and sent. */
export function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encode(k)}=${encode(String(v))}`)
    .join("&");
}

export class BinanceWeb3Client {
  readonly baseUrl: string;
  private readonly credentials: BinanceCredentials | null;
  private readonly missing: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly recvWindowMs: number | undefined;
  private readonly recordDir: string | undefined;
  private readonly minSpacingMs: number;
  private readonly retryRateLimited: boolean;
  private lastCallAt: number | null = null;

  constructor(options: BinanceClientOptions & { missing?: string[] }) {
    this.credentials = options.credentials;
    this.missing = options.missing ?? (options.credentials ? [] : ["BINANCE_WEB3_API_KEY", "BINANCE_WEB3_API_SECRET"]);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.recvWindowMs = options.recvWindowMs;
    this.recordDir = options.recordDir;
    this.minSpacingMs = options.minSpacingMs ?? 250;
    this.retryRateLimited = options.retryRateLimited ?? true;
  }

  /** `BINANCE_WEB3_API_KEY`, `BINANCE_WEB3_API_SECRET`, optional `BINANCE_WEB3_BASE_URL` and `BINANCE_WEB3_RECORD_DIR`. */
  static fromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): BinanceWeb3Client {
    const { credentials, missing } = credentialsFromEnv(env);
    return new BinanceWeb3Client({
      credentials,
      missing,
      baseUrl: env.BINANCE_WEB3_BASE_URL?.trim() || undefined,
      recordDir: env.BINANCE_WEB3_RECORD_DIR?.trim() || undefined,
      fetch: fetchImpl,
    });
  }

  get configured(): boolean {
    return this.credentials !== null;
  }

  /** What is missing, for a "not configured" line. */
  get missingVariables(): string[] {
    return [...this.missing];
  }

  /** The path prefix the signature must carry: the base URL's own path, `/build` by default. */
  private get pathPrefix(): string {
    return new URL(this.baseUrl).pathname.replace(/\/+$/, "");
  }

  /** The headers one GET carries. Exposed for tests; never log the result. */
  signedHeaders(method: string, pathWithQuery: string, body = ""): Record<string, string> {
    if (!this.credentials) throw new BinanceNotConfigured(this.missing);
    const timestamp = this.now().toISOString();
    const requestPath = `${this.pathPrefix}${pathWithQuery}`;
    const headers: Record<string, string> = {
      "X-OC-APIKEY": this.credentials.apiKey,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": sign(preHash({ timestamp, method, requestPath, body }), this.credentials.secretKey),
      accept: "application/json",
    };
    if (this.recvWindowMs !== undefined) headers["X-OC-RECV-WINDOW"] = String(this.recvWindowMs);
    return headers;
  }

  private async spacing(): Promise<void> {
    const wait = this.lastCallAt === null ? 0 : this.lastCallAt + this.minSpacingMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCallAt = Date.now();
  }

  /** One signed GET, unwrapped from its envelope. */
  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    if (!this.credentials) throw new BinanceNotConfigured(this.missing);
    const query = queryString(params);
    const pathWithQuery = query ? `${path}?${query}` : path;
    const send = async () => {
      await this.spacing();
      // Signed afresh on every attempt: a replayed timestamp + signature is refused (40103).
      const headers = this.signedHeaders("GET", pathWithQuery);
      const startedAt = new Date();
      const response = await this.fetchImpl(`${this.baseUrl}${pathWithQuery}`, { method: "GET", headers });
      const text = await response.text();
      this.record(path, pathWithQuery, startedAt, response, text);
      return { response, text };
    };
    let { response, text } = await send();
    if (response.status === 429 && this.retryRateLimited) {
      const seconds = Number(response.headers.get("retry-after"));
      const waitMs = Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000, 10_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      ({ response, text } = await send());
    }

    let envelope: Envelope<T> | null = null;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      // Not JSON: a gateway or bot-protection page. Quoted below.
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    if (!envelope || typeof envelope !== "object" || !("code" in envelope)) {
      const snippet = text.replace(/\s+/g, " ").slice(0, 160) || "(empty body)";
      throw new BinanceApiError(path, response.status, null, `not a JSON envelope: ${snippet}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
    }
    // Documented both ways: the Authentication page lists 4xx statuses, the Market API error page says errors are HTTP 200.
    // So success is the envelope's code, whatever the status line says.
    if (!response.ok || Number(envelope.code) !== 0) {
      throw new BinanceApiError(path, response.status, Number(envelope.code), envelope.msg ?? "", Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
    }
    return envelope.data;
  }

  private record(path: string, pathWithQuery: string, at: Date, response: Response, body: string): void {
    if (!this.recordDir) return;
    mkdirSync(this.recordDir, { recursive: true });
    const name = `${at.toISOString().replace(/[:.]/g, "-")}${path.replace(/[^a-z0-9]+/gi, "_")}.json`;
    const kept = ["content-type", "retry-after", "x-oc-ratelimit-limit", "x-oc-ratelimit-remaining", "x-oc-used-weight", "x-amzn-waf-action"];
    const headers = Object.fromEntries(kept.flatMap((h) => (response.headers.get(h) ? [[h, response.headers.get(h)]] : [])));
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      // keep the text
    }
    writeFileSync(
      join(this.recordDir, name),
      `${JSON.stringify({ request: { method: "GET", url: `${this.baseUrl}${pathWithQuery}`, at: at.toISOString() }, status: response.status, headers, body: parsed }, null, 2)}\n`,
    );
  }

  // --- RWA Data API -------------------------------------------------------------

  /** On-chain token price and per-share reference price, for up to 100 tokens on one chain. */
  rwaPrice(tokenContractAddresses: string[], binanceChainId = BSC_CHAIN_ID): Promise<RwaPrice[]> {
    return this.get<RwaPrice[]>("/api/v1/dex/market/rwa/price", {
      binanceChainId,
      tokenContractAddresses: tokenContractAddresses.map((a) => a.toLowerCase()).join(","),
    });
  }

  /** Every tokenized asset, optionally narrowed to a chain and a platform (`bstock` for Binance's own). */
  rwaTokens(filter: { binanceChainId?: string; platformId?: PlatformId; tabId?: number } = {}): Promise<RwaToken[]> {
    return this.get<RwaToken[]>("/api/v1/dex/market/rwa/tokens", {
      binanceChainId: filter.binanceChainId,
      platformId: filter.platformId,
      tabId: filter.tabId,
    });
  }

  /** The underlying share's market data and trading status for one token. */
  rwaUnderlyingMarket(tokenContractAddress: string, binanceChainId = BSC_CHAIN_ID): Promise<RwaUnderlyingMarket> {
    return this.get<RwaUnderlyingMarket>("/api/v1/dex/market/rwa/underlying-market", {
      binanceChainId,
      tokenContractAddress: tokenContractAddress.toLowerCase(),
    });
  }

  /** The underlying company, the token-to-share ratio and the attestation reports for one token. */
  rwaUnderlyingProfile(tokenContractAddress: string, binanceChainId = BSC_CHAIN_ID): Promise<RwaUnderlyingProfile> {
    return this.get<RwaUnderlyingProfile>("/api/v1/dex/market/rwa/underlying-profile", {
      binanceChainId,
      tokenContractAddress: tokenContractAddress.toLowerCase(),
    });
  }

  /** Tokenized assets matching a ticker, a company name or an address. */
  rwaSearch(keyword: string, platformId?: PlatformId): Promise<RwaSearchHit[]> {
    return this.get<RwaSearchHit[]>("/api/v1/dex/market/rwa/search", { keyword, platformId });
  }

  /** The issuance platforms (Ondo, bStocks) and their token counts per chain. */
  rwaPlatforms(platformId?: PlatformId): Promise<RwaPlatform[]> {
    return this.get<RwaPlatform[]>("/api/v1/dex/market/rwa/platforms", { platformId });
  }
}
