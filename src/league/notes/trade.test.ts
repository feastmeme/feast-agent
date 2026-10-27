import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import type { HostCall } from "../ask/host.ts";
import { coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody } from "../feed/fakes.ts";
import { fakeClock, marketWorld } from "../prompt/fakes.ts";
import { recordHostAction } from "../prompt/host.ts";
import { leagueWire } from "../register/fakes.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths, writeJsonAtomic } from "../store.ts";
import { readNotes } from "./queue.ts";
import { readHoldLine } from "./hold.ts";
import { HOLD_LINE_EVERY_MS, KEEPER_WHY, STOP_LOSS_WHY, WHY_MAX, cleanWhy, holdLineDue, holdNoteText, tradeNoteText, tradeWhy } from "./trade.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/**
 * Task 1020 (the owner's ruling C for league-v5.1.4): every trade the runtime makes and confirms posts one public note,
 * from any source: the asked AI's answer, the host's FL buy or FL sell, the floor keeper. Made-up addresses throughout.
 */

const MIN = 60_000;
const T0 = Date.parse("2026-10-29T06:00:00Z");
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const COINS = [coin(0xc0e1), coin(0xc0e2), coin(0xc0e3)];
const SYMBOLS = ["NOODFEED", "KOIFEED", "MOTHFEED"];
const OWN = coin(0xb0d1e);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("the note's text", () => {
  it("bought / sold <coin> for <size> BNB: <why>; without a why, no colon part", () => {
    expect(tradeNoteText({ side: "buy", symbol: "NOODFEED", bnb: 0.006, why: "the crowd is buying it" })).toBe("bought NOODFEED for 0.006 BNB: the crowd is buying it");
    expect(tradeNoteText({ side: "sell", symbol: "KOIFEED", bnb: 0.0058812345, why: null })).toBe("sold KOIFEED for 0.005881 BNB");
    expect(tradeNoteText({ side: "buy", symbol: "NOODFEED", bnb: 0.006, why: KEEPER_WHY })).toBe("bought NOODFEED for 0.006 BNB: keeper: meeting today's activity floor");
  });

  it("never an address or a hash, in the coin or the why; one line, at most 140 characters of why", () => {
    const address = "0x00000000000000000000000000000000000c0e01";
    const hash = `0x${"ab".repeat(32)}`;
    const text = tradeNoteText({ side: "buy", symbol: `X${address}`, bnb: 0.01, why: `copying ${address} after ${hash} and 0x00c0…0e01\nnew line` });
    expect(text).not.toMatch(/0x[0-9a-f]{4,}/i);
    expect(text).not.toContain("\n");
    expect(text).toBe("bought X for 0.01 BNB: copying after and new line");
    expect([...cleanWhy("w".repeat(500))!].length).toBe(WHY_MAX);
    expect(cleanWhy("   ")).toBeNull();
    expect(cleanWhy(42)).toBeNull();
    expect(tradeNoteText({ side: "sell", symbol: null, bnb: 0.002, why: null })).toBe("sold a coin for 0.002 BNB");
    // An escape cannot split a hex run past the scrub; a bare hash (no 0x) goes too.
    expect(tradeNoteText({ side: "buy", symbol: "0x\u001b[mdeadbeefcafe1234", bnb: 0.01, why: `see ${"cd".repeat(32)} done` })).toBe("bought a coin for 0.01 BNB: see done");
  });

  it("the why by source: the AI's or the host's own, the keeper's line, a preset's, the hard stop-loss's; a script none", () => {
    const prompt = { track: "prompt", preset: "steady" };
    expect(tradeWhy({ source: "manual", why: "rotation into strength" }, prompt)).toBe("rotation into strength");
    expect(tradeWhy({ source: "manual" }, prompt)).toBeNull();
    expect(tradeWhy({ source: "preset" }, prompt)).toBe(KEEPER_WHY);
    expect(tradeWhy({ source: "preset" }, { track: "preset", preset: "dca" })).toBe("the dca preset");
    expect(tradeWhy({ source: "runtime", reason: "L6 backstop: 50% below entry" }, prompt)).toBe(STOP_LOSS_WHY);
    expect(tradeWhy({ source: "script", why: "anything" }, { track: "script", preset: null })).toBeNull();
  });
});

function setup(options: { ask: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-1020-notes-"));
  dirs.push(dir);
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, "Trade the busiest coin small; keep the floor early.\n");
  const planned = planAgent({ name: "demo", promptPath, preset: "steady", ...(options.ask ? { ask: { every: 5, with: "claude", model: null } } : {}) });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  const home = join(dir, "home");
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(T0 - 2 * 86_400_000)), league: { waitForSeason: true } });
  writeJsonAtomic(join(agentPaths(home, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: OWN, launchTx: null });
  return { home };
}

function world(c: ReturnType<typeof fakeClock>) {
  const rows = COINS.map((k, i) => coinRow(k, { symbol: SYMBOLS[i], volume24hBnb: 9 - i, trades24h: 90 - i, launchedAt: "2026-10-20T00:00:00.000Z" }));
  const feed = new FakeFeed(c.now, () => ({ status: 200, body: snapshotBody({ coins: rows }), etag: '"d2"' }));
  feed.other = (url) => (url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } }) } : null);
  const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: i === 0 ? "MAPLEFEED" : SYMBOLS[i - 1]! })), now: c.now });
  return { feed, w };
}

const idOf = (pack: string, symbol: string) => new RegExp(`^(c\\d+) \\| ${symbol} \\|`, "m").exec(pack)?.[1] ?? null;
const answer = (a: Record<string, unknown>): HostCall => ({ ok: true, answer: { action: "hold", coin: null, amountBnb: null, fraction: null, reason: "", why: null, memo: "", ...a } });
const hold = async () => answer({ reason: "nothing to do" });
const noteTexts = (home: string) => readNotes(home, "demo").map((n) => n.text);
const filled = (home: string) => (readNotesLog(home).match(/"event":"(buy|sell)\.filled"/g) ?? []).length;
const readNotesLog = (home: string) => {
  try {
    return readFileSync(agentPaths(home, "demo").log, "utf8");
  } catch {
    return "";
  }
};

async function run(home: string, c: ReturnType<typeof fakeClock>, feed: FakeFeed, w: ReturnType<typeof marketWorld>, until: number, askHost?: (o: { pack: string }) => Promise<HostCall>) {
  return runAgent({ home, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(1), noJitter: true, loopMs: 15_000, pollMs: 30_000, maxRuntimeMs: until - c.now(), out: () => {}, ...(askHost ? { askHost: askHost as never } : {}) });
}

describe("a public note for every trade the runtime makes", () => {
  it("the asked AI's answer: its why is the note", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    let n = 0;
    await run(home, c, feed, w, T0 + 7 * MIN, async ({ pack }) => {
      n += 1;
      return n === 1 ? answer({ action: "buy", coin: idOf(pack, "NOODFEED"), amountBnb: 0.006, reason: "for the player", why: "the crowd is buying NOODFEED", memo: "m" }) : hold();
    });
    expect(noteTexts(home)).toEqual(["bought NOODFEED for 0.006 BNB: the crowd is buying NOODFEED"]);
    expect(noteTexts(home).join(" ")).not.toContain("for the player");
  }, 60_000);

  it("the host's FL buy and FL sell: --why, or no colon part without one", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    const inbox = (at: number, file: string, request: Record<string, unknown>) =>
      c.at(at, () => {
        mkdirSync(agentPaths(home, "demo").inbox, { recursive: true });
        writeJsonAtomic(join(agentPaths(home, "demo").inbox, file), { type: "intent", requestId: file, request });
      });
    inbox(T0 + 1 * MIN, "1-buy.json", { kind: "buy", coin: COINS[1], bnb: 0.004, reason: "manual buy", why: "KOIFEED's flow turned up" });
    inbox(T0 + 3 * MIN, "2-sell.json", { kind: "sell", coin: COINS[1], fraction: 1, reason: "manual sale" });
    await run(home, c, feed, w, T0 + 4 * MIN, hold);
    const texts = noteTexts(home);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe("bought KOIFEED for 0.004 BNB: KOIFEED's flow turned up");
    expect(texts[1]).toMatch(/^sold KOIFEED for [\d.]+ BNB$/);
  }, 60_000);

  it("the floor keeper's trades say the keeper's line", async () => {
    const { home } = setup({ ask: false });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    await run(home, c, feed, w, T0 + 90 * MIN);
    const texts = noteTexts(home);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.length).toBe(filled(home));
    for (const text of texts) expect(text).toMatch(/^(bought|sold) (NOODFEED|KOIFEED|MOTHFEED) for [\d.]+ BNB: keeper: meeting today's activity floor$/);
  }, 60_000);

  it("a note that cannot be written, or a notes door that is waiting, never fails the trade: dropped, never queued", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    // The notes file is read-only: every append throws (a read still works).
    mkdirSync(agentPaths(home, "demo").dir, { recursive: true });
    writeFileSync(join(agentPaths(home, "demo").dir, "notes.jsonl"), "", { mode: 0o444 });
    let n = 0;
    await run(home, c, feed, w, T0 + 7 * MIN, async ({ pack }) => (++n === 1 ? answer({ action: "buy", coin: idOf(pack, "NOODFEED"), amountBnb: 0.006, why: "w" }) : hold()));
    expect(filled(home)).toBe(1);
    expect(readNotesLog(home)).toContain('"event":"note.failed"');

    const t = setup({ ask: true });
    const c2 = fakeClock(T0);
    const w2 = world(c2);
    recordHostAction(t.home, "demo", "buy", T0);
    writeJsonAtomic(join(agentPaths(t.home, "demo").dir, "doors.json"), { notes: { until: T0 + 60 * MIN, at: T0, status: 429 } });
    let m = 0;
    await run(t.home, c2, w2.feed, w2.w, T0 + 7 * MIN, async ({ pack }) => (++m === 1 ? answer({ action: "buy", coin: idOf(pack, "NOODFEED"), amountBnb: 0.006, why: "w" }) : hold()));
    expect(filled(t.home)).toBe(1);
    expect(noteTexts(t.home)).toEqual([]);
    expect(readNotesLog(t.home)).toContain('"event":"note.dropped"');
  }, 60_000);
});

describe("run 26: a hold's public line", () => {
  it("holdLineDue: a line, cleaned; never the same as the last, never under 30 minutes after it", () => {
    expect(HOLD_LINE_EVERY_MS).toBe(30 * MIN);
    expect(holdLineDue(null, "  the pit is quiet\n", T0)).toBe("the pit is quiet");
    expect(holdLineDue(null, null, T0)).toBeNull();
    expect(holdLineDue(null, "0x1234567890abcdef", T0)).toBeNull();
    const last = { text: "the pit is quiet", at: T0 };
    expect(holdLineDue(last, "the pit is quiet", T0 + 60 * MIN)).toBeNull();
    expect(holdLineDue(last, "something else", T0 + 29 * MIN)).toBeNull();
    expect(holdLineDue(last, "something else", T0 + 30 * MIN)).toBe("something else");
    expect(holdNoteText("x")).toBe("held: x");
  });

  it("the asked AI's holds: its why is published as held: <why>, when it changes and 30 minutes after the last", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    const asked: number[] = [];
    await run(home, c, feed, w, T0 + 70 * MIN, async () => {
      asked.push(c.now());
      return answer({ reason: "r", why: asked.length <= 2 ? "the pit is quiet, waiting for a wave" : "the pit woke up, next round I go in" });
    });
    expect(asked.length).toBeGreaterThanOrEqual(4);
    // The floor keeper's own trades (if any) say their own line; the holds' lines are these two, the second one the
    // first ask with a new line at least 30 minutes after the first was published.
    const held = readNotes(home, "demo").filter((n) => n.text.startsWith("held: "));
    expect(held.map((n) => n.text)).toEqual(["held: the pit is quiet, waiting for a wave", "held: the pit woke up, next round I go in"]);
    const first = Date.parse(held[0]!.ts);
    const second = Date.parse(held[1]!.ts);
    expect(first).toBe(asked[0]);
    expect(second - first).toBeGreaterThanOrEqual(30 * MIN);
    expect(asked.filter((t) => t > first + 30 * MIN && t < second)).toEqual([]);
    expect(readHoldLine(home, "demo")).toEqual({ text: "the pit woke up, next round I go in", at: second });
  }, 60_000);

  it("a hold with no why publishes nothing; a waiting notes door drops the line and keeps no last one", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    await run(home, c, feed, w, T0 + 12 * MIN, hold);
    expect(noteTexts(home)).toEqual([]);

    const t = setup({ ask: true });
    const c2 = fakeClock(T0);
    const w2 = world(c2);
    recordHostAction(t.home, "demo", "buy", T0);
    writeJsonAtomic(join(agentPaths(t.home, "demo").dir, "doors.json"), { notes: { until: T0 + 60 * MIN, at: T0, status: 429 } });
    await run(t.home, c2, w2.feed, w2.w, T0 + 12 * MIN, async () => answer({ why: "waiting" }));
    expect(noteTexts(t.home)).toEqual([]);
    expect(readHoldLine(t.home, "demo")).toBeNull();
    expect(readNotesLog(t.home)).toContain('"by":"hold"');
  }, 60_000);
});

describe("run 26: the answer's public note", () => {
  it("an asked AI's note is queued as FL note's are, once: the same note again is not, a new one is", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", T0);
    const GAME = "My game: I lead the pit's first wave and sell to the ones who follow.";
    const CHANGED = "Changed my mind: the pit is dead today, I play the busiest coin instead.";
    let n = 0;
    await run(home, c, feed, w, T0 + 25 * MIN, async ({ pack }) => {
      n += 1;
      if (n === 1) return answer({ note: GAME });
      if (n === 2) return answer({ action: "buy", coin: idOf(pack, "NOODFEED"), amountBnb: 0.006, why: "in first", note: GAME });
      return answer({ note: n === 3 ? CHANGED : null });
    });
    expect(n).toBeGreaterThanOrEqual(3);
    const texts = noteTexts(home);
    expect(texts.filter((t) => t === GAME)).toHaveLength(1);
    expect(texts.filter((t) => t === CHANGED)).toHaveLength(1);
    expect(texts.indexOf(GAME)).toBeLessThan(texts.indexOf("bought NOODFEED for 0.006 BNB: in first"));
    expect(readNotesLog(home)).toContain('"why":"answer note"');
  }, 60_000);
});

