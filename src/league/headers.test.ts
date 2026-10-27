import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { MAINNET } from "../sdk/networks.ts";
import { confirmAgent, planAgent, saveAgent } from "./agent.ts";
import { dataFace } from "./data/face.ts";
import { fakeFaceChain } from "./data/fakes.ts";
import { Executor } from "./executor.ts";
import { MarketFeed } from "./feed/feed.ts";
import { SnapshotClient } from "./feed/snapshot.ts";
import { checkModel as checkModelHere, declareHost, HOST_HEADER, hostHeaders, modelHint as hintHere, readDeclaredHost, RUNTIME_HEADER, RUNTIME_RELEASE, withHostHeaders } from "./headers.ts";
import { Market } from "./market.ts";
import { checkModel, flushNotes, modelHint, noteCommand } from "./notes/queue.ts";
import { tradeWorld } from "./prompt/fakes.ts";
import { LeagueSite } from "./register/site.ts";
import { appendJsonl, writeFileAtomic } from "./store.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/**
 * Task 975, the owner's ruling B: every request to feast.meme carries `x-feast-host` (which AI hosts the agent) and
 * `x-feast-runtime` (the release); the indexer, the chain and any other origin never see them.
 */

const SITE = "https://feast.test";
const INDEXER = "https://indexer.test";
// Synthetic: never a real wallet.
const WALLET: Address = "0x000000000000000000000000000000000000a11c";
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-headers-"));
  dirs.push(dir);
  return dir;
};

type Seen = { origin: string; path: string; method: string; headers: Record<string, string> };

/** A stub fetch that writes down every request, its headers whole, and answers `answer`. */
function recorder(answer: (url: URL) => Response = () => new Response("{}", { status: 404 })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(new Headers(input instanceof Request ? input.headers : undefined).entries());
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
    seen.push({ origin: url.origin, path: url.pathname, method: init?.method ?? (input instanceof Request ? input.method : "GET"), headers });
    return answer(url);
  }) as typeof fetch;
  return { seen, fetch: fetchImpl };
}

const ENVS: [string, Record<string, string | undefined>, string][] = [
  ["FEAST_LEAGUE_MODEL=grok", { FEAST_LEAGUE_MODEL: "grok", CLAUDECODE: "1" }, "grok"],
  ["an invalid FEAST_LEAGUE_MODEL falls through", { FEAST_LEAGUE_MODEL: "gpt", CLAUDECODE: "1" }, "claude"],
  ["CLAUDECODE=1", { CLAUDECODE: "1" }, "claude"],
  ["CODEX_SANDBOX", { CODEX_SANDBOX: "seatbelt" }, "codex"],
  ["CODEX_SANDBOX_NETWORK_DISABLED", { CODEX_SANDBOX_NETWORK_DISABLED: "1" }, "codex"],
  ["FL enter --host grok, handed on as FEAST_LEAGUE_HOST", { FEAST_LEAGUE_HOST: "grok", CLAUDECODE: "1" }, "grok"],
  ["FEAST_LEAGUE_MODEL before the declared host", { FEAST_LEAGUE_MODEL: "codex", FEAST_LEAGUE_HOST: "grok" }, "codex"],
  ["none", {}, "other"],
];

describe("the values", () => {
  it("x-feast-host is modelHint's, the very function behind FL note's --model default; x-feast-runtime is the release, league-v5.1.6", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits (league-v5.1.4: the release)
    expect(RUNTIME_RELEASE).toBe("league-v5.1.6");
    expect(modelHint).toBe(hintHere);
    expect(checkModel).toBe(checkModelHere);
    for (const [what, env, host] of ENVS) {
      expect(modelHint(env), what).toBe(host);
      expect(hostHeaders(env), what).toEqual({ [HOST_HEADER]: host, [RUNTIME_HEADER]: RUNTIME_RELEASE });
    }
  });

  it("FL note's default model follows the same hint", async () => {
    for (const [what, env, host] of ENVS) {
      const home = tmp();
      const out = await noteCommand({ home, name: "demo", site: SITE, fetch: recorder().fetch, wallet: async () => null, env }, { text: "watching" });
      expect(out.data.model, what).toBe(host);
    }
  });

  it("the host FL enter --host declared is kept for the home, and only one of the four", () => {
    const home = tmp();
    expect(readDeclaredHost(home)).toBeNull();
    declareHost(home, "grok");
    expect(readDeclaredHost(home)).toBe("grok");
    writeFileAtomic(join(home, "league-host.json"), JSON.stringify({ host: "gpt" }));
    expect(readDeclaredHost(home)).toBeNull();
  });
});

describe("withHostHeaders", () => {
  const env = { CLAUDECODE: "1" };
  const ours = { [HOST_HEADER]: "claude", [RUNTIME_HEADER]: RUNTIME_RELEASE };

  it("sets both on feast.meme, keeps every other header, as a plain object, a Headers or a Request", async () => {
    const r = recorder(() => new Response("{}"));
    const f = withHostHeaders(r.fetch, [SITE], env);
    await f(`${SITE}/api/league`, { headers: { accept: "application/json", "If-None-Match": '"e1"', authorization: "Bearer t" } });
    await f(`${SITE}/api/league/notes`, { method: "POST", headers: new Headers({ "content-type": "application/json", "x-feast-host": "spoofed" }) });
    await f(new Request(`${SITE}/api/v1/snapshot`, { headers: { accept: "application/json" } }));
    await f(new URL(`${SITE}/api/pin`), { method: "POST" });
    expect(r.seen.map((s) => s.headers)).toEqual([
      { accept: "application/json", "if-none-match": '"e1"', authorization: "Bearer t", ...ours },
      { "content-type": "application/json", ...ours },
      { accept: "application/json", ...ours },
      ours,
    ]);
  });

  it("a plain object stays a plain object with its own keys", async () => {
    const got: unknown[] = [];
    const f = withHostHeaders((async (_u: string, init?: RequestInit) => (got.push(init?.headers), new Response("{}"))) as unknown as typeof fetch, [SITE], env);
    await f(`${SITE}/x`, { headers: { Accept: "application/json" } });
    expect(got[0]).toEqual({ Accept: "application/json", ...ours });
  });

  it("nothing on any other origin: the indexer, the chain's RPC, another site", async () => {
    const r = recorder(() => new Response("{}"));
    const f = withHostHeaders(r.fetch, [SITE], env);
    await f(`${INDEXER}/v1/board`, { headers: { accept: "application/json" } });
    await f("http://127.0.0.1:8545/", { method: "POST", headers: { "content-type": "application/json" } });
    await f("https://feast.test.example/api", {});
    expect(r.seen.map((s) => s.headers)).toEqual([{ accept: "application/json" }, { "content-type": "application/json" }, {}]);
  });

  it("wrapping twice is harmless", async () => {
    const r = recorder(() => new Response("{}"));
    await withHostHeaders(withHostHeaders(r.fetch, [SITE], env), [SITE], env)(`${SITE}/a`, { headers: { accept: "x" } });
    expect(r.seen[0]!.headers).toEqual({ accept: "x", ...ours });
  });
});

describe("every client that reaches feast.meme", () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });
  const sendsBoth = (seen: Seen[]) => {
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.headers, `${s.method} ${s.path}`).toMatchObject({ [HOST_HEADER]: "grok", [RUNTIME_HEADER]: RUNTIME_RELEASE });
  };

  it("LeagueSite: kept, league, register, the page's Agent ID, the avatar and the notes session (FL note --login's road)", async () => {
    process.env.FEAST_LEAGUE_MODEL = "grok";
    const r = recorder(() => new Response("{}", { status: 404 }));
    const site = new LeagueSite(SITE, r.fetch, 50);
    await site.kept(WALLET).catch(() => null);
    await site.league("today", null).catch(() => null);
    await site.register({} as never).catch(() => null);
    await site.agentIdOnPage(WALLET).catch(() => null);
    await site.avatar("maplegrin", 1_000).catch(() => null);
    await site.noteSession({} as never).catch(() => null);
    expect(new Set(r.seen.map((s) => `${s.method} ${s.path}`)).size).toBeGreaterThanOrEqual(6);
    sendsBoth(r.seen);
  });

  it("the snapshot and its tail; MarketFeed: feast.meme yes, the indexer no", async () => {
    process.env.FEAST_LEAGUE_MODEL = "grok";
    const r = recorder(() => new Response("{}", { status: 503 }));
    const client = new SnapshotClient({ site: SITE, fetch: r.fetch, now: () => 0, random: () => 0, timeoutMs: 0 });
    await client.read();
    await client.readTail("/api/v1/events?fromCursor=x").catch(() => null);
    sendsBoth(r.seen);
    const w = tradeWorld();
    const s = recorder(() => new Response(JSON.stringify({ asOf: { block: 1 }, data: [] })));
    const live = new MarketFeed({ site: SITE, indexer: INDEXER, fetch: s.fetch, now: () => 0, random: () => 0, live: true, market: new Market(w.chain, { indexer: INDEXER, fetch: s.fetch, log: () => {} }), log: () => {} });
    await live.step({ events: true });
    await live.prepareBoard(0);
    const indexed = s.seen.filter((x) => x.origin === INDEXER);
    expect(indexed.length).toBeGreaterThan(0);
    for (const x of indexed) expect(Object.keys(x.headers)).not.toContain(HOST_HEADER);
    const snap = recorder(() => new Response("{}", { status: 503 }));
    const feed = new MarketFeed({ site: SITE, indexer: INDEXER, fetch: snap.fetch, now: () => 0, random: () => 0, market: new Market(w.chain, { indexer: INDEXER, fetch: snap.fetch, log: () => {} }), log: () => {} });
    await feed.step({ events: true });
    sendsBoth(snap.seen.filter((x) => x.origin === SITE));
  });

  it("flushNotes: the notes POST", async () => {
    process.env.FEAST_LEAGUE_MODEL = "grok";
    const home = tmp();
    appendJsonl(join(home, "agents", "demo", "notes.jsonl"), { id: "n1", ts: new Date(0).toISOString(), text: "why", tx: null, model: "grok", sent: false });
    const r = recorder(() => new Response("{}", { status: 201 }));
    await flushNotes(home, "demo", WALLET, { site: SITE, fetch: r.fetch, dev: true });
    expect(r.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/league/notes"]);
    sendsBoth(r.seen);
  });

  it("dataFace: feast.meme yes, the indexer's board no", async () => {
    process.env.FEAST_LEAGUE_MODEL = "grok";
    const home = tmp();
    const promptPath = join(home, "strategy.md");
    writeFileAtomic(promptPath, "Buy what moves.\n");
    const planned = planAgent({ name: "demo", promptPath });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    appendJsonl(join(home, "agents", "demo", "notes.jsonl"), { id: "n1", ts: new Date(0).toISOString(), text: "why", tx: null, model: "grok", sent: false });
    const r = recorder(() => new Response("{}", { status: 503 }));
    await dataFace({ home, site: SITE, indexer: INDEXER, fetch: r.fetch, chain: fakeFaceChain(), wallet: async () => WALLET, now: () => Date.parse("2026-10-29T06:00:00Z"), timeoutMs: 50 }, { name: "demo" });
    const site = r.seen.filter((s) => s.origin === SITE);
    const indexer = r.seen.filter((s) => s.origin === INDEXER);
    sendsBoth(site);
    expect(indexer.length).toBeGreaterThan(0);
    for (const s of indexer) expect(Object.keys(s.headers)).not.toContain(HOST_HEADER);
  });

  it("the executor's launch pin, through the SDK, at the network's siteUrl", async () => {
    process.env.FEAST_LEAGUE_MODEL = "grok";
    const r = recorder(() => Response.json({ error: "stop here" }, { status: 500 }));
    const executor = new Executor({ signer: null as never, chain: null as never, wallet: WALLET, network: MAINNET, rpcUrl: "http://127.0.0.1:9", stopReason: () => null, log: () => {}, fetch: r.fetch });
    await executor.prepareLaunch({ name: "maplegrin.ai", symbol: "MAPLEGRIN", quote: "WBNB" });
    const pins = r.seen.filter((s) => s.origin === new URL(MAINNET.siteUrl).origin);
    sendsBoth(pins);
    for (const s of r.seen.filter((x) => x.origin !== new URL(MAINNET.siteUrl).origin)) expect(Object.keys(s.headers)).not.toContain(HOST_HEADER);
  });
});
