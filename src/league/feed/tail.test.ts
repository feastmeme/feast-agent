import { describe, expect, it } from "vitest";

import { cursorAt } from "../events.ts";
import type { Market } from "../market.ts";
import { EventStream } from "./events.ts";
import { FakeFeed, INDEXER, seeded, SITE, snapshotBody, tradeRow, type Asked } from "./fakes.ts";
import { MarketFeed } from "./feed.ts";
import { parseSnapshot, parseTail, SnapshotClient, type FeastSnapshot } from "./snapshot.ts";

/**
 * Two fixes from the site's lane (task 966, the coordinator's addendum 6): the cursors as the site hoists them
 * (`fromCursor` the FIRST event the tail includes, `afterCursor` the exclusive start), and a cut inline tail
 * (`truncated`, `events_url`) read whole from the site instead of filled from the legacy route.
 */

const T0 = Date.parse("2026-10-28T13:00:00Z");
const S = 1_000;
const EVENTS_URL = "/api/v1/snapshot/events";

const snap = (o: { block: number; events?: unknown[]; fromCursor?: string; afterCursor?: string; cursor?: string; truncated?: boolean; events_url?: string }): FeastSnapshot =>
  parseSnapshot({ generatedAt: new Date(T0 + o.block * S).toISOString(), block: o.block, coins: [], events: o.events ?? [], toCursor: o.cursor ?? cursorAt(o.block, 999), ...(o.fromCursor ? { fromCursor: o.fromCursor } : {}), ...(o.afterCursor ? { afterCursor: o.afterCursor } : {}), truncated: o.truncated ?? false, ...(o.events_url ? { events_url: o.events_url } : {}) })!;

function stream(page: Record<string, unknown>[] | null = []) {
  const clock = { t: T0 };
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  const fills: string[] = [];
  const s = new EventStream({ now: () => clock.t, log: (event, fields) => lines.push({ event, fields }), fill: async (cursor) => (fills.push(cursor), page) });
  return { s, clock, lines, fills };
}

describe("the site's cursors (task 966): afterCursor exclusive, fromCursor the first event included", () => {
  it("parses both, events_url only as a path of the site's own, and the position after an empty tail is afterCursor", () => {
    const parsed = parseSnapshot({ coins: [], events: [], fromCursor: cursorAt(105, 3), afterCursor: cursorAt(105, 3), toCursor: null, cursor: null, truncated: false, events_url: EVENTS_URL })!;
    expect(parsed).toMatchObject({ fromCursor: cursorAt(105, 3), afterCursor: cursorAt(105, 3), cursor: cursorAt(105, 3), eventsUrl: EVENTS_URL });
    for (const bad of ["https://elsewhere.test/api/v1/snapshot/events", "//elsewhere.test/x", "/api/v1/snapshot/events?cursor=x", "/api/v1/../admin", "/v1/snapshot/events", 7]) expect(parseSnapshot({ coins: [], events: [], events_url: bad })!.eventsUrl, String(bad)).toBeNull();
    expect(parseTail({ events: [tradeRow(101, 0)], fromCursor: cursorAt(101, 0), afterCursor: cursorAt(100, 0), toCursor: cursorAt(101, 0), truncated: false })).toMatchObject({ coins: [], afterCursor: cursorAt(100, 0), cursor: cursorAt(101, 0) });
    expect(parseTail({ coins: [] })).toBeNull();
  });

  it("the position exactly at afterCursor is no gap, though it is before fromCursor: nothing is filled", async () => {
    const { s, fills, clock, lines } = stream([tradeRow(101, 0)]);
    await s.take(snap({ block: 100, cursor: cursorAt(105, 3) }));
    clock.t += 10 * S;
    // The tail's first event is 106:0; the newest one it leaves out is 105:3, where the position is.
    const out = await s.take(snap({ block: 107, events: [tradeRow(106, 0), tradeRow(107, 0)], fromCursor: cursorAt(106, 0), afterCursor: cursorAt(105, 3), cursor: cursorAt(107, 0) }));
    expect(fills).toEqual([]);
    expect(lines.filter((l) => l.event === "events.gap")).toEqual([]);
    expect(out.map((e) => e.block)).toEqual([106, 107]);
  });

  it("the position before afterCursor is a gap: one fill from the position, taking events up to afterCursor itself", async () => {
    const { s, fills, clock } = stream([tradeRow(101, 0), tradeRow(105, 3), tradeRow(108, 0)]);
    await s.take(snap({ block: 100, cursor: cursorAt(100, 0) }));
    clock.t += 20 * S;
    const out = await s.take(snap({ block: 107, events: [tradeRow(106, 0)], fromCursor: cursorAt(106, 0), afterCursor: cursorAt(105, 3), cursor: cursorAt(106, 0) }));
    expect(fills).toEqual([cursorAt(100, 0)]);
    // 108 is past the tail's start: not the fill's to give.
    expect(out.map((e) => `${e.block}`)).toEqual(["101", "105", "106"]);
    expect(s.position).toEqual({ b: 106, i: 0 });
  });

  it("fromCursor alone is inclusive: its own event comes from the tail, the fill only what is before it", async () => {
    const { s, fills, clock } = stream([tradeRow(101, 0), tradeRow(105, 0), tradeRow(109, 0)]);
    await s.take(snap({ block: 100, cursor: cursorAt(100, 0) }));
    clock.t += 20 * S;
    const out = await s.take(snap({ block: 107, events: [tradeRow(105, 0), tradeRow(106, 0)], fromCursor: cursorAt(105, 0), cursor: cursorAt(106, 0) }));
    expect(fills).toHaveLength(1);
    expect(out.map((e) => e.block)).toEqual([101, 105, 106]);
    // The position on fromCursor itself is no gap.
    clock.t += 40 * S;
    await s.take(snap({ block: 110, events: [tradeRow(106, 0), tradeRow(110, 0)], fromCursor: cursorAt(106, 0), cursor: cursorAt(110, 0) }));
    expect(fills).toHaveLength(1);
  });
});

/** A feed against the stub site: `snapshots(at)` answers /api/v1/snapshot, `tail(at)` the events_url. */
function feedWorld(snapshots: (at: number, asked: Asked) => { status: number; body?: unknown; etag?: string }, tail: (at: number, asked: Asked) => { status: number; body?: unknown; etag?: string }) {
  const clock = { t: T0 };
  const site = new FakeFeed(() => clock.t, snapshots);
  site.other = (url) => (url.origin === SITE && url.pathname === EVENTS_URL ? tail(clock.t, site.asked.at(-1)!) : null);
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  const feed = new MarketFeed({ site: SITE, indexer: INDEXER, fetch: site.fetch, now: () => clock.t, random: seeded(966), market: {} as Market, log: (event, fields) => lines.push({ event, fields }) });
  /** Step the feed every second for `seconds`, collecting what it passes on. */
  const run = async (seconds: number) => {
    const passed: number[] = [];
    for (let i = 0; i < seconds; i += 1) {
      for (const e of await feed.step({ events: true })) passed.push(e.block);
      clock.t += S;
    }
    return passed;
  };
  const tailAsks = () => site.asked.filter((a) => a.url === `${SITE}${EVENTS_URL}`);
  const legacy = () => site.asked.filter((a) => a.url.startsWith(INDEXER));
  return { clock, site, feed, lines, run, tailAsks, legacy };
}

describe("a cut inline tail (truncated, events_url): the whole tail from the site, never the legacy route", () => {
  // Generation g (every 6 s) brings three events; the snapshot's inline events are its newest two only, cut, so every
  // read after the first misses one; the whole tail has them all.
  const gen = (at: number) => Math.floor((at - T0) / 6_000);
  const all = (g: number) => Array.from({ length: 3 * g + 3 }, (_, k) => tradeRow(100 + k, 0));
  const cutSnapshot = (at: number) => {
    const g = gen(at);
    const events = all(g);
    const kept = events.slice(-2);
    const dropped = events.at(-3);
    return { status: 200, etag: `"s${g}"`, body: { ...snapshotBody({ block: 100 + events.length }), events: kept, fromCursor: kept[0]!.cursor, afterCursor: dropped ? dropped.cursor : cursorAt(99, 0), toCursor: kept.at(-1)!.cursor, cursor: kept.at(-1)!.cursor, truncated: dropped !== undefined, events_url: EVENTS_URL } };
  };
  const wholeTail = (at: number) => {
    const g = gen(at);
    const events = all(g);
    return { status: 200, etag: `"t${g}"`, body: { schemaVersion: 1, events, fromCursor: events[0]!.cursor, afterCursor: cursorAt(99, 0), toCursor: events.at(-1)!.cursor, cursor: events.at(-1)!.cursor, truncated: false } };
  };

  it("a cut that misses events after the position: the next slot reads events_url, passes every event once and in order, and the indexer is never asked", async () => {
    const w = feedWorld(cutSnapshot, wholeTail);
    const passed = await w.run(60);
    expect(w.tailAsks().length).toBeGreaterThan(0);
    expect(w.legacy()).toEqual([]);
    // In order, never twice, and nothing between the first position and the last one is missing.
    expect(passed).toEqual([...passed].sort((a, b) => a - b));
    expect(new Set(passed).size).toBe(passed.length);
    expect(passed).toEqual(Array.from({ length: passed.length }, (_, k) => passed[0]! + k));
    // Never two asks within 3 s, tail reads included.
    const at = w.site.asked.map((a) => a.at);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(3 * S);
    expect(w.lines.some((l) => l.event === "events.tail")).toBe(true);
    expect(w.lines.filter((l) => l.event === "events.gap")).toEqual([]);
  });

  it("the tail is asked with its ETag: a 304 answers the tail held", async () => {
    const clock = { t: T0 };
    const site = new FakeFeed(() => clock.t);
    const body = wholeTail(T0 + 60 * S);
    site.other = (url) => (url.pathname === EVENTS_URL ? (site.asked.at(-1)!.headers["if-none-match"] === body.etag ? { status: 304, etag: body.etag } : body) : null);
    const client = new SnapshotClient({ site: SITE, fetch: site.fetch, now: () => clock.t, random: seeded(1) });
    const first = await client.readTail(EVENTS_URL);
    expect(first).toMatchObject({ kind: "tail", tail: { cursor: body.body.toCursor } });
    clock.t += 10 * S;
    const second = await client.readTail(EVENTS_URL);
    expect(site.asked.at(-1)!.headers["if-none-match"]).toBe(body.etag);
    expect(second).toEqual(first);
    // Paced as the snapshot is: not within 3 s of the last ask.
    expect(await client.readTail(EVENTS_URL)).toEqual({ kind: "wait" });
    // Never a path that is not the site's own.
    clock.t += 10 * S;
    expect(await client.readTail("https://elsewhere.test/x")).toEqual({ kind: "wait" });
    expect(site.asked).toHaveLength(2);
  });

  it("a cut that still reaches back to the position: events_url is not read", async () => {
    // Each snapshot keeps the last 10 events; the feed reads every 5–8 s and 2 events come a generation: never short.
    const w = feedWorld(
      (at) => {
        const events = all(gen(at));
        const kept = events.slice(-10);
        return { status: 200, etag: `"k${gen(at)}"`, body: { ...snapshotBody({ block: 100 + events.length }), events: kept, fromCursor: kept[0]!.cursor, afterCursor: events.at(-11)?.cursor ?? cursorAt(99, 0), toCursor: kept.at(-1)!.cursor, cursor: kept.at(-1)!.cursor, truncated: events.length > 10, events_url: EVENTS_URL } };
      },
      wholeTail,
    );
    const passed = await w.run(90);
    expect(passed.length).toBeGreaterThan(10);
    expect(w.tailAsks()).toEqual([]);
    expect(w.legacy()).toEqual([]);
  });

  it("events_url answers 503: the cut snapshot's own events pass, the gap is said, the legacy route is not asked, and the next ask backs off", async () => {
    const w = feedWorld(cutSnapshot, () => ({ status: 503, body: {} }));
    const passed = await w.run(40);
    expect(passed.length).toBeGreaterThan(0);
    expect(new Set(passed).size).toBe(passed.length);
    expect(w.legacy()).toEqual([]);
    expect(w.lines.some((l) => l.event === "events.tail.failed")).toBe(true);
    expect(w.lines.find((l) => l.event === "events.gap")).toMatchObject({ fields: { filled: 0, why: "the whole tail could not be read" } });
    expect(w.lines.some((l) => l.event === "feed.backoff")).toBe(true);
  });

  it("an events_url that is not the site's own path is ignored: the gap goes the legacy way, as before", async () => {
    const w = feedWorld((at) => ({ ...cutSnapshot(at), body: { ...cutSnapshot(at).body, events_url: "https://elsewhere.test/api/v1/snapshot/events" } }), wholeTail);
    await w.run(40);
    expect(w.site.asked.some((a) => a.url.includes("elsewhere"))).toBe(false);
    expect(w.tailAsks()).toEqual([]);
  });
});
