import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, loadAgent, planAgent, saveAgent } from "../agent.ts";
import { promptChanged } from "../prompt/host.ts";
import { prepareStart } from "../start.ts";
import { keepPit } from "../support.ts";
import { migrateDefault, migrationLine, readMigration, restoreDefault, shippedDefaultOf } from "./migrate.ts";
import { SHIPPED_DEFAULTS } from "./shipped.ts";
import { DEFAULT_STRATEGY_VERSION, defaultStrategy, personaOf, type PersonaKey } from "./strategy.ts";

/** Run 26, amendment C: unedited earlier defaults move to v1.3 on start; edited ones never. Made-up names and addresses. */

const ID = "maplegrin";
const PIT = { coin: `0x${"0".repeat(36)}be11`, symbol: "PITCOIN", name: "Pit Coin", quote: `0x${"0".repeat(36)}bc0b`, poolId: `0x${"ab".repeat(32)}` } as const;
const PIT_LABEL = "PITCOIN 0x0000…be11";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** An earlier default as that version's runtime (or the coordinator, for v1.2) wrote it for this seat. */
function oldDefault(version: string, lang: "en" | "zh", persona: PersonaKey | null, pit: string | null = null): string {
  const d = SHIPPED_DEFAULTS.find((x) => x.version === version)!;
  return d.template[lang]
    .replaceAll("<id>", ID)
    .replaceAll("<persona>", persona && d.personas ? d.personas[persona]![lang] : "")
    .replaceAll("<pit>", pit ?? "");
}

/** A confirmed prompt seat on `text`, as FL enter left it. */
function seat(text: string, persona: PersonaKey | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-migrate-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const path = join(dir, "strategy.md");
  writeFileSync(path, text, { mode: 0o644 });
  const planned = planAgent({ name: ID, promptPath: path, preset: "steady" });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, { ...confirmAgent(planned.agent), ...(persona ? { persona } : {}) });
  return { home, path };
}

const CASES: { version: string; persona: PersonaKey | null; pit: string | null }[] = [
  { version: "v1", persona: null, pit: null },
  { version: "v1.1", persona: "hunter", pit: null },
  { version: "v1.2", persona: "instigator", pit: "QUQU (contract 0x00…01)" },
];

describe("an unedited earlier default moves to the new one on start", () => {
  for (const { version, persona, pit } of CASES)
    for (const lang of ["en", "zh"] as const)
      it(`${version} (${lang}): replaced by ${DEFAULT_STRATEGY_VERSION} in the same language and style, the card with it; restorable`, () => {
        const old = oldDefault(version, lang, persona, pit);
        const { home, path } = seat(old, persona);
        // The pit the page last named, for a version that named none.
        keepPit(home, { pit: PIT } as never);
        const style = persona ?? personaOf(ID);
        const expected = defaultStrategy(ID, lang, style, pit ?? PIT_LABEL);
        expect(shippedDefaultOf(old, [ID])).toMatchObject({ version, lang, persona, pit });

        const checked = prepareStart(home, ID, { plan: null, yes: false, confirm: true });
        expect(checked).toMatchObject({ kind: "ready", strategy: { kind: "migrated", from: version, to: DEFAULT_STRATEGY_VERSION } });
        expect(readFileSync(path, "utf8")).toBe(expected);
        expect(readFileSync(`${path}.default-${version}`, "utf8")).toBe(old);
        const agent = loadAgent(home, ID)!;
        expect(promptChanged(agent)).toBe(false);
        expect(agent.persona).toBe(style);
        expect(migrationLine(home, agent)).toContain(`the unedited default ${version} was replaced by ${DEFAULT_STRATEGY_VERSION}`);
        // A second start: it is the current default, nothing more.
        expect(prepareStart(home, ID, { plan: null, yes: false, confirm: true })).toMatchObject({ kind: "ready", strategy: { kind: "current" } });
        // FL start --prompt on the same file: no new card, no new yes.
        expect(prepareStart(home, ID, { plan: { name: ID, promptPath: path, preset: "steady" }, yes: false, confirm: true })).toMatchObject({ kind: "ready", replanned: false });

        const restored = restoreDefault(home, loadAgent(home, ID)!);
        expect(restored).toMatchObject({ ok: true, from: version });
        expect(readFileSync(path, "utf8")).toBe(old);
        expect(promptChanged(loadAgent(home, ID)!)).toBe(false);
        expect(loadAgent(home, ID)!.persona ?? null).toBe(persona);
        // Put back: the next start leaves it, and says so.
        expect(prepareStart(home, ID, { plan: null, yes: false, confirm: true })).toMatchObject({ kind: "ready", strategy: { kind: "kept", from: version } });
        expect(readFileSync(path, "utf8")).toBe(old);
        expect(migrationLine(home, loadAgent(home, ID)!)).toBe(`strategy: kept on the default ${version} by FL strategy restore (the new default ${DEFAULT_STRATEGY_VERSION} is out)`);
        expect(restoreDefault(home, loadAgent(home, ID)!)).toEqual({ ok: false, why: "no default strategy was replaced for this agent" });
      });

  it("no pit kept and none in the old file: the new default's own words for none", () => {
    const { home, path } = seat(oldDefault("v1.1", "zh", "dip"), "dip");
    migrateDefault(home, loadAgent(home, ID)!);
    expect(readFileSync(path, "utf8")).toBe(defaultStrategy(ID, "zh", "dip", null));
    expect(readFileSync(path, "utf8")).toContain("擂台币 （待发），");
  });
});

describe("an edited file is never touched", () => {
  for (const { version, persona, pit } of CASES)
    for (const lang of ["en", "zh"] as const)
      it(`${version} (${lang}) with one byte changed: left as it is, and a notice that a new default is out`, () => {
        const old = oldDefault(version, lang, persona, pit);
        const edited = old.replace("0.15", "0.14");
        expect(edited).not.toBe(old);
        const { home, path } = seat(edited, persona);
        expect(prepareStart(home, ID, { plan: null, yes: false, confirm: true })).toMatchObject({ kind: "ready", strategy: { kind: "edited" } });
        expect(readFileSync(path, "utf8")).toBe(edited);
        expect(existsSync(`${path}.default-${version}`)).toBe(false);
        expect(readMigration(home, ID)).toBeNull();
        expect(migrationLine(home, loadAgent(home, ID)!)).toBe(`strategy: a new default strategy ${DEFAULT_STRATEGY_VERSION} is out; your edited strategy file is left as it is`);
        expect(migrationLine(home, loadAgent(home, ID)!, "zh")).toBe(`策略：新的默认策略 ${DEFAULT_STRATEGY_VERSION} 已发布；你改过的 strategy.md 原样保留`);
      });

  it("another seat's default (another Agent ID), the player's own file, and the current default: nothing", () => {
    const other = seat(oldDefault("v1.1", "en", "hunter").replaceAll(`${ID}.ai`, "otherseat.ai"), "hunter");
    expect(migrateDefault(other.home, loadAgent(other.home, ID)!)).toEqual({ kind: "edited", title: "Season-1 default strategy v1.1" });
    const own = seat("Mine: buy only what moves.\n");
    expect(migrateDefault(own.home, loadAgent(own.home, ID)!)).toEqual({ kind: "none" });
    expect(migrationLine(own.home, loadAgent(own.home, ID)!)).toBeNull();
    const current = seat(defaultStrategy(ID, "en", "closer", PIT_LABEL), "closer");
    expect(migrateDefault(current.home, loadAgent(current.home, ID)!)).toEqual({ kind: "current" });
  });

  it("a file changed after the migration is not restored over", () => {
    const { home, path } = seat(oldDefault("v1.1", "en", "closer"), "closer");
    migrateDefault(home, loadAgent(home, ID)!);
    writeFileSync(path, `${readFileSync(path, "utf8")}My own line.\n`);
    expect(restoreDefault(home, loadAgent(home, ID)!)).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toContain("My own line.");
  });
});
