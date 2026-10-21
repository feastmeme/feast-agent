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
  type Limits,
} from "./limits.ts";

/** PLAN.md §3, as approved: every default and range. */
const PLAN: Record<keyof Limits, { id: string; default: number; min: number | keyof Limits; max: number | keyof Limits }> = {
  maxTradeBnb: { id: "L1", default: 0.02, min: 0.001, max: 0.25 },
  maxDailySpendBnb: { id: "L2", default: 0.1, min: "maxTradeBnb", max: 1 },
  budgetBnb: { id: "L3", default: 0.25, min: "maxDailySpendBnb", max: 10 },
  maxExposureBnb: { id: "L4", default: 0.1, min: "maxTradeBnb", max: 2 },
  maxOpenPositions: { id: "L5", default: 5, min: 1, max: 20 },
  backstopStopLossPct: { id: "L6", default: 50, min: 5, max: 90 },
  maxDailyLossBnb: { id: "L7", default: 0.05, min: 0.001, max: 0.5 },
  maxDrawdownBnb: { id: "L8", default: 0.1, min: 0.001, max: "budgetBnb" },
  maxSlippagePct: { id: "L9", default: 10, min: 0.1, max: 20 },
  maxPriceImpactPct: { id: "L10", default: 8, min: 0.5, max: 25 },
  gasReserveBnb: { id: "L11", default: 0.003, min: 0.001, max: 0.1 },
  maxTradesPerHour: { id: "L12", default: 12, min: 1, max: 60 },
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
  it("has exactly the fourteen configurable limits, L1–L14, with the plan's defaults and ranges", () => {
    expect(LIMIT_SPECS.map((s) => s.id)).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L12", "L13", "L14"]);
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
});

describe("ranges", () => {
  it("a user may tighten every limit to its floor and loosen it to its ceiling", () => {
    const floor = resolved({
      maxTradeBnb: 0.001,
      maxDailySpendBnb: 0.001,
      budgetBnb: 0.001,
      maxExposureBnb: 0.001,
      maxOpenPositions: 1,
      backstopStopLossPct: 5,
      maxDailyLossBnb: 0.001,
      maxDrawdownBnb: 0.001,
      maxSlippagePct: 0.1,
      maxPriceImpactPct: 0.5,
      gasReserveBnb: 0.001,
      maxTradesPerHour: 1,
      coinCooldownSeconds: 15,
      maxConsecutiveFailures: 2,
    });
    expect(floor.maxTradeBnb).toBe(0.001);
    const ceiling = resolved({
      maxTradeBnb: 0.25,
      maxDailySpendBnb: 1,
      budgetBnb: 10,
      maxExposureBnb: 2,
      maxOpenPositions: 20,
      backstopStopLossPct: 90,
      maxDailyLossBnb: 0.5,
      maxDrawdownBnb: 10,
      maxSlippagePct: 20,
      maxPriceImpactPct: 25,
      gasReserveBnb: 0.1,
      maxTradesPerHour: 60,
      coinCooldownSeconds: 3600,
      maxConsecutiveFailures: 10,
    });
    expect(ceiling.budgetBnb).toBe(10);
  });

  it("refuses one step past a ceiling or a floor", () => {
    expect(refused({ maxTradeBnb: 0.2501 }).join(" ")).toContain("L1");
    expect(refused({ maxTradeBnb: 0.0009 }).join(" ")).toContain("L1");
    expect(refused({ maxOpenPositions: 21 }).join(" ")).toContain("L5");
    expect(refused({ backstopStopLossPct: 91 }).join(" ")).toContain("L6");
    expect(refused({ backstopStopLossPct: 4.9 }).join(" ")).toContain("L6");
    expect(refused({ maxSlippagePct: 20.5 }).join(" ")).toContain("L9");
    expect(refused({ gasReserveBnb: 0.0005 }).join(" ")).toContain("L11");
    expect(refused({ maxTradesPerHour: 61 }).join(" ")).toContain("L12");
    expect(refused({ coinCooldownSeconds: 14 }).join(" ")).toContain("L13");
    expect(refused({ maxConsecutiveFailures: 1 }).join(" ")).toContain("L14");
  });

  it("holds the limits that are bounded by other limits to them", () => {
    // L2 ≥ L1, L3 ≥ L2, L4 ≥ L1, L8 ≤ L3
    expect(refused({ maxTradeBnb: 0.05, maxDailySpendBnb: 0.04 }).join(" ")).toContain("L2");
    expect(refused({ maxDailySpendBnb: 0.3, budgetBnb: 0.25 }).join(" ")).toContain("L3");
    expect(refused({ maxTradeBnb: 0.05, maxExposureBnb: 0.04 }).join(" ")).toContain("L4");
    expect(refused({ budgetBnb: 0.2, maxDrawdownBnb: 0.21 }).join(" ")).toContain("L8");
    expect(resolved({ maxTradeBnb: 0.005, maxDailySpendBnb: 0.03, budgetBnb: 0.03, maxDrawdownBnb: 0.03 }).budgetBnb).toBe(0.03);
  });

  it("counts are whole numbers", () => {
    expect(refused({ maxOpenPositions: 2.5 }).join(" ")).toContain("L5");
    expect(refused({ maxTradesPerHour: 1.5 }).join(" ")).toContain("L12");
    expect(refused({ maxConsecutiveFailures: 3.2 }).join(" ")).toContain("L14");
  });

  it("accepts numbers written as strings, as a model or a person may type them", () => {
    expect(resolved({ maxTradeBnb: "0.005" }).maxTradeBnb).toBe(0.005);
  });
});

describe("the confirmed envelope", () => {
  it("nothing loosened: no complaint; tightening is always allowed", () => {
    expect(loosenedBeyond(DEFAULT_LIMITS, DEFAULT_LIMITS)).toEqual([]);
    expect(loosenedBeyond({ ...DEFAULT_LIMITS, maxTradeBnb: 0.01, gasReserveBnb: 0.01, coinCooldownSeconds: 300 }, DEFAULT_LIMITS)).toEqual([]);
  });

  it("names every limit loosened past what the user confirmed, in the limit's own direction", () => {
    const looser = { ...DEFAULT_LIMITS, maxTradeBnb: 0.03, gasReserveBnb: 0.002, coinCooldownSeconds: 30, backstopStopLossPct: 60 };
    const said = loosenedBeyond(looser, DEFAULT_LIMITS).join(" ");
    expect(said).toContain("L1");
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
