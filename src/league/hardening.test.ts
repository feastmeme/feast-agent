import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "./agent.ts";
import type { HostCall } from "./ask/host.ts";
import type { WalletSettings } from "./baw.ts";
import { emptyBook, parseBook, serializeBook } from "./book.ts";
import { autopilotLine, agentSection, doneRunning, signInSentence } from "./enter/copy.ts";
import { coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody } from "./feed/fakes.ts";
import { healthFlag, HEALTH_HEADER, withHealth, type Health } from "./headers.ts";
import { saveSession } from "./notes/session.ts";
import { fakeClock, marketWorld } from "./prompt/fakes.ts";
import { recordHostAction } from "./prompt/host.ts";
import { leagueWire } from "./register/fakes.ts";
import { parseLeague, type LeagueRead } from "./register/site.ts";
import { runAgent } from "./runtime.ts";
import { readGate, SEASON_OVER_LINE, warmUpDinner } from "./season-gate.ts";
import { signInLine } from "./session.ts";
import { agentPaths, walletLockPath, writeJsonAtomic, writeStop } from "./store.ts";
import { readVersion, upgradeSentence, versionLine, versionView } from "./version.ts";
import { utc8 } from "./register/copy.ts";

/**
 * Task 975, addendum 8 (the season-readiness audit's gaps): the runtime's own hardening, on fakes. The league is a
 * function here (`seasonRead`) that answers as the test says and records the health flag each read carries.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-29T06:00:00Z");
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const COINS = [coin(0xc0e1), coin(0xc0e2)];
const SYMBOLS = ["NOODFEED", "KOIFEED"];
const OWN = coin(0xb0d1e);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup(o: { ask?: boolean; autopilot?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-a8-"));
  dirs.push(dir);
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, "Trade the busiest coin small; keep the floor early.\n");
  const planned = planAgent({ name: "demo", promptPath, ...(o.autopilot === false ? {} : { preset: "steady" }), ...(o.ask ? { ask: { every: 5, with: "claude", model: null } } : {}) });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  const home = join(dir, "home");
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(T0 - 2 * 86_400_000)), league: { waitForSeason: true } });
  writeJsonAtomic(join(agentPaths(home, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: OWN, launchTx: null });
  return { home };
}

function world(c: ReturnType<typeof fakeClock>) {
  const rows = COINS.map((k, i) => coinRow(k, { symbol: SYMBOLS[i], volume24hBnb: 9 - i, trades24h: 90 - i, launchedAt: "2026-10-20T00:00:00.000Z" }));
  const feed = new FakeFeed(c.now, () => ({ status: 200, body: snapshotBody({ coins: rows }), etag: '"a8"' }));
  feed.other = (url) => (url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } }) } : null);
  const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: i === 0 ? "MAPLEFEED" : SYMBOLS[i - 1]! })), now: c.now });
  return { feed, w };
}

const league = (over: Record<string, unknown> = {}): LeagueRead => parseLeague(leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() }, ...over }))!;

/** The league as a function of the clock; every read's health flag is kept. */
function seasonRead(c: ReturnType<typeof fakeClock>, at: (now: number) => LeagueRead | null) {
  const healths: { at: number; health: Health }[] = [];
  return { healths, read: async (o: { health: Health }) => (healths.push({ at: c.now(), health: o.health }), at(c.now())) };
}

const notices = (h: string) =>
  existsSync(agentPaths(h, "demo").notifications)
    ? readFileSync(agentPaths(h, "demo").notifications, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; text: string; code?: string })
    : [];
const lines = (h: string) =>
  existsSync(agentPaths(h, "demo").log)
    ? readFileSync(agentPaths(h, "demo").log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string })
    : [];
const hold = async (): Promise<HostCall> => ({ ok: true, answer: { action: "hold", coin: null, amountBnb: null, fraction: null, reason: "waiting", memo: "" } });

function run(home: string, c: ReturnType<typeof fakeClock>, feed: FakeFeed, w: ReturnType<typeof marketWorld>, until: number, extra: Record<string, unknown> = {}) {
  return runAgent({ home, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(8), noJitter: true, loopMs: 15_000, pollMs: 30_000, maxRuntimeMs: until - c.now(), out: () => {}, askHost: hold as never, ...extra });
}

const inbox = (h: string, file: string, body: Record<string, unknown>) => {
  mkdirSync(agentPaths(h, "demo").inbox, { recursive: true });
  writeJsonAtomic(join(agentPaths(h, "demo").inbox, file), body);
};

// --- 1. the runtime's release -------------------------------------------------------------------------------

describe("1. version awareness (G1)", () => {
  const BEHIND = { latestRuntime: { tag: "league-v6", publishedAt: "2026-10-30T12:00:00.000Z", minSupported: "league-v5" } };
  const CURRENT = { latestRuntime: { tag: "league-v5", publishedAt: "2026-10-26T12:00:00.000Z", minSupported: "league-v4" } };

  it("the page's latestRuntime, checked: a tag that is not league-vN is no answer; absent is undefined", () => {
    expect(league(BEHIND).latestRuntime).toEqual({ tag: "league-v6", publishedAt: Date.parse("2026-10-30T12:00:00Z"), minSupported: "league-v5" });
    expect(league({ latestRuntime: { tag: "v6; rm -rf /", publishedAt: null } }).latestRuntime).toBeUndefined();
    expect(league().latestRuntime).toBeUndefined();
  });

  it("behind, current, absent: the status line, the You're in sentence, never an upgrade", () => {
    const behind = versionView(league(BEHIND).latestRuntime, T0)!;
    expect(behind).toMatchObject({ current: "league-v5.1.2", latest: "league-v6", behind: true, unsupported: false });
    expect(versionLine(behind)).toBe("runtime league-v5.1.2 · latest league-v6 · upgrade: npx skills add feastmeme/feast-agent");
    expect(versionLine(versionView(league(CURRENT).latestRuntime, T0))).toBeNull();
    expect(versionView(league().latestRuntime, T0)).toBeNull();
    // Addendum 11: a minor release orders: v5.1 is behind v5.2 and v6, and ahead of v5.
    expect(versionView({ tag: "league-v5.2", publishedAt: null, minSupported: "league-v4" }, T0)).toMatchObject({ behind: true });
    expect(versionView({ tag: "league-v5", publishedAt: null, minSupported: "league-v4" }, T0)).toMatchObject({ behind: false, unsupported: false });
    expect(league({ latestRuntime: { tag: "league-v5.1", publishedAt: null, minSupported: "league-v4" } }).latestRuntime).toMatchObject({ tag: "league-v5.1" });
    // Run 17: a patch release orders too; run 19: v5.1.2 is ahead of v5.1.1 and v5.1, behind v5.1.3 and v5.2.
    expect(versionView({ tag: "league-v5.1", publishedAt: null, minSupported: "league-v4" }, T0)).toMatchObject({ behind: false });
    expect(versionView({ tag: "league-v5.1.1", publishedAt: null, minSupported: "league-v4" }, T0)).toMatchObject({ behind: false });
    expect(versionView({ tag: "league-v5.1.3", publishedAt: null, minSupported: "league-v4" }, T0)).toMatchObject({ behind: true });
    expect(league({ latestRuntime: { tag: "league-v5.1.2", publishedAt: null, minSupported: "league-v4" } }).latestRuntime).toMatchObject({ tag: "league-v5.1.2" });
    expect(versionLine(versionView({ tag: "league-v7", publishedAt: null, minSupported: "league-v6" }, T0))).toBe("runtime league-v5.1.2 · latest league-v7 · upgrade: npx skills add feastmeme/feast-agent (league-v5.1.2 is older than league-v6, the oldest feast.meme still supports: upgrade before the next dinner)");
    const opens = { kind: "open" as const };
    const shown = { preset: "steady", idleMinutes: 30, ask: { every: 5, with: "claude" } };
    expect(doneRunning("maplegrin", opens, "en", shown, "strategy.md", upgradeSentence(behind, "en"))).toMatch(/ A newer runtime is out \(league-v6; this is league-v5\.1\.2\): upgrade with `npx skills add feastmeme\/feast-agent`; it never upgrades by itself\.$/);
    expect(doneRunning("maplegrin", opens, "en", shown, "strategy.md", upgradeSentence(versionView(league(CURRENT).latestRuntime, T0), "en"))).toBe(doneRunning("maplegrin", opens, "en", shown));
    expect(upgradeSentence(behind, "zh")).toContain("npx skills add feastmeme/feast-agent");
  });

  for (const [what, over, said] of [["behind", BEHIND, 2], ["current", CURRENT, 0], ["absent", {}, 0]] as const) {
    it(`${what}: ${said ? "one notification a league day (two across a dinner)" : "nothing said"}, read every 5 minutes`, async () => {
      const { home } = setup({ ask: true });
      const c = fakeClock(DINNER - 2 * HOUR);
      const { feed, w } = world(c);
      recordHostAction(home, "demo", "buy", c.now());
      const s = seasonRead(c, () => league(over));
      await run(home, c, feed, w, DINNER + HOUR, { seasonRead: s.read });
      expect(s.healths.length).toBeGreaterThanOrEqual(36);
      expect(notices(home).filter((n) => n.kind === "version")).toHaveLength(said);
      if (what === "behind") {
        expect(notices(home).find((n) => n.kind === "version")!.text).toBe("a newer runtime is out: league-v6 (this one is league-v5.1.2). Upgrade with `npx skills add feastmeme/feast-agent`, then `FL start <name>` again; nothing upgrades by itself.");
        expect(readVersion(home, "demo")).toMatchObject({ behind: true, latest: "league-v6" });
      } else if (what === "current") expect(readVersion(home, "demo")).toMatchObject({ behind: false });
      else expect(readVersion(home, "demo")).toBeNull();
    }, 60_000);
  }
});

// --- 2. the wallet's sign-in ---------------------------------------------------------------------------------

describe("2. the sign-in's end (G2)", () => {
  it("the entry card's sentence and FL status's line name the date", () => {
    const end = Date.parse("2026-11-01T06:05:00Z");
    expect(signInSentence(end, "en")).toBe("Wallet sign-in ends at 2026-11-01 14:05 UTC+8: re-scan before then or the agent stops trading, the floor keeper and the stop-loss included (`FL login` says how).");
    expect(signInSentence(end, "zh")).toContain("2026-11-01 14:05 UTC+8");
    expect(signInLine(end, utc8)).toBe("wallet sign-in ends at 2026-11-01 14:05 UTC+8: re-scan before then or the agent stops trading (FL login says how); once it ends nothing trades, not the floor keeper and not a stop-loss, until the player scans again; a day's floor still unmet then is eaten at the dinner");
    const section = agentSection({ strategy: { kind: "own", path: "strategy.md", firstLine: "x" } as never, name: "maplegrin", card: "CARD", opens: { kind: "open" }, autopilot: null, signInEnd: end }, "en");
    expect(section.split("\n").at(-1)).toBe(signInSentence(end, "en"));
    expect(autopilotLine(null, "en")).not.toContain("sign-in");
  });

  it("the running agent says 24 h, 6 h and 1 h before the end, once each; the pack carries the warning inside the last 24 h", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(DINNER - 30 * HOUR);
    const { feed, w } = world(c);
    const end = c.now() + 26 * HOUR;
    const base = await w.signer.settings();
    w.signer.settings = async () => ({ ...(base as WalletSettings), signInMaxTime: new Date(end).toISOString() });
    const packs: { at: number; pack: string }[] = [];
    await run(home, c, feed, w, end - 30 * MIN, { askHost: (async ({ pack }: { pack: string }) => (packs.push({ at: c.now(), pack }), hold())) as never, seasonRead: seasonRead(c, () => league()).read });
    const said = notices(home).filter((n) => n.kind === "session");
    expect(said.map((n) => n.code)).toEqual(["24h", "6h", "1h"]);
    // Addendum 11: the same three steps as public notes, their prefix byte-exact, queued for the notes stream.
    const noted = readFileSync(join(agentPaths(home, "demo").dir, "notes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text?: string }).filter((n) => typeof n.text === "string").map((n) => n.text);
    expect(noted).toEqual(["⏰ 登录到期 · 24 小时后 · 主人需要重新扫码一次", "⏰ 登录到期 · 6 小时后 · 主人需要重新扫码一次", "⏰ 登录到期 · 1 小时后 · 主人需要重新扫码一次"]);
    expect(Buffer.from(noted[0]!).subarray(0, Buffer.byteLength("⏰ 登录到期")).toString("hex")).toBe(Buffer.from("⏰ 登录到期").toString("hex"));
    // The heartbeat: alive since the start, its last tick a safety pass of this run.
    const alive = JSON.parse(readFileSync(join(agentPaths(home, "demo").dir, "alive.json"), "utf8")) as { since: string; lastTick: string };
    expect(Date.parse(alive.since)).toBe(DINNER - 30 * HOUR);
    expect(Date.parse(alive.lastTick)).toBeGreaterThan(end - 2 * HOUR);
    expect(said[0]!.text).toContain("Your wallet's sign-in ends in under 24 hours");
    const before = packs.filter((p) => end - p.at > 24 * HOUR);
    const inside = packs.filter((p) => end - p.at < 23 * HOUR);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((p) => !p.pack.includes("WALLET SIGN-IN"))).toBe(true);
    expect(inside.every((p) => /WALLET SIGN-IN EXPIRES IN \d+ H: the agent will stop; tell the player to run FL login\./.test(p.pack))).toBe(true);
  }, 120_000);
});

// --- 3. no orphan position -----------------------------------------------------------------------------------

describe("3. a send is journaled before it goes (G3)", () => {
  it("killed between the send and the receipt: the restart finds the record, reads the receipt by its hash, and books the position, once", async () => {
    const { home } = setup({ autopilot: false });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    const receipt = w.chain.receipt.bind(w.chain);
    let hang: (e: Error) => void = () => {};
    (w.chain as unknown as { receipt: unknown }).receipt = () => new Promise((_, reject) => (hang = reject));
    const first = run(home, c, feed, w, T0 + HOUR, { seasonRead: seasonRead(c, () => league()).read });
    inbox(home, "1-buy.json", { type: "intent", requestId: "a8", request: { kind: "buy", coin: COINS[0], bnb: 0.004, reason: "manual buy" } });
    const book = () => (existsSync(agentPaths(home, "demo").state) ? parseBook(readFileSync(agentPaths(home, "demo").state, "utf8")) : null);
    for (let i = 0; i < 400 && !book()?.unresolved.some((u) => u.txHash !== null); i += 1) await new Promise((r) => setTimeout(r, 10));
    // On disk, before any receipt: the record with its hash, still sending; no position yet.
    const kept = book()!;
    expect(kept.unresolved).toHaveLength(1);
    expect(kept.unresolved[0]).toMatchObject({ kind: "buy", sending: true, coin: COINS[0] });
    expect(kept.unresolved[0]!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Object.keys(kept.positions)).toEqual([]);
    // The kill: the process is gone (its lock and pid file with it); the chain has the receipt by now.
    rmSync(walletLockPath(home), { force: true });
    rmSync(agentPaths(home, "demo").pid, { force: true });
    (w.chain as unknown as { receipt: unknown }).receipt = receipt;
    (w.chain.client as unknown as { getTransactionReceipt: unknown }).getTransactionReceipt = ({ hash }: { hash: Hex }) => receipt(hash, 1);
    const before = notices(home).length;
    const second = run(home, c, feed, w, c.now() + 2 * MIN, { seasonRead: seasonRead(c, () => league()).read });
    await second;
    const after = book()!;
    expect(after.unresolved).toEqual([]);
    expect(after.positions[COINS[0]!.toLowerCase()]?.coins).toBeGreaterThan(0n);
    expect(lines(home).filter((l) => l.event === "buy.filled" && l.late === true)).toHaveLength(1);
    const told = notices(home).slice(before).filter((n) => n.kind === "trade");
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toMatch(/^a late outcome: bought NOODFEED for 0\.004 BNB/);
    // The first run, let go: it stops on its stop file.
    writeStop(agentPaths(home, "demo").stop, "test over");
    hang(new Error("timed out"));
    await first;
  }, 60_000);

  it("killed before the wallet sent it: no hash, no balance moved, the wallet free: released at the start, nothing booked", async () => {
    const { home } = setup({ autopilot: false });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    mkdirSync(agentPaths(home, "demo").dir, { recursive: true });
    writeFileSync(agentPaths(home, "demo").state, serializeBook({ ...emptyBook(), unresolved: [{ txHash: null, kind: "buy", at: T0 - 5 * MIN, intentId: "x", source: "manual", fundedBy: "wallet", coin: COINS[1]!, symbol: "KOIFEED", quote: COINS[1]!, payIn: "native", sizeWei: 4n * 10n ** 15n, balanceBefore: 0n, minCoins: 1n, sending: true, run: "an earlier run" }] }));
    await run(home, c, feed, w, T0 + MIN, { seasonRead: seasonRead(c, () => league()).read });
    const after = parseBook(readFileSync(agentPaths(home, "demo").state, "utf8"));
    expect(after.unresolved).toEqual([]);
    expect(after.positions).toEqual({});
    expect(notices(home).filter((n) => n.kind === "trade").map((n) => n.text)).toEqual(["buy (no hash): the last run stopped before the wallet sent it, and no balance moved: nothing was traded"]);
  }, 60_000);
});

// --- 4. loud failures -----------------------------------------------------------------------------------------

describe("4. loud failures (G5)", () => {
  it("three failed passes in a row: one notification, however long it lasts; the health flag says failing", async () => {
    const { home } = setup({ autopilot: false });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    (w.chain as unknown as { balance: unknown }).balance = async () => {
      throw new Error("HTTP request failed. URL: https://rpc.example/with-a-key Status: 429");
    };
    const s = seasonRead(c, () => league());
    await run(home, c, feed, w, T0 + 30 * MIN, { seasonRead: s.read });
    const failed = notices(home).filter((n) => n.kind === "failure" && n.text.startsWith("the loop's pass"));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.text).not.toContain("rpc.example");
    // Addendum 10: nor the log: the keyed URL never reaches a line on disk.
    expect(readFileSync(agentPaths(home, "demo").log, "utf8")).not.toMatch(/rpc\.example|with-a-key/);
    expect(lines(home).find((l) => l.event === "tick.failed")!.reason).toBe("HTTP request failed.");
    expect(lines(home).filter((l) => l.event === "tick.failed").length).toBeGreaterThan(3);
    expect(s.healths[0]!.health).toBe("ok");
    expect(s.healths.at(-1)!.health).toBe("failing");
  }, 60_000);

  it("a note feast.meme refuses: one notification, with its status", async () => {
    const { home } = setup({ autopilot: false });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    saveSession(home, { version: 1, agentId: "maplegrin", season: 1, token: "test-session", expiresAt: null, at: new Date(T0).toISOString() });
    mkdirSync(agentPaths(home, "demo").dir, { recursive: true });
    appendFileSync(join(agentPaths(home, "demo").dir, "notes.jsonl"), `${JSON.stringify({ id: "n1", ts: new Date(T0).toISOString(), text: "a buy", tx: null, model: "claude" })}\n`);
    const other = feed.other;
    feed.other = (url, init) => (url.pathname === "/api/league/notes" ? { status: 422, body: { error: "bad" } } : other(url, init));
    await run(home, c, feed, w, T0 + 5 * MIN, { seasonRead: seasonRead(c, () => league()).read });
    expect(notices(home).filter((n) => n.kind === "notes").map((n) => n.text)).toEqual(["feast.meme refused 1 note (HTTP 422): kept on this machine and never sent again"]);
  }, 60_000);
});

// --- 5. the season's end -------------------------------------------------------------------------------------

describe("5. the season over closes the gate (G6)", () => {
  it("no ask and no floor keeper after it; a buy refused, a sale still runs; said once; FL status's gate says over", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(DINNER - 40 * MIN);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", c.now() - 10 * MIN);
    const overAt = DINNER;
    const asked: number[] = [];
    // The host's own position, bought before the end.
    inbox(home, "1-buy.json", { type: "intent", requestId: "b1", request: { kind: "buy", coin: COINS[0], bnb: 0.004, reason: "manual buy" } });
    c.at(overAt + 10 * MIN, () => {
      inbox(home, "2-buy.json", { type: "intent", requestId: "b2", request: { kind: "buy", coin: COINS[1], bnb: 0.004, reason: "after the end" } });
      inbox(home, "3-sell.json", { type: "intent", requestId: "s1", request: { kind: "sell", coin: COINS[0], fraction: 1, reason: "close out" } });
    });
    const s = seasonRead(c, (now) => (now >= overAt ? league({ state: "over", season: { number: 1, day: null, countdownTo: null } }) : league({ season: { number: 1, day: 7, countdownTo: new Date(DINNER).toISOString() } })));
    await run(home, c, feed, w, overAt + 2 * HOUR, { seasonRead: s.read, askHost: (async () => (asked.push(c.now()), hold())) as never });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((t) => t < overAt + 5 * MIN)).toBe(true);
    const log = lines(home);
    expect(log.filter((l) => l.event === "season.over")).toHaveLength(1);
    expect(notices(home).filter((n) => n.kind === "season" && n.text.startsWith("the season is over"))).toHaveLength(1);
    expect(log.find((l) => l.event === "request.outcome" && l.requestId === "b2")).toMatchObject({ outcome: "refused", message: SEASON_OVER_LINE });
    expect(log.some((l) => l.event === "sell.filled" && l.coin === COINS[0])).toBe(true);
    expect(log.some((l) => l.event === "autopilot.on" && Date.parse(l.at) >= overAt)).toBe(false);
    expect(log.some((l) => l.event === "intent.queued" && l.source === "preset" && Date.parse(l.at) >= overAt)).toBe(false);
    expect(readGate(home, "demo")).toMatchObject({ state: "over" });
  }, 60_000);
});

// --- 6. the warm-up dinner ------------------------------------------------------------------------------------

describe("6. the warm-up dinner asks no floor", () => {
  const WARM = Date.parse("2026-10-28T13:00:00Z");
  const day1 = () => league({ season: { number: 1, day: 1, countdownTo: new Date(WARM).toISOString() } });

  it("from the league's clock: day 1's countdown, or a day after the start; nothing on day 2", () => {
    expect(warmUpDinner(day1())).toBe(WARM);
    expect(warmUpDinner(league({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(WARM - 86_400_000).toISOString() } }))).toBe(WARM);
    expect(warmUpDinner(league())).toBeNull();
  });

  it("no guard trades from dinner − 20 to dinner on day 1, the floor unmet; the pack says warm-up tonight: no floor", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(WARM - 70 * MIN);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", c.now() - 5 * MIN);
    const packs: string[] = [];
    await run(home, c, feed, w, WARM, { seasonRead: seasonRead(c, day1).read, askHost: (async ({ pack }: { pack: string }) => (packs.push(pack), hold())) as never });
    const log = lines(home);
    expect(log.some((l) => l.event === "autopilot.on")).toBe(false);
    expect(log.some((l) => l.event === "buy.filled")).toBe(false);
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.every((p) => p.includes("today's floor: warm-up tonight: no floor."))).toBe(true);
    expect(packs.some((p) => p.includes("FLOOR UNMET"))).toBe(false);
    expect(readGate(home, "demo")).toMatchObject({ warmUpDinnerAt: new Date(WARM).toISOString(), day: 1 });
  }, 60_000);
});

// --- 7. the health flag ---------------------------------------------------------------------------------------

describe("7. the health flag (G7)", () => {
  it("one word, from what the loop knows", () => {
    expect(healthFlag({ tickFailsInARow: 0, oldestUnresolvedMs: null, rpcOnFallback: false, askFailsInARow: 0 })).toBe("ok");
    expect(healthFlag({ tickFailsInARow: 0, oldestUnresolvedMs: null, rpcOnFallback: true, askFailsInARow: 0 })).toBe("degraded");
    expect(healthFlag({ tickFailsInARow: 2, oldestUnresolvedMs: 9 * MIN, rpcOnFallback: false, askFailsInARow: 1 })).toBe("degraded");
    expect(healthFlag({ tickFailsInARow: 3, oldestUnresolvedMs: null, rpcOnFallback: false, askFailsInARow: 0 })).toBe("failing");
    expect(healthFlag({ tickFailsInARow: 0, oldestUnresolvedMs: 11 * MIN, rpcOnFallback: false, askFailsInARow: 0 })).toBe("failing");
  });

  it("on the league read, and on it alone: the header's value, and nothing else added", async () => {
    let seen: Headers | null = null;
    const f = withHealth((async (_u: unknown, init?: RequestInit) => ((seen = new Headers(init?.headers)), new Response("{}"))) as unknown as typeof fetch, "degraded");
    await f("https://feast.test/api/league?view=today", { headers: { accept: "application/json" } });
    expect(seen!.get(HEALTH_HEADER)).toBe("degraded");
    expect([...seen!.keys()].sort()).toEqual(["accept", HEALTH_HEADER]);
  });

  it("asks failing: degraded on the next league read; the snapshot carries no health flag", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", c.now() - 10 * MIN);
    const s = seasonRead(c, () => league());
    await run(home, c, feed, w, T0 + 20 * MIN, { seasonRead: s.read, askHost: (async () => ({ ok: false, cause: "Claude Code did not answer within 120 s" })) as never });
    expect(s.healths[0]!.health).toBe("ok");
    expect(s.healths.some((h) => h.health === "degraded")).toBe(true);
    expect(feed.snapshots().every((a) => a.headers[HEALTH_HEADER] === undefined)).toBe(true);
  }, 60_000);
});

// --- addendum 10 ----------------------------------------------------------------------------------------------

describe("addendum 10: the rehearsal's last six", () => {
  it("errorLine: viem's short message, no request body, no URL, no address", async () => {
    const { HttpRequestError } = await import("viem");
    const { errorLine } = await import("./rpc.ts");
    const e = new HttpRequestError({ url: "https://rpc.example/v1/with-a-key", status: 503, body: { method: "eth_call", params: [{ from: "0x000000000000000000000000000000000000a11c", data: "0x70a08231" }] } });
    const line = errorLine(e);
    expect(line).toBe("HTTP request failed.");
    expect(errorLine(new Error("fetch failed at https://rpc.example/with-a-key for 0x000000000000000000000000000000000000a11c\nRequest body: {}"))).toBe("fetch failed at <url> for 0x…");
  });

  it("FL start says it waits for the season only while the gate is not open", async () => {
    const { startSaysWaiting } = await import("./season-gate.ts");
    const at = new Date(T0).toISOString();
    expect(startSaysWaiting(true, null)).toBe(true);
    expect(startSaysWaiting(true, { state: "waiting", opensAt: null, at })).toBe(true);
    expect(startSaysWaiting(true, { state: "open", opensAt: at, at })).toBe(false);
    expect(startSaysWaiting(true, { state: "over", opensAt: at, at })).toBe(false);
    expect(startSaysWaiting(false, null)).toBe(false);
  });

  it("the warm-up day's line: no floor tonight, never \"not yet\"", async () => {
    const { dayLine } = await import("./prompt/floor.ts");
    const view = { startsAt: "2026-10-27T13:00:00.000Z", endsAt: "2026-10-28T13:00:00.000Z", trades: 0, volumeBnb: 0, floor: { trades: 3, volumeBnb: 0.02 }, passed: false };
    const line = dayLine({ ...view, noFloor: true }, Date.parse("2026-10-28T12:30:00Z"));
    expect(line).toBe("today: 0 trades, 0 BNB of volume; warm-up: no floor tonight (the warm-up dinner eats nobody); dinner at 21:00 UTC+8, in 30 min");
    expect(dayLine(view, Date.parse("2026-10-28T12:30:00Z"))).toContain("not yet");
  });
});

// --- run 17: the seat's heartbeat ------------------------------------------------------------------------------

describe("run 17: the authenticated me= read every 9 minutes, in every mode", () => {
  it("with its notes session: the bearer, the release and host headers and the health flag; every 9 minutes whatever it trades; the token never logged", async () => {
    const { home } = setup({ ask: true });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    recordHostAction(home, "demo", "buy", c.now());
    saveSession(home, { version: 1, agentId: "maplegrin", season: 1, token: "test-session-heartbeat", expiresAt: null, at: new Date(T0).toISOString() });
    await run(home, c, feed, w, T0 + 40 * MIN, { seasonRead: seasonRead(c, () => league()).read });
    // The authenticated ones (the ask's standing read falls back to an anonymous me= on this fake page, with no field).
    const seen = feed.asked.filter((a) => a.url.startsWith(`${SITE}/api/league?`) && a.headers.authorization !== undefined);
    expect(seen.map((a) => (a.at - T0) / MIN)).toEqual([0, 9, 18, 27, 36]);
    for (const a of seen) {
      expect(a.url).toMatch(/me=0x[0-9a-f]{40}$/);
      expect(a.headers).toMatchObject({ authorization: "Bearer test-session-heartbeat", "x-feast-health": expect.stringMatching(/^(ok|degraded|failing)$/), "x-feast-runtime": expect.any(String), "x-feast-host": expect.any(String) });
    }
    // No other request carries the bearer.
    expect(feed.asked.filter((a) => a.headers.authorization && !a.url.startsWith(`${SITE}/api/league?view=today&limit=1&me=`))).toEqual([]);
    expect(readFileSync(agentPaths(home, "demo").log, "utf8")).not.toContain("test-session-heartbeat");
  }, 60_000);

  it("no notes session: nothing sent, said once a run", async () => {
    const { home } = setup({ autopilot: false });
    const c = fakeClock(T0);
    const { feed, w } = world(c);
    await run(home, c, feed, w, T0 + 30 * MIN, { seasonRead: seasonRead(c, () => league()).read });
    expect(feed.asked.filter((a) => a.headers.authorization !== undefined)).toEqual([]);
    expect(notices(home).filter((n) => n.text.startsWith("feast.meme cannot see this agent alive"))).toHaveLength(1);
  }, 60_000);
});

