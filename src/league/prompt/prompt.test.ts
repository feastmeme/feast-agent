import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyChange, confirmAgent, planAgent, type AgentConfig } from "../agent.ts";
import { renderCard } from "../card.ts";
import { DEFAULT_LIMITS } from "../limits.ts";
import { CAP_REFUSAL, DEFAULT_IDLE_MINUTES, LEAGUE_CAP_BNB, SAFETY_PASS_SECONDS } from "./constants.ts";
import { autopilotGate, promptChanged } from "./host.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function promptFile(text = "Ride coins whose volume and holders are growing.\nSize 0.005 BNB a trade.\nSell at -20% or after a day.\nNote why on every trade.\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-prompt-"));
  dirs.push(dir);
  const path = join(dir, "strategy.md");
  writeFileSync(path, text);
  return path;
}

function planned(input: Parameters<typeof planAgent>[0]): AgentConfig {
  const out = planAgent(input);
  if (!out.ok) throw new Error(out.errors.join("; "));
  return out.agent;
}

describe("prompt mode: the track", () => {
  it("a prompt and no preset: the prompt track, no autopilot, the safety pass as its only interval", () => {
    const path = promptFile();
    const agent = planned({ name: "demo", promptPath: path });
    expect(agent).toMatchObject({ track: "prompt", preset: null, script: null, autopilot: null, params: {}, tickSeconds: SAFETY_PASS_SECONDS });
    expect(agent.prompt).toEqual({ path, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("a prompt and a preset: the preset is the autopilot, its params resolved as a preset's, --set kept", () => {
    const agent = planned({ name: "demo", promptPath: promptFile(), preset: "momentum", params: { buyBnb: 0.005 } });
    expect(agent).toMatchObject({ track: "prompt", preset: "momentum", autopilot: { idleMinutes: DEFAULT_IDLE_MINUTES }, tickSeconds: 60 });
    expect(agent.params).toMatchObject({ buyBnb: 0.005, lookbackMinutes: 15 });
    expect(agent.given).toEqual(["buyBnb"]);
    expect(planned({ name: "demo", promptPath: promptFile(), preset: "dca", idleMinutes: 30 }).autopilot).toEqual({ idleMinutes: 30 });
  });

  it("a prompt and a script is refused; a preset and a script keeps its own line", () => {
    const out = planAgent({ name: "demo", promptPath: promptFile(), scriptPath: "/nowhere.mjs" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.join("\n")).toMatch(/never a script/);
    const both = planAgent({ name: "demo", preset: "dca", scriptPath: "/nowhere.mjs" });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.errors).toContain("an agent runs one preset or one script");
  });

  it("--idle-minutes needs an autopilot; a tick without one is refused; a missing or empty prompt is refused", () => {
    const idle = planAgent({ name: "demo", promptPath: promptFile(), idleMinutes: 30 });
    expect(idle.ok).toBe(false);
    const tick = planAgent({ name: "demo", promptPath: promptFile(), tickSeconds: 15 });
    expect(tick.ok).toBe(false);
    if (!tick.ok) expect(tick.errors.join(" ")).toMatch(/your agent decides when to look/);
    expect(planAgent({ name: "demo", promptPath: "/no/such/strategy.md" }).ok).toBe(false);
    expect(planAgent({ name: "demo", promptPath: promptFile("   \n") }).ok).toBe(false);
    expect(planAgent({ name: "demo", promptPath: promptFile(), preset: "dca", idleMinutes: 0 }).ok).toBe(false);
  });

  it("a changed prompt file is a changed prompt: the confirmed sha no longer matches", () => {
    const path = promptFile();
    const agent = confirmAgent(planned({ name: "demo", promptPath: path }));
    expect(promptChanged(agent)).toBe(false);
    writeFileSync(path, "Buy everything.\n");
    expect(promptChanged(agent)).toBe(true);
    rmSync(path);
    expect(promptChanged(agent)).toBe(true);
  });
});

describe("the capital cap: 0.15 BNB, the league's boundary, with limits.ts unchanged", () => {
  it("L3's own default and ceiling stay; a plan of any track gets 0.15", () => {
    expect(DEFAULT_LIMITS.budgetBnb).toBe(0.25);
    expect(LEAGUE_CAP_BNB).toBe(0.15);
    expect(planned({ name: "demo", promptPath: promptFile() }).limits.budgetBnb).toBe(0.15);
    expect(planned({ name: "dca1", preset: "dca" }).limits.budgetBnb).toBe(0.15);
    const script = new URL("../../../examples/scripts/round-trip.mjs", import.meta.url).pathname;
    expect(planned({ name: "s", scriptPath: script }).limits.budgetBnb).toBe(0.15);
  });

  it("a tighter budget is kept; one above the cap is refused at plan and at set, with the cap's line", () => {
    expect(planned({ name: "demo", promptPath: promptFile(), limits: { budgetBnb: 0.1 } }).limits.budgetBnb).toBe(0.1);
    const over = planAgent({ name: "demo", promptPath: promptFile(), limits: { budgetBnb: 0.2 } });
    expect(over).toEqual({ ok: false, errors: [CAP_REFUSAL] });
    expect(CAP_REFUSAL).toBe("the league caps capital at 0.15 BNB");
    const agent = confirmAgent(planned({ name: "dca1", preset: "dca" }));
    expect(applyChange(agent, { limits: { budgetBnb: 0.2 } }, { byReview: false })).toEqual({ ok: false, errors: [CAP_REFUSAL] });
    expect(applyChange(agent, { limits: { budgetBnb: "0.16" } }, { byReview: false })).toEqual({ ok: false, errors: [CAP_REFUSAL] });
    const tighter = applyChange(agent, { limits: { budgetBnb: 0.12 } }, { byReview: false });
    expect(tighter.ok && tighter.agent.limits.budgetBnb).toBe(0.12);
  });

  it("a prompt agent without an autopilot takes no parameters and no tick at set", () => {
    const agent = confirmAgent(planned({ name: "demo", promptPath: promptFile() }));
    expect(applyChange(agent, { params: { buyBnb: 0.01 } }, { byReview: false }).ok).toBe(false);
    expect(applyChange(agent, { tickSeconds: 30 }, { byReview: false }).ok).toBe(false);
    expect(applyChange(agent, { limits: { maxTradeBnb: 0.01 } }, { byReview: false }).ok).toBe(true);
  });
});

describe("the card of a prompt agent", () => {
  it("shows the prompt's first three lines, cleaned, its sha as 6+4, the cap and the autopilot", () => {
    const path = promptFile("Line one\u001b[31m red\u001b[0m\n\nLine ‮two‬\nLine three\nLine four, not shown\n");
    const agent = planned({ name: "demo", promptPath: path });
    const card = renderCard(agent);
    expect(card).toContain(`Prompt: ${path} (sha256 ${agent.prompt!.sha256.slice(0, 6)}…${agent.prompt!.sha256.slice(-4)})`);
    expect(card).toContain("  > Line one red\n  > Line two\n  > Line three");
    expect(card).not.toContain("Line four");
    expect(card).not.toMatch(/[\u001b‮]/);
    expect(card).toContain("Capital cap: 0.15 BNB, wallet-wide: every agent on this wallet counts.");
    expect(card).toContain("Autopilot: none.");
    expect(card).toContain("the runtime watches your positions for the hard stop-loss; when to look and when to trade is your agent's call");
    expect(card).not.toMatch(/Cadence: a tick every/);
    expect(card).toContain("This trades real BNB from your wallet as soon as you say yes. There is no practice mode.");
    const auto = renderCard(planned({ name: "demo", promptPath: path, preset: "momentum", idleMinutes: 45 }));
    expect(auto).toContain("Autopilot: preset momentum (Momentum), only after 45 min with no FL buy, FL sell or FL note from your agent");
    expect(auto).toContain("| buyBnb | 0.01 BNB | default |");
  });

  it("every card of the user's own agents names the cap", () => {
    expect(renderCard(planned({ name: "dca1", preset: "dca" }))).toContain("Capital cap: 0.15 BNB, wallet-wide: every agent on this wallet counts.");
  });
});

describe("the autopilot's gate", () => {
  it("calls the preset only while the host is silent, and answers nothing otherwise", async () => {
    let silent = false;
    const asked: string[] = [];
    const inner = {
      meta: { name: "dca", tickSeconds: 60, events: ["price.move" as const], watch: ["FEAST"] },
      params: {},
      wants: () => [],
      call: async (fn: "onTick" | "onEvent", _s: never, state: Record<string, unknown>) => (asked.push(fn), { intents: [{ id: "x" } as never], problems: [], logs: [], state }),
      stop: () => {},
    };
    const gated = autopilotGate(inner, () => silent);
    expect((await gated.call("onTick", {} as never, {})).intents).toEqual([]);
    expect((await gated.call("onEvent", {} as never, {})).intents).toEqual([]);
    expect(asked).toEqual([]);
    silent = true;
    expect((await gated.call("onTick", {} as never, {})).intents).toHaveLength(1);
    expect((await gated.call("onEvent", {} as never, {})).intents).toHaveLength(1);
    expect(asked).toEqual(["onTick", "onEvent"]);
  });
});
