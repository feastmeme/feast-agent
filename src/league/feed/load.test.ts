import { describe, expect, it } from "vitest";

import { cursorAt } from "../events.ts";
import { seeded, VirtualTime } from "./fakes.ts";
import { drawStartJitter, SnapshotClient } from "./snapshot.ts";

/**
 * Design 5's load test: 1,000 runtime instances in one process, each a real SnapshotClient with its own seeded random,
 * against a stub snapshot server (an in-process fetch that counts requests by instance and time, and answers 200 with a
 * fresh ETag every 5 simulated seconds and 304 otherwise). Virtual time throughout: no socket, no wall-clock wait.
 * The numbers each run measures are printed for the report.
 */

const N = 1_000;
const S = 1_000;

type Request = { at: number; who: number };

function stubServer(vt: VirtualTime, outage?: { from: number; to: number }) {
  const requests: Request[] = [];
  const bodyOf = (generation: number) => JSON.stringify({ generatedAt: new Date(generation * 5 * S).toISOString(), block: 1_000 + generation, coins: [], events: [], cursor: cursorAt(1_000 + generation, 0) });
  const plain = (status: number, headers: Record<string, string>, body: string | null) =>
    ({ status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => body ?? "" }) as unknown as Response;
  const fetchFor = (who: number) =>
    (async (_url: string, init?: RequestInit) => {
      const at = vt.now();
      requests.push({ at, who });
      if (outage && at >= outage.from && at < outage.to) return plain(429, { "content-type": "application/json" }, "{}");
      const generation = Math.floor(at / (5 * S));
      const etag = `"g${generation}"`;
      const inm = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
      return inm === etag ? plain(304, { etag }, null) : plain(200, { etag, "content-type": "application/json" }, bodyOf(generation));
    }) as unknown as typeof fetch;
  return { requests, fetchFor };
}

async function simulate(o: { endMs: number; jitter: boolean; outage?: { from: number; to: number } }) {
  const vt = new VirtualTime(0);
  const server = stubServer(vt, o.outage);
  const logs: string[][] = Array.from({ length: N }, () => []);
  const firstRead: number[] = [];
  for (let who = 0; who < N; who += 1) {
    const random = seeded(who + 1);
    const client = new SnapshotClient({ site: "https://feast.test", fetch: server.fetchFor(who), now: vt.now, random, timeoutMs: 0, log: (event) => logs[who]!.push(event) });
    void (async () => {
      // FL start's jitter: before the first read of the site.
      if (o.jitter) await vt.sleep(drawStartJitter(random));
      firstRead[who] = vt.now();
      for (;;) {
        await client.read();
        await vt.sleep(Math.max(0, client.nextAt - vt.now()));
      }
    })();
  }
  await vt.runUntil(o.endMs);
  const byWho: number[][] = Array.from({ length: N }, () => []);
  for (const r of server.requests) byWho[r.who]!.push(r.at);
  const count = (from: number, to: number) => server.requests.filter((r) => r.at >= from && r.at < to).length;
  const peakPerSecond = (from: number, to: number) => {
    const buckets = new Map<number, number>();
    for (const r of server.requests) if (r.at >= from && r.at < to) buckets.set(Math.floor(r.at / S), (buckets.get(Math.floor(r.at / S)) ?? 0) + 1);
    return Math.max(0, ...buckets.values());
  };
  const smallestGap = Math.min(...byWho.flatMap((times) => times.slice(1).map((t, i) => t - times[i]!)));
  return { requests: server.requests, byWho, logs, firstRead, count, peakPerSecond, smallestGap };
}

const band = (seconds: number) => [N * (seconds / 8) - N, N * (seconds / 5) + N] as const;

describe("1,000 runtime instances against one snapshot", () => {
  it("steady, with no start jitter: inside the 5–8 s band over 120 s, never more than 1,000 per 5 s on average", async () => {
    const run = await simulate({ endMs: 120 * S, jitter: false });
    const total = run.count(0, 120 * S);
    const [low, high] = band(120);
    expect(total).toBeGreaterThanOrEqual(low);
    expect(total).toBeLessThanOrEqual(high);
    expect(total / (120 / 5)).toBeLessThanOrEqual(N);
    expect(run.smallestGap).toBeGreaterThanOrEqual(5 * S);
    const peak = run.peakPerSecond(0, 120 * S);
    // The baseline without the jitter: every instance's first read in the same second.
    expect(peak).toBe(N);
    console.info(`[load] steady: ${total} requests in 120 s (band ${low}–${high}); ${(total / 24).toFixed(0)} per 5 s; 1 s peak without the start jitter ${peak}; smallest gap ${(run.smallestGap / S).toFixed(3)} s`);
  });

  it("the start jitter spreads the 20:00 burst over 0–120 s: no 1 s bucket holds more than 3 × (1000/120) first reads", async () => {
    const run = await simulate({ endMs: 125 * S, jitter: true });
    const firsts = run.byWho.map((times) => times[0]!);
    expect(Math.min(...firsts)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...firsts)).toBeLessThan(120 * S);
    const buckets = new Map<number, number>();
    for (const t of firsts) buckets.set(Math.floor(t / S), (buckets.get(Math.floor(t / S)) ?? 0) + 1);
    const peakFirst = Math.max(...buckets.values());
    expect(peakFirst).toBeLessThanOrEqual(3 * (N / 120));
    // Spread, not bunched: most seconds of the two minutes see a first read.
    expect(buckets.size).toBeGreaterThanOrEqual(100);
    const peakAll = run.peakPerSecond(0, 120 * S);
    console.info(`[load] start: with the jitter, at most ${peakFirst} first reads in any 1 s (limit ${(3 * N / 120).toFixed(1)}), ${peakAll} requests of any kind in any 1 s; without it, ${N} in the first second`);
  });

  it("429s from 60 s to 240 s: each instance backs off, never twice within 3 s, and the site sees a trickle; back in the band within 75 s", async () => {
    const outage = { from: 60 * S, to: 240 * S };
    const run = await simulate({ endMs: 400 * S, jitter: false, outage });
    // Every instance's waits during the outage follow the backoff.
    let longest = 0;
    for (const times of run.byWho) {
      const failing = times.filter((t) => t >= outage.from && t < outage.to);
      // The first ask after the outage's end is the one that comes back.
      const after = times.find((t) => t >= outage.to);
      const seq = after === undefined ? failing : [...failing, after];
      for (let j = 1; j < seq.length; j += 1) {
        const gap = seq[j]! - seq[j - 1]!;
        longest = Math.max(longest, gap);
        expect(gap).toBeGreaterThanOrEqual(Math.max(3 * S, 0.75 * Math.min(60 * S, 2 * S * 2 ** (j - 1))));
        expect(gap).toBeLessThanOrEqual(75 * S);
      }
    }
    expect(run.smallestGap).toBeGreaterThanOrEqual(3 * S);
    const lastMinute = run.count(180 * S, 240 * S);
    expect(lastMinute).toBeLessThanOrEqual(N * (60 / 45));
    // Recovered: every instance has read once since the outage ended, within 75 s of its end.
    const backAt = run.byWho.map((times) => times.find((t) => t >= outage.to)!);
    const recovery = Math.max(...backAt) - outage.to;
    expect(recovery).toBeLessThanOrEqual(75 * S);
    const steady = run.count(315 * S, 375 * S);
    const [low, high] = band(60);
    expect(steady).toBeGreaterThanOrEqual(low);
    expect(steady).toBeLessThanOrEqual(high);
    // One line each way, per instance, for the outage (and the stale line after its third failed read).
    for (const lines of run.logs) expect(lines).toEqual(["feed.backoff", "feed.stale", "feed.ok"]);
    const before = run.count(0, 60 * S);
    console.info(
      `[load] outage: ${before} requests in the 60 s before it; ${lastMinute} in its last 60 s (limit ${(N * 60 / 45).toFixed(0)}), i.e. ${(lastMinute / 60).toFixed(1)}/s against ${(before / 60).toFixed(1)}/s steady; longest wait ${(longest / S).toFixed(1)} s; every instance back ${(recovery / S).toFixed(1)} s after the end; ${steady} requests in 315–375 s (band ${low}–${high}); smallest gap ${(run.smallestGap / S).toFixed(3)} s`,
    );
  });
});
