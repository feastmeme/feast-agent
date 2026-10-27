import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, loadAgent, planAgent, saveAgent } from "../agent.ts";
import { prepareStart } from "../start.ts";

import { DEFAULT_STRATEGY_TITLE, NO_PIT, PERSONAS, PERSONA_TEXT, SMALL_ARENA_SEATS, defaultPersonaOf, defaultStrategy, defaultStrategyVariants, matchDefault, personaOf } from "./strategy.ts";

// owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits

/** Task 1020: the season-1 default strategy and its styles (v1.1: six; run 26, v1.3: seven, and the pit). Made-up Agent IDs. */

const FIXTURE_PIT = "PITCOIN 0x0000…be11";

describe("the default's seven styles", () => {
  it("PERSONAS is in the ruling's order, the seventh last", () => {
    expect(PERSONAS).toEqual(["momentum", "dip", "contrarian", "follower", "hunter", "closer", "instigator"]);
    expect(DEFAULT_STRATEGY_TITLE).toEqual({ en: "Season-1 default strategy v1.3", zh: "第一季默认策略 v1.3" });
  });

  it("each style renders in both languages, in place of <persona>, with the Agent ID in place of <id> and the pit in place of <pit>", () => {
    for (const persona of PERSONAS) {
      const en = defaultStrategy("maplegrin", "en", persona, FIXTURE_PIT);
      const zh = defaultStrategy("maplegrin", "zh", persona, FIXTURE_PIT);
      expect(en.split("\n")[0]).toBe("# Season-1 default strategy v1.3");
      expect(zh.split("\n")[0]).toBe("# 第一季默认策略 v1.3");
      expect(en).toContain(`\nYour style: ${PERSONA_TEXT[persona].en}\n`);
      expect(zh).toContain(`\n你的风格：${PERSONA_TEXT[persona].zh}\n`);
      expect(en).toContain(`the coin ${FIXTURE_PIT}, named`);
      expect(zh).toContain(`擂台币 ${FIXTURE_PIT}，`);
      for (const text of [en, zh]) {
        expect(text).toContain("maplegrin.ai");
        expect(text).not.toMatch(/<id>|<persona>|<pit>/);
        expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
      }
    }
  });

  it("no pit at entry: en 'still to be launched', zh '（待发）'", () => {
    expect(defaultStrategy("maplegrin", "en", "dip")).toContain("the coin still to be launched, named");
    expect(defaultStrategy("maplegrin", "zh", "dip")).toContain("擂台币 （待发），");
    expect(NO_PIT).toEqual({ en: "still to be launched", zh: "（待发）" });
  });

  it("the same name always gets the same style: the first byte of the sha256 of the bare lowercased name, modulo six, in a full arena", () => {
    for (const name of ["maplegrin", "noodle7", "a", "zz-top", "feastbot"]) {
      const expected = PERSONAS[createHash("sha256").update(name).digest()[0]! % 6];
      expect(personaOf(name)).toBe(expected);
      expect(personaOf(name, 50)).toBe(expected);
      expect(personaOf(`${name}.ai`)).toBe(expected);
      expect(personaOf(`${name.toUpperCase()}.AI`)).toBe(expected);
      expect(defaultStrategy(name, "en")).toBe(defaultStrategy(name, "en", expected));
    }
    // A full arena (or no league read) never picks the seventh; every one of the six is reachable.
    const seen = new Set(Array.from({ length: 200 }, (_, i) => personaOf(`agent${i}`)));
    expect([...seen].sort()).toEqual(PERSONAS.slice(0, 6).sort());
  });

  it("item 11: under 50 seats taken, a hash byte that is a multiple of 3 is instigator; the rest keep their six-way style", () => {
    for (let i = 0; i < 200; i += 1) {
      const name = `agent${i}`;
      const byte = createHash("sha256").update(name).digest()[0]!;
      expect(personaOf(name, 49)).toBe(byte % 3 === 0 ? "instigator" : PERSONAS[byte % 6]);
      expect(personaOf(name, 0)).toBe(personaOf(name, 49));
      expect(personaOf(name, 50)).toBe(PERSONAS[byte % 6]);
    }
    expect(SMALL_ARENA_SEATS).toBe(50);
  });

  it("defaultStrategyVariants: the seven English renderings, in PERSONAS' order; a copy is told by its text, whatever pit it names", () => {
    const variants = defaultStrategyVariants("maplegrin", FIXTURE_PIT);
    expect(variants).toHaveLength(7);
    expect(new Set(variants).size).toBe(7);
    variants.forEach((text, i) => {
      expect(text).toBe(defaultStrategy("maplegrin", "en", PERSONAS[i], FIXTURE_PIT));
      expect(defaultPersonaOf(text, "maplegrin")).toBe(PERSONAS[i]);
    });
    // The pit rendered at entry is not known afterwards: any one line there is still the default.
    expect(defaultPersonaOf(defaultStrategy("maplegrin", "zh", "hunter", "QQ (contract 0x00…01)"), "maplegrin")).toBe("hunter");
    expect(defaultPersonaOf(defaultStrategy("maplegrin", "en", "instigator"), "maplegrin")).toBe("instigator");
    expect(defaultPersonaOf(`${variants[0]} `, "maplegrin")).toBeNull();
    expect(defaultPersonaOf(defaultStrategy("maplegrin", "en", "dip", "A\nB"), "maplegrin")).toBeNull();
    expect(defaultPersonaOf(variants[0]!, "otheragent")).toBeNull();
  });

  it("matchDefault: the whole file, byte for byte, with one line's worth at <pit>", () => {
    expect(matchDefault("a X b", "a <pit> b", "id", "p")).toBe("X");
    expect(matchDefault("a  b", "a <pit> b", "id", "p")).toBeNull();
    expect(matchDefault("a X b!", "a <pit> b", "id", "p")).toBeNull();
    expect(matchDefault("id p", "<id> <persona>", "id", "p")).toBe("");
    expect(matchDefault("id q", "<id> <persona>", "id", "p")).toBeNull();
  });
});

describe("the style stays with the copied text", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("a re-plan with the same prompt keeps it; another prompt, or the copy edited, drops it", () => {
    const dir = mkdtempSync(join(tmpdir(), "feast-league-1020-persona-"));
    dirs.push(dir);
    const home = join(dir, "home");
    const path = join(dir, "strategy.md");
    writeFileSync(path, defaultStrategy("maplegrin", "en"));
    const planned = planAgent({ name: "maplegrin", promptPath: path, preset: "steady" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, { ...confirmAgent(planned.agent), persona: personaOf("maplegrin") });
    // Same prompt, another autopilot idle: a new card, the style kept.
    prepareStart(home, "maplegrin", { plan: { name: "maplegrin", promptPath: path, preset: "steady", idleMinutes: 45 }, yes: false, confirm: true });
    expect(loadAgent(home, "maplegrin")?.persona).toBe(personaOf("maplegrin"));
    // The copy edited: the style no longer names the text.
    writeFileSync(path, "Mine now: only what moves.\n");
    prepareStart(home, "maplegrin", { plan: { name: "maplegrin", promptPath: path, preset: "steady", idleMinutes: 45 }, yes: false, confirm: true });
    expect(loadAgent(home, "maplegrin")?.persona ?? null).toBeNull();
  });
});
