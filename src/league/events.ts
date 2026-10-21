import { getAddress, isAddress, type Address, type Hex } from "viem";

/**
 * The event stream (PLAN.md §2.2). There is no client-facing realtime feed, so
 * the runtime polls the Feast indexer's `/v1/events` every 2 s with a cursor.
 *
 * Checked live on 2026-10-21: a cursor `{"b": block, "i": logIndex}` (base64url)
 * is accepted and exclusive; the indexer caches each exact query for 30 s, and a
 * repeated query returned the cached page while one with another `limit` came
 * back fresh. So the poller cycles `limit` through fifteen values: at one poll
 * every 2 s, no query repeats inside the cache's 30 s.
 */

export const INDEXER_URL = "https://indexer.feast.meme";

export type CoinCreatedEvent = {
  type: "coin.created";
  coin: Address;
  poolId: Hex;
  creator: Address;
  quote: Address;
  metadataHash: Hex;
  block: number;
  at: number;
  txHash: Hex;
  depth: string;
};

export type TradeEvent = {
  type: "trade";
  coin: Address;
  poolId: Hex;
  side: "buy" | "sell";
  payer: Address;
  coinAmount: bigint;
  quoteAmount: bigint;
  quote: Address;
  fee: bigint;
  sqrtPriceX96After: bigint;
  block: number;
  at: number;
  txHash: Hex;
  depth: string;
};

export type LeagueEvent = CoinCreatedEvent | TradeEvent;

export function cursorAt(block: number, logIndex = 0): string {
  return Buffer.from(JSON.stringify({ b: block, i: logIndex })).toString("base64url");
}

type Raw = Record<string, unknown>;
const addr = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);
const big = (v: unknown): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" ? BigInt(Math.trunc(v)) : 0n);
const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : Number.NaN);

/** One raw indexer event as a league event; null for anything malformed or of another type. */
export function normalizeEvent(raw: Raw): LeagueEvent | null {
  const coin = addr(raw.coin);
  if (!coin) return null;
  const block = typeof raw.blockNumber === "number" ? raw.blockNumber : Number(raw.blockNumber);
  const at = ms(raw.at);
  if (!Number.isFinite(block) || !Number.isFinite(at)) return null;
  const base = { coin, poolId: String(raw.poolId ?? "0x") as Hex, block, at, txHash: String(raw.txHash ?? "0x") as Hex, depth: String(raw.depth ?? "latest") };
  if (raw.type === "launch") {
    const creator = addr(raw.creator);
    const quote = addr(raw.quote);
    if (!creator || !quote) return null;
    return { type: "coin.created", ...base, creator, quote, metadataHash: String(raw.metadataHash ?? `0x${"0".repeat(64)}`) as Hex };
  }
  if (raw.type === "trade") {
    const payer = addr(raw.payer);
    const quote = addr(raw.quote);
    if (!payer || !quote) return null;
    const side = raw.buy === true || raw.side === "buy" ? "buy" : "sell";
    return {
      type: "trade",
      ...base,
      side,
      payer,
      quote,
      coinAmount: big(raw.coinAmount),
      quoteAmount: big(raw.quoteAmount),
      fee: big(raw.fee),
      sqrtPriceX96After: big(raw.sqrtPriceX96 ?? raw.sqrtPriceX96After),
    };
  }
  return null;
}

export type PollerOptions = {
  base?: string;
  types?: ("launch" | "trade")[];
  fetch?: typeof fetch;
  cursor?: string | null;
};

export class IndexerPoller {
  private cursor: string | null;
  private turn = 0;
  private readonly base: string;
  private readonly types: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PollerOptions = {}) {
    this.base = (options.base ?? INDEXER_URL).replace(/\/+$/, "");
    this.types = (options.types ?? ["launch", "trade"]).join(",");
    this.fetchImpl = options.fetch ?? fetch;
    this.cursor = options.cursor ?? null;
  }

  get position(): string | null {
    return this.cursor;
  }

  private async get(path: string): Promise<{ asOf?: { block?: number }; data?: unknown }> {
    const response = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`the indexer answered HTTP ${response.status} for ${path.split("?")[0]}`);
    return (await response.json()) as { asOf?: { block?: number }; data?: unknown };
  }

  /** Start at the indexer's head, unless the book carries a cursor from an earlier run. */
  async start(): Promise<string> {
    if (this.cursor) return this.cursor;
    const head = await this.get("/v1/events?types=launch&limit=1");
    const block = head.asOf?.block;
    if (typeof block !== "number") throw new Error("the indexer's answer carries no head block");
    this.cursor = cursorAt(block, 0);
    return this.cursor;
  }

  /** The next page after the cursor; `limit` cycles so no query repeats inside the indexer's 30 s cache. */
  async poll(): Promise<LeagueEvent[]> {
    if (!this.cursor) await this.start();
    const limit = 200 - (this.turn % 15);
    this.turn += 1;
    const page = await this.get(`/v1/events?types=${this.types}&cursor=${this.cursor}&limit=${limit}`);
    const rows = Array.isArray(page.data) ? (page.data as Raw[]) : [];
    const last = rows.at(-1);
    if (last && typeof last.cursor === "string") this.cursor = last.cursor;
    return rows.map(normalizeEvent).filter((e): e is LeagueEvent => e !== null);
  }
}
