import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, type Address } from "viem";

import { withHostHeaders } from "../headers.ts";
import { writeFileAtomic } from "../store.ts";
import { Backoff, failureOf, type Failure, type FeedLog } from "./backoff.ts";
import { comparePosition, CURSOR_RE, decodeCursor } from "./events.ts";

/**
 * feast.meme's market snapshot (task 967; PLAN.md §15): `GET <site>/api/v1/snapshot`, one read every
 * `poll × 1000 + U(0, 3000)` ms (5–8 s by default), with `If-None-Match`. A 304 keeps the snapshot held and costs
 * nothing else; a 200 replaces it, unless it is an older copy than the one held. A 404 or 410 says the route is
 * not deployed (tasks 965 and 966); anything else that is not an answer backs off (`backoff.ts`). No two asks are
 * less than 3 s apart, and never two at once.
 *
 * The request carries no wallet header, no token and no cookie (the coordinator's ruling C4): the CDN keeps one
 * copy for everyone. What it does carry, besides `accept` and `If-None-Match`, are the two headers every request to
 * feast.meme carries (task 975, `headers.ts`): `x-feast-host` and `x-feast-runtime`, the same for every player on a
 * host and a release, never a wallet or a token; the site's snapshot route must not `Vary` on them. Everything in the snapshot is data: its events go through `normalizeEvent`, its coins through
 * `snapshotCoins`, and no field of it is put in a URL but a validated cursor.
 *
 * The newest good snapshot's coins and its ETag are kept in `<home>/cache/snapshot.json`, shared by the runtime
 * and `FL data`, with every occurrence of the wallet's own address written as "self" (the home's rule); "self"
 * maps back in memory only. Its events are not kept: no reader needs them.
 */

export const SNAPSHOT_PATH = "/api/v1/snapshot";
export const DEFAULT_POLL_SECONDS = 5;
export const MIN_POLL_SECONDS = 3;
export const POLL_JITTER_MS = 3_000;
/** Never two asks of one instance closer than this, backoff or not. */
export const FLOOR_MS = 3_000;
/** How often the route is asked again while it answers 404. */
export const RECHECK_MS = 10 * 60_000;
/** FL start's spread of the 20:00 start. */
export const START_JITTER_MS = 120_000;
/** FL data asks nothing when the shared cache is fresher than this. */
export const CACHE_FRESH_MS = 5_000;
const MAX_ROWS = 5_000;

export function parsePoll(raw: string | undefined): { ok: true; seconds: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, seconds: DEFAULT_POLL_SECONDS };
  const text = raw.trim();
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(text)) return { ok: false, error: "--poll is a number of seconds, at least 3" };
  const seconds = Number(text);
  return seconds < MIN_POLL_SECONDS ? { ok: false, error: "the poll is at least 3 s" } : { ok: true, seconds };
}

/** FL start's wait before its first read of the site: U(0, 120) s. */
export const drawStartJitter = (random: () => number = Math.random) => Math.floor(random() * START_JITTER_MS);

export type FeastSnapshot = {
  generatedAt: number | null;
  block: number | null;
  /** The position after the snapshot's last event (`toCursor`, else `cursor`); always one that matches CURSOR_RE. */
  cursor: string | null;
  /**
   * The FIRST event the tail includes (the site's contract, task 966; when the tail is empty, the same as
   * `afterCursor`); null when the snapshot does not say.
   */
  fromCursor: string | null;
  /** The exclusive start of `events`: the newest event the tail does NOT include (task 966); null when not given. */
  afterCursor: string | null;
  /** Where the whole tail is, when `events` was cut (`truncated`): a path on the site, checked (`EVENTS_PATH`); else null. */
  eventsUrl: string | null;
  truncated: boolean;
  coins: Record<string, unknown>[];
  events: Record<string, unknown>[];
};

const cursorOf = (v: unknown) => (typeof v === "string" && CURSOR_RE.test(v) ? v : null);
const objects = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r)).slice(0, MAX_ROWS) : null);
const time = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/** `events_url` as the site names it: a path of its own under /api/v1/, never another origin or a query. */
export const EVENTS_PATH = /^\/api\/v1\/[a-z0-9_/-]{1,100}$/;

/** A snapshot, or null for anything that is not one. */
export function parseSnapshot(body: unknown): FeastSnapshot | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const coins = objects(b.coins);
  const events = b.events === undefined ? [] : objects(b.events);
  if (!coins || !events) return null;
  const block = typeof b.block === "number" && Number.isSafeInteger(b.block) && b.block >= 0 ? b.block : null;
  const afterCursor = cursorOf(b.afterCursor);
  // The position after the snapshot: its newest event, else (an empty tail) where the tail begins.
  const cursor = cursorOf(b.toCursor) ?? cursorOf(b.cursor) ?? afterCursor;
  const eventsUrl = typeof b.events_url === "string" && EVENTS_PATH.test(b.events_url) && !b.events_url.includes("..") ? b.events_url : null;
  return { generatedAt: time(b.generatedAt), block, cursor, fromCursor: cursorOf(b.fromCursor), afterCursor, eventsUrl, truncated: b.truncated === true, coins, events };
}

/** The site's events document (`events_url`): the whole tail and its cursors, no coins; null for anything else. */
export function parseTail(body: unknown): FeastSnapshot | null {
  if (typeof body !== "object" || body === null || Array.isArray(body) || !Array.isArray((body as { events?: unknown }).events)) return null;
  const tail = parseSnapshot({ ...(body as Record<string, unknown>), coins: [] });
  return tail ? { ...tail, eventsUrl: null } : null;
}

/** Whether `a` is an older copy than `b`: by the cursor, else the block, else the time it was made. */
export function olderThan(a: FeastSnapshot, b: FeastSnapshot): boolean {
  const [pa, pb] = [decodeCursor(a.cursor), decodeCursor(b.cursor)];
  if (pa && pb) return comparePosition(pa, pb) < 0;
  if (a.block !== null && b.block !== null) return a.block < b.block;
  return a.generatedAt !== null && b.generatedAt !== null && a.generatedAt < b.generatedAt;
}

/** One coin of the snapshot (ruling C2), every field checked; null where the snapshot does not give it (unknown, never zero). */
export type SnapshotCoin = {
  coin: Address;
  name: string | null;
  symbol: string | null;
  quote: Address;
  quoteSymbol: string | null;
  /** The full creator; "self" read back from the home's cache without the wallet; null when not given. */
  creator: Address | "self" | null;
  metadataHash: string | null;
  launchedAt: number | null;
  priceQuote: number | null;
  priceBnb: number | null;
  volume24hBnb: number | null;
  trades24h: number | null;
  lastTradeAt: number | null;
  holders: number | null;
};

const addr = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);
const text = (v: unknown): string | null => (typeof v === "string" ? [...v].slice(0, 120).join("") : null);
const amount = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim()) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const count = (v: unknown): number | null => {
  const n = amount(v);
  return n === null ? null : Math.floor(n);
};

export function snapshotCoins(snapshot: Pick<FeastSnapshot, "coins">): SnapshotCoin[] {
  return snapshot.coins.flatMap((raw): SnapshotCoin[] => {
    const coin = addr(raw.address ?? raw.coin);
    const quote = addr(raw.quote);
    if (!coin || !quote) return [];
    const hash = typeof raw.metadataHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(raw.metadataHash) ? raw.metadataHash.toLowerCase() : null;
    return [
      {
        coin,
        name: text(raw.name),
        symbol: text(raw.symbol),
        quote,
        quoteSymbol: text(raw.quoteSymbol),
        creator: raw.creator === "self" ? "self" : addr(raw.creator),
        metadataHash: hash,
        launchedAt: time(raw.launchedAt),
        priceQuote: amount(raw.priceQuote),
        priceBnb: amount(raw.priceBnb),
        volume24hBnb: amount(raw.volume24hBnb),
        trades24h: count(raw.trades24h),
        lastTradeAt: time(raw.lastTradeAt),
        holders: count(raw.holders),
      },
    ];
  });
}

// --- the home's cache ------------------------------------------------------------------------------------

export type CachedSnapshot = { at: number; etag: string | null; snapshot: FeastSnapshot };

export const snapshotCachePath = (home: string) => join(home, "cache", "snapshot.json");

type CacheFile = { version: 1; at: number | null; etag: string | null; snapshot: FeastSnapshot | null; unavailableAt: number | null };

function readCacheFile(home: string): CacheFile | null {
  const path = snapshotCachePath(home);
  if (!existsSync(path)) return null;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    return file && file.version === 1 ? file : null;
  } catch {
    return null;
  }
}

/** Every occurrence of the wallet's address, any case, with or without 0x, as "self". */
const scrubbed = (json: string, wallet: string) => json.replace(new RegExp(`(0x)?${wallet.toLowerCase().replace(/^0x/, "")}`, "gi"), "self");

function writeCacheFile(home: string, wallet: string, file: CacheFile): void {
  writeFileAtomic(snapshotCachePath(home), `${scrubbed(JSON.stringify(file), wallet)}\n`);
}

/** The newest good snapshot the home holds (coins only), with "self" as the wallet again when it is known. */
export function readSnapshotCache(home: string, wallet: string | null): CachedSnapshot | null {
  const file = readCacheFile(home);
  if (!file?.snapshot || typeof file.at !== "number") return null;
  const snapshot = parseSnapshot(file.snapshot);
  if (!snapshot) return null;
  const self = wallet?.toLowerCase() ?? null;
  const coins = self ? snapshot.coins.map((c) => (c.creator === "self" ? { ...c, creator: self } : c)) : snapshot.coins;
  return { at: file.at, etag: typeof file.etag === "string" ? file.etag : null, snapshot: { ...snapshot, coins } };
}

/** When the route last answered 404 or 410, if it did and has not answered since. */
export function snapshotUnavailableAt(home: string): number | null {
  const at = readCacheFile(home)?.unavailableAt;
  return typeof at === "number" ? at : null;
}

// --- the pacing ---------------------------------------------------------------------------------------------

/** When the next ask may go: the interval after an answer, the backoff after a failure, never under 3 s, one at a time. */
export class Pacer {
  nextAt = 0;
  private inFlight = false;
  private lastAsk = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly o: { now: () => number; random: () => number; pollMs: number },
    readonly backoff: Backoff,
  ) {}

  due(): boolean {
    return !this.inFlight && this.o.now() >= this.nextAt;
  }

  begin(): boolean {
    if (!this.due()) return false;
    this.inFlight = true;
    this.lastAsk = this.o.now();
    return true;
  }

  /** The ask's outcome: an answer (a 404 is one) waits the interval, drawn afresh; a failure, the backoff. */
  end(failure: Failure | null): void {
    this.inFlight = false;
    if (failure === null) {
      this.backoff.ok();
      this.nextAt = this.lastAsk + this.o.pollMs + this.o.random() * POLL_JITTER_MS;
    } else {
      const wait = this.backoff.fail(failure);
      this.nextAt = Math.max(this.lastAsk + FLOOR_MS, this.o.now() + wait);
    }
  }

  /** A failure off the paced asks (the legacy board, a gap's fill): the backoff, and the next ask no sooner than it says. */
  failOutside(failure: Failure): void {
    const wait = this.backoff.fail(failure);
    this.nextAt = Math.max(this.nextAt, this.o.now() + wait, this.lastAsk + FLOOR_MS);
  }
}

// --- the client -------------------------------------------------------------------------------------------------

export type ReadOutcome =
  | { kind: "new"; snapshot: FeastSnapshot }
  | { kind: "same" }
  | { kind: "unavailable"; status: number }
  | { kind: "failed"; failure: Failure }
  | { kind: "wait" };

export type Stale = { sinceMs: number; reason: string };

export type SnapshotOptions = {
  site: string;
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  pollSeconds?: number;
  /** 0: no timeout (the load test, whose fetch answers at once). */
  timeoutMs?: number;
  log?: FeedLog;
  onStale?: (failure: Failure) => void;
  /** The home's shared cache: written only when the wallet's address is known, so it can be scrubbed. */
  cache?: { home: string; wallet: string | null };
  /** What the cache held, to ask with its ETag. */
  seed?: CachedSnapshot | null;
};

/** A reason of ours fit to log: the first line, no URL. */
export const plainReason = (error: unknown) => String((error as Error)?.message ?? error).split("\n")[0]!.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 160);

export class SnapshotClient {
  readonly backoff: Backoff;
  readonly pacer: Pacer;
  private etag: string | null;
  private snapshot: FeastSnapshot | null;
  private goodAt: number | null;
  private readonly startedAt: number;
  private servedStale = false;

  /** The options' fetch, with the host's and the release's headers on feast.meme (task 975). */
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: SnapshotOptions) {
    this.fetchImpl = withHostHeaders(o.fetch, [o.site]);
    this.backoff = new Backoff({ now: o.now, random: o.random, log: o.log, onStale: o.onStale });
    this.pacer = new Pacer({ now: o.now, random: o.random, pollMs: (o.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1_000 }, this.backoff);
    this.etag = o.seed?.etag ?? null;
    this.snapshot = o.seed?.snapshot ?? null;
    this.goodAt = o.seed?.at ?? null;
    this.startedAt = o.now();
  }

  get held(): FeastSnapshot | null {
    return this.snapshot;
  }

  get nextAt(): number {
    return this.pacer.nextAt;
  }

  /** When the market data last came fresh: the last 200 or 304. */
  get lastGoodAt(): number | null {
    return this.goodAt;
  }

  /** What a strategy sees while the held snapshot is not fresh: since when, and why; null when it is. */
  stale(): Stale | null {
    const failure = this.backoff.failure;
    if (failure) return { sinceMs: this.goodAt ?? this.startedAt, reason: failure.reason };
    if (this.servedStale && this.snapshot) return { sinceMs: this.snapshot.generatedAt ?? this.goodAt ?? this.startedAt, reason: "feast.meme served an older copy" };
    return null;
  }

  async read(): Promise<ReadOutcome> {
    if (!this.pacer.begin()) return { kind: "wait" };
    let outcome: ReadOutcome = { kind: "same" };
    let failure: Failure | null = null;
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.etag && this.snapshot) headers["if-none-match"] = this.etag;
      const timeout = this.o.timeoutMs ?? 10_000;
      const response = await this.fetchImpl(`${this.o.site.replace(/\/+$/, "")}${SNAPSHOT_PATH}`, { headers, ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}) });
      const now = this.o.now();
      const flagged = (response.headers.get("x-snapshot-stale") ?? "").trim();
      if (response.status === 304 && this.snapshot) {
        this.goodAt = now;
        this.servedStale = flagged !== "" && flagged !== "0" && flagged.toLowerCase() !== "false";
        this.keep(now);
      } else if (response.status === 404 || response.status === 410) {
        outcome = { kind: "unavailable", status: response.status };
        this.markUnavailable(now);
      } else if (response.status === 200) {
        let parsed: FeastSnapshot | null = null;
        try {
          parsed = parseSnapshot(JSON.parse(await response.text()));
        } catch {
          parsed = null;
        }
        if (!parsed) failure = { status: 200, reason: "HTTP 200, not a snapshot" };
        else {
          this.goodAt = now;
          this.servedStale = flagged !== "" && flagged !== "0" && flagged.toLowerCase() !== "false";
          // An older copy (a CDN's, after a newer one) never replaces what is held.
          if (!this.snapshot || !olderThan(parsed, this.snapshot)) {
            this.snapshot = parsed;
            this.etag = response.headers.get("etag");
            outcome = { kind: "new", snapshot: parsed };
          }
          this.keep(now);
        }
      } else failure = failureOf(response.status, response.headers.get("retry-after"), now) ?? { status: response.status, reason: `HTTP ${response.status}` };
    } catch (error) {
      failure = { status: null, reason: plainReason(error) };
    }
    this.pacer.end(failure);
    return failure ? { kind: "failed", failure } : outcome;
  }

  private tailEtag: string | null = null;
  private tail: FeastSnapshot | null = null;

  /**
   * The whole tail from `events_url` (task 966), when the snapshot's inline `events` were cut: one ask under the same
   * pacing and backoff as the snapshot (never within 3 s of another, never two at once), with its own ETag; a 304
   * answers the tail held. Its events are never written to the home: the cache keeps coins only.
   */
  async readTail(path: string): Promise<{ kind: "tail"; tail: FeastSnapshot } | { kind: "failed"; failure: Failure } | { kind: "wait" }> {
    if (!EVENTS_PATH.test(path) || !this.pacer.begin()) return { kind: "wait" };
    let failure: Failure | null = null;
    let tail: FeastSnapshot | null = null;
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.tailEtag && this.tail) headers["if-none-match"] = this.tailEtag;
      const timeout = this.o.timeoutMs ?? 10_000;
      const response = await this.fetchImpl(`${this.o.site.replace(/\/+$/, "")}${path}`, { headers, ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}) });
      const now = this.o.now();
      if (response.status === 304 && this.tail) tail = this.tail;
      else if (response.status === 200) {
        try {
          tail = parseTail(JSON.parse(await response.text()));
        } catch {
          tail = null;
        }
        if (!tail) failure = { status: 200, reason: "HTTP 200, not the events tail" };
        else {
          this.tail = tail;
          this.tailEtag = response.headers.get("etag");
        }
      } else failure = failureOf(response.status, response.headers.get("retry-after"), now) ?? { status: response.status, reason: `HTTP ${response.status}` };
    } catch (error) {
      failure = { status: null, reason: plainReason(error) };
    }
    this.pacer.end(failure);
    return failure || !tail ? { kind: "failed", failure: failure ?? { status: null, reason: "no tail" } } : { kind: "tail", tail };
  }

  private keep(now: number): void {
    const cache = this.o.cache;
    if (!cache?.wallet || !this.snapshot) return;
    try {
      writeCacheFile(cache.home, cache.wallet, { version: 1, at: now, etag: this.etag, snapshot: { ...this.snapshot, events: [] }, unavailableAt: null });
    } catch {
      // A cache that cannot be written never stops a read.
    }
  }

  private markUnavailable(now: number): void {
    const cache = this.o.cache;
    if (!cache) return;
    try {
      const file = readCacheFile(cache.home);
      // Nothing of the wallet's goes in: an earlier file was scrubbed when it was written, and this is a time.
      writeFileAtomic(snapshotCachePath(cache.home), `${JSON.stringify({ version: 1, at: file?.at ?? null, etag: file?.etag ?? null, snapshot: file?.snapshot ?? null, unavailableAt: now } satisfies CacheFile)}\n`);
    } catch {
      // As above.
    }
  }
}
