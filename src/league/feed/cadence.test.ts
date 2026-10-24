import { describe, expect, it } from "vitest";

import { cadenceLine, nextSlowRead, pollCadence } from "./cadence.ts";

/** Task 975, addendum 6: poll by need. The selection, pinned. */

const DINNER = Date.parse("2026-10-31T13:00:00Z");
const MIN = 60_000;

describe("the cadence", () => {
  it("fast while it holds, within a minute of a fill, in the last 30 minutes before dinner; slow otherwise", () => {
    const at = DINNER - 3 * 60 * MIN;
    expect(pollCadence({ now: at, positions: 1, lastFillAt: null, dinnerAt: DINNER })).toEqual({ mode: "fast", why: "positions have stops" });
    expect(pollCadence({ now: at, positions: 0, lastFillAt: at - 30_000, dinnerAt: DINNER })).toEqual({ mode: "fast", why: "a fill in the last minute" });
    expect(pollCadence({ now: at, positions: 0, lastFillAt: at - 61_000, dinnerAt: DINNER })).toEqual({ mode: "slow", why: "nothing to watch closely" });
    expect(pollCadence({ now: DINNER - 30 * MIN, positions: 0, lastFillAt: null, dinnerAt: DINNER })).toEqual({ mode: "fast", why: "the last 30 minutes before dinner" });
    expect(pollCadence({ now: DINNER - 31 * MIN, positions: 0, lastFillAt: null, dinnerAt: DINNER }).mode).toBe("slow");
  });

  it("a slow read comes 30–60 s later, jittered", () => {
    expect(nextSlowRead(0, () => 0)).toBe(30_000);
    expect(nextSlowRead(0, () => 0.999)).toBeLessThan(60_000);
  });

  it("what FL status says", () => {
    expect(cadenceLine({ mode: "slow", why: "nothing to watch closely", fastSeconds: "5–8", at: "x" })).toBe("watching every 30–60 s; fast mode (every 5–8 s) while positions have stops, within a minute of a fill, and in the last 30 minutes before dinner");
    expect(cadenceLine({ mode: "fast", why: "positions have stops", fastSeconds: "5–8", at: "x" })).toBe("watching every 5–8 s now: positions have stops; every 30–60 s otherwise");
    expect(cadenceLine(null)).toBeNull();
  });
});
