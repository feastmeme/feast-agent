import { describe, expect, it } from "vitest";

import { planAgent } from "../agent.ts";
import type { LeagueChain } from "../chain.ts";
import { cursorAt, type LeagueEvent } from "../events.ts";
import { Market } from "../market.ts";
import { presetStrategy } from "../presets/logic.ts";
import { makeApi, type Snapshot, type StrategyEvent } from "../strategy.ts";
import { comparePosition, decodeCursor, EventStream } from "./events.ts";
import { BOB, C1, C3, CAROL, launchRow, META_HASH, tradeRow, WBNB } from "./fakes.ts";
import { parseSnapshot, type FeastSnapshot } from "./snapshot.ts";

const T0 = Date.parse("2026-10-26T13:00:00Z");

const snap = (o: { block: number; events?: unknown[]; fromCursor?: string; cursor?: string }): FeastSnapshot =>
  parseSnapshot({ generatedAt: new Date(T0 + o.block * 1_000).toISOString(), block: o.block, coins: [], events: o.events ?? [], cursor: o.cursor ?? cursorAt(o.block, 999), ...(o.fromCursor ? { fromCursor: o.fromCursor } : {}) })!;

function stream(fill?: (cursor: string) => Promise<Record<string, unknown>[] | null>) {
  const clock = { t: T0 };
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  const fills: string[] = [];
  const s = new EventStream({
    now: () => clock.t,
    log: (event, fields) => lines.push({ event, fields }),
    fill: fill ? async (cursor) => (fills.push(cursor), fill(cursor)) : undefined,
  });
  return { s, clock, lines, fills };
}
const blocks = (events: LeagueEvent[]) => events.map((e) => `${e.block}:${(e as { txHash: string }).txHash.slice(-4)}`);

describe("the cursor", () => {
  it("decodes the indexer's base64url {b, i}, the inverse of cursorAt; anything else is no cursor", () => {
    expect(decodeCursor(cursorAt(12_345, 7))).toEqual({ b: 12_345, i: 7 });
    expect(decodeCursor(cursorAt(1, 0))).toEqual({ b: 1, i: 0 });
    for (const bad of ["", "not a cursor", "a/b", Buffer.from('{"b":"x"}').toString("base64url"), Buffer.from("[1,2]").toString("base64url"), null, 5, "x".repeat(300)]) expect(decodeCursor(bad), String(bad)).toBeNull();
    expect(comparePosition({ b: 10, i: 5 }, { b: 11, i: 0 })).toBeLessThan(0);
    expect(comparePosition({ b: 11, i: 2 }, { b: 11, i: 1 })).toBeGreaterThan(0);
    expect(comparePosition({ b: 11, i: 1 }, { b: 11, i: 1 })).toBe(0);
  });
});

describe("the events of each snapshot", () => {
  it("the first snapshot only sets the position (as the head read did); later ones pass only what comes after it, in (block, logIndex) order", async () => {
    const { s } = stream();
    expect(await s.take(snap({ block: 100, events: [tradeRow(99, 0), tradeRow(100, 3)] , cursor: cursorAt(100, 3) }))).toEqual([]);
    expect(s.position).toEqual({ b: 100, i: 3 });
    const shuffled = [tradeRow(102, 0), tradeRow(100, 3), tradeRow(101, 4), tradeRow(100, 2), tradeRow(101, 1), launchRow(102, 1)];
    const out = await s.take(snap({ block: 102, events: shuffled, cursor: cursorAt(102, 1) }));
    expect(out.map((e) => [e.block, e.type])).toEqual([
      [101, "trade"],
      [101, "trade"],
      [102, "trade"],
      [102, "coin.created"],
    ]);
    expect(blocks(out)).toEqual(blocks(out).slice().sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]) || 0));
    expect(out[0]!.txHash).toBe(tradeRow(101, 1).txHash);
    expect(s.position).toEqual({ b: 102, i: 1 });
  });

  it("a snapshot served twice, and an older copy served after a newer one, pass nothing twice", async () => {
    const { s } = stream();
    await s.take(snap({ block: 100 }));
    const newer = snap({ block: 105, events: [tradeRow(103, 0), tradeRow(104, 0)], cursor: cursorAt(104, 0) });
    expect(await s.take(newer)).toHaveLength(2);
    expect(await s.take(newer)).toEqual([]);
    const older = snap({ block: 103, events: [tradeRow(102, 0), tradeRow(103, 0)], cursor: cursorAt(103, 0) });
    expect(await s.take(older)).toEqual([]);
    // The position never moves back.
    expect(s.position).toEqual({ b: 104, i: 0 });
    const next = snap({ block: 106, events: [tradeRow(104, 0), tradeRow(105, 2)], cursor: cursorAt(105, 2) });
    expect((await s.take(next)).map((e) => e.block)).toEqual([105]);
  });

  it("an event without a readable position is never passed: it could be one already seen", async () => {
    const { s } = stream();
    await s.take(snap({ block: 100 }));
    const odd = { ...tradeRow(101, 0), blockNumber: "soon", cursor: "%%" };
    expect(await s.take(snap({ block: 102, events: [odd, tradeRow(101, 1)], cursor: cursorAt(101, 1) }))).toHaveLength(1);
  });
});

describe("gaps (ruling C1: fromCursor, a rolling tail of at least 120 s)", () => {
  it("a gap under 120 s: exactly one legacy page from the position, then the snapshot; at most one fill every 30 s", async () => {
    const page = [tradeRow(101, 0), tradeRow(102, 0), tradeRow(110, 0)];
    const { s, fills, clock, lines } = stream(async () => page);
    await s.take(snap({ block: 100, cursor: cursorAt(100, 0) }));
    clock.t += 60_000;
    // The snapshot's tail starts after block 105: 101–105 would be lost without the fill.
    const out = await s.take(snap({ block: 112, events: [tradeRow(106, 0), tradeRow(110, 0)], fromCursor: cursorAt(105, 999), cursor: cursorAt(110, 0) }));
    expect(fills).toEqual([cursorAt(100, 0)]);
    expect(out.map((e) => e.block)).toEqual([101, 102, 106, 110]);
    expect(lines.find((l) => l.event === "events.gap")).toMatchObject({ fields: { filled: 2 } });
    // Another gap 10 s later: no second fill inside 30 s.
    clock.t += 10_000;
    await s.take(snap({ block: 130, events: [tradeRow(125, 0)], fromCursor: cursorAt(120, 0), cursor: cursorAt(125, 0) }));
    expect(fills).toHaveLength(1);
  });

  it("a gap that starts more than 120 s back: no fill (those events would be dropped anyway), events.gap once", async () => {
    const { s, fills, clock, lines } = stream(async () => [tradeRow(101, 0)]);
    await s.take(snap({ block: 100 }));
    clock.t += 180_000;
    const out = await s.take(snap({ block: 300, events: [tradeRow(290, 0)], fromCursor: cursorAt(200, 0), cursor: cursorAt(290, 0) }));
    expect(fills).toEqual([]);
    expect(out.map((e) => e.block)).toEqual([290]);
    expect(lines.filter((l) => l.event === "events.gap")).toHaveLength(1);
    expect(lines.find((l) => l.event === "events.gap")!.fields).toMatchObject({ filled: 0, why: "the gap starts more than 120 s back" });
  });

  it("no gap when the tail reaches back to the position: nothing is filled", async () => {
    const { s, fills, clock } = stream(async () => []);
    await s.take(snap({ block: 100, cursor: cursorAt(100, 0) }));
    clock.t += 30_000;
    await s.take(snap({ block: 130, events: [tradeRow(101, 0)], fromCursor: cursorAt(99, 0), cursor: cursorAt(101, 0) }));
    expect(fills).toEqual([]);
  });

  it("without fromCursor a gap cannot be told from a quiet spell: never filled, events.gap.unknown once a run", async () => {
    const { s, fills, lines } = stream(async () => []);
    await s.take(snap({ block: 100 }));
    for (let b = 110; b < 200; b += 10) await s.take(snap({ block: b, events: [tradeRow(b - 1, 0)], cursor: cursorAt(b - 1, 0) }));
    expect(fills).toEqual([]);
    expect(lines.filter((l) => l.event === "events.gap.unknown")).toHaveLength(1);
  });

  it("a fill that fails is not asked again inside 30 s, and the snapshot's own events still pass", async () => {
    const { s, fills, clock } = stream(async () => null);
    await s.take(snap({ block: 100 }));
    clock.t += 20_000;
    const out = await s.take(snap({ block: 120, events: [tradeRow(115, 0)], fromCursor: cursorAt(110, 0), cursor: cursorAt(115, 0) }));
    expect(out.map((e) => e.block)).toEqual([115]);
    expect(fills).toHaveLength(1);
  });
});

describe("the presets read the snapshot's events as they read the indexer's", () => {
  const chain = {
    coinInfo: async (coin: string) => ({ coin, quote: WBNB, creator: CAROL, poolId: "0x01", coinIsCurrency0: true, symbol: "C", name: "C" }),
    quoteBnbE18: async () => 10n ** 18n,
    markWei: async () => 0n,
  } as unknown as LeagueChain;

  async function seen(rows: Record<string, unknown>[], now: number): Promise<StrategyEvent[]> {
    const { s } = stream();
    await s.take(snap({ block: 100 }));
    const events = await s.take(snap({ block: 200, events: rows, cursor: cursorAt(199, 0) }));
    const market = new Market(chain, { log: () => {} });
    return (await Promise.all(events.map((e) => market.ingest(e, now, new Set())))).flat();
  }
  const snapshotFor = (now: number): Snapshot => ({ now, balanceBnb: 1, limits: { maxTradeBnb: 0.02 } as never, warmup: null, coins: [], positions: [], trades: [], holders: {}, launchesByCreator: {}, feast: C1, launched: null, stale: null });

  it("copy: a trade carries the payer's full address, and a followed wallet's buy is queued to copy", async () => {
    const at = Date.parse(String(tradeRow(150, 0).at));
    const [event] = await seen([tradeRow(150, 0, { payer: BOB.toLowerCase(), quoteAmount: "100000000000000000" })], at + 5_000);
    expect(event).toMatchObject({ type: "trade", payer: BOB, side: "buy", coin: C1 });
    const planned = planAgent({ name: "c", preset: "copy", params: { wallets: [BOB] } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const state: Record<string, unknown> = {};
    const { api } = makeApi(snapshotFor(at + 5_000), { params: planned.agent.params, state, source: "preset", ttlMs: 30_000, log: () => {} });
    presetStrategy("copy").onEvent!(api, event!);
    expect(state.pending).toMatchObject([{ coin: C1 }]);
  });

  it("sniper: a coin.created carries hasMetadata and the creator's full address, and a fresh one is bought", async () => {
    const at = Date.parse(String(launchRow(160, 0).at));
    const [event] = await seen([launchRow(160, 0, { metadataHash: META_HASH, creator: CAROL.toLowerCase() })], at + 8_000);
    expect(event).toMatchObject({ type: "coin.created", coin: C3, creator: CAROL, hasMetadata: true });
    const planned = planAgent({ name: "s", preset: "sniper" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const { api, intents } = makeApi(snapshotFor(at + 8_000), { params: planned.agent.params, state: {}, source: "preset", ttlMs: 30_000, log: () => {} });
    presetStrategy("sniper").onEvent!(api, event!);
    expect(intents).toMatchObject([{ kind: "buy", coin: C3 }]);
  });
});
