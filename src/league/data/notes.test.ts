import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dataFace, type FaceDeps } from "./face.ts";
import { BOB, C1, C2, CAROL, EVIL, FakeFeast, fakeFaceChain, INDEXER, SITE, WALLET, type Answer } from "./fakes.ts";
import { notesCachePath } from "./notes.ts";

/**
 * `FL data`'s notes section (task 968, gap C13): the public notes feed of the last 2 hours, the crowd per coin, read
 * once a call, cached 60 s, and not asked for 10 minutes after a 404. Made-up agents and wallets only.
 */

const NOW = Date.parse("2026-10-29T05:00:00Z");
const MIN = 60_000;
let homes: string[] = [];
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

const note = (agent: { name: string | null; wallet: string }, coin: string | null, text: string, minutesAgo: number, over: Record<string, unknown> = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  agent,
  model: "claude",
  ts: new Date(NOW - minutesAgo * MIN).toISOString(),
  text,
  tx: null,
  coin: coin ? { address: coin, symbol: coin === C1 ? "NOODFEED" : "CATFEED" } : null,
  side: "buy",
  sizeBnb: 0.01,
  dev: false,
  ...over,
});

function world(answer: Answer) {
  const home = mkdtempSync(join(tmpdir(), "feast-league-notes-"));
  homes.push(home);
  const feast = new FakeFeast({});
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === SITE && url.pathname === "/api/league/notes" && (init?.method ?? "GET") === "GET") {
      feast.calls.push(`GET ${url.origin}${url.pathname}${url.search}`);
      const a = world.answer;
      if (a === "refused" || a === "timeout") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }
    return feast.fetch(input, init);
  }) as typeof globalThis.fetch;
  world.answer = answer;
  const clock = { now: NOW };
  const deps: FaceDeps = { home, site: SITE, indexer: INDEXER, fetch, chain: fakeFaceChain(), wallet: async () => WALLET, now: () => clock.now };
  const notesCalls = () => feast.calls.filter((c) => c.includes("/api/league/notes"));
  return { home, clock, deps, notesCalls, run: (input: Parameters<typeof dataFace>[1] = {}) => dataFace(deps, input) };
}
world.answer = { status: 404, body: {} } as Answer;

const FEED = {
  status: 200,
  body: {
    schemaVersion: 1,
    next: null,
    notes: [
      note({ name: "maplegrin.ai", wallet: BOB }, C1, "bought: holders up", 5),
      note({ name: "maplegrin.ai", wallet: BOB }, C1, "added", 20),
      note({ name: "oakmoss.ai", wallet: CAROL }, C1, "momentum", 30),
      note({ name: null, wallet: "0x000000000000000000000000000000000000d00d" }, C1, "me too", 40),
      note({ name: "fernlight.ai", wallet: "0x000000000000000000000000000000000000f00d" }, C2, EVIL, 50),
      note({ name: "quiet.ai", wallet: "0x000000000000000000000000000000000000beef" }, null, "watching, no trade", 60),
    ],
  },
} as const;

describe("FL data's notes section", () => {
  it("one GET with since (2 h ago) and limit; the crowd per coin by distinct agents; texts and names marked untrusted", async () => {
    const w = world(FEED);
    const out = await w.run({});
    expect(w.notesCalls()).toEqual([`GET ${SITE}/api/league/notes?since=${encodeURIComponent(new Date(NOW - 120 * MIN).toISOString())}&limit=100`]);
    const data = out.data as Record<string, any>;
    expect(data.notesAvailable).toBe(true);
    expect(data.notes.items).toHaveLength(6);
    expect(data.notes.items[0]).toMatchObject({ agent: { untrusted: true, text: "maplegrin.ai" }, model: "claude", coin: C1, symbol: { untrusted: true, text: "NOODFEED" }, side: "buy", sizeBnb: 0.01, text: { untrusted: true, text: "bought: holders up" } });
    // C1: maplegrin (twice), oakmoss, and one named only by its wallet: 3 agents of the 4 that noted a coin.
    expect(data.notes.crowd).toEqual([
      { coin: C1, symbol: { untrusted: true, text: "NOODFEED" }, agents: 3, share: 0.75 },
      { coin: C2, symbol: { untrusted: true, text: "CATFEED" }, agents: 1, share: 0.25 },
    ]);
    expect(data.notes.agents).toBe(4);
    expect(data.untrusted).toEqual(expect.arrayContaining(["notes.items[].text", "notes.items[].agent", "notes.crowd[].symbol"]));
    expect(data.missing).not.toContain("notes");
    expect(out.text).toContain("the crowd: NOODFEED 0x0000…");
    expect(out.text).toMatch(/3 agents \(75%\)/);
    expect(out.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/);
  });

  it("no wallet address in the home's cache; a call within 60 s asks nothing", async () => {
    const w = world(FEED);
    await w.run({});
    const cached = readFileSync(notesCachePath(w.home), "utf8").toLowerCase();
    for (const wallet of [BOB, CAROL, "0x000000000000000000000000000000000000d00d", WALLET]) expect(cached).not.toContain(wallet.slice(2).toLowerCase());
    w.clock.now += 30_000;
    await w.run({});
    expect(w.notesCalls()).toHaveLength(1);
    w.clock.now += 40_000;
    await w.run({});
    expect(w.notesCalls()).toHaveLength(2);
  });

  it("a 404 (964 not deployed): an empty section, notesAvailable false, notes listed missing; not asked again for 10 minutes", async () => {
    const w = world({ status: 404, body: { error: "not-found" } });
    const out = await w.run({});
    const data = out.data as Record<string, any>;
    expect(data).toMatchObject({ notesAvailable: false, notes: { available: false, items: [], crowd: [] } });
    expect(data.missing).toContain("notes");
    expect(out.code).toBe(0);
    expect(out.text).toContain("Notes: feast.meme's public notes feed is not available yet.");
    for (let i = 0; i < 5; i += 1) {
      w.clock.now += MIN;
      await w.run({});
    }
    expect(w.notesCalls()).toHaveLength(1);
    w.clock.now += 6 * MIN;
    await w.run({});
    expect(w.notesCalls()).toHaveLength(2);
  });

  it("a failure that is not a 404: the last copy, marked stale, and never a problem of the call", async () => {
    const w = world(FEED);
    await w.run({});
    world.answer = { status: 503, body: {} };
    w.clock.now += 2 * MIN;
    const out = await w.run({});
    const data = out.data as Record<string, any>;
    expect(data.notes).toMatchObject({ available: true, stale: { reason: "HTTP 503" } });
    expect(data.notes.items.length).toBeGreaterThan(0);
    expect(data.problems).toEqual([]);
  });

  it("--no-notes: no request, no section", async () => {
    const w = world(FEED);
    const out = await w.run({ notes: false });
    expect(w.notesCalls()).toEqual([]);
    expect(out.data).not.toHaveProperty("notes");
    expect(existsSync(notesCachePath(w.home))).toBe(false);
  });
});
