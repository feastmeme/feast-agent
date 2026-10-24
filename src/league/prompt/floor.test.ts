import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentPaths, appendJsonl, writeJsonAtomic } from "../store.ts";
import { dayCount, dayLine, dayView, leftOut, nextDinner } from "./floor.ts";

/**
 * The day's count (task 975): dinner to dinner (21:00 UTC+8 = 13:00 UTC), every buy and every sale one trade, their
 * BNB the volume, the agent's own coin left out and FEAST counted (addendum 7: as the settlement engine counts it),
 * read from the agent's own log.
 */

const OWN = "0x00000000000000000000000000000000000b0d1e";
const FEAST = "0x000000000000000000000000000000000000fea5";
const C1 = "0x00000000000000000000000000000000000c0e01";
const C2 = "0x00000000000000000000000000000000000c0e02";
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const MIN = 60_000;
const WEI = (bnb: number) => String(BigInt(Math.round(bnb * 1e9)) * 10n ** 9n);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-floor-"));
  dirs.push(dir);
  return dir;
}
const log = (h: string, at: number, event: string, fields: Record<string, unknown> = {}) => appendJsonl(agentPaths(h, "demo").log, { at: new Date(at).toISOString(), event, ...fields });

describe("nextDinner: the first 13:00 UTC strictly after now", () => {
  it("just before, at and after the dinner", () => {
    expect(nextDinner(DINNER - 1)).toBe(DINNER);
    expect(nextDinner(DINNER)).toBe(DINNER + 24 * 60 * MIN);
    expect(nextDinner(DINNER + 1)).toBe(DINNER + 24 * 60 * MIN);
    expect(nextDinner(Date.parse("2026-10-29T00:00:00Z"))).toBe(DINNER);
    // 21:00 UTC+8 across a month's end.
    expect(new Date(nextDinner(Date.parse("2026-11-02T13:30:00Z"))).toISOString()).toBe("2026-11-03T13:00:00.000Z");
  });
});

describe("dayCount", () => {
  it("a buy and a sale are one trade each, their BNB the volume; the own coin left out, a FEAST fill counted; refusals, failures and intents not counted", () => {
    const h = home();
    const t = DINNER - 5 * 60 * MIN;
    log(h, t, "intent.queued", { kind: "buy", coin: C1, bnb: 0.006 });
    log(h, t + 1, "buy.filled", { coin: C1, bnbInWei: WEI(0.006) });
    log(h, t + 2, "intent.refused", { kind: "buy", limit: "L12" });
    log(h, t + 3, "intent.failed", { kind: "sell", stage: "prepare" });
    log(h, t + 4, "buy.filled", { coin: OWN, bnbInWei: WEI(0.01) });
    log(h, t + 5, "buy.filled", { coin: FEAST, bnbInWei: WEI(0.01) });
    log(h, t + 30 * MIN, "sell.filled", { coin: C1, bnbOutWei: WEI(0.00588) });
    const count = dayCount(h, "demo", t + 31 * MIN, leftOut(h, OWN));
    expect(count).toMatchObject({ startsAt: DINNER - 24 * 60 * MIN, endsAt: DINNER, trades: 3, passed: true });
    expect(count.volumeBnb).toBeCloseTo(0.02188, 9);
  });

  it("a late fill counts by its coin; a fill with no coin is not counted; yesterday's fills are not counted", () => {
    const h = home();
    log(h, DINNER - 24 * 60 * MIN - 1, "buy.filled", { coin: C1, bnbInWei: WEI(0.01) });
    log(h, DINNER - 60 * MIN, "buy.filled", { late: true, coin: C2, bnbInWei: WEI(0.006) });
    log(h, DINNER - 50 * MIN, "sell.filled", { late: true, bnbOutWei: WEI(0.006) });
    // A line after `now` is not counted (a count is of what has happened).
    log(h, DINNER - 5 * MIN, "buy.filled", { coin: C1, bnbInWei: WEI(0.006) });
    const count = dayCount(h, "demo", DINNER - 10 * MIN, []);
    expect(count.trades).toBe(1);
    expect(count.volumeBnb).toBeCloseTo(0.006, 9);
  });

  it("passes at 3 trades and 0.02 BNB; the next day starts at 21:00 UTC+8 from nothing", () => {
    const h = home();
    const t = DINNER - 3 * 60 * MIN;
    log(h, t, "buy.filled", { coin: C1, bnbInWei: WEI(0.006) });
    log(h, t + 15 * MIN, "buy.filled", { coin: C2, bnbInWei: WEI(0.006) });
    log(h, t + 30 * MIN, "sell.filled", { coin: C1, bnbOutWei: WEI(0.00588) });
    expect(dayCount(h, "demo", t + 31 * MIN, []).passed).toBe(false);
    log(h, t + 45 * MIN, "sell.filled", { coin: C2, bnbOutWei: WEI(0.00588) });
    const passed = dayCount(h, "demo", t + 46 * MIN, []);
    expect(passed).toMatchObject({ trades: 4, passed: true });
    expect(passed.volumeBnb).toBeCloseTo(0.02376, 9);
    expect(dayCount(h, "demo", DINNER, [])).toMatchObject({ startsAt: DINNER, trades: 0, passed: false });
  });

  it("a restart mid-day keeps the count: it is the log's, not the runtime's memory", () => {
    const h = home();
    log(h, DINNER - 2 * 60 * MIN, "buy.filled", { coin: C1, bnbInWei: WEI(0.006) });
    log(h, DINNER - 2 * 60 * MIN + 1, "started", { track: "prompt" });
    log(h, DINNER - 60 * MIN, "sell.filled", { coin: C1, bnbOutWei: WEI(0.006) });
    expect(dayCount(h, "demo", DINNER - 1, []).trades).toBe(2);
  });

  it("leftOut: the agent's launch and FL enter's coin, lowercase; never FEAST", () => {
    const h = home();
    writeJsonAtomic(join(agentPaths(h, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: OWN.toUpperCase().replace("0X", "0x"), launchTx: null });
    expect([...leftOut(h, null)]).toEqual([OWN]);
    expect([...leftOut(h, C2)].sort()).toEqual([OWN, C2].sort());
    expect(leftOut(h, null).has(FEAST)).toBe(false);
  });

  it("addendum 7: FEAST alone meets the floor, as the settlement engine counts it", () => {
    const h = home();
    const t = DINNER - 3 * 60 * MIN;
    log(h, t, "buy.filled", { coin: FEAST, bnbInWei: WEI(0.01) });
    log(h, t + 15 * MIN, "sell.filled", { coin: FEAST, bnbOutWei: WEI(0.0098) });
    log(h, t + 30 * MIN, "buy.filled", { coin: FEAST, bnbInWei: WEI(0.006) });
    expect(dayCount(h, "demo", t + 31 * MIN, leftOut(h, OWN))).toMatchObject({ trades: 3, passed: true });
  });

  it("its view and its line", () => {
    const h = home();
    log(h, DINNER - 2 * 60 * MIN, "buy.filled", { coin: C1, bnbInWei: WEI(0.006) });
    const view = dayView(dayCount(h, "demo", DINNER - 72 * MIN, []));
    expect(view).toEqual({ startsAt: "2026-10-28T13:00:00.000Z", endsAt: "2026-10-29T13:00:00.000Z", trades: 1, volumeBnb: 0.006, floor: { trades: 3, volumeBnb: 0.02 }, passed: false });
    expect(dayLine(view, DINNER - 72 * MIN)).toBe("today: 1 trade, 0.006 BNB of volume (the floor: 3 and 0.02 BNB, own coin left out): not yet; dinner at 21:00 UTC+8, in 1 h 12 min");
  });
});
