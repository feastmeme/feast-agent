import { describe, expect, it } from "vitest";

import { leagueWire } from "../register/fakes.ts";
import { fieldRowsOf, LeagueSite } from "../register/site.ts";
import { readStanding } from "./standing.ts";

/**
 * Task 975, addendum 6 (lane 978): the standing from the cached `field=1` board, never the uncached `me=` read
 * unless the site is older. Made-up wallets.
 */

const SITE = "https://feast.test";
const w = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const ME = w(7);
const row = (n: number, pnlBnb: number, over: Record<string, unknown> = {}) => ({ rank: n, name: `agent${n}.ai`, wallet: w(n), pnlBnb, danger: false, eaten: null, bodyCoin: null, hp: 0, ...over });
const wire = (extra: Record<string, unknown> = {}) => ({ ...leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: "2026-10-31T13:00:00.000Z" } }), ...extra });

function site(pages: Record<string, unknown>[], withField = true) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(`${url.pathname}${url.search}`);
    if (url.searchParams.get("field") === "1" && withField) {
      const cursor = url.searchParams.get("cursor");
      return Response.json(pages[cursor ? Number(cursor) : 0]);
    }
    return Response.json(wire());
  }) as typeof fetch;
  return { asked, s: new LeagueSite(SITE, fetchImpl, 1_000) };
}

describe("the field", () => {
  it("parses rows as an array or as field.rows, and the next page's cursor", () => {
    expect(fieldRowsOf({ field: [row(1, 0.01)] })!.rows.map((r) => r.wallet)).toEqual([w(1)]);
    expect(fieldRowsOf({ field: { rows: [row(2, -0.01, { eaten: { day: 2, reason: "drop" } })], next: "1" } })).toMatchObject({ next: "1", rows: [{ eaten: { day: 2, reason: "drop" } }] });
    expect(fieldRowsOf({ arena: { set: [] } })).toBeNull();
  });

  it("follows the pages; the standing comes from it, and nothing asks with me=", async () => {
    const pages = [wire({ field: { rows: Array.from({ length: 6 }, (_, i) => row(i + 1, 0.01 - i * 0.003)), next: "1" } }), wire({ field: { rows: [row(7, -0.02, { danger: true }), row(8, 0.5, { eaten: { day: 1, reason: "idle" } })] } })];
    const { asked, s } = site(pages);
    const got = await readStanding(s, ME);
    expect(asked).toEqual(["/api/league?view=today&field=1&limit=10000", "/api/league?view=today&field=1&limit=10000&cursor=1"]);
    expect(asked.some((a) => a.includes("me="))).toBe(false);
    expect(got.from).toBe("field");
    expect(got.read!.field).toHaveLength(8);
    // 7 alive (agent8 eaten); without trades every living agent is counted over the floor: floor(7/5) = 1 at the bottom.
    expect(got.standing).toMatchObject({ from: "field", alive: 7, rank: 7, pnlBnb: -0.02, gapUpBnb: 0.015, cutoff: { passing: 7, bottom: 1, cutoffPnlBnb: -0.02, me: "drop-zone" } });
    expect(got.standing!.danger.map((d) => d.name.text)).toEqual(["agent7.ai"]);
  });

  it("an older site with no field: the me= read, once, as the fallback", async () => {
    const { asked, s } = site([], false);
    const got = await readStanding(s, ME);
    expect(asked).toEqual(["/api/league?view=today&field=1&limit=10000", `/api/league?view=today&limit=100&me=${ME}`]);
    expect(got.from).toBe("me");
  });
});
