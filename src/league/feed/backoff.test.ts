import { describe, expect, it } from "vitest";

import { Backoff, backoffWait, retryAfterMs, retrying } from "./backoff.ts";
import { seeded } from "./fakes.ts";

describe("the backoff's waits", () => {
  it("attempt k waits min(60 s, 2 s × 2^k) × U(0.75, 1.25), clamped to [2 s, 60 s]", () => {
    const bounds = [
      [2_000, 2_500],
      [3_000, 5_000],
      [6_000, 10_000],
      [12_000, 20_000],
      [24_000, 40_000],
      [45_000, 60_000],
      [45_000, 60_000],
    ];
    const random = seeded(7);
    for (let run = 0; run < 2_000; run += 1) {
      for (const [k, [low, high]] of bounds.entries()) {
        const wait = backoffWait(k, random);
        expect(wait, `k=${k}`).toBeGreaterThanOrEqual(low!);
        expect(wait, `k=${k}`).toBeLessThanOrEqual(high!);
      }
    }
    // The jitter's two ends, exactly.
    expect(backoffWait(1, () => 0)).toBe(3_000);
    expect(backoffWait(1, () => 0.999_999_999)).toBeCloseTo(5_000, 3);
    expect(backoffWait(0, () => 0)).toBe(2_000);
    expect(backoffWait(30, () => 0.999_999_999)).toBe(60_000);
  });

  it("Retry-After in seconds or as a date; anything else is no answer", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(retryAfterMs("7", now)).toBe(7_000);
    expect(retryAfterMs(" 12 ", now)).toBe(12_000);
    expect(retryAfterMs("Mon, 26 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Mon, 26 Oct 2026 11:00:00 GMT", now)).toBe(0);
    for (const bad of [null, "", "soon", "-5", "1.5e3"]) expect(retryAfterMs(bad, now), String(bad)).toBeNull();
  });
});

describe("the backoff's state", () => {
  function world() {
    const clock = { t: 1_000_000 };
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const stale: unknown[] = [];
    const backoff = new Backoff({ now: () => clock.t, random: seeded(3), log: (event, fields) => lines.push({ event, fields }), onStale: (f) => stale.push(f) });
    return { clock, lines, stale, backoff };
  }

  it("a Retry-After raises the wait to at least its value, still capped at 60 s", () => {
    const { backoff } = world();
    expect(backoff.fail({ status: 429, reason: "HTTP 429", retryAfterMs: 20_000 })).toBe(20_000);
    expect(backoff.fail({ status: 429, reason: "HTTP 429", retryAfterMs: 600_000 })).toBe(60_000);
    // A Retry-After below the backoff's own wait changes nothing.
    const w = backoff.fail({ status: 503, reason: "HTTP 503", retryAfterMs: 1_000 });
    expect(w).toBeGreaterThanOrEqual(6_000);
    expect(w).toBeLessThanOrEqual(10_000);
  });

  it("waits grow by attempt, and a good read (200 or 304) starts them again at k = 0", () => {
    const { backoff } = world();
    const first = [0, 1, 2, 3].map(() => backoff.fail({ status: 503, reason: "HTTP 503" }));
    expect(first[0]).toBeLessThanOrEqual(2_500);
    expect(first[3]).toBeGreaterThanOrEqual(12_000);
    expect(backoff.attempt).toBe(4);
    backoff.ok();
    expect(backoff.attempt).toBe(0);
    expect(backoff.failing).toBe(false);
    expect(backoff.fail({ status: null, reason: "fetch failed" })).toBeLessThanOrEqual(2_500);
  });

  it("one line per change of state, never one per failed read; feed.stale after the third, once; one notice an outage", () => {
    const { backoff, lines, stale, clock } = world();
    backoff.ok();
    expect(lines).toEqual([]);
    for (let i = 0; i < 12; i += 1) {
      backoff.fail({ status: 429, reason: "HTTP 429" });
      clock.t += 10_000;
    }
    expect(lines.map((l) => l.event)).toEqual(["feed.backoff", "feed.stale"]);
    expect(lines[0]!.fields).toMatchObject({ status: 429, reason: "HTTP 429" });
    expect(lines[1]!.fields).toMatchObject({ failures: 3 });
    expect(stale).toHaveLength(1);
    backoff.ok();
    backoff.ok();
    expect(lines.map((l) => l.event)).toEqual(["feed.backoff", "feed.stale", "feed.ok"]);
    expect(lines[2]!.fields).toMatchObject({ afterMs: 120_000, failures: 12 });
    // A second outage is a second set of lines, and a second notice.
    backoff.fail({ status: null, reason: "timeout" });
    backoff.fail({ status: null, reason: "timeout" });
    backoff.fail({ status: null, reason: "timeout" });
    backoff.ok();
    expect(lines.map((l) => l.event)).toEqual(["feed.backoff", "feed.stale", "feed.ok", "feed.backoff", "feed.stale", "feed.ok"]);
    expect(stale).toHaveLength(2);
  });
});

describe("retrying: FL enter's GETs", () => {
  const clock = () => {
    const c = { t: 0, slept: [] as number[] };
    return { c, retry: { now: () => c.t, sleep: async (ms: number) => void (c.slept.push(ms), (c.t += ms)), random: seeded(11) } };
  };
  const statusOf = (outcome: { value: number } | { error: unknown }) => ("error" in outcome ? { status: null, reason: "fetch failed" } : outcome.value === 503 || outcome.value === 429 ? { status: outcome.value, reason: `HTTP ${outcome.value}` } : null);

  it("a 503 then a 200: one wait, then the answer", async () => {
    const { c, retry } = clock();
    const answers = [503, 200];
    const got = await retrying(retry, async () => answers.shift()!, statusOf);
    expect(got).toBe(200);
    expect(c.slept).toHaveLength(1);
    expect(c.slept[0]).toBeGreaterThanOrEqual(2_000);
  });

  it("at most 3 attempts and 2 minutes in all; a network error is a failure too; other answers are never asked again", async () => {
    const { c, retry } = clock();
    let asked = 0;
    expect(await retrying(retry, async () => ((asked += 1), 503), statusOf)).toBe(503);
    expect(asked).toBe(3);
    expect(c.t).toBeLessThanOrEqual(120_000);
    let thrown = 0;
    await expect(
      retrying(retry, async () => {
        thrown += 1;
        throw new TypeError("fetch failed");
      }, statusOf),
    ).rejects.toThrow("fetch failed");
    expect(thrown).toBe(3);
    let once = 0;
    expect(await retrying(retry, async () => ((once += 1), 404), statusOf)).toBe(404);
    expect(once).toBe(1);
    // No policy: one attempt, as before.
    let plain = 0;
    expect(await retrying(undefined, async () => ((plain += 1), 503), statusOf)).toBe(503);
    expect(plain).toBe(1);
  });

  it("a Retry-After past the 2-minute budget is not waited for", async () => {
    const { c, retry } = clock();
    let asked = 0;
    const got = await retrying(retry, async () => ((asked += 1), 429), () => ({ status: 429, reason: "HTTP 429", retryAfterMs: 60_000 }));
    expect(got).toBe(429);
    expect(asked).toBe(3);
    expect(c.t).toBeLessThanOrEqual(120_000);
  });
});
