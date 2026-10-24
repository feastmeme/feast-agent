/**
 * The autopilot backup's dry run (task 975): the real CLI, the real entry flow and the real runtime loop, wired to
 * the test fakes. A made-up wallet and Agent ID, the fake signer and chain of `fakes.ts` (several coins whose sales
 * pay their mark), feast.meme and the indexer stubbed in process (every request and its headers written down),
 * throwaway homes under the system's temp folder, and a virtual clock per scene. Nothing reaches a network; nothing
 * is signed by a real wallet, launched, bought or POSTed for real.
 *
 *   npx tsx src/league/prompt/dryrun.ts > docs/league/autopilot-dryrun-<UTC stamp>.md
 *
 * (a) the cards: FL start with no flag and with --no-autopilot; FL enter's agent section and its "You're in" line, en
 * and zh. (b) the takeover: the host's last trade at Thursday 14:00 UTC+8, a note at 14:10 (which does not hold the
 * backup back), then nothing, run to 23:00. (c) a dump: one of its coins falls 50 % between two ticks. (d) a late
 * takeover, in the rush before the dinner. (e) the host comes back 20 minutes after the takeover. (f) the requests,
 * under four hosts. (g) an agent entered days ahead, at the season's opening instant. Scenes (b)–(g) are the floor
 * keeper alone, as for a Grok host (`--ask-with none`). Addendum 4's ask loop, through a stub `claude` on PATH run by
 * the real adapter: (h) its card and "You're in" lines; (i) asks every 5 minutes, with the pack; (j) a failure streak
 * and the floor keeper; (k) the dinner guard.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { callHost } from "../ask/host.ts";
import { readJournal } from "../ask/journal.ts";
import { BawSigner } from "../baw.ts";
import { FakeEnterSite, fakeEnterChain, INDEXER as ENTER_INDEXER, SITE as ENTER_SITE } from "../enter/fakes.ts";
import { enter } from "../enter/flow.ts";
import { coinRow, FakeFeed, INDEXER, seeded, SITE, snapshotBody, type Asked } from "../feed/fakes.ts";
import { HOST_HEADER, RUNTIME_HEADER } from "../headers.ts";
import { noteCommand } from "../notes/queue.ts";
import { short, utc8 } from "../register/copy.ts";
import { fakeBaw, leagueWire } from "../register/fakes.ts";
import { LeagueSite } from "../register/site.ts";
import { runAgent } from "../runtime.ts";
import { autopilotChoice } from "../start.ts";
import { agentPaths, readJson, writeJsonAtomic, writeStop } from "../store.ts";
import { FEAST, fakeClock, marketWorld } from "./fakes.ts";
import { dayCount, nextDinner, passesFloor } from "./floor.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BIN = join(import.meta.dirname, "../bin.mjs");
/** Thursday 10/29: the season's day 2 ends at its dinner, 21:00 UTC+8. */
const DINNER = Date.parse("2026-10-29T13:00:00Z");
const at8 = (hhmm: string) => DINNER - 21 * HOUR + Number(hhmm.slice(0, 2)) * HOUR + Number(hhmm.slice(3)) * MIN;
// Made up, every one of them: the coins, the own coin and the host's wallet.
const coin = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const OWN = coin(0xb0d1e);
const BOARD = [
  { coin: OWN, symbol: "MAPLEFEED", volume: 40, trades: 300 },
  { coin: FEAST, symbol: "FEAST", volume: 30, trades: 250 },
  { coin: coin(0xc0e1), symbol: "NOODFEED", volume: 9.4, trades: 120 },
  { coin: coin(0xc0e2), symbol: "KOIFEED", volume: 7.1, trades: 95 },
  { coin: coin(0xc0e3), symbol: "MOTHFEED", volume: 5.2, trades: 80 },
  { coin: coin(0xc0e4), symbol: "FIGFEED", volume: 2.8, trades: 44 },
  { coin: coin(0xc0e5), symbol: "NEWFEED", volume: 12, trades: 60, young: true },
];
const symbolOf = new Map(BOARD.map((b) => [b.coin.toLowerCase(), b.symbol]));
// The day's count leaves out the agent's own coin only: FEAST counts (addendum 7, as the settlement engine counts it).
const OWN_SET = [OWN.toLowerCase()];

const roots: string[] = [];
const tmpRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "feast-league-975-dryrun-"));
  roots.push(root);
  return root;
};
const out: string[] = [];
const hide = (text: string) => roots.reduce((t, r) => t.split(r).join("<tmp>"), text).replace(/0x[0-9a-fA-F]{40}/g, (a) => short(a));
const say = (line = "") => out.push(hide(line));
const section = (title: string) => say(`\n## ${title}\n`);
const block = (text: string) => say(["```text", text.trimEnd(), "```"].join("\n"));
const bnb = (wei: unknown) => Number((Number(BigInt(String(wei))) / 1e18).toFixed(6));
const hm = (ms: number) => utc8(ms, false);

// --- (a) the cards -------------------------------------------------------------------------------------

function cliCards(): void {
  section("(a) The cards");
  const root = tmpRoot();
  const promptPath = join(root, "strategy.md");
  writeFileSync(promptPath, "Ride what the crowd is buying, small; sell at -15% or after an hour.\nOne note per trade.\n");
  // Every route on a closed port: a card needs no wallet and no site.
  const env = { ...process.env, FEAST_LEAGUE_HOME: join(root, "home"), FEAST_LEAGUE_BAW: join(root, "no-baw"), FEAST_MAINNET_RPC_URL: "http://127.0.0.1:9", FEAST_LEAGUE_SITE: "http://127.0.0.1:9", FEAST_LEAGUE_INDEXER: "http://127.0.0.1:9" };
  for (const [title, args] of [
    ["`FL start demo --prompt strategy.md` (no flag: the backup is on)", ["start", "demo", "--prompt", promptPath]],
    ["`FL start demo2 --prompt strategy.md --no-autopilot`", ["start", "demo2", "--prompt", promptPath, "--no-autopilot"]],
  ] as const) {
    const run = spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 60_000 });
    say(`### ${title} (exit ${run.status})\n`);
    block(run.stdout);
  }
}

async function enterCards(): Promise<void> {
  const ON = leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } });
  for (const [lang, seasonOn] of [["en", false], ["zh", false], ["en", true], ["zh", true]] as const) {
    const root = tmpRoot();
    const home = join(root, "home");
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    // A key made for this run only, never printed: the fake wallet signs with it, nothing else does.
    const account = privateKeyToAccount(generatePrivateKey());
    const { runner } = fakeBaw({ account });
    const site = new FakeEnterSite({ wallet: account.address, agentId: { agentId: "maplegrin" }, avatar: { status: 200 }, session: { status: 201, body: { token: "tok-dry", expiresAt: "2026-11-04T13:00:00.000Z", season: 1 } }, ...(seasonOn ? { league: ON } : {}) });
    const deps = {
      home,
      signer: new BawSigner(runner),
      chain: fakeEnterChain({ agentId: "maplegrin" }),
      site: new LeagueSite(ENTER_SITE, site.fetch),
      indexer: ENTER_INDEXER,
      fetch: site.fetch,
      now: () => (seasonOn ? at8("14:00") : Date.parse("2026-10-24T13:00:00Z")),
      notesDev: false,
      signOptions: { pollMs: 1, sleep: async () => {} },
      cwd,
      start: async () => 4242,
      oneShot: async () => {
        throw new Error("the dry run never launches");
      },
    };
    const card = await enter(deps, { name: "maplegrin.ai", yes: false, lang });
    const text = card.text;
    const from = text.indexOf(lang === "zh" ? "策略：" : "Strategy:");
    const when = seasonOn ? "once the season is on (Thursday 14:00 UTC+8)" : "before the season (Saturday)";
    if (!seasonOn) {
      say(`### \`FL enter --name maplegrin.ai --lang ${lang}\`, ${when}: the entry card's table, with the signing domain and both messages' fields\n`);
      block(text.slice(0, text.indexOf("\n\n", text.indexOf("| --- | --- |"))));
      say(`### \`FL enter --name maplegrin.ai --lang ${lang}\`, ${when}: the agent section under the entry card\n`);
      block(text.slice(from, text.lastIndexOf("\n\n")));
    } else {
      say(`### \`FL enter --name maplegrin.ai --lang ${lang}\`, ${when}: the last row of the entry card, and the lines under the agent's card\n`);
      block([...text.split("\n").filter((l) => l.startsWith(lang === "zh" ? "| 最后 |" : "| Last |")), ...text.slice(from, text.lastIndexOf("\n\n")).split("\n").slice(-2)].join("\n"));
    }
    const done = await enter(deps, { name: "maplegrin.ai", yes: true, lang });
    say(`### \`FL enter … --yes --lang ${lang}\`, ${when}: the last line\n`);
    block(done.text.split("\n").at(-1)!);
    say(`\`FL enter --json\`'s \`autopilot\`: \`${JSON.stringify(done.data.autopilot)}\``);
  }
}

// --- the loop's world ------------------------------------------------------------------------------------

type Scene = { home: string; feed: FakeFeed; w: ReturnType<typeof marketWorld>; c: ReturnType<typeof fakeClock> };

function scene(start: number, o: { confirmedAt?: number; league?: () => unknown; hostTradedAt?: number; ask?: { every: number; with: "claude" | "codex" } } = {}): Scene {
  const root = tmpRoot();
  const promptPath = join(root, "strategy.md");
  writeFileSync(promptPath, "Ride what the crowd is buying, small.\n");
  // As FL enter plans it: neither flag, so the default backup.
  const choice = autopilotChoice({});
  const planned = planAgent({ name: "maplegrin", promptPath, preset: choice.ok ? choice.preset : undefined, ...(o.ask ? { ask: { ...o.ask, model: null } } : {}) });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  const home = join(root, "home");
  saveAgent(home, { ...confirmAgent(planned.agent, new Date(o.confirmedAt ?? Date.parse("2026-10-24T13:00:00Z"))), league: { waitForSeason: true } });
  writeJsonAtomic(join(agentPaths(home, "league-entry").dir, "entry.json"), { agentId: "maplegrin", bodyCoin: OWN, launchTx: null });
  // The host was trading before the scene starts: its last trade, as the runtime writes it down.
  if (o.hostTradedAt !== undefined) writeJsonAtomic(join(agentPaths(home, "maplegrin").dir, "host.json"), { at: new Date(o.hostTradedAt).toISOString(), what: "buy" });
  const c = fakeClock(start);
  const w = marketWorld({ coins: BOARD.map((b) => ({ coin: b.coin, symbol: b.symbol })), now: c.now });
  const rows = BOARD.map((b) => coinRow(b.coin, { symbol: b.symbol, volume24hBnb: b.volume, trades24h: b.trades, launchedAt: b.young ? new Date(start - 20 * MIN).toISOString() : "2026-10-20T00:00:00.000Z" }));
  const feed = new FakeFeed(c.now, () => ({ status: 200, body: snapshotBody({ coins: rows }), etag: '"day2"' }));
  const league = o.league ?? (() => leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } }));
  feed.other = (url) => (url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: league() } : url.origin === SITE && url.pathname === "/api/league/notes" ? { status: 201, body: {} } : null);
  return { home, feed, w, c };
}

const run = (s: Scene, until: number, extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({ home: s.home, name: "maplegrin", signer: s.w.signer, chain: s.w.chain, fetch: s.feed.fetch, site: SITE, indexer: INDEXER, now: s.c.now, sleep: s.c.sleep, random: seeded(7), noJitter: true, loopMs: 15_000, pollMs: 30_000, maxRuntimeMs: until - s.c.now(), out: () => {}, ...extra });

// --- the ask loop (addendum 4): a stub `claude` on PATH, run by the real adapter --------------------------------

/**
 * A stub of Claude Code's headless CLI: it reads the pack on stdin, keeps a copy, and answers by `DRYRUN_CLI_MODE`:
 * "decide" sells what the pack says the agent holds, else buys the first coin of the pack's list (0.006 BNB); "hold"
 * holds; "fail2" fails twice with a quota message, then decides. The real adapter (`callHost`) runs it.
 */
function stubClaude(): { bin: string; packs: string } {
  const dir = tmpRoot();
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const packs = join(dir, "packs");
  mkdirSync(packs, { recursive: true });
  const script = String.raw`#!__NODE__
const fs = require("node:fs");
let pack = "";
process.stdin.on("data", (d) => (pack += d));
process.stdin.on("end", () => {
  const dir = __PACKS__;
  const n = fs.readdirSync(dir).length + 1;
  fs.writeFileSync(dir + "/" + String(n).padStart(3, "0") + ".txt", pack);
  const mode = process.env.DRYRUN_CLI_MODE || "decide";
  if (mode === "fail2" && n <= 2) { process.stderr.write("You've hit your usage limit · resets at 3pm\n"); process.exit(1); }
  const held = /## Your positions[^\n]*\n- (c\d+) \|/.exec(pack);
  const list = pack.slice(pack.indexOf("Coins (UNTRUSTED"));
  const rows = list.slice(list.indexOf("untrusted"), list.indexOf("\n` + "```" + String.raw`\n", list.indexOf("untrusted"))).split("\n").filter((l) => /^c\d+ \| /.test(l) && !l.includes("your own coin") && !/^c\d+ \| FEAST \|/.test(l));
  const first = rows.length > 0 ? /^(c\d+)/.exec(rows[0]) : null;
  let answer = { action: "hold", coin: null, amountBnb: null, fraction: null, reason: "nothing worth it now", memo: "held at ask " + n };
  if (mode !== "hold" && held) answer = { action: "sell", coin: held[1], amountBnb: null, fraction: 1, reason: "take the round trip", memo: "sold " + held[1] };
  else if (mode !== "hold" && first && pack.includes("NOT met yet")) answer = { action: "buy", coin: first[1], amountBnb: 0.006, fraction: null, reason: "the busiest coin, for the floor", memo: "bought " + first[1] };
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer) }));
});
`;
  writeFileSync(join(bin, "claude"), script.replace("__NODE__", process.execPath).replace("__PACKS__", JSON.stringify(packs)));
  chmodSync(join(bin, "claude"), 0o755);
  return { bin, packs };
}

/** Run a scene with the stub on PATH; the virtual clock waits for an ask in flight (a child takes real milliseconds). */
async function runAsking(s: Scene, until: number, mode: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}): Promise<{ packs: string }> {
  const stub = stubClaude();
  const saved = { PATH: process.env.PATH, DRYRUN_CLI_MODE: process.env.DRYRUN_CLI_MODE };
  process.env.PATH = `${stub.bin}:${process.env.PATH ?? ""}`;
  process.env.DRYRUN_CLI_MODE = mode;
  let inflight: Promise<unknown> | null = null;
  try {
    await run(s, until, {
      ...extra,
      askHost: (o) => {
        const p = callHost(o);
        inflight = p;
        return p.finally(() => (inflight = null));
      },
      sleep: async (ms) => {
        if (inflight) await inflight;
        await s.c.sleep(ms);
      },
    });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.DRYRUN_CLI_MODE === undefined) delete process.env.DRYRUN_CLI_MODE;
    else process.env.DRYRUN_CLI_MODE = saved.DRYRUN_CLI_MODE;
  }
  return { packs: stub.packs };
}

function journalTable(home: string): void {
  const rows = readJournal(home, "maplegrin", 100);
  say(["| asked (UTC+8) | pack | answer | reason | result |", "| --- | --- | --- | --- | --- |", ...rows.map((r) => `| ${hm(Date.parse(r.at))} | ${r.pack} | ${r.action}${r.symbol ? ` ${r.symbol}` : ""}${r.amountBnb !== null ? ` ${r.amountBnb} BNB` : ""}${r.fraction !== null ? ` ${r.fraction} of it` : ""} | ${r.reason} | ${r.result} |`)].join("\n"));
}

async function askCards(): Promise<void> {
  section("(h) The ask loop's words: the card and the \"You're in\" line under Claude Code");
  const saved = process.env.FEAST_LEAGUE_MODEL;
  process.env.FEAST_LEAGUE_MODEL = "claude";
  try {
    const ON = leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } });
    for (const [lang, seasonOn] of [["en", false], ["zh", false], ["en", true], ["zh", true]] as const) {
      const root = tmpRoot();
      const cwd = join(root, "work");
      mkdirSync(cwd, { recursive: true });
      const account = privateKeyToAccount(generatePrivateKey());
      const { runner } = fakeBaw({ account });
      const site = new FakeEnterSite({ wallet: account.address, agentId: { agentId: "maplegrin" }, avatar: { status: 200 }, session: { status: 201, body: { token: "tok-dry", expiresAt: "2026-11-04T13:00:00.000Z", season: 1 } }, ...(seasonOn ? { league: ON } : {}) });
      const deps = { home: join(root, "home"), signer: new BawSigner(runner), chain: fakeEnterChain({ agentId: "maplegrin" }), site: new LeagueSite(ENTER_SITE, site.fetch), indexer: ENTER_INDEXER, fetch: site.fetch, now: () => (seasonOn ? at8("14:00") : Date.parse("2026-10-24T13:00:00Z")), notesDev: false, signOptions: { pollMs: 1, sleep: async () => {} }, cwd, start: async () => 4242, oneShot: async () => { throw new Error("the dry run never launches"); } };
      const card = await enter(deps, { name: "maplegrin.ai", yes: false, lang });
      if (lang === "en" && !seasonOn) {
        say("### The agent's card under the entry card: the ask loop and the floor keeper\n");
        block(card.text.split("\n").filter((l) => l.startsWith("Ask loop:") || l.startsWith("Floor keeper:")).join("\n"));
      }
      const done = await enter(deps, { name: "maplegrin.ai", yes: true, lang });
      say(`### \`FL enter … --yes --lang ${lang}\`, ${seasonOn ? "once the season is on" : "before the season"}: the last line\n`);
      block(done.text.split("\n").at(-1)!);
    }
  } finally {
    if (saved === undefined) delete process.env.FEAST_LEAGUE_MODEL;
    else process.env.FEAST_LEAGUE_MODEL = saved;
  }
}

async function askTick(): Promise<void> {
  section("(i) Asks: every 5 minutes of the host's silence, through a stub `claude` on PATH and the real adapter");
  say("The host's last trade at 13:55 UTC+8, then its session ends. Every 5 minutes the runtime builds the pack, runs `claude -p --output-format json --max-turns 1 --tools \"\" --strict-mcp-config --disable-slash-commands --no-session-persistence --json-schema …` with the pack on stdin, checks the answer and makes it. The stub buys the first coin of the list while the floor is unmet, and sells what it holds.\n");
  const s = scene(at8("14:00"), { hostTradedAt: at8("13:55"), ask: { every: 5, with: "claude" } });
  const { packs } = await runAsking(s, at8("14:31"), "decide");
  journalTable(s.home);
  const packLines = logOf(s.home).filter((l) => l.event === "ask.pack");
  say(`\n${packLines.length} packs; each one's digest, size and requests to feast.meme: ${packLines.map((l) => `${String(l.pack)} (${String(l.chars)} characters, ${String(l.coins)} coins, ${String(l.requests)} requests)`).join("; ")}.\n`);
  fillTable(fills(s.home));
  const first = readdirSync(packs).sort()[0];
  if (first) {
    say("\nThe first pack, as the stub received it on stdin (addresses 6+4 here; the schema line cut):\n");
    block(readFileSync(join(packs, first), "utf8").split("\n").map((l) => (l.startsWith('{"type":"object"') ? `${l.slice(0, 80)}…` : l)).join("\n"));
  }
}

async function askFailing(): Promise<void> {
  section("(j) A failure streak: the stub fails twice (a quota), the floor keeper trades, then the asks answer again");
  const s = scene(at8("14:00"), { hostTradedAt: at8("13:55"), ask: { every: 5, with: "claude" } });
  await runAsking(s, at8("14:46"), "fail2");
  journalTable(s.home);
  say("");
  events(s.home, ["autopilot.on", "autopilot.off"]);
  const notices = existsSync(agentPaths(s.home, "maplegrin").notifications) ? readFileSync(agentPaths(s.home, "maplegrin").notifications, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; text: string }).filter((n) => n.kind === "ask" || n.kind === "autopilot") : [];
  say(`\nThe notifications:\n${notices.map((n) => `- ${hm(Date.parse(n.at))} ${n.kind}: ${n.text}`).join("\n")}\n`);
  fillTable(fills(s.home));
}

/** The snapshot as lane 976 sends it (docs/api/snapshot.md): `schemaMinor`, its six `features` flags, and per coin its windows, flow, impacts and meta. */
function serverSide(s: Scene): void {
  const rows = BOARD.map((b) => ({
    ...coinRow(b.coin, { symbol: b.symbol, volume24hBnb: b.volume, trades24h: b.trades, launchedAt: b.young ? new Date(s.c.now() - 20 * MIN).toISOString() : "2026-10-20T00:00:00.000Z" }),
    windows: { "5m": { changePct: 0.5, volumeBnb: b.volume / 288, trades: 2, buys: 1, sells: 1 }, "15m": { changePct: 1.2, volumeBnb: b.volume / 96, trades: 6, buys: 3, sells: 3 }, "1h": { changePct: -2, volumeBnb: b.volume / 24, trades: 20, buys: 10, sells: 10 }, "24h": { changePct: 15, volumeBnb: b.volume, trades: b.trades, buys: b.trades / 2, sells: b.trades / 2 } },
    flow2m: { buys: 1, sells: 1, buyBnb: 0.01, sellBnb: 0.008, netBnb: 0.002, largestTradeBnb: 0.01, uniquePayers: 2 },
    impact: { buy: { "0.005": 0.3, "0.01": 0.6, "0.02": 1.2, "0.05": 3 }, sell: { "0.005": 0.4, "0.01": 0.8, "0.02": 1.6, "0.05": 4 }, roundTripFeePct: 2.0096, asOf: new Date(s.c.now() - 60_000).toISOString(), movedPct: 0.1 },
    meta: { type: "bnb", quoteSymbol: "WBNB", marketCapBnb: 10, openingCapBnb: null, openingCapBinding: false, roundTripFeePct: 2.0096, ageMinutes: 600 },
    underlying: null,
  }));
  s.feed.snapshot = () => ({ status: 200, body: { ...snapshotBody({ coins: rows }), schemaMinor: 1, features: ["windows", "flow", "launches", "impact", "freshness", "clock"], launches: [], freshness: { builtAt: new Date(s.c.now() - 2_000).toISOString(), lagSeconds: 2 }, mostActive15m: BOARD.slice(2).map((b) => b.coin.toLowerCase()) }, etag: '"srv"' });
  const league = leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(DINNER).toISOString() } });
  const field = Array.from({ length: 30 }, (_, i) => ({ rank: i + 1, name: `agent${i + 1}.ai`, wallet: `0x${(0xaa00 + i).toString(16).padStart(40, "0")}`, pnlBnb: 0.01 - i * 0.001, danger: i > 25, eaten: null, bodyCoin: null, hp: 0 }));
  s.feed.other = (url) => (url.origin === SITE && url.pathname === "/api/league" ? { status: 200, body: url.searchParams.get("field") === "1" ? { ...league, field } : league } : null);
}

async function atScale(): Promise<void> {
  section("(l) At 10,000 agents: the server's picture, the field, the snapshot by need (addendum 6)");
  say("The same asks as (i), twice: on today's snapshot (the candles and the quoter local), and on the snapshot lane 976 sends (`schemaMinor: 1`, `features`: windows, flow, launches, impact, freshness, clock) with lane 978's `field=1`. Then 30 minutes flat and 30 minutes holding, counting the snapshot reads.\n");
  const rows: string[] = ["| the snapshot | requests to feast.meme per ask (league + candles) | quotes per ask | asked with `me=` | from |", "| --- | --- | --- | --- | --- |"];
  for (const server of [false, true]) {
    const s = scene(at8("14:00"), { hostTradedAt: at8("13:55"), ask: { every: 5, with: "claude" } });
    if (server) serverSide(s);
    await runAsking(s, at8("14:16"), "hold");
    const packs = logOf(s.home).filter((l) => l.event === "ask.pack");
    const withMe = s.feed.asked.filter((a) => a.url.includes("/api/league?") && a.url.includes("me=")).length;
    rows.push(`| ${server ? "with features (lane 976) and field=1 (978)" : "today's (no features)"} | ${packs.map((l) => String(l.requests)).join(", ")} | ${server ? 0 : "up to 12"} | ${withMe} | ${server ? "server windows, flow, impacts, meta; the field's standing" : "local candles and quotes; the arena's standing"} |`);
  }
  say(rows.join("\n"));
  say("");
  const counts: string[] = ["| 30 minutes | snapshot reads | the cadence |", "| --- | --- | --- |"];
  for (const holding of [false, true]) {
    const s = scene(at8("14:00"), { hostTradedAt: at8("13:55"), ask: { every: 5, with: "claude" } });
    if (holding) hostBuy(s, at8("14:00"), BOARD[2]!.coin, 0.004);
    await runAsking(s, at8("14:30"), "hold", { pollMs: 5_000, loopMs: 1_000 }).catch(() => undefined);
    const cadence = readFileSync(join(agentPaths(s.home, "maplegrin").dir, "cadence.json"), "utf8");
    counts.push(`| ${holding ? "holding a position" : "flat"} | ${s.feed.snapshots().length} | ${(JSON.parse(cadence) as { mode: string; why: string }).mode}: ${(JSON.parse(cadence) as { why: string }).why} |`);
  }
  say(counts.join("\n"));
  say("\n(At the default `--poll 5`: fast mode is every 5–8 s, a flat agent every 30–60 s and once before each of its 6 asks. Before this addendum a listening strategy read every 5–8 s all day; a flat agent now reads about a sixth as often as a fast one, and the CDN answers most of those with a 304.)");
}

async function askGuard(): Promise<void> {
  section("(k) The dinner guard: the AI only holds; 20 minutes before dinner the floor keeper fills the floor");
  const s = scene(DINNER - 70 * MIN, { hostTradedAt: DINNER - 75 * MIN, ask: { every: 5, with: "claude" } });
  await runAsking(s, DINNER, "hold");
  events(s.home, ["autopilot.on", "autopilot.off"]);
  say("");
  fillTable(fills(s.home));
  const passed = fills(s.home).find((f) => f.day.passed);
  say(`\nThe day's floor: ${passed ? `passed at ${hm(passed.t)} UTC+8` : "not passed"}; the last fill at ${hm(Math.max(...fills(s.home).map((f) => f.t)))} UTC+8 (flat by dinner − 5). The asks in the hour before (all holds) are in the journal: ${readJournal(s.home, "maplegrin", 100).length} of them.`);
}

/** The host's FL buy, as the CLI hands it to the running agent: its inbox. */
const hostBuy = (s: Scene, when: number, target: Address, size: number) =>
  s.c.at(when, () => {
    mkdirSync(agentPaths(s.home, "maplegrin").inbox, { recursive: true });
    writeJsonAtomic(join(agentPaths(s.home, "maplegrin").inbox, `${when}-buy.json`), { type: "intent", requestId: `host-${when}`, request: { kind: "buy", coin: target, bnb: size, reason: "manual buy" } });
  });

type Line = Record<string, unknown> & { event: string; at: string };
const logOf = (home: string): Line[] =>
  existsSync(agentPaths(home, "maplegrin").log)
    ? readFileSync(agentPaths(home, "maplegrin").log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Line)
    : [];

/** Every fill, who asked for it, and the day's count right after it (the runtime's own count at that instant). */
function fills(home: string) {
  const log = logOf(home);
  const source = new Map(log.filter((l) => l.event === "intent.queued").map((l) => [String(l.id), String(l.source)]));
  const reason = new Map(log.filter((l) => l.event === "intent.queued").map((l) => [String(l.id), String(l.reason)]));
  const BY: Record<string, string> = { preset: "steady", manual: "host", runtime: "runtime (L6)" };
  // The ask loop's trades take the manual road, with a reason of their own.
  const by = (id: string) => (source.get(id) === "manual" && (reason.get(id) ?? "").startsWith("ask:") ? "ask" : BY[source.get(id) ?? ""] ?? "?");
  // The count after each fill, in the log's order: the runtime's own rule (`floor.ts`), one fill at a time.
  const days = new Map<number, { trades: number; volumeBnb: number }>();
  return log
    .filter((l) => l.event === "buy.filled" || l.event === "sell.filled")
    .map((l) => {
      const t = Date.parse(l.at);
      const side = l.event === "buy.filled" ? "buy" : "sell";
      const wei = side === "buy" ? l.bnbInWei : l.bnbOutWei;
      const key = nextDinner(t);
      const day = days.get(key) ?? { trades: 0, volumeBnb: 0 };
      if (!OWN_SET.includes(String(l.coin).toLowerCase())) days.set(key, (day.trades += 1, (day.volumeBnb += bnb(wei)), day));
      const passed = passesFloor(day.trades, day.volumeBnb);
      return { t, by: by(String(l.id)), side, coin: String(l.coin), bnb: bnb(wei), reason: reason.get(String(l.id)) ?? "", day: { trades: day.trades, volumeBnb: day.volumeBnb, passed } };
    });
}

function fillTable(rows: ReturnType<typeof fills>): void {
  const lines = ["| time (UTC+8) | by | side | coin | BNB | the day's count after it |", "| --- | --- | --- | --- | --- | --- |"];
  for (const r of rows) lines.push(`| ${hm(r.t)} | ${r.by} | ${r.side} | ${symbolOf.get(r.coin.toLowerCase()) ?? "?"} ${short(r.coin)} | ${r.bnb} | ${r.day.trades} trade${r.day.trades === 1 ? "" : "s"}, ${Number(r.day.volumeBnb.toFixed(6))} BNB: ${r.day.passed ? "**passed**" : "not yet"} |`);
  say(lines.join("\n"));
}

function events(home: string, names: string[]): void {
  for (const l of logOf(home).filter((x) => names.includes(x.event))) say(`- ${hm(Date.parse(l.at))} \`${l.event}\`${l.event.startsWith("autopilot") ? ` (preset ${String(l.preset)}, idle ${String(l.idleMinutes)} min)` : ""}`);
}

/** The first hour after the takeover (cut at the dinner): steady's own fills, their BNB, and when the day's floor was passed. */
function firstHour(home: string): { on: number; fills: number; volume: number; passedAt: number | null; spend: number } {
  const on = Date.parse(logOf(home).find((l) => l.event === "autopilot.on")!.at);
  const all = fills(home);
  const mine = all.filter((f) => f.by === "steady" && f.t >= on && f.t <= Math.min(on + HOUR, nextDinner(on) - 1));
  const passed = all.find((f) => f.day.passed && f.t >= nextDinner(on) - 24 * HOUR && f.t < nextDinner(on));
  const spend = all.filter((f) => f.by === "steady" && f.side === "buy" && f.t >= nextDinner(on) - 24 * HOUR && f.t < nextDinner(on)).reduce((s, f) => s + f.bnb, 0);
  return { on, fills: mine.length, volume: Number(mine.reduce((s, f) => s + f.bnb, 0).toFixed(6)), passedAt: passed?.t ?? null, spend: Number(spend.toFixed(6)) };
}

function numbers(label: string, n: ReturnType<typeof firstHour>): void {
  say(
    `**${label}:** the backup took over at ${hm(n.on)} UTC+8; in its first 60 minutes, **${n.fills} fills and ${n.volume} BNB of volume** by steady; the day's floor was **${n.passedAt ? `passed at ${hm(n.passedAt)} UTC+8` : "not passed"}**; steady's buys that day: ${n.spend} BNB.`,
  );
}

// --- (b) the takeover --------------------------------------------------------------------------------------

async function takeover(): Promise<void> {
  section("(b) The takeover: the host's session ends at 14:00 UTC+8");
  say("Planned as `FL enter` plans it (`steady`, 30 minutes), confirmed on Saturday, waiting for the season; the stub `/api/league` says season 1, day 2. The host's last trade is an `FL buy` of 0.004 BNB at 14:00 UTC+8; at 14:10 it writes an `FL note`, which no longer holds the backup back (ruling C6); then its session ends. The run goes to 23:00 UTC+8. The board: the own coin MAPLEFEED and FEAST are the busiest and never bought; NEWFEED is 20 minutes old and too young.\n");
  const s = scene(at8("13:55"), { hostTradedAt: at8("13:40") });
  hostBuy(s, at8("14:00"), BOARD[5]!.coin, 0.004);
  s.c.at(at8("14:10"), () => void noteCommand({ home: s.home, name: "maplegrin", site: SITE, fetch: s.feed.fetch, wallet: async () => null, now: s.c.now }, { text: "watching the board; nothing to do" }));
  await run(s, at8("23:00"));
  events(s.home, ["season.open", "autopilot.on", "autopilot.off"]);
  say("");
  fillTable(fills(s.home));
  say("");
  const n = firstHour(s.home);
  numbers("(b)", n);
  const all = fills(s.home);
  const quiet = all.filter((f) => f.t > n.on + HOUR && f.t < DINNER);
  say(`\nThe quiet afternoon: ${quiet.length} fill${quiet.length === 1 ? "" : "s"} between ${hm(n.on + HOUR)} and 21:00 UTC+8 (the day's floor met, it only waits for its exits). The day ends at 21:00: ${dayCount(s.home, "maplegrin", DINNER - 1, OWN_SET).trades} trades, ${Number(dayCount(s.home, "maplegrin", DINNER - 1, OWN_SET).volumeBnb.toFixed(6))} BNB. The next day starts from nothing at 21:00, and at 23:00 it stands at ${dayCount(s.home, "maplegrin", at8("23:00"), OWN_SET).trades} trades, ${Number(dayCount(s.home, "maplegrin", at8("23:00"), OWN_SET).volumeBnb.toFixed(6))} BNB: ${dayCount(s.home, "maplegrin", at8("23:00"), OWN_SET).passed ? "passed" : "not yet"}.`);
  results.b = n;
}

// --- (c) a dump --------------------------------------------------------------------------------------------

async function dump(): Promise<void> {
  section("(c) A dump: one of its coins falls 50 % between two ticks");
  const s = scene(at8("14:25"), { hostTradedAt: at8("14:00") });
  // NOODFEED, its first buy, halves 20 minutes after the takeover.
  s.c.at(at8("14:50") + 30_000, () => s.w.move(BOARD[2]!.coin, 0.5));
  await run(s, at8("17:00"));
  events(s.home, ["autopilot.on"]);
  say("");
  fillTable(fills(s.home));
  say("");
  const n = firstHour(s.home);
  numbers("(c)", n);
  results.c = n;
}

// --- (d) a late takeover -------------------------------------------------------------------------------------

async function late(): Promise<void> {
  section("(d) A late takeover: the host quiet from 19:50 UTC+8, the backup on at 20:20, in the rush");
  const s = scene(at8("19:45"), { hostTradedAt: at8("19:30") });
  hostBuy(s, at8("19:50"), BOARD[5]!.coin, 0.004);
  await run(s, at8("21:30"));
  events(s.home, ["autopilot.on"]);
  say("");
  fillTable(fills(s.home));
  say("");
  const n = firstHour(s.home);
  numbers("(d)", n);
  results.d = n;
}

// --- (e) the host comes back ---------------------------------------------------------------------------------

async function back(): Promise<void> {
  section("(e) The host comes back: an `FL buy` 20 minutes after the takeover");
  const s = scene(at8("14:25"), { hostTradedAt: at8("14:00") });
  hostBuy(s, at8("14:50"), BOARD[5]!.coin, 0.004);
  await run(s, at8("16:00"));
  events(s.home, ["autopilot.on", "autopilot.off"]);
  say("");
  fillTable(fills(s.home));
  const log = logOf(s.home);
  const off = Date.parse(log.find((l) => l.event === "autopilot.off")!.at);
  const buys = log.filter((l) => l.event === "intent.queued" && l.source === "preset" && l.kind === "buy" && Date.parse(l.at) > off).map((l) => Date.parse(l.at));
  say(`\nAfter \`autopilot.off\` at ${hm(off)}: steady's next buy intent ${buys.length ? `at ${hm(buys[0]!)}` : "none before 16:00"} (no buy before ${hm(off + 30 * MIN)}, 30 minutes after the host's trade). The position it opened before the host traded keeps its exits (ruling C7): its sales while it stood by are in the table above.`);
}

// --- (f) the requests ------------------------------------------------------------------------------------------

async function requests(): Promise<void> {
  section("(f) The requests, under four hosts");
  say("A short run each (the gate's `/api/league`, the market, a note's flush), then one with `--live` for the indexer's routes. Every request the stubs saw: feast.meme's carry both headers, the indexer's neither.\n");
  const keys = ["FEAST_LEAGUE_MODEL", "FEAST_LEAGUE_HOST", "CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "LEAGUE_NOTES_DEV"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const [label, env] of [
      ["FEAST_LEAGUE_MODEL=grok", { FEAST_LEAGUE_MODEL: "grok" }],
      ["CLAUDECODE=1", { CLAUDECODE: "1" }],
      ["CODEX_SANDBOX=1", { CODEX_SANDBOX: "1" }],
      ["none", {}],
    ] as const) {
      for (const k of keys) delete process.env[k];
      // Notes unsigned, as LEAGUE_NOTES_DEV=1 sends them, so the flush reaches the stub without a session.
      Object.assign(process.env, env, { LEAGUE_NOTES_DEV: "1" });
      const asked: Asked[] = [];
      for (const live of [false, true]) {
        const s = scene(at8("14:40"), { hostTradedAt: at8("14:00") });
        await noteCommand({ home: s.home, name: "maplegrin", site: SITE, fetch: s.feed.fetch, wallet: async () => null, now: s.c.now }, { text: "watching" });
        await run(s, at8("14:43"), { live });
        asked.push(...s.feed.asked);
      }
      const seen = new Map<string, Asked>();
      for (const a of asked) {
        const u = new URL(a.url);
        const key = `${a.method} ${u.origin === SITE ? "feast.meme" : "indexer"} ${u.pathname}`;
        if (!seen.has(key)) seen.set(key, a);
      }
      say(`### ${label}\n`);
      say(["| request | x-feast-host | x-feast-runtime | other headers |", "| --- | --- | --- | --- |", ...[...seen.entries()].map(([k, a]) => `| ${k} | ${a.headers[HOST_HEADER] ?? "—"} | ${a.headers[RUNTIME_HEADER] ?? "—"} | ${Object.keys(a.headers).filter((h) => h !== HOST_HEADER && h !== RUNTIME_HEADER).join(", ") || "—"} |`)].join("\n"));
      say(`\n${asked.length} requests in all: ${asked.filter((a) => a.url.startsWith(SITE)).length} to feast.meme, each with both headers: ${asked.filter((a) => a.url.startsWith(SITE)).every((a) => a.headers[HOST_HEADER] && a.headers[RUNTIME_HEADER] === "league-v5")}; ${asked.filter((a) => a.url.startsWith(INDEXER)).length} to the indexer, any with either: ${asked.filter((a) => a.url.startsWith(INDEXER)).some((a) => a.headers[HOST_HEADER] || a.headers[RUNTIME_HEADER])}.\n`);
    }
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- (g) entered days ahead: the opening instant ----------------------------------------------------------------

async function opening(): Promise<void> {
  section("(g) Entered on Saturday, the host quiet since: the opening instant, Wednesday 20:00 UTC+8");
  const opensAt = Date.parse("2026-10-28T12:00:00Z");
  const s = scene(opensAt - 10 * MIN, { confirmedAt: Date.parse("2026-10-24T13:00:00Z"), league: () => leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(Date.parse("2026-10-27T13:00:00Z")).toISOString() } }) });
  await run(s, opensAt + 90 * MIN);
  events(s.home, ["season.open", "autopilot.on"]);
  say("");
  fillTable(fills(s.home));
  say("\nThe silence counts from the yes, so the backup is on at the opening instant (here with `--no-jitter`; `FL enter` starts with the jitter, 0–120 s). The opening hour is the last hour before dinner 1, the warm-up dinner: it eats nobody and asks no floor (addendum 8), so the backup stands on but makes no trade for the floor; the league's clock says which dinner it is (`warmUpDinnerAt` in `season.json`), never a date. From the next day the floor counts.");
}

// --- addendum 8: the season's end, the warm-up dinner, a run killed mid-send ------------------------------------

const noticesOf = (home: string) =>
  existsSync(agentPaths(home, "maplegrin").notifications)
    ? readFileSync(agentPaths(home, "maplegrin").notifications, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; text: string })
    : [];
const inboxAt = (s: Scene, when: number, file: string, body: Record<string, unknown>) =>
  s.c.at(when, () => {
    mkdirSync(agentPaths(s.home, "maplegrin").inbox, { recursive: true });
    writeJsonAtomic(join(agentPaths(s.home, "maplegrin").inbox, file), body);
  });

async function seasonEnd(): Promise<void> {
  section("(m) The season's last dinner: feast.meme says `over`; and a newer runtime is out");
  const END = Date.parse("2026-11-03T13:00:00Z");
  let now = () => 0;
  const s = scene(END - 40 * MIN, {
    hostTradedAt: END - 45 * MIN,
    ask: { every: 5, with: "claude" },
    league: () => ({ ...(now() >= END ? leagueWire({ state: "over", season: { number: 1, day: null, countdownTo: null } }) : leagueWire({ state: "season", season: { number: 1, day: 7, countdownTo: new Date(END).toISOString() } })), latestRuntime: { tag: "league-v6", publishedAt: "2026-11-02T04:00:00.000Z", minSupported: "league-v5" } }),
  });
  now = s.c.now;
  say("Day 7, 20:20 UTC+8, the ask loop on (the stub `claude` holds), a page that names `league-v6` as the newest release. At 21:00 UTC+8 the stub `/api/league` turns to `over`. The host bought NOODFEED at 20:25; at 21:10 it sends one more `FL buy` and an `FL sell` of NOODFEED.\n");
  inboxAt(s, END - 35 * MIN, "1-buy.json", { type: "intent", requestId: "m1", request: { kind: "buy", coin: BOARD[2]!.coin, bnb: 0.004, reason: "manual buy" } });
  inboxAt(s, END + 10 * MIN, "2-buy.json", { type: "intent", requestId: "m2", request: { kind: "buy", coin: BOARD[3]!.coin, bnb: 0.004, reason: "after the end" } });
  inboxAt(s, END + 10 * MIN, "3-sell.json", { type: "intent", requestId: "m3", request: { kind: "sell", coin: BOARD[2]!.coin, fraction: 1, reason: "close out" } });
  await runAsking(s, END + 2 * HOUR, "hold");
  events(s.home, ["season.over", "runtime.behind"]);
  const outcomes = logOf(s.home).filter((l) => l.event === "request.outcome");
  say(`\nThe host's requests: ${outcomes.map((l) => `\`${String(l.requestId)}\` ${String(l.kind)} → ${String(l.outcome)}${l.message ? ` ("${String(l.message)}")` : ""}`).join("; ")}.`);
  const asks = readJournal(s.home, "maplegrin", 100);
  say(`The asks: ${asks.length}, the last at ${hm(Date.parse(asks.at(-1)!.at))} UTC+8 (none after the end). The floor keeper's intents after 21:00 UTC+8: ${logOf(s.home).filter((l) => l.event === "intent.queued" && l.source === "preset" && Date.parse(l.at) >= END).length}.\n`);
  say("The notifications (the season and the release):");
  for (const n of noticesOf(s.home).filter((x) => x.kind === "season" || x.kind === "version")) say(`- ${hm(Date.parse(n.at))} ${n.kind}: ${n.text}`);
  say("");
  fillTable(fills(s.home));
  say("\nThe release is told once a league day: once before 21:00 UTC+8 and once after it, the dinner being a new league day; `FL status` says `runtime league-v5 · latest league-v6 · upgrade: npx skills add feastmeme/feast-agent` meanwhile. Nothing upgrades by itself.");
}

async function warmUp(): Promise<void> {
  section("(n) The warm-up dinner: day 1, the AI only holds, the floor unmet at 20:40 UTC+8");
  const WARM = Date.parse("2026-10-28T13:00:00Z");
  const s = scene(WARM - 70 * MIN, { hostTradedAt: WARM - 75 * MIN, ask: { every: 5, with: "claude" }, league: () => leagueWire({ state: "season", season: { number: 1, day: 1, countdownTo: new Date(WARM).toISOString() } }) });
  const { packs } = await runAsking(s, WARM, "hold");
  events(s.home, ["autopilot.on", "autopilot.off"]);
  const files = existsSync(packs) ? readdirSync(packs).sort() : [];
  const last = files.length ? readFileSync(join(packs, files.at(-1)!), "utf8") : "";
  say(`\nThe same hour as (k), a day earlier: no \`autopilot.on\`, ${fills(s.home).length} fills. ${files.length} asks; the last pack's floor line:\n`);
  block(last.split("\n").find((l) => l.startsWith("today's floor:")) ?? "(none)");
  say(`\n\`season.json\`: ${JSON.stringify(readJson(join(agentPaths(s.home, "maplegrin").dir, "season.json")))}`.replace(/"at":"[^"]+",?/, ""));
}

async function killedMidSend(): Promise<void> {
  section("(o) Killed between the send and the receipt, then restarted");
  const s = scene(at8("14:00"), { hostTradedAt: at8("13:50") });
  const receipt = s.w.chain.receipt.bind(s.w.chain);
  let hang: (e: Error) => void = () => {};
  (s.w.chain as unknown as { receipt: unknown }).receipt = () => new Promise((_, reject) => (hang = reject));
  const first = run(s, at8("15:00"));
  mkdirSync(agentPaths(s.home, "maplegrin").inbox, { recursive: true });
  writeJsonAtomic(join(agentPaths(s.home, "maplegrin").inbox, "1-buy.json"), { type: "intent", requestId: "o1", request: { kind: "buy", coin: BOARD[3]!.coin, bnb: 0.004, reason: "manual buy" } });
  const state = () => (existsSync(agentPaths(s.home, "maplegrin").state) ? (JSON.parse(readFileSync(agentPaths(s.home, "maplegrin").state, "utf8")) as { unresolved?: Record<string, unknown>[]; positions?: Record<string, { coins?: string }> }) : null);
  for (let i = 0; i < 400 && !state()?.unresolved?.some((u) => u.txHash !== null); i += 1) await new Promise((r) => setTimeout(r, 10));
  const kept = state()!.unresolved![0]!;
  say("The host's `FL buy` of 0.004 BNB of KOIFEED at 14:00 UTC+8. The wallet broadcasts it; the receipt never comes back to this run, which is killed there (its lock and pid file gone with it). In the book on disk, before any receipt:\n");
  block(JSON.stringify({ kind: kept.kind, symbol: kept.symbol, sizeWei: kept.sizeWei, txHash: `${String(kept.txHash).slice(0, 10)}…`, sending: kept.sending, positions: Object.keys(state()!.positions ?? {}).length }, null, 2));
  rmSync(join(s.home, "wallet.lock"), { force: true });
  rmSync(agentPaths(s.home, "maplegrin").pid, { force: true });
  (s.w.chain as unknown as { receipt: unknown }).receipt = receipt;
  (s.w.chain.client as unknown as { getTransactionReceipt: unknown }).getTransactionReceipt = ({ hash }: { hash: `0x${string}` }) => receipt(hash, 1);
  const told = noticesOf(s.home).length;
  await run(s, s.c.now() + 2 * MIN);
  const after = state()!;
  say(`\nThe restart, at ${hm(s.c.now() - 2 * MIN)} UTC+8: the record is read by its hash, its receipt found, the fill booked. Unresolved after it: ${after.unresolved?.length ?? 0}; KOIFEED held: ${Object.keys(after.positions ?? {}).length === 1 ? "yes" : "no"}. Told once:\n`);
  for (const n of noticesOf(s.home).slice(told).filter((x) => x.kind === "trade")) say(`- ${n.kind}: ${n.text}`.replace(/0x[0-9a-f]{64}/g, (h) => `${h.slice(0, 10)}…`));
  writeStop(agentPaths(s.home, "maplegrin").stop, "dry run over");
  hang(new Error("timed out"));
  await first;
}

const results: Record<string, ReturnType<typeof firstHour>> = {};

async function main(): Promise<void> {
  say("# The autopilot backup's dry run (task 975)");
  say("");
  say("Offline: the real CLI, `FL enter`'s flow and the runtime loop on the test fakes (a made-up wallet, made-up coins, feast.meme and the indexer stubbed in process, throwaway homes, a virtual clock). Every address is made up and shown 6+4. Nothing was signed by a real wallet, launched, bought or sent. `npx tsx src/league/prompt/dryrun.ts`.");
  cliCards();
  await enterCards();
  await takeover();
  await dump();
  await late();
  await back();
  await requests();
  await opening();
  await askCards();
  await askTick();
  await askFailing();
  await askGuard();
  await atScale();
  await seasonEnd();
  await warmUp();
  await killedMidSend();
  section("The numbers");
  say("(The first 60 minutes are cut at the dinner: the next day's fills are not in them.)\n");
  say("| scene | took over (UTC+8) | steady's fills in its first 60 min | their volume | the day's floor | steady's buys that day |");
  say("| --- | --- | --- | --- | --- | --- |");
  for (const [k, n] of Object.entries(results)) say(`| (${k}) | ${hm(n.on)} | ${n.fills} | ${n.volume} BNB | ${n.passedAt ? `passed at ${hm(n.passedAt)}` : "not passed"} | ${n.spend} BNB |`);
  process.stdout.write(`${out.join("\n")}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`dry run failed: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
