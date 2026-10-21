import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "./agent.ts";
import type { Signer, WalletSettings } from "./baw.ts";
import type { LeagueChain } from "./chain.ts";
import { runAgent } from "./runtime.ts";
import { freshMemory, sessionStep, sessionView, type SessionMemory } from "./session.ts";
import { agentPaths, writeStop } from "./store.ts";

const H = 3_600_000;

describe("the sign-in's end (measured 2026-10-22)", () => {
  it("is signInMaxTime when the 48 h inactivity window, pushed ahead by every read, is later", () => {
    expect(sessionView({ sessionExpireTime: "2026-10-24T00:26:09+08:00", inactiveSignOutTime: "2026-10-24T00:26:09+08:00", signInMaxTime: "2026-10-28T10:34:11+08:00" })).toEqual({
      key: "2026-10-28T10:34:11+08:00",
      end: Date.parse("2026-10-24T00:26:09+08:00"),
      source: "inactivity",
    });
    expect(sessionView({ sessionExpireTime: "2026-10-29T00:00:00+08:00", inactiveSignOutTime: "2026-10-29T00:00:00+08:00", signInMaxTime: "2026-10-28T10:34:11+08:00" })).toMatchObject({ end: Date.parse("2026-10-28T10:34:11+08:00"), source: "sign-in limit" });
    expect(sessionView({ sessionExpireTime: "2026-10-24T00:26:09+08:00", inactiveSignOutTime: null })).toMatchObject({ key: null, source: "inactivity" });
    expect(sessionView({ sessionExpireTime: null, inactiveSignOutTime: null, signInMaxTime: null })).toEqual({ key: null, end: null, source: null });
  });
});

describe("the reminder: once per sign-in", () => {
  const view = (end: number, key = "k1") => ({ connected: true, view: { key, end, source: "sign-in limit" as const } });

  it("says 6 h, 1 h and the end once each, however often it is asked", () => {
    let memory: SessionMemory = freshMemory();
    const said: string[] = [];
    const end = 100 * H;
    for (let now = 90 * H; now < 102 * H; now += 300_000) {
      // The wallet says CONNECTED until its end, then not.
      const step = sessionStep(memory, now < end ? view(end) : { connected: false, view: null }, now);
      memory = step.memory;
      said.push(...step.say);
    }
    expect(said).toEqual(["6h", "1h", "ended"]);
  });

  it("goes straight to 1 h when it first looks inside the last hour", () => {
    const step = sessionStep(freshMemory(), view(10 * H), 9.5 * H);
    expect(step.say).toEqual(["1h"]);
    expect(sessionStep(step.memory, view(10 * H), 9.6 * H).say).toEqual([]);
  });

  it("counts a wallet that says it is signed out as ended, once", () => {
    let step = sessionStep(freshMemory(), view(100 * H), 0);
    step = sessionStep(step.memory, { connected: false, view: null }, H);
    expect(step).toMatchObject({ say: ["ended"], signedOut: true });
    expect(sessionStep(step.memory, { connected: false, view: null }, 2 * H).say).toEqual([]);
  });

  it("says 'back' once after a new scan, and arms the next sign-in afresh", () => {
    let step = sessionStep(freshMemory(), view(10 * H, "k1"), 9 * H);
    step = sessionStep(step.memory, { connected: false, view: null }, 11 * H);
    expect(step.say).toEqual(["ended"]);
    step = sessionStep(step.memory, view(200 * H, "k2"), 12 * H);
    expect(step).toMatchObject({ say: ["back"], signedOut: false, memory: { key: "k2", said: [] } });
    expect(sessionStep(step.memory, view(200 * H, "k2"), 196 * H).say).toEqual(["6h"]);
  });

  it("believes a wallet that still says CONNECTED past its own end: no notice, no hold, and that end dropped", () => {
    const step = sessionStep(freshMemory(), view(10 * H), 11 * H);
    expect(step).toEqual({ say: [], signedOut: false, memory: { key: "k1", end: null, said: [] } });
    // A fast clock, the same way: still CONNECTED, so nothing is held.
    expect(sessionStep(step.memory, view(10 * H), 30 * H).signedOut).toBe(false);
  });

  it("says 'back' once even when the wallet gives no sign-in time to key it by", () => {
    let step = sessionStep(freshMemory(), { connected: false, view: null }, 0);
    step = sessionStep(step.memory, { connected: true, view: { key: null, end: null, source: null } }, H);
    expect(step.say).toEqual(["back"]);
    expect(sessionStep(step.memory, { connected: true, view: { key: null, end: null, source: null } }, 2 * H).say).toEqual([]);
  });
});

// --- the loop ---------------------------------------------------------------------------------

const WALLET: Address = "0x000000000000000000000000000000000000a11c";
let homes: string[] = [];
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

function setup(clock: { now: number }, settings: Partial<WalletSettings>, connected: () => boolean = () => true) {
  const home = mkdtempSync(join(tmpdir(), "feast-league-session-"));
  homes.push(home);
  // A DCA agent with nothing to do for a week: the only intent is the user's manual buy, sent once the sign-in has ended.
  const planned = planAgent({ name: "dca", preset: "dca", params: { buyOnStart: false, everyMinutes: 10080 } });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirmAgent(planned.agent));
  const calls: string[] = [];
  const signer: Signer = {
    status: async () => (calls.push("status"), { connected: connected(), status: connected() ? "CONNECTED" : "DISCONNECTED" }),
    address: async () => WALLET,
    settings: async () => (calls.push("settings"), { devModeEnabled: true, devModeExpiresAt: null, devModeDailyLimitUsd: 1000, devModeQuotaUsedUsd: 0, balanceExceeded: false, sessionExpireTime: null, inactiveSignOutTime: null, abnormalTxnHandling: null, ...settings }),
    txLock: async () => (calls.push("tx-lock"), "UNLOCKED"),
    preview: async () => (calls.push("preview"), {}),
    execute: async () => (calls.push("execute"), { status: "BROADCASTED", txHash: null, orderId: null, message: null }),
    signMessagePreview: async () => ({}),
  };
  const chain = {
    balance: async () => 10n ** 18n,
    bnbUsd: async () => 600,
    markWei: async () => 0n,
    coinInfo: async () => ({ coin: WALLET, quote: WALLET, creator: WALLET, poolId: "0x01", coinIsCurrency0: true, symbol: "FEAST", name: "Feast" }),
    quoteBnbE18: async () => 10n ** 18n,
    isFeastCoin: async () => true,
  } as unknown as LeagueChain;
  const board = (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;
  return { home, signer, calls, chain, board, now: () => clock.now };
}

const notices = (home: string) =>
  readFileSync(agentPaths(home, "dca").notifications, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; code?: string; text: string })
    .filter((n) => n.kind === "session");

describe("the runtime, when the sign-in ends", () => {
  it("knows before a trade fails: asks the wallet nothing, says it once, and holds through a restart", async () => {
    const clock = { now: Date.parse("2026-10-28T02:00:00Z") };
    // The sign-in ends 30 s into the run, between two 5-minute wallet reads; from then on the wallet says it is signed out.
    const end = new Date(clock.now + 30_000).toISOString();
    const s = setup(clock, { signInMaxTime: end, sessionExpireTime: new Date(clock.now + 48 * H).toISOString() }, () => clock.now < Date.parse(end));
    // A minute after the end, the user asks the running agent for a buy (the CLI's inbox).
    let sent = false;
    const sleep = async (ms: number) => {
      clock.now += ms;
      if (!sent && clock.now > Date.parse(end) + 60_000) {
        sent = true;
        mkdirSync(agentPaths(s.home, "dca").inbox, { recursive: true });
        writeFileSync(join(agentPaths(s.home, "dca").inbox, "1-buy.json"), JSON.stringify({ type: "intent", request: { kind: "buy", coin: "FEAST", bnb: 0.002, reason: "manual buy" } }));
      }
    };
    const first = await runAgent({ home: s.home, name: "dca", signer: s.signer, chain: s.chain, fetch: s.board, now: s.now, sleep, loopMs: 10_000, maxRuntimeMs: 30 * 60_000 });
    expect(first.exit).toBe("finished");
    expect(s.calls).not.toContain("preview");
    expect(s.calls).not.toContain("execute");
    expect(notices(s.home).map((n) => n.code)).toEqual(["1h", "ended"]);
    expect(notices(s.home).at(-1)!.text).toMatch(/scan again/);
    // The buy was held, never handed to the guard or the wallet, and lapsed at its expiry.
    const log = readFileSync(agentPaths(s.home, "dca").log, "utf8");
    expect(sent).toBe(true);
    expect(log).toMatch(/"event":"intent.queued"[^\n]*"kind":"buy"/);
    expect(log).toMatch(/"event":"intent.stale"[^\n]*"signedOut":true/);
    expect(log).not.toMatch(/"event":"intent.refused"/);

    // A restart on the same sign-in: refused at the start, nothing said twice.
    const again = await runAgent({ home: s.home, name: "dca", signer: s.signer, chain: s.chain, fetch: s.board, now: s.now, sleep, loopMs: 10_000, maxRuntimeMs: 60_000 });
    expect(again.exit).toBe("refused");
    expect(notices(s.home).map((n) => n.code)).toEqual(["1h", "ended"]);
  });

  it("never holds a wallet that still says CONNECTED past its sign-in time (a wrong field, or a fast clock)", async () => {
    const clock = { now: Date.parse("2026-10-28T02:00:00Z") };
    const s = setup(clock, { signInMaxTime: new Date(clock.now - H).toISOString(), sessionExpireTime: new Date(clock.now + 48 * H).toISOString() });
    let sent = false;
    const sleep = async (ms: number) => {
      clock.now += ms;
      if (!sent && clock.now > Date.parse("2026-10-28T02:01:00Z")) {
        sent = true;
        mkdirSync(agentPaths(s.home, "dca").inbox, { recursive: true });
        writeFileSync(join(agentPaths(s.home, "dca").inbox, "1-buy.json"), JSON.stringify({ type: "intent", request: { kind: "buy", coin: "FEAST", bnb: 0.002, reason: "manual buy" } }));
      }
    };
    expect((await runAgent({ home: s.home, name: "dca", signer: s.signer, chain: s.chain, fetch: s.board, now: s.now, sleep, loopMs: 10_000, maxRuntimeMs: 10 * 60_000 })).exit).toBe("finished");
    const log = readFileSync(agentPaths(s.home, "dca").log, "utf8");
    expect(sent).toBe(true);
    expect(existsSync(agentPaths(s.home, "dca").notifications) ? notices(s.home) : []).toEqual([]);
    expect(log).not.toMatch(/"signedOut":true/);
    // The buy went on to the guard and the executor, as for any connected wallet.
    expect(log).toMatch(/"event":"intent.queued"[^\n]*"kind":"buy"/);
  });

  it("says 'back' once after a new scan, and trades again", async () => {
    const clock = { now: Date.parse("2026-10-28T02:00:00Z") };
    let signedIn = false;
    const s = setup(clock, {}, () => signedIn);
    const sleep = async (ms: number) => void (clock.now += ms);
    expect((await runAgent({ home: s.home, name: "dca", signer: s.signer, chain: s.chain, fetch: s.board, now: s.now, sleep, loopMs: 10_000, maxRuntimeMs: 60_000 })).exit).toBe("refused");
    expect(notices(s.home).map((n) => n.code)).toEqual(["ended"]);
    signedIn = true;
    writeStop(agentPaths(s.home, "dca").stop, "a test stop");
    rmSync(agentPaths(s.home, "dca").stop);
    await runAgent({ home: s.home, name: "dca", signer: s.signer, chain: s.chain, fetch: s.board, now: s.now, sleep, loopMs: 10_000, maxRuntimeMs: 60_000 });
    expect(notices(s.home).map((n) => n.code)).toEqual(["ended", "back"]);
  });
});
