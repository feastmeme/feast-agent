import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { bodyCoinNames, bodyCoinPlan, launchesBy, normalizeXHandle, type BodyCoinInput } from "./claims.ts";

// Synthetic addresses only.
const WALLET: Address = getAddress("0x000000000000000000000000000000000000a11c");
const OTHER: Address = getAddress("0x000000000000000000000000000000000000b0b0");
const COIN_A: Address = getAddress("0x000000000000000000000000000000000000feed");
const COIN_B: Address = getAddress("0x000000000000000000000000000000000000beef");
const COIN_C: Address = getAddress("0x000000000000000000000000000000000000c0c0");

const creators = (table: Record<string, Address | null | "unreadable">) => async (coin: Address) => table[coin.toLowerCase()] ?? null;
const input = (over: Partial<BodyCoinInput> = {}): BodyCoinInput => ({
  wallet: WALLET,
  named: null,
  kept: null,
  bookLaunch: null,
  indexed: [],
  preset: "sniper",
  creatorOf: creators({ [COIN_A.toLowerCase()]: WALLET, [COIN_B.toLowerCase()]: WALLET, [COIN_C.toLowerCase()]: OTHER }),
  ...over,
});

describe("the body coin decision tree (PLAN-941 §2)", () => {
  it("keeps the body coin the page fixed for this season, whatever else is offered", async () => {
    expect(await bodyCoinPlan(input({ kept: { bodyCoin: COIN_B.toLowerCase(), seated: true }, named: COIN_A, bookLaunch: COIN_A }))).toMatchObject({ kind: "coin", coin: COIN_B, why: "fixed" });
  });

  it("takes a named coin only when the chain says this wallet launched it", async () => {
    expect(await bodyCoinPlan(input({ named: COIN_A.toLowerCase() }))).toMatchObject({ kind: "coin", coin: COIN_A, why: "named" });
    expect(await bodyCoinPlan(input({ named: COIN_C }))).toEqual({ kind: "not-yours", coin: COIN_C });
    expect(await bodyCoinPlan(input({ named: "0x0000000000000000000000000000000000000009" }))).toMatchObject({ kind: "not-yours" });
    expect(await bodyCoinPlan(input({ named: "not an address" }))).toEqual({ kind: "bad-address", given: "not an address" });
  });

  it("an unseated registration's coin can still change", async () => {
    expect(await bodyCoinPlan(input({ kept: { bodyCoin: COIN_B, seated: false }, named: COIN_A }))).toMatchObject({ kind: "coin", coin: COIN_A, why: "named" });
  });

  it("prefers this agent's own launch, then the indexer's newest", async () => {
    expect(await bodyCoinPlan(input({ bookLaunch: COIN_A, indexed: [{ coin: COIN_B, launchedAt: 2 }, { coin: COIN_A, launchedAt: 1 }] }))).toMatchObject({ kind: "coin", coin: COIN_A, why: "book", others: [COIN_B] });
    expect(await bodyCoinPlan(input({ indexed: [{ coin: COIN_A, launchedAt: 5 }] }))).toMatchObject({ kind: "coin", coin: COIN_A, why: "only", others: [] });
    expect(await bodyCoinPlan(input({ indexed: [{ coin: COIN_B, launchedAt: 9 }, { coin: COIN_A, launchedAt: 5 }] }))).toMatchObject({ kind: "coin", coin: COIN_B, why: "newest", others: [COIN_A] });
  });

  it("skips an indexed coin the chain does not give to this wallet", async () => {
    expect(await bodyCoinPlan(input({ indexed: [{ coin: COIN_C, launchedAt: 9 }, { coin: COIN_A, launchedAt: 5 }] }))).toMatchObject({ kind: "coin", coin: COIN_A });
  });

  it("never takes a chain read that failed for a yes", async () => {
    const unreadable = creators({ [COIN_A.toLowerCase()]: "unreadable" });
    expect(await bodyCoinPlan(input({ named: COIN_A, creatorOf: unreadable }))).toEqual({ kind: "unreadable" });
    expect(await bodyCoinPlan(input({ indexed: [{ coin: COIN_A, launchedAt: 1 }], creatorOf: unreadable }))).toEqual({ kind: "unreadable" });
    expect(await bodyCoinPlan(input({ named: COIN_A, creatorOf: async () => Promise.reject(new Error("rpc down")) }))).toEqual({ kind: "unreadable" });
  });

  it("asks for the address when the indexer cannot be read, rather than guess or launch", async () => {
    expect(await bodyCoinPlan(input({ indexed: null }))).toEqual({ kind: "ask-address" });
  });

  it("waits for a launch-and-run agent's own launch, and otherwise offers one", async () => {
    expect(await bodyCoinPlan(input({ preset: "launch" }))).toEqual({ kind: "await-preset-launch" });
    expect(await bodyCoinPlan(input({ preset: "dca" }))).toEqual({ kind: "launch" });
    expect(await bodyCoinPlan(input({ preset: null }))).toEqual({ kind: "launch" });
  });
});

describe("the body coin's name and ticker", () => {
  it("come from the Agent ID", () => {
    expect(bodyCoinNames("maplegrin")).toEqual({ name: "maplegrin.ai", symbol: "MAPLEGRIN" });
    expect(bodyCoinNames("agent007x")).toEqual({ name: "agent007x.ai", symbol: "AGENT007X" });
  });

  it("fit the factory's 32 characters and 10-character ticker for a long Agent ID", () => {
    const long = "a".repeat(64);
    const names = bodyCoinNames(long);
    expect(names.name.length).toBeLessThanOrEqual(32);
    expect(names.name.endsWith(".ai")).toBe(true);
    expect(names.symbol).toMatch(/^[A-Z0-9]{1,10}$/);
  });
});

describe("the X handle claim (930's rule)", () => {
  it("takes @h, h, and x.com or twitter.com links", () => {
    expect(normalizeXHandle("@maple_grin")).toBe("maple_grin");
    expect(normalizeXHandle(" maple_grin ")).toBe("maple_grin");
    expect(normalizeXHandle("https://x.com/maple_grin")).toBe("maple_grin");
    expect(normalizeXHandle("twitter.com/maple_grin/status/1")).toBe("maple_grin");
    expect(normalizeXHandle("https://mobile.twitter.com/Maple?s=20")).toBe("Maple");
  });

  it("refuses what is not one", () => {
    expect(normalizeXHandle("a".repeat(16))).toBeNull();
    expect(normalizeXHandle("maple grin")).toBeNull();
    expect(normalizeXHandle("maple.ai")).toBeNull();
    expect(normalizeXHandle("")).toBeNull();
    expect(normalizeXHandle(undefined)).toBeNull();
  });
});

describe("the wallet's launches, from the indexer", () => {
  const fake = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("keeps this wallet's rows, newest first", async () => {
    const rows = [
      { coin: COIN_A.toLowerCase(), creator: WALLET.toLowerCase(), launchedAt: "2026-10-20T00:00:00.000Z" },
      { coin: COIN_C.toLowerCase(), creator: OTHER.toLowerCase(), launchedAt: "2026-10-21T00:00:00.000Z" },
      { coin: COIN_B.toLowerCase(), creator: WALLET.toLowerCase(), launchedAt: "2026-10-21T02:55:04.000Z" },
    ];
    const launches = await launchesBy(WALLET, { indexer: "https://indexer.test", fetch: fake({ schemaVersion: 1, data: rows }) });
    expect(launches?.map((l) => l.coin)).toEqual([COIN_B, COIN_A]);
  });

  it("is null when the indexer cannot be read, and empty when the wallet launched nothing", async () => {
    expect(await launchesBy(WALLET, { indexer: "https://indexer.test", fetch: fake({ error: "x" }, 503) })).toBeNull();
    expect(await launchesBy(WALLET, { indexer: "https://indexer.test", fetch: fake({ nope: 1 }) })).toBeNull();
    expect(await launchesBy(WALLET, { indexer: "https://indexer.test", fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch })).toBeNull();
    expect(await launchesBy(WALLET, { indexer: "https://indexer.test", fetch: fake({ data: [] }) })).toEqual([]);
  });
});
