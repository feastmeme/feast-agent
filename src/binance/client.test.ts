import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  BinanceApiError,
  BinanceNotConfigured,
  BinanceWeb3Client,
  credentialsFromEnv,
  preHash,
  queryString,
  sign,
} from "./client.ts";
import { stockReference } from "./stock.ts";

const AAPLB = "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-05-11T10:08:57.715Z");
const CREDENTIALS = { apiKey: "test-api-key", secretKey: "test-secret-key" };

function fakeFetch(routes: Record<string, { status?: number; body: string; headers?: Record<string, string> }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (!route) return new Response("no route", { status: 404 });
    return new Response(route.body, { status: route.status ?? 200, headers: { "content-type": "application/json", ...route.headers } });
  });
}

describe("signing, as the Authentication page specifies it", () => {
  it("builds the pre-hash as timestamp + METHOD + requestPath + body, with the documented example", () => {
    expect(
      preHash({ timestamp: "2026-05-11T10:08:57.715Z", method: "get", requestPath: "/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT" }),
    ).toBe("2026-05-11T10:08:57.715ZGET/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT");
  });
  it("signs Base64(HMAC-SHA256(preHash, secret))", () => {
    const expected = createHmac("sha256", "s3cret").update("abc", "utf8").digest("base64");
    expect(sign("abc", "s3cret")).toBe(expected);
  });
  it("encodes a space as %20, not +, and keeps the given parameter order", () => {
    expect(queryString({ symbol: "ETH USDT", chainId: 1, skip: undefined })).toBe("symbol=ETH%20USDT&chainId=1");
  });
  it("signs exactly the query the URL will carry, apostrophes included", () => {
    const query = queryString({ keyword: "McDonald's (MCD)!" });
    expect(query).toBe("keyword=McDonald%27s%20%28MCD%29%21");
    // What a URL parser puts on the wire is what was signed.
    expect(new URL(`https://web3.binance.com/build/x?${query}`).search).toBe(`?${query}`);
  });
  it("signs the path WITH the /build prefix and sends it on the URL too", async () => {
    const fetchMock = fakeFetch({ "/build/api/v1/dex/market/rwa/price": { body: fixture("rwa-price.aaplb.json") } });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock, now: () => NOW, minSpacingMs: 0 });
    await client.rwaPrice([AAPLB]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const path = "/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a";
    expect(url).toBe(`https://web3.binance.com${path}`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-OC-APIKEY"]).toBe("test-api-key");
    expect(headers["X-OC-TIMESTAMP"]).toBe("2026-05-11T10:08:57.715Z");
    expect(headers["X-OC-SIGN"]).toBe(sign(`2026-05-11T10:08:57.715ZGET${path}`, "test-secret-key"));
  });
});

describe("not configured", () => {
  it("names the missing variables, key and secret alike", () => {
    expect(credentialsFromEnv({}).missing).toEqual(["BINANCE_WEB3_API_KEY", "BINANCE_WEB3_API_SECRET"]);
    expect(credentialsFromEnv({ BINANCE_WEB3_API_KEY: "k" }).missing).toEqual(["BINANCE_WEB3_API_SECRET"]);
    expect(credentialsFromEnv({ BINANCE_WEB3_API_KEY: "k", BINANCE_WEB3_API_SECRET: "s" }).credentials).toEqual({ apiKey: "k", secretKey: "s" });
  });
  it("refuses to call, and never touches the network", async () => {
    const fetchMock = vi.fn();
    const client = BinanceWeb3Client.fromEnv({}, fetchMock as unknown as typeof fetch);
    expect(client.configured).toBe(false);
    await expect(client.rwaPrice([AAPLB])).rejects.toBeInstanceOf(BinanceNotConfigured);
    const reference = await stockReference(client, AAPLB);
    expect(reference.state).toBe("not_configured");
    if (reference.state === "not_configured") expect(reference.message).toMatch(/BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RWA Data API against fixtures", () => {
  it("assembles a stock reference from /rwa/price and /rwa/underlying-market", async () => {
    const fetchMock = fakeFetch({
      "/build/api/v1/dex/market/rwa/price": { body: fixture("rwa-price.aaplb.json") },
      "/build/api/v1/dex/market/rwa/underlying-market": { body: fixture("rwa-underlying-market.aaplb.json") },
    });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock, now: () => NOW, minSpacingMs: 0 });
    const reference = await stockReference(client, AAPLB);
    expect(reference.state).toBe("ok");
    if (reference.state !== "ok") return;
    expect(reference.tokenPriceUsd).toBe(251.4);
    expect(reference.referencePriceUsd).toBe(250.15);
    expect(reference.gap).toBeCloseTo((251.4 - 250.15) / 250.15, 10);
    expect(reference.marketStatus).toBe("closed");
    expect(reference.marketOpen).toBe(false);
    expect(reference.endpoints).toEqual(["/api/v1/dex/market/rwa/price", "/api/v1/dex/market/rwa/underlying-market"]);
  });
  it("still prices the token when the market-status call is refused", async () => {
    const fetchMock = fakeFetch({
      "/build/api/v1/dex/market/rwa/price": { body: fixture("rwa-price.aaplb.json") },
      "/build/api/v1/dex/market/rwa/underlying-market": { status: 429, body: fixture("error-rate-limited.json"), headers: { "retry-after": "1" } },
    });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock, now: () => NOW, minSpacingMs: 0 });
    const reference = await stockReference(client, AAPLB);
    expect(reference.state).toBe("ok");
    if (reference.state === "ok") expect(reference.marketStatus).toBeNull();
  });
  it("treats a missing tokenPrice as unavailable, never as $0", async () => {
    const body = JSON.parse(fixture("rwa-price.aaplb.json")) as { data: Array<Record<string, unknown>> };
    body.data[0]!.tokenPrice = null;
    const fetchMock = fakeFetch({ "/build/api/v1/dex/market/rwa/price": { body: JSON.stringify(body) } });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock, now: () => NOW, minSpacingMs: 0 });
    const reference = await stockReference(client, AAPLB);
    expect(reference.state).toBe("unavailable");
  });
  it("surfaces the API's own code and message on a refusal (HTTP 401, code 40102)", async () => {
    const fetchMock = fakeFetch({ "/build/api/v1/dex/market/rwa/price": { status: 401, body: fixture("error-invalid-signature.json") } });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock, now: () => NOW, minSpacingMs: 0 });
    const error = await client.rwaPrice([AAPLB]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BinanceApiError);
    expect((error as BinanceApiError).code).toBe(40102);
    const reference = await stockReference(client, AAPLB);
    expect(reference.state).toBe("unavailable");
    if (reference.state === "unavailable") expect(reference.message).toMatch(/code 40102: Invalid signature/);
  });
  it("treats a non-zero code as a refusal even under HTTP 200 (the Market API error page says errors are 200)", async () => {
    const fetchMock = fakeFetch({ "/build/api/v1/dex/market/rwa/price": { status: 200, body: fixture("error-rate-limited.json") } });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock, now: () => NOW, minSpacingMs: 0 });
    await expect(client.rwaPrice([AAPLB])).rejects.toThrow(/code 42900/);
  });
  it("quotes a non-JSON answer (a WAF challenge is HTTP 202 with an empty body) instead of crashing on it", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } }));
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock as unknown as typeof fetch, now: () => NOW, minSpacingMs: 0 });
    await expect(client.rwaTokens({ platformId: "bstock", binanceChainId: "56" })).rejects.toThrow(/HTTP 202: not a JSON envelope: \(empty body\)/);
  });
});

describe("live responses recorded with the owner's key (2026-10-10T02:32Z)", () => {
  const live = (suffix: string) => {
    const dir = new URL("./fixtures/live/", import.meta.url);
    const name = readdirSync(dir).find((f) => f.startsWith("2026-10-10T02-32-23") && f.endsWith(`${suffix}.json`));
    return JSON.parse(readFileSync(new URL(name ?? "missing", dir), "utf8")) as { status: number; headers: Record<string, string>; body: unknown };
  };

  it("prices AAPLB from /rwa/price, and copes with underlying-market's null marketStatus and null referencePrice", async () => {
    const price = live("_rwa_price");
    const market = live("_rwa_underlying_market");
    const fetchMock = fakeFetch({
      "/build/api/v1/dex/market/rwa/price": { body: JSON.stringify(price.body) },
      "/build/api/v1/dex/market/rwa/underlying-market": { body: JSON.stringify(market.body) },
    });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock, now: () => NOW, minSpacingMs: 0 });
    const reference = await stockReference(client, AAPLB);
    expect(reference.state).toBe("ok");
    if (reference.state !== "ok") return;
    expect(reference.tokenPriceUsd).toBe(336.3);
    expect(reference.referencePriceUsd).toBe(336.097029);
    expect(reference.underlyingReferenceUsd).toBeNull();
    expect(reference.marketStatus).toBeNull();
    expect(reference.marketOpen).toBe(true);
    expect(reference.reasonCode).toBe("TRADING");
    expect(reference.tokenPriceUpdatedAt).toBe(1791599510696);
  });

  it("shows referencePrice is tokenPrice divided by the token-to-share ratio, for every token priced", () => {
    const price = live("_rwa_price").body as { data: Array<{ tokenContractAddress: string; tokenPrice: string; referencePrice: string }> };
    const skill = JSON.parse(readFileSync(new URL("./fixtures/skill-bstock-list.bsc.live.json", import.meta.url), "utf8")) as {
      bstocksOnBsc: Array<{ contractAddress: string; multiplier: string }>;
    };
    const ratio = new Map(skill.bstocksOnBsc.map((b) => [b.contractAddress, Number(b.multiplier)]));
    expect(price.data).toHaveLength(8);
    for (const row of price.data) {
      expect(Number(row.tokenPrice) / (ratio.get(row.tokenContractAddress) ?? Number.NaN)).toBeCloseTo(Number(row.referencePrice), 5);
    }
  });

  it("recorded the 429: code 42900, Retry-After 1, data as an empty string, no success field", () => {
    const search = live("_rwa_search");
    expect(search.status).toBe(429);
    expect(search.headers["retry-after"]).toBe("1");
    expect(search.body).toEqual({ code: 42900, timestamp: 1791599543616, msg: "Rate limit exceeded", data: "" });
  });

  it("recorded /rwa/tokens listing 46 bStocks, without AAPLB and BNCB, while /rwa/platforms reported 91", () => {
    const tokens = live("_rwa_tokens").body as { data: Array<{ tokenContractAddress: string }> };
    const platforms = live("_rwa_platforms").body as { data: Array<{ tickerCount: number }> };
    const listed = new Set(tokens.data.map((t) => t.tokenContractAddress));
    expect(tokens.data).toHaveLength(46);
    expect(platforms.data[0]?.tickerCount).toBe(91);
    expect(listed.has("0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a")).toBe(false);
    expect(listed.has("0x4902c5ebc598265ed2212b559b042de8a5eeec3f")).toBe(false);
  });
});

describe("politeness", () => {
  it("retries an HTTP 429 once, after Retry-After, signing the retry afresh", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(fixture("error-rate-limited.json"), { status: 429, headers: { "retry-after": "0.05" } })
        : new Response(fixture("rwa-price.aaplb.json"), { status: 200 });
    });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock as unknown as typeof fetch, minSpacingMs: 0 });
    const rows = await client.rwaPrice([AAPLB]);
    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("gives up after one retry and surfaces the 429", async () => {
    const fetchMock = vi.fn(async () => new Response(fixture("error-rate-limited.json"), { status: 429, headers: { "retry-after": "0.01" } }));
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock as unknown as typeof fetch, minSpacingMs: 0 });
    await expect(client.rwaPrice([AAPLB])).rejects.toThrow(/HTTP 429, code 42900/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("spaces calls across endpoints, not per endpoint", async () => {
    const at: number[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      at.push(Date.now());
      const path = new URL(String(input)).pathname;
      return new Response(path.endsWith("/price") ? fixture("rwa-price.aaplb.json") : fixture("rwa-underlying-market.aaplb.json"));
    });
    const client = new BinanceWeb3Client({ credentials: CREDENTIALS, fetch: fetchMock as unknown as typeof fetch, minSpacingMs: 120 });
    await client.rwaPrice([AAPLB]);
    await client.rwaUnderlyingMarket(AAPLB);
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(110);
  });
});
