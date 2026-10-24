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
 * and zh. (b) the takeover: the host's last trade at Tuesday 14:00 UTC+8, a note at 14:10 (which does not hold the
 * backup back), then nothing, run to 23:00. (c) a dump: one of its coins falls 50 % between two ticks. (d) a late
 * takeover, in the rush before the dinner. (e) the host comes back 20 minutes after the takeover. (f) the requests,
 * under four hosts. (g) an agent entered days ahead, at the season's opening instant.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
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
import { agentPaths, writeJsonAtomic } from "../store.ts";
import { FEAST, fakeClock, marketWorld } from "./fakes.ts";
import { dayCount, nextDinner, passesFloor } from "./floor.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BIN = join(import.meta.dirname, "../bin.mjs");
/** Tuesday 10/27: the season's day 2 ends at its dinner, 21:00 UTC+8. */
const DINNER = Date.parse("2026-10-27T13:00:00Z");
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
const OWN_SET = [OWN.toLowerCase(), FEAST.toLowerCase()];

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
  for (const lang of ["en", "zh"] as const) {
    const root = tmpRoot();
    const home = join(root, "home");
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    // A key made for this run only, never printed: the fake wallet signs with it, nothing else does.
    const account = privateKeyToAccount(generatePrivateKey());
    const { runner } = fakeBaw({ account });
    const site = new FakeEnterSite({ wallet: account.address, agentId: { agentId: "maplegrin" }, avatar: { status: 200 }, session: { status: 201, body: { token: "tok-dry", expiresAt: "2026-11-02T13:00:00.000Z", season: 1 } } });
    const deps = {
      home,
      signer: new BawSigner(runner),
      chain: fakeEnterChain({ agentId: "maplegrin" }),
      site: new LeagueSite(ENTER_SITE, site.fetch),
      indexer: ENTER_INDEXER,
      fetch: site.fetch,
      now: () => Date.parse("2026-10-24T13:00:00Z"),
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
    say(`### \`FL enter --name maplegrin.ai --lang ${lang}\`: the agent section under the entry card\n`);
    block(text.slice(from, text.lastIndexOf("\n\n")));
    const done = await enter(deps, { name: "maplegrin.ai", yes: true, lang });
    say(`### \`FL enter … --yes --lang ${lang}\`: the last line\n`);
    block(done.text.split("\n").at(-1)!);
    say(`\`FL enter --json\`'s \`autopilot\`: \`${JSON.stringify(done.data.autopilot)}\``);
  }
}

// --- the loop's world ------------------------------------------------------------------------------------

type Scene = { home: string; feed: FakeFeed; w: ReturnType<typeof marketWorld>; c: ReturnType<typeof fakeClock> };

function scene(start: number, o: { confirmedAt?: number; league?: () => unknown; hostTradedAt?: number } = {}): Scene {
  const root = tmpRoot();
  const promptPath = join(root, "strategy.md");
  writeFileSync(promptPath, "Ride what the crowd is buying, small.\n");
  // As FL enter plans it: neither flag, so the default backup.
  const choice = autopilotChoice({});
  const planned = planAgent({ name: "maplegrin", promptPath, preset: choice.ok ? choice.preset : undefined });
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
      return { t, by: BY[source.get(String(l.id)) ?? ""] ?? "?", side, coin: String(l.coin), bnb: bnb(wei), reason: reason.get(String(l.id)) ?? "", day: { trades: day.trades, volumeBnb: day.volumeBnb, passed } };
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
  section("(g) Entered on Saturday, the host quiet since: the opening instant, Monday 20:00 UTC+8");
  const opensAt = Date.parse("2026-10-26T12:00:00Z");
  const s = scene(opensAt - 10 * MIN, { confirmedAt: Date.parse("2026-10-24T13:00:00Z"), league: () => leagueWire({ state: "warm-up", season: { number: 1, day: null, countdownTo: new Date(Date.parse("2026-10-25T13:00:00Z")).toISOString() } }) });
  await run(s, opensAt + 90 * MIN);
  events(s.home, ["season.open", "autopilot.on"]);
  say("");
  fillTable(fills(s.home));
  say("\nThe silence counts from the yes, so the backup is on at the opening instant (here with `--no-jitter`; `FL enter` starts with the jitter, 0–120 s). The opening hour is the last hour before dinner 1, so it is in the rush: buys and sales 3 minutes apart. Dinner 1 eats nobody; the floor it keeps there is the arithmetic's first of seven days.");
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
