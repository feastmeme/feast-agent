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
 * The reward's phrasings, and the step-1 open time that only mattered for it.
 */
const REWARD = [/USDT worth/i, /worth of FEAST/i, /hold it/i, /held 24/i, /\b72 ?h\b/i, /\bearns?\b/i, /\breward/i, /\bseats?\b/i, /Step 1 opens/i, /does not count/i, /拿住/, /持有/, /等值/, /奖励/, /席位/, /第 1 步在/, /不算数/];

describe("the entry's copy promises no reward", () => {
  it("no reward sentence anywhere in the copy module", () => {
    for (const pattern of REWARD) expect(SOURCE, String(pattern)).not.toMatch(pattern);
  });

  it("after the launch, one line: you're in, and the prompt-mode command (the owner's ruling, 2026-10-24)", () => {
    expect(copy.doneLine("en")).toBe("You're in. Write your strategy.md and run `FL start <name> --prompt strategy.md`");
    expect(copy.doneLine("zh")).toBe("你已报名。写好你的 strategy.md，然后运行 `FL start <name> --prompt strategy.md`");
    for (const lang of ["en", "zh"] as const) {
      const entered = copy.alreadyEntered({ agentId: "maplegrin", coin: "0x00000000000000000000000000000000000b0d1e", notes: "open" }, lang);
      expect(entered.split("\n").at(-1)).toBe(copy.doneLine(lang));
      for (const pattern of REWARD) expect(entered).not.toMatch(pattern);
    }
  });

  it("the entry no longer buys: no buy card, no today's coin, in either language", () => {
    expect(SOURCE).not.toMatch(/buyCard|today's coin|今天的币|assignment/);
  });
});
