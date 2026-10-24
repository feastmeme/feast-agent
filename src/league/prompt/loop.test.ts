import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent, type PlanInput } from "../agent.ts";
import { emptyBook, recordBuy, serializeBook } from "../book.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths, writeFileAtomic, writeJsonAtomic } from "../store.ts";
import { FEAST, fakeClock, tradeWorld } from "./fakes.ts";
import { hostPath, recordHostAction } from "./host.ts";

const writeStopFile = (h: string) => writeFileSync(agentPaths(h, "demo").stop, "stop requested by the user\n");

const T0 = Date.parse("2026-10-28T13:00:00Z");
const MIN = 60_000;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function home(plan: Omit<PlanInput, "name" | "promptPath"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-loop-"));
  dirs.push(dir);
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, "Buy what moves; sell at -20%.\n");
  const planned = planAgent({ name: "demo", promptPath, ...plan });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  const h = join(dir, "home");
  saveAgent(h, confirmAgent(planned.agent, new Date(T0)));
  return { home: h, promptPath };
}

const lines = (h: string) =>
  existsSync(agentPaths(h, "demo").log)
    ? readFileSync(agentPaths(h, "demo").log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string })
    : [];
const board = (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;

describe("prompt mode, no autopilot: the runtime only enforces", () => {
  it("runs its time and sends nothing on its own: no preview, no execute", async () => {
    const { home: h } = home();
    const w = tradeWorld();
    const c = fakeClock(T0);
    const said: string[] = [];
    const outcome = await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, now: c.now, sleep: c.sleep, loopMs: MIN, maxRuntimeMs: 3 * 60 * MIN, out: (l) => said.push(l) });
    expect(outcome.exit).toBe("finished");
    expect(w.calls).not.toContain("preview");
    expect(w.calls).not.toContain("execute");
    expect(said[0]).toBe("[demo] started: prompt mode; your agent decides; no autopilot");
    expect(lines(h).filter((l) => l.event === "intent.queued")).toEqual([]);
  });

  it("a request from FL buy is processed, and its outcome is logged under its id", async () => {
    const { home: h } = home();
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    mkdirSync(agentPaths(h, "demo").inbox, { recursive: true });
    writeJsonAtomic(join(agentPaths(h, "demo").inbox, "1-buy.json"), { type: "intent", requestId: "req-1", request: { kind: "buy", coin: FEAST, bnb: 0.002, reason: "manual buy" } });
    w.notFeast.add("0x00000000000000000000000000000000000c0de9");
    writeJsonAtomic(join(agentPaths(h, "demo").inbox, "2-buy.json"), { type: "intent", requestId: "req-2", request: { kind: "buy", coin: "0x00000000000000000000000000000000000c0de9", bnb: 0.002, reason: "manual buy" } });
    writeJsonAtomic(join(agentPaths(h, "demo").inbox, "3-buy.json"), { type: "intent", requestId: "req-3", request: { kind: "buy", coin: "not a coin", bnb: 0.002 } });
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, now: c.now, sleep: c.sleep, loopMs: MIN, maxRuntimeMs: 10 * MIN, out: () => {} });
    const outcomes = lines(h).filter((l) => l.event === "request.outcome");
    expect(outcomes.find((o) => o.requestId === "req-1")).toMatchObject({ outcome: "filled", kind: "buy", txHash: w.hashes[0], bnb: 0.002 });
    expect(outcomes.find((o) => o.requestId === "req-2")).toMatchObject({ outcome: "refused", limit: "L15" });
    expect(outcomes.find((o) => o.requestId === "req-3")).toMatchObject({ outcome: "refused", message: "buy: coin must be an address or FEAST" });
    expect(w.calls.filter((x) => x === "execute")).toHaveLength(1);
  });

  it("a position under the backstop is sold whole by the runtime (L6), whatever the prompt says", async () => {
    const { home: h } = home();
    const c = fakeClock(T0);
    const w = tradeWorld({ sellBnbWei: 4n * 10n ** 15n, now: c.now });
    const book = { ...recordBuy(emptyBook(), { coin: FEAST, symbol: "FEAST", quote: FEAST, coinsOut: 10_000n * 10n ** 18n, bnbInWei: 10n ** 16n, gasWei: 0n, at: T0 - 60 * MIN, fundedBy: "wallet", ownLaunch: false, source: "manual" }) };
    book.positions[FEAST.toLowerCase()]!.armed = true;
    writeFileAtomic(agentPaths(h, "demo").state, serializeBook(book));
    w.marks.wei = 4n * 10n ** 15n; // 60% below its cost: past L6's 50%
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, now: c.now, sleep: c.sleep, loopMs: MIN, maxRuntimeMs: 5 * MIN, out: () => {} });
    const log = lines(h);
    expect(log.find((l) => l.event === "intent.queued")).toMatchObject({ kind: "sell", source: "runtime", reason: expect.stringMatching(/backstop stop-loss L6/) });
    expect(log.find((l) => l.event === "sell.filled")).toMatchObject({ coin: FEAST, bnbOutWei: String(4n * 10n ** 15n) });
    expect(w.calls.filter((x) => x === "execute")).toHaveLength(1);
  });

  it("the safety pass sends the notes FL note kept, once feast.meme takes them, and never holds the loop for it", async () => {
    const { home: h } = home();
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    const { noteCommand, readNotes } = await import("../notes/queue.ts");
    const { saveSession } = await import("../notes/session.ts");
    const { FakeFeast, SITE } = await import("../data/fakes.ts");
    const feast = new FakeFeast();
    saveSession(h, { version: 1, agentId: "maplegrin", season: 1, token: "tok-1", expiresAt: null, at: new Date(T0).toISOString() });
    await noteCommand({ home: h, name: "demo", site: SITE, fetch: feast.fetch, wallet: w.signer.address, now: c.now }, { text: "watching C01: volume up threefold" });
    expect(readNotes(h, "demo")).toMatchObject([{ state: "queued" }]);
    feast.options.notes = { status: 201, body: {} };
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: feast.fetch, site: SITE, now: c.now, sleep: c.sleep, loopMs: MIN, maxRuntimeMs: 5 * MIN, out: () => {} });
    for (let i = 0; i < 50 && readNotes(h, "demo")[0]!.state !== "sent"; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(readNotes(h, "demo")).toMatchObject([{ state: "sent" }]);
    expect(feast.posts).toHaveLength(2);
    expect(w.calls).not.toContain("preview");
  });

  it("every request still queued when the agent stops is answered, so no FL buy waits on it", async () => {
    const { home: h } = home();
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    // The first buy's preview: the user stops the agent right then.
    const preview = w.signer.preview.bind(w.signer);
    w.signer.preview = async (tx) => (writeStopFile(h), preview(tx));
    mkdirSync(agentPaths(h, "demo").inbox, { recursive: true });
    writeJsonAtomic(join(agentPaths(h, "demo").inbox, "1-buy.json"), { type: "intent", requestId: "req-1", request: { kind: "buy", coin: FEAST, bnb: 0.002 } });
    writeJsonAtomic(join(agentPaths(h, "demo").inbox, "2-buy.json"), { type: "intent", requestId: "req-2", request: { kind: "buy", coin: "0x00000000000000000000000000000000000c0de9", bnb: 0.002 } });
    const outcome = await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, now: c.now, sleep: c.sleep, loopMs: MIN, maxRuntimeMs: 10 * MIN, out: () => {} });
    expect(outcome.exit).toBe("stopped");
    const answered = lines(h).filter((l) => l.event === "request.outcome");
    expect(answered.map((l) => [l.requestId, l.outcome])).toEqual([
      ["req-1", "dropped"],
      ["req-2", "dropped"],
    ]);
    expect(w.calls).not.toContain("execute");
  });

  it("refuses to start when the prompt changed since the user's yes, before the wallet is asked", async () => {
    const { home: h, promptPath } = home();
    writeFileSync(promptPath, "Something else entirely.\n");
    const w = tradeWorld();
    const outcome = await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, maxRuntimeMs: 100 });
    expect(outcome.exit).toBe("refused");
    expect(outcome.reason).toMatch(/the prompt changed since you confirmed it/);
    expect(w.calls).toEqual([]);
  });
});

describe("prompt mode with autopilot: the preset trades only after the host's silence", () => {
  it("the safety pass keeps its minute whatever the autopilot's tick: L6 sells within it, under a dca autopilot of an hour", async () => {
    const { home: h } = home({ preset: "dca", params: { buyOnStart: false } });
    const c = fakeClock(T0);
    const w = tradeWorld({ sellBnbWei: 4n * 10n ** 15n, now: c.now });
    const book = recordBuy(emptyBook(), { coin: FEAST, symbol: "FEAST", quote: FEAST, coinsOut: 10_000n * 10n ** 18n, bnbInWei: 10n ** 16n, gasWei: 0n, at: T0 - 60 * MIN, fundedBy: "wallet", ownLaunch: false, source: "manual" });
    writeFileAtomic(agentPaths(h, "demo").state, serializeBook(book));
    recordHostAction(h, "demo", "buy", T0);
    // A minute in, the coin falls 60%: the next safety pass, not the preset's hourly tick, sells it.
    c.at(T0 + MIN, () => (w.marks.wei = 4n * 10n ** 15n));
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, now: c.now, sleep: c.sleep, loopMs: 15_000, pollMs: 10_000 * MIN, maxRuntimeMs: 5 * MIN, out: () => {} });
    const sold = lines(h).find((l) => l.event === "sell.filled");
    expect(sold).toBeDefined();
    expect(Date.parse(sold!.at) - T0).toBeLessThanOrEqual(3 * MIN);
  });

  it("a launch autopilot runs the wallet's body coin from FL enter, and never launches a second coin", async () => {
    const { home: h } = home({ preset: "launch", idleMinutes: 1, params: { name: "Maple", symbol: "MAPLE", openingBuyBnb: 0 } });
    const BODY = "0x00000000000000000000000000000000000b0d1e";
    writeJsonAtomic(join(h, "agents", "league-entry", "entry.json"), { agentId: "maplegrin", bodyCoin: BODY, launchTx: null, buy: null });
    const c = fakeClock(T0);
    const w = tradeWorld({ now: c.now });
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, now: c.now, sleep: c.sleep, loopMs: MIN, maxRuntimeMs: 30 * MIN, out: () => {} });
    const log = lines(h);
    expect(String(log.find((l) => l.event === "launch.inherited")?.coin).toLowerCase()).toBe(BODY);
    expect(log.filter((l) => l.event === "autopilot.on")).toHaveLength(1);
    expect(log.filter((l) => l.event === "intent.queued" && l.kind === "launch")).toEqual([]);
    expect(w.calls).not.toContain("execute");
  });

  it("nothing while the host is fresh; the preset after idleMinutes; it steps back when the host acts; on and off logged once each", async () => {
    const { home: h } = home({ preset: "dca", idleMinutes: 30, tickSeconds: 60, params: { buyOnStart: true, everyMinutes: 60, dipPct: 0 } });
    // 0.001 BNB in the wallet: every preset buy is refused by L11 (the gas reserve), so no wallet call, only the intent is seen.
    const w = tradeWorld({ balanceWei: 10n ** 15n });
    const c = fakeClock(T0);
    recordHostAction(h, "demo", "note", T0);
    // The host acts again 40 minutes in: autopilot steps back.
    c.at(T0 + 40 * MIN, () => recordHostAction(h, "demo", "buy", T0 + 40 * MIN));
    const said: string[] = [];
    await runAgent({ home: h, name: "demo", signer: w.signer, chain: w.chain, fetch: board, now: c.now, sleep: c.sleep, loopMs: MIN, pollMs: 10_000 * MIN, maxRuntimeMs: 65 * MIN, out: (l) => said.push(l) });
    const log = lines(h);
    const queued = log.filter((l) => l.event === "intent.queued" && l.source === "preset");
    expect(queued.length).toBeGreaterThan(0);
    for (const q of queued) {
      const at = Date.parse(q.at);
      expect(at).toBeGreaterThanOrEqual(T0 + 30 * MIN);
      expect(at).toBeLessThan(T0 + 40 * MIN);
    }
    // The preset ran only while silent: its own price history holds no time outside that window.
    const state = JSON.parse(readFileSync(join(agentPaths(h, "demo").dir, "strategy-state.json"), "utf8")) as { state: { prices: Record<string, { at: number }[]> } };
    const ran = Object.values(state.state.prices).flat().map((p) => p.at);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((at) => at >= T0 + 30 * MIN && at < T0 + 40 * MIN)).toBe(true);
    expect(log.filter((l) => l.event === "autopilot.on")).toHaveLength(1);
    expect(log.filter((l) => l.event === "autopilot.off")).toHaveLength(1);
    expect(said[0]).toBe("[demo] started: prompt mode; your agent decides; autopilot dca after 30 min of silence");
    expect(said.filter((s) => s.includes("autopilot"))).toEqual([said[0], "[demo] autopilot: your agent has been silent for 30 min: autopilot dca trades until it acts", "[demo] autopilot: your agent acted: autopilot dca steps back"]);
    expect(existsSync(hostPath(h, "demo"))).toBe(true);
  });
});
