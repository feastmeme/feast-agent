import { describe, expect, it } from "vitest";

import * as copy from "../enter/copy.ts";
import { closingLine } from "../season-card.ts";
import { parseLeague } from "../register/site.ts";
import { leagueWire } from "../register/fakes.ts";

/**
 * Task 975, addendum 4: the three facts, said the same way on the entry's card, in the "You're in" line (before and
 * after the season starts, en and zh) and in FL status: every N minutes it asks your AI; if it can't be reached, or
 * the floor is unmet 20 minutes before dinner, it keeps the floor itself; keep this machine awake.
 */

const ASK = { preset: "steady", idleMinutes: 30, ask: { every: 5, with: "claude" } };
const EN = "Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.";
const ZH = "它每 5 分钟问一次你的 Claude Code 该做什么（你自己没在交易的时候）；Claude Code 联系不上，或开饭前 20 分钟当天活动门槛还没达到，它就自己守住门槛。";

describe("the ask loop's sentences", () => {
  it("the three facts, word for word, en and zh; Codex named as Codex; a host asked by nobody keeps the v5 sentence", () => {
    expect(copy.autopilotLine(ASK, "en")).toBe(EN);
    expect(copy.autopilotLine(ASK, "zh")).toBe(ZH);
    expect(copy.autopilotLine({ ...ASK, ask: { every: 15, with: "codex" } }, "en")).toBe("Every 15 minutes it asks your Codex what to do (while you are not trading yourself); if Codex can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.");
    expect(copy.autopilotLine({ ...ASK, ask: { every: 5, with: "none" } }, "en")).toBe("Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset; `--no-autopilot` turns it off.");
  });

  it("the You're in line, before and after the season starts: the three facts, then keep this machine awake", () => {
    const before = { kind: "at" as const, at: Date.parse("2026-10-26T12:00:00Z") };
    for (const [lang, facts] of [["en", EN], ["zh", ZH]] as const) {
      for (const opens of [before, { kind: "open" as const }]) {
        const line = copy.doneRunning("maplegrin", opens, lang, ASK);
        expect(line, `${lang} ${opens.kind}`).toContain(`${facts}${lang === "en" ? " " : ""}${copy.awakeLine(lang)}`);
      }
    }
    expect(copy.doneRunning("maplegrin", { kind: "open" }, "en", ASK).endsWith("The season is on. Decide and trade now by strategy.md; if you go quiet for 5 minutes, the runtime asks your Claude Code what to do.")).toBe(true);
    expect(copy.doneRunning("maplegrin", { kind: "open" }, "zh", ASK).endsWith("赛季已经开始。现在就按 strategy.md 决策和交易；你 5 分钟不动，运行时就去问你的 Claude Code 该做什么。")).toBe(true);
    expect(copy.waitingLine({ kind: "open" }, "en", ASK)).toBe("The season is on: it starts trading now (it asks your Claude Code in 5 minutes if you go quiet).");
  });

  it("the status card's last line says what happens, before the season and in it", () => {
    const read = (state: "season" | "warm-up") => parseLeague(leagueWire({ state, season: { number: 1, day: state === "season" ? 2 : null, countdownTo: "2026-10-27T13:00:00.000Z" } }))!;
    const agent = { track: "prompt", autopilot: ASK, promptFile: "strategy.md" };
    expect(closingLine({ today: read("warm-up"), agent }, "en")).toBe("Whatever the league says, the league never stops your agent: your AI decides by strategy.md; every 5 minutes without its trade the runtime asks Claude Code, and the floor keeper (steady) covers it when Claude Code can't be reached or the floor is unmet 20 minutes before dinner.");
    expect(closingLine({ today: read("season"), agent }, "en")).toBe("The season is on. Decide and trade now by strategy.md; if you go quiet for 5 minutes, the runtime asks your Claude Code what to do.");
  });
});
