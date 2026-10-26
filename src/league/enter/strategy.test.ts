import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DEFAULT_STRATEGY_TITLE, PERSONAS, PERSONA_TEXT, defaultPersonaOf, defaultStrategy, defaultStrategyVariants, personaOf } from "./strategy.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/** Task 1020: the season-1 default strategy v1.1 and its six styles. Made-up Agent IDs. */

describe("the default's six styles", () => {
  it("PERSONAS is in the ruling's order", () => {
    expect(PERSONAS).toEqual(["momentum", "dip", "contrarian", "follower", "hunter", "closer"]);
    expect(DEFAULT_STRATEGY_TITLE).toEqual({ en: "Season-1 default strategy v1.1", zh: "第一季默认策略 v1.1" });
  });

  it("each style renders in both languages, in place of <persona>, with the Agent ID in place of <id>", () => {
    for (const persona of PERSONAS) {
      const en = defaultStrategy("maplegrin", "en", persona);
      const zh = defaultStrategy("maplegrin", "zh", persona);
      expect(en.split("\n")[0]).toBe("# Season-1 default strategy v1.1");
      expect(zh.split("\n")[0]).toBe("# 第一季默认策略 v1.1");
      expect(en).toContain(`\nYour style: ${PERSONA_TEXT[persona].en}\n`);
      expect(zh).toContain(`\n你的风格：${PERSONA_TEXT[persona].zh}\n`);
      for (const text of [en, zh]) {
        expect(text).toContain("maplegrin.ai");
        expect(text).not.toMatch(/<id>|<persona>/);
      }
    }
  });

  it("the same name always gets the same style: the first byte of the sha256 of the bare lowercased name, modulo six", () => {
    for (const name of ["maplegrin", "noodle7", "a", "zz-top", "feastbot"]) {
      const expected = PERSONAS[createHash("sha256").update(name).digest()[0]! % 6];
      expect(personaOf(name)).toBe(expected);
      expect(personaOf(`${name}.ai`)).toBe(expected);
      expect(personaOf(`${name.toUpperCase()}.AI`)).toBe(expected);
      expect(defaultStrategy(name, "en")).toBe(defaultStrategy(name, "en", expected));
    }
    // Every style is reachable.
    const seen = new Set(Array.from({ length: 200 }, (_, i) => personaOf(`agent${i}`)));
    expect([...seen].sort()).toEqual([...PERSONAS].sort());
  });

  it("defaultStrategyVariants: the six English renderings, in PERSONAS' order; a copy is told by its text", () => {
    const variants = defaultStrategyVariants("maplegrin");
    expect(variants).toHaveLength(6);
    expect(new Set(variants).size).toBe(6);
    variants.forEach((text, i) => {
      expect(text).toBe(defaultStrategy("maplegrin", "en", PERSONAS[i]));
      expect(defaultPersonaOf(text, "maplegrin")).toBe(PERSONAS[i]);
    });
    expect(defaultPersonaOf(defaultStrategy("maplegrin", "zh", "hunter"), "maplegrin")).toBe("hunter");
    expect(defaultPersonaOf(`${variants[0]} `, "maplegrin")).toBeNull();
  });
});
