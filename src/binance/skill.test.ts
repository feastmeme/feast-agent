import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { BinanceApiError, BinanceWeb3Client } from "./client.ts";
import { SKILL_USER_AGENT, parseSkillRwaDynamic, skillRwaDynamic } from "./skill.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const AAPLB = "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A";

describe("the keyless Wallet Skill (recorded live)", () => {
  it("reads a bStock's on-chain price and its share multiplier; the stock price is null on a Saturday", () => {
    const parsed = parseSkillRwaDynamic(JSON.parse(fixture("skill-rwa-dynamic.aaplb.live.json")));
    expect(parsed?.symbol).toBe("AAPLB");
    expect(parsed?.ticker).toBe("AAPL");
    expect(parsed?.type).toBe(3);
    expect(parsed?.tokenPriceUsd).toBeCloseTo(336.5431, 3);
    expect(parsed?.sharesMultiplier).toBeCloseTo(1.0006039, 6);
    expect(parsed?.impliedSharePriceUsd).toBeCloseTo(336.5431 / 1.000603906, 3);
    expect(parsed?.stockPriceUsd).toBeNull();
    expect(parsed?.gap).toBeNull();
    // Recorded on a Saturday: "TRADING" and openState true while marketStatus is null.
    expect(parsed?.reasonCode).toBe("TRADING");
  });
  it("identifies itself the way the skill asks, and lower-cases the address", async () => {
    const fetchMock = vi.fn(async () => new Response(fixture("skill-rwa-dynamic.aaplb.live.json")));
    await skillRwaDynamic(AAPLB, { fetch: fetchMock as unknown as typeof fetch });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("chainId=56&contractAddress=0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(SKILL_USER_AGENT);
  });
  it("is null, not an exception, when the skill does not answer", async () => {
    expect(parseSkillRwaDynamic({ code: "000001", data: null })).toBeNull();
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    expect(await skillRwaDynamic(AAPLB, { fetch: fetchMock as unknown as typeof fetch })).toBeNull();
  });
});

describe("the RWA Data API without a key (recorded live)", () => {
  it("is HTTP 401 with code 40101 'API Key is required' and data as an empty string", async () => {
    const fetchMock = vi.fn(async () => new Response(fixture("rwa-nokey-401.live.json"), { status: 401, headers: { "x-oc-blocked-by": "AuthenticationFilter/40101" } }));
    // Credentials present but rejected: the client must surface the API's own words.
    const client = new BinanceWeb3Client({ credentials: { apiKey: "x", secretKey: "y" }, fetch: fetchMock as unknown as typeof fetch, minSpacingMs: 0 });
    const error = await client.rwaTokens({ platformId: "bstock" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BinanceApiError);
    expect((error as BinanceApiError).httpStatus).toBe(401);
    expect((error as BinanceApiError).code).toBe(40101);
    expect((error as BinanceApiError).apiMessage).toBe("API Key is required");
  });
});
