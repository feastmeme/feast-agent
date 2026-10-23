import { INDEXER_URL, IndexerError, IndexerPoller, type LeagueEvent } from "../events.ts";
import type { Market } from "../market.ts";
import { failureOf, type Failure, type FeedLog } from "./backoff.ts";
import { CURSOR_RE, EventStream } from "./events.ts";
import { plainReason, RECHECK_MS, SnapshotClient, type FeastSnapshot, type Stale } from "./snapshot.ts";

/**
 * The runtime's market reads (task 967; PLAN.md §15): one read per interval serves the events and the board.
 *
 * - **The snapshot** (`snapshot.ts`), the default: its events go through the cursor (`events.ts`), its coins become
 *   the board's rows when a tick needs them, with no fetch in the tick and no chain read per row.
 * - **The legacy reads**, while the route answers 404 or 410 (asked again every 10 minutes) or with `--live`: the
 *   indexer's `/v1/events` poller (its `limit` still cycling) at the same 5–8 s, and its `/v1/board` for a tick, as
 *   before, at most every 15 s.
 *
 * Both live under the one backoff and its pacing: never two asks within 3 s, never two at once. While it backs off,
 * the runtime keeps deciding on the last good read, marked stale; L6, L8, the inbox and the host's own trades never
 * wait on it. `step` and `prepareBoard` never throw.
 */

export type FeedDeps = {
  site: string;
  indexer?: string;
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  pollSeconds?: number;
  /** `--live`: the legacy reads only; the snapshot route is never asked. */
  live?: boolean;
  market: Market;
  log: FeedLog;
  /** Once an outage. */
  onStale?: (failure: Failure) => void;
  cache?: { home: string; wallet: string | null };
  timeoutMs?: number;
};

const failureFrom = (error: unknown, now: number): Failure =>
  error instanceof IndexerError ? (failureOf(error.status, error.retryAfter, now) ?? { status: error.status, reason: `HTTP ${error.status}` }) : { status: null, reason: plainReason(error) };

export class MarketFeed {
  mode: "snapshot" | "legacy";
  private readonly client: SnapshotClient;
  private readonly stream: EventStream;
  private readonly indexer: string;
  private poller: IndexerPoller | null = null;
  private recheckAt = 0;
  private unavailableSaid = false;
  private availableSaid = false;
  private boardFrom: FeastSnapshot | null = null;
  /** A snapshot whose inline tail was cut short of the position: the whole tail is read at the next slot (task 966). */
  private pendingTail: FeastSnapshot | null = null;

  constructor(private readonly d: FeedDeps) {
    this.indexer = (d.indexer ?? INDEXER_URL).replace(/\/+$/, "");
    this.client = new SnapshotClient({ site: d.site, fetch: d.fetch, now: d.now, random: d.random, pollSeconds: d.pollSeconds, timeoutMs: d.timeoutMs, log: d.log, onStale: d.onStale, cache: d.cache });
    this.stream = new EventStream({ now: d.now, log: d.log, fill: (cursor) => this.fill(cursor) });
    this.mode = d.live ? "legacy" : "snapshot";
  }

  get nextAt(): number {
    return this.client.nextAt;
  }

  due(): boolean {
    return this.client.pacer.due();
  }

  stale(): Stale | null {
    return this.client.stale();
  }

  /** Stop listening: the next read starts at the head again. */
  reset(): void {
    this.stream.reset();
    this.poller = null;
    this.pendingTail = null;
  }

  /** One read, if one is due: the events after the position (`events`), and the newest coins for the next tick. */
  async step(o: { events: boolean }): Promise<LeagueEvent[]> {
    if (!this.due()) return [];
    if (this.pendingTail) return this.fromTail(o);
    if (this.mode === "snapshot" || (!this.d.live && this.d.now() >= this.recheckAt)) return this.fromSnapshot(o);
    return o.events ? this.fromLegacy() : [];
  }

  private async fromSnapshot(o: { events: boolean }): Promise<LeagueEvent[]> {
    const wasLegacy = this.mode === "legacy";
    const out = await this.client.read();
    if (out.kind === "unavailable") {
      if (!this.unavailableSaid) {
        this.unavailableSaid = true;
        this.d.log("snapshot.unavailable", { status: out.status, fallback: "the indexer's /v1/events and /v1/board, at the same interval", recheckMinutes: RECHECK_MS / 60_000 });
      }
      if (!wasLegacy) {
        this.mode = "legacy";
        this.poller = null;
      }
      this.recheckAt = this.d.now() + RECHECK_MS;
      return [];
    }
    if (wasLegacy) {
      if (out.kind !== "new" && out.kind !== "same") {
        // Not answering either: the legacy reads go on, and the route is asked again in 10 minutes.
        this.recheckAt = this.d.now() + RECHECK_MS;
        return [];
      }
      this.mode = "snapshot";
      if (!this.availableSaid) {
        this.availableSaid = true;
        this.d.log("snapshot.available", { after: "the legacy reads" });
      }
      // Go on from where the legacy poller was, so nothing is passed twice and nothing between is dropped.
      this.stream.resume(this.poller?.position ?? null);
      this.poller = null;
    }
    if (out.kind !== "new" || !o.events) return [];
    // The inline tail was cut, and does not reach back to the position: the whole tail, at the next slot, from the
    // site's events_url, never the legacy route. Until then nothing of this snapshot is passed, so nothing is out of order.
    if (this.stream.needsTail(out.snapshot)) {
      this.pendingTail = out.snapshot;
      this.d.log("events.tail", { path: out.snapshot.eventsUrl, why: "the snapshot's events were cut short of the position" });
      return [];
    }
    return this.stream.take(out.snapshot, { fill: !(out.snapshot.truncated && out.snapshot.eventsUrl) });
  }

  /** The whole tail a cut snapshot pointed at; if it cannot be read, the cut snapshot's own events, the gap said. */
  private async fromTail(o: { events: boolean }): Promise<LeagueEvent[]> {
    const cut = this.pendingTail!;
    const got = await this.client.readTail(cut.eventsUrl!);
    if (got.kind === "wait") return [];
    this.pendingTail = null;
    if (!o.events) return [];
    if (got.kind === "tail") return this.stream.take(got.tail, { fill: false });
    this.d.log("events.tail.failed", { status: got.failure.status, reason: got.failure.reason });
    return this.stream.take(cut, { fill: false });
  }

  private async fromLegacy(): Promise<LeagueEvent[]> {
    if (!this.client.pacer.begin()) return [];
    try {
      this.poller ??= new IndexerPoller({ base: this.indexer, fetch: this.d.fetch, cursor: this.stream.cursor });
      const events = await this.poller.poll();
      this.client.pacer.end(null);
      // The snapshot's position follows the poller's, for when the route comes back.
      this.stream.resume(this.poller.position);
      return events;
    } catch (error) {
      this.client.pacer.end(failureFrom(error, this.d.now()));
      return [];
    }
  }

  /** A gap's one legacy page, under the same backoff: none while it backs off. */
  private async fill(cursor: string): Promise<Record<string, unknown>[] | null> {
    if (this.client.backoff.failing || !CURSOR_RE.test(cursor)) return null;
    try {
      const response = await this.d.fetch(`${this.indexer}/v1/events?types=launch,trade&cursor=${cursor}&limit=200`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.d.timeoutMs ?? 10_000) });
      if (!response.ok) {
        this.client.pacer.failOutside(failureOf(response.status, response.headers.get("retry-after"), this.d.now()) ?? { status: response.status, reason: `HTTP ${response.status}` });
        return null;
      }
      const body = (await response.json()) as { data?: unknown };
      return Array.isArray(body.data) ? body.data.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null) : null;
    } catch (error) {
      this.client.pacer.failOutside(failureFrom(error, this.d.now()));
      return null;
    }
  }

  /** The board a tick reads: the held snapshot's coins (no fetch), or in the legacy mode the indexer's board, as before. */
  async prepareBoard(now: number): Promise<void> {
    if (this.mode === "snapshot") {
      const held = this.client.held;
      if (held && held !== this.boardFrom) {
        await this.d.market.boardFromSnapshot(held, now).catch((error: unknown) => this.d.log("board.unreadable", { reason: plainReason(error) }));
        this.boardFrom = held;
      }
      return;
    }
    // Never while the backoff says to wait.
    if (this.client.backoff.failing && now < this.client.nextAt) return;
    try {
      await this.d.market.refreshBoard(now);
      if (this.client.backoff.failing) this.client.backoff.ok();
    } catch (error) {
      this.client.pacer.failOutside(failureFrom(error, now));
    }
  }
}
