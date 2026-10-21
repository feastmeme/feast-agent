import { describe, expect, it } from "vitest";

import { leagueWire } from "./fakes.ts";
import { parseLeague, parseRegisterAnswer, siteFromEnv } from "./site.ts";

const agent = { wallet: "0xabc", agentId: "maplegrin", name: "maplegrin", manifesto: "m", issuedAt: 1792675500, bodyCoin: null, season: 1, seatNo: 61, waitlisted: false, founding: true, foundingNo: 42 };

describe("the register answer, in every shape (927 API.md run 5, the sealed route, PLAN-v2)", () => {
  it("reads run 5's seating, founding number and place", () => {
    expect(parseRegisterAnswer(201, { agent, seating: { state: "seated", seatNo: 61, waitlisted: false, place: null, founding: true, foundingNo: 42 }, prereg: "matched" })).toMatchObject({
      kind: "kept",
      seating: { kind: "seated", seatNo: 61, founding: true, foundingNo: 42, waitlisted: false, place: null },
      prereg: "matched",
    });
    expect(parseRegisterAnswer(201, { agent, seating: { state: "seated", seatNo: 1_012, waitlisted: true, place: 12, founding: false, foundingNo: null }, prereg: "unclaimed" })).toMatchObject({ seating: { waitlisted: true, place: 12 } });
  });

  it("reads the sealed route's seating, working out the place", () => {
    expect(parseRegisterAnswer(201, { agent, seating: { state: "seated", seatNo: 1_001, founding: false, waitlisted: true }, prereg: "none" })).toMatchObject({ seating: { kind: "seated", place: 1, foundingNo: null }, prereg: "none" });
    expect(parseRegisterAnswer(201, { agent, seating: { state: "pending", reason: "no-body-coin" }, prereg: "unclaimed" })).toMatchObject({ seating: { kind: "pending", reason: "no-body-coin" } });
  });

  it("reads PLAN-v2's seat and pending", () => {
    expect(parseRegisterAnswer(201, { seat: { no: 7, founding: false, waitlisted: false } })).toMatchObject({ kind: "kept", seating: { kind: "seated", seatNo: 7 }, prereg: "unclaimed", agent: null });
    expect(parseRegisterAnswer(201, { pending: "no-agent-id" })).toMatchObject({ seating: { kind: "pending", reason: "no-agent-id" } });
    expect(parseRegisterAnswer(201, { pending: "no-body-coin" })).toMatchObject({ seating: { kind: "pending", reason: "no-body-coin" } });
  });

  it("falls back to the kept agent's own seat, and refuses a 201 with neither", () => {
    expect(parseRegisterAnswer(201, { agent })).toMatchObject({ seating: { kind: "seated", seatNo: 61, founding: true } });
    expect(parseRegisterAnswer(201, {})).toMatchObject({ kind: "no-answer" });
  });

  it("reads each refusal by its code and field, never by its message", () => {
    for (const [status, code] of [
      [400, "invalid-fields"],
      [400, "stale"],
      [400, "no-agent-id"],
      [400, "agent-id-mismatch"],
      [400, "body-coin-not-yours"],
      [401, "bad-signature"],
      [409, "replayed"],
      [409, "name-taken"],
      [429, "rate-limited"],
      [503, "unavailable"],
      [503, "upstream-unavailable"],
      [413, "bad-request"],
      [415, "bad-request"],
    ] as const) {
      expect(parseRegisterAnswer(status, { error: { code, message: "页面的话", field: code === "invalid-fields" ? "bodyCoin" : undefined } })).toEqual({ kind: "refused", status, code, field: code === "invalid-fields" ? "bodyCoin" : null });
    }
    expect(parseRegisterAnswer(429, null)).toMatchObject({ kind: "refused", code: "rate-limited" });
    expect(parseRegisterAnswer(502, null)).toMatchObject({ kind: "refused", code: "unavailable" });
    expect(parseRegisterAnswer(404, { nothing: true })).toMatchObject({ kind: "no-answer" });
  });
});

describe("the league read", () => {
  it("reads v1, which is live before 927 ships, as coming soon", () => {
    expect(parseLeague({ schemaVersion: 1, state: "no-season", season: null })).toMatchObject({ schema: 1, state: "coming-soon", season: { number: 1 } });
  });

  it("reads v2's state, season, seats, boards and counts", () => {
    const read = parseLeague(
      leagueWire({
        state: "season",
        season: { number: 1, day: 3, countdownTo: "2026-10-29T13:00:00.000Z" },
        boards: { earners: [{ rank: 1, wallet: "0xAB", name: "maplegrin", pnlUsd: 3.2, trades: 7, hp: 6, eatenDay: null }], backed: [] },
        counts: { earners: 140, backed: 90 },
      }),
    );
    expect(read).toMatchObject({ schema: 2, state: "season", season: { number: 1, day: 3, countdownTo: Date.parse("2026-10-29T13:00:00.000Z") }, seats: { taken: 412, cap: 1000 }, counts: { earners: 140 } });
    expect(read!.earners[0]).toMatchObject({ rank: 1, wallet: "0xab", name: "maplegrin", pnlUsd: 3.2 });
    expect(read!.me).toBeUndefined();
  });

  it("reads the me row, eaten included", () => {
    const read = parseLeague(leagueWire({ me: { wallet: "0xab", earners: null, backed: { rank: 40, wallet: "0xab", name: "maplegrin", hp: 6, eatenDay: 2 }, eaten: { day: 2, reason: "drop" } } }));
    expect(read!.me).toEqual({ earners: null, backed: { rank: 40, wallet: "0xab", name: "maplegrin", hp: 6, eatenDay: 2 }, eaten: { day: 2, reason: "drop" } });
    expect(parseLeague(leagueWire({ me: null }))!.me).toBeNull();
  });

  it("refuses what is not the league", () => {
    expect(parseLeague({ schemaVersion: 3 })).toBeNull();
    expect(parseLeague(leagueWire({ state: "party" }))).toBeNull();
    expect(parseLeague("nope")).toBeNull();
  });

  it("talks to feast.meme unless told otherwise", () => {
    expect(siteFromEnv({})).toBe("https://feast.meme");
    expect(siteFromEnv({ FEAST_LEAGUE_SITE: "http://127.0.0.1:3000/" })).toBe("http://127.0.0.1:3000");
  });
});
