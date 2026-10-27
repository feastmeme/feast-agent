import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { goldenRun, shapeOf } from "./golden.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/**
 * Task 975, addendum 5: `FL data --json`'s shape, pinned. A change to it is deliberate: regenerate
 * `golden-data-shape.json` from `golden.ts`'s run and say so in the CHANGELOG.
 */

describe("FL data --json, the golden shape", () => {
  it("every key and the type of its value, nested, on a world with every new field in it", async () => {
    const { home, out } = await goldenRun();
    try {
      const golden = JSON.parse(readFileSync(join(import.meta.dirname, "golden-data-shape.json"), "utf8")) as unknown;
      expect(shapeOf(JSON.parse(JSON.stringify(out.data)))).toEqual(golden);
      const data = out.data as Record<string, any>;
      expect(data.problems).toEqual([]);
      // The figures behind the shape, spot-checked.
      expect(data.self.wallet).toEqual({ balanceBnb: 0.05, gasReserveBnb: 0.003, spendableBnb: 0.047 });
      expect(data.self.positions[0]).toMatchObject({ pnlPct: expect.closeTo(16.67, 1), exitImpactPct: 1.5 });
      expect(data.self.recentFills[0]).toMatchObject({ side: "buy", slippagePct: 1, gasBnb: 0.0001 });
      expect(data.coins[0]).toMatchObject({ type: "bnb", quoteSymbol: "WBNB", flow2m: { buys: 1, buyBnb: 0.01 }, picked: true });
      expect(data.market).toMatchObject({ coinsTotal: 9, coinsOmitted: 8, ageSeconds: 5 });
      expect(data.league.standing).toMatchObject({ rank: 1, alive: 1 });
      expect(data.league.rules.map((r: { rule: string }) => r.rule)).toEqual(["floor", "dinner", "drop", "prizes", "cap"]);
      expect(data.requests.thisCall).toBeLessThanOrEqual(30);
      // Run 26 (items 6, 16): the pit, the league players' trades and their 15-minute count, in --json and in the text.
      expect(data.pit).toMatchObject({ label: "C01 0x0000…0d01", symbol: { untrusted: true, text: "C01" }, leagueTrades15m: 1 });
      expect(data.players).toEqual([expect.objectContaining({ who: "you", side: "buy", bnb: 0.01, rank: null })]);
      expect(data.leagueTrades15m).toBe(1);
      expect(data.untrusted).toEqual(expect.arrayContaining(["pit.symbol", "pit.name", "players[].who", "players[].symbol"]));
      expect(out.text.split("\n")[0]).toMatch(/^The pit: C01 0x0000…0d01 \(not in this pack's coins list; price [\d.e-]+ BNB; impact of a 0\.01 BNB buy \?; league trades in the pit in the last 15 min: 1\)$/);
      expect(out.text).toContain("League players' trades, last 15 min (newest first; names are other players' words):\n  you bought C01 0x0000…0d01 0.01 BNB");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
