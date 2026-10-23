import { describe, expect, it } from "vitest";

import { leagueWire } from "./register/fakes.ts";
import { parseLeague, type Seating } from "./register/site.ts";
import { battleCardLines, standingLines } from "./season-card.ts";

const now = Date.parse("2026-10-22T13:05:00Z");
const founding: Seating = { kind: "seated", seatNo: 61, founding: true, foundingNo: 42, waitlisted: false, place: null };
const row = (over = {}) => ({ rank: 12, wallet: "0xab", name: "maplegrin", pnlUsd: 3.2, realizedUsd: 3, unrealizedUsd: 0.2, trades: 7, hp: 6, unpriced: false, earlyBird: false, founding: true, foundingNo: 42, seatNo: 61, eatenDay: null, ...over });
const inSeason = (over = {}) => parseLeague(leagueWire({ state: "season", season: { number: 1, day: 3, countdownTo: "2026-10-22T18:17:00.000Z" }, ...over }));

describe("the league in the status card (PLAN-941 §6)", () => {
  it("in season: the day, the seat, the ranks today and this season, and that the preset runs regardless", () => {
    const today = inSeason({ boards: { earners: [row()], backed: [{ ...row(), rank: 40 }] }, counts: { earners: 140, backed: 90 } });
    const season = inSeason({ boards: { earners: [row({ rank: 20 })], backed: [{ ...row(), rank: 33 }] }, counts: { earners: 150, backed: 95 } });
    expect(standingLines({ agentId: "maplegrin", seating: founding, today, season, now }, "en")).toEqual([
      "League · Season 1, day 3 of 7 · next dinner in 5 h 12 min (21:00 UTC+8)",
      "maplegrin.ai · seat 61 of 1,000 · founding seat #42",
      "Top earners today: #12 of 140 (+3.20 USDT, 7 trades). Most backed today: #40 (HP 6).",
      "Season so far, Top earners: #20 of 150 (+3.20 USDT, 7 trades). Most backed: #33 (HP 6).",
      "Your agent runs its preset whatever the league says.",
    ]);
    expect(standingLines({ agentId: "maplegrin", seating: founding, today, season, now }, "zh")[2]).toBe("今日最赚钱：第 12 名（共 140，+3.20 USDT，7 笔）。今日最多人押：第 40 名（血量 6）。");
  });

  it("eaten: out of this season's prizes, its coin trading, the agent running, the next season open", () => {
    const today = inSeason({ boards: { earners: [row({ rank: null, eatenDay: 2 })], backed: [] }, counts: { earners: 140, backed: 0 } });
    const lines = standingLines({ agentId: "maplegrin", seating: founding, today, season: null, now }, "en");
    expect(lines[2]).toBe("Eaten at dinner on day 2: out of this season's prizes. Its coin keeps trading, your agent keeps running its preset, and it can enter the next season.");
    expect(lines).toHaveLength(4);
  });

  it("reads its own rows from the page's me row, past the top 100, eaten included", () => {
    const today = inSeason({ boards: { earners: [], backed: [] }, counts: { earners: 400, backed: 300 }, me: { wallet: "0xab", earners: row({ rank: 250 }), backed: null, eaten: null } });
    expect(standingLines({ agentId: "maplegrin", seating: founding, today, season: null, now }, "en")[2]).toBe("Top earners today: #250 of 400 (+3.20 USDT, 7 trades).");
    const eaten = inSeason({ me: { wallet: "0xab", earners: null, backed: null, eaten: { day: 4, reason: "idle" } } });
    expect(standingLines({ agentId: "maplegrin", seating: founding, today: eaten, season: null, now }, "zh")[2]).toMatch(/^第 4 天开饭时被吃掉了/);
  });

  it("without a me row: outside the top 100, or not ranked yet", () => {
    const cut = inSeason({ boards: { earners: [row({ name: "other" })], backed: [] }, counts: { earners: 400, backed: 0 } });
    expect(standingLines({ agentId: "maplegrin", seating: founding, today: cut, season: null, now }, "en")[2]).toBe("Outside the top 100 on Top earners.");
    const few = inSeason({ boards: { earners: [], backed: [] }, counts: { earners: 0, backed: 0 } });
    expect(standingLines({ agentId: "maplegrin", seating: founding, today: few, season: null, now }, "en")[2]).toBe("Not on Top earners yet: an agent needs 5 trades in the day.");
  });

  it("before the season and in warm-up, and when not registered or not readable", () => {
    const soon = parseLeague(leagueWire());
    expect(standingLines({ agentId: "maplegrin", seating: founding, today: soon, season: null, now }, "en")).toEqual(["League · Season 1 · coming soon", "maplegrin.ai · seat 61 of 1,000 · founding seat #42", "Your agent runs its preset whatever the league says."]);
    const warm = parseLeague(leagueWire({ state: "warm-up", boards: { earners: [row({ rank: 3 })], backed: [] }, counts: { earners: 30, backed: 0 } }));
    expect(standingLines({ agentId: "maplegrin", seating: founding, today: warm, season: null, now }, "en")).toContain("Warm-up ranks don't pay and don't eat.");
    expect(standingLines({ agentId: null, seating: null, today: soon, season: null, now }, "zh")).toEqual(["联赛 · 第 1 季 · 即将开赛", "还没报名联赛。说「报名」即可参加。", "不管联赛怎样，你的 agent 都照常跑它的策略。"]);
    expect(standingLines({ agentId: "maplegrin", seating: { kind: "seated", seatNo: 1_012, founding: false, foundingNo: null, waitlisted: true, place: 12 }, today: null, season: null, now }, "en")).toEqual([
      "League · The league couldn't be read just now. Your agent isn't affected.",
      "maplegrin.ai · waitlist, place 12",
      "Your agent runs its preset whatever the league says.",
    ]);
  });
});

describe("the daily battle card (the owner's ruling, 2026-10-24)", () => {
  it("in season: the agent's card for today, and one line to post it; nothing posted for the user", () => {
    expect(battleCardLines("https://feast.meme", "maplegrin", 3, "en")).toEqual(["Battle card: https://feast.meme/league/agent/maplegrin/card?day=3", "Post it on X today to be in tonight's airdrop"]);
    expect(battleCardLines("https://feast.meme", "maplegrin", 3, "zh")).toEqual(["今日战报卡：https://feast.meme/league/agent/maplegrin/card?day=3", "今天把它发到 X 上，就能参加今晚的空投"]);
    const today = inSeason({ boards: { earners: [row()], backed: [] }, counts: { earners: 140, backed: 0 } });
    const lines = standingLines({ agentId: "maplegrin", seating: founding, today, season: null, now, site: "https://feast.meme" }, "en");
    expect(lines.slice(-3)).toEqual(["Battle card: https://feast.meme/league/agent/maplegrin/card?day=3", "Post it on X today to be in tonight's airdrop", "Your agent runs its preset whatever the league says."]);
  });

  it("only in season, only for an Agent ID that is one; an entry by FL enter alone is enough", () => {
    expect(battleCardLines("https://feast.meme", "Maple Grin/../x", 3, "en")).toEqual([]);
    expect(battleCardLines("https://feast.meme", "maplegrin", 0, "en")).toEqual([]);
    const warm = parseLeague(leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: "2026-10-26T12:00:00.000Z" } }));
    expect(standingLines({ agentId: "maplegrin", seating: founding, today: warm, season: null, now, site: "https://feast.meme" }, "en").join("\n")).not.toContain("Battle card");
    const today = inSeason({ boards: { earners: [], backed: [] }, counts: { earners: 0, backed: 0 } });
    const entered = standingLines({ agentId: "maplegrin", seating: null, entered: true, today, season: null, now, site: "https://feast.meme" }, "en");
    expect(entered).toContain("maplegrin.ai · entered with FL enter");
    expect(entered).toContain("Battle card: https://feast.meme/league/agent/maplegrin/card?day=3");
    expect(entered.join("\n")).not.toContain('Say "register"');
  });
});

