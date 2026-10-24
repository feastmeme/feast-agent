import { isAbsolute } from "node:path";
import { getAddress, isAddress, type Address } from "viem";

import type { Intent } from "./guard.ts";
import type { Limits } from "./limits.ts";
import type { DayCount } from "./prompt/floor.ts";

/**
 * The one interface every strategy has — the six presets and any user script
 * (PLAN.md §2.4). A strategy reads a snapshot the runtime prepared and enqueues
 * intents; nothing is ever sent from inside it, and every intent goes through
 * the same guard and executor.
 */

export type CoinRow = {
  coin: Address;
  symbol: string | null;
  quote: Address;
  creator: Address;
  launchedAt: number;
  ageSeconds: number;
  holders: number;
  volume24hBnb: number;
  trades24h: number;
  /** BNB per whole coin, at the last price the indexer or the chain gave; null when unknown. */
  priceBnb: number | null;
  hasMetadata: boolean;
};

export type PositionRow = {
  coin: Address;
  symbol: string;
  /** Whole coins held. */
  coins: number;
  costBnb: number;
  markBnb: number | null;
  pnlPct: number | null;
  peakBnb: number;
  openedAt: number;
  ageSeconds: number;
  ownLaunch: boolean;
  armed: boolean;
};

export type TradeRow = { coin: Address; side: "buy" | "sell"; payer: Address; bnb: number | null; coins: number; priceBnb: number | null; at: number; txHash: string };

export type Snapshot = {
  now: number;
  /** BNB the wallet can spend, above the gas reserve. */
  balanceBnb: number;
  limits: Limits;
  warmup: { active: boolean; remaining: number; sizeBnb: number } | null;
  coins: CoinRow[];
  positions: PositionRow[];
  /** Trades seen on the event stream, newest last, the last two hours. */
  trades: TradeRow[];
  /** Holder-count samples per coin (lowercase address), oldest first. */
  holders: Record<string, { at: number; holders: number }[]>;
  /** Launches seen per creator (lowercase), epoch ms. */
  launchesByCreator: Record<string, number[]>;
  feast: Address;
  launched: { coin: Address; at: number } | null;
  /**
   * Set while the market feed backs off (task 967): the coins, holders and trades above are the last good read's,
   * not refreshed since `sinceMs` (epoch ms), for `reason`. Null or absent: fresh. Positions and balance are the chain's.
   */
  stale?: { sinceMs: number; reason: string } | null;
};

export type StrategyEvent =
  | { type: "coin.created"; coin: Address; creator: Address; quote: Address; hasMetadata: boolean; at: number }
  | { type: "trade"; coin: Address; side: "buy" | "sell"; payer: Address; bnb: number | null; coins: number; priceBnb: number | null; at: number }
  | { type: "price.move"; coin: Address; fromBnb: number; toBnb: number; movePct: number; at: number };

/** What a strategy may ask for. Anything else on the request is ignored. */
export type IntentRequest =
  | { kind: "buy"; coin: unknown; bnb: unknown; reason?: unknown }
  | { kind: "sell"; coin: unknown; fraction?: unknown; reason?: unknown }
  | { kind: "launch"; name: unknown; symbol: unknown; quote?: unknown; description?: unknown; burn?: unknown; referrer?: unknown; reason?: unknown; image?: unknown };

export type Meta = { name: string; tickSeconds: number; events: ("coin.created" | "trade" | "price.move")[]; watch: string[] };

export type StrategyApi = {
  read: {
    now(): number;
    balance(): number;
    limits(): Limits;
    warmup(): Snapshot["warmup"];
    coins(options?: { sort?: "new" | "holders" | "volume"; limit?: number }): CoinRow[];
    coin(coinOrSymbol: string): CoinRow | null;
    trades(coin?: string, options?: { limit?: number; sinceMs?: number }): TradeRow[];
    positions(): PositionRow[];
    position(coin: string): PositionRow | null;
    holders(coin: string, sinceMs?: number): { at: number; holders: number }[];
    launchesBy(creator: string, sinceMs?: number): number;
    launched(): { coin: Address; at: number } | null;
    /** Null when the market data is fresh; while the feed backs off, since when it is not, and why. */
    stale(): { sinceMs: number; reason: string } | null;
  };
  buy(request: { coin: string; bnb: number; reason?: string }): string | null;
  sell(request: { coin: string; fraction?: number; reason?: string }): string | null;
  launch(request: { name: string; symbol: string; quote?: string; description?: string; burn?: number; referrer?: number; reason?: string }): string | null;
  state: Record<string, unknown>;
  params: Record<string, unknown>;
  log(text: string): void;
};

/**
 * What only a trusted preset may ask of the runtime, never a script: a creator claim spent on a buyback; the day's
 * count (task 975: this agent's trades and volume since the last dinner, own coin left out; null when it cannot be
 * read); and whether it stands by as an autopilot whose host has just traded (its own exits only).
 */
export type PresetExtras = {
  claimAndBuyBack(coin: Address, options: { buybackPct: number; minClaimBnb: number; reason: string }): string | null;
  day?(): DayCount | null;
  standingBy?(): boolean;
};

export type Strategy = {
  meta: Meta;
  onTick(api: StrategyApi, extras?: PresetExtras): void;
  onEvent?(api: StrategyApi, event: StrategyEvent, extras?: PresetExtras): void;
  /** Coins the strategy needs a fresh chain price for in its next snapshot, besides meta.watch (presets only). */
  wants?(state: Record<string, unknown>): string[];
};

let counter = 0;
const nextId = (kind: string, now: number) => `${kind}-${now}-${(counter += 1)}`;

export function resolveCoin(snapshot: Pick<Snapshot, "feast">, coin: unknown): Address | null {
  if (typeof coin !== "string") return null;
  if (coin.trim().toUpperCase() === "FEAST") return snapshot.feast;
  return isAddress(coin, { strict: false }) ? getAddress(coin) : null;
}

/** A launch's picture on a request: a file on this machine and the sha256 of its bytes as the user's card showed them. */
function launchImage(raw: unknown): { path: string; sha256: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { path, sha256 } = raw as { path?: unknown; sha256?: unknown };
  return typeof path === "string" && isAbsolute(path) && typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256) ? { path, sha256 } : undefined;
}

/**
 * A strategy's request as an intent, or the reason it is not one. Shared by
 * presets and the script sandbox, so a script can set nothing a preset cannot:
 * no `fundedBy`, no source, no expiry of its own, and no file: a launch's
 * picture is kept only on a manual request (`FL enter`'s), never a strategy's.
 */
export function normalizeIntent(
  request: IntentRequest,
  ctx: { snapshot: Pick<Snapshot, "feast" | "now" | "limits">; source: Intent["source"]; slippagePct: number; ttlMs: number },
): { intent: Intent } | { error: string } {
  const now = ctx.snapshot.now;
  const reason = typeof request.reason === "string" && request.reason.trim() ? request.reason.trim().slice(0, 200) : request.kind;
  const base = { reason, source: ctx.source, createdAt: now, slippagePct: ctx.slippagePct };
  if (request.kind === "buy") {
    const coin = resolveCoin(ctx.snapshot, request.coin);
    if (!coin) return { error: "buy: coin must be an address or FEAST" };
    if (typeof request.bnb !== "number" || !Number.isFinite(request.bnb)) return { error: "buy: bnb must be a number" };
    return { intent: { id: nextId("buy", now), kind: "buy", coin, bnb: request.bnb, expiresAt: now + ctx.ttlMs, ...base } };
  }
  if (request.kind === "sell") {
    const coin = resolveCoin(ctx.snapshot, request.coin);
    if (!coin) return { error: "sell: coin must be an address or FEAST" };
    const fraction = request.fraction === undefined ? 1 : request.fraction;
    if (typeof fraction !== "number" || !Number.isFinite(fraction)) return { error: "sell: fraction must be a number" };
    return { intent: { id: nextId("sell", now), kind: "sell", coin, fraction, ...base } };
  }
  if (request.kind === "launch") {
    if (typeof request.name !== "string" || typeof request.symbol !== "string") return { error: "launch: name and symbol are text" };
    const quote = typeof request.quote === "string" ? request.quote : "WBNB";
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const image = ctx.source === "manual" ? launchImage(request.image) : undefined;
    return {
      intent: {
        id: nextId("launch", now),
        kind: "launch",
        launch: {
          name: request.name.slice(0, 32),
          symbol: request.symbol.slice(0, 10),
          quote,
          description: typeof request.description === "string" ? request.description.slice(0, 280) : undefined,
          burn: num(request.burn),
          referrer: num(request.referrer),
          ...(image ? { image } : {}),
        },
        ...base,
      },
    };
  }
  return { error: "unknown request" };
}

/** An `api` over a snapshot. Intents collect in `intents`; problems in `problems`. */
export function makeApi(
  snapshot: Snapshot,
  options: { params: Record<string, unknown>; state: Record<string, unknown>; source: Intent["source"]; ttlMs: number; log: (text: string) => void },
): { api: StrategyApi; intents: Intent[]; problems: string[] } {
  const intents: Intent[] = [];
  const problems: string[] = [];
  const slippagePct = typeof options.params.slippagePct === "number" ? options.params.slippagePct : snapshot.limits.maxSlippagePct;
  const enqueue = (request: IntentRequest): string | null => {
    const out = normalizeIntent(request, { snapshot, source: options.source, slippagePct, ttlMs: options.ttlMs });
    if ("error" in out) {
      problems.push(out.error);
      return null;
    }
    intents.push(out.intent);
    return out.intent.id;
  };
  const lower = (coin: string) => resolveCoin(snapshot, coin)?.toLowerCase() ?? null;
  const api: StrategyApi = {
    read: {
      now: () => snapshot.now,
      balance: () => snapshot.balanceBnb,
      limits: () => ({ ...snapshot.limits }),
      warmup: () => (snapshot.warmup ? { ...snapshot.warmup } : null),
      coins: ({ sort = "volume", limit = 50 } = {}) => {
        const rows = [...snapshot.coins];
        if (sort === "new") rows.sort((a, b) => b.launchedAt - a.launchedAt);
        else if (sort === "holders") rows.sort((a, b) => b.holders - a.holders);
        else rows.sort((a, b) => b.volume24hBnb - a.volume24hBnb);
        return rows.slice(0, Math.max(0, Math.min(200, Math.floor(limit))));
      },
      coin: (coinOrSymbol) => {
        const k = lower(coinOrSymbol);
        if (k) return snapshot.coins.find((c) => c.coin.toLowerCase() === k) ?? null;
        const symbol = coinOrSymbol.trim().toUpperCase();
        return snapshot.coins.find((c) => c.symbol?.toUpperCase() === symbol) ?? null;
      },
      trades: (coin, { limit = 200, sinceMs } = {}) => {
        const k = coin ? lower(coin) : null;
        const rows = snapshot.trades.filter((t) => (k ? t.coin.toLowerCase() === k : true) && (sinceMs === undefined || t.at >= sinceMs));
        return rows.slice(-Math.max(0, Math.min(1_000, Math.floor(limit))));
      },
      positions: () => snapshot.positions.map((p) => ({ ...p })),
      position: (coin) => {
        const k = lower(coin);
        const found = snapshot.positions.find((p) => p.coin.toLowerCase() === k);
        return found ? { ...found } : null;
      },
      holders: (coin, sinceMs) => {
        const k = lower(coin);
        const rows = k ? snapshot.holders[k] ?? [] : [];
        return rows.filter((r) => sinceMs === undefined || r.at >= sinceMs);
      },
      launchesBy: (creator, sinceMs) => {
        const rows = snapshot.launchesByCreator[creator.toLowerCase()] ?? [];
        return rows.filter((t) => sinceMs === undefined || t >= sinceMs).length;
      },
      launched: () => (snapshot.launched ? { ...snapshot.launched } : null),
      stale: () => (snapshot.stale ? { ...snapshot.stale } : null),
    },
    buy: (request) => enqueue({ kind: "buy", coin: request?.coin, bnb: request?.bnb, reason: request?.reason }),
    sell: (request) => enqueue({ kind: "sell", coin: request?.coin, fraction: request?.fraction, reason: request?.reason }),
    launch: (request) =>
      enqueue({ kind: "launch", name: request?.name, symbol: request?.symbol, quote: request?.quote, description: request?.description, burn: request?.burn, referrer: request?.referrer, reason: request?.reason }),
    state: options.state,
    params: options.params,
    log: (text) => options.log(String(text).slice(0, 500)),
  };
  return { api, intents, problems };
}
