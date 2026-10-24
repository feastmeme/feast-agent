import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { MAINNET } from "../../sdk/networks.ts";
import { parseSnapshot } from "../feed/snapshot.ts";
import { exitImpacts, interpolate, picture, serverImpact } from "./picture.ts";
/** Keys only, nested: a number where one path has data and null where the other has none is the same shape. */
const keysOf = (v: unknown): unknown => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, keysOf((v as Record<string, unknown>)[k])])) : "value");

/**
 * Task 975, addendum 6 (lanes 976, 977): the server's picture when `features` names it: no candles and no quoter for
 * what it covers; the same shape as the local fallback; the positions' exit impact estimated from its sale table.
 */

const NOW = Date.parse("2026-10-31T06:00:00Z");
const WBNB = MAINNET.contracts.wrappedNative;
const STOCK = MAINNET.stocks[0]!;
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const [A, B] = [coin(0xc0e1), coin(0xc0e2)];

const row = (c: Address, server: boolean, quote: Address = WBNB) => ({
  address: c.toLowerCase(),
  quote: quote.toLowerCase(),
  symbol: `S${c.slice(-2)}`,
  launchedAt: new Date(NOW - 600 * 60_000).toISOString(),
  priceQuote: 1e-8,
  volume24hBnb: 3,
  trades24h: 40,
  holders: 20,
  ...(server
    ? {
        windows: { m5: { changePct: 1, volumeBnb: 0.1, trades: 3, buys: 2, sells: 1 }, m15: { changePct: 2, volumeBnb: 0.3, trades: 8, buys: 5, sells: 3 }, h1: { changePct: -4, volumeBnb: 1, trades: 30, buys: 15, sells: 15 }, h24: { changePct: 40, volumeBnb: 3, trades: 40, buys: 20, sells: 20 } },
        flow2m: { buys: 2, sells: 1, buyBnb: 0.02, sellBnb: 0.005, netBnb: 0.015, largestBnb: 0.012 },
        impact: { buy: { "0.005": 0.4, "0.01": 0.8, "0.02": 1.6, "0.05": 4 }, sell: { "0.005": 0.5, "0.01": 1, "0.02": 2, "0.05": 5 }, roundTripFeePct: 2.0096 },
        meta: { type: quote === WBNB ? "bnb" : "stock-paired", quoteSymbol: "ignored", marketCapBnb: 12.5, openingCapBnb: 0.5, roundTripFeePct: 2.0096, ageMinutes: 600 },
        ...(quote !== WBNB ? { underlying: { priceBnb: 0.31, change1hPct: 0.2, change24hPct: -1.1, usMarketOpen: false, nextOpenAt: "2026-10-31T13:30:00Z", nextCloseAt: null } } : {}),
        holdersLedger: { holdersChange: { m15: 2, h1: 5, h24: 9 }, holdersNew1h: 6, top1SharePct: 12, top10SharePct: 48, protocolSharePct: 3, creatorSharePct: 1, creatorInitialSharePct: 5, creatorHeldOfInitialPct: 20, creatorSold: true, sampledAt: "2026-10-31T05:59:00Z" },
      }
    : {}),
});
const snapshotOf = (server: boolean) =>
  parseSnapshot({ generatedAt: new Date(NOW - 4_000).toISOString(), block: 1, coins: [row(A, server), row(B, server, STOCK.address)], events: [], ...(server ? { features: ["windows", "flow2m", "impact", "meta", "underlying", "holdersLedger", "launches", "freshness", "mostActive15m"], launches: [], freshness: { blockTimeAgeSeconds: 3 }, mostActive15m: [A.toLowerCase(), B.toLowerCase()] } : {}) })!;

const candle = (minAgo: number) => [Math.floor((NOW - minAgo * 60_000) / 1_000), String(2n ** 96n), String(2n ** 96n), String(2n ** 96n), String(2n ** 96n), "100000000000000000"];

describe("the server's picture", () => {
  it("with the features: no candle request and no quoter call; its windows, flow, meta, impacts, underlying and holders used", async () => {
    let gets = 0;
    let quotes = 0;
    const p = await picture({ now: NOW, snapshot: snapshotOf(true), quoteBnb: async () => 0.01, get: async () => (gets++, { status: 200, body: { rows: [] } }), site: "https://feast.test", cacheDir: null, impact: async () => (quotes++, 9), held: [], own: new Set() });
    expect(gets).toBe(0);
    expect(quotes).toBe(0);
    expect(p.requests).toBe(0);
    expect(p.from).toEqual({ windows: "server", flow2m: "server", impact: "server", meta: "server", launches: "server" });
    const a = p.coins.find((c) => c.coin === A)!;
    expect(a.windows).toEqual({ change: { m5: 1, m15: 2, h1: -4, h24: 40 }, volume: { m5: 0.1, m15: 0.3, h1: 1 } });
    expect(a.flow2m).toEqual({ buys: 2, sells: 1, buyBnb: 0.02, sellBnb: 0.005, netBnb: 0.015, largestBnb: 0.012 });
    expect(a.impactPct).toBe(0.8);
    expect(a.meta).toMatchObject({ type: "bnb", quoteSymbol: "WBNB", marketCapBnb: 12.5, openingCapBnb: 0.5 });
    expect(a.holdersLedger).toMatchObject({ top10SharePct: 48, creatorSold: true });
    const b = p.coins.find((c) => c.coin === B)!;
    expect(b.meta.type).toBe("stock-paired");
    expect(b.underlying).toEqual({ priceBnb: 0.31, change1hPct: 0.2, change24hPct: -1.1, usMarketOpen: false, nextOpenAt: "2026-10-31T13:30:00.000Z", nextCloseAt: null });
    expect(p.market.freshness).toEqual({ blockTimeAgeSeconds: 3 });
  });

  it("without them: the local path, candles and quotes; the same shape for what both compute", async () => {
    let gets = 0;
    let quotes = 0;
    const local = await picture({ now: NOW, snapshot: snapshotOf(false), quoteBnb: async () => 0.01, get: async () => (gets++, { status: 200, body: { rows: [candle(20), candle(10), candle(0)] } }), site: "https://feast.test", cacheDir: null, impact: async () => (quotes++, 0.9), held: [], own: new Set() });
    const server = await picture({ now: NOW, snapshot: snapshotOf(true), quoteBnb: async () => 0.01, site: "https://feast.test", cacheDir: null, held: [], own: new Set() });
    expect(gets).toBeGreaterThan(0);
    expect(quotes).toBeGreaterThan(0);
    expect(local.from).toEqual({ windows: "local", flow2m: "local", impact: "local", meta: "local", launches: "local" });
    const common = (c: (typeof local.coins)[number]) => ({ windows: c.windows, flow2m: c.flow2m, impactPct: c.impactPct, meta: c.meta, ageMinutes: c.ageMinutes });
    for (const k of [A, B]) expect(keysOf(common(local.coins.find((c) => c.coin === k)!))).toEqual(keysOf(common(server.coins.find((c) => c.coin === k)!)));
  });

  it("interpolates an impact between the two nearest sizes; outside the table it gives nothing", () => {
    const t = serverImpact({ sell: [{ bnb: 0.01, pct: 1 }, { bnb: 0.02, pct: 2 }] })!.sell;
    expect(interpolate(t, 0.015)).toBe(1.5);
    expect(interpolate(t, 0.01)).toBe(1);
    expect(interpolate(t, 0.03)).toBeNull();
  });

  it("a position's exit impact: estimated from the sale table when it covers the value (and named so), else the local quote", async () => {
    const pic = await picture({ now: NOW, snapshot: snapshotOf(true), quoteBnb: async () => 0.01, site: "https://feast.test", cacheDir: null, held: [A], own: new Set() });
    const positions = [
      { coin: A, coins: 1000, markBnb: 0.015, costBnb: 0.01, exitImpactPct: null as number | null, exitImpactPctEstimate: null as number | null },
      { coin: A, coins: 9000, markBnb: 0.2, costBnb: 0.2, exitImpactPct: null as number | null, exitImpactPctEstimate: null as number | null },
    ];
    let quoted = 0;
    const out = await exitImpacts(positions, pic, async () => (quoted++, 7.5));
    expect(out).toEqual({ estimated: 1, quoted: 1 });
    expect(positions[0]).toMatchObject({ exitImpactPctEstimate: 1.5, exitImpactPct: null });
    expect(positions[1]).toMatchObject({ exitImpactPct: 7.5 });
  });
});
