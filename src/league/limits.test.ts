import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMITS,
  LIMIT_SPECS,
  MIN_TRADE_BNB,
  WARMUP_SIZE_BNB,
  WARMUP_TRADES,
  bnbToWei,
  loosenedBeyond,
  resolveLimits,
  weiToBnb,
  migrateLimits,
  type Limits,
} from "./limits.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/** PLAN.md §3, as approved, with the owner's ruling of 2026-10-26 (L3 the cap on BNB at work; L1, L2, L4 and L12 gone). */
const PLAN: Record<keyof Limits, { id: string; default: number; min: number | keyof Limits; max: number | keyof Limits }> = {
  maxAtWorkBnb: { id: "L3", default: 0.15, min: 0.001, max: 0.15 },
  maxOpenPositions: { id: "L5", default: 5, min: 1, max: 20 },
  backstopStopLossPct: { id: "L6", default: 50, min: 5, max: 90 },
  maxDailyLossBnb: { id: "L7", default: 0.05, min: 0.001, max: 0.5 },
  maxDrawdownBnb: { id: "L8", default: 0.1, min: 0.001, max: 0.15 },
  maxSlippagePct: { id: "L9", default: 10, min: 0.1, max: 20 },
  maxPriceImpactPct: { id: "L10", default: 8, min: 0.5, max: 25 },
  gasReserveBnb: { id: "L11", default: 0.003, min: 0.001, max: 0.1 },
  coinCooldownSeconds: { id: "L13", default: 60, min: 15, max: 3600 },
  maxConsecutiveFailures: { id: "L14", default: 3, min: 2, max: 10 },
};

const resolved = (input: unknown): Limits => {
  const r = resolveLimits(input);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.limits;
};
const refused = (input: unknown): string[] => {
  const r = resolveLimits(input);
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(input)}`);
  return r.errors;
};

describe("the hard limits, as PLAN.md §3 sets them", () => {
  it("has exactly the ten configurable limits left, their ids never renumbered, with the plan's defaults and ranges", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(LIMIT_SPECS.map((s) => s.id)).toEqual(["L3", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L13", "L14"]);
    for (const spec of LIMIT_SPECS) {
      const plan = PLAN[spec.key];
      expect(spec.id, spec.key).toBe(plan.id);
      expect(spec.default, spec.key).toBe(plan.default);
      expect(spec.min, spec.key).toBe(plan.min);
      expect(spec.max, spec.key).toBe(plan.max);
      expect(DEFAULT_LIMITS[spec.key], spec.key).toBe(plan.default);
    }
  });

  it("resolves an empty config to the defaults", () => {
    expect(resolved({})).toEqual(DEFAULT_LIMITS);
    expect(resolved(undefined)).toEqual(DEFAULT_LIMITS);
  });

  it("the warm-up and minimum sizes are the plan's", () => {
    expect(MIN_TRADE_BNB).toBe(0.001);
    expect(WARMUP_TRADES).toBe(5);
    expect(WARMUP_SIZE_BNB).toBe(0.001);
  });
});

describe("no limit can be switched off", () => {
  for (const spec of LIMIT_SPECS) {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, "", "off", false]) {
      it(`${spec.id} ${spec.key} refuses ${String(bad)}`, () => {
        const errors = refused({ [spec.key]: bad });
        expect(errors.join(" ")).toContain(spec.id);
      });
    }
  }

  it("refuses an unknown key rather than ignoring it (a typo must not leave a limit at its default unnoticed)", () => {
    expect(refused({ maxTradeBNB: 0.01 }).join(" ")).toMatch(/unknown/i);
  });

  it("a retired limit given again is refused with what became of it", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(refused({ maxTradeBnb: 0.01 }).join(" ")).toMatch(/L1 .* was removed: the league has no per-trade, hourly or daily volume limit/);
    expect(refused({ maxDailySpendBnb: 0.1 }).join(" ")).toMatch(/L2 .* was removed/);
    expect(refused({ maxTradesPerHour: 12 }).join(" ")).toMatch(/L12 .* was removed/);
    expect(refused({ budgetBnb: 0.15 }).join(" ")).toMatch(/now L3 maxAtWorkBnb/);
    expect(refused({ maxExposureBnb: 0.1 }).join(" ")).toMatch(/now L3 maxAtWorkBnb/);
  });
});

describe("ranges", () => {
  it("a user may tighten every limit to its floor and loosen it to its ceiling", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const floor = resolved({
      maxAtWorkBnb: 0.001,
      maxOpenPositions: 1,
      backstopStopLossPct: 5,
      maxDailyLossBnb: 0.001,
      maxDrawdownBnb: 0.001,
      maxSlippagePct: 0.1,
      maxPriceImpactPct: 0.5,
      gasReserveBnb: 0.001,
      coinCooldownSeconds: 15,
      maxConsecutiveFailures: 2,
    });
    expect(floor.maxAtWorkBnb).toBe(0.001);
    const ceiling = resolved({
      maxAtWorkBnb: 0.15,
      maxOpenPositions: 20,
      backstopStopLossPct: 90,
      maxDailyLossBnb: 0.5,
      maxDrawdownBnb: 0.15,
      maxSlippagePct: 20,
      maxPriceImpactPct: 25,
      gasReserveBnb: 0.1,
      coinCooldownSeconds: 3600,
      maxConsecutiveFailures: 10,
    });
    expect(ceiling.maxAtWorkBnb).toBe(0.15);
  });

  it("refuses one step past a ceiling or a floor", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(refused({ maxAtWorkBnb: 0.1501 }).join(" ")).toContain("L3");
    expect(refused({ maxAtWorkBnb: 0.0009 }).join(" ")).toContain("L3");
    expect(refused({ maxDrawdownBnb: 0.1501 }).join(" ")).toContain("L8");
    expect(refused({ maxOpenPositions: 21 }).join(" ")).toContain("L5");
    expect(refused({ backstopStopLossPct: 91 }).join(" ")).toContain("L6");
    expect(refused({ backstopStopLossPct: 4.9 }).join(" ")).toContain("L6");
    expect(refused({ maxSlippagePct: 20.5 }).join(" ")).toContain("L9");
    expect(refused({ gasReserveBnb: 0.0005 }).join(" ")).toContain("L11");
    expect(refused({ coinCooldownSeconds: 14 }).join(" ")).toContain("L13");
    expect(refused({ maxConsecutiveFailures: 1 }).join(" ")).toContain("L14");
  });

  it("no limit is bounded by another any more: L3 and L8 are both bounded by the league's 0.15 BNB", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(LIMIT_SPECS.every((spec) => typeof spec.min === "number" && typeof spec.max === "number")).toBe(true);
    expect(resolved({ maxAtWorkBnb: 0.03, maxDrawdownBnb: 0.1 }).maxAtWorkBnb).toBe(0.03);
  });

  it("counts are whole numbers", () => {
    expect(refused({ maxOpenPositions: 2.5 }).join(" ")).toContain("L5");
    expect(refused({ maxConsecutiveFailures: 3.2 }).join(" ")).toContain("L14");
  });

  it("accepts numbers written as strings, as a model or a person may type them", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(resolved({ maxAtWorkBnb: "0.005" }).maxAtWorkBnb).toBe(0.005);
  });
});

describe("the confirmed envelope", () => {
  it("nothing loosened: no complaint; tightening is always allowed", () => {
    expect(loosenedBeyond(DEFAULT_LIMITS, DEFAULT_LIMITS)).toEqual([]);
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(loosenedBeyond({ ...DEFAULT_LIMITS, maxAtWorkBnb: 0.1, gasReserveBnb: 0.01, coinCooldownSeconds: 300 }, DEFAULT_LIMITS)).toEqual([]);
  });

  it("names every limit loosened past what the user confirmed, in the limit's own direction", () => {
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    const looser = { ...DEFAULT_LIMITS, maxAtWorkBnb: 0.15, gasReserveBnb: 0.002, coinCooldownSeconds: 30, backstopStopLossPct: 60 };
    const said = loosenedBeyond(looser, { ...DEFAULT_LIMITS, maxAtWorkBnb: 0.1 }).join(" ");
    expect(said).toContain("L3");
    expect(said).toContain("L11");
    expect(said).toContain("L13");
    expect(said).toContain("L6");
  });
});

describe("BNB and wei", () => {
  it("converts exactly, with no float residue", () => {
    expect(bnbToWei(0.005)).toBe(5_000_000_000_000_000n);
    expect(bnbToWei("0.1")).toBe(100_000_000_000_000_000n);
    expect(bnbToWei(0.1 + 0.2)).toBe(300_000_000_000_000_000n);
    expect(bnbToWei(0.001)).toBe(1_000_000_000_000_000n);
    expect(weiToBnb(2_500_000_000_000_000n)).toBe(0.0025);
  });

  it("refuses what is not an amount", () => {
    expect(() => bnbToWei(-1)).toThrow();
    expect(() => bnbToWei(Number.NaN)).toThrow();
    expect(() => bnbToWei("1e400")).toThrow();
  });
});

describe("limits an earlier runtime stored (migrateLimits)", () => {
  // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
  const migrated = (stored: object) => migrateLimits(stored as unknown as Limits);
  const old = { maxTradeBnb: 0.02, maxDailySpendBnb: 0.1, budgetBnb: 0.15, maxExposureBnb: 0.1, maxOpenPositions: 5, backstopStopLossPct: 50, maxDailyLossBnb: 0.05, maxDrawdownBnb: 0.1, maxSlippagePct: 10, maxPriceImpactPct: 8, gasReserveBnb: 0.003, maxTradesPerHour: 12, coinCooldownSeconds: 60, maxConsecutiveFailures: 3 };

  it("the old defaults become today's defaults, in today's order: the cap is 0.15 BNB at work", () => {
    expect(JSON.stringify(migrated(old))).toBe(JSON.stringify(DEFAULT_LIMITS));
    expect(JSON.stringify(migrated({ ...old, budgetBnb: 0.25 }))).toBe(JSON.stringify(DEFAULT_LIMITS));
    expect(resolved(migrated(old))).toEqual(DEFAULT_LIMITS);
  });

  it("a lower budget or exposure the user chose stays: the cap only ever tightens", () => {
    expect(migrated({ ...old, budgetBnb: 0.05 }).maxAtWorkBnb).toBe(0.05);
    expect(migrated({ ...old, maxExposureBnb: 0.03 }).maxAtWorkBnb).toBe(0.03);
    expect(migrated({ ...old, maxDrawdownBnb: 0.2 }).maxDrawdownBnb).toBe(0.15);
  });

  it("a stored exposure of 0.1 a review tightened (the envelope's is not 0.1) stays; never looser than the envelope", () => {
    const stored = { ...old, maxExposureBnb: 0.1 };
    const envelope = { ...old, maxExposureBnb: 0.12 };
    const now = migrateLimits(stored as unknown as Limits, envelope);
    const yes = migrated(envelope);
    expect(now.maxAtWorkBnb).toBe(0.1);
    expect(yes.maxAtWorkBnb).toBe(0.12);
    expect(loosenedBeyond(now, yes)).toEqual([]);
    // The old default on both sides is the old default: the cap is the league's.
    expect(migrateLimits(old as unknown as Limits, old).maxAtWorkBnb).toBe(0.15);
    // A stored cap can never come out looser than the envelope's.
    expect(migrateLimits({ ...old, budgetBnb: 0.15, maxExposureBnb: 0.1 } as unknown as Limits, { ...old, budgetBnb: 0.05 }).maxAtWorkBnb).toBe(0.05);
  });

  it("limits already in today's shape come back as they are", () => {
    expect(migrateLimits(DEFAULT_LIMITS)).toBe(DEFAULT_LIMITS);
    expect(migrateLimits(null)).toBeNull();
  });
});
