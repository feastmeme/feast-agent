import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { sha256Of } from "../audit/static.ts";
import { auditFile, recordModelVerdict } from "../audit/verdict.ts";
import { parseBook } from "../book.ts";
import { renderCard } from "../card.ts";
import { tradeWorld } from "../prompt/fakes.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths } from "../store.ts";
import { checkPath, checkScript, scriptCheckPassed, writeCheckReport } from "./check.ts";
import { stubWorld } from "./world.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function dir() {
  const d = mkdtempSync(join(tmpdir(), "feast-league-check-"));
  dirs.push(d);
  return d;
}

const PASSING = `// Buys the busiest coin once, sells it ten ticks later.
export const meta = { name: "busy", tickSeconds: 60, events: ["coin.created"] };
export const params = { size: 0.002 };

export function onTick(api) {
  const state = api.state;
  state.n = (state.n || 0) + 1;
  const top = api.read.coins({ sort: "volume", limit: 1 })[0];
  if (state.n === 2 && top) {
    state.coin = top.coin;
    api.buy({ coin: top.coin, bnb: api.params.size, reason: "the busiest coin" });
  }
  if (state.n === 12 && state.coin && api.read.position(state.coin)) {
    api.sell({ coin: state.coin, fraction: 1, reason: "ten ticks later" });
  }
}

export function onEvent(api, event) {
  api.log("saw " + event.type);
}
`;

const tick = (body: string) => `export const meta = { name: "t", tickSeconds: 60 };\nexport function onTick(api) {\n${body}\n}\n`;

describe("the stub world", () => {
  it("is fixed by its seed: 8 coins, at least 30 snapshots, a launch, trades and a price move", () => {
    const a = stubWorld();
    expect(a.frames.length).toBeGreaterThanOrEqual(30);
    expect(a.coins).toHaveLength(8);
    const events = a.frames.flatMap((f) => f.events.map((e) => e.type));
    expect(events).toContain("coin.created");
    expect(events).toContain("trade");
    expect(events).toContain("price.move");
    expect(JSON.stringify(stubWorld())).toBe(JSON.stringify(a));
    expect(a.balanceBnb).toBe(0.2);
  });
});

describe("FL script check", () => {
  it("a script that stays inside every limit passes, and its report is written beside its audit", async () => {
    const report = await checkScript(PASSING, { file: "busy.mjs" });
    expect(report.verdict).toBe("pass");
    expect(report.checks.map((c) => c.id)).toEqual(["load", "meta", "calls", "normalize", "size", "feast", "held", "launch", "guard", "trades"]);
    expect(report.checks.every((c) => c.pass)).toBe(true);
    expect(report.stats).toMatchObject({ buys: 1, sells: 1, launches: 0, refusals: 0 });
    expect(report.stats.ticks).toBeGreaterThanOrEqual(30);
    expect(report.stats.events).toBeGreaterThan(0);
    const home = dir();
    const path = writeCheckReport(home, report);
    expect(path).toBe(checkPath(home, sha256Of(PASSING)));
    expect(path).toMatch(/audits\/[0-9a-f]{64}\.check\.json$/);
    expect(scriptCheckPassed(home, sha256Of(PASSING))).toBe(true);
    expect(scriptCheckPassed(home, sha256Of(`${PASSING}\n`))).toBe(false);
  });

  const failing: [string, string, string][] = [
    ["throws", tick(`throw new Error("boom");`), "calls"],
    ["overruns", tick(`let i = 0; while (true) { i += 1; }`), "calls"],
    ["buys over L1", tick(`api.buy({ coin: "FEAST", bnb: 0.05 });`), "size"],
    ["buys under the smallest trade", tick(`api.buy({ coin: "FEAST", bnb: 0.0001 });`), "size"],
    ["buys a coin that is not a Feast coin", tick(`api.buy({ coin: "0x000000000000000000000000000000000000dEaD", bnb: 0.002 });`), "feast"],
    ["sells a coin it does not hold", tick(`api.sell({ coin: "FEAST", fraction: 1 });`), "held"],
    ["launches twice", tick(`api.state.n = (api.state.n || 0) + 1; if (api.state.n <= 2) api.launch({ name: "Twice", symbol: "TWO" });`), "launch"],
    ["passes L2 over the day", tick(`const c = api.read.coins({ sort: "new", limit: 8 })[(api.state.k = ((api.state.k || 0) + 1) % 8)]; if (c) api.buy({ coin: c.coin, bnb: 0.02 });`), "guard"],
    ["asks for an unknown event", `export const meta = { name: "t", tickSeconds: 60, events: ["block"] };\nexport function onTick(api) {}\n`, "meta"],
    ["a tick outside 15–3600 s", `export const meta = { name: "t", tickSeconds: 5 };\nexport function onTick(api) {}\n`, "meta"],
  ];
  for (const [what, source, check] of failing) {
    it(`fails a script that ${what}, naming the check, the snapshot and the request`, async () => {
      const report = await checkScript(source);
      expect(report.verdict).toBe("fail");
      const failed = report.checks.find((c) => !c.pass)!;
      expect(failed.id).toBe(check);
      if (check !== "meta") expect(failed.snapshot).toEqual(expect.any(Number));
      if (["size", "feast", "held", "launch", "guard"].includes(check)) expect(failed.request).toBeDefined();
    }, 20_000);
  }

  it("a script that never trades passes nothing a warm-up would test: it fails, and keeps its warm-up", async () => {
    const report = await checkScript(tick(`api.log("watching");`));
    expect(report.verdict).toBe("fail");
    expect(report.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(["trades"]);
    const buyOnly = await checkScript(tick(`if (!api.state.done) { api.state.done = true; api.buy({ coin: "FEAST", bnb: 0.002 }); }`));
    expect(buyOnly.checks.find((c) => !c.pass)?.id).toBe("trades");
  });

  it("a module that does not load fails the load check", async () => {
    const report = await checkScript("export const = ;");
    expect(report.verdict).toBe("fail");
    expect(report.checks[0]).toMatchObject({ id: "load", pass: false });
  });
});

describe("graduation: a passing check and a passed audit finish the warm-up for that sha256", () => {
  async function scriptAgent(source: string, options: { check?: boolean; audit?: boolean } = {}) {
    const d = dir();
    const home = join(d, "home");
    const file = join(d, "busy.mjs");
    writeFileSync(file, source);
    if (options.audit !== false) {
      auditFile(home, file);
      recordModelVerdict(home, file, "pass", "read against the checklist: no wallet, no network, sizes inside L1");
    }
    if (options.check !== false) writeCheckReport(home, await checkScript(source, { file }));
    const planned = planAgent({ name: "busy", scriptPath: file });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const w = tradeWorld();
    const out = await runAgent({ home, name: "busy", signer: w.signer, chain: w.chain, fetch: (async () => new Response("{}")) as unknown as typeof fetch, only: [] });
    expect(out.exit).toBe("finished");
    return { home, file, warmup: parseBook(readFileSync(agentPaths(home, "busy").state, "utf8")).warmup, agent: planned.agent };
  }

  it("starts the warm-up finished; the card says so", async () => {
    const { warmup, home, agent } = await scriptAgent(PASSING);
    expect(warmup).toMatchObject({ sha: sha256Of(PASSING), trades: 5 });
    const card = renderCard(agent, null, { warmupPassed: scriptCheckPassed(home, agent.script!.sha256) });
    expect(card).toContain(`Warm-up: passed by FL script check (sha ${agent.script!.sha256.slice(0, 6)}…${agent.script!.sha256.slice(-4)}).`);
  });

  it("a check on record for another sha does not; an edited file starts the warm-up at 0", async () => {
    const { warmup: none } = await scriptAgent(PASSING, { check: false });
    expect(none).toMatchObject({ trades: 0 });
    const edited = `${PASSING}// an edit\n`;
    const d = dir();
    const home = join(d, "home");
    writeCheckReport(home, await checkScript(PASSING));
    expect(existsSync(checkPath(home, sha256Of(PASSING)))).toBe(true);
    expect(scriptCheckPassed(home, sha256Of(edited))).toBe(false);
    writeFileSync(join(d, "edited.mjs"), edited);
    const planned = planAgent({ name: "x", scriptPath: join(d, "edited.mjs") });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const card = renderCard(planned.agent, null, { warmupPassed: scriptCheckPassed(home, planned.agent.script!.sha256) });
    expect(card).toContain("Warm-up: its first 5 trades run at 0.001 BNB");
  });
});
