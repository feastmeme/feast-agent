/**
 * The trades of the last 15 minutes (task 975, run 24), gathered from every snapshot the runtime holds: each
 * snapshot's tail covers 120 seconds, so the pack's 15-minute counts (the pit's league trades) need the tails kept
 * as they come. In memory only, never written to the home; a trade is kept once, by its transaction and log index.
 * A process that reads one snapshot (`FL data` with no loop) holds that one tail, nothing more.
 */

export const RECENT_WINDOW_MS = 15 * 60_000;
/** A busy quarter hour is cut here: the oldest go first. */
export const RECENT_MAX = 5_000;

export class RecentTrades {
  private readonly rows = new Map<string, { at: number; raw: Record<string, unknown> }>();

  constructor(private readonly windowMs = RECENT_WINDOW_MS) {}

  /** A snapshot's events: its trades kept, anything older than the window let go. */
  absorb(events: readonly Record<string, unknown>[], now: number): void {
    for (const e of events) {
      if (e.type !== "trade") continue;
      const at = Date.parse(String(e.at));
      if (!Number.isFinite(at)) continue;
      const key = `${String(e.txHash ?? "")}:${String(e.logIndex ?? "")}:${String(e.blockNumber ?? "")}:${String(e.coin ?? "").toLowerCase()}:${String(e.payer ?? "").toLowerCase()}:${String(e.quoteAmount ?? "")}`;
      if (!this.rows.has(key)) this.rows.set(key, { at, raw: e });
    }
    this.prune(now);
  }

  /** The trades held within the window of `now`, oldest first. */
  list(now: number): Record<string, unknown>[] {
    this.prune(now);
    return [...this.rows.values()].filter((r) => r.at <= now).sort((a, b) => a.at - b.at).map((r) => r.raw);
  }

  private prune(now: number): void {
    for (const [k, r] of this.rows) if (now - r.at > this.windowMs) this.rows.delete(k);
    if (this.rows.size > RECENT_MAX) [...this.rows.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.rows.size - RECENT_MAX).forEach(([k]) => this.rows.delete(k));
  }
}
