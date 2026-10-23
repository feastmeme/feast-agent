/**
 * Prompt mode's dry run (task 963): one round of a prompt agent, with the real
 * code each command runs, wired to the test fakes. A made-up wallet and Agent
 * ID; the fake signer and chain (`prompt/fakes.ts`), so a buy "fills" in
 * memory; feast.meme's four routes served by a stub on 127.0.0.1 (the notes
 * route answers 404, then 201); a throwaway FEAST_LEAGUE_HOME under the
 * system's temp folder. Nothing reaches a network, a wallet or a chain.
 *
 *   npx tsx src/league/data/dryrun.ts > docs/league/freedom-dryrun-<UTC stamp>.md
 *
 * The steps: `FL start demo --prompt docs/prompts/momentum.md` (the card),
 * then with `--yes`; `FL data demo --since 24h --json`; a decision written by
 * hand, as the host would make it; `FL buy demo <stub coin> 0.002`; `FL note …
 * --tx <the stub hash>`, kept and then sent; and `FL script check` on a passing
 * and a failing stub script. It prints a markdown transcript, every address
 * abbreviated 6+4 and every local path replaced.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Address } from "viem";

import { confirmAgent, loadAgent, planAgent, saveAgent } from "../agent.ts";
import { auditFile, auditRefusal, recordModelVerdict } from "../audit/verdict.ts";
import { renderCard } from "../card.ts";
import { flushNotes, noteCommand, readNotes } from "../notes/queue.ts";
import { tradeWorld, WALLET } from "../prompt/fakes.ts";
import { recordHostAction } from "../prompt/host.ts";
import { outcomeLine, sendRequest, waitForOutcome } from "../prompt/inbox.ts";
import { leagueWire } from "../register/fakes.ts";
import { runAgent } from "../runtime.ts";
import { checkLines, checkScript, writeCheckReport } from "../script/check.ts";
import { agentPaths, writeStop } from "../store.ts";
import { dataFace, type FaceChain } from "./face.ts";
import { C1, C2, C3, OWN, pool, SQRT_LOW, WBNB } from "./fakes.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const PROMPT = join(REPO, "docs/prompts/momentum.md");
const NOW = Date.now();
const HOUR = 3_600_000;
const home = mkdtempSync(join(tmpdir(), "feast-league-963-dryrun-"));
const out: string[] = [];
const say = (...lines: string[]) => out.push(...lines);
/** Addresses and hashes 6+4, local paths named. */
const shown = (text: string) =>
  text
    .split(home)
    .join("<home>")
    .split(REPO)
    .join("<repo>")
    .replace(/0x[0-9a-fA-F]{64}/g, (h) => `${h.slice(0, 6)}…${h.slice(-4).toLowerCase()}`)
    .replace(/0x[0-9a-fA-F]{40}/g, (a) => `${a.slice(0, 6)}…${a.slice(-4).toLowerCase()}`);
const block = (text: string, lang = "") => say(`\`\`\`${lang}`, shown(text), "```", "");

// --- feast.meme's routes, stubbed on 127.0.0.1 ---------------------------------------------------
const asked: string[] = [];
let notesAnswer = 404;
const hour = (t: number) => Math.floor(t / HOUR) * HOUR;
// MOMO's hourly sqrt prices: a slow climb for a day, then a jump in the last hour.
const sqrts = Array.from({ length: 30 }, (_, i) => (SQRT_LOW * BigInt(1_000 + 5 * Math.min(i, 28))) / 1_000n * (i === 29 ? 106n : 100n) / 100n);
const pages = [
  [
    pool(C1, { symbol: "MOMO", name: "momo", creator: "0x000000000000000000000000000000000000b0b0", createdAt: new Date(NOW - 30 * HOUR).toISOString(), volume24h: "900000000000000000", trades24h: 41, holders: 31, lastTradeAt: new Date(NOW - 4 * 60_000).toISOString(), sqrt: sqrts[29] }),
    pool(C2, { symbol: "SLOW", name: "slow", currency1: true, creator: "0x000000000000000000000000000000000000ca01", createdAt: new Date(NOW - 20 * 24 * HOUR).toISOString(), volume24h: "50000000000000000", trades24h: 3, holders: 12, lastTradeAt: new Date(NOW - 7 * HOUR).toISOString() }),
  ],
  [
    pool(C3, { symbol: "NEWB", name: "newb", creator: "0x000000000000000000000000000000000000ca01", createdAt: new Date(NOW - 5 * 60_000).toISOString(), volume24h: "20000000000000000", trades24h: 2, holders: 3, lastTradeAt: new Date(NOW - 2 * 60_000).toISOString() }),
    pool(OWN, { symbol: "DEMO", name: "demo", creator: WALLET, createdAt: new Date(NOW - 40 * HOUR).toISOString(), volume24h: "100000000000000000", trades24h: 6, holders: 9, lastTradeAt: new Date(NOW - 3 * HOUR).toISOString() }),
  ],
];
const rising = sqrts.map((sqrt, i) => {
  const t = Math.floor((hour(NOW) - (29 - i) * HOUR) / 1_000);
  const open = i === 0 ? sqrt : sqrts[i - 1]!;
  return [t, String(open), String((sqrt * 101n) / 100n), String((open * 99n) / 100n), String(sqrt), String(BigInt(10 + 3 * i) * 10n ** 15n)];
});
const league = leagueWire({
  state: "season",
  season: { number: 1, day: 1, countdownTo: new Date(hour(NOW) + 13 * HOUR).toISOString() },
  window: { from: new Date(hour(NOW) - 11 * HOUR).toISOString(), to: new Date(hour(NOW) + 13 * HOUR).toISOString() },
  boards: {
    earners: [{ rank: 1, wallet: "0x000000000000000000000000000000000000b0b0", name: "bobagent", pnlUsd: 4.2, trades: 9, hp: 22, eatenDay: null }],
    backed: [{ rank: 1, wallet: "0x000000000000000000000000000000000000ca01", name: "carol", hp: 31, eatenDay: null }],
  },
  counts: { earners: 1, backed: 1 },
  dinner: null,
  me: { earners: null, backed: null, eaten: null },
});
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://stub");
  asked.push(`${req.method} ${url.pathname}${url.search}`);
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "x-ratelimit-limit": "60" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/api/v1/pools") {
    const index = Number(url.searchParams.get("cursor") ?? "0");
    return json(200, { chainId: 56, source: "indexer", asOf: { block: 1 }, pools: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/ohlcv") return json(200, { asOf: null, poolId: null, coin: url.searchParams.get("coin"), timeframe: "hour", aggregate: 1, rows: url.searchParams.get("coin") === C1.toLowerCase() ? rising : [] });
  if (req.method === "GET" && url.pathname === "/api/league") return json(200, league);
  if (req.method === "POST" && url.pathname === "/api/league/notes") {
    req.resume();
    return req.on("end", () => json(notesAnswer, notesAnswer === 201 ? { ok: true } : { error: "not-found" }));
  }
  json(404, { error: "not-found" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// --- the fake wallet and chain ---------------------------------------------------------------------------
const world = tradeWorld({ coin: C1, symbol: "MOMO" });
const ids: Record<string, string | null> = { "0x000000000000000000000000000000000000b0b0": "bobagent", "0x000000000000000000000000000000000000ca01": null, [WALLET.toLowerCase()]: "demo" };
const chain = {
  ...(world.chain as unknown as Record<string, unknown>),
  quoteBnbE18: async () => 10n ** 18n,
  bnbUsd: async () => 600,
  agentIdOf: async (wallet: Address) => ({ state: "read" as const, id: ids[wallet.toLowerCase()] ?? null }),
  // The stub coin marked 5% above what it cost.
  markWei: async (_coin: Address, coins: bigint) => (coins * 105n) / (100n * 5_000_000n),
} as unknown as FaceChain & Parameters<typeof runAgent>[0]["chain"];
const face = () => dataFace({ home, site: SITE, indexer: SITE, fetch, chain, wallet: async () => WALLET }, { name: "demo", since: "24h" });

let running: Promise<unknown> | null = null;
try {
  say("# Prompt mode: the dry run (task 963)", "");
  say(`Run ${new Date(NOW).toISOString()} with \`npx tsx src/league/data/dryrun.ts\`: the real code of each command, a made-up wallet (${shown(WALLET)}) and Agent ID (\`demo\`), the fake signer and chain of \`src/league/prompt/fakes.ts\`, feast.meme's routes stubbed on 127.0.0.1, and a throwaway home. Nothing reached a network, a wallet or a chain; nothing was signed, launched or bought. Addresses and hashes are abbreviated 6+4.`, "");

  // 1. The card.
  say("## 1. `FL start demo --prompt docs/prompts/momentum.md`", "");
  const planned = planAgent({ name: "demo", promptPath: PROMPT });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, planned.agent);
  block(`${renderCard(planned.agent)}\n\nNot started: this needs the user's explicit yes (--yes).`, "text");
  say("Exit 2. Stopped here for the user's yes.", "");

  // 2. The yes.
  say("## 2. `FL start demo --prompt docs/prompts/momentum.md --yes`", "");
  saveAgent(home, confirmAgent(loadAgent(home, "demo")!));
  const notices: string[] = [];
  running = runAgent({ home, name: "demo", signer: world.signer, chain, fetch, site: SITE, indexer: SITE, loopMs: 100, maxRuntimeMs: 120_000, out: (l) => notices.push(l) });
  for (let i = 0; i < 50 && notices.length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  block(notices.join("\n"), "text");
  say(`The runtime runs in this process, as \`FL run demo\` would (with \`--detach\`, in the background). The wallet was asked: ${world.calls.join(", ")}.`, "");

  // 3. The data.
  say("## 3. `FL data demo --since 24h --json`", "");
  const data = await face();
  const d = data.data as Record<string, any>;
  const trimmed = { ...d, coins: d.coins.slice(0, 2), ohlcv: Object.fromEntries(Object.entries(d.ohlcv ?? {}).map(([k, v]) => [k, (v as unknown[]).slice(-3)])) };
  block(JSON.stringify(trimmed, null, 2), "json");
  say(`Exit ${data.code}. Trimmed above to two of the ${d.coins.length} coins and the last three hours of each history. The human output of the same read:`, "");
  block(data.text, "text");
  say(`Requests to the stub so far: ${asked.length} (${asked.map((a) => shown(a)).join("; ")}).`, "");

  // 4. The decision.
  say("## 4. The decision, written by hand as the host would make it", "");
  const momo = ((d.ohlcv ?? {}) as Record<string, { close: number }[]>)[C1] ?? [];
  const pct = (a: number, b: number) => (((a - b) / b) * 100).toFixed(1);
  const lastHour = momo.length >= 2 ? pct(momo.at(-1)!.close, momo.at(-2)!.close) : "?";
  const day = momo.length >= 2 ? pct(momo.at(-1)!.close, momo[0]!.close) : "?";
  const row = (d.coins as { symbol: { text: string }; volume24hBnb: number; holders: number; launchedAt: string }[]).find((c) => c.symbol.text === "MOMO")!;
  const ageHours = Math.round((NOW - Date.parse(row.launchedAt)) / HOUR);
  say(`> momentum.md enters a coin whose price is up at least 10% over its last hour, that gained at least 10 holders, with at least 0.5 BNB of volume, between 10 minutes and 3 days old. MOMO: its last hourly close is up ${lastHour}% on the hour before (${day}% across the ${momo.length} hours since --since 24h), its 24 h volume is ${row.volume24hBnb} BNB, it is ${ageHours} hours old, and it has ${row.holders} holders. FL data gives holders as a count now, so their growth comes from comparing my looks; this dry run has no earlier look, and takes that rule as met for the illustration. I hold nothing (the 3-position rule leaves room) and ${d.self.capital.spentBnb} of 0.15 BNB is spent. The prompt's size is 0.01 BNB; this dry run buys 0.002 BNB, as its step asks. The note will say why.`, "");

  // 5. The buy.
  say(`## 5. \`FL buy demo ${shown(C1)} 0.002\``, "");
  recordHostAction(home, "demo", "buy");
  const sent = sendRequest(home, "demo", { kind: "buy", coin: C1, bnb: 0.002, reason: "manual buy" });
  const outcome = await waitForOutcome(home, "demo", sent, { timeoutMs: 30_000 });
  const line = outcomeLine(outcome, "demo");
  block(line.text, "text");
  say(`Exit ${line.code}. The request went into the running agent's inbox with an id, through \`normalizeIntent\`, the guard and the executor (preview, then execute, against the fake signer), and the command waited for its outcome. The wallet was asked: ${world.calls.join(", ")}.`, "");

  // 6. The note.
  const tx = world.hashes[0]!;
  const text = `MOMO: last hour +${lastHour}%, ${row.holders} holders, ${row.volume24hBnb} BNB of 24 h volume; out at -20% or when the hour fades`;
  say(`## 6. \`FL note demo "${text}" --tx ${shown(tx)}\``, "");
  const kept = await noteCommand({ home, name: "demo", site: SITE, fetch, wallet: async () => WALLET }, { text, tx });
  block(kept.text, "text");
  say(`Exit ${kept.code}: the stub's notes route answered 404, as feast.meme's does until task 964 ships it. Then the route answers 201, and the next flush (the one \`FL data\`, \`FL note\` or the runtime's safety pass makes) sends it:`, "");
  notesAnswer = 201;
  const flushed = await flushNotes(home, "demo", WALLET, { site: SITE, fetch });
  block(JSON.stringify({ flushed, notes: readNotes(home, "demo") }, null, 2), "json");

  // 7. The book, after.
  say("## 7. `FL data demo --since 24h` after the trade (human output)", "");
  const after = await face();
  block(after.text, "text");
  say(`Exit ${after.code}. The pools and the history came from the cache (30 s and 5 min); only the league was asked again.`, "");

  writeStop(agentPaths(home, "demo").stop, "stop requested by the user");
  await running;
  running = null;

  // 8. The script check.
  say("## 8. `FL script check` on a passing and a failing stub script", "");
  const scripts = {
    "busy.mjs": `// Buys the busiest coin once, sells it ten ticks later.\nexport const meta = { name: "busy", tickSeconds: 60, events: ["coin.created"] };\nexport const params = { size: 0.002 };\n\nexport function onTick(api) {\n  const state = api.state;\n  state.n = (state.n || 0) + 1;\n  const top = api.read.coins({ sort: "volume", limit: 1 })[0];\n  if (state.n === 2 && top) {\n    state.coin = top.coin;\n    api.buy({ coin: top.coin, bnb: api.params.size, reason: "the busiest coin" });\n  }\n  if (state.n === 12 && state.coin && api.read.position(state.coin)) {\n    api.sell({ coin: state.coin, fraction: 1, reason: "ten ticks later" });\n  }\n}\n`,
    "greedy.mjs": `// Buys every new coin it sees with 0.02 BNB.\nexport const meta = { name: "greedy", tickSeconds: 60 };\n\nexport function onTick(api) {\n  for (const coin of api.read.coins({ sort: "new", limit: 8 })) {\n    if (!api.read.position(coin.coin)) api.buy({ coin: coin.coin, bnb: 0.02, reason: "everything new" });\n  }\n}\n`,
  };
  for (const [file, source] of Object.entries(scripts)) {
    const path = join(home, file);
    writeFileSync(path, source);
    if (file === "busy.mjs") {
      auditFile(home, path);
      recordModelVerdict(home, path, "pass", "dry run: no wallet, no network, sizes within L1");
    }
    const report = await checkScript(source, { file: path });
    const where = writeCheckReport(home, report);
    say(`### \`FL script check ${file}\``, "");
    block(checkLines(report, where, auditRefusal(home, path, source)), "text");
    say(`Exit ${report.verdict === "pass" ? 0 : 2}.`, "");
  }

  say("## Where it stopped", "");
  say("- Step 1 stopped at the card, exit 2, for the user's yes. Step 2 confirmed it and started the runtime in this process, on the fake wallet.");
  say("- The buy filled against the fake signer and chain: no transaction exists. The note was kept (404), then sent to the stub (201).");
  say("- The runtime stopped on its stop file after step 7. The throwaway home was deleted after the run.", "");
  say(`Every request the stub served: ${asked.length}.`, "");
  for (const a of asked) say(`- \`${shown(a)}\``);
  say("");
} finally {
  if (running) {
    writeStop(agentPaths(home, "demo").stop, "stop requested by the user");
    await running.catch(() => undefined);
  }
  server.close();
  rmSync(home, { recursive: true, force: true });
}
console.log(out.join("\n"));
