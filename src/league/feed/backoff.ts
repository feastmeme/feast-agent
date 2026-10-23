/**
 * The backoff every market read lives under (task 967; PLAN.md §15.3). On a 429, a 5xx, any other refusal, a
 * network error or a timeout, attempt k (from 0) waits min(60 s, 2 s × 2^k) × U(0.75, 1.25), clamped to
 * [2 s, 60 s]; a Retry-After raises the wait to at least its value, still capped at 60 s. A good read (a 200 or
 * a 304) starts again at k = 0. It logs once per change of state, never once per failed read, and gives one
 * notice an outage.
 */

export const BACKOFF_FLOOR_MS = 2_000;
export const BACKOFF_CAP_MS = 60_000;
/** The failed reads after which the held market data is called stale, and the user is told once. */
export const STALE_AFTER = 3;

export type Failure = { status: number | null; reason: string; retryAfterMs?: number | null };

export type FeedLog = (event: string, fields: Record<string, unknown>) => void;

/** Attempt k's wait, before any Retry-After. */
export function backoffWait(k: number, random: () => number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_FLOOR_MS * 2 ** Math.max(0, k));
  return Math.min(BACKOFF_CAP_MS, Math.max(BACKOFF_FLOOR_MS, base * (0.75 + 0.5 * random())));
}

/** A Retry-After header in ms: whole seconds, or an HTTP date (0 when it is past); null when there is none or it is neither. */
export function retryAfterMs(value: string | null | undefined, now: number): number | null {
  const text = value?.trim() ?? "";
  if (/^\d{1,6}$/.test(text)) return Number(text) * 1_000;
  // An HTTP date ("Mon, 26 Oct 2026 12:00:30 GMT"), not any string Date.parse would take.
  if (text.length < 10 || !/[a-z]/i.test(text) || !/\d/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * A 429 or a 5xx as a failure to back off from and ask again after; null for any other answer. The snapshot client
 * backs off on any other refusal too (a 403 from a firewall, say), but a GET of FL enter's is not asked again for one.
 */
export function failureOf(status: number, retryAfter: string | null, now: number): Failure | null {
  if (status !== 429 && status < 500) return null;
  return { status, reason: `HTTP ${status}`, retryAfterMs: retryAfterMs(retryAfter, now) };
}

export class Backoff {
  private k = 0;
  private failures = 0;
  private since: number | null = null;
  private last: Failure | null = null;

  constructor(
    private readonly o: {
      now: () => number;
      random: () => number;
      log?: FeedLog;
      /** Once an outage, after its third failed read. */
      onStale?: (failure: Failure) => void;
    },
  ) {}

  get failing(): boolean {
    return this.failures > 0;
  }

  get attempt(): number {
    return this.k;
  }

  /** The last failure of the outage under way; null when none is. */
  get failure(): Failure | null {
    return this.failing ? this.last : null;
  }

  /** A failed read: the wait before the next attempt. */
  fail(failure: Failure): number {
    if (this.failures === 0) {
      this.since = this.o.now();
      this.o.log?.("feed.backoff", { status: failure.status, reason: failure.reason });
    }
    this.failures += 1;
    this.last = failure;
    if (this.failures === STALE_AFTER) {
      this.o.log?.("feed.stale", { failures: this.failures, status: failure.status, reason: failure.reason });
      this.o.onStale?.(failure);
    }
    const wait = Math.min(BACKOFF_CAP_MS, Math.max(backoffWait(this.k, this.o.random), failure.retryAfterMs ?? 0));
    this.k += 1;
    return wait;
  }

  /** A good read: the outage, if there was one, is over. */
  ok(): void {
    if (this.failures > 0) this.o.log?.("feed.ok", { afterMs: this.o.now() - (this.since ?? this.o.now()), failures: this.failures });
    this.k = 0;
    this.failures = 0;
    this.since = null;
    this.last = null;
  }
}

export type Retry = { now: () => number; sleep: (ms: number) => Promise<void>; random: () => number; attempts?: number; budgetMs?: number };

/** FL enter's bound: at most 3 attempts, and 2 minutes in all. */
export const RETRY_ATTEMPTS = 3;
export const RETRY_BUDGET_MS = 120_000;

/** Real time, for the CLI. */
export const realRetry = (): Retry => ({ now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random });

/**
 * A GET asked again under the backoff while `classify` calls its outcome a failure: at most `attempts` asks, with no
 * wait that would end past `budgetMs` from the first. The last outcome is the answer (a thrown error is thrown again).
 * No policy: one ask, as before. Only for GETs: a POST is never asked twice.
 */
export async function retrying<T>(retry: Retry | undefined, ask: () => Promise<T>, classify: (outcome: { value: T } | { error: unknown }) => Failure | null): Promise<T> {
  if (!retry) return ask();
  const attempts = retry.attempts ?? RETRY_ATTEMPTS;
  const budget = retry.budgetMs ?? RETRY_BUDGET_MS;
  const started = retry.now();
  const backoff = new Backoff({ now: retry.now, random: retry.random });
  for (let attempt = 1; ; attempt += 1) {
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await ask() };
    } catch (error) {
      outcome = { error };
    }
    const failure = classify(outcome);
    const wait = failure ? backoff.fail(failure) : 0;
    if (!failure || attempt >= attempts || retry.now() + wait - started > budget) {
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    }
    await retry.sleep(wait);
  }
}
