import { getAddress, type Address } from "viem";

import { MAINNET } from "../../sdk/networks.ts";
import { cursorAt } from "../events.ts";

/**
 * TEST FAKES, NOT USED AT RUNTIME (task 967).
 *
 * The site's `/api/v1/snapshot` as tasks 965 and 966 describe it (coin rows
 * with the full creator and the quote's address, event rows in the indexer's
 * `/v1/events` shape, `cursor`, `fromCursor`, an ETag), and the indexer's
 * legacy `/v1/events` and `/v1/board`, as one in-process `fetch`: nothing
 * reaches a network. A virtual clock whose `sleep` only moves time, and a
 * seeded random, so a test of 1,000 clients runs in a second.
 *
 * Every address and hash here is made up, built by hand; no row is copied
 * from a live route.
 */

export const SITE = "https://feast.test";
export const INDEXER = "https://indexer.test";
// Synthetic: never a real wallet.
export const WALLET: Address = "0x000000000000000000000000000000000000a11c";
export const WBNB: Address = MAINNET.contracts.wrappedNative;
export const C1: Address = getAddress("0x00000000000000000000000000000000000c0e01");
export const C2: Address = getAddress("0x00000000000000000000000000000000000c0e02");
export const C3: Address = getAddress("0x00000000000000000000000000000000000c0e03");
export const BOB: Address = getAddress("0x000000000000000000000000000000000000b0b0");
export const CAROL: Address = getAddress("0x000000000000000000000000000000000000ca01");
export const ZERO_HASH = `0x${"0".repeat(64)}`;
export const META_HASH = `0x${"4d".repeat(32)}`;

export const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** One coin row as the snapshot carries it (the coordinator's ruling C2). */
export function coinRow(address: Address, over: Record<string, unknown> = {}) {
  return {
    address: address.toLowerCase(),
    name: `Coin ${address.slice(-2)}`,
    symbol: `C${address.slice(-2)}`,
    quote: WBNB.toLowerCase(),
    creator: BOB.toLowerCase(),
    metadataHash: META_HASH,
    launchedAt: "2026-10-28T12:00:00.000Z",
    priceQuote: 0.000001,
    priceBnb: 0.000001,
    volume24hBnb: 2.5,
    trades24h: 12,
    lastTradeAt: "2026-10-28T12:59:00.000Z",
    holders: 30,
    lastCursor: cursorAt(100, 0),
    ...over,
  };
}

/** A launch as `/v1/events` gives it. */
export function launchRow(block: number, logIndex: number, over: Record<string, unknown> = {}) {
  return {
    type: "launch",
    at: new Date(Date.parse("2026-10-28T13:00:00Z") + block * 1_000).toISOString(),
    blockNumber: block,
    logIndex,
    cursor: cursorAt(block, logIndex),
    coin: C3.toLowerCase(),
    creator: CAROL.toLowerCase(),
    quote: WBNB.toLowerCase(),
    metadataHash: META_HASH,
    poolId: hash(0xc3),
    supply: "1000000000000000000000000000",
    referrerBps: 1000,
    selfBurnBps: 2000,
    depth: "latest",
    txHash: hash(block * 100 + logIndex),
    ...over,
  };
}

/** A trade as `/v1/events` gives it. */
export function tradeRow(block: number, logIndex: number, over: Record<string, unknown> = {}) {
  return {
    type: "trade",
    at: new Date(Date.parse("2026-10-28T13:00:00Z") + block * 1_000).toISOString(),
    blockNumber: block,
    blockHash: hash(block),
    logIndex,
    cursor: cursorAt(block, logIndex),
    coin: C1.toLowerCase(),
    buy: true,
    payer: BOB.toLowerCase(),
    quote: WBNB.toLowerCase(),
    coinAmount: "1000000000000000000000",
    quoteAmount: "2000000000000000",
    fee: "20000000000000",
    sqrtPriceX96: String(2n ** 86n),
    poolId: hash(0xc1),
    depth: "latest",
    txHash: hash(block * 100 + logIndex),
    ...over,
  };
}

export type SnapshotBody = { generatedAt: string; block: number; coins: unknown[]; events: unknown[]; cursor: string; fromCursor?: string; toCursor?: string; truncated?: boolean };

export function snapshotBody(over: Partial<SnapshotBody> & { block?: number } = {}): SnapshotBody {
  const block = over.block ?? 100;
  return { generatedAt: new Date(Date.parse("2026-10-28T13:00:00Z") + block * 1_000).toISOString(), block, coins: [coinRow(C1), coinRow(C2, { creator: CAROL.toLowerCase(), holders: 7 })], events: [], cursor: cursorAt(block, 0), ...over };
}

export type Answer = { status: number; body?: unknown; etag?: string; headers?: Record<string, string> } | "refused";

export type Asked = { at: number; method: string; url: string; headers: Record<string, string> };

/**
 * feast.meme's snapshot and the indexer's legacy routes. `snapshot(at, asked)` answers each snapshot GET (an ETag on a
 * 200, a 304 when If-None-Match holds the current one); `events` and `board` answer the indexer.
 */
export class FakeFeed {
  readonly asked: Asked[] = [];
  snapshot: (at: number, asked: Asked) => Answer;
  events: (at: number, url: URL) => Answer = () => ({ status: 200, body: { asOf: { block: 100 }, data: [] } });
  board: (at: number) => Answer = () => ({ status: 200, body: { data: [] } });
  /** Every other path on either origin. */
  other: (url: URL, init?: RequestInit) => Answer | null = () => null;

  constructor(
    private readonly now: () => number,
    snapshot?: (at: number, asked: Asked) => Answer,
  ) {
    this.snapshot = snapshot ?? (() => ({ status: 200, body: snapshotBody(), etag: '"s100"' }));
  }

  /** Snapshot requests only. */
  snapshots(): Asked[] {
    return this.asked.filter((a) => a.url.includes("/api/v1/snapshot"));
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const asked: Asked = { at: this.now(), method: init?.method ?? "GET", url: `${url.origin}${url.pathname}${url.search}`, headers };
    this.asked.push(asked);
    let answer: Answer | null = null;
    if (url.origin === SITE && url.pathname === "/api/v1/snapshot") {
      answer = this.snapshot(asked.at, asked);
      if (answer !== "refused" && answer.status === 200 && answer.etag && headers["if-none-match"] === answer.etag) answer = { status: 304, etag: answer.etag };
    } else if (url.origin === INDEXER && url.pathname === "/v1/events") answer = this.events(asked.at, url);
    else if (url.origin === INDEXER && url.pathname === "/v1/board") answer = this.board(asked.at);
    else answer = this.other(url, init);
    if (answer === null) return new Response("{}", { status: 404 });
    if (answer === "refused") throw new TypeError("fetch failed");
    const out: Record<string, string> = { "content-type": "application/json", ...(answer.etag ? { etag: answer.etag } : {}), ...answer.headers };
    return new Response(answer.status === 304 || answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: out });
  }) as typeof fetch;
}

/** A small, fast, seeded random in [0, 1) (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Virtual time: `sleep` registers a wake-up and only the driver moves the clock, to the earliest one. Everything awaited
 * between two sleeps must settle in microtasks (the load test's fetch answers with a plain object, not a stream).
 */
export class VirtualTime {
  t: number;
  private heap: { at: number; seq: number; wake: () => void }[] = [];
  private seq = 0;

  constructor(start = 0) {
    this.t = start;
  }

  readonly now = () => this.t;

  readonly sleep = (ms: number) =>
    new Promise<void>((wake) => {
      this.push({ at: this.t + Math.max(0, ms), seq: (this.seq += 1), wake });
    });

  private less(a: number, b: number): boolean {
    const x = this.heap[a]!;
    const y = this.heap[b]!;
    return x.at < y.at || (x.at === y.at && x.seq < y.seq);
  }

  private swap(a: number, b: number): void {
    const h = this.heap;
    [h[a], h[b]] = [h[b]!, h[a]!];
  }

  private push(item: { at: number; seq: number; wake: () => void }): void {
    this.heap.push(item);
    for (let i = this.heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private pop(): { at: number; seq: number; wake: () => void } {
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.heap.length && this.less(l, m)) m = l;
        if (r < this.heap.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  /** Wake every sleeper due by `end`, in time order, letting each run until it sleeps again. */
  async runUntil(end: number): Promise<void> {
    // Whoever is running now first reaches its next sleep.
    await new Promise((r) => setImmediate(r));
    while (this.heap.length > 0 && this.heap[0]!.at <= end) {
      const at = this.heap[0]!.at;
      this.t = at;
      // Everyone due at this instant wakes together.
      while (this.heap.length > 0 && this.heap[0]!.at === at) this.pop().wake();
      await new Promise((r) => setImmediate(r));
    }
    this.t = Math.max(this.t, end);
  }
}
