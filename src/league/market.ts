import { getAddress, isAddress, type Address } from "viem";

import { E18, coinPriceE18 } from "../sdk/price.ts";
import type { Book } from "./book.ts";
import type { LeagueChain } from "./chain.ts";
import { INDEXER_URL, IndexerError, type LeagueEvent } from "./events.ts";
import { snapshotCoins, type FeastSnapshot } from "./feed/snapshot.ts";
import { bnbToWei, type Limits } from "./limits.ts";
import type { CoinRow, PositionRow, Snapshot, StrategyEvent, TradeRow } from "./strategy.ts";

/**
 * The snapshot a strategy reads (PLAN.md §2.2–2.4, §15): the board for
 * discovery — holders, volume, last price — and the chain for anything money is
 * measured by: every position is marked at the pool's spot price. Trades,
 * holder counts and launches seen on the event stream are kept in memory for
 * the windows the presets look back over.
 *
 * The board's rows come from feast.meme's market snapshot (task 967), priced by
 * the server, with no chain read per row; or, while that route is not deployed
 * or with `--live`, from the indexer's board as before. Nothing here fetches on
 * a tick: `feed/feed.ts` reads, under its backoff, and this holds the rows.
 */

const ZERO_HASH = `0x${"0".repeat(64)}`;
const HOUR = 3_600_000;
const BOARD_TTL_MS = 15_000;
/** One holder sample per coin a minute at most, so the window cannot grow with a 5 s read. */
const HOLDER_SAMPLE_MS = 60_000;
/** A watched coin moving this much between two trades is a `price.move`. */
const PRICE_MOVE_PCT = 5;

type BoardRow = {
  coin: string;
  creator: string;
  quote: string;
  metadataHash: string;
  launchedAt: string;
  lastPriceSqrtX96: string | null;
  volume24h: string;
  trades24h: number;
  holders: number;
};

const toNumber = (value: bigint, scale: bigint = E18) => Number(value / scale) + Number(value % scale) / Number(scale);

export class Market {
  private board: { at: number; rows: CoinRow[] } | null = null;
  private trades: TradeRow[] = [];
  private holders: Record<string, { at: number; holders: number }[]> = {};
  private launches: Record<string, number[]> = {};
  private priceRef: Record<string, number> = {};

  constructor(
    private readonly chain: LeagueChain,
    private readonly options: { indexer?: string; fetch?: typeof fetch; log: (event: string, fields: Record<string, unknown>) => void },
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  /** BNB per whole coin from a sqrt price, through the coin's quote. */
  private async priceBnb(coin: Address, sqrtPriceX96: bigint): Promise<number | null> {
    const info = await this.chain.coinInfo(coin).catch(() => null);
    if (!info || sqrtPriceX96 === 0n) return null;
    const quotePerCoin = coinPriceE18(sqrtPriceX96, info.coinIsCurrency0);
    const quoteBnb = await this.chain.quoteBnbE18(info.quote).catch(() => null);
    return quoteBnb === null ? null : toNumber((quotePerCoin * quoteBnb) / E18);
  }

  async refreshBoard(now: number): Promise<CoinRow[]> {
    if (this.board && now - this.board.at < BOARD_TTL_MS) return this.board.rows;
    const response = await this.fetchImpl(`${(this.options.indexer ?? INDEXER_URL).replace(/\/+$/, "")}/v1/board?limit=100`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new IndexerError(`the indexer's board answered HTTP ${response.status}`, response.status, response.headers.get("retry-after"));
    const body = (await response.json()) as { data?: BoardRow[] };
    // The rows' chain reads run eight at a time: a cold cache is a few round trips, not hundreds in series.
    const raws = (Array.isArray(body.data) ? body.data : []).filter((r) => isAddress(r.coin, { strict: false }) && isAddress(r.quote, { strict: false }));
    const built: (CoinRow | null)[] = [];
    for (let i = 0; i < raws.length; i += 8) {
      built.push(...(await Promise.all(raws.slice(i, i + 8).map((raw) => this.boardRow(raw, now)))));
    }
    const rows = built.filter((r): r is CoinRow => r !== null);
    this.board = { at: now, rows };
    return rows;
  }

  private async boardRow(raw: BoardRow, now: number): Promise<CoinRow | null> {
    const coin = getAddress(raw.coin);
    const quote = getAddress(raw.quote);
    const info = await this.chain.coinInfo(coin).catch(() => null);
    if (!info) return null;
    const quoteBnb = await this.chain.quoteBnbE18(quote).catch(() => null);
    const launchedAt = Date.parse(raw.launchedAt);
    const volume = /^\d+$/.test(String(raw.volume24h)) ? BigInt(raw.volume24h) : 0n;
    const sqrt = raw.lastPriceSqrtX96 && /^\d+$/.test(raw.lastPriceSqrtX96) ? BigInt(raw.lastPriceSqrtX96) : 0n;
    this.sample(coin, Number(raw.holders) || 0, now);
    this.launched(raw.creator, launchedAt, now);
    return {
      coin,
      symbol: info.symbol,
      quote,
      creator: isAddress(raw.creator, { strict: false }) ? getAddress(raw.creator) : info.creator,
      launchedAt,
      ageSeconds: Math.max(0, Math.floor((now - launchedAt) / 1_000)),
      holders: Number(raw.holders) || 0,
      volume24hBnb: quoteBnb === null ? 0 : toNumber((volume * quoteBnb) / E18),
      trades24h: Number(raw.trades24h) || 0,
      priceBnb: sqrt > 0n ? await this.priceBnb(coin, sqrt) : null,
      hasMetadata: raw.metadataHash !== ZERO_HASH,
    };
  }

  private sample(coin: Address, holders: number, now: number): void {
    const k = coin.toLowerCase();
    const kept = (this.holders[k] ?? []).filter((s) => now - s.at < 4 * HOUR);
    const last = kept.at(-1);
    this.holders[k] = last && now - last.at < HOLDER_SAMPLE_MS ? kept : [...kept, { at: now, holders }];
  }

  private launched(creatorRaw: string, launchedAt: number, now: number): void {
    const creator = creatorRaw.toLowerCase();
    if (Number.isFinite(launchedAt) && now - launchedAt < 24 * HOUR && !(this.launches[creator] ?? []).includes(launchedAt)) {
      this.launches[creator] = [...(this.launches[creator] ?? []), launchedAt];
    }
  }

  /**
   * The board from a snapshot's coins: the server's price and volume in BNB, no chain read per row. A price the
   * snapshot gives as null (unknown, never zero) is its price in the quote times the quote's BNB value, one cached
   * read per quote; a creator it does not give, the factory's (cached per coin), else the row is left out.
   */
  async boardFromSnapshot(snapshot: Pick<FeastSnapshot, "coins">, now: number): Promise<CoinRow[]> {
    const rows: CoinRow[] = [];
    const quoteBnb = new Map<string, Promise<bigint | null>>();
    const valueOf = (quote: Address) => {
      const k = quote.toLowerCase();
      if (!quoteBnb.has(k)) quoteBnb.set(k, this.chain.quoteBnbE18(quote).catch(() => null));
      return quoteBnb.get(k)!;
    };
    for (const c of snapshotCoins(snapshot)) {
      const creator = c.creator && c.creator !== "self" ? c.creator : ((await this.chain.coinInfo(c.coin).catch(() => null))?.creator ?? null);
      if (!creator) continue;
      let priceBnb = c.priceBnb;
      if (priceBnb === null && c.priceQuote !== null) {
        const q = await valueOf(c.quote);
        priceBnb = q === null ? null : c.priceQuote * toNumber(q);
      }
      const launchedAt = c.launchedAt ?? 0;
      this.sample(c.coin, c.holders ?? 0, now);
      this.launched(creator, launchedAt, now);
      rows.push({
        coin: c.coin,
        symbol: c.symbol,
        quote: c.quote,
        creator,
        launchedAt,
        ageSeconds: c.launchedAt === null ? 0 : Math.max(0, Math.floor((now - c.launchedAt) / 1_000)),
        holders: c.holders ?? 0,
        volume24hBnb: c.volume24hBnb ?? 0,
        trades24h: c.trades24h ?? 0,
        priceBnb,
        hasMetadata: c.metadataHash === null ? true : c.metadataHash !== ZERO_HASH,
      });
    }
    this.board = { at: now, rows };
    return rows;
  }

  /** One event off the stream: into the windows, and out as what a strategy sees (with any price move it makes). */
  async ingest(event: LeagueEvent, now: number, watched: Set<string>): Promise<StrategyEvent[]> {
    if (event.type === "coin.created") {
      const creator = event.creator.toLowerCase();
      this.launches[creator] = [...(this.launches[creator] ?? []).filter((t) => now - t < 24 * HOUR), event.at];
      return [{ type: "coin.created", coin: event.coin, creator: event.creator, quote: event.quote, hasMetadata: event.metadataHash !== ZERO_HASH, at: event.at }];
    }
    const info = await this.chain.coinInfo(event.coin).catch(() => null);
    const quoteBnb = info ? await this.chain.quoteBnbE18(info.quote).catch(() => null) : null;
    const bnb = quoteBnb === null ? null : toNumber((event.quoteAmount * quoteBnb) / E18);
    const priceBnb = await this.priceBnb(event.coin, event.sqrtPriceX96After);
    const row: TradeRow = { coin: event.coin, side: event.side, payer: event.payer, bnb, coins: toNumber(event.coinAmount), priceBnb, at: event.at, txHash: event.txHash };
    this.trades = [...this.trades, row].filter((t) => now - t.at < 2 * HOUR).slice(-5_000);
    const out: StrategyEvent[] = [{ type: "trade", coin: row.coin, side: row.side, payer: row.payer, bnb, coins: row.coins, priceBnb, at: row.at }];
    const k = event.coin.toLowerCase();
    if (priceBnb !== null && watched.has(k)) {
      const ref = this.priceRef[k];
      if (ref === undefined) this.priceRef[k] = priceBnb;
      else if (Math.abs((priceBnb - ref) / ref) * 100 >= PRICE_MOVE_PCT) {
        out.push({ type: "price.move", coin: event.coin, fromBnb: ref, toBnb: priceBnb, movePct: ((priceBnb - ref) / ref) * 100, at: event.at });
        this.priceRef[k] = priceBnb;
      }
    }
    return out;
  }

  /** Every position, marked at spot in BNB; null where no price could be read. */
  async marks(book: Book): Promise<Record<string, bigint | null>> {
    const out: Record<string, bigint | null> = {};
    for (const [k, position] of Object.entries(book.positions)) {
      out[k] = await this.chain.markWei(position.coin, position.coins).catch(() => null);
    }
    return out;
  }

  async snapshot(input: {
    now: number;
    balanceWei: bigint;
    limits: Limits;
    book: Book;
    marks: Record<string, bigint | null>;
    warmup: Snapshot["warmup"];
    watch: string[];
    feast: Address;
    needBoard: boolean;
    /** The feed's word on the market data: null when fresh. */
    stale?: Snapshot["stale"];
  }): Promise<Snapshot> {
    const { now, book } = input;
    // The rows the feed last gave (`feed/feed.ts`): nothing is fetched here.
    const coins: CoinRow[] = input.needBoard && this.board ? [...this.board.rows] : [];
    // Watched coins carry a fresh price from the chain, whatever the board says.
    for (const entry of input.watch) {
      const coin = entry.trim().toUpperCase() === "FEAST" ? input.feast : isAddress(entry, { strict: false }) ? getAddress(entry) : null;
      if (!coin) continue;
      const info = await this.chain.coinInfo(coin).catch(() => null);
      if (!info) continue;
      const spot = await this.chain.markWei(coin, E18).catch(() => null);
      const priceBnb = spot === null ? null : toNumber(spot);
      const existing = coins.findIndex((c) => c.coin.toLowerCase() === coin.toLowerCase());
      if (existing >= 0) coins[existing] = { ...coins[existing]!, priceBnb };
      else coins.push({ coin, symbol: info.symbol, quote: info.quote, creator: info.creator, launchedAt: 0, ageSeconds: 0, holders: 0, volume24hBnb: 0, trades24h: 0, priceBnb, hasMetadata: true });
    }
    const positions: PositionRow[] = Object.entries(book.positions).map(([k, p]) => {
      const mark = input.marks[k] ?? null;
      const costBnb = toNumber(p.costWei);
      const markBnb = mark === null ? null : toNumber(mark);
      return {
        coin: p.coin,
        symbol: p.symbol,
        coins: toNumber(p.coins),
        costBnb,
        markBnb,
        pnlPct: markBnb === null || costBnb === 0 ? null : ((markBnb - costBnb) / costBnb) * 100,
        peakBnb: toNumber(p.peakMarkWei),
        openedAt: p.openedAt,
        ageSeconds: Math.max(0, Math.floor((now - p.openedAt) / 1_000)),
        ownLaunch: p.ownLaunch,
        armed: p.armed,
      };
    });
    const reserve = bnbToWei(input.limits.gasReserveBnb);
    return {
      now,
      balanceBnb: input.balanceWei > reserve ? toNumber(input.balanceWei - reserve) : 0,
      limits: input.limits,
      warmup: input.warmup,
      coins,
      positions,
      trades: this.trades.filter((t) => now - t.at < 2 * HOUR),
      holders: this.holders,
      launchesByCreator: this.launches,
      feast: input.feast,
      launched: book.launched ? { coin: book.launched.coin, at: book.launched.at } : null,
      stale: input.stale ?? null,
    };
  }
}
