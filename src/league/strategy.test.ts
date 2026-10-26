import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "./limits.ts";
import { makeApi, normalizeIntent, type IntentRequest, type Snapshot } from "./strategy.ts";

// Synthetic: never a real coin.
const FEAST = "0x000000000000000000000000000000000000fea5";
const IMAGE = { path: "/tmp/feast-league-test/agents/league-entry/avatar.png", sha256: "ab".repeat(32) };
const launch: IntentRequest = { kind: "launch", name: "maplegrin.ai", symbol: "MAPLEGRIN", image: IMAGE };
const ctx = (source: "manual" | "script" | "preset" | "runtime") => ({ snapshot: { feast: FEAST, now: 1, limits: DEFAULT_LIMITS }, source, slippagePct: 3, ttlMs: 1_000 }) as const;

describe("a launch's picture on the request (task 961)", () => {
  it("is kept only on a manual request: a script or a preset can never name a file", () => {
    const manual = normalizeIntent(launch, ctx("manual"));
    expect("intent" in manual && manual.intent.launch?.image).toEqual(IMAGE);
    for (const source of ["script", "preset", "runtime"] as const) {
      const other = normalizeIntent(launch, ctx(source));
      expect("intent" in other && other.intent.launch).toBeTruthy();
      expect("intent" in other && other.intent.launch?.image).toBeUndefined();
    }
  });

  it("is dropped unless it is an absolute path and a sha256", () => {
    for (const image of [{ path: "avatar.png", sha256: "ab".repeat(32) }, { path: IMAGE.path, sha256: "nope" }, { path: 1, sha256: "ab".repeat(32) }, "avatar.png", null]) {
      const out = normalizeIntent({ ...launch, image }, ctx("manual"));
      expect("intent" in out && out.intent.launch?.image).toBeUndefined();
    }
  });

  it("league-v5.1.4: a script written before still reads the retired limits, as the cap that replaced them", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const snapshot = { now: 1, balanceBnb: 1, limits: { ...DEFAULT_LIMITS, maxAtWorkBnb: 0.1 }, warmup: null, coins: [], positions: [], trades: [], holders: {}, launchesByCreator: {}, feast: FEAST, launched: null } as unknown as Snapshot;
    const { api } = makeApi(snapshot, { params: {}, state: {}, source: "script", ttlMs: 1_000, log: () => {} });
    expect(api.read.limits()).toMatchObject({ maxAtWorkBnb: 0.1, maxTradeBnb: 0.1, maxDailySpendBnb: 0.1, budgetBnb: 0.1, maxExposureBnb: 0.1, maxTradesPerHour: 60 });
    expect(Math.min(0.005, (api.read.limits() as unknown as { maxTradeBnb: number }).maxTradeBnb)).toBe(0.005);
  });

  it("a script's api.launch cannot pass one through", () => {
    const snapshot = { now: 1, balanceBnb: 1, limits: DEFAULT_LIMITS, warmup: null, coins: [], positions: [], trades: [], holders: {}, launchesByCreator: {}, feast: FEAST, launched: null } as unknown as Snapshot;
    const { api, intents } = makeApi(snapshot, { params: {}, state: {}, source: "script", ttlMs: 1_000, log: () => {} });
    (api.launch as (r: unknown) => string | null)({ name: "x", symbol: "X", image: IMAGE });
    expect(intents[0]?.launch?.image).toBeUndefined();
  });
});
