import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { emptyBook, recordBuy, serializeBook } from "../book.ts";
import { leagueWire } from "../register/fakes.ts";
import { agentPaths, appendJsonl, writeFileAtomic } from "../store.ts";
import { dataFace } from "./face.ts";
import { FakeFeast, fakeFaceChain, INDEXER, SITE, WALLET, WBNB } from "./fakes.ts";

/**
 * TEST FAKES, NOT USED AT RUNTIME (task 975, addendum 5): one `FL data demo --json` on a world with every new field in
 * it (a position, a fill, the snapshot's tail, an arena, candles, impacts), and the JSON's shape: every key, nested,
 * with the type of its value. `golden.test.ts` holds `FL data --json` to `golden-data-shape.json`.
 */

export const NOW = Date.parse("2026-10-27T06:00:00Z");
const E18 = 10n ** 18n;
const C1 = getAddress("0x00000000000000000000000000000000000c0d01");

export async function goldenRun() {
  const home = mkdtempSync(join(tmpdir(), "feast-league-975-golden-"));
  const promptPath = join(home, "strategy.md");
  writeFileAtomic(promptPath, "Small trades.\n");
  const planned = planAgent({ name: "demo", promptPath, preset: "steady" });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirmAgent(planned.agent));
  writeFileAtomic(agentPaths(home, "demo").state, serializeBook(recordBuy(emptyBook(), { coin: C1, symbol: "C01", quote: WBNB, coinsOut: 1_000n * E18, bnbInWei: 6n * 10n ** 15n, gasWei: 0n, at: NOW - 20 * 60_000, fundedBy: "wallet", ownLaunch: false, source: "manual" })));
  appendJsonl(agentPaths(home, "demo").log, { at: new Date(NOW - 20 * 60_000).toISOString(), event: "buy.prepared", id: "b1", coin: C1, quotedOut: "1000000000000000000000" });
  appendJsonl(agentPaths(home, "demo").log, { at: new Date(NOW - 20 * 60_000).toISOString(), event: "buy.filled", id: "b1", coin: C1, coinsOut: "990000000000000000000", bnbInWei: "6000000000000000", gasWei: "100000000000000" });
  const coin = { address: C1.toLowerCase(), symbol: "C01", name: "Coin 01", quote: WBNB.toLowerCase(), creator: "0x000000000000000000000000000000000000b0b0", launchedAt: new Date(NOW - 600 * 60_000).toISOString(), priceQuote: 1e-8, volume24hBnb: 2.5, trades24h: 12, holders: 30, lastTradeAt: new Date(NOW).toISOString() };
  const event = { type: "trade", at: new Date(NOW - 30_000).toISOString(), coin: C1.toLowerCase(), quote: WBNB.toLowerCase(), buy: true, quoteAmount: "10000000000000000", coinAmount: "1" };
  const snapshot = { generatedAt: new Date(NOW - 5_000).toISOString(), block: 1, coins: [coin], events: [event], coinsTotal: 9, coinsListed: 1, coinsOmitted: 8, board: { mostActive: [C1.toLowerCase()] }, asOf: { blocksBehind: 1 } };
  const arena = { set: [{ name: "demo.ai", wallet: WALLET.toLowerCase(), pnlBnb: 0.001, pnlUsd: 0.6, seasonBnb: 0.002, trades: 4, model: "claude", note: null, bodyCoin: null, danger: false, eaten: false, viewer: true, airdrop: false }] };
  const feast = new FakeFeast({ snapshot: { status: 200, body: snapshot, etag: '"g"' }, league: { status: 200, body: { ...leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: "2026-10-27T13:00:00.000Z" } }), arena } }, ohlcv: { [C1.toLowerCase()]: [[Math.floor((NOW - 10 * 60_000) / 1_000), String(2n ** 96n), String(2n ** 96n), String(2n ** 96n), String(2n ** 96n), "100000000000000000"]] } });
  const chain = { ...fakeFaceChain({ marks: { [C1.toLowerCase()]: 7n * 10n ** 15n } }), balance: async () => 5n * 10n ** 16n };
  const out = await dataFace({ home, site: SITE, indexer: INDEXER, fetch: feast.fetch, chain, wallet: async () => WALLET, now: () => NOW, impacts: { buy: async () => 0.8, exit: async () => 1.5 } }, { name: "demo", notes: false });
  return { home, out };
}

/** The shape of a JSON value: objects as their sorted keys' shapes, arrays as their first element's, the rest as a type. */
export function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]));
  return typeof value;
}
