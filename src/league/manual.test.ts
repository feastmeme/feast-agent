import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, loadAgent, planAgent, saveAgent } from "./agent.ts";
import { askWithFor } from "./ask/host.ts";
import { renderCard } from "./card.ts";
import { FakeFeed, INDEXER, seeded, SITE } from "./feed/fakes.ts";
import { checkHost, hostDetailHint, hostHeaders, modelHint } from "./headers.ts";
import { MANUAL_BEAT_MS, manualBeat } from "./manual.ts";
import { readNotes } from "./notes/queue.ts";
import { saveSession } from "./notes/session.ts";
import { FEAST, fakeClock, tradeWorld } from "./prompt/fakes.ts";
import { leagueWire } from "./register/fakes.ts";
import { runAgent } from "./runtime.ts";
import { askChoice, prepareStart, shapeOf } from "./start.ts";
import { agentPaths } from "./store.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/**
 * Task 975, run 21: manual mode (the owner's ruling of 2026-10-25, for Binance AI Pro's sandbox, where a background
 * process dies when the command returns): the agent recorded, no loop and no daemon; each manual command does what the
 * loop would, under the same guard, limits and gate, and keeps the seat lit. The loop's own fakes; no network.
 */

const T0 = Date.parse("2026-10-28T10:00:00Z");
const S = 1_000;
const HOUR = 3_600_000;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function manualAgent() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-manual-"));
  dirs.push(dir);
  writeFileSync(join(dir, "strategy.md"), "Trade new Feast coins for me.\n");
  const home = join(dir, "home");
  const planned = planAgent({ name: "maplegrin", promptPath: join(dir, "strategy.md"), preset: "steady", idleMinutes: 30 });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(T0 - HOUR)), league: { waitForSeason: true }, manual: true });
  return { home, dir };
}

function league(c: { now: () => number }, body: () => Record<string, unknown>) {
  const feed = new FakeFeed(c.now);
  feed.other = (url) => (url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: body() } : null);
  return feed;
}

const outcomes = (home: string) =>
  readFileSync(agentPaths(home, "maplegrin").log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string })
    .filter((l) => l.event === "request.outcome");

describe("manual commands with no loop: the one-shot, under the loop's own rules", () => {
  it("before the season's start: FL buy refused with the loop's own words, nothing asked of the wallet to trade", async () => {
    const { home } = manualAgent();
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const start = T0 + 4 * HOUR;
    const feed = league(c, () => leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(start).toISOString() } }));
    const out = await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(1), only: [{ kind: "buy", coin: FEAST, bnb: 0.006, reason: "manual buy" }], onlyIds: ["m-1"], out: () => {} });
    expect(out.exit).toBe("refused");
    expect(out.reason).toMatch(/^the season has not started; it opens at /);
    expect(w.calls.filter((call) => call === "preview" || call === "execute")).toEqual([]);
  });

  it("in season: FL buy fills and is said as the loop says it (its transaction), the book keeps it; FL sell all sells it", async () => {
    const { home } = manualAgent();
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const feed = league(c, () => leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(T0 + 3 * HOUR).toISOString() } }));
    const base = { home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, out: () => {} };
    const bought = await runAgent({ ...base, random: seeded(2), only: [{ kind: "buy", coin: FEAST, bnb: 0.006, reason: "manual buy", why: "FEAST holds while the pairs dip" }], onlyIds: ["m-buy"] });
    expect(bought).toEqual({ exit: "finished", reason: "the manual request ran" });
    expect(outcomes(home).find((o) => o.requestId === "m-buy")).toMatchObject({ outcome: "filled", kind: "buy", txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    const book = JSON.parse(readFileSync(agentPaths(home, "maplegrin").state, "utf8")) as { positions: Record<string, unknown> };
    expect(Object.keys(book.positions)).toHaveLength(1);
    c.clock.t += 5 * S;
    const sold = await runAgent({ ...base, random: seeded(3), only: [{ kind: "sell", coin: FEAST, fraction: 1, reason: "manual sale" }], onlyIds: ["m-sell"] });
    expect(sold.exit).toBe("finished");
    expect(outcomes(home).find((o) => o.requestId === "m-sell")).toMatchObject({ outcome: "filled", kind: "sell" });
    // Nothing runs between the commands: no loop event, no autopilot, no ask.
    const events = readFileSync(agentPaths(home, "maplegrin").log, "utf8");
    expect(events).not.toMatch(/"event":"(autopilot\.|ask\.|started")/);
    // Task 1020 (ruling C): each one-shot trade posts its own public note, the why given, or none.
    expect(readNotes(home, "maplegrin").map((n) => n.text.replace(/for [\d.]+ BNB/, "for <size> BNB"))).toEqual(["bought FEAST for <size> BNB: FEAST holds while the pairs dip", "sold FEAST for <size> BNB"]);
  });

  it("the hard limits hold: a buy over the cap (L3, 0.15 BNB at work) is refused, nothing executed", async () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const { home } = manualAgent();
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const feed = league(c, () => leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: null } }));
    const out = await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(4), only: [{ kind: "buy", coin: FEAST, bnb: 0.2, reason: "manual buy" }], onlyIds: ["m-big"], out: () => {} });
    const said = out.exit === "refused" ? out.reason : JSON.stringify(outcomes(home).find((o) => o.requestId === "m-big"));
    expect(said).toMatch(/L3/);
    expect(said).toMatch(/0\.15 BNB cap/);
    expect(w.calls.filter((call) => call === "execute")).toEqual([]);
  });

  it("no loop runs a manual agent: a daemon left from before stands down with the reason", async () => {
    const { home } = manualAgent();
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const out = await runAgent({ home, name: "maplegrin", signer: w.signer, chain: w.chain, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, out: () => {} });
    expect(out).toEqual({ exit: "refused", reason: '"maplegrin" is in manual mode: no loop runs it (FL start maplegrin switches it to the loop)' });
    expect(w.calls).toEqual([]);
  });
});

describe("manual mode is the agent's own, never part of its card's shape", () => {
  it("FL start --manual on, FL start off; the confirmation stays; the card says manual mode and nothing of an autopilot running", () => {
    const { home } = manualAgent();
    const before = loadAgent(home, "maplegrin")!;
    const card = renderCard(before);
    expect(card).toContain("Manual mode: no loop and no daemon run this agent.");
    expect(card).toContain("no autopilot, no floor keeper and no stop-loss watcher");
    expect(card).toContain("The day's floor (3 trades and 0.02 BNB) is yours to make by hand.");
    expect(card).not.toMatch(/Autopilot backup: on|Ask loop|Floor keeper:|Autopilot cadence|watches your positions for the hard stop-loss/);
    expect(card).toContain("Watching: nothing watches your positions in manual mode; each FL buy and FL sell checks the hard limits when you run it.");
    const off = prepareStart(home, "maplegrin", { plan: null, yes: false, confirm: true, manual: false });
    expect(off.kind).toBe("ready");
    expect(loadAgent(home, "maplegrin")!.manual).toBeUndefined();
    expect(loadAgent(home, "maplegrin")!.confirmed).toEqual(before.confirmed);
    expect(shapeOf(loadAgent(home, "maplegrin")!)).toBe(shapeOf(before));
    prepareStart(home, "maplegrin", { plan: null, yes: false, confirm: true, manual: true });
    expect(loadAgent(home, "maplegrin")!.manual).toBe(true);
  });
});

describe("the heartbeat on a manual command", () => {
  const session = (home: string) => saveSession(home, { version: 1, agentId: "maplegrin", season: 1, token: "tok-manual", expiresAt: null, at: new Date(T0).toISOString() });

  it("one authenticated me= read, at most once per 2 minutes per agent; the token in the header only", async () => {
    const { home } = manualAgent();
    session(home);
    const asked: { url: string; auth: string | null; host: string | null }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      asked.push({ url, auth: h.get("authorization"), host: h.get("x-feast-host") });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const wallet = async () => "0x000000000000000000000000000000000000A11C";
    const beat = (now: number, name = "maplegrin") => manualBeat({ home, name, site: SITE, fetch: f, wallet, now });
    expect(await beat(T0)).toBe("sent");
    expect(await beat(T0 + 30 * S)).toBe("throttled");
    expect(await beat(T0 + MANUAL_BEAT_MS - 1)).toBe("throttled");
    expect(await beat(T0 + 10 * S, "other-agent")).toBe("sent");
    expect(await beat(T0 + MANUAL_BEAT_MS)).toBe("sent");
    expect(asked).toHaveLength(3);
    expect(asked[0]!.url).toBe(`${SITE}/api/league?view=today&limit=1&me=0x000000000000000000000000000000000000a11c`);
    expect(asked[0]!.auth).toBe("Bearer tok-manual");
    expect(asked[0]!.host).not.toBeNull();
    expect(asked.every((a) => !a.url.includes("tok-manual"))).toBe(true);
  });

  it("no notes session: nothing sent; a failed read is only a result", async () => {
    const { home } = manualAgent();
    let n = 0;
    const f = (async () => (n++, new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    expect(await manualBeat({ home, name: "maplegrin", site: SITE, fetch: f, wallet: async () => "0x000000000000000000000000000000000000A11C", now: T0 })).toBe("no-session");
    expect(n).toBe(0);
    session(home);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await manualBeat({ home, name: "maplegrin", site: SITE, fetch: down, wallet: async () => "0x000000000000000000000000000000000000A11C", now: T0 })).toBe("failed");
    expect(existsSync(join(home, "cache", "manual-beat.json"))).toBe(true);
  });
});

describe("--host binance", () => {
  it("accepted; other on the wire (the site's set has no binance yet), binance in the detail header; nobody is asked", () => {
    expect(checkHost("binance")).toEqual({ ok: true, model: "other", detail: "binance" });
    const env = { FEAST_LEAGUE_HOST: "binance", CLAUDECODE: "1" };
    expect(modelHint(env)).toBe("other");
    expect(hostDetailHint(env)).toBe("binance");
    expect(hostHeaders(env)).toMatchObject({ "x-feast-host": "other", "x-feast-host-detail": "binance" });
    expect(askWithFor("other", "binance")).toBe("none");
    expect(askChoice({ host: "other", detail: "binance" })).toMatchObject({ ok: true, ask: { with: "none" } });
  });
});
