import { existsSync, readFileSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";

import { MAINNET } from "../../sdk/networks.ts";
import { coinPicture } from "../../sdk/metadata.ts";
import { emptyBook, parseBook, serializeBook } from "../book.ts";
import type { AgentIdRead, CoinInfo, LeagueChain } from "../chain.ts";
import { Executor } from "../executor.ts";
import { agentPaths, writeFileAtomic } from "../store.ts";
import { normalizeIntent, type IntentRequest } from "../strategy.ts";
import { leagueWire } from "../register/fakes.ts";
import { ENTRY_AGENT } from "./constants.ts";
import type { EnterChain, OneShot, OneShotResult } from "./flow.ts";

/**
 * TEST FAKES, NOT USED AT RUNTIME (task 961).
 *
 * `FakeEnterSite`: feast.meme's league reads as task 960 shapes them
 * (`/api/league/agent-id`, `/api/league/avatar/<id>.png`, `/api/league` for the
 * season), the notes session route task 964 builds (`/api/league/notes/session`),
 * its `/api/pin`, and the indexer's `/v1/creators`, as one in-process `fetch`:
 * nothing reaches a network. It writes down every path it is asked, every pin
 * it receives and every session asked for.
 *
 * `fakeEnterChain`: the chain reads `FL enter` makes. `fakeOneShot`: the
 * runtime's one-shot, booking what a landed launch or buy would book; with
 * `pinWith`, a launch first goes through the real `normalizeIntent` and
 * `Executor.prepareLaunch`, so the picture's whole path to `/api/pin` is the
 * real one.
 *
 * Every address here is made up.
 */

export const SITE = "https://feast.test";
export const INDEXER = "https://indexer.test";

/** A league picture: a real PNG, unlike any ticker's. */
export const AVATAR_PNG: Uint8Array = coinPicture("the league creature (a test fixture)", 64);

export type Answer = { status: number; body: unknown; contentType?: string } | "timeout" | "refused";

export type FakeSiteOptions = {
  wallet: Address;
  /** `/api/league/agent-id`: the page's row, or a raw answer. */
  agentId?: { agentId: string | null; wallet?: string; coins?: { coin: string; launchedAt: string }[] | null } | Answer;
  /** `/api/league/avatar/<id>.png`. */
  avatar?: { status?: number; contentType?: string; bytes?: Uint8Array } | "timeout";
  /** `POST /api/league/notes/session`. */
  session?: Answer;
  /** `/v1/creators`: rows (any creator), or down. */
  creators?: { coin: string; creator: string; launchedAt?: string }[] | "down";
  /** `/api/pin` refuses the metadata document (after taking the picture), so a launch stops before any chain read. */
  pinMetadata?: "ok" | "refuse";
};

export class FakeEnterSite {
  readonly calls: string[] = [];
  readonly pins: { kind: "image" | "metadata"; bytes: Uint8Array | null; json: unknown }[] = [];
  readonly sessions: unknown[] = [];

  constructor(readonly options: FakeSiteOptions) {}

  private answer(a: Answer, signal: AbortSignal | null | undefined): Promise<Response> {
    if (a === "refused") return Promise.reject(new TypeError("fetch failed"));
    if (a === "timeout") return hang(signal);
    const text = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    return Promise.resolve(new Response(text, { status: a.status, headers: { "content-type": a.contentType ?? "application/json" } }));
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}${url.search}`);
    const signal = init?.signal;
    const o = this.options;
    if (url.origin === INDEXER && url.pathname === "/v1/creators") {
      if (o.creators === "down") return new Response("{}", { status: 503 });
      return Response.json({ schemaVersion: 1, asOf: null, data: o.creators ?? [] });
    }
    // The SDK pins through the network's own site: any origin's /api/pin lands here.
    if (url.pathname === "/api/pin" && init?.method === "POST") {
      if (init.body instanceof FormData) {
        const file = init.body.get("file") as Blob;
        this.pins.push({ kind: "image", bytes: new Uint8Array(await file.arrayBuffer()), json: null });
        return Response.json({ cid: "bafkreiimage", digest: `0x${"11".repeat(32)}` });
      }
      this.pins.push({ kind: "metadata", bytes: null, json: JSON.parse(String(init.body)) });
      if (o.pinMetadata === "refuse") return Response.json({ error: "a test refusal, after the picture" }, { status: 500 });
      return Response.json({ cid: "bafkreimeta", digest: `0x${"22".repeat(32)}` });
    }
    if (url.origin !== SITE) throw new Error(`the fake site has no ${url.origin}`);
    if (url.pathname === "/api/league/agent-id") {
      const a = o.agentId ?? { agentId: null };
      if (a === "timeout" || a === "refused" || "status" in a) return this.answer(a, signal);
      return Response.json({ wallet: (a.wallet ?? o.wallet).toLowerCase(), agentId: a.agentId, coins: a.coins ?? null });
    }
    if (url.pathname.startsWith("/api/league/avatar/")) {
      const a = o.avatar ?? { status: 404 };
      if (a === "timeout") return hang(signal);
      const status = a.status ?? 200;
      return new Response(status === 200 ? Buffer.from(a.bytes ?? AVATAR_PNG) : "<html>not found</html>", { status, headers: { "content-type": a.contentType ?? (status === 200 ? "image/png" : "text/html") } });
    }
    if (url.pathname === "/api/league") return Response.json(leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: "2026-10-26T12:00:00.000Z" } }));
    if (url.pathname === "/api/league/notes/session" && init?.method === "POST") {
      this.sessions.push(JSON.parse(String(init.body)));
      return this.answer(o.session ?? { status: 404, body: "<html>not found</html>", contentType: "text/html" }, signal);
    }
    return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}

/** A request that never answers: it ends when its signal aborts, as a timeout does. */
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export type FakeChainOptions = {
  agentId: string | null | "unreadable";
  /** Who launched each coin (lower case); missing: not a Feast coin. */
  creators?: Record<string, Address | "unreadable">;
  /** The coins the factory made besides those in `creators` (lower case), FEAST included. */
  feastCoins?: string[];
  feastUnreadable?: boolean;
  symbols?: Record<string, string>;
};

export function fakeEnterChain(o: FakeChainOptions): EnterChain & { reads: string[] } {
  const reads: string[] = [];
  const feast = new Set([MAINNET.platformCoin!.address.toLowerCase(), ...(o.feastCoins ?? []).map((c) => c.toLowerCase())]);
  return {
    reads,
    async agentIdOf(): Promise<AgentIdRead> {
      reads.push("agentIdOf");
      if (o.agentId === "unreadable") return { state: "unreadable", reason: "the RPC did not answer" };
      return { state: "read", id: o.agentId };
    },
    async creatorOf(coin) {
      reads.push(`creatorOf ${coin}`);
      const c = o.creators?.[coin.toLowerCase()];
      if (c === "unreadable") return "unreadable";
      return c ?? null;
    },
    async coinInfo(coin) {
      reads.push(`coinInfo ${coin}`);
      const symbol = o.symbols?.[coin.toLowerCase()] ?? "COIN";
      return { coin, quote: MAINNET.contracts.wrappedNative, creator: coin, poolId: "0x01", coinIsCurrency0: true, symbol, name: symbol } as CoinInfo;
    },
    async isFeastCoin(coin) {
      reads.push(`isFeastCoin ${coin}`);
      if (o.feastUnreadable) throw new Error("HTTP request failed. URL: https://rpc.invalid/secret-key");
      return feast.has(coin.toLowerCase()) || o.creators?.[coin.toLowerCase()] !== undefined;
    },
  };
}

export type FakeShotOptions = {
  home: string;
  /** The coin a launch makes. */
  launchCoin?: Address;
  /** Run a launch's picture through the real request path to `/api/pin`. */
  pinWith?: { fetch: typeof fetch; wallet: Address };
  /** The launch does not land. */
  fail?: "launch";
};

let hashes = 0;
export const fakeHash = (): Hex => `0x${(hashes += 1).toString(16).padStart(64, "0")}` as Hex;

/** The runtime's one-shot, as far as the book goes: what a landed launch books. */
export function fakeOneShot(o: FakeShotOptions): { run: OneShot; requests: IntentRequest[][] } {
  const requests: IntentRequest[][] = [];
  const paths = agentPaths(o.home, ENTRY_AGENT);
  const book = () => (existsSync(paths.state) ? parseBook(readFileSync(paths.state, "utf8")) : emptyBook());
  const nothing = (reason: string): OneShotResult => ({ exit: "finished", reason, launched: null, failure: null });
  const run: OneShot = async (list) => {
    requests.push(list);
    const [request] = list;
    if (!request) return nothing("nothing asked");
    if (request.kind === "launch") {
      if (o.pinWith) {
        const normal = normalizeIntent(request, { snapshot: { feast: MAINNET.platformCoin!.address, now: Date.now(), limits: {} as never }, source: "manual", slippagePct: 3, ttlMs: 120_000 });
        if ("error" in normal) throw new Error(normal.error);
        const executor = new Executor({ signer: null as never, chain: null as never, wallet: o.pinWith.wallet, network: MAINNET, rpcUrl: "http://127.0.0.1:9", stopReason: () => null, log: () => {}, fetch: o.pinWith.fetch });
        await executor.prepareLaunch(normal.intent.launch!);
      }
      if (o.fail === "launch") return { exit: "finished", reason: "the manual request ran", launched: null, failure: "launch failed at gate: the preview flagged a risk" };
      const coin = o.launchCoin ?? getAddress("0x00000000000000000000000000000000000b0d1e");
      const txHash = fakeHash();
      writeFileAtomic(paths.state, serializeBook({ ...book(), launched: { coin, poolId: "0x01", at: Date.now(), txHash } }));
      return { exit: "finished", reason: "the manual request ran", launched: { coin, txHash }, failure: null };
    }
    return nothing("not a request the entry makes");
  };
  return { run, requests };
}
