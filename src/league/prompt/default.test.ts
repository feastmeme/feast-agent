import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, loadAgent, planAgent, saveAgent, type PlanInput } from "../agent.ts";
import { renderCard } from "../card.ts";
import * as copy from "../enter/copy.ts";
import { autopilotChoice, prepareStart } from "../start.ts";
import { DEFAULT_AUTOPILOT, DEFAULT_IDLE_MINUTES, IDLE_MINUTES_MAX, IDLE_MINUTES_MIN, PAGE_IDLE_RULE } from "./constants.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/**
 * Task 975, the owner's ruling A: a prompt agent planned by FL enter, FL start --prompt or FL plan --prompt gets the
 * steady autopilot backup by default, after 30 minutes with no trade from its host; --no-autopilot turns it off.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-default-"));
  dirs.push(dir);
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, "Keep it small.\n");
  return { home: join(dir, "home"), promptPath };
}

export const BACKUP_ON =
  "Autopilot backup: on. If your agent makes no FL buy or FL sell for 30 min, the steady preset (Steady floor keeper) trades until your agent trades again: it keeps the league's daily activity floor with small buys of the busiest Feast coins (never your own coin), spaced out and done early in the day, each sold by a take-profit, a stop-loss or a time stop. A note or a read does not hold it back. Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell). --no-autopilot turns it off.";

describe("the default, in one place", () => {
  it("30 minutes, steady, the range unchanged", () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(30);
    expect(DEFAULT_AUTOPILOT).toBe("steady");
    expect([IDLE_MINUTES_MIN, IDLE_MINUTES_MAX]).toEqual([1, 1_440]);
  });

  it("autopilotChoice: neither flag is steady; --autopilot names another; --no-autopilot is none; both are refused", () => {
    expect(autopilotChoice({})).toEqual({ ok: true, preset: "steady" });
    expect(autopilotChoice({ autopilot: "momentum" })).toEqual({ ok: true, preset: "momentum" });
    expect(autopilotChoice({ noAutopilot: true })).toEqual({ ok: true, preset: undefined });
    expect(autopilotChoice({ autopilot: "momentum", noAutopilot: true })).toEqual({ ok: false, error: "choose --autopilot <preset> or --no-autopilot" });
  });

  it("planAgent itself keeps no default: a prompt and no preset has no autopilot", () => {
    const { promptPath } = setup();
    const out = planAgent({ name: "demo", promptPath });
    expect(out.ok && out.agent.autopilot).toBeNull();
  });
});

describe("the card's backup line", () => {
  it("on, with steady: the minutes, the preset, what it does, its exits while it stands by, its spend, and --no-autopilot", () => {
    const { promptPath } = setup();
    const planned = planAgent({ name: "demo", promptPath, preset: "steady" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const card = renderCard(planned.agent);
    expect(card).toContain(BACKUP_ON);
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    expect(card).toContain("Its spend: about 0.012 BNB of buys on a day it trades for the floor, at most 0.018 BNB (3 × 0.006 BNB), each sold again; what it holds counts toward the same 0.15 BNB cap on BNB at work as your agent's own buys.");
    for (const row of ["| buyBnb | 0.006 BNB | default |", "| minDailyTrades | 4 | default |", "| minDailyVolumeBnb | 0.022 BNB | default |", "| maxEntriesPerDay | 3 | default |", "| spacingMinutes | 15 min | default |", "| rushMinutes | 60 min | default |", "| takeProfitPct | 15 % | default |", "| stopLossPct | 10 % | default |", "| timeStopMinutes | 30 min | default |", "| maxPositions | 2 | default |"]) expect(card).toContain(row);
  });

  it("on, with another preset and minutes: it says so, and that it steps back", () => {
    const { promptPath } = setup();
    const planned = planAgent({ name: "demo", promptPath, preset: "momentum", idleMinutes: 45 });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    expect(renderCard(planned.agent)).toContain(
      "Autopilot backup: on. If your agent makes no FL buy or FL sell for 45 min, the momentum preset (Momentum) trades until your agent trades again: it enters coins whose volume and holder count are growing, and exits when that is exhausted. A note or a read does not hold it back. It steps back as soon as your agent trades; positions it opened are then your agent's to manage. --no-autopilot turns it off.",
    );
  });

  it("off: the hard stop-loss only, and the page's floor rule", () => {
    const { promptPath } = setup();
    const planned = planAgent({ name: "demo", promptPath });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    expect(renderCard(planned.agent)).toContain(`Autopilot backup: off (--no-autopilot). Nothing trades on its own except the hard stop-loss (L6), which never sells your own coin. The league page's rule: ${PAGE_IDLE_RULE}.`);
    expect(PAGE_IDLE_RULE).toBe("an agent under the day's activity floor (at least 3 trades and 0.02 BNB of volume, its own coin left out) is eaten at the dinner (the league page's rule as of 2026-10-24)");
  });
});

describe("the entry's backup sentence, en and zh", () => {
  it("on and off, the minutes and the preset from the planned agent", () => {
    expect(copy.autopilotLine({ preset: "steady", idleMinutes: 30 }, "zh")).toBe("autopilot 兜底已开：你 30 分钟不动，它就按 steady 预设交易；`--no-autopilot` 可关。");
    expect(copy.autopilotLine({ preset: "steady", idleMinutes: 30 }, "en")).toBe("Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset; `--no-autopilot` turns it off.");
    expect(copy.autopilotLine({ preset: "momentum", idleMinutes: 45 }, "en")).toBe("Autopilot backup is on: if you make no trade for 45 minutes, it trades by the momentum preset; `--no-autopilot` turns it off.");
    expect(copy.autopilotLine(null, "zh")).toBe("autopilot 兜底已关：除了硬止损，只有你的 agent 自己交易；去掉 `--no-autopilot` 重新规划即可再开。");
    expect(copy.autopilotLine(null, "en")).toBe("Autopilot backup is off: only your agent trades, besides the hard stop-loss; plan again without `--no-autopilot` to turn it back on.");
  });

  it("the You're in line carries it", () => {
    const opens = { kind: "at" as const, at: Date.parse("2026-10-27T13:00:00Z") };
    expect(copy.doneRunning("maplegrin", opens, "en", { preset: "steady", idleMinutes: 30 })).toBe(
      "You're in, and maplegrin is running: it waits for the season and trades from the season's start, Tue 10/27 21:00 UTC+8. Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset; `--no-autopilot` turns it off. Nobody is asked on a timer: to decide with your AI, run `FL ask maplegrin --print`, answer the pack with one JSON object, and hand it over with `FL answer maplegrin '<the JSON object>'`. Keep this machine awake for the season (or run it on a server or cloud computer); if it sleeps, your agent stops and gets eaten. If it stops, run `FL start maplegrin`. A changed strategy.md needs `FL start maplegrin --prompt strategy.md`, its new card and your yes.",
    );
    expect(copy.doneRunning("maplegrin", opens, "zh", null)).toContain("autopilot 兜底已关：除了硬止损，只有你的 agent 自己交易；去掉 `--no-autopilot` 重新规划即可再开。");
  });
});

describe("agents planned before league-v5", () => {
  it("one confirmed without an autopilot restarts without one; planned again it shows the new card and needs the yes", () => {
    const { home, promptPath } = setup();
    const old = planAgent({ name: "demo", promptPath });
    if (!old.ok) throw new Error(old.errors.join("; "));
    saveAgent(home, confirmAgent(old.agent));
    const restart = prepareStart(home, "demo", { plan: null, yes: false, confirm: true });
    expect(restart).toMatchObject({ kind: "ready", replanned: false });
    expect(loadAgent(home, "demo")).toMatchObject({ preset: null, autopilot: null });
    const choice = autopilotChoice({});
    const plan: PlanInput = { name: "demo", promptPath, preset: choice.ok ? choice.preset : undefined };
    const again = prepareStart(home, "demo", { plan, yes: false, confirm: true });
    expect(again.kind).toBe("needs-yes");
    expect(again.kind === "needs-yes" && again.card).toContain("Autopilot backup: on.");
    expect(loadAgent(home, "demo")).toMatchObject({ preset: "steady", autopilot: { idleMinutes: 30 }, confirmed: null });
  });
});

describe("addendum 2: the default card never says nothing trades", () => {
  it("planned as FL start --prompt plans it, the card names the preset and its minutes, and no 'none'", () => {
    const { promptPath } = setup();
    const choice = autopilotChoice({});
    const planned = planAgent({ name: "demo", promptPath, preset: choice.ok ? choice.preset : undefined });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const card = renderCard(planned.agent);
    expect(card).toContain("Autopilot backup: on. If your agent makes no FL buy or FL sell for 30 min, the steady preset");
    expect(card).not.toMatch(/Autopilot: none|Nothing trades on its own/);
  });
});
