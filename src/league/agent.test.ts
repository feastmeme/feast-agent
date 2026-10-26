import { describe, expect, it } from "vitest";

import { applyChange, confirmAgent, planAgent, type AgentConfig } from "./agent.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

const LEADER = "0x000000000000000000000000000000000000bEEF";
const OTHER = "0x000000000000000000000000000000000000c0DE";

function confirmed(preset: string, params: Record<string, unknown> = {}): AgentConfig {
  const planned = planAgent({ name: "t", preset, params });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  return confirmAgent(planned.agent);
}
const review = (agent: AgentConfig, params: Record<string, unknown>, limits: Record<string, unknown> = {}) => applyChange(agent, { params, limits }, { byReview: true });

describe("the hourly review stays inside the envelope the user confirmed", () => {
  it("may tighten a size and a stop, and retune a neutral threshold either way", () => {
    const sniper = confirmed("sniper");
    expect(review(sniper, { buyBnb: 0.004, stopLossPct: 20 }).ok).toBe(true);
    const momentum = confirmed("momentum");
    expect(review(momentum, { lookbackMinutes: 30 }).ok).toBe(true);
    expect(review(momentum, { lookbackMinutes: 10 }).ok).toBe(true);
    expect(review(momentum, { minVolumeBnb: 1 }).ok).toBe(true);
  });

  it("may not raise a size, a stop, a slippage or a count, nor lower an entry threshold", () => {
    const sniper = confirmed("sniper");
    for (const params of [{ buyBnb: 0.006 }, { stopLossPct: 30 }, { slippagePct: 9 }, { snipesPerHour: 4 }, { maxAgeSeconds: 120 }, { timeStopMinutes: 60 }]) {
      expect(review(sniper, params).ok, JSON.stringify(params)).toBe(false);
    }
    const momentum = confirmed("momentum");
    expect(review(momentum, { minVolumeBnb: 0.1 }).ok).toBe(false);
    expect(review(momentum, { minNewHolders: 5 }).ok).toBe(false);
    const dca = confirmed("dca");
    expect(review(dca, { everyMinutes: 60 }).ok).toBe(false);
    expect(review(dca, { dipPct: 5 }).ok).toBe(false);
  });

  it("lists may only shrink; booleans may only move to the safer value; choices do not change", () => {
    const copy = confirmed("copy", { wallets: [LEADER, OTHER] });
    expect(review(copy, { wallets: [LEADER] }).ok).toBe(true);
    expect(review(copy, { wallets: [LEADER, OTHER, "0x000000000000000000000000000000000000dEaD"] }).ok).toBe(false);
    expect(review(copy, { sizeMode: "proportional" }).ok).toBe(false);
    const sniper = confirmed("sniper", { requireMetadata: false, quotes: "WBNB,BNCB" });
    expect(review(sniper, { requireMetadata: true }).ok).toBe(true);
    expect(review(confirmed("sniper"), { requireMetadata: false }).ok).toBe(false);
    expect(review(sniper, { quotes: "WBNB" }).ok).toBe(true);
    expect(review(sniper, { quotes: "all" }).ok).toBe(false);
    const dca = confirmed("dca");
    expect(review(dca, { targets: "topHolders" }).ok).toBe(false);
  });

  it("may not loosen a limit", () => {
    const dca = confirmed("dca");
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(review(dca, {}, { maxAtWorkBnb: 0.1 }).ok).toBe(true);
    expect(review(dca, {}, { maxOpenPositions: 4 }).ok).toBe(true);
    expect(review(dca, {}, { maxOpenPositions: 6 }).ok).toBe(false);
  });

  it("may not change a script's parameters at all", () => {
    const planned = planAgent({ name: "s", scriptPath: new URL("../../examples/scripts/round-trip.mjs", import.meta.url).pathname });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const script = confirmAgent(planned.agent);
    expect(applyChange(script, { params: { size: 0.001 } }, { byReview: true }).ok).toBe(false);
  });

  it("a change the user makes is a new confirmation, and becomes the envelope", () => {
    const sniper = confirmed("sniper");
    const changed = applyChange(sniper, { params: { buyBnb: 0.01 } }, { byReview: false });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.agent.confirmed?.params.buyBnb).toBe(0.01);
  });
});
