import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as copy from "./copy.ts";

/**
 * The entry reward is cancelled (the coordinator's ruling, 2026-10-23 22:49 SGT),
 * and since the owner's ruling of 2026-10-24 the entry is the launch only, with
 * no buy. No sentence of the entry's copy may promise a reward, in either language.
 */

const SOURCE = readFileSync(join(import.meta.dirname, "copy.ts"), "utf8");
/**
 * The reward's phrasings, and the step-1 open time that only mattered for it. Since task 968 the seat is what
 * feast.meme answers to the entry's Register (the coordinator's ruling C1), not a reward, so the entry names it.
 */
const REWARD = [/USDT worth/i, /worth of FEAST/i, /hold it/i, /held 24/i, /\b72 ?h\b/i, /\bearns?\b/i, /\breward/i, /Step 1 opens/i, /does not count/i, /拿住/, /持有/, /等值/, /奖励/, /第 1 步在/, /不算数/];

describe("the entry's copy promises no reward", () => {
  it("no reward sentence anywhere in the copy module", () => {
    for (const pattern of REWARD) expect(SOURCE, String(pattern)).not.toMatch(pattern);
  });

  it("after the entry, one line: you're in, and the prompt-mode command (the owner's ruling, 2026-10-24)", () => {
    expect(copy.doneLine("en")).toBe("You're in. Write your strategy.md and run `FL start <name> --prompt strategy.md`");
    expect(copy.doneLine("zh")).toBe("你已报名。写好你的 strategy.md，然后运行 `FL start <name> --prompt strategy.md`");
    for (const lang of ["en", "zh"] as const) {
      const entered = copy.alreadyEntered({ agentId: "maplegrin", coin: "0x00000000000000000000000000000000000b0d1e", notes: "open" }, lang);
      for (const pattern of REWARD) expect(entered).not.toMatch(pattern);
      // Task 968: the entry that started the agent ends with it running, and how to restart it.
      const running = copy.doneRunning("maplegrin", { kind: "at", at: Date.parse("2026-10-26T12:00:00Z") }, lang);
      expect(running).toContain("FL start maplegrin");
      for (const pattern of REWARD) expect(running).not.toMatch(pattern);
    }
  });

  it("the autopilot backup's sentence, word for word, in Chinese and English (task 975, the owner's ruling A)", () => {
    expect(copy.autopilotLine({ preset: "steady", idleMinutes: 30 }, "zh")).toBe("autopilot 兜底已开：你 30 分钟不动，它就按 steady 预设交易；`--no-autopilot` 可关。");
    expect(copy.autopilotLine({ preset: "steady", idleMinutes: 30 }, "en")).toBe("Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset; `--no-autopilot` turns it off.");
    for (const lang of ["en", "zh"] as const) for (const pattern of REWARD) expect(copy.autopilotLine(null, lang)).not.toMatch(pattern);
  });

  it("keep the machine awake, in the owner's words (task 975, addendum 3); the You're in line says it in both branches", () => {
    expect(copy.awakeLine("en")).toBe("Keep this machine awake for the season (or run it on a server or cloud computer); if it sleeps, your agent stops and gets eaten.");
    expect(copy.awakeLine("zh")).toBe("赛季期间保持这台电脑不休眠（或放到服务器 / 云电脑上跑）：它一睡，你的 agent 就停，开饭时会被吃掉。");
    for (const lang of ["en", "zh"] as const)
      for (const opens of [{ kind: "at" as const, at: Date.parse("2026-10-26T12:00:00Z") }, { kind: "open" as const }]) {
        const line = copy.doneRunning("maplegrin", opens, lang, { preset: "steady", idleMinutes: 30 });
        expect(line, `${lang} ${opens.kind}`).toContain(copy.awakeLine(lang));
        for (const pattern of REWARD) expect(line).not.toMatch(pattern);
      }
    // Once the season is on, the instruction to trade still ends it (addendum 2).
    expect(copy.doneRunning("maplegrin", { kind: "open" }, "en", { preset: "steady", idleMinutes: 30 }).endsWith("autopilot (steady) takes over.")).toBe(true);
  });

  it("the entry no longer buys: no buy card, no today's coin, in either language", () => {
    expect(SOURCE).not.toMatch(/buyCard|today's coin|今天的币|assignment/);
  });
});
