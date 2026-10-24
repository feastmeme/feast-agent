/**
 * The snapshot feed's dry run (task 967): two runtimes, with the real loop, on the test fakes. A momentum agent, and
 * a prompt agent with a sniper autopilot (on after 1 minute of silence), each with a made-up wallet, the fake signer
 * and chain of `prompt/fakes.ts` (nothing is signed, nothing is bought), a throwaway FEAST_LEAGUE_HOME under the
 * system's temp folder, and one virtual clock that moves only when both loops sleep. feast.meme's snapshot and the
 * indexer's legacy routes are served by a stub on 127.0.0.1, which plays the phases: the start jitter, the steady
 * state, a stretch of 429s, the recovery, then the route answering 404 (as before tasks 965 and 966 deploy) and,
 * near the end, 200 again, which the agents see at their 10-minute recheck.
 *
 *   npx tsx src/league/feed/dryrun.ts > docs/league/capacity-dryrun-<UTC stamp>.md
 *
 * Nothing reaches a network but 127.0.0.1. It prints a markdown transcript, every address and hash 6+4.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address } from "viem";

import { confirmAgent, planAgent, saveAgent, type PlanInput } from "../agent.ts";
import { MAINNET } from "../../sdk/networks.ts";
import { cursorAt } from "../events.ts";
import { tradeWorld } from "../prompt/fakes.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths } from "../store.ts";
import { seeded } from "./fakes.ts";
import { drawStartJitter } from "./snapshot.ts";

const T0 = Date.parse("2026-10-28T12:00:00Z");
const S = 1_000;
const PHASES = [
  { at: 0, name: "the start", what: "the snapshot, with its ETag; each agent waits its own start jitter before its first read" },
  { at: 30 * S, name: "steady", what: "the same; a quiet market, so a new generation (and ETag) every 10 s: a 200 when it moved, a 304 when not" },
  { at: 90 * S, name: "the outage", what: "every snapshot GET answers 429, with Retry-After: 5" },
  { at: 135 * S, name: "the recovery", what: "the snapshot answers again" },
  { at: 180 * S, name: "the 404 fallback", what: "the route answers 404, as before tasks 965 and 966 deploy; the indexer's legacy routes answer" },
  { at: 720 * S, name: "the route deployed", what: "the snapshot answers 200 again; each agent sees it at its 10-minute recheck" },
] as const;
const END = 830 * S;
const phaseOf = (t: number) => [...PHASES].reverse().find((p) => t - T0 >= p.at)!;

// --- made-up coins and wallets --------------------------------------------------------------------------------------
const WBNB = MAINNET.contracts.wrappedNative;
const C1: Address = getAddress("0x00000000000000000000000000000000000c0f01");
const C2: Address = getAddress("0x00000000000000000000000000000000000c0f02");
const C3: Address = getAddress("0x00000000000000000000000000000000000c0f03");
const BOB: Address = getAddress("0x000000000000000000000000000000000000b0b0");
const WALLETS = { m: getAddress("0x000000000000000000000000000000000000a11c"), p: getAddress("0x000000000000000000000000000000000000a22c") };

// --- one virtual clock for both loops: it moves when both sleep ----------------------------------------------------
const clock = {
  t: T0,
  sleeping: [] as { at: number; wake: () => void }[],
  participants: 2,
  now: () => clock.t,
  sleep: (ms: number) =>
    new Promise<void>((wake) => {
      clock.sleeping.push({ at: clock.t + ms, wake });
      clock.advance();
    }),
  done() {
    clock.participants -= 1;
    clock.advance();
  },
  advance() {
    if (clock.sleeping.length === 0 || clock.sleeping.length < clock.participants) return;
    const next = Math.min(...clock.sleeping.map((s) => s.at));
    clock.t = next;
    const due = clock.sleeping.filter((s) => s.at === next);
    clock.sleeping = clock.sleeping.filter((s) => s.at !== next);
    for (const s of due) setImmediate(s.wake);
  },
};

// --- the stub: the snapshot, and the indexer's legacy routes ------------------------------------------------------
type Row = { agent: "m" | "p"; t: number; method: string; path: string; status: number };
const served: Row[] = [];
const GENERATION_MS = 10 * S;
const generation = (t: number) => Math.floor((t - T0) / GENERATION_MS);
const blockOf = (g: number) => 50_000 + g;
const trade = (g: number) => ({
  type: "trade",
  at: new Date(T0 + g * GENERATION_MS).toISOString(),
  blockNumber: blockOf(g),
  blockHash: `0x${blockOf(g).toString(16).padStart(64, "0")}`,
  logIndex: 0,
  cursor: cursorAt(blockOf(g), 0),
  coin: C1.toLowerCase(),
  buy: g % 2 === 0,
  payer: BOB.toLowerCase(),
  quote: WBNB.toLowerCase(),
  coinAmount: "1000000000000000000000",
  quoteAmount: "1000000000000000",
  fee: "10000000000000",
  sqrtPriceX96: String(2n ** 86n),
  poolId: `0x${"c1".repeat(32)}`,
  depth: "latest",
  txHash: `0x${(0xd000 + g).toString(16).padStart(64, "0")}`,
});
const coins = [
  { address: C1.toLowerCase(), name: "Momo", symbol: "MOMO", quote: WBNB.toLowerCase(), creator: BOB.toLowerCase(), metadataHash: `0x${"4d".repeat(32)}`, launchedAt: new Date(T0 - 3 * 3_600_000).toISOString(), priceQuote: 0.0000012, priceBnb: 0.0000012, volume24hBnb: 4.2, trades24h: 61, lastTradeAt: new Date(T0).toISOString(), holders: 44, lastCursor: cursorAt(blockOf(0), 0) },
  { address: C2.toLowerCase(), name: "Slow", symbol: "SLOW", quote: WBNB.toLowerCase(), creator: BOB.toLowerCase(), metadataHash: `0x${"4e".repeat(32)}`, launchedAt: new Date(T0 - 30 * 3_600_000).toISOString(), priceQuote: 0.0000004, priceBnb: null, volume24hBnb: 0.3, trades24h: 4, lastTradeAt: new Date(T0 - 3_600_000).toISOString(), holders: 12, lastCursor: cursorAt(blockOf(0), 0) },
  { address: C3.toLowerCase(), name: "Newb", symbol: null, quote: WBNB.toLowerCase(), creator: BOB.toLowerCase(), metadataHash: `0x${"0".repeat(64)}`, launchedAt: new Date(T0 - 600_000).toISOString(), priceQuote: 0.000002, priceBnb: 0.000002, volume24hBnb: 0.05, trades24h: 2, lastTradeAt: new Date(T0 - 300_000).toISOString(), holders: 3, lastCursor: cursorAt(blockOf(0), 0) },
];
const snapshotAt = (t: number) => {
  const g = generation(t);
  // A rolling tail of 120 s (12 generations), as ruling C1 asks of task 965.
  const first = Math.max(0, g - 11);
  return { generatedAt: new Date(T0 + g * GENERATION_MS).toISOString(), block: blockOf(g), coins, events: Array.from({ length: g - first + 1 }, (_, i) => trade(first + i)), fromCursor: cursorAt(blockOf(first - 1), 0), toCursor: cursorAt(blockOf(g), 0), cursor: cursorAt(blockOf(g), 0), truncated: false };
};
const boardRows = coins.map((c) => ({ coin: c.address, creator: c.creator, quote: c.quote, metadataHash: c.metadataHash, launchedAt: c.launchedAt, lastPriceSqrtX96: String(2n ** 86n), volume24h: "1000000000000000000", trades24h: c.trades24h, holders: c.holders }));

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://stub");
  const [, agent, ...rest] = url.pathname.split("/");
  const path = `/${rest.join("/")}`;
  const t = clock.t;
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    served.push({ agent: agent as "m" | "p", t: t - T0, method: req.method ?? "GET", path: `${path}${url.search}`, status });
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(status === 304 ? undefined : JSON.stringify(body));
  };
  const phase = phaseOf(t).name;
  if (path === "/api/v1/snapshot") {
    if (phase === "the outage") return send(429, { error: "rate-limited" }, { "retry-after": "5" });
    if (phase === "the 404 fallback") return send(404, { error: "not-found" });
    const etag = `"g${generation(t)}"`;
    if (req.headers["if-none-match"] === etag) return send(304, null, { etag });
    return send(200, snapshotAt(t), { etag, "cache-control": "public, s-maxage=5, stale-while-revalidate=30" });
  }
  if (path === "/idx/v1/events") {
    const g = generation(t);
    if (url.searchParams.get("limit") === "1") return send(200, { asOf: { block: blockOf(g) }, data: [] });
    const after = (() => {
      try {
        return (JSON.parse(Buffer.from(url.searchParams.get("cursor") ?? "", "base64url").toString("utf8")) as { b: number }).b;
      } catch {
        return blockOf(g);
      }
    })();
    const rows = Array.from({ length: Math.max(0, blockOf(g) - after) }, (_, i) => trade(after - 50_000 + 1 + i)).slice(0, Number(url.searchParams.get("limit") ?? 200));
    return send(200, { asOf: { block: blockOf(g) }, data: rows });
  }
  if (path === "/idx/v1/board") return send(200, { data: boardRows });
  send(404, { error: "not-found" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// --- the two agents ----------------------------------------------------------------------------------------------------
const homes: string[] = [];
const random = seeded(967);
const jitters = { m: drawStartJitter(random) % 30_000, p: drawStartJitter(random) % 30_000 };
const said: { agent: string; t: number; line: string }[] = [];

function agentHome(plan: Omit<PlanInput, "name">): string {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-967-dryrun-"));
  homes.push(dir);
  const home = join(dir, "home");
  const planned = planAgent({ name: "demo", ...plan });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirmAgent(planned.agent, new Date(T0)));
  return home;
}

const promptDir = mkdtempSync(join(tmpdir(), "feast-league-967-prompt-"));
homes.push(promptDir);
const promptPath = join(promptDir, "strategy.md");
writeFileSync(promptPath, "Snipe new coins with metadata; sell at -25% or after 30 minutes. Note why.\n");
const runs = {
  m: { title: "momentum (preset)", home: agentHome({ preset: "momentum" }) },
  p: { title: "prompt mode, sniper autopilot after 1 min", home: agentHome({ promptPath, preset: "sniper", idleMinutes: 1 }) },
};

const start = (key: "m" | "p") => {
  const w = tradeWorld({ now: clock.now, wallet: WALLETS[key] });
  return runAgent({
    home: runs[key].home,
    name: "demo",
    signer: w.signer,
    chain: w.chain,
    fetch,
    site: `${base}/${key}`,
    indexer: `${base}/${key}/idx`,
    now: clock.now,
    sleep: clock.sleep,
    random: seeded(key === "m" ? 1 : 2),
    loopMs: S,
    maxRuntimeMs: END,
    startJitterMs: jitters[key],
    out: (line) => said.push({ agent: key, t: clock.t - T0, line }),
  }).finally(() => clock.done());
};

let outcomes: Awaited<ReturnType<typeof runAgent>>[] = [];
try {
  outcomes = await Promise.all([start("m"), start("p")]);
} finally {
  server.closeAllConnections();
  server.close();
}

// --- the transcript ---------------------------------------------------------------------------------------------------
const out: string[] = [];
const say = (...lines: string[]) => out.push(...lines);
const shown = (text: string) =>
  homes
    .reduce((s, h) => s.split(h).join("<home>"), text)
    .split(base)
    .join("<stub>")
    .replace(/0x[0-9a-fA-F]{64}/g, (h) => `${h.slice(0, 6)}…${h.slice(-4).toLowerCase()}`)
    .replace(/0x[0-9a-fA-F]{40}/g, (a) => `${a.slice(0, 6)}…${a.slice(-4).toLowerCase()}`);
const sec = (ms: number) => `${(ms / S).toFixed(1)} s`;
const logOf = (home: string) =>
  readFileSync(agentPaths(home, "demo").log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string });

say("# The snapshot feed: the dry run (task 967)", "");
say(
  `Run ${new Date().toISOString()} with \`npx tsx src/league/feed/dryrun.ts\`: two runtimes with the real loop, feed and backoff, each on a made-up wallet (${shown(WALLETS.m)}, ${shown(WALLETS.p)}) with the fake signer and chain of \`src/league/prompt/fakes.ts\`, a throwaway home under the system's temp folder, and one virtual clock that moves only when both loops sleep (${sec(END)} of it, from ${new Date(T0).toISOString()}). feast.meme's \`/api/v1/snapshot\` and the indexer's \`/v1/events\` and \`/v1/board\` are a stub on 127.0.0.1 (\`<stub>\` below); every coin, wallet, event and hash is made up. Nothing reached a network, a wallet or a chain; nothing was signed, launched or bought. Addresses and hashes are abbreviated 6+4.`,
  "",
);
say("## The phases", "", "| From | Phase | The stub |", "| --- | --- | --- |");
for (const p of PHASES) say(`| ${sec(p.at)} | ${p.name} | ${p.what} |`);
say("", `The start jitter drawn for each (FL start draws U(0, 120) s; here kept under 30 s so the run stays short): momentum ${sec(jitters.m)}, prompt ${sec(jitters.p)}.`, "");

for (const key of ["m", "p"] as const) {
  const run = runs[key];
  const rows = served.filter((r) => r.agent === key);
  const outcome = outcomes[key === "m" ? 0 : 1]!;
  say(`## ${key === "m" ? "1" : "2"}. ${run.title}`, "");
  say(`Outcome: ${outcome.exit} (${outcome.reason}). Requests to the stub: ${rows.length}.`, "");
  say("| Phase | Snapshot GETs (200 / 304 / 429 / 404) | Legacy GETs (events / board) | Gaps between snapshot GETs |", "| --- | --- | --- | --- |");
  for (const [i, p] of PHASES.entries()) {
    const to = PHASES[i + 1]?.at ?? END;
    const inPhase = rows.filter((r) => r.t >= p.at && r.t < to);
    const snaps = inPhase.filter((r) => r.path === "/api/v1/snapshot");
    const by = (s: number) => snaps.filter((r) => r.status === s).length;
    const times = rows.filter((r) => r.path === "/api/v1/snapshot").map((r) => r.t);
    const gaps = snaps.map((r) => r.t - (times[times.indexOf(r.t) - 1] ?? Number.NaN)).filter((g) => Number.isFinite(g));
    const legacyEvents = inPhase.filter((r) => r.path.startsWith("/idx/v1/events")).length;
    const legacyBoard = inPhase.filter((r) => r.path.startsWith("/idx/v1/board")).length;
    say(`| ${p.name} (${sec(p.at)}) | ${snaps.length} (${by(200)} / ${by(304)} / ${by(429)} / ${by(404)}) | ${legacyEvents} / ${legacyBoard} | ${gaps.length ? `${sec(Math.min(...gaps))} – ${sec(Math.max(...gaps))}` : "—"} |`);
  }
  say("", "The log's feed lines (and the start, the jitter's end and the autopilot):", "", "```text");
  for (const l of logOf(run.home).filter((l) => /^(started|jitter\.done|feed\.|snapshot\.|events\.gap|autopilot\.|events\.failed|tick\.failed)/.test(l.event))) {
    const { at, event, ...rest } = l;
    const keep = event === "started" ? { track: rest.track, preset: rest.preset, feed: rest.feed, pollMs: rest.pollMs, startJitterMs: rest.startJitterMs } : rest;
    say(shown(`+${sec(Date.parse(at) - T0).padStart(7)} ${event} ${JSON.stringify(keep)}`));
  }
  say("```", "", "Notifications:", "", "```text");
  for (const n of said.filter((s) => s.agent === key)) say(shown(`+${sec(n.t).padStart(7)} ${n.line}`));
  say("```", "", "<details><summary>Every request, in order</summary>", "", "```text");
  for (const r of rows) say(shown(`+${sec(r.t).padStart(7)} ${r.method} ${r.path.length > 90 ? `${r.path.slice(0, 90)}…` : r.path} → ${r.status}`));
  say("```", "", "</details>", "");
}

say("## What it shows", "");
const snapshotTimes = (key: "m" | "p") => served.filter((r) => r.agent === key && r.path === "/api/v1/snapshot");
const gapsIn = (key: "m" | "p", from: number, to: number) => {
  const all = snapshotTimes(key);
  return all.flatMap((r, i) => (i > 0 && r.t >= from && r.t < to ? [r.t - all[i - 1]!.t] : []));
};
const outage = PHASES.find((p) => p.name === "the outage")!;
const recovery = PHASES.find((p) => p.name === "the recovery")!;
const fallback = PHASES.find((p) => p.name === "the 404 fallback")!;
const deployed = PHASES.find((p) => p.name === "the route deployed")!;
const firstRead = (key: "m" | "p") => served.find((r) => r.agent === key)?.t ?? Number.NaN;
const autopilotOn = Date.parse(logOf(runs.p.home).find((l) => l.event === "autopilot.on")?.at ?? "") - T0;
const steadyGaps = (["m", "p"] as const).flatMap((k) => gapsIn(k, PHASES[1].at, outage.at));
const statuses = (key: "m" | "p", from: number, to: number) => snapshotTimes(key).filter((r) => r.t >= from && r.t < to).map((r) => r.status);
const legacyGaps = (["m", "p"] as const).flatMap((k) => {
  const ev = served.filter((r) => r.agent === k && r.path.startsWith("/idx/v1/events")).map((r) => r.t);
  return ev.slice(1).map((t, i) => t - ev[i]!);
});
const rechecks = (["m", "p"] as const).map((k) => {
  const after = snapshotTimes(k).filter((r) => r.t >= fallback.at);
  return `${k === "m" ? "momentum" : "prompt"} ${sec(after[0]!.t)} (404) then ${sec(after[1]!.t)} (${after[1]!.status})`;
});
say(`- **The start jitter.** Momentum's first read came at ${sec(firstRead("m"))} (jitter ${sec(jitters.m)}); the prompt agent's at ${sec(firstRead("p"))}, when its autopilot came on (${sec(autopilotOn)}; jitter ${sec(jitters.p)}): with the autopilot off it reads nothing.`);
say(`- **Steady.** Gaps between snapshot GETs ${sec(Math.min(...steadyGaps))}–${sec(Math.max(...steadyGaps))} (5–8 s drawn, then the loop's 1 s step); with If-None-Match, ${(["m", "p"] as const).map((k) => statuses(k, PHASES[1].at, outage.at).filter((x) => x === 304).length).reduce((a, b) => a + b, 0)} of the steady reads were 304s.`);
// The wait after each 429, up to the read that came back.
const waits = (key: "m" | "p") => snapshotTimes(key).flatMap((r, i, all) => (i > 0 && all[i - 1]!.status === 429 ? [r.t - all[i - 1]!.t] : []));
say(`- **The outage** (${sec(outage.at)}–${sec(recovery.at)}). The wait after each 429, momentum: ${waits("m").map(sec).join(", ")}; the prompt agent: ${waits("p").map(sec).join(", ")} (attempt k waits 2 s × 2^k × U(0.75, 1.25), Retry-After: 5 raising the first ones to 5 s, never under 3 s; the last wait is the one the recovery ended, plus the loop's 1 s step). Each logged one \`feed.backoff\`, one \`feed.stale\` after its third failure, gave one notification, and one \`feed.ok\` with the outage's length. Meanwhile a strategy reads the last snapshot's rows with \`stale\` set (\`feed/runtime.test.ts\`), and L6, L8 and the inbox never wait on it.`);
say(`- **The 404.** One \`snapshot.unavailable\` each, then the indexer's \`/v1/events\` at ${sec(Math.min(...legacyGaps))}–${sec(Math.max(...legacyGaps))} (the same interval; its \`limit\` cycling), and its board on momentum's ticks only. The recheck, 10 minutes on: ${rechecks.join("; ")}; \`snapshot.available\` once each, and the events go on from the legacy poller's cursor (the route was deployed at ${sec(deployed.at)}).`);
say("");
for (const h of homes) rmSync(h, { recursive: true, force: true });
console.log(out.join("\n"));
process.exit(0);
