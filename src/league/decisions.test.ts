import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "./agent.ts";
import type { HostCall } from "./ask/host.ts";
import { readJournal } from "./ask/journal.ts";
import {
  appendDecision,
  canonicalJson,
  decisionRow,
  decisionsPath,
  decisionsStatePath,
  DECISIONS_KEPT,
  KEEPER_OFF,
  pendingDecisions,
  readDecisions,
  readDecisionsState,
  resultOfJournal,
  resultOfOutcome,
  rowSecrets,
  sendDecisions,
  strategyOf,
  writeKeeper,
  type DecisionRow,
} from "./decisions.ts";
import { defaultStrategy, defaultStrategyVariants, PERSONAS, personaOf } from "./enter/strategy.ts";
import { coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody, type Answer } from "./feed/fakes.ts";
import { RUNTIME_RELEASE } from "./headers.ts";
import { saveSession } from "./notes/session.ts";
import { fakeClock, marketWorld } from "./prompt/fakes.ts";
import { recordHostAction } from "./prompt/host.ts";
import { leagueWire } from "./register/fakes.ts";
import { runAgent } from "./runtime.ts";
import { agentPaths, writeJsonAtomic } from "./store.ts";
import { splitHelp } from "./support.ts";

/**
 * Task 1018: each round's decision, on disk and up to feast.meme with the heartbeat. The site is a fake fetch here; the
 * row is checked against the contract's own patterns (the ones the site's body check holds every row to).
 */

const MIN = 60_000;
const T0 = Date.parse("2026-10-29T06:00:00Z");
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const COINS = [coin(0xc0e1), coin(0xc0e2), coin(0xc0e3)];
const SYMBOLS = ["NOODFEED", "KOIFEED", "MOTHFEED"];
const OWN = coin(0xb0d1e);
const PROMPT = "Trade the busiest coin small; keep the floor early.\n";

/** The contract's patterns (briefs 1018 and 1019), as the site checks every row. */
const RESULT = /^(?:ok|refused|failed)(?:: .*)?$/su;
const KIND = /^(?:default|script|custom|preset:[A-Za-z0-9._-]+)$/;
const SHA8 = /^[0-9a-f]{8}$/;
const points = (s: string) => [...s].length;

function contract(row: DecisionRow) {
  expect(Object.keys(row).sort()).toEqual(["action", "at", "host", "keeper", "reason", "result", "runtime", "source", "strategy"]);
  expect(new Date(row.at).toISOString()).toBe(row.at);
  expect(["runtime-ask", "host-answer", "keeper"]).toContain(row.source);
  expect(["hold", "buy", "sell", "none"]).toContain(row.action);
  expect(typeof row.reason).toBe("string");
  expect(points(row.reason)).toBeLessThanOrEqual(140);
  expect(points(row.result)).toBeLessThanOrEqual(160);
  expect(row.result).toMatch(RESULT);
  expect(row.strategy.kind).toMatch(KIND);
  expect(points(row.strategy.kind)).toBeLessThanOrEqual(32);
  expect(row.strategy.sha8).toMatch(SHA8);
  expect(typeof row.keeper.on).toBe("boolean");
  expect(points(row.keeper.mode)).toBeLessThanOrEqual(32);
  expect(row.runtime).toBe(RUNTIME_RELEASE);
  expect(points(row.host)).toBeLessThanOrEqual(32);
}

let dirs: string[] = [];
const envKept: Record<string, string | undefined> = {};
beforeEach(() => {
  // The host as the headers say it, the same on every machine: `other`, with the detail `binance`.
  for (const k of ["FEAST_LEAGUE_MODEL", "FEAST_LEAGUE_HOST"]) envKept[k] = process.env[k];
  process.env.FEAST_LEAGUE_MODEL = "other";
  process.env.FEAST_LEAGUE_HOST = "binance";
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  for (const [k, v] of Object.entries(envKept)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-1018-"));
  dirs.push(dir);
  return dir;
};

const strategy = { kind: "custom", sha8: "0123abcd" };
const row = (at: number, over: Partial<Parameters<typeof decisionRow>[0]> = {}) => decisionRow({ at, source: "runtime-ask", action: "hold", reason: `r${at}`, result: "ok: hold", strategy, keeper: KEEPER_OFF, ...over });

// --- the ring --------------------------------------------------------------------------------------------------

describe("the ring on disk", () => {
  it("keeps at most 30 rows: appends up to 30, then rewrites the file whole (a new file by rename), newest 30 kept, mode 0600", () => {
    const home = tempDir();
    for (let i = 0; i < DECISIONS_KEPT; i += 1) appendDecision(home, "demo", row(T0 + i * MIN));
    const path = decisionsPath(home, "demo");
    const inode = statSync(path).ino;
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(30);
    appendDecision(home, "demo", row(T0 + 30 * MIN));
    // Over 30: written through a temporary file and a rename, so a crash never leaves half a ring.
    expect(statSync(path).ino).not.toBe(inode);
    for (let i = 31; i < 45; i += 1) appendDecision(home, "demo", row(T0 + i * MIN));
    const rows = readDecisions(home, "demo");
    expect(rows).toHaveLength(30);
    expect(rows[0]!.at).toBe(new Date(T0 + 15 * MIN).toISOString());
    expect(rows[29]!.at).toBe(new Date(T0 + 44 * MIN).toISOString());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(agentPaths(home, "demo").dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a row is never at or before the one above it (a trade settled after a later decision goes 1 ms after it); torn lines are skipped", () => {
    const home = tempDir();
    appendDecision(home, "demo", row(T0 + 5 * MIN));
    const late = appendDecision(home, "demo", row(T0 + 2 * MIN));
    const same = appendDecision(home, "demo", row(T0 + 2 * MIN));
    expect(late.at).toBe(new Date(T0 + 5 * MIN + 1).toISOString());
    expect(same.at).toBe(new Date(T0 + 5 * MIN + 2).toISOString());
    writeFileSync(decisionsPath(home, "demo"), `${readFileSync(decisionsPath(home, "demo"), "utf8")}{"at":"2026-10-29T06:`, { flag: "w" });
    expect(readDecisions(home, "demo").map((r) => r.reason)).toEqual([`r${T0 + 5 * MIN}`, `r${T0 + 2 * MIN}`, `r${T0 + 2 * MIN}`]);
  });

  it("a restart reads the ring and the cursor back: only what the site has not taken is pending", async () => {
    const home = tempDir();
    for (let i = 1; i <= 5; i += 1) appendDecision(home, "demo", row(T0 + i * MIN));
    const site = fakeSite([ok(3)]);
    await sendDecisions({ home, name: "demo", site: SITE, fetch: site.fetch, token: "test-token", now: T0 + 6 * MIN, log: () => {} });
    // A new process: nothing in memory, both files read again.
    expect(readDecisionsState(home, "demo").sentThrough).toBe(new Date(T0 + 3 * MIN).toISOString());
    expect(pendingDecisions(home, "demo", T0 + 6 * MIN).map((r) => r.at)).toEqual([4, 5].map((i) => new Date(T0 + i * MIN).toISOString()));
  });

  it("neither file holds the wallet, an address, a hash, a key or a path", () => {
    const home = tempDir();
    const wallet = getAddress("0x00000000000000000000000000000000000a11ce");
    const hash = `0x${"ab".repeat(32)}`;
    appendDecision(
      home,
      "demo",
      decisionRow(
        { at: T0, source: "keeper", action: "buy", reason: `mine ${wallet} and ${wallet.toLowerCase()} sk-abcdefghijklmnop`, result: `failed: execute: ${hash} ${COINS[0]} at ${join(homedir(), "x", "y")} and ${join(home, "agents")}`, strategy, keeper: KEEPER_OFF },
        { home, wallet },
      ),
    );
    writeKeeper(home, "demo", { on: true, mode: "asks failing" }, T0);
    const text = readFileSync(decisionsPath(home, "demo"), "utf8") + readFileSync(decisionsStatePath(home, "demo"), "utf8");
    for (const secret of [wallet, wallet.toLowerCase(), hash, COINS[0]!, homedir(), home, "sk-abcdefghijklmnop"]) expect(text).not.toContain(secret);
    const [kept] = readDecisions(home, "demo");
    expect(kept!.reason).toContain("mine self and self");
    expect(kept!.result).toMatch(/^failed: execute: 0xabab…abab 0x0000…c0e1 at ~/);
  });
});

describe("named secrets never reach a row", () => {
  it("the notes token, a keyed RPC or indexer URL and the agent's ask key (its variable or its stored file), wherever they appear in a cause", () => {
    const home = tempDir();
    saveSession(home, { version: 1, agentId: "maplegrin", season: 1, token: "rawnotestoken-1018", expiresAt: null, at: new Date(T0).toISOString() });
    mkdirSync(agentPaths(home, "demo").dir, { recursive: true });
    writeFileSync(join(agentPaths(home, "demo").dir, "ask-key"), "stored-ask-key-1018\n");
    const env = { FEAST_MAINNET_RPC_URL: "https://rpc.test/keyed-path-1018", FEAST_LEAGUE_INDEXER: "https://indexer.test/v1-1018", MY_ENDPOINT_KEY: "env-ask-key-1018" };
    const fromFile = rowSecrets(home, { name: "demo", ask: { every: 5, with: "openai", model: "m", keyEnv: null } }, env);
    const fromEnv = rowSecrets(home, { name: "demo", ask: { every: 5, with: "openai", model: "m", keyEnv: "MY_ENDPOINT_KEY" } }, env);
    expect(fromFile).toEqual(["rawnotestoken-1018", "https://rpc.test/keyed-path-1018", "https://indexer.test/v1-1018", "stored-ask-key-1018"]);
    expect(fromEnv.at(-1)).toBe("env-ask-key-1018");
    const cause = "the endpoint said 401 for env-ask-key-1018 and stored-ask-key-1018 via https://rpc.test/keyed-path-1018 (session rawnotestoken-1018)";
    const r = decisionRow({ at: T0, source: "runtime-ask", action: "none", reason: cause, result: `failed: ${cause}`, strategy, keeper: KEEPER_OFF }, { home, secrets: [...fromFile, ...fromEnv] });
    for (const secret of ["rawnotestoken-1018", "https://rpc.test/keyed-path-1018", "stored-ask-key-1018", "env-ask-key-1018"]) {
      expect(r.reason).not.toContain(secret);
      expect(r.result).not.toContain(secret);
    }
    expect(r.result).toBe("failed: the endpoint said 401 for <redacted> and <redacted> via <redacted> (session <redacted>)");
    // A secret across the 160th character: scrubbed whole before the cut, never left in part.
    const across = decisionRow({ at: T0, source: "runtime-ask", action: "none", reason: "", result: resultOfJournal(`error: ${"y".repeat(140)} rawnotestoken-1018 and more`), strategy, keeper: KEEPER_OFF }, { home, secrets: fromFile });
    expect(across.result).not.toMatch(/rawnot/);
    expect(points(across.result)).toBeLessThanOrEqual(160);
  });
});

// --- the upload --------------------------------------------------------------------------------------------------

type Call = { url: string; init: RequestInit; rows: DecisionRow[] };
const ok = (stored: number) => new Response(JSON.stringify({ ok: true, stored, ignored: 0 }), { status: 200, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => new Response(JSON.stringify({ error: { code } }), { status, headers: { "content-type": "application/json" } });
function fakeSite(answers: (Response | "refused" | "timeout")[]) {
  const calls: Call[] = [];
  const answer = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, rows: (JSON.parse(String(init.body)) as { rows: DecisionRow[] }).rows });
    const a = answers.shift() ?? ok(0);
    if (a === "refused") throw new TypeError("fetch failed");
    if (a === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return a;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch: answer };
}

describe("the upload: at most 3 rows a beat, oldest first, the cursor only on a 2xx", () => {
  it("batches of 3 in order; 404 (not deployed), 405, 401, 429, 503, no answer and a timeout leave the rows and log one line each", async () => {
    const home = tempDir();
    for (let i = 1; i <= 8; i += 1) appendDecision(home, "demo", row(T0 + i * MIN));
    const logged: { event: string; fields?: Record<string, unknown> }[] = [];
    const site = fakeSite([ok(3), refused(404, "not_found"), refused(405, "x"), refused(401, "session_expired"), refused(429, "rate_limited"), refused(503, "unavailable"), "refused", "timeout", ok(3), ok(2)]);
    const send = () => sendDecisions({ home, name: "demo", site: `${SITE}/`, fetch: site.fetch, token: "test-token", now: T0 + 9 * MIN, log: (event, fields) => logged.push({ event, fields }) });
    const outs = [];
    for (let i = 0; i < 11; i += 1) outs.push(await send());
    expect(outs.map((o) => o.status)).toEqual([200, 404, 405, 401, 429, 503, null, null, 200, 200, null]);
    expect(site.calls).toHaveLength(10);
    expect(site.calls.every((c) => c.url === `${SITE}/api/league/decisions` && c.init.method === "POST")).toBe(true);
    expect(site.calls.every((c) => c.rows.length >= 1 && c.rows.length <= 3)).toBe(true);
    // The failed ones sent the same 3 again; the accepted ones are the ring, oldest first, once each.
    const at = (c: Call) => c.rows.map((r) => (Date.parse(r.at) - T0) / MIN);
    expect(site.calls.map(at)).toEqual([[1, 2, 3], ...Array(7).fill([4, 5, 6]), [4, 5, 6], [7, 8]]);
    expect(readDecisionsState(home, "demo").sentThrough).toBe(new Date(T0 + 8 * MIN).toISOString());
    expect(logged.filter((l) => l.event === "decisions.failed").map((l) => [l.fields?.status, l.fields?.code ?? l.fields?.why])).toEqual([
      [404, "not_found"],
      [405, "x"],
      [401, "session_expired"],
      [429, "rate_limited"],
      [503, "unavailable"],
      [null, "no answer"],
      [null, "no answer in time"],
    ]);
    expect(logged.filter((l) => l.event === "decisions.sent").map((l) => l.fields?.rows)).toEqual([3, 3, 2]);
    // Each request: the bearer, JSON both ways, and a deadline.
    for (const c of site.calls) {
      expect(c.init.headers).toEqual({ accept: "application/json", "content-type": "application/json", authorization: "Bearer test-token" });
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(logged)).not.toContain("test-token");
  });

  it("no notes session: nothing is sent, one line logged while rows wait; nothing pending: nothing at all", async () => {
    const home = tempDir();
    const logged: string[] = [];
    const site = fakeSite([]);
    expect(await sendDecisions({ home, name: "demo", site: SITE, fetch: site.fetch, token: null, now: T0, log: (e) => logged.push(e) })).toEqual({ sent: 0, status: null, left: 0 });
    appendDecision(home, "demo", row(T0));
    expect(await sendDecisions({ home, name: "demo", site: SITE, fetch: site.fetch, token: null, now: T0 + MIN, log: (e) => logged.push(e) })).toEqual({ sent: 0, status: null, left: 1 });
    expect(site.calls).toEqual([]);
    expect(logged).toEqual(["decisions.failed"]);
  });

  it("a row older than 23 h is not sent (the site takes 24 h back): it never blocks the ones after it", async () => {
    const home = tempDir();
    appendDecision(home, "demo", row(T0 - 30 * 60 * MIN));
    appendDecision(home, "demo", row(T0 - 5 * MIN));
    const site = fakeSite([ok(1)]);
    await sendDecisions({ home, name: "demo", site: SITE, fetch: site.fetch, token: "test-token", now: T0, log: () => {} });
    expect(site.calls.map((c) => c.rows.map((r) => r.at))).toEqual([[new Date(T0 - 5 * MIN).toISOString()]]);
  });
});

// --- the row --------------------------------------------------------------------------------------------------

describe("the row: every field's shape", () => {
  it("the reason cut to 140 characters and the result to 160 (code points, as the site counts), on one line", () => {
    const long = "盘".repeat(100) + "🍜".repeat(100) + "\nsecond line";
    const r = row(T0, { reason: long, result: `refused: ${"x".repeat(400)}` });
    contract(r);
    expect(points(r.reason)).toBe(140);
    expect(r.reason.startsWith("盘".repeat(100) + "🍜".repeat(39))).toBe(true);
    expect(points(r.result)).toBe(160);
    expect(r.result.startsWith("refused: xxx")).toBe(true);
    expect(row(T0, { reason: "" }).reason).toBe("");
    // A result that does not start as the contract says is a failure, its words kept.
    expect(row(T0, { result: "okay then" }).result).toBe("failed: okay then");
    expect(row(T0, { result: "refused: " }).result).toBe("failed: refused:");
  });

  it("runtime and host as the headers say them: other/binance, or the host alone", () => {
    expect(row(T0)).toMatchObject({ runtime: RUNTIME_RELEASE, host: "other/binance" });
    process.env.FEAST_LEAGUE_MODEL = "claude";
    delete process.env.FEAST_LEAGUE_HOST;
    expect(row(T0).host).toBe("claude");
  });

  it("the ask journal's results: filled and hold ok; rejected and dropped refused; failed, invalid, error and unknown failed", () => {
    const cases: [string, string][] = [
      ["filled", "ok: filled"],
      ["hold", "ok: hold"],
      ["rejected: L3 0.02 BNB more would pass the cap", "refused: L3 0.02 BNB more would pass the cap"],
      ["dropped: nothing to sell", "refused: nothing to sell"],
      ["dropped: it expired before it ran", "refused: it expired before it ran"],
      ["failed: execute: the wallet said no", "failed: execute: the wallet said no"],
      ["invalid: a buy needs a coin", "failed: invalid: a buy needs a coin"],
      ["error: Claude Code exited 1: You have hit your usage limit.", "failed: Claude Code exited 1: You have hit your usage limit."],
      ["error: invalid answer: not JSON", "failed: invalid answer: not JSON"],
      ["unknown: its outcome is not known yet", "failed: sent, its outcome is not known yet"],
      ["something new", "failed: something new"],
    ];
    for (const [journal, said] of cases) {
      expect(resultOfJournal(journal), journal).toBe(said);
      expect(said).toMatch(RESULT);
    }
  });

  it("a trade's outcome: filled ok, refused and stale refused, failed and unknown failed; no transaction hash", () => {
    const hash = `0x${"cd".repeat(32)}`;
    expect(resultOfOutcome({ outcome: "filled", kind: "buy", symbol: "NOODFEED", bnb: 0.006, txHash: hash })).toBe("ok: bought NOODFEED for 0.006 BNB");
    expect(resultOfOutcome({ outcome: "filled", kind: "sell", symbol: "KOIFEED", bnb: 0.0071, txHash: hash })).toBe("ok: sold KOIFEED for 0.0071 BNB");
    expect(resultOfOutcome({ outcome: "refused", limit: "L3", message: "over the cap" })).toBe("refused: L3: over the cap");
    expect(resultOfOutcome({ outcome: "stale" })).toBe("refused: it went stale before its turn");
    expect(resultOfOutcome({ outcome: "nothing" })).toBe("refused: nothing to sell");
    expect(resultOfOutcome({ outcome: "dropped", reason: "a sale of this coin is already queued" })).toBe("refused: a sale of this coin is already queued");
    expect(resultOfOutcome({ outcome: "failed", stage: "execute", reason: "rejected", txHash: hash })).toBe("failed: execute: rejected");
    expect(resultOfOutcome({ outcome: "unknown", txHash: hash })).toBe("failed: sent, its outcome is not known yet");
    expect(resultOfOutcome(null)).toMatch(/^failed: no outcome within 90 s/);
  });
});

// --- strategy.kind and strategy.sha8 ---------------------------------------------------------------------------

describe("strategy.kind and sha8: never the text", () => {
  const sha8 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 8);
  const promptAgent = (dir: string, text: string, name = "maplegrin") => {
    const path = join(dir, `${name}-strategy.md`);
    writeFileSync(path, text);
    return { name, track: "prompt" as const, preset: "steady" as const, script: null, prompt: { path, sha256: "" }, params: {} };
  };

  it("the shipped default, zh and en, with <id> replaced: default, with its style; one character more: custom", () => {
    const dir = tempDir();
    const home = join(dir, "home");
    for (const lang of ["zh", "en"] as const) {
      const text = defaultStrategy("maplegrin", lang);
      expect(strategyOf(home, promptAgent(dir, text))).toEqual({ kind: "default", sha8: sha8(text), persona: personaOf("maplegrin") });
      const edited = `${text}.`;
      expect(strategyOf(home, promptAgent(dir, edited))).toEqual({ kind: "custom", sha8: sha8(edited) });
    }
  });

  it("each of the seven styles, in either language, is the default; another Agent ID's default is custom", () => {
    const dir = tempDir();
    const home = join(dir, "home");
    const en = defaultStrategyVariants("maplegrin");
    expect(en).toHaveLength(7);
    PERSONAS.forEach((persona, i) => {
      expect(strategyOf(home, promptAgent(dir, en[i]!))).toMatchObject({ kind: "default", persona });
      expect(strategyOf(home, promptAgent(dir, defaultStrategy("maplegrin", "zh", persona)))).toMatchObject({ kind: "default", persona });
    });
    expect(strategyOf(home, promptAgent(dir, defaultStrategy("otheragent", "en"))).kind).toBe("custom");
  });

  it("an agent named apart from its Agent ID (FL enter --agent) is still on the default of the ID it entered with", () => {
    const dir = tempDir();
    const home = join(dir, "home");
    writeJsonAtomic(join(agentPaths(home, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: null, launchTx: null });
    expect(strategyOf(home, promptAgent(dir, defaultStrategy("maplegrin", "en"), "trader"))).toMatchObject({ kind: "default" });
  });

  it("a prompt that cannot be read: custom, from the sha256 it was confirmed with", () => {
    const home = tempDir();
    const gone = { name: "demo", track: "prompt" as const, preset: null, script: null, prompt: { path: join(home, "gone.md"), sha256: "feedc0de".repeat(8) }, params: {} };
    expect(strategyOf(home, gone)).toEqual({ kind: "custom", sha8: "feedc0de" });
  });

  it("a script: the file's bytes; a preset: preset:<name> and its canonical parameters, whatever their keys' order", () => {
    const dir = tempDir();
    const path = join(dir, "s.mjs");
    const source = "export default { onTick() {} };\n";
    writeFileSync(path, source);
    expect(strategyOf(dir, { name: "demo", track: "script", preset: null, script: { path, sha256: "0".repeat(64) }, prompt: null, params: {} })).toEqual({ kind: "script", sha8: sha8(Buffer.from(source)) });
    const a = strategyOf(dir, { name: "demo", track: "preset", preset: "dca", script: null, prompt: null, params: { buyBnb: 0.002, every: { hours: 24, jitter: 1 } } });
    const b = strategyOf(dir, { name: "demo", track: "preset", preset: "dca", script: null, prompt: null, params: { every: { jitter: 1, hours: 24 }, buyBnb: 0.002 } });
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: "preset:dca", sha8: sha8('{"buyBnb":0.002,"every":{"hours":24,"jitter":1}}') });
    expect(canonicalJson({ b: [2, { d: 1, c: 0 }], a: null })).toBe('{"a":null,"b":[2,{"c":0,"d":1}]}');
    expect(strategyOf(dir, { name: "demo", track: "preset", preset: "dca", script: null, prompt: null, params: { buyBnb: 0.003 } }).sha8).not.toBe(a.sha8);
  });
});

// --- in the runtime ---------------------------------------------------------------------------------------------

function setup(o: { ask?: "claude" | "none" } = {}) {
  const dir = tempDir();
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, PROMPT);
  const planned = planAgent({ name: "demo", promptPath, preset: "steady", ask: { every: 5, with: o.ask ?? "claude", model: null } });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  const home = join(dir, "home");
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(T0 - 2 * 86_400_000)), league: { waitForSeason: true } });
  writeJsonAtomic(join(agentPaths(home, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: OWN, launchTx: null });
  saveSession(home, { version: 1, agentId: "maplegrin", season: 1, token: "test-session-decisions", expiresAt: null, at: new Date(T0).toISOString() });
  return { home };
}

/** The market, the league, and the decisions route answering as `route` says (null: 404, the route not deployed). */
function world(c: ReturnType<typeof fakeClock>, route: (at: number, rows: DecisionRow[]) => Answer | null) {
  const rows = COINS.map((k, i) => coinRow(k, { symbol: SYMBOLS[i], volume24hBnb: 9 - i, trades24h: 90 - i, launchedAt: "2026-10-20T00:00:00.000Z" }));
  const feed = new FakeFeed(c.now, () => ({ status: 200, body: snapshotBody({ coins: rows }), etag: '"d1"' }));
  const posted: { at: number; rows: DecisionRow[] }[] = [];
  feed.other = (url, init) => {
    if (url.origin === SITE && url.pathname === "/api/league/decisions" && init?.method === "POST") {
      const body = (JSON.parse(String(init.body)) as { rows: DecisionRow[] }).rows;
      posted.push({ at: c.now(), rows: body });
      return route(c.now(), body);
    }
    return url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } }) } : null;
  };
  const w = marketWorld({ coins: [OWN, ...COINS].map((k, i) => ({ coin: k, symbol: i === 0 ? "MAPLEFEED" : SYMBOLS[i - 1]! })), now: c.now });
  return { feed, w, posted };
}

const logOf = (h: string) =>
  existsSync(agentPaths(h, "demo").log)
    ? readFileSync(agentPaths(h, "demo").log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string })
    : [];
const hold = (reason: string): HostCall => ({ ok: true, answer: { action: "hold", coin: null, amountBnb: null, fraction: null, reason, memo: "" } });

function run(home: string, c: ReturnType<typeof fakeClock>, feed: FakeFeed, w: ReturnType<typeof marketWorld>, until: number, askHost: () => Promise<HostCall>) {
  return runAgent({ home, name: "demo", signer: w.signer, chain: w.chain, fetch: feed.fetch, site: SITE, indexer: INDEXER, now: c.now, sleep: c.sleep, random: seeded(5), noJitter: true, loopMs: 15_000, pollMs: 30_000, maxRuntimeMs: until - c.now(), out: () => {}, askHost: askHost as never });
}

describe("in the runtime: the ask loop's rounds go up with the heartbeat", () => {
  it("while the route 404s (not deployed) or fails, the rows wait and the heartbeat keeps its 9 minutes; then 3 a beat, oldest first, with the four headers", async () => {
    const { home } = setup();
    const c = fakeClock(T0);
    // 404 (not deployed) until T0 + 20, no answer until T0 + 30, then taken.
    const { feed, w, posted } = world(c, (at, rows) => (at < T0 + 20 * MIN ? null : at < T0 + 30 * MIN ? "refused" : { status: 200, body: { ok: true, stored: rows.length, ignored: 0 } }));
    recordHostAction(home, "demo", "buy", T0);
    let n = 0;
    await run(home, c, feed, w, T0 + 60 * MIN, async () => hold(`round ${(n += 1)}: nothing worth it`));

    // The heartbeat's authenticated read, every 9 minutes, whatever the decisions route did.
    const beats = feed.asked.filter((a) => a.url.startsWith(`${SITE}/api/league?view=today&limit=1&me=`) && a.headers.authorization !== undefined);
    expect(beats.map((a) => (a.at - T0) / MIN)).toEqual([0, 9, 18, 27, 36, 45, 54]);
    // One POST a beat once a row exists, after the read, at most 3 rows each.
    const posts = feed.asked.filter((a) => a.method === "POST" && a.url === `${SITE}/api/league/decisions`);
    expect(posts.map((a) => Math.floor((a.at - T0) / MIN))).toEqual([9, 18, 27, 36, 45, 54]);
    expect(posted.every((p) => p.rows.length >= 1 && p.rows.length <= 3)).toBe(true);
    for (const a of posts) {
      expect(a.headers).toMatchObject({ authorization: "Bearer test-session-decisions", "content-type": "application/json", "x-feast-host": "other", "x-feast-host-detail": "binance", "x-feast-runtime": RUNTIME_RELEASE, "x-feast-health": expect.stringMatching(/^(ok|degraded|failing)$/) });
    }

    const ring = readDecisions(home, "demo");
    const journal = readJournal(home, "demo", 50);
    expect(ring).toHaveLength(journal.length);
    expect(ring.length).toBeGreaterThanOrEqual(10);
    // The same rounds as the journal: its time, its action, its reason; the result in the contract's words.
    ring.forEach((r, i) => {
      contract(r);
      expect(r).toMatchObject({ at: journal[i]!.at, source: "runtime-ask", action: "hold", reason: journal[i]!.reason, result: "ok: hold", keeper: { on: false, mode: "off" }, runtime: RUNTIME_RELEASE, host: "other/binance" });
      expect(r.strategy).toEqual({ kind: "custom", sha8: createHash("sha256").update(PROMPT).digest("hex").slice(0, 8) });
    });
    // The failed beats sent the oldest rows again; the taken ones are the ring's first nine, once each, in order.
    const taken = posted.filter((p) => p.at >= T0 + 30 * MIN);
    expect(taken.map((p) => p.rows.length)).toEqual([3, 3, 3]);
    expect(taken.flatMap((p) => p.rows)).toEqual(ring.slice(0, 9));
    expect(posted.filter((p) => p.at < T0 + 30 * MIN).map((p) => p.rows[0]!.at)).toEqual([ring[0]!.at, ring[0]!.at, ring[0]!.at]);
    expect(readDecisionsState(home, "demo").sentThrough).toBe(ring[8]!.at);

    const log = logOf(home);
    expect(log.filter((l) => l.event === "decisions.failed").map((l) => l.status)).toEqual([404, 404, null]);
    expect(log.filter((l) => l.event === "decisions.sent").map((l) => l.rows)).toEqual([3, 3, 3]);
    expect(log.some((l) => l.event === "seen.failed")).toBe(false);
    // Never told to the player; the token never written.
    expect(readFileSync(agentPaths(home, "demo").notifications, "utf8")).not.toContain("decisions");
    expect(readFileSync(agentPaths(home, "demo").log, "utf8")).not.toContain("test-session-decisions");
    expect(readFileSync(decisionsPath(home, "demo"), "utf8")).not.toContain(PROMPT.trim());
  }, 60_000);
});

describe("in the runtime: the floor keeper's rows", () => {
  it("its trades with the preset's own reason, and a hold at most every 5 minutes while it is on; every row says the switch", async () => {
    const { home } = setup();
    const c = fakeClock(T0);
    const { feed, w } = world(c, () => ({ status: 200, body: { ok: true, stored: 1, ignored: 0 } }));
    recordHostAction(home, "demo", "buy", T0);
    await run(home, c, feed, w, T0 + 45 * MIN, async () => ({ ok: false, cause: "Claude Code exited 1: You have hit your usage limit." }));

    const ring = readDecisions(home, "demo");
    ring.forEach(contract);
    const asks = ring.filter((r) => r.source === "runtime-ask");
    expect(asks.length).toBeGreaterThanOrEqual(6);
    for (const r of asks) expect(r).toMatchObject({ action: "none", reason: "", result: "failed: Claude Code exited 1: You have hit your usage limit." });
    // The switch: off until the second failure, then on for the asks' failures.
    const on = Date.parse(logOf(home).find((l) => l.event === "autopilot.on")!.at);
    for (const r of ring) expect(r.keeper, r.at).toEqual(Date.parse(r.at) >= on + 15_000 ? { on: true, mode: "asks failing" } : Date.parse(r.at) < on ? { on: false, mode: "off" } : r.keeper);
    expect(readDecisionsState(home, "demo").keeper).toMatchObject({ on: true, mode: "asks failing" });

    const keeper = ring.filter((r) => r.source === "keeper");
    const trades = keeper.filter((r) => r.action === "buy" || r.action === "sell");
    const queued = logOf(home).filter((l) => l.event === "intent.queued" && l.source === "preset" && (l.kind === "buy" || l.kind === "sell"));
    expect(trades.length).toBeGreaterThan(0);
    expect(trades.length).toBeLessThanOrEqual(queued.length);
    // The preset's own words (cut to 140 characters if they are longer).
    for (const r of trades) expect(r.reason.startsWith("steady: ") && queued.some((l) => String(l.reason).startsWith(r.reason.replace(/…$/, "")))).toBe(true);
    for (const r of trades) expect(r.result).toMatch(/^(ok: (bought|sold) \S+ for [\d.]+ BNB|refused: .+|failed: .+)$/);
    const holds = keeper.filter((r) => r.action === "hold");
    expect(holds.length).toBeGreaterThan(0);
    for (const r of holds) {
      expect(r).toMatchObject({ reason: "steady: nothing to trade this pass", result: "ok: hold", keeper: { on: true, mode: "asks failing" } });
      const before = keeper.filter((k) => Date.parse(k.at) < Date.parse(r.at)).at(-1);
      if (before) expect(Date.parse(r.at) - Date.parse(before.at)).toBeGreaterThanOrEqual(5 * MIN - 15_000);
    }
  }, 60_000);
});

// --- FL answer --reason ----------------------------------------------------------------------------------------

const BIN = join(import.meta.dirname, "bin.mjs");
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout: splitHelp(stdout).text }));
    child.stdin?.end();
  });
}

describe("FL answer --reason: the hand-answered round, a hold's too", () => {
  const C1 = "0x000000000000000000000000000000000000c0e1";
  function answering(maxBuyBnb = 0.02) {
    const dir = tempDir();
    const prompt = join(dir, "strategy.md");
    writeFileSync(prompt, "Keep it small.\n");
    const home = join(dir, "home");
    const env = { FEAST_LEAGUE_HOME: home, FEAST_LEAGUE_MODEL: "other", FEAST_LEAGUE_HOST: "", FEAST_LEAGUE_BAW: "/nonexistent", FEAST_MAINNET_RPC_URL: "http://127.0.0.1:9", FEAST_LEAGUE_SITE: "http://127.0.0.1:9", FEAST_LEAGUE_DAEMON: "off" };
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady", ask: { every: 5, with: "none", model: null } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    writeFileSync(join(agentPaths(home, "demo").dir, "printed-pack.json"), JSON.stringify({ at: Date.now(), digest: "sha256:0123456789abcdef", maxBuyBnb, ids: [["c1", { coin: C1, symbol: "NOODFEED", held: false }]] }));
    return { home, env };
  }
  const answer = (a: Record<string, unknown>) => JSON.stringify({ action: "hold", coin: null, amountBnb: null, fraction: null, reason: "", memo: "", ...a });

  it("a hold with --reason writes it; without it, the answer's own reason (\"\" when it gives none); the row is the contract's", async () => {
    const { home, env } = answering();
    const before = Date.now();
    expect((await cli(["answer", "demo", answer({}), "--reason", "nothing has volume yet; waiting for the next launch"], env)).code).toBe(0);
    expect((await cli(["answer", "demo", answer({})], env)).code).toBe(0);
    expect((await cli(["answer", "demo", answer({ reason: "flat market" })], env)).code).toBe(0);
    expect((await cli(["answer", "demo", answer({ reason: "flat" }), "--reason", "x".repeat(200)], env)).code).toBe(0);
    const ring = readDecisions(home, "demo");
    ring.forEach(contract);
    expect(ring.map((r) => [r.source, r.action, r.reason, r.result])).toEqual([
      ["host-answer", "hold", "nothing has volume yet; waiting for the next launch", "ok: hold"],
      ["host-answer", "hold", "", "ok: hold"],
      ["host-answer", "hold", "flat market", "ok: hold"],
      ["host-answer", "hold", `${"x".repeat(139)}…`, "ok: hold"],
    ]);
    for (const r of ring) {
      expect(Date.parse(r.at)).toBeGreaterThanOrEqual(before);
      // No runtime runs: the keeper is off; the host as the headers say it.
      expect(r).toMatchObject({ keeper: { on: false, mode: "off" }, host: "other", strategy: { kind: "custom", sha8: createHash("sha256").update("Keep it small.\n").digest("hex").slice(0, 8) } });
    }
    // The log's answer.taken line now carries the reason too.
    const taken = logOf(home).filter((l) => l.event === "answer.taken");
    expect(taken.map((l) => l.reason)).toEqual(["nothing has volume yet; waiting for the next launch", "", "flat market", "x".repeat(200)]);
  }, 60_000);

  it("a buy is what FL buy's road reports: refused by the cap before any wallet call; the keeper's switch as the running runtime last kept it", async () => {
    const { home, env } = answering(1);
    writeKeeper(home, "demo", { on: true, mode: "host silent" }, Date.now());
    const out = await cli(["answer", "demo", answer({ action: "buy", coin: "c1", amountBnb: 0.5, reason: "big" }), "--reason", "all in on the busiest"], env);
    expect(out.code).toBe(2);
    const [r] = readDecisions(home, "demo");
    contract(r!);
    expect(r).toMatchObject({ source: "host-answer", action: "buy", reason: "all in on the busiest" });
    expect(r!.result).toMatch(/^refused: L3: .*0\.15 BNB cap/);
    // Not running: the switch on disk is a stopped runtime's, so the row says off.
    expect(r!.keeper).toEqual({ on: false, mode: "off" });
  }, 60_000);

  it("an answer not taken is a round where no decision came out: none, failed, and --reason kept", async () => {
    const { home, env } = answering(0.02);
    expect((await cli(["answer", "demo", answer({ action: "buy", coin: "c1", amountBnb: 0.5, reason: "big" }), "--reason", "too eager"], env)).code).toBe(2);
    expect((await cli(["answer", "demo", answer({ action: "buy", coin: "c9", amountBnb: 0.005 })], env)).code).toBe(2);
    const ring = readDecisions(home, "demo");
    ring.forEach(contract);
    expect(ring.map((r) => [r.source, r.action, r.reason])).toEqual([
      ["host-answer", "none", "too eager"],
      ["host-answer", "none", ""],
    ]);
    expect(ring[0]!.result).toMatch(/^failed: invalid answer: amountBnb 0\.5 is above the 0\.02 BNB a buy may be now/);
    expect(ring[1]!.result).toMatch(/^failed: invalid answer: .*c9/);
  }, 60_000);
});

// --- the docs ---------------------------------------------------------------------------------------------------

describe("the docs say what goes up, in the same words", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  const PRIVACY = "Each round's action and its one-line reason go to feast.meme with the heartbeat and are shown publicly five minutes later, as notes are; the strategy text never leaves this machine — only an 8-character hash of it, for the site's operators.";
  it("README, SKILL, ask-hosts and the CHANGELOG's league-v5.1.5 entry carry the privacy sentence verbatim; FL answer's usage and the routine name --reason", () => {
    for (const f of ["README.md", "skills/feast-league/SKILL.md", "docs/league/ask-hosts.md"]) expect(readFileSync(join(ROOT, f), "utf8"), f).toContain(PRIVACY);
    const log = readFileSync(join(ROOT, "docs/CHANGELOG.md"), "utf8");
    const unreleased = log.slice(log.indexOf("## league-v5.1.5\n"), log.indexOf("## league-v5.1.4\n"));
    expect(unreleased).toContain(PRIVACY);
    expect(unreleased).toContain("`FL answer --reason");
    expect(readFileSync(join(ROOT, "docs/league/ask-hosts.md"), "utf8")).toContain(`FL answer <name> '<the JSON object>' --reason "<one line: why, a hold's too>"`);
    expect(readFileSync(join(ROOT, "src/league/cli.ts"), "utf8")).toContain(`answer <name> '<json>' [--why "<one line>"] [--reason "<one line>"]`);
  });
});
