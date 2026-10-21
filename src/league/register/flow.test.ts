import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BawSigner } from "../baw.ts";
import type { CoinInfo } from "../chain.ts";
import { leagueRecordPath } from "../store.ts";
import { fakeBaw, FakeLeaguePage, leagueWire, type FakeBawOptions, type FakePageOptions } from "./fakes.ts";
import { check, prepare, submit, type FlowChain, type FlowDeps } from "./flow.ts";
import { LeagueSite } from "./site.ts";

// Synthetic: a key made for each test, never a real wallet.
const COIN: Address = getAddress("0x00000000000000000000000000000000000ffeed");
const OLDER: Address = getAddress("0x00000000000000000000000000000000000fbeef");

let homes: string[] = [];
let pages: FakeLeaguePage[] = [];
beforeEach(() => {
  homes = [];
  pages = [];
});
afterEach(async () => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  for (const p of pages) await p.stop();
});

type World = { deps: FlowDeps; page: FakeLeaguePage; calls: string[][]; wallet: Address; home: string };

async function world(options: { baw?: Partial<FakeBawOptions>; page?: Partial<FakePageOptions>; agentId?: string | null | "unreadable"; coins?: Address[]; indexer?: "down" } = {}): Promise<World> {
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = account.address;
  const home = mkdtempSync(join(tmpdir(), "feast-league-register-"));
  homes.push(home);
  const agentId = options.agentId === undefined ? "maplegrin" : options.agentId;
  const coins = options.coins ?? [COIN];
  const page = new FakeLeaguePage({
    agentIds: { [wallet.toLowerCase()]: agentId },
    creators: Object.fromEntries(coins.map((c) => [c.toLowerCase(), wallet.toLowerCase()])),
    league: leagueWire(),
    ...options.page,
  });
  pages.push(page);
  await page.start();
  const { runner, calls } = fakeBaw({ account, ...options.baw });
  const chain: FlowChain = {
    agentIdOf: async () => (agentId === "unreadable" ? { state: "unreadable", reason: "rpc down" } : { state: "read", id: agentId }),
    creatorOf: async (coin) => (coins.some((c) => c.toLowerCase() === coin.toLowerCase()) ? wallet : null),
    coinInfo: async (coin) => ({ coin, symbol: coin === COIN ? "MAPLEGRIN" : "OLD", name: "x", quote: coin, creator: wallet, poolId: "0x01", coinIsCurrency0: true }) as CoinInfo,
  };
  const indexerFetch = (async () =>
    options.indexer === "down"
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ schemaVersion: 1, data: coins.map((c, i) => ({ coin: c.toLowerCase(), creator: wallet.toLowerCase(), launchedAt: new Date(Date.UTC(2026, 9, 21 - i)).toISOString() })) }))) as unknown as typeof fetch;
  const logs: string[] = [];
  const deps: FlowDeps = {
    home,
    name: "maple",
    signer: new BawSigner(runner),
    chain,
    site: new LeagueSite(page.base),
    indexer: "https://indexer.test",
    fetch: indexerFetch,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  };
  Object.assign(deps, { logs });
  return { deps, page, calls, wallet, home };
}

const MANIFESTO = "Small, fast bites on brand-new coins. I cut losses early and never chase.";

async function register(w: World, input: { manifesto?: string; xHandle?: string | null; pending?: boolean; named?: string | null } = {}) {
  const ready = await check(w.deps, { named: input.named ?? null });
  if (ready.kind !== "ready") throw new Error(`not ready: ${ready.kind}`);
  const prepared = prepare(ready, { manifesto: input.manifesto ?? MANIFESTO, xHandle: input.xHandle ?? null, pending: input.pending }, Date.now());
  if (!prepared.ok) throw new Error(`not prepared: ${JSON.stringify(prepared.problem)}`);
  return { ready, prepared: prepared.prepared, outcome: await submit(w.deps, prepared.prepared, { sleep: async () => {} }) };
}

describe("registration, end to end against the fake page (PLAN-941 §1, §10)", () => {
  it("reads the Agent ID and the body coin, signs, sends, and keeps the seat — with no address on disk", async () => {
    const w = await world();
    const { ready, outcome } = await register(w);
    expect(ready).toMatchObject({ kind: "ready", agentId: "maplegrin", plan: { kind: "coin", coin: COIN, why: "only" }, coin: { symbol: "MAPLEGRIN" } });
    expect(outcome).toMatchObject({ kind: "answer", answer: { kind: "kept", seating: { kind: "seated", seatNo: 1, founding: false, waitlisted: false, place: null }, prereg: "unclaimed" } });
    // What was sent: the fields and the two claims, nothing about the agent's setup.
    const sent = w.page.posts[0]!;
    expect(Object.keys(sent).sort()).toEqual(["bodyCoin", "copies", "issuedAt", "name", "scheme", "signature", "signatureRecovery", "strategy", "wallet"]);
    expect(sent).toMatchObject({ name: "maplegrin", strategy: MANIFESTO, copies: null, scheme: "eip712", bodyCoin: COIN.toLowerCase(), wallet: w.wallet.toLowerCase() });
    expect(String(sent.signature)).toMatch(/^[0-9a-f]{128}$/);
    // The record holds the answer, not the address and not the signature.
    const record = readFileSync(leagueRecordPath(w.home), "utf8");
    expect(record).not.toContain(w.wallet.toLowerCase().slice(2));
    expect(record).not.toContain(String(sent.signature));
    expect(JSON.parse(record)).toMatchObject({ agentId: "maplegrin", bodyCoin: COIN.toLowerCase(), seating: { kind: "seated", seatNo: 1 } });
    expect(((w.deps as unknown as { logs: string[] }).logs).join("\n")).not.toContain(w.wallet.toLowerCase().slice(2));
    // The wallet saw one preview and one execute.
    expect(w.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["wallet status", "wallet settings", "wallet address", "wallet status", "wallet settings", "sign-message preview", "sign-message execute"]);
  });

  it("gives a founding seat when the page says so, with its roster number", async () => {
    const w = await world({ page: { roster: { maplegrin: { number: 42, xHandle: "maple_grin" } }, preSeason: true } });
    const { outcome } = await register(w, { xHandle: "@maple_grin" });
    expect(outcome).toMatchObject({ answer: { kind: "kept", seating: { kind: "seated", founding: true, foundingNo: 42 }, prereg: "matched" } });
    expect(w.page.posts[0]).toMatchObject({ xHandle: "maple_grin" });
  });

  it("says when the X handle matched no pre-registration", async () => {
    const w = await world({ page: { roster: { maplegrin: { number: 7, xHandle: "someone" } } } });
    expect((await register(w, { xHandle: "x.com/maple_grin" })).outcome).toMatchObject({ answer: { prereg: "none" } });
  });

  it("puts the 1,001st on the waitlist at place 1, and reads the place from each answer shape", async () => {
    for (const shape of ["run5", "sealed", "plan"] as const) {
      const w = await world({ page: { nextSeat: 1_001, seatingShape: shape } });
      expect((await register(w)).outcome).toMatchObject({ answer: { kind: "kept", seating: { kind: "seated", seatNo: 1_001, waitlisted: true, place: 1 } } });
    }
  });

  it("registers without a body coin only when asked to, and then without a seat", async () => {
    const w = await world({ coins: [] });
    const ready = await check(w.deps);
    if (ready.kind !== "ready") throw new Error(ready.kind);
    expect(ready.plan).toEqual({ kind: "launch" });
    expect(prepare(ready, { manifesto: MANIFESTO }, Date.now())).toMatchObject({ ok: false, problem: { kind: "body-coin" } });
    const { outcome } = await register(w, { pending: true });
    expect(outcome).toMatchObject({ answer: { kind: "kept", seating: { kind: "pending", reason: "no-body-coin" } } });
    expect(w.page.posts[0]).not.toHaveProperty("bodyCoin");
  });

  it("signs again with a newer issuedAt; the seat and the body coin stay", async () => {
    const w = await world({ coins: [COIN, OLDER] });
    const first = await register(w);
    const again = await register(w, { manifesto: "A new manifesto.", named: OLDER });
    expect(again.ready).toMatchObject({ plan: { kind: "coin", coin: COIN, why: "fixed" } });
    expect(again.prepared.fields.issuedAt).toBeGreaterThan(first.prepared.fields.issuedAt);
    expect(again.prepared.view.replaces).toMatchObject({ issuedAt: first.prepared.fields.issuedAt, seated: true });
    expect(again.outcome).toMatchObject({ answer: { kind: "kept", seating: { seatNo: 1 } } });
    expect(w.page.kept.get(w.wallet.toLowerCase())).toMatchObject({ manifesto: "A new manifesto.", bodyCoin: COIN.toLowerCase() });
  });

  it("waits for the App's confirmation, then sends", async () => {
    const w = await world({ baw: { confirm: { kind: "app", polls: 3, then: "COMPLETED" } } });
    expect((await register(w)).outcome).toMatchObject({ answer: { kind: "kept" } });
    expect(w.calls.filter((c) => c[1] === "result")).toHaveLength(3);
  });

  it("sends nothing when the App declines or the request expires", async () => {
    for (const then of ["REJECTED", "EXPIRED"] as const) {
      const w = await world({ baw: { confirm: { kind: "app", polls: 1, then } } });
      expect((await register(w)).outcome).toMatchObject({ kind: "not-signed", why: { kind: then === "REJECTED" ? "declined" : "expired" } });
      expect(w.page.posts).toHaveLength(0);
    }
  });

  it("signs nothing when the preview reads back other fields, flags a risk, or is refused", async () => {
    for (const baw of [{ tamper: true }, { risk: true }, { refusePreview: true }]) {
      const w = await world({ baw });
      const { outcome } = await register(w);
      expect(outcome.kind).toBe("not-signed");
      expect(w.calls.some((c) => c[1] === "execute")).toBe(false);
      expect(w.page.posts).toHaveLength(0);
    }
  });

  it("sends nothing whose signature does not recover this wallet here", async () => {
    const w = await world({ baw: { signWith: privateKeyToAccount(generatePrivateKey()) } });
    expect((await register(w)).outcome).toMatchObject({ kind: "local-check-failed" });
    expect(w.page.posts).toHaveLength(0);
  });

  it("takes a 65-byte signature as the wallet may give it", async () => {
    const w = await world({ baw: { signatureForm: "full" } });
    expect((await register(w)).outcome).toMatchObject({ answer: { kind: "kept" } });
    expect(String(w.page.posts[0]!.signature)).toMatch(/^0x[0-9a-f]{130}$/);
    expect(w.page.posts[0]).not.toHaveProperty("signatureRecovery");
  });

  it("reconciles an answer that never came: it landed, and says so", async () => {
    const w = await world();
    w.page.next = { dropAnswer: true };
    expect((await register(w)).outcome).toMatchObject({ kind: "answer", answer: { kind: "kept", seating: { kind: "seated", seatNo: 1 } }, reconciled: true });
  });

  it("reads every refusal by its code", async () => {
    for (const [status, code, field] of [
      [400, "invalid-fields", "strategy"],
      [400, "stale", undefined],
      [400, "no-agent-id", undefined],
      [400, "agent-id-mismatch", undefined],
      [400, "body-coin-not-yours", undefined],
      [401, "bad-signature", undefined],
      [409, "name-taken", undefined],
      [503, "upstream-unavailable", undefined],
    ] as const) {
      const w = await world();
      w.page.next = { refuse: { status, code, field } };
      expect((await register(w)).outcome).toMatchObject({ kind: "answer", answer: { kind: "refused", status, code, field: field ?? null } });
    }
    const limited = await world();
    limited.page.next = { status: 429 };
    expect((await register(limited)).outcome).toMatchObject({ answer: { kind: "refused", status: 429, code: "rate-limited" } });
  });

  it("is refused by the page's own checks: another wallet's Agent ID, another wallet's coin, an old issuedAt", async () => {
    const mismatch = await world({ page: { agentIds: {} } });
    mismatch.page.options.agentIds[mismatch.wallet.toLowerCase()] = "somebodyelse";
    expect((await register(mismatch)).outcome).toMatchObject({ answer: { kind: "refused", code: "agent-id-mismatch" } });
    const notYours = await world();
    notYours.page.options.creators = {};
    expect((await register(notYours)).outcome).toMatchObject({ answer: { kind: "refused", code: "body-coin-not-yours" } });
    const stale = await world({ page: { now: () => Date.now() + 40 * 60_000 } });
    expect((await register(stale)).outcome).toMatchObject({ answer: { kind: "refused", code: "stale" } });
  });

  it("says plainly what is missing before anything is signed", async () => {
    expect(await check((await world({ baw: { connected: false } })).deps)).toEqual({ kind: "not-ready", reason: "signed-out" });
    expect(await check((await world({ baw: { devMode: false } })).deps)).toEqual({ kind: "not-ready", reason: "devmode" });
    expect(await check((await world({ agentId: null })).deps)).toEqual({ kind: "no-agent-id" });
    expect(await check((await world({ agentId: "unreadable" })).deps)).toMatchObject({ kind: "agent-id-unreadable" });
    expect(await check((await world({ indexer: "down" })).deps)).toMatchObject({ kind: "ready", plan: { kind: "ask-address" } });
  });

  it("writes no record when nothing was kept", async () => {
    const w = await world();
    w.page.next = { refuse: { status: 401, code: "bad-signature" } };
    await register(w);
    expect(existsSync(leagueRecordPath(w.home))).toBe(false);
  });
});
