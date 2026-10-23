import { cursorAt, normalizeEvent, type LeagueEvent } from "../events.ts";
import type { FeedLog } from "./backoff.ts";
import type { FeastSnapshot } from "./snapshot.ts";

/**
 * The events of each snapshot, and the runtime's position in them (task 967; PLAN.md §15.2). Every event carries
 * the indexer's `cursor`, `blockNumber` and `logIndex`; the position is a `(block, logIndex)`, read from those two
 * fields or decoded from the cursor (the inverse of `cursorAt`), and it is exclusive, as the indexer's cursor is.
 *
 * The first snapshot only sets the position, as the head read did: a restart begins at the head. Each later one
 * passes on the events strictly after it, in `(block, logIndex)` order, and the position moves to the snapshot's
 * end; it never moves back, so a snapshot served twice, or an older copy after a newer one, passes nothing twice.
 *
 * A gap is any span between the position and the start of the snapshot's tail. The site (task 966) gives that
 * start exactly as `afterCursor`, exclusive: there is a gap only when the position is before it. A snapshot with
 * only `fromCursor` (the FIRST event the tail includes) may have a gap when the position is before that event. One
 * under 120 s is filled with one legacy page, at most every 30 s; one that starts further back is not, since the
 * runtime's freshness filter would drop those events anyway. A snapshot whose inline tail was cut (`truncated`,
 * with `events_url`) is not filled from the legacy route: the feed reads the whole tail there instead (`feed.ts`).
 * With neither cursor a gap cannot be told from a quiet spell: it is never filled, and said once a run.
 */

export type Position = { b: number; i: number };
type Raw = Record<string, unknown>;

/** A cursor fit to put in a URL. */
export const CURSOR_RE = /^[A-Za-z0-9_-]{1,256}$/;
/** runtime.ts's freshness filter: an older event never reaches a strategy. */
export const FRESH_MS = 120_000;
export const FILL_EVERY_MS = 30_000;

export function decodeCursor(cursor: unknown): Position | null {
  if (typeof cursor !== "string" || !CURSOR_RE.test(cursor)) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { b?: unknown; i?: unknown } | null;
    const { b, i } = value ?? {};
    if (typeof b === "number" && typeof i === "number" && Number.isSafeInteger(b) && Number.isSafeInteger(i) && b >= 0 && i >= 0) return { b, i };
  } catch {
    // Not one of the indexer's cursors.
  }
  return null;
}

export const comparePosition = (a: Position, b: Position) => a.b - b.b || a.i - b.i;

const whole = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** An event's place: its block and log index, else its cursor; null when it has neither. */
export function positionOf(raw: Raw): Position | null {
  const b = whole(raw.blockNumber);
  const i = whole(raw.logIndex);
  return b !== null && i !== null ? { b, i } : decodeCursor(raw.cursor);
}

const cursorFor = (raw: Raw, at: Position) => (typeof raw.cursor === "string" && CURSOR_RE.test(raw.cursor) && decodeCursor(raw.cursor) !== null ? raw.cursor : cursorAt(at.b, at.i));

export class EventStream {
  private pos: Position | null = null;
  private posCursor: string | null = null;
  private posAt = 0;
  private lastFill = Number.NEGATIVE_INFINITY;
  private unknownSaid = false;

  constructor(
    private readonly o: {
      now: () => number;
      log: FeedLog;
      /** One legacy `/v1/events?cursor=` page after the cursor; null when it could not be read. */
      fill?: (cursor: string) => Promise<Raw[] | null>;
    },
  ) {}

  get position(): Position | null {
    return this.pos;
  }

  /** The position as a cursor, for the legacy poller or a fill: always one that matches CURSOR_RE. */
  get cursor(): string | null {
    return this.posCursor;
  }

  /** Go on from the legacy poller's cursor (the snapshot route came back). */
  resume(cursor: string | null): void {
    const at = decodeCursor(cursor);
    if (!at) return;
    this.pos = at;
    this.posCursor = cursor;
    this.posAt = this.o.now();
  }

  /** Forget the position: the next snapshot starts at the head again (an autopilot that steps back stops listening). */
  reset(): void {
    this.pos = null;
    this.posCursor = null;
  }

  /** Where a snapshot's tail starts: `afterCursor` exclusive, else `fromCursor` inclusive; null when it says neither. */
  private startOf(snapshot: FeastSnapshot): { at: Position; inclusive: boolean } | null {
    const after = decodeCursor(snapshot.afterCursor);
    if (after) return { at: after, inclusive: false };
    const from = decodeCursor(snapshot.fromCursor);
    return from ? { at: from, inclusive: true } : null;
  }

  /** Whether events between the position and this snapshot's tail may be missing. */
  private gapBefore(snapshot: FeastSnapshot): boolean {
    const start = this.startOf(snapshot);
    return this.pos !== null && start !== null && comparePosition(this.pos, start.at) < 0;
  }

  /** A cut tail (`truncated`, `events_url`) that does not reach back to the position: the whole tail is wanted. */
  needsTail(snapshot: FeastSnapshot): boolean {
    return snapshot.truncated && snapshot.eventsUrl !== null && this.gapBefore(snapshot);
  }

  /** `fill: false`: a gap is said, never filled from the legacy route (a cut tail, or the whole tail already read). */
  async take(snapshot: FeastSnapshot, options: { fill?: boolean } = {}): Promise<LeagueEvent[]> {
    const now = this.o.now();
    const rows = snapshot.events.flatMap((raw) => {
      const at = positionOf(raw);
      return at ? [{ raw, at }] : [];
    });
    const end = decodeCursor(snapshot.cursor);
    const newest = rows.reduce<{ raw: Raw; at: Position } | null>((best, r) => (best === null || comparePosition(r.at, best.at) > 0 ? r : best), null);
    if (this.pos === null) {
      // The first snapshot sets the position, as the head read did: its tail is history, not a signal.
      if (end) this.move(end, snapshot.cursor!, now);
      else if (newest) this.move(newest.at, cursorFor(newest.raw, newest.at), now);
      else if (snapshot.block !== null) this.move({ b: snapshot.block, i: 0 }, cursorAt(snapshot.block, 0), now);
      return [];
    }
    const pos = this.pos;
    // An older copy than the one the position came from: nothing in it is new, and the position stays.
    if (end && comparePosition(end, pos) < 0) return [];

    let filled: { raw: Raw; at: Position }[] = [];
    const start = this.startOf(snapshot);
    if (start === null) {
      if (!this.unknownSaid) {
        this.unknownSaid = true;
        this.o.log("events.gap.unknown", { why: "the snapshot carries neither afterCursor nor fromCursor: a gap cannot be told from a quiet spell, and events between two snapshots may be missed" });
      }
    } else if (comparePosition(pos, start.at) < 0) {
      const ageMs = now - this.posAt;
      // Inside the gap: after the position, and up to the tail's start (itself, when it is the exclusive afterCursor).
      const inGap = (at: Position) => comparePosition(at, pos) > 0 && (start.inclusive ? comparePosition(at, start.at) < 0 : comparePosition(at, start.at) <= 0);
      if (options.fill === false) this.o.log("events.gap", { filled: 0, ageMs, why: snapshot.eventsUrl !== null ? "the whole tail could not be read" : "older than the whole tail" });
      else if (ageMs > FRESH_MS) this.o.log("events.gap", { filled: 0, ageMs, why: "the gap starts more than 120 s back" });
      else if (!this.o.fill || now - this.lastFill < FILL_EVERY_MS || this.posCursor === null) this.o.log("events.gap", { filled: 0, ageMs, why: "at most one fill every 30 s" });
      else {
        this.lastFill = now;
        const page = await this.o.fill(this.posCursor).catch(() => null);
        if (page === null) this.o.log("events.gap", { filled: 0, ageMs, why: "the fill could not be read" });
        else {
          filled = page.flatMap((raw) => {
            const at = positionOf(raw);
            return at && inGap(at) ? [{ raw, at }] : [];
          });
          this.o.log("events.gap", { filled: filled.length, ageMs });
        }
      }
    }

    const seen = new Set<string>();
    const fresh = [...filled, ...rows]
      .filter((r) => comparePosition(r.at, pos) > 0)
      .sort((a, b) => comparePosition(a.at, b.at))
      .filter((r) => {
        const key = `${r.at.b}:${r.at.i}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const last = fresh.at(-1);
    if (end && (!last || comparePosition(end, last.at) >= 0)) this.move(end, snapshot.cursor!, now);
    else if (last) this.move(last.at, cursorFor(last.raw, last.at), now);
    else this.posAt = now;
    return fresh.map((r) => normalizeEvent(r.raw)).filter((e): e is LeagueEvent => e !== null);
  }

  private move(at: Position, cursor: string, now: number): void {
    if (this.pos && comparePosition(at, this.pos) < 0) return;
    this.pos = at;
    this.posCursor = CURSOR_RE.test(cursor) ? cursor : cursorAt(at.b, at.i);
    this.posAt = now;
  }
}
