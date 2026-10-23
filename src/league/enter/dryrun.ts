/**
 * The league entry's dry run (tasks 961, 968): the real flow, the real cards and the real runtime loop, wired to
 * the test fakes. A made-up wallet (a key generated for the run, never printed), a made-up Agent ID, a fake chain,
 * feast.meme's routes stubbed in process, throwaway homes and working folders under the system's temp folder, and
 * a clock of its own. Nothing reaches a network; nothing is signed by a real wallet, launched or bought: the
 * one-shot here refuses to run, and the agent's runtime trades against the loop's own fakes.
 *
 *   npx tsx src/league/enter/dryrun.ts [--lang en|zh]
 *
 * (a) the entry card, with the season-1 default copied to ./strategy.md; (b) the --yes against a register route
 * that seats; (c) one that answers pending; (d) the compose card; (e) the meme's preview with the host's PNG,
 * (e2) with a JPEG, (f) with 262,145 bytes, (g) with no league creature; (h) the agent under the season gate,
 * three simulated minutes before trading opens; (i) the same with no start announced.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { BawSigner } from "../baw.ts";
import { FakeFeed, INDEXER as FEED_INDEXER, seeded, SITE as FEED_SITE } from "../feed/fakes.ts";
import { fakeClock, FEAST, tradeWorld } from "../prompt/fakes.ts";
import { langOf, short, utc8 } from "../register/copy.ts";
import { fakeBaw, leagueWire } from "../register/fakes.ts";
import { LeagueSite } from "../register/site.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths, writeJsonAtomic } from "../store.ts";
import { AVATAR_PNG, FakeEnterSite, fakeEnterChain, INDEXER, SITE, type FakeSiteOptions } from "./fakes.ts";
import { enter, type EnterInput, type MemeInput } from "./flow.ts";

const { values } = parseArgs({ options: { lang: { type: "string", default: "en" } } });
const lang = langOf(values.lang);

// Made up: the Agent ID is not minted, and the key lives only in this run.
const AGENT_ID = "demo";
const DAY = Date.parse("2026-10-24T13:00:00Z");
const MEME: MemeInput = { concept: "a cat that only eats noodles at midnight", name: "Noodle Cat", symbol: "NOOD", description: "A midnight cat with a noodle habit." };

const roots: string[] = [];
/** The throwaway wallets' addresses, written as <wallet>; any other address as 6+4. */
const wallets = new Set<string>();
const abbreviated = (text: string) => text.replace(/0x[0-9a-fA-F]{40}/g, (a) => (wallets.has(a.toLowerCase()) ? "<wallet>" : short(a)));
const out: string[] = [];
const say = (line = "") => out.push(abbreviated(line));
const section = (title: string) => say(`\n## ${title}\n`);
const block = (text: string) => say(["```text", text, "```"].join("\n"));

function world(page: Partial<FakeSiteOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "feast-league-enter-dryrun-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const account = privateKeyToAccount(generatePrivateKey());
  wallets.add(account.address.toLowerCase());
  const { runner, calls } = fakeBaw({ account });
  const site = new FakeEnterSite({ wallet: account.address, agentId: { agentId: AGENT_ID }, avatar: { status: 200 }, session: { status: 201, body: { token: "tok-dry", expiresAt: "2026-11-02T13:00:00.000Z", season: 1 } }, ...page });
  const starts: string[] = [];
  const run = (input: Partial<EnterInput> = {}) =>
    enter(
      {
        home,
        signer: new BawSigner(runner),
        chain: fakeEnterChain({ agentId: AGENT_ID }),
        site: new LeagueSite(SITE, site.fetch),
        indexer: INDEXER,
        fetch: site.fetch,
        now: () => DAY,
        notesDev: false,
        signOptions: { pollMs: 1, sleep: async () => {} },
        cwd,
        start: async (name) => (starts.push(name), 4242),
        oneShot: async () => {
          throw new Error("the dry run never launches: it stops at the preview card");
        },
      },
      { name: `${AGENT_ID}.ai`, yes: false, lang, ...input },
    );
  const asked = () => [
    `wallet: ${calls.map((c) => `${c[0]} ${c[1]}`).join(", ")}`,
    `feast.meme:\n${site.calls.map((c) => `  ${c}`).join("\n")}`,
    `signed messages: ${calls.filter((c) => c[0] === "sign-message" && c[1] === "preview").map((c) => (JSON.parse((JSON.parse(c[c.indexOf("--message") + 1]!) as { params: [string, string] }).params[1]) as { primaryType: string }).primaryType).join(", ") || "none"}`,
    `pins: ${site.pins.length}; agents started: ${starts.join(", ") || "none"}`,
  ];
  return { home, cwd, site, run, asked, starts };
}

try {
  say(`# FL enter, one command: the dry run (task 968, ${lang})`);
  say();
  say("Stubs only: a made-up wallet and Agent ID, feast.meme in process, a fixed clock (2026-10-24 21:00 UTC+8), throwaway homes. Nothing is signed by a real wallet, sent to a network, launched or bought.");

  // --- (a) and (g2): the entry card, the default strategy copied ------------------------------
  const w = world();
  section("(a) The entry card, with no --prompt: the season-1 default copied to ./strategy.md");
  const a = await w.run();
  say(`exit ${a.code}, stage ${a.stage}`);
  block(a.text.replaceAll(w.cwd, "<cwd>"));
  say("The copied strategy.md:");
  block(readFileSync(join(w.cwd, "strategy.md"), "utf8").trimEnd());

  // --- (b) the yes against a register route that seats ------------------------------------------
  section("(b) --yes, against a register route that seats");
  const b = await w.run({ yes: true });
  say(`exit ${b.code}, stage ${b.stage}`);
  block(b.text);
  say("What was asked, in order:");
  block(w.asked().join("\n"));
  say("entry.json:");
  block(readFileSync(join(agentPaths(w.home, "league-entry").dir, "entry.json"), "utf8").trimEnd());

  // --- (c) pending -------------------------------------------------------------------------------
  section("(c) --yes, against a register route that answers pending (an old deploy)");
  const p = world({ register: "pending" });
  await p.run({ noStart: true });
  const c = await p.run({ noStart: true, yes: true });
  say(`exit ${c.code}, stage ${c.stage}`);
  block(c.text);
  block(p.asked().join("\n"));

  // --- (d) the compose card -------------------------------------------------------------------------
  section("(d) --meme without the composed fields: the compose card");
  const d = await w.run({ meme: { concept: MEME.concept } });
  say(`exit ${d.code}, stage ${d.stage}`);
  block(d.text);

  // --- (e) to (g) the preview cards ------------------------------------------------------------------
  section("(e) The meme's preview card, with the host's PNG");
  writeFileSync(join(w.cwd, "noodle-cat.png"), AVATAR_PNG);
  const e = await w.run({ meme: { ...MEME, image: "noodle-cat.png" } });
  say(`exit ${e.code}, stage ${e.stage}`);
  block(e.text);

  section("(e2) The host's picture is a JPEG (ruling C9: PNG only): the league creature");
  writeFileSync(join(w.cwd, "noodle-cat.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  const e2 = await w.run({ meme: { ...MEME, image: "noodle-cat.jpg" } });
  say(`exit ${e2.code}, stage ${e2.stage}`);
  block(e2.text);

  section("(f) The host's picture is 262,145 bytes: the league creature");
  writeFileSync(join(w.cwd, "big.png"), Buffer.concat([Buffer.from(AVATAR_PNG.subarray(0, 8)), Buffer.alloc(262_145 - 8)]));
  const f = await w.run({ meme: { ...MEME, image: "big.png" } });
  say(`exit ${f.code}, stage ${f.stage}`);
  block(f.text);

  section("(g) No picture, and the league creature unavailable (404): the ticker's identicon");
  w.site.options.avatar = { status: 404 };
  const g = await w.run({ meme: MEME });
  say(`exit ${g.code}, stage ${g.stage}`);
  block(g.text);
  say(`pins so far: ${w.site.pins.length} (the dry run stops at the preview cards)`);
  say(`files under the throwaway home's league-entry: ${readdirSync(agentPaths(w.home, "league-entry").dir).sort().join(", ")}`);

  // --- (h) and (i): the agent under the season gate, on virtual time ---------------------------------
  const gated = async (title: string, league: (at: number) => Record<string, unknown>, minutes: number, buyAt: number) => {
    section(title);
    const root = mkdtempSync(join(tmpdir(), "feast-league-enter-dryrun-gate-"));
    roots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    // The agent as FL enter left it: the default strategy, confirmed, waiting for the season; an autopilot, so it reads the market once open.
    const e = world();
    await e.run({ autopilot: "sniper", idleMinutes: 1 });
    await e.run({ autopilot: "sniper", idleMinutes: 1, yes: true });
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "agents"), { recursive: true });
    const from = agentPaths(e.home, AGENT_ID);
    mkdirSync(agentPaths(home, AGENT_ID).dir, { recursive: true });
    writeFileSync(agentPaths(home, AGENT_ID).agent, readFileSync(from.agent));
    const T0 = Date.parse("2026-10-26T11:57:00Z");
    const clock = fakeClock(T0);
    const tw = tradeWorld({ now: clock.now });
    const feed = new FakeFeed(clock.now);
    feed.other = (url) => (url.origin === FEED_SITE && url.pathname === "/api/league" ? { status: 200, body: league(clock.now()) } : null);
    clock.at(T0 + buyAt, () => {
      mkdirSync(agentPaths(home, AGENT_ID).inbox, { recursive: true });
      writeJsonAtomic(join(agentPaths(home, AGENT_ID).inbox, "1-buy.json"), { type: "intent", requestId: "dry-buy", request: { kind: "buy", coin: FEAST, bnb: 0.002, reason: "manual buy" } });
    });
    const lines: string[] = [];
    await runAgent({ home, name: AGENT_ID, signer: tw.signer, chain: tw.chain, fetch: feed.fetch, site: FEED_SITE, indexer: FEED_INDEXER, now: clock.now, sleep: clock.sleep, random: seeded(968), loopMs: 1_000, maxRuntimeMs: minutes * 60_000, out: (l) => lines.push(`${utc8(clock.now())}:${String(new Date(clock.now()).getUTCSeconds()).padStart(2, "0")} ${l}`) });
    const log = readFileSync(agentPaths(home, AGENT_ID).log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string });
    const at = (iso: string) => `${utc8(Date.parse(iso))}:${String(new Date(iso).getUTCSeconds()).padStart(2, "0")}`;
    const shown = log.filter((l) => ["started", "inbox.refused", "request.outcome", "season.open", "autopilot.on", "jitter.done"].includes(l.event)).map((l) => `${at(l.at)} ${l.event} ${JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !["at", "event", "track", "preset", "tickSeconds", "events", "warmup", "autopilot", "feed", "pollMs"].includes(k))))}`);
    say("The runtime's notices (UTC+8):");
    block(lines.join("\n"));
    say("Its log, the lines that matter (UTC+8):");
    block(shown.join("\n"));
    const leagueReads = feed.asked.filter((x) => x.url.startsWith(`${FEED_SITE}/api/league?`)).map((x) => `${utc8(x.at)}:${String(new Date(x.at).getUTCSeconds()).padStart(2, "0")}`);
    const market = feed.asked.filter((x) => !x.url.startsWith(`${FEED_SITE}/api/league?`));
    say(`League reads: ${leagueReads.join(", ")}`);
    say(`First market read: ${market[0] ? `${utc8(market[0].at)}:${String(new Date(market[0].at).getUTCSeconds()).padStart(2, "0")} (${market[0].url.replace(FEED_SITE, "<site>")})` : "none"}; market reads in all: ${market.length}`);
    say(`Wallet trades (preview/execute): ${tw.calls.filter((x) => x === "preview" || x === "execute").length}`);
  };
  await gated("(h) The agent from the default, under the gate; trading opens in 3 simulated minutes (Monday 20:00 UTC+8)", () => leagueWire({ state: "season", season: { number: 1, day: 1, countdownTo: "2026-10-26T13:00:00.000Z" } }), 6, 60_000);
  await gated("(i) The same, with no start announced: it waits, and reads the league every 5 minutes", () => leagueWire({ state: "coming-soon", season: { number: 1, day: null, countdownTo: null } }), 16, 60_000);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
console.log(out.join("\n"));
