#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAddress, isAddress, type Address } from "viem";

import { approveCall, MAX_UINT160, permit2ApproveCall } from "../sdk/infinity.ts";
import { MAINNET } from "../sdk/networks.ts";
import { applyChange, confirmAgent, loadAgent, planAgent, saveAgent, type AgentConfig, type PlanInput } from "./agent.ts";
import { AUDIT_RULES } from "./audit/static.ts";
import { auditFile, auditRefusal, recordModelVerdict } from "./audit/verdict.ts";
import { BawError, BawSigner, execRunner } from "./baw.ts";
import { aliveLine, markStarting, readAlive, startingNow } from "./alive.ts";
import { manualBeat, readManual, recordManual, settleBeats } from "./manual.ts";
import { keepSupport, supportLine, supportUrl } from "./support.ts";
import { fit, logTail, saveReport, scrub, sendReport, type ReportBundle } from "./report.ts";
import { daemon, daemonPath, kickDaemon, windowsLines, type Runner } from "./daemon.ts";
import { bookView } from "./book.ts";
import { renderCard } from "./card.ts";
import { DEFAULT_MAINNET_RPC, LeagueChain } from "./chain.ts";
import { dataFace } from "./data/face.ts";
import { realRetry } from "./feed/backoff.ts";
import { drawStartJitter, parsePoll, START_JITTER_MS } from "./feed/snapshot.ts";
import { selfView } from "./data/self.ts";
import { INDEXER_URL } from "./events.ts";
import { refuseEarly } from "./early.ts";
import { Executor } from "./executor.ts";
import { impacts, quoteBuy, quoteSell } from "./quote.ts";
import { ASK_EVERY_MAX, ASK_EVERY_MIN, askKeyPath, hostShown } from "./ask/host.ts";
import { parseAnswerText, validateAnswer } from "./ask/pack.ts";
import { gatherPack } from "./ask/gather.ts";
import { journalPath, readAskState, readJournal } from "./ask/journal.ts";
import { readSnapshotCache, SnapshotClient, CACHE_FRESH_MS } from "./feed/snapshot.ts";
import { bnbToWei, weiToBnb } from "./limits.ts";
import { noteCommand } from "./notes/queue.ts";
import { liveToken, notesLogin, recordedAgentId } from "./notes/session.ts";
import { checkHost, checkModel, declareHost, hostDetailHint, modelHint, readDeclaredHost, RUNTIME_RELEASE } from "./headers.ts";
import { ACTIVITY_FLOOR_BNB, ACTIVITY_FLOOR_TRADES, LEAGUE_CAP_BNB, PAGE_IDLE_RULE } from "./prompt/constants.ts";
import { dayLine } from "./prompt/floor.ts";
import { readStanding } from "./data/standing.ts";
import { cadenceLine, readCadence } from "./feed/cadence.ts";
import { activeWaits } from "./doors.ts";
import { lastSleep, promptChanged, within } from "./prompt/host.ts";
import { outcomeLine, sendRequest, waitForOutcome } from "./prompt/inbox.ts";
import { PRESETS, PRESET_IDS } from "./presets/specs.ts";
import { BODY_COIN_QUOTE, BODY_COIN_SPLIT, bodyCoinNames } from "./register/claims.ts";
import {
  agentIdUnreadable,
  alreadyLaunchedLine,
  bodyCoinProblem,
  checkCard,
  duration,
  langOf,
  launchCard,
  launchedLine,
  launchFailedLine,
  launchPresetOwnLine,
  manifestoProblem,
  nextStepLine,
  noAgentIdCard,
  noAnswerLine,
  preregLine,
  previewMismatch,
  queuedLaunchLine,
  refusalLine,
  registerCard,
  seatedLine,
  sessionNotice,
  short,
  signingLine,
  utc8,
  walletNotReady,
  walletUnreadable,
  xHandleProblem,
  type Lang,
  type SessionCode,
} from "./register/copy.ts";
import { check, prepare, readLeagueRecord, submit, type FlowDeps } from "./register/flow.ts";
import { ENTRY_AGENT } from "./enter/constants.ts";
import { autopilotLine, awakeLine, clean, doneManual, driveByAnswerLine, referrerLine, tradeNowLine } from "./enter/copy.ts";
import { enter, entryOneShot, keepReferrerRead, keptReferrer, readEntry, referrerStatus } from "./enter/flow.ts";
import { normalizeManifesto, previewDescribes, signRequestMessage } from "./register/message.ts";
import { referralDeps } from "./register/referral.ts";
import { LeagueSite, seatingOfKept, siteFromEnv, type LeagueRead } from "./register/site.ts";
import { runAgent, statusOf } from "./runtime.ts";
import { checkLines, checkScript, scriptCheckPassed, writeCheckReport } from "./script/check.ts";
import { standingLines, type StandingInput } from "./season-card.ts";
import { noFloorTonight, readGate, SEASON_OVER_LINE, startSaysWaiting, tradingOpens, utc8Day, waitingStatusLine, type GateState, type Opening } from "./season-gate.ts";
import { sessionView, signInEndOf, signInLine } from "./session.ts";
import { readVersion, versionLine, versionView } from "./version.ts";
import { askChoice, autopilotChoice, prepareStart } from "./start.ts";
import { agentNameOf, agentPaths, appendJsonl, checkAgentName, leagueHome, readJson, readLedger, removeStop, stopReason, unreadNotifications, walletLockHolder, writeJsonAtomic, writeStop } from "./store.ts";
import type { IntentRequest } from "./strategy.ts";

const HELP = `feast-league — run a Feast agent with your Binance Agentic Wallet

  plan <name> --prompt <strategy.md> [--autopilot <${PRESET_IDS.join("|")}> | --no-autopilot] [--idle-minutes N] [--set key=value]… [--limit key=value]…
  start <name> --prompt <strategy.md> [--autopilot <preset> | --no-autopilot] [--idle-minutes N] [--yes] [--detach]
                                  prompt mode: your own agent decides by your prompt, with data, buy, sell and note; the
                                  runtime keeps the limits, and the autopilot backup (default steady, after 30 min) trades
                                  only after N minutes with no buy or sell from your agent (a note does not count);
                                  --no-autopilot turns it off. Without --yes: the card, and nothing starts
  plan <name> --preset <${PRESET_IDS.join("|")}> [--set key=value]… [--limit key=value]… [--tick s] [--sentence "…"]
  plan <name> --script <file.mjs> [--limit key=value]… [--tick s] [--sentence "…"]
                                  validate and save an agent, and print its confirmation card
  card <name>                     print the confirmation card again
  start <name> --yes [--detach]   the user said yes: confirm and start (real BNB, no practice mode), in the background
                                  (--foreground keeps it in this shell); --manual: manual mode instead (no loop), and
                                  FL start <name> without it switches a manual agent back to the loop
  stop <name> | --all             write the stop file and wait for the agent to halt
  resume <name> [--all] [--detach] remove the stop file (--all: the global one too) and start again
  start|resume <name> … [--poll <s>] [--live] [--no-jitter]
                                  the market: feast.meme's cached snapshot every s + 0–3 s (default 5, at least 3), backing off
                                  when the site is busy; --live reads the indexer's routes instead, at the same interval; the
                                  first read waits a random 0–120 s, so the 20:00 start is spread (--no-jitter: at once)
  status <name> [--json] [--lang en|zh] [--no-league]
                                  the book, the limits, what is new since the last status, and the league
  set <name> [--set k=v]… [--limit k=v]… [--tick s] (--yes | --review)
                                  change a confirmed agent (--review may only tighten)
  review <name>                   the last hour, as JSON, for the optional hourly review
  audit <file.mjs> [--model-verdict pass|refuse --notes "…"]
                                  the script audit: static rules, then the model read's verdict
  script check <file.mjs> [--json] the script against a stub world, through the real guard; a pass on record with a
                                  passed audit counts as the warm-up done for that exact file
  plan|start|enter … [--every N] [--ask-with claude|codex|gemini|cursor|openai|none] [--ask-model <name>]
        [--ask-base-url <url> [--ask-key-env <NAME>]]
                                  the ask loop: every N minutes (default 5, 2–120) without a buy or sell from your agent,
                                  the runtime asks your AI's headless CLI (claude -p, codex exec; default the host's own)
                                  what to do, and makes its one buy, sell or hold within the hard limits; the floor keeper
                                  (steady) trades when it fails twice in a row, and 20 minutes before dinner with the floor
                                  unmet. --ask-with none: no asks, the floor keeper after 30 min (v5). --ask-with openai
                                  asks an OpenAI-compatible endpoint (--ask-base-url, --ask-model; its key in the
                                  variable --ask-key-env names, or stored once with FL ask-key <name>)
  model <name> <model|default>    change the model the agent's AI is asked with (default: the host's own default)
  ask-key <name>                  read the endpoint's key on stdin and keep it for the agent (mode 0600; never shown)
  answer <name> '<json>'          a host with no headless CLI answers the last FL ask <name> --print by hand (within 10 min):
                                  the same check as an asked AI's, then the trade through FL buy's or FL sell's road
  every <name> <minutes>          change how often the agent is asked
  ask <name> [--print] [--json]   one ask now, into the running agent; --print: the exact pack it would send, nothing sent
  quote --coin <0x…|FEAST> --bnb <n> [--sell] [--fraction f] [--json]
                                  read-only: a buy's (or with --sell a sale's) expected fill, price impact, round-trip
                                  fees and minimum received; nothing is signed or sent
  data [<name>] [--since 24h|90m|7d|<iso>] [--coin 0x…] [--json] [--live] [--no-notes]
                                  every Feast coin in BNB, the agent's book and PnL in BNB, the league's clock and boards,
                                  and the public notes of the last 2 h with the crowd per coin; with --since, hourly
                                  history. Reads only: the coins from feast.meme's snapshot (--live: its pools, then the
                                  indexer's board)
  note <name> "<text>" [--tx 0x…] [--model grok|codex|claude|other]
                                  one reason, at most 280 characters, and the AI that wrote it (default: the host's hint,
                                  else other): kept here, sent to feast.meme with the season's notes session
  note --login                    open the season's notes session: one signed message (no gas), its token kept here
  buy <name> <coin|FEAST> <bnb> [--no-wait]
                                  one guarded buy, through the agent's limits; into a running agent it waits up to 90 s
                                  for the outcome (filled: exit 0; refused: exit 2)
  sell <name> <coin|FEAST> <fraction|all> [--no-wait]
  enter --name <id>.ai [--prompt <strategy.md>] [--meme "<concept>"] [--image <path>] [--no-start] [--yes] [--lang en|zh] [--json]
        [--coin-name "<…feed>" --symbol T --description "…"] [--autopilot <preset> | --no-autopilot] [--idle-minutes N]
        [--agent <name>] [--host <claude|codex|grok|other|gemini|cursor|opencode|openai|binance>] [--manual] [--no-jitter] [--no-daemon]
        [--ref <code>]                  a tutorial's referral code (or the pasted line with ?ref=<code> or ref: <code>):
                                  sent with the registration, unsigned; FL status shows it
                                  one command enters the league and runs your AI: one card and one yes sign the league's
                                  Register (no coin needed, no gas) and the notes session, then start the agent detached,
                                  waiting for the season: it trades nothing before. Without --prompt, the season-1 default
                                  is copied to ./strategy.md (never over one that is there). --no-start registers only.
                                  --meme launches one coin, composed by your agent, on its own card and its own yes
                                  (--name is the wallet's Agent ID here; FL start <name> restarts the agent). The agent's
                                  autopilot backup is on (default steady, after 30 min); --no-autopilot turns it off.
                                  --host names the AI that runs it, for feast.meme (kept here; default: the host's hint)
                                  --manual: no loop and no daemon (a host whose background processes die, Binance AI
                                  Pro): drive it with FL data, buy, sell, note, status; nothing trades on its own
  meme "<concept>" [--coin-name "<…feed>"] [--symbol T] [--description "…"] [--image <file.png>] [--yes]
                                  after the entry: the meme's compose card, then its preview card; one coin per agent
  register <name> --check [--body-coin 0x…] [--lang en|zh]
                                  the league registration check: Agent ID, the agent's coin, seat (reads only)
  register <name> --manifesto "…" [--body-coin 0x…] [--x handle] [--pending] [--lang en|zh] [--yes]
                                  the registration card; with --yes (the user's word): sign (no gas) and send to the league page
  launch <name> [--name "…"] [--symbol T] [--quote WBNB|<stock>] [--description "…"] [--lang en|zh] [--yes]
                                  an agent's one coin, its card; with --yes: one launch through the agent's limits
  preview <buy|approve|permit2|sell|claim|create|register> [--coin c] [--bnb x]
                                  preview-only checks: the wallet's answer, nothing executed
  agents                          the agents on this machine
  doctor                          is everything in place?
  report <name>                   a problem report: doctor, status, the last 200 log lines, the release, scrubbed of
                                  addresses, keys and paths; saved as a file to paste in a chat, and sent to feast.meme
                                  with the notes session (at most once per 10 minutes)
  login [--json]                  the wallet's sign-in: until when it is valid, and how to scan again (reads only)
  daemon <name> --install | --uninstall | --status
                                  keep the agent running across reboots and crashes: a LaunchAgent (macOS) or a
                                  systemd user unit (Linux) that runs \`run <name> --supervised\`; FL stop still stops it

Home: $FEAST_LEAGUE_HOME (default ~/.feast-league). RPC: $FEAST_MAINNET_RPC_URL (default the Binance dataseed).
Site: $FEAST_LEAGUE_SITE (default https://feast.meme). Indexer: $FEAST_LEAGUE_INDEXER (default https://indexer.feast.meme).`;

const BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function kv(list: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of list ?? []) {
    const i = item.indexOf("=");
    if (i <= 0) throw new Error(`"${item}" is not key=value`);
    const key = item.slice(0, i).trim();
    const raw = item.slice(i + 1).trim();
    out[key] = raw === "true" ? true : raw === "false" ? false : raw === "off" ? null : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

function signerFor(home: string, name: string | null): BawSigner {
  return new BawSigner(execRunner(), (command) => {
    if (name) appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "baw.invoke", command });
  });
}

const rpc = () => process.env.FEAST_MAINNET_RPC_URL?.trim() || DEFAULT_MAINNET_RPC;
/** A whole number given on the command line, else NaN (so the plan's own check says what is wrong); undefined when not given. */
const wholeOrNaN = (v: string | undefined) => (v === undefined ? undefined : /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN);
const indexer = () => (process.env.FEAST_LEAGUE_INDEXER?.trim() || INDEXER_URL).replace(/\/+$/, "");
/**
 * Run 22 (the owner's ruling: we must see players' problems fast): a refusal or an error, the "You're in" lines and
 * FL status end with one line naming where to get help (the page's own support link, else the league page's help).
 * Said once, last, in human output only.
 */
const help = { due: false, home: null as string | null, lang: "en" as "en" | "zh", json: false };
const helpDue = () => void (help.due = true);
function sayHelp(stream: "out" | "err" = "out"): void {
  if (help.json) return;
  const line = supportLine(help.home ? supportUrl(help.home) : null, help.lang);
  if (stream === "err") console.error(line);
  else console.log(line);
}
const print = (json: boolean, data: unknown, human: () => string) => {
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { ok?: unknown }).ok === false) helpDue();
  console.log(json ? JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) : human());
};

function detach(home: string, name: string, extra: string[] = []): number {
  return spawnDetached(home, name, extra).pid ?? 0;
}
function spawnDetached(home: string, name: string, extra: string[]) {
  const paths = agentPaths(home, name);
  mkdirSync(paths.dir, { recursive: true });
  const outFd = openSync(join(paths.dir, "runtime.out"), "a", 0o600);
  const child = spawn(process.execPath, [BIN, "run", name, ...extra], { detached: true, stdio: ["ignore", outFd, outFd], env: { ...process.env, FEAST_LEAGUE_HOME: home } });
  child.unref();
  // Run 21: "starting" in FL status until its first tick (or 30 s), never "not running" while it boots.
  markStarting(home, name, child.pid ?? null);
  return child;
}
/** How long `FL start` watches the background start for an exit at once (a refusal, a signed-out wallet). */
const START_WATCH_MS = 3_000;
/**
 * Run 19: `FL start` in the background, and watched for a moment: a start that exits at once (a refusal) is said with
 * its own last line, never "started". Null: it is running.
 */
async function detachWatched(home: string, name: string, extra: string[]): Promise<{ pid: number; ended: string | null }> {
  const child = spawnDetached(home, name, extra);
  const ended = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => done(null), START_WATCH_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code ?? 1);
    });
  });
  if (ended === null) return { pid: child.pid ?? 0, ended: null };
  const out = existsSync(join(agentPaths(home, name).dir, "runtime.out")) ? readFileSync(join(agentPaths(home, name).dir, "runtime.out"), "utf8").trim().split("\n") : [];
  return { pid: child.pid ?? 0, ended: clean(out.at(-1) ?? `exit ${ended}`, 300) };
}

/** What `FL start` says of an agent that waits for the season (task 968). */
const waitingLine = (name: string, opensAt: string | null = null) =>
  opensAt && Number.isFinite(Date.parse(opensAt)) ? `"${name}" waits for the season: season starts and trading opens ${utc8Day(Date.parse(opensAt))} UTC+8; it trades nothing before` : `"${name}" waits for the season: it trades nothing before it opens; FL status ${name} shows when`;

async function waitForExit(home: string, name: string, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1_000;
  while (Date.now() < until) {
    if (!statusOf(home, name).running) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !statusOf(home, name).running;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      preset: { type: "string" },
      script: { type: "string" },
      set: { type: "string", multiple: true },
      limit: { type: "string", multiple: true },
      tick: { type: "string" },
      sentence: { type: "string" },
      yes: { type: "boolean", default: false },
      review: { type: "boolean", default: false },
      detach: { type: "boolean", default: false },
      foreground: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      wait: { type: "string" },
      json: { type: "boolean", default: false },
      "model-verdict": { type: "string" },
      notes: { type: "string" },
      "max-runtime": { type: "string" },
      // Task 975, addendum 8: FL daemon, and the supervised run it starts.
      install: { type: "boolean", default: false },
      uninstall: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      supervised: { type: "boolean", default: false },
      "no-daemon": { type: "boolean", default: false },
      // Addendum 12: a tutorial's referral code (bare, or the pasted line).
      ref: { type: "string" },
      coin: { type: "string" },
      bnb: { type: "string" },
      home: { type: "string" },
      "clear-pause": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      manifesto: { type: "string" },
      "body-coin": { type: "string" },
      x: { type: "string" },
      pending: { type: "boolean", default: false },
      lang: { type: "string" },
      name: { type: "string" },
      symbol: { type: "string" },
      quote: { type: "string" },
      description: { type: "string" },
      "no-league": { type: "boolean", default: false },
      prompt: { type: "string" },
      autopilot: { type: "string" },
      "no-autopilot": { type: "boolean", default: false },
      // Task 975, addenda 4 and 5: the ask loop, FL ask and FL quote.
      every: { type: "string" },
      "ask-with": { type: "string" },
      "ask-model": { type: "string" },
      "ask-base-url": { type: "string" },
      "ask-key-env": { type: "string" },
      print: { type: "boolean", default: false },
      sell: { type: "boolean", default: false },
      fraction: { type: "string" },
      host: { type: "string" },
      "idle-minutes": { type: "string" },
      since: { type: "string" },
      tx: { type: "string" },
      "no-wait": { type: "boolean", default: false },
      model: { type: "string" },
      login: { type: "boolean", default: false },
      poll: { type: "string" },
      live: { type: "boolean", default: false },
      "no-jitter": { type: "boolean", default: false },
      // FL start's drawn wait, handed to a detached `run` (seconds); not for the user.
      "start-jitter": { type: "string" },
      // FL enter and FL meme (task 968).
      meme: { type: "string" },
      "coin-name": { type: "string" },
      image: { type: "string" },
      "no-start": { type: "boolean", default: false },
      manual: { type: "boolean", default: false },
      agent: { type: "string" },
      "no-notes": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return values.help || command ? 0 : 1;
  }
  const home = values.home ?? leagueHome();
  const json = values.json;
  help.home = home;
  help.json = json === true;
  help.lang = langOf(values.lang);
  // Task 975 (the coordinator's ruling C8): the AI this home's agent runs on, declared once by FL enter --host; every
  // request to feast.meme names it (x-feast-host), and FL note's --model defaults to it.
  if (values.host !== undefined) {
    const host = checkHost(values.host);
    if (command !== "enter" || !host.ok) {
      const line = command !== "enter" ? "--host goes with enter" : host.ok ? "" : host.reason;
      print(json, { ok: false, error: line }, () => line);
      return 2;
    }
    declareHost(home, host.detail ?? host.model);
  }
  const declared = readDeclaredHost(home);
  if (declared) process.env.FEAST_LEAGUE_HOST = declared;
  const need = (value: string | undefined, what: string) => {
    if (!value) throw new Error(`missing ${what}; see FL --help`);
    return value;
  };
  /** An agent's name; `<id>.ai` (the Agent ID as the player sees it) is the same agent (run 19). */
  const agentArg = (value: string | undefined) => agentNameOf(need(value, "an agent name"));
  /**
   * Run 21: a manual command keeps the seat lit (the loop's heartbeat, for a player who drives by hand), at most once
   * per 2 minutes per agent; a running loop sends its own, so nothing is sent for it here.
   */
  const beat = (raw: string | undefined) => {
    const name = raw ? agentNameOf(raw) : (readEntry(home)?.agent ?? null);
    if (!name || name === ENTRY_AGENT || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || statusOf(home, name).running) return;
    void manualBeat({ home, name, site: siteFromEnv(), fetch, wallet: () => signerFor(home, null).address() });
  };
  /** league-entry is FL enter's own agent: the season's commands never plan, start or change it. */
  const notEntry = (name: string) => {
    if (name === ENTRY_AGENT) throw new Error(`${ENTRY_AGENT} is FL enter's; plan your season agent under another name`);
    return name;
  };
  /** What plan and start --prompt plan from: a prompt with at most one preset as its autopilot, or a preset, or a script. */
  const planInput = (name: string): PlanInput => {
    if (values.autopilot !== undefined && values.prompt === undefined) throw new Error("--autopilot is a prompt agent's fallback: give the prompt with --prompt <strategy.md>");
    if (values["no-autopilot"] && values.prompt === undefined) throw new Error("--no-autopilot is a prompt agent's: give the prompt with --prompt <strategy.md>");
    if (values["idle-minutes"] !== undefined && values.prompt === undefined) throw new Error("--idle-minutes goes with --prompt and --autopilot");
    if (values.prompt !== undefined && values.preset !== undefined) throw new Error("with --prompt, name the fallback preset with --autopilot, not --preset");
    // Task 975: a prompt agent's autopilot backup is steady unless --autopilot names another or --no-autopilot.
    const choice = autopilotChoice({ autopilot: values.autopilot, noAutopilot: values["no-autopilot"] });
    // Addendum 4: the ask loop rides with the autopilot (the floor keeper underneath), never on a preset or a script.
    if ((values.every !== undefined || values["ask-with"] !== undefined || values["ask-model"] !== undefined || values["ask-base-url"] !== undefined || values["ask-key-env"] !== undefined) && values.prompt === undefined) throw new Error("--every and --ask-with are a prompt agent's: give the prompt with --prompt <strategy.md>");
    const asked = askChoice({ noAutopilot: values["no-autopilot"], every: wholeOrNaN(values.every), askWith: values["ask-with"], askModel: values["ask-model"], askBaseUrl: values["ask-base-url"], askKeyEnv: values["ask-key-env"], host: modelHint(), detail: hostDetailHint() });
    return {
      name,
      preset: values.prompt !== undefined ? (choice.ok ? choice.preset : undefined) : values.preset,
      scriptPath: values.script,
      promptPath: values.prompt,
      idleMinutes: values["idle-minutes"] !== undefined ? Number(values["idle-minutes"]) : undefined,
      ...(values.prompt !== undefined && asked.ok && asked.ask ? { ask: asked.ask } : {}),
      params: kv(values.set),
      limits: kv(values.limit),
      tickSeconds: values.tick ? Number(values.tick) : undefined,
      sentence: values.sentence,
    };
  };

  /** Both --autopilot and --no-autopilot: one line, exit 2, nothing saved (task 975). */
  const both = autopilotChoice({ autopilot: values.autopilot, noAutopilot: values["no-autopilot"] });
  const askFlags = askChoice({ noAutopilot: values["no-autopilot"], every: wholeOrNaN(values.every), askWith: values["ask-with"], askModel: values["ask-model"], askBaseUrl: values["ask-base-url"], askKeyEnv: values["ask-key-env"], host: modelHint(), detail: hostDetailHint() });
  const conflict = !both.ok ? both : !askFlags.ok ? askFlags : null;
  if (conflict && !conflict.ok && (command === "plan" || command === "start" || command === "enter")) {
    print(json, { ok: false, error: conflict.error }, () => conflict.error);
    return 2;
  }

  switch (command) {
    case "plan": {
      const name = notEntry(agentArg(args[0]));
      const planned = planAgent(planInput(name));
      if (!planned.ok) {
        print(json, { ok: false, errors: planned.errors }, () => `not planned:\n- ${planned.errors.join("\n- ")}`);
        return 2;
      }
      const existing = loadAgent(home, name);
      if (existing && statusOf(home, name).running) throw new Error(`agent "${name}" is running; stop it, or change it with FL set`);
      saveAgent(home, planned.agent);
      if (planned.audit) auditFile(home, planned.agent.script!.path, { maxBuyBnb: planned.agent.limits.maxAtWorkBnb });
      print(json, { ok: true, agent: planned.agent, audit: planned.audit, card: renderCard(planned.agent, planned.audit) }, () => renderCard(planned.agent, planned.audit));
      return 0;
    }
    case "card": {
      const agent = loadAgent(home, agentArg(args[0]));
      if (!agent) throw new Error("no such agent");
      console.log(renderCard(agent, null, { warmupPassed: agent.track === "script" && scriptCheckPassed(home, agent.script!.sha256) }));
      // Addendum 11: the card carries the agent's last tick and the sign-in's end.
      if (agent.track !== "entry") {
        const end = signInEndOf(home, agent.name);
        console.log(["", aliveLine(readAlive(home, agent.name), statusOf(home, agent.name).running, Date.now()), ...(signInLine(end, utc8) ? [signInLine(end, utc8)!] : [])].join("\n"));
      }
      return 0;
    }
    case "start":
    case "resume":
    case "run": {
      // The market's interval (task 967), checked before anything else: below 3 s is refused, never clamped.
      const poll = parsePoll(values.poll);
      if (!poll.ok) {
        print(json, { ok: false, error: poll.error }, () => poll.error);
        return 2;
      }
      const given = values["start-jitter"];
      if (given !== undefined && !(/^\d{1,3}$/.test(given) && Number(given) * 1_000 <= START_JITTER_MS)) throw new Error("--start-jitter is FL start's own: 0–120 whole seconds");
      const name = notEntry(agentArg(args[0]));
      if (values.prompt !== undefined && command !== "start") throw new Error("--prompt goes with plan or start");
      if (command === "resume") {
        if (!loadAgent(home, name)) throw new Error(`no agent "${name}": plan it first`);
        removeStop(agentPaths(home, name).stop);
        if (existsSync(join(home, "STOP"))) {
          if (!values.all) throw new Error("the global stop file is present too (FL stop --all wrote it); resume with --all to remove it");
          removeStop(join(home, "STOP"));
        }
      }
      if (values.manual && command !== "start") throw new Error("--manual goes with enter or start");
      // Run 21: FL start --manual puts the agent in manual mode (no loop); FL start without it switches it to the loop.
      if (command === "start" && statusOf(home, name).running && values.manual) {
        print(json, { ok: false, running: true }, () => `"${name}" is running its loop: FL stop ${name} first, then FL start ${name} --manual`);
        return 2;
      }
      // start --prompt: plan first when there is no agent yet, or its prompt, autopilot, parameters or limits changed.
      const checked = prepareStart(home, name, { plan: values.prompt !== undefined ? planInput(name) : null, yes: values.yes === true, confirm: command !== "run", ...(command === "start" ? { manual: values.manual === true } : {}) });
      if (checked.kind === "not-planned") {
        print(json, { ok: false, errors: checked.errors }, () => `not planned:\n- ${checked.errors.join("\n- ")}`);
        return 2;
      }
      if (checked.kind === "running") throw new Error(`agent "${name}" is running; stop it first (FL stop ${name}), then start it with the new prompt`);
      if (checked.kind === "no-agent") throw new Error(`no agent "${name}": plan it first`);
      if (checked.kind === "needs-yes") {
        console.log(`${checked.card}\n\nNot started: this needs the user's explicit yes (--yes).`);
        return 2;
      }
      if (checked.kind === "refused") {
        print(json, { ok: false, refused: checked.why }, () => `not started: ${checked.why}`);
        return 2;
      }
      const agent = checked.agent;
      if (checked.replanned && checked.confirmedNow) console.log(`${renderCard(agent)}\n`);
      if (agent.manual && command !== "run") {
        const g = readGate(home, name);
        const opensAt = g?.opensAt ? Date.parse(g.opensAt) : null;
        const opens = g?.state === "open" ? ({ kind: "open" } as const) : opensAt !== null && Number.isFinite(opensAt) ? ({ kind: "at", at: opensAt } as const) : ({ kind: "unknown" } as const);
        print(json, { ok: true, manual: true }, () => doneManual(name, opens, langOf(values.lang), true));
        return 0;
      }
      const extra = [...(values["max-runtime"] ? ["--max-runtime", values["max-runtime"]] : []), ...(values.poll !== undefined ? ["--poll", String(poll.seconds)] : []), ...(values.live ? ["--live"] : []), ...(values["no-jitter"] ? ["--no-jitter"] : [])];
      // FL start (and resume, which is a start) spreads the 20:00 start; `run` waits only what it is handed.
      const jitterMs = command === "run" ? Number(given ?? 0) * 1_000 : values["no-jitter"] ? 0 : drawStartJitter();
      const readsMarket = agent.track === "script" || (agent.preset !== null && agent.preset !== "launch");
      const jitterLine = readsMarket && jitterMs > 0 ? `starts reading the market within ${Math.ceil(jitterMs / 1_000)} s` : null;
      if (command === "resume" && statusOf(home, name).running) {
        // Running already (an L14 pause stops entries, not the runtime): the user's resume clears the pause in place.
        const paths = agentPaths(home, name);
        mkdirSync(paths.inbox, { recursive: true });
        writeJsonAtomic(join(paths.inbox, `${Date.now()}-unpause.json`), { type: "unpause" });
        console.log(`"${name}" is running; its pause is cleared`);
        return 0;
      }
      // Run 19: FL start and FL resume run the agent in the background by default (in the foreground it died with the
      // player's shell); --foreground keeps it in this shell, for debugging. `FL run` (the daemon's) stays in the foreground.
      if (!values.foreground && command !== "run") {
        if (statusOf(home, name).running) {
          console.log(`"${name}" is running already; FL status ${name}`);
          return 0;
        }
        const stopped = stopReason(home, name);
        if (stopped) {
          print(json, { ok: false, stopped }, () => `"${name}" is stopped (${stopped}): FL resume ${name} removes the stop and starts it`);
          return 2;
        }
        const holder = walletLockHolder(home);
        if (holder) throw new Error(`the wallet is in use by agent "${holder.agent}"; stop it first`);
        const waits = startSaysWaiting(agent.league?.waitForSeason === true, readGate(home, name));
        // A daemon of its own starts it, when nothing more is asked of this start (a supervisor runs `FL run` as written).
        if (command === "start" && extra.filter((a) => a !== "--no-jitter").length === 0 && (process.platform === "darwin" || process.platform === "linux") && process.env.FEAST_LEAGUE_DAEMON?.trim().toLowerCase() !== "off") {
          const kicked = await kickDaemon({ platform: process.platform, name, uid: process.getuid?.() ?? 0, run: supervisorRunner, userHome: homedir(), isRunning: () => statusOf(home, name).running });
          if (kicked.installed && kicked.running) {
            console.log(`"${name}" is started by this machine's daemon: it keeps running when this shell closes, and comes back by itself after a reboot or a crash; FL status ${name}`);
            if (waits) console.log(waitingLine(name, readGate(home, name)?.opensAt ?? null));
            return 0;
          }
          if (kicked.installed) console.log(`its daemon did not start it (${kicked.state ? `state "${kicked.state}"` : "its state could not be read"}): starting it in the background instead`);
        }
        const { pid, ended } = await detachWatched(home, name, [...extra, ...(command === "resume" ? ["--clear-pause"] : []), ...(jitterMs > 0 ? ["--start-jitter", String(Math.ceil(jitterMs / 1_000))] : [])]);
        if (ended !== null) {
          print(json, { ok: false, ended }, () => `"${name}" did not keep running: ${ended}`);
          return 2;
        }
        console.log(`started "${name}" in the background (pid ${pid}): it keeps running when this shell closes; FL status ${name}`);
        if (jitterLine) console.log(jitterLine);
        // Addendum 10: only while the gate is not open (a restart in the season, or after it, waits for nothing).
        if (waits) console.log(waitingLine(name, readGate(home, name)?.opensAt ?? null));
        return 0;
      }
      if (jitterLine && command !== "run") console.log(jitterLine);
      const outcome = await runAgent({
        home,
        name,
        signer: signerFor(home, name),
        rpcUrl: rpc(),
        site: siteFromEnv(),
        indexer: indexer(),
        maxRuntimeMs: values["max-runtime"] ? Number(values["max-runtime"]) * 1_000 : undefined,
        clearPause: command === "resume" || values["clear-pause"],
        pollMs: poll.seconds * 1_000,
        live: values.live,
        startJitterMs: jitterMs,
        noJitter: values["no-jitter"],
      });
      console.log(`${name}: ${outcome.exit} — ${outcome.reason}`);
      // Under a supervisor (FL daemon, addendum 8) a refusal (a stop file, a signed-out wallet) exits 0: it is not
      // restarted into the same refusal every minute; an error exits 1 and is.
      return outcome.exit === "error" ? 1 : outcome.exit === "refused" ? (values.supervised ? 0 : 2) : 0;
    }
    case "stop": {
      const names = values.all ? (existsSync(join(home, "agents")) ? readdirSync(join(home, "agents")) : []) : [need(args[0], "an agent name (or --all)")];
      if (values.all) writeStop(join(home, "STOP"), "stop requested by the user");
      for (const name of names) {
        // league-entry's own stop file could not be cleared (resume refuses the name); the global one already halts it.
        if (values.all && name === ENTRY_AGENT) continue;
        writeStop(agentPaths(home, name).stop, "stop requested by the user");
        const exited = await waitForExit(home, name, values.wait ? Number(values.wait) : 150);
        console.log(`${name}: ${exited ? "halted" : "the stop file is written; the runtime has not exited yet (it finishes recording a sent transaction first)"}`);
      }
      return 0;
    }
    case "status": {
      const name = agentArg(args[0]);
      beat(name);
      // Run 22: FL status ends with where to get help.
      helpDue();
      const s = statusOf(home, name);
      if (!s.agent) throw new Error("no such agent");
      const view = s.book ? bookView(s.book, undefined, Date.now()) : null;
      const lang = langOf(values.lang);
      const unread = unreadNotifications(home, name, true);
      // Task 975, addendum 2: a prompt agent's own line closes the status: in season, the host is told to trade now.
      const shownAutopilot = s.agent.preset && s.agent.autopilot ? { preset: s.agent.preset, idleMinutes: s.agent.autopilot.idleMinutes, ...(s.agent.ask ? { ask: { every: s.agent.ask.every, with: s.agent.ask.with } } : {}) } : null;
      const standingAgent = { track: s.agent.track, autopilot: shownAutopilot, promptFile: basename(s.agent.prompt?.path ?? "strategy.md"), name, manual: s.agent.manual === true };
      // Run 21: manual mode (no loop), and "starting" in the seconds after a start, instead of "not running".
      const manualNow = s.agent.manual === true && !s.running;
      const startingAgent = !s.running && !manualNow && startingNow(home, name);
      const runState = s.running ? "running" : manualNow ? "manual mode" : startingAgent ? "starting" : "not running";
      const lastManual = readManual(home, name);
      const manualLine = `manual mode: no loop and no daemon; last manual action ${lastManual ? `${utc8(Date.parse(lastManual.at))} UTC+8 (${duration(Date.now() - Date.parse(lastManual.at), "en")} ago): ${clean(lastManual.what, 160)}` : "none yet"}`;
      const league = values["no-league"] ? null : await leagueStanding(home, lang, standingAgent).catch(() => null);
      // The agent's figures in BNB (task 963), marked on the chain only when it holds something; a USDT figure is a reference.
      const holds = Object.keys(s.book?.positions ?? {}).length > 0;
      const chain = new LeagueChain(MAINNET, rpc());
      const statusWallet = await within(signerFor(home, null).address(), 5_000).catch(() => null);
      const mine = await selfView(home, name, { chain, now: Date.now(), wallet: statusWallet, marksTimeoutMs: holds ? 8_000 : 4_000 }).catch(() => null);
      const bnbUsd = mine && (holds || mine.pnl.realizedBnb !== 0) ? await within(chain.bnbUsd(), 8_000) : null;
      const usdRef = typeof bnbUsd === "number" && bnbUsd > 0 ? { bnbUsd: Number(bnbUsd.toFixed(4)), at: new Date().toISOString() } : null;
      const sleptAt = lastSleep(home, name);
      const release = (league?.latestRuntime ? versionView(league.latestRuntime, Date.now()) : null) ?? readVersion(home, name) ?? null;
      // Run 17: the referral binding, read from the registry itself when this entry carries a code.
      const entryRecord = readEntry(home);
      // Run 19: once read as bound it is kept (a referrer never changes), and the chain is not asked again.
      const referrerKept = keptReferrer(entryRecord);
      const referrerOn = !entryRecord?.ref ? null : referrerKept ? referrerKept : statusWallet ? await within(referralDeps({ site: siteFromEnv(), fetch, client: chain.client as never }).referrerOf(statusWallet), 6_000).catch(() => "unreadable" as const) : ("unreadable" as const);
      if (entryRecord?.ref && !referrerKept && referrerOn && referrerOn !== "unreadable") keepReferrerRead(home, referrerOn, Date.now());
      const signInEnd = signInEndOf(home, name);
      const askState = readAskState(home, name);
      const askNow = { lastAskAt: askState.lastAskAt === null ? null : new Date(askState.lastAskAt).toISOString(), last: askState.last ? { ...askState.last, at: new Date(askState.last.at).toISOString() } : null, failuresInARow: askState.streak, floorKeeperSince: askState.floorKeeperSince === null ? null : new Date(askState.floorKeeperSince).toISOString() };
      const data = {
        name,
        running: s.running,
        stop: s.stop,
        track: s.agent.track,
        preset: s.agent.preset,
        confirmed: s.agent.confirmed?.at ?? null,
        limits: s.agent.limits,
        positions: s.book ? Object.values(s.book.positions).map((p) => ({ coin: p.coin, symbol: p.symbol, coins: p.coins, costBnb: weiToBnb(p.costWei), armed: p.armed, ownLaunch: p.ownLaunch })) : [],
        spent24hBnb: view ? weiToBnb(view.spent24hWei) : 0,
        leagueSpentBnb: weiToBnb(readLedger(home).spentWei),
        realizedBnb: s.book ? weiToBnb(s.book.realizedTotalWei) : 0,
        gasBnb: s.book ? weiToBnb(s.book.gasWei) : 0,
        counters: s.book?.counters ?? null,
        paused: s.book?.paused ?? null,
        warmup: s.book?.warmup ?? null,
        pnl: mine?.pnl ?? null,
        capital: mine?.capital ?? null,
        usdRef,
        prompt: mine?.prompt ?? null,
        autopilot: mine?.autopilot ?? null,
        lastTradeAt: mine?.lastTradeAt ?? null,
        lastActionAt: mine?.lastActionAt ?? null,
        // Task 975: the day's trades and volume, dinner to dinner, as the page counts its floor.
        day: mine?.day ?? null,
        // Task 975, addenda 4 and 5: the ask loop, the wallet and the limits' headroom (one source with FL data and the pack).
        ask: s.agent.ask ? { ...s.agent.ask, ...askNow } : null,
        wallet: mine?.wallet ?? null,
        headroom: mine?.headroom ?? null,
        recentFills: mine?.recentFills ?? [],
        // Task 975, addendum 6: how often it reads the market, and the doors that asked it to wait.
        cadence: readCadence(home, name),
        doorWaits: activeWaits(home, name, Date.now()).map((w) => ({ door: w.door, until: new Date(w.until).toISOString() })),
        // Task 975, addendum 3: the newest time the machine slept under the runtime.
        slept: sleptAt ? { at: new Date(sleptAt.at).toISOString(), minutes: sleptAt.minutes } : null,
        notifications: s.notifications,
        unread,
        league: league?.data ?? null,
        // Task 968: an agent FL enter started waits for the season's opening; addendum 8: any prompt agent's gate (the season's end, the warm-up).
        season: s.agent.league?.waitForSeason ? (readGate(home, name) ?? { state: "waiting", opensAt: null, at: null }) : s.agent.track === "prompt" ? readGate(home, name) : null,
        // Task 975, addendum 8: the release against the page's newest (this read's, else the runtime's last), and the sign-in's end.
        runtime: release,
        // Addendum 11: alive since, and the last tick.
        alive: readAlive(home, name),
        // Addendum 12: the referral code sent with the registration, from the entry's record (kept nowhere else).
        referral: entryRecord?.ref ?? null,
        // Run 18: where the referrer stands (null with no code: an entry with no code says nothing about referrals).
        referrer: referrerStatus(entryRecord, referrerOn, Date.now()),
        signInEndsAt: signInEnd === null ? null : new Date(signInEnd).toISOString(),
        // Run 21.
        state: runState,
        manual: s.agent.manual === true,
        lastManual,
        // Task 1020: the style of the season-1 default strategy v1.1 FL enter copied, or null.
        persona: s.agent.persona ?? null,
      };
      const gate = data.season;
      const seasonOverNow = gate?.state === "over";
      // Addendum 12: the season starts and trading opens at one instant.
      // Run 19: the date the card named, from the page itself when this agent's gate has not read it (not running yet).
      const pageOpens = league?.opens.kind === "at" ? league.opens.at : null;
      const waiting = gate && gate.state === "waiting" ? [waitingStatusLine(gate.opensAt ? Date.parse(gate.opensAt) : pageOpens)] : [];
      const ago = (at: string | null) => (at ? `${duration(Date.now() - Date.parse(at), "en")} ago` : "never");
      const signed = (n: number) => `${n >= 0 ? "+" : ""}${Number(n.toPrecision(6))} BNB`;
      const selfLines = mine
        ? [
            `PnL: realized ${signed(mine.pnl.realizedBnb)}, unrealized ${holds ? signed(mine.pnl.unrealizedBnb) : "none"}${usdRef ? ` (≈ ${((mine.pnl.realizedBnb + mine.pnl.unrealizedBnb) * usdRef.bnbUsd).toFixed(2)} USDT)` : ""}; at work: ${mine.capital.atWorkBnb} of ${mine.capital.capBnb} BNB in open positions, wallet-wide (a sale frees room)`,
            ...(mine.prompt
              ? [
                  `prompt: ${mine.prompt.path} (sha256 ${mine.prompt.sha256.slice(0, 6)}…${mine.prompt.sha256.slice(-4)})${mine.prompt.changed ? `; CHANGED since the user's yes: FL start ${name} --prompt ${mine.prompt.path} shows the new card` : ""}`,
                  ...(data.persona ? [`style: ${data.persona} (the season-1 default strategy v1.1, as FL enter copied it)`] : []),
                  // Addendum 10: after the season, nothing about asking or the floor keeper: the season-over line says it all.
                  ...(seasonOverNow
                    ? []
                    : manualNow
                    ? ["nothing trades on its own in manual mode: no autopilot, no floor keeper and no stop-loss watcher; trade by hand with FL buy and FL sell"]
                    : s.agent!.ask && s.agent!.ask.with !== "none"
                    ? [
                        `asking ${hostShown(s.agent!.ask.with)} every ${s.agent!.ask.every} min with ${s.agent!.ask.model ?? "its default model"} · last ask ${askState.last ? `${utc8(askState.last.at)} UTC+8 → ${askState.last.action}${askState.last.reason ? ` (${clean(askState.last.reason, 80)})` : ""}: ${clean(askState.last.result, 80)}` : "none yet"} · failures in a row ${askState.streak}${askState.floorKeeperSince !== null ? ` · on floor keeper since ${utc8(askState.floorKeeperSince)} UTC+8` : ""}`,
                        mine.autopilot ? `floor keeper: ${mine.autopilot.preset}, when ${hostShown(s.agent!.ask.with)} fails twice in a row, and 20 min before dinner with the floor unmet` : "floor keeper: none",
                      ]
                    : [
                        mine.autopilot ? `autopilot: ${mine.autopilot.preset}, after ${mine.autopilot.idleMinutes} min with no trade from your agent (${mine.autopilot.active ? "trading now" : "standing by"})` : "autopilot: none; nothing trades on its own but the hard stop-loss",
                        // Run 21: nobody is asked (--ask-with none): how the player's AI decides by hand.
                        ...(s.agent!.track === "prompt" && mine.autopilot ? [driveByAnswerLine(name, "en")] : []),
                      ]),
                  ...(cadenceLine(readCadence(home, name)) ? [cadenceLine(readCadence(home, name))!] : []),
                  ...activeWaits(home, name, Date.now()).concat(activeWaits(home, ENTRY_AGENT, Date.now())).map((w) => `feast.meme asked ${w.door === "notes" ? "the notes" : w.door === "session" ? "the notes session" : w.door} to wait until ${utc8(w.until)} UTC+8 (429): nothing is sent there before`),
                  ...(mine.wallet ? [`wallet: ${mine.wallet.balanceBnb} BNB, ${mine.wallet.spendableBnb} spendable (${mine.wallet.gasReserveBnb} kept for gas); room to buy now ${mine.headroom.roomToBuyBnb} BNB`] : []),
                  `last trade ${ago(mine.lastTradeAt)}; last action by your agent ${ago(mine.lastActionAt)}`,
                  ...(mine.day ? [dayLine(mine.day, Date.now())] : []),
                  ...(mine.day && !mine.day.passed && !mine.day.noFloor && !seasonOverNow && !mine.autopilot?.active
                    ? [
                        // Addendum 7: in ask mode the unified line (the asks, then the floor keeper), not league-v5's first cut.
                        manualNow
                          ? `manual mode: the day's floor is yours to make by hand (${ACTIVITY_FLOOR_TRADES} trades and ${ACTIVITY_FLOOR_BNB} BNB), or the agent gets eaten at the dinner`
                          : s.agent!.ask && s.agent!.ask.with !== "none" && mine.autopilot
                          ? autopilotLine({ preset: mine.autopilot.preset, idleMinutes: mine.autopilot.idleMinutes, ask: s.agent!.ask }, "en")
                          : mine.autopilot
                            ? `while your agent trades, the day's floor is its to keep; the backup takes over after ${mine.autopilot.idleMinutes} min without a trade`
                            : "no backup: the day's floor is your agent's to keep",
                      ]
                    : []),
                  `the league page's rule: ${PAGE_IDLE_RULE}`,
                ]
              : []),
          ]
        : [];
      print(json, data, () =>
        [
          `${name}: ${runState}${s.stop ? ` (stop file: ${s.stop})` : ""}; ${s.agent!.track === "preset" ? `preset ${s.agent!.preset}` : s.agent!.track === "entry" ? "the league entry (FL enter)" : s.agent!.track === "prompt" ? "prompt mode" : "script"}`,
          `positions: ${data.positions.length ? data.positions.map((p) => `${p.symbol} ${p.costBnb} BNB${p.armed ? "" : " (exit not armed)"}`).join(", ") : "none"}`,
          `bought in 24 h: ${data.spent24hBnb} BNB; bought in all from this wallet: ${data.leagueSpentBnb} BNB (a figure, not a limit); realized ${data.realizedBnb} BNB; gas ${data.gasBnb} BNB`,
          ...waiting,
          // Addendum 11: alive since its start, and its last safety pass that worked.
          ...(s.agent!.track !== "entry" ? [manualNow ? manualLine : aliveLine(readAlive(home, name), s.running, Date.now(), startingAgent)] : []),
          // Task 975, addendum 8: the season's end, the warm-up dinner, the release, the sign-in.
          ...(gate?.state === "over" ? [SEASON_OVER_LINE] : []),
          ...(s.agent!.track === "prompt" && !mine?.day && noFloorTonight(gate?.at ? (gate as GateState) : null, Date.now()) ? ["warm-up tonight: no floor (the warm-up dinner eats nobody); the floor counts from tomorrow"] : []),
          ...(versionLine(release) ? [versionLine(release)!] : []),
          ...(s.agent!.track !== "entry" && signInLine(signInEnd, utc8) ? [signInLine(signInEnd, utc8)!] : []),
          ...(data.referral ? [`referral: ${data.referral} (sent with the registration)`] : []),
          ...(data.referrer ? [referrerLine(data.referrer, lang)] : []),
          // It runs on this machine: say so, and when it last slept (task 975, addendum 3).
          ...(s.agent!.track !== "entry" && !manualNow ? [awakeLine(lang)] : []),
          ...(sleptAt ? [`slept ${sleptAt.minutes} minutes at ${utc8(sleptAt.at)} UTC+8: nothing traded while it slept`] : []),
          ...(data.paused ? [`paused: ${data.paused}`] : []),
          ...(data.warmup ? [`warm-up: ${data.warmup.trades >= 5 ? "done" : `${data.warmup.trades} of 5 trades`}`] : []),
          ...selfLines,
          ...(unread.length > 0 ? ["new since the last status:", ...unreadShown(unread).map((n) => (typeof n === "string" ? n : noticeLine(n, lang)))] : ["latest:", ...s.notifications.slice(-8).map((n) => noticeLine(n, lang))]),
          ...(league ? ["", ...league.lines] : []),
          // No league block (or it could not be read), and the gate says the season is open: the instruction still ends it.
          ...(!league?.lines.length && s.agent!.track === "prompt" && gate?.state === "open" ? [manualNow ? "The season is on: trade by hand with FL buy and FL sell (manual mode)." : tradeNowLine(shownAutopilot, standingAgent.promptFile, lang, name)] : []),
        ].join("\n"),
      );
      return 0;
    }
    case "set": {
      const name = notEntry(agentArg(args[0]));
      const agent = loadAgent(home, name);
      if (!agent) throw new Error("no such agent");
      if (!values.yes && !values.review) throw new Error("a change needs --yes (the user's word) or --review (the hourly review, which may only tighten)");
      const changed = applyChange(agent, { params: kv(values.set), limits: kv(values.limit), tickSeconds: values.tick ? Number(values.tick) : undefined }, { byReview: values.review });
      if (!changed.ok) {
        print(json, { ok: false, errors: changed.errors }, () => `not changed:\n- ${changed.errors.join("\n- ")}`);
        return 2;
      }
      saveAgent(home, changed.agent);
      const paths = agentPaths(home, name);
      mkdirSync(paths.inbox, { recursive: true });
      writeJsonAtomic(join(paths.inbox, `${Date.now()}-reload.json`), { type: "reload" });
      appendJsonl(paths.log, { at: new Date().toISOString(), event: "agent.changed", by: values.review ? "review" : "user", params: kv(values.set), limits: kv(values.limit) });
      print(json, { ok: true, agent: changed.agent }, () => `changed "${name}"${values.review ? " (review)" : ""}`);
      return 0;
    }
    case "review": {
      const name = agentArg(args[0]);
      const s = statusOf(home, name);
      if (!s.agent) throw new Error("no such agent");
      const paths = agentPaths(home, name);
      const since = Date.now() - 3_600_000;
      const lines = existsSync(paths.log) ? readFileSync(paths.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; event: string }) : [];
      const hour = lines.filter((l) => Date.parse(l.at) >= since);
      console.log(
        JSON.stringify(
          {
            name,
            preset: s.agent.preset,
            params: s.agent.params,
            limits: s.agent.limits,
            envelope: s.agent.confirmed,
            lastHour: {
              trades: hour.filter((l) => l.event === "buy.filled" || l.event === "sell.filled"),
              refusals: hour.filter((l) => l.event === "intent.refused"),
              failures: hour.filter((l) => l.event === "intent.failed"),
            },
            book: s.book ? { positions: Object.keys(s.book.positions).length, realizedBnb: weiToBnb(s.book.realizedTotalWei), paused: s.book.paused } : null,
            rule: "the review may tighten anything and retune thresholds with `FL set <name> --review`; it may not raise a size, a stop-loss, a slippage or a limit past the envelope",
          },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
          2,
        ),
      );
      return 0;
    }
    case "audit": {
      const file = need(args[0], "a script file");
      const verdict = values["model-verdict"];
      const record = verdict
        ? recordModelVerdict(home, file, verdict === "pass" ? "pass" : "refuse", values.notes ?? "")
        : auditFile(home, file, { maxBuyBnb: LEAGUE_CAP_BNB });
      print(json, record, () =>
        [
          `${record.file}`,
          `sha256 ${record.sha256}`,
          `static rules: ${record.static.verdict.toUpperCase()}`,
          ...record.static.hits.map((h) => `  ${h.severity === "refuse" ? "✗" : "!"} ${h.rule} line ${h.line}:${h.column} — ${h.message}`),
          ...(record.static.verdict === "pass" ? [`model read: ${record.model ? `${record.model.verdict.toUpperCase()} (${record.model.at})` : "not yet: read it against the checklist, then record the verdict with --model-verdict"}`] : []),
          "",
          "The rules: " + AUDIT_RULES.map((r) => `${r.id} ${r.rule.split(":")[0]}`).join("; "),
        ].join("\n"),
      );
      return record.static.verdict === "pass" ? 0 : 2;
    }
    case "buy":
    case "sell": {
      const name = agentArg(args[0]);
      beat(name);
      const agent = loadAgent(home, name);
      if (!agent?.confirmed) throw new Error(`no confirmed agent "${name}"`);
      const coin = need(args[1], "a coin (an address or FEAST)");
      const amount = need(args[2], command === "buy" ? "an amount of BNB" : "a fraction (0–1) or all");
      const request =
        command === "buy"
          ? { kind: "buy" as const, coin, bnb: Number(amount), reason: "manual buy" }
          : { kind: "sell" as const, coin, fraction: amount === "all" ? 1 : Number(amount), reason: "manual sale" };
      return manualTrade(home, name, agent, request, json, values["no-wait"] === true);
    }
    case "answer": {
      // Addendum 11 (the Grok Bot routine): the host's own answer to the last `FL ask <name> --print`, checked as the
      // runtime checks an asked AI's (the pack's ids, the cap), then made through FL buy's and FL sell's road.
      const name = notEntry(agentArg(args[0]));
      beat(name);
      const agent = loadAgent(home, name);
      if (!agent?.confirmed || agent.track !== "prompt") throw new Error(`"${name}" is not a confirmed prompt agent`);
      const printed = readPrinted(home, name);
      if (!printed || Date.now() - printed.at > PRINTED_MAX_AGE_MS) {
        const line = `no fresh pack: run FL ask ${name} --print first (a pack answers for 10 minutes)`;
        print(json, { ok: false, error: line }, () => line);
        return 2;
      }
      const checked = validateAnswer(parseAnswerText(need(args[1], "the answer: one JSON object in the pack's schema")), { ids: new Map(printed.ids), maxBuyBnb: printed.maxBuyBnb });
      if (!checked.ok) {
        print(json, { ok: false, refused: checked.why, pack: printed.digest }, () => `not taken: ${checked.why} (pack ${printed.digest})`);
        return 2;
      }
      const d = checked.decision;
      appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "answer.taken", pack: printed.digest, action: d.action, coin: d.coin, amountBnb: d.amountBnb, fraction: d.fraction });
      if (d.action === "hold") {
        print(json, { ok: true, action: "hold", pack: printed.digest }, () => `hold: nothing traded (pack ${printed.digest})`);
        return 0;
      }
      const request = d.action === "buy" ? { kind: "buy" as const, coin: d.coin!, bnb: d.amountBnb!, reason: `answer: ${d.reason}` } : { kind: "sell" as const, coin: d.coin!, fraction: d.fraction!, reason: `answer: ${d.reason}` };
      return manualTrade(home, name, agent, request, json, values["no-wait"] === true);
    }
    case "data": {
      beat(args[0]);
      const signer = signerFor(home, null);
      const chain = new LeagueChain(MAINNET, rpc());
      // The quoter's impacts (addendum 5), read-only: an executor that prepares and never sends; the wallet only reads.
      const quoterWallet = await within(signer.address(), 5_000).catch(() => null);
      const quoter = new Executor({ signer: null as never, chain, wallet: quoterWallet ?? ZERO, network: MAINNET, rpcUrl: rpc(), stopReason: () => "a quote only", log: () => {} });
      const result = await dataFace(
        { home, site: siteFromEnv(), indexer: indexer(), fetch, chain, wallet: async () => quoterWallet, impacts: impacts(quoter, chain) },
        { name: args[0], since: values.since, coin: values.coin, live: values.live, notes: !values["no-notes"] },
      );
      print(json, result.data, () => result.text);
      return result.code;
    }
    case "note": {
      const signer = signerFor(home, null);
      // The session's door: the home's identity (league-entry's), and its Retry-After.
      const site = new LeagueSite(siteFromEnv(), fetch, 15_000, undefined, { home, name: ENTRY_AGENT });
      const login = () => notesLogin({ home, signer, site, chain: new LeagueChain(MAINNET, rpc()), signOptions: { onPending: () => process.stderr.write("Confirm the notes signature in the Binance App; waiting up to 10 minutes.\n") } }, langOf(values.lang));
      if (values.login) {
        const out = await login();
        print(json, out.data, () => out.text);
        return out.code;
      }
      const name = notEntry(checkAgentName(agentArg(args[0])));
      if (!loadAgent(home, name)) throw new Error(`no agent "${name}": plan it first`);
      if (args[1] === undefined) throw new Error('missing the note\'s text: FL note <name> "<text>"');
      beat(name);
      // A 401 opens the session again, once, here only: a background flush never signs.
      const relogin = async () => (await login()).code === 0;
      const out = await noteCommand({ home, name, site: siteFromEnv(), fetch, wallet: () => signer.address(), relogin }, { text: args[1], tx: values.tx, model: values.model });
      recordManual(home, name, `note ${(out.data as { state?: unknown }).state ?? (out.code === 0 ? "sent" : "not sent")}`);
      print(json, out.data, () => out.text);
      return out.code;
    }
    case "script": {
      if (args[0] !== "check") throw new Error("FL script check <file.mjs>");
      const file = resolve(need(args[1], "a script file"));
      if (!existsSync(file)) throw new Error(`no script at ${file}`);
      const source = readFileSync(file, "utf8");
      const report = await checkScript(source, { file });
      const path = writeCheckReport(home, report);
      print(json, { ...report, report: path }, () => checkLines(report, path, auditRefusal(home, file, source)));
      return report.verdict === "pass" ? 0 : 2;
    }
    case "enter":
      return enterCommand(home, values, json);
    case "meme":
      return enterCommand(home, { ...values, meme: need(args[0], 'the meme\'s one-line concept: FL meme "<concept>"') }, json, true);
    case "register":
      return registerCommand(home, checkAgentName(agentArg(args[0])), values, json);
    case "launch":
      return launchCommand(home, checkAgentName(agentArg(args[0])), values, json);
    case "preview":
      return previewCheck(home, need(args[0], "a check"), values.coin, values.bnb, json);
    case "agents": {
      const dir = join(home, "agents");
      const names = existsSync(dir) ? readdirSync(dir) : [];
      for (const name of names) {
        const s = statusOf(home, name);
        console.log(`${name}\t${s.agent?.track ?? "?"}\t${s.agent?.prompt?.path ?? s.agent?.preset ?? s.agent?.script?.path ?? ""}${s.agent?.track === "prompt" && s.agent.preset ? ` (autopilot ${s.agent.preset})` : ""}\t${s.running ? "running" : "stopped"}${s.stop ? " (stop file)" : ""}`);
      }
      return 0;
    }
    case "every": {
      // Task 975, addendum 4: how often the running agent asks its AI, without planning it again.
      const name = notEntry(agentArg(args[0]));
      const agent = loadAgent(home, name);
      if (!agent?.ask) throw new Error(`"${name}" has no ask loop: plan it with --prompt (and --every)`);
      const minutes = wholeOrNaN(need(args[1], "the minutes between asks"));
      if (minutes === undefined || !Number.isInteger(minutes) || minutes < ASK_EVERY_MIN || minutes > ASK_EVERY_MAX) {
        const line = `every is ${ASK_EVERY_MIN}–${ASK_EVERY_MAX} whole minutes`;
        print(json, { ok: false, error: line }, () => line);
        return 2;
      }
      saveAgent(home, { ...agent, ask: { ...agent.ask, every: minutes } });
      const paths = agentPaths(home, name);
      mkdirSync(paths.inbox, { recursive: true });
      writeJsonAtomic(join(paths.inbox, `${Date.now()}-reload.json`), { type: "reload" });
      appendJsonl(paths.log, { at: new Date().toISOString(), event: "agent.changed", by: "user", ask: { every: minutes } });
      print(json, { ok: true, every: minutes }, () => `"${name}" asks ${hostShown(agent.ask!.with)} every ${minutes} min from now on`);
      return 0;
    }
    case "model": {
      // Addendum 11: the model the agent's AI is asked with, changed without planning it again; "default" is the host's own.
      const name = notEntry(agentArg(args[0]));
      const agent = loadAgent(home, name);
      if (!agent?.ask || agent.ask.with === "none") throw new Error(`"${name}" asks no AI: plan it with --prompt (and --ask-with)`);
      const given = need(args[1], "a model's name, or default");
      const model = given === "default" ? null : given;
      const line =
        model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(model)
          ? "a model's name is letters, digits, dots, dashes, colons, slashes"
          : model === null && agent.ask.with === "openai"
            ? "an endpoint has no default model: name one"
            : null;
      if (line) {
        print(json, { ok: false, error: line }, () => line);
        return 2;
      }
      saveAgent(home, { ...agent, ask: { ...agent.ask, model } });
      const paths = agentPaths(home, name);
      mkdirSync(paths.inbox, { recursive: true });
      writeJsonAtomic(join(paths.inbox, `${Date.now()}-reload.json`), { type: "reload" });
      appendJsonl(paths.log, { at: new Date().toISOString(), event: "agent.changed", by: "user", ask: { model } });
      print(json, { ok: true, model }, () => `"${name}" asks ${hostShown(agent.ask!.with)} with ${model ?? "its default model"} from its next ask on`);
      return 0;
    }
    case "ask-key": {
      // Addendum 11: the endpoint's key, read on stdin (never argv, never shown), kept for the agent under FL daemon too.
      const name = notEntry(agentArg(args[0]));
      const agent = loadAgent(home, name);
      // Run 19: the Gemini CLI's API key too (Google's own login is closed to individuals; FL daemon passes no env of the shell).
      const keyFor = agent?.ask?.with === "openai" ? "endpoint" : agent?.ask?.with === "gemini" ? "gemini" : null;
      if (!keyFor) throw new Error(`"${name}" asks no endpoint (--ask-with openai) and no Gemini CLI (--ask-with gemini): it needs no key here`);
      if (process.stdin.isTTY) throw new Error(`pipe the key on stdin, e.g. \`pbpaste | FL ask-key ${name}\`: it is never typed on the command line`);
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const key = Buffer.concat(chunks).toString("utf8").trim();
      if (!key || key.length > 4_096 || /\s/.test(key)) {
        print(json, { ok: false, error: "no key on stdin (one token, no spaces)" }, () => "no key on stdin (one token, no spaces)");
        return 2;
      }
      const path = askKeyPath(home, name);
      mkdirSync(agentPaths(home, name).dir, { recursive: true });
      writeFileSync(path, `${key}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "ask.key.kept" });
      print(json, { ok: true, kept: true }, () =>
        keyFor === "gemini"
          ? `the Gemini API key for "${name}" is kept on this machine (mode 0600, read at each ask, handed to the Gemini CLI only, never shown); GEMINI_API_KEY, when set, comes first`
          : `the key for "${name}"'s endpoint is kept on this machine (mode 0600, read at each ask, never shown); a variable named by --ask-key-env, when set, comes first`,
      );
      return 0;
    }
    case "ask": {
      // Task 975, addendum 4: --print shows the exact pack (nothing is sent to any AI); without it, one ask now.
      const name = notEntry(agentArg(args[0]));
      const agent = loadAgent(home, name);
      if (!agent || agent.track !== "prompt") throw new Error(`"${name}" is not a prompt agent`);
      if (values.print) {
        const signer = signerFor(home, null);
        const wallet = await within(signer.address(), 5_000).catch(() => null);
        const chain = new LeagueChain(MAINNET, rpc());
        const quoter = new Executor({ signer: null as never, chain, wallet: wallet ?? ZERO, network: MAINNET, rpcUrl: rpc(), stopReason: () => "a quote only", log: () => {} });
        const cached = readSnapshotCache(home, wallet?.toLowerCase() ?? null);
        let snapshot = cached && Date.now() - cached.at < CACHE_FRESH_MS ? cached.snapshot : null;
        if (!snapshot) {
          const client = new SnapshotClient({ site: siteFromEnv(), fetch, now: Date.now, random: Math.random, timeoutMs: 15_000, cache: { home, wallet: wallet?.toLowerCase() ?? null }, seed: cached });
          const out = await client.read();
          snapshot = out.kind === "new" ? out.snapshot : out.kind === "same" ? client.held : (cached?.snapshot ?? null);
        }
        const g = readGate(home, name);
        const opensAt = g?.opensAt ? Date.parse(g.opensAt) : null;
        const gathered = await gatherPack({ home, agent, now: Date.now(), wallet, chain, snapshot, fetch, site: siteFromEnv(), gate: { opensAt, open: g ? g.state === "open" : !agent.league?.waitForSeason, noFloorTonight: noFloorTonight(g, Date.now()), signInEndsAt: signInEndOf(home, name) }, feast: MAINNET.platformCoin?.address ?? null, impacts: impacts(quoter, chain) });
        // Addendum 11: its ids kept 10 minutes, for `FL answer <name> '<json>'` (a host with no headless CLI answers by hand).
        writeJsonAtomic(join(agentPaths(home, name).dir, "printed-pack.json"), { at: Date.now(), digest: gathered.pack.digest, maxBuyBnb: gathered.pack.maxBuyBnb, ids: [...gathered.pack.ids.entries()] });
        print(json, { ok: true, digest: gathered.pack.digest, chars: gathered.pack.text.length, requests: gathered.requests, pack: gathered.pack.text }, () => gathered.pack.text);
        return 0;
      }
      if (!agent.ask || agent.ask.with === "none") throw new Error(`"${name}" asks no AI (--ask-with none): FL ask ${name} --print shows the pack to decide on`);
      if (!statusOf(home, name).running) throw new Error(`"${name}" is not running: FL start ${name} first (FL ask ${name} --print shows the pack)`);
      const before = readJournal(home, name, 1_000).length;
      const paths = agentPaths(home, name);
      mkdirSync(paths.inbox, { recursive: true });
      writeJsonAtomic(join(paths.inbox, `${Date.now()}-ask.json`), { type: "ask" });
      // The answer lands in the journal; the trade, if any, after it has run.
      for (let i = 0; i < 300; i += 1) {
        const rows = readJournal(home, name, 1_000);
        if (rows.length > before) {
          const row = rows.at(-1)!;
          print(json, { ok: true, journal: journalPath(home, name), row }, () => `asked ${hostShown(agent.ask!.with)}: ${row.action}${row.symbol ? ` ${clean(row.symbol, 24)}` : ""}${row.amountBnb !== null ? ` ${row.amountBnb} BNB` : ""}${row.fraction !== null ? ` ${row.fraction} of it` : ""} (${clean(row.reason, 140)}) → ${clean(row.result, 160)}`);
          return row.result.startsWith("error") || row.result.startsWith("invalid") ? 1 : 0;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      print(json, { ok: false, error: "no answer within 150 s" }, () => `no answer within 150 s; FL status ${name} shows the last ask`);
      return 1;
    }
    case "quote": {
      // Task 975, addendum 5: read-only. The executor prepares the trade and never sends it; the wallet is not asked.
      const coinArg = need(values.coin, "--coin <0x…|FEAST>");
      const coin = coinArg.trim().toUpperCase() === "FEAST" ? MAINNET.platformCoin!.address : isAddress(coinArg, { strict: false }) ? getAddress(coinArg) : null;
      if (!coin) throw new Error("--coin is a coin's address or FEAST");
      const signer = signerFor(home, null);
      const wallet = await within(signer.address(), 5_000).catch(() => null);
      const chain = new LeagueChain(MAINNET, rpc());
      const quoter = new Executor({ signer: null as never, chain, wallet: wallet ?? ZERO, network: MAINNET, rpcUrl: rpc(), stopReason: () => "a quote only", log: () => {} });
      // The gas (addendum 6): one eth_estimateGas of the prepared call, at today's gas price; never sent.
      const gas = async (call: { to: Address; data: `0x${string}`; value: bigint }) => {
        if (!wallet) return null;
        const units = await chain.client.estimateGas({ account: wallet, to: call.to, data: call.data, value: call.value });
        const price = await chain.client.getGasPrice();
        return weiToBnb(units * price);
      };
      let out: Awaited<ReturnType<typeof quoteBuy>>;
      if (values.sell) {
        if (!wallet) throw new Error("the wallet could not be read: a sale's quote is of what it holds");
        const held = await chain.tokenBalance(coin, wallet);
        const fraction = values.fraction !== undefined ? Number(values.fraction) : 1;
        if (!(fraction > 0 && fraction <= 1)) throw new Error("--fraction is above 0 and at most 1");
        let coins = (held * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
        if (values.bnb !== undefined) {
          const perCoin = await chain.markWei(coin, 10n ** 18n);
          coins = perCoin > 0n ? (bnbToWei(Number(values.bnb)) * 10n ** 18n) / perCoin : 0n;
        }
        out = await quoteSell(quoter, chain, coin, coins, 3, gas);
      } else {
        const bnb = Number(need(values.bnb, "--bnb <n>"));
        if (!(bnb > 0)) throw new Error("--bnb is a positive amount of BNB");
        out = await quoteBuy(quoter, coin, bnb, 3, gas);
      }
      if ("error" in out) {
        print(json, { ok: false, error: out.error }, () => `no quote: ${out.error}`);
        return 1;
      }
      const q = out;
      print(json, { ok: true, quote: q }, () =>
        [
          `${q.side === "buy" ? `buy ${q.amountIn} BNB of` : `sell ${Number(q.amountIn.toPrecision(6))} coins of`} ${short(coin)}: expected ${Number(q.expectedOut.toPrecision(6))} ${q.side === "buy" ? "coins" : "BNB"}, at least ${Number(q.minOut.toPrecision(6))} at ${q.slippagePct}% slippage`,
          `price impact ${q.impactPct === null ? "unknown" : `${q.impactPct}%`}; a round trip's fees ${q.roundTripFeePct}%; gas about ${q.gasBnbEstimate === null || q.gasBnbEstimate === undefined ? "unknown" : `${Number(q.gasBnbEstimate.toPrecision(3))} BNB`}; quoted by the ${q.quotedBy}. Nothing was signed or sent.`,
        ].join("\n"),
      );
      return 0;
    }
    case "login": {
      // Addendum 8: the sign-in the pack and the notifications point to. Reads only: the wallet's own sign-in is the
      // Binance Agentic Wallet skill's (baw auth signin), which this runtime may not run.
      const signer = signerFor(home, null);
      const status = await within(signer.status(), 10_000).catch(() => null);
      const settings = status?.connected ? await within(signer.settings(), 10_000).catch(() => null) : null;
      const end = settings ? sessionView(settings).end : null;
      const how = "To sign in again: use the Binance Agentic Wallet skill (`baw auth signin`), show the pairing code, and scan it in the Binance App. A running agent picks the new sign-in up by itself; nothing needs restarting.";
      const data = { connected: status?.connected ?? null, signInEndsAt: end === null ? null : new Date(end).toISOString(), how };
      print(json, data, () =>
        [
          status === null ? "the wallet could not be read just now" : !status.connected ? "the wallet is signed out: the agent cannot trade or exit until it is signed in again" : end !== null ? `the wallet is signed in, valid until ${utc8(end)} UTC+8 (${end > Date.now() ? `in ${duration(end - Date.now(), "en")}` : "ended"})` : "the wallet is signed in; its end could not be read",
          how,
        ].join("\n"),
      );
      return status?.connected ? 0 : 1;
    }
    case "daemon": {
      const name = notEntry(agentArg(args[0]));
      if (!loadAgent(home, name)) throw new Error(`no agent "${name}": plan it first`);
      const action = values.install ? "install" : values.uninstall ? "uninstall" : values.status ? "status" : null;
      if (!action || [values.install, values.uninstall, values.status].filter(Boolean).length > 1) throw new Error("FL daemon <name> takes one of --install, --uninstall, --status");
      // Addendum 11: Windows gets the Task Scheduler line to run once; nothing is installed for it.
      if (process.platform !== "darwin" && process.platform !== "linux") {
        const lines = windowsLines({ name, node: process.execPath, bin: BIN });
        print(json, { ok: false, platform: process.platform, lines }, () => lines.join("\n"));
        return action === "install" ? 0 : 1;
      }
      const result = await supervise(home, name, action);
      print(json, result, () => result.lines.join("\n"));
      // Run 19: installed but not started is not done: exit 2, with the command that starts it.
      return result.ok ? (result.running === false ? 2 : 0) : 1;
    }
    case "doctor":
      return doctor(home, json);
    case "report":
      return reportCommand(home, notEntry(checkAgentName(agentArg(args[0]))), json, langOf(values.lang));
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
}

/** Run 17: "引荐人:已绑定 / 未绑定" (zh, the coordinator's words), "referrer: bound / not bound" (en), and why. */
/** The last `FL ask --print`'s ids (addendum 11), and how long an answer to it is taken. */
const PRINTED_MAX_AGE_MS = 10 * 60_000;
function readPrinted(home: string, name: string): { at: number; digest: string; maxBuyBnb: number; ids: [string, { coin: Address; symbol: string | null; held: boolean }][] } | null {
  const got = readJson<{ at?: unknown; digest?: unknown; maxBuyBnb?: unknown; ids?: unknown }>(join(agentPaths(home, name).dir, "printed-pack.json"));
  if (!got || typeof got.at !== "number" || typeof got.digest !== "string" || typeof got.maxBuyBnb !== "number" || !Array.isArray(got.ids)) return null;
  return got as never;
}

/** FL buy's and FL sell's road (and FL answer's): the early refusals, then the running agent's inbox or a one-shot. */
async function manualTrade(home: string, name: string, agent: AgentConfig, request: IntentRequest, json: boolean, noWait: boolean): Promise<number> {
  // A trade by the user's own agent holds back the autopilot (task 963): the runtime writes it down when the guard
  // lets it through (task 975, ruling C6), so a refused one does not count.
  // The limits that need no wallet are checked before anything is asked of the wallet.
  const early = refuseEarly(home, agent, request);
  if (early) {
    appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "intent.refused", source: "manual", limit: early.limit, message: early.message, before: "any wallet call" });
    print(json, { ok: false, refused: early }, () => `refused by ${early.limit}: ${early.message} (nothing was asked of the wallet)`);
    return 2;
  }
  if (statusOf(home, name).running) {
    const sent = sendRequest(home, name, request);
    if (noWait) {
      print(json, { ok: true, queued: true, requestId: sent.requestId }, () => `queued for the running agent "${name}"; FL status ${name}`);
      return 0;
    }
    const outcome = await waitForOutcome(home, name, sent);
    const line = outcomeLine(outcome, name);
    recordManual(home, name, `${request.kind}: ${line.text}`);
    print(json, { ok: line.code === 0, requestId: sent.requestId, outcome }, () => line.text);
    return line.code;
  }
  // No loop (manual mode, or a stopped agent): the one-shot runs this request under the same guard, limits and gate,
  // and (run 21) says what became of it as the loop's answer does: filled with its transaction, or refused and why.
  const requestId = randomUUID();
  const logPath = agentPaths(home, name).log;
  const from = existsSync(logPath) ? statSync(logPath).size : 0;
  const run = await runAgent({ home, name, signer: signerFor(home, name), rpcUrl: rpc(), only: [request], onlyIds: [requestId] });
  const outcome = run.exit === "finished" ? await waitForOutcome(home, name, { requestId, from }, { timeoutMs: 1_000, pollMs: 100 }) : null;
  const line = outcome ? outcomeLine(outcome, name) : { code: run.exit === "finished" ? (0 as const) : (2 as const), text: `${name}: ${run.exit} — ${run.reason}` };
  recordManual(home, name, `${request.kind}: ${line.text}`);
  print(json, { ok: line.code === 0, requestId, outcome, exit: run.exit, reason: run.reason }, () => line.text);
  return line.code;
}

/** The machine's supervisor for FL daemon and FL enter's last step (addendum 11): launchctl or systemctl, as a child. */
const supervisorRunner: Runner = (command, list) =>
  new Promise((done) => {
    const child = spawn(command, list, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (error) => done({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

async function supervise(home: string, name: string, action: "install" | "uninstall" | "status") {
  return daemon({ action, platform: process.platform as "darwin" | "linux", name, home, userHome: homedir(), node: process.execPath, bin: BIN, path: daemonPath(process.env, process.execPath), uid: process.getuid?.() ?? 0, run: supervisorRunner, running: statusOf(home, name).running, isRunning: () => statusOf(home, name).running });
}

/** FL enter's last step (addendum 11): the daemon on macOS and Linux; on Windows, the Task Scheduler line and no daemon. */
async function enterDaemon(home: string, name: string): Promise<{ ok: boolean; running?: boolean | null; startCommand?: string | null; lines: string[] }> {
  if (process.env.FEAST_LEAGUE_DAEMON?.trim().toLowerCase() === "off") return { ok: false, lines: [] };
  if (process.platform !== "darwin" && process.platform !== "linux") return { ok: false, lines: windowsLines({ name, node: process.execPath, bin: BIN }) };
  const out = await supervise(home, name, "install");
  return { ok: out.ok, running: out.running ?? null, startCommand: out.startCommand ?? null, lines: out.ok ? [] : out.lines };
}

/** 280 characters, zh and en mixed, for the preview of the Register message. */
const PREVIEW_MANIFESTO = (() => {
  const text = [..."预览检查 preview-check 只咬刚出生的新币，小口快吃。 ".repeat(10).normalize("NFKC").replace(/\s+/gu, " ")].slice(0, 280).join("").trim();
  return normalizeManifesto(text).ok ? text : "preview-check";
})();

type Values = Record<string, string | boolean | string[] | undefined>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Every unread notice that matters is shown; of the trade lines, the last 20 and a count of the rest. Nothing is marked seen unshown. */
function unreadShown(unread: unknown[]): (unknown | string)[] {
  const routine = (n: unknown) => (n as { kind?: string }).kind === "trade" || (n as { kind?: string }).kind === "started";
  const kept = unread.filter((n) => !routine(n));
  const trades = unread.filter(routine);
  const dropped = Math.max(0, trades.length - 20);
  const shown = new Set([...kept, ...trades.slice(-20)]);
  return [...(dropped > 0 ? [`  (${dropped} older trade lines: FL status --json lists them)`] : []), ...unread.filter((n) => shown.has(n))];
}

/** One notification as the status card shows it; a session notice in the user's language. */
function noticeLine(n: unknown, lang: Lang): string {
  const entry = n as { at: string; kind: string; text: string; code?: SessionCode; endsAt?: string | null };
  const text = entry.kind === "session" && entry.code ? sessionNotice(entry.code, entry.endsAt ? Date.parse(entry.endsAt) : null, lang) : entry.text;
  return `  ${entry.at} ${entry.kind}: ${text}`;
}

/** The league block of `status` (PLAN-941 §6). Best effort: it never fails `status`. */
async function leagueStanding(home: string, lang: Lang, agent: StandingInput["agent"] = null): Promise<{ lines: string[]; data: Record<string, unknown>; latestRuntime: LeagueRead["latestRuntime"] | null; opens: Opening }> {
  const site = new LeagueSite(siteFromEnv(), fetch, 8_000);
  const me = await Promise.race([signerFor(home, null).address(), new Promise<null>((r) => setTimeout(() => r(null), 5_000))]).catch(() => null);
  const record = readLeagueRecord(home);
  // An entry by FL enter alone (no registration) is in the league too.
  const entered = Boolean(readEntry(home)?.bodyCoin);
  let agentId = record?.agentId ?? recordedAgentId(home);
  let seating = record?.seating ?? null;
  const kept = me ? await site.kept(me) : null;
  if (kept?.state === "read" && kept.agent) {
    agentId = kept.agent.agentId ?? agentId;
    seating = seatingOfKept(kept.agent);
  }
  // The cached field, never the uncached me= board unless the site is older (task 975, addendum 6).
  const ranked = await readStanding(site, me);
  const today = ranked.read;
  keepSupport(home, today);
  const season = today && (today.state === "season" || today.state === "over") ? await site.league("season", me) : null;
  const lines = standingLines({ agentId, seating, today, season, now: Date.now(), site: siteFromEnv(), entered, agent, standing: ranked.standing }, lang);
  // The page's own rows, without the wallet's address: printed output keeps the home's rule.
  const own = today?.me ? { earners: today.me.earners ? { ...today.me.earners, wallet: undefined } : null, backed: today.me.backed ? { ...today.me.backed, wallet: undefined } : null, eaten: today.me.eaten } : (today?.me ?? null);
  return { lines, data: { state: today?.state ?? "unreadable", season: today?.season ?? null, agentId, seating, me: own }, latestRuntime: today?.latestRuntime ?? null, opens: tradingOpens(today) };
}

/** `feast-league enter` and `feast-league meme` (tasks 961, 968): `src/league/enter/flow.ts` is the whole of it. */
async function enterCommand(home: string, values: Values, json: boolean, memeOnly = false): Promise<number> {
  const signer = signerFor(home, ENTRY_AGENT);
  const entryChain = new LeagueChain(MAINNET, rpc());
  const idle = str(values["idle-minutes"]);
  const concept = str(values.meme);
  const result = await enter(
    {
      home,
      signer,
      chain: entryChain,
      // FL enter's GETs back off (task 967): at most 3 asks and 2 minutes each; its POSTs are never asked twice.
      site: new LeagueSite(siteFromEnv(), fetch, 15_000, realRetry(), { home, name: ENTRY_AGENT }),
      retry: realRetry(),
      oneShot: entryOneShot({ home, signer, rpcUrl: rpc() }),
      signOptions: { onPending: () => process.stderr.write("Confirm the signature in the Binance App; waiting up to 10 minutes.\n") },
      // The trading agent, detached as FL start --detach starts it; it waits for the season itself.
      start: async (name, options) => detach(home, name, options.noJitter ? ["--no-jitter"] : []),
      daemon: (name) => enterDaemon(home, name),
      // Run 17: the referral binding's doors (feast.meme) and the registry's one read (the chain).
      referrals: referralDeps({ site: siteFromEnv(), fetch, client: entryChain.client as never }),
      waitForExit: (name) => waitForExit(home, name, 150),
      cwd: process.cwd(),
    },
    {
      name: memeOnly ? undefined : str(values.name),
      yes: values.yes === true,
      lang: langOf(values.lang),
      prompt: str(values.prompt),
      noStart: values["no-start"] === true,
      manual: values.manual === true,
      agent: str(values.agent),
      autopilot: str(values.autopilot),
      noAutopilot: values["no-autopilot"] === true,
      every: wholeOrNaN(str(values.every)),
      askWith: str(values["ask-with"]),
      askModel: str(values["ask-model"]),
      askBaseUrl: str(values["ask-base-url"]),
      askKeyEnv: str(values["ask-key-env"]),
      noDaemon: values["no-daemon"] === true,
      ref: str(values.ref),
      idleMinutes: idle !== undefined ? Number(idle) : undefined,
      noJitter: values["no-jitter"] === true,
      meme: concept !== undefined ? { concept, name: str(values["coin-name"]), symbol: str(values.symbol), description: str(values.description), image: str(values.image) } : undefined,
      memeOnly,
    },
  );
  // Run 22: the "You're in" lines (and "Already entered") end with where to get help, as a refusal does.
  if (["done", "entered", "registered"].includes(result.stage)) helpDue();
  print(json, { ok: result.ok, stage: result.stage, ...result.data, card: result.text }, () => result.text);
  return result.code;
}

/** `feast-league register` (PLAN-941 §1): the check, the card, and after the user's yes the signature and the answer. */
async function registerCommand(home: string, name: string, values: Values, json: boolean): Promise<number> {
  const lang = langOf(values.lang);
  const signer = signerFor(home, name);
  const paths = agentPaths(home, name);
  const deps: FlowDeps = {
    home,
    name,
    signer,
    chain: new LeagueChain(MAINNET, rpc()),
    site: new LeagueSite(siteFromEnv(), fetch, 15_000, undefined, { home, name }),
    log: (event, fields) => appendJsonl(paths.log, { at: new Date().toISOString(), event, ...fields }),
  };
  const say = (data: Record<string, unknown>, text: string, code: number) => (print(json, { ...data, card: text }, () => text), code);
  let found: Awaited<ReturnType<typeof check>>;
  try {
    found = await check(deps, { named: str(values["body-coin"]) ?? null });
  } catch (error) {
    const reason = error instanceof BawError ? error.message : (error as Error).message;
    return say({ ok: false, stage: "check", result: "wallet-unreadable", reason }, walletUnreadable(reason, lang), 2);
  }
  if (found.kind === "not-ready") return say({ ok: false, stage: "check", result: found.kind, reason: found.reason }, walletNotReady(found.reason, lang), 2);
  if (found.kind === "no-agent-id") return say({ ok: false, stage: "check", result: found.kind }, noAgentIdCard(lang), 2);
  if (found.kind === "agent-id-unreadable") return say({ ok: false, stage: "check", result: found.kind }, agentIdUnreadable(lang), 2);

  const summary = {
    agentId: found.agentId,
    bodyCoin: found.plan.kind === "coin" ? { coin: found.plan.coin, symbol: found.coin?.symbol ?? null, why: found.plan.why, others: found.plan.others } : null,
    plan: found.plan.kind,
    registration: found.keptUnreadable ? "unreadable" : found.keptSeating,
    league: found.league ? { state: found.league.state, season: found.league.season, seats: found.league.seats } : null,
    launch: { ...found.launch, quote: BODY_COIN_QUOTE },
  };
  const manifesto = str(values.manifesto);
  if (values.check || manifesto === undefined) return say({ ok: true, stage: "check", ...summary }, checkCard({ agentId: found.agentId, plan: found.plan, coin: found.coin, kept: found.kept, keptSeating: found.keptSeating, keptUnreadable: found.keptUnreadable, league: found.league, now: Date.now() }, lang), 0);

  const prepared = prepare(found, { manifesto, xHandle: str(values.x) ?? null, pending: values.pending === true }, Date.now());
  if (!prepared.ok) {
    const p = prepared.problem;
    const text = p.kind === "manifesto" ? manifestoProblem(p.reason, p.length, lang) : p.kind === "x-handle" ? xHandleProblem(p.given, lang) : bodyCoinProblem(p.plan, lang);
    return say({ ok: false, stage: "prepare", problem: p.kind, ...summary }, text, 2);
  }
  const card = registerCard(prepared.prepared.view, lang);
  const shown = { agentId: found.agentId, manifesto: prepared.prepared.fields.strategy, issuedAt: prepared.prepared.fields.issuedAt, bodyCoin: prepared.prepared.bodyCoin?.coin ?? null, xHandle: prepared.prepared.xHandle };
  if (!values.yes) return say({ ok: true, stage: "card", answer: { kind: "not-sent" }, ...shown }, `${card}\n\n${lang === "zh" ? "没有发送：需要用户说「好」（--yes）。" : "Not sent: this needs the user's yes (--yes)."}`, 2);

  const outcome = await submit(deps, prepared.prepared, { onPending: () => process.stderr.write(`${signingLine("pending", lang)}\n`) });
  if (outcome.kind === "not-signed") {
    const why = outcome.why;
    const text = why.kind === "declined" ? signingLine("declined", lang) : why.kind === "expired" ? signingLine("expired", lang) : why.kind === "not-ready" ? walletNotReady(why.reason, lang) : previewMismatch(why.reason, lang);
    return say({ ok: false, stage: "sign", answer: { kind: "not-sent", why: why.kind } }, text, 2);
  }
  if (outcome.kind === "local-check-failed") return say({ ok: false, stage: "sign", answer: { kind: "not-sent", why: "local-check" } }, signingLine("local-check", lang, outcome.reason), 2);
  if (outcome.kind === "too-old") return say({ ok: false, stage: "sign", answer: { kind: "not-sent", why: "too-old" } }, signingLine("expired", lang), 2);
  const answer = outcome.answer;
  if (answer.kind === "kept") {
    const season = answer.agent?.season ?? found.league?.season.number ?? 1;
    const lines = [seatedLine(answer.seating, found.agentId, season, lang), preregLine(answer.prereg, prepared.prepared.xHandle, found.agentId, lang), nextStepLine(found.league, Date.now(), lang)].filter((l): l is string => l !== null);
    if (outcome.reconciled) lines.unshift(noAnswerLine(true, lang));
    const seating = answer.seating;
    return say({ ok: true, stage: "answer", answer: { kind: seating.kind, ...(seating.kind === "seated" ? { seatNo: seating.seatNo, founding: seating.founding, foundingNo: seating.foundingNo, waitlisted: seating.waitlisted, place: seating.place } : { reason: seating.reason }), prereg: answer.prereg, reconciled: outcome.reconciled } }, lines.join("\n"), 0);
  }
  if (answer.kind === "refused") return say({ ok: false, stage: "answer", answer: { kind: "refused", status: answer.status, code: answer.code, field: answer.field } }, refusalLine(answer.code, answer.field, found.agentId, lang), 2);
  return say({ ok: false, stage: "answer", answer: { kind: "no-answer", reason: answer.reason, reconciled: outcome.reconciled } }, noAnswerLine(outcome.reconciled, lang), 2);
}

const QUOTES = ["WBNB", ...MAINNET.stocks.map((s) => s.symbol)];

/** `feast-league launch` (PLAN-941 §1.5): the body coin's card, and after the user's yes one launch through the agent's limits. */
async function launchCommand(home: string, name: string, values: Values, json: boolean): Promise<number> {
  const lang = langOf(values.lang);
  const say = (data: Record<string, unknown>, text: string, code: number) => (print(json, { ...data, card: text }, () => text), code);
  const agent = loadAgent(home, name);
  if (!agent?.confirmed) throw new Error(`no confirmed agent "${name}": the launch goes through its hard limits, so plan it and confirm it first`);
  if (agent.preset === "launch") return say({ ok: false, stage: "card" }, launchPresetOwnLine(lang), 2);
  const launched = statusOf(home, name).book?.launched;
  if (launched) return say({ ok: false, stage: "card", coin: launched.coin }, alreadyLaunchedLine(launched.coin, lang), 2);

  // The Agent ID names the coin and titles the card; best effort when a name and a ticker are given.
  let agentId: string | null = null;
  try {
    const id = await new LeagueChain(MAINNET, rpc()).agentIdOf(await signerFor(home, name).address());
    agentId = id.state === "read" ? id.id : null;
  } catch {
    agentId = null;
  }
  const derived = agentId ? bodyCoinNames(agentId) : null;
  const coinName = (str(values.name) ?? derived?.name ?? "").trim();
  const symbol = (str(values.symbol) ?? derived?.symbol ?? "").trim().toUpperCase();
  if (!coinName || !symbol) throw new Error("give the coin's --name and --symbol: this wallet's Agent ID could not be read to derive them");
  if (coinName.length > 32) throw new Error(`a coin's name is at most 32 characters (got ${coinName.length})`);
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("a ticker is 1–10 letters or digits");
  const quote = (str(values.quote) ?? BODY_COIN_QUOTE).trim().toUpperCase();
  if (!QUOTES.includes(quote)) throw new Error(`the pair is WBNB or a listed tokenized stock: ${QUOTES.join(", ")}`);
  const description = (str(values.description) ?? readLeagueRecord(home)?.manifesto ?? "").trim().slice(0, 280) || null;

  const card = launchCard({ agentId, name: coinName, symbol, quote, description }, lang);
  const shown = { name: coinName, symbol, quote, description, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer };
  if (!values.yes) return say({ ok: true, stage: "card", ...shown }, `${card}\n\n${lang === "zh" ? "没有发币：需要用户说「好」（--yes）。" : "Not launched: this needs the user's yes (--yes)."}`, 2);

  const request: IntentRequest = { kind: "launch", name: coinName, symbol, quote, description: description ?? undefined, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, reason: "the league's body coin" };
  const early = refuseEarly(home, agent, request);
  if (early) {
    appendJsonl(agentPaths(home, name).log, { at: new Date().toISOString(), event: "intent.refused", source: "manual", limit: early.limit, message: early.message, before: "any wallet call" });
    return say({ ok: false, stage: "limits", refused: early }, launchFailedLine(`${early.limit}: ${early.message}`, lang), 2);
  }
  if (statusOf(home, name).running) {
    const paths = agentPaths(home, name);
    mkdirSync(paths.inbox, { recursive: true });
    writeJsonAtomic(join(paths.inbox, `${Date.now()}-launch.json`), { type: "intent", request });
    return say({ ok: true, stage: "queued", ...shown }, queuedLaunchLine(name, lang), 0);
  }
  const outcome = await runAgent({ home, name, signer: signerFor(home, name), rpcUrl: rpc(), only: [request] });
  const after = statusOf(home, name);
  if (after.book?.launched) return say({ ok: true, stage: "launched", coin: after.book.launched.coin, txHash: after.book.launched.txHash ?? null, ...shown }, launchedLine(symbol, after.book.launched.coin, after.book.launched.txHash ?? null, lang), 0);
  const failure = [...after.notifications].reverse().find((n) => (n as { kind: string }).kind === "failure") as { text?: string } | undefined;
  return say({ ok: false, stage: "launch", exit: outcome.exit, reason: outcome.reason }, launchFailedLine(`${outcome.exit}: ${failure?.text ?? outcome.reason}`, lang), 2);
}

/** The preview-only checks of PLAN.md §8.2: the wallet's answer to each call shape. Nothing is executed. */
async function previewCheck(home: string, check: string, coinArg: string | undefined, bnbArg: string | undefined, json: boolean): Promise<number> {
  const name = "preview-checks";
  const paths = agentPaths(home, name);
  mkdirSync(paths.dir, { recursive: true });
  const signer = signerFor(home, name);
  const wallet = await signer.address();
  const chain = new LeagueChain(MAINNET, rpc());
  const log = (event: string, fields: Record<string, unknown>) =>
    appendJsonl(paths.log, JSON.parse(JSON.stringify({ at: new Date().toISOString(), event, check, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).split(wallet).join("self").split(wallet.toLowerCase()).join("self")));
  const executor = new Executor({ signer, chain, wallet, network: MAINNET, rpcUrl: rpc(), stopReason: () => stopReason(home, name), log });
  const trade = MAINNET.trade.kind === "infinity" ? MAINNET.trade : null!;
  const feast = MAINNET.platformCoin!.address;
  const coin = coinArg && isAddress(coinArg) ? getAddress(coinArg) : feast;
  const report = (result: unknown) => {
    const text = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2).split(wallet).join("self").split(wallet.toLowerCase()).join("self");
    console.log(json ? text : `${check}: ${text}`);
  };
  await executor.learn(coin);

  if (check === "register") {
    // The league's Register message as task 941 sends it (bare name, a 280-character zh/en manifesto, copies zero). Preview only: never signed here.
    const fields = { wallet, name: "previewcheck", strategy: PREVIEW_MANIFESTO, issuedAt: Math.floor(Date.now() / 1_000) };
    const answer = (await signer.signMessagePreview(signRequestMessage(fields))) as Record<string, unknown>;
    const data = (answer.data ?? {}) as Record<string, unknown>;
    const result = {
      accepted: answer.success === true && typeof data.requestId === "string",
      readsBack: previewDescribes(data.parsedMessage, fields).ok,
      manifestoLength: [...fields.strategy].length,
      error: answer.error ?? null,
      parsedMessage: data.parsedMessage ?? null,
      risks: data.risks ?? null,
      requireConfirmation: data.requireConfirmation ?? null,
      executed: false,
    };
    log("preview.register", result);
    report(result);
    return 0;
  }

  let call;
  if (check === "buy") {
    const prepared = await executor.prepareBuy(coin, bnbToWei(bnbArg ? Number(bnbArg) : 0.001), 3);
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    call = prepared.value.call;
  } else if (check === "approve") call = approveCall(coin, trade.permit2);
  else if (check === "permit2") call = permit2ApproveCall(trade.permit2, coin, trade.router, MAX_UINT160, (await chain.chainTime()) + 30n * 24n * 3600n);
  else if (check === "sell") {
    const held = await chain.tokenBalance(coin, wallet);
    const prepared = await executor.prepareSell(coin, held > 0n ? held / 10n : 1n, 3);
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    call = prepared.value.call;
  } else if (check === "claim") {
    // The wallet's own launch, found on the board by its creator; held in memory only.
    const response = await fetch(`${indexer()}/v1/board?limit=100`);
    const rows = ((await response.json()) as { data?: { coin: string; creator: string }[] }).data ?? [];
    const mine = rows.find((r) => r.creator.toLowerCase() === wallet.toLowerCase());
    if (!mine) return report({ ok: false, reason: "this wallet has launched no coin" }), 2;
    const prepared = await executor.prepareClaim(getAddress(mine.coin));
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    if (!prepared.value) return report({ ok: true, note: "the wallet's own coin owes it nothing to claim right now; a claim would be a no-op" }), 0;
    call = prepared.value.call;
  } else if (check === "create") {
    const prepared = await executor.prepareLaunch({ name: "Preview Check", symbol: "PRVW", quote: "WBNB", burn: 20, referrer: 10, metadataHash: `0x${"00".repeat(32)}` });
    if (!prepared.ok) return report({ ok: false, reason: prepared.reason }), 2;
    call = prepared.value.call;
  } else throw new Error(`unknown check "${check}"`);
  const result = await executor.previewOnly(check, call);
  report({ ...result, executed: false });
  return 0;
}

/** This CLI, run once more for one of its own reads (`FL report`): its JSON, else its text; never more than 60 s. */
function selfJson(home: string, args: string[]): Promise<unknown> {
  return new Promise((done) => {
    execFile(process.execPath, [BIN, ...args, "--json"], { env: { ...process.env, FEAST_LEAGUE_HOME: home }, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        done(JSON.parse(stdout));
      } catch {
        done({ unreadable: true, exit: error ? ((error as { code?: unknown }).code ?? 1) : 0, said: clean(`${stdout}\n${stderr}`, 2_000) });
      }
    });
  });
}

/**
 * `FL report <name>` (run 22): doctor, status, the last 200 log lines and the release, scrubbed (addresses and hashes
 * to 6+4, keys, tokens, the home folders), at most 64 KB; kept as a file (its path printed, to paste in a chat) and
 * sent to feast.meme with the notes session, once per 10 minutes per agent.
 */
async function reportCommand(home: string, name: string, json: boolean, lang: "en" | "zh"): Promise<number> {
  if (!loadAgent(home, name)) throw new Error(`no agent "${name}": plan it first`);
  const [doctorOut, statusOut] = await Promise.all([selfJson(home, ["doctor"]), selfJson(home, ["status", name])]);
  const declared = readDeclaredHost(home) ?? hostDetailHint() ?? modelHint();
  const raw: ReportBundle = { agentId: readEntry(home)?.agentId ?? readLeagueRecord(home)?.agentId ?? null, agent: name, runtime: RUNTIME_RELEASE, host: declared, doctor: doctorOut, status: statusOut, logTail: logTail(home, name), at: new Date().toISOString() };
  const token = liveToken(home);
  // The notes token and every endpoint the player may have keyed (the scrub also strips any URL's userinfo and query).
  const secrets = [token ?? "", ...["FEAST_MAINNET_RPC_URL", "FEAST_MAINNET_RPC_FALLBACK", "FEAST_LEAGUE_INDEXER"].map((k) => process.env[k]?.trim() ?? "")];
  const { json: body } = fit(scrub(raw, { homes: [{ path: home, as: "<league-home>" }, { path: homedir(), as: "~" }], secrets }));
  const path = saveReport(home, name, body);
  const shown = path.split(homedir()).join("~");
  const sent = await sendReport({ home, name, site: siteFromEnv(), fetch, json: body, token });
  const zh = lang === "zh";
  const said =
    sent.kind === "sent"
      ? zh ? `已发送给 feast.meme${sent.id ? `（编号 ${sent.id}）` : ""}。` : `sent to feast.meme${sent.id ? ` (report ${sent.id})` : ""}.`
      : sent.kind === "throttled"
        ? zh ? `这个 agent 10 分钟内已经发过一份报告：下一份可在 ${utc8(sent.next)} UTC+8 之后发送；这份没有发送。` : `not sent: a report for this agent went less than 10 minutes ago; the next can go after ${utc8(sent.next)} UTC+8.`
        : sent.kind === "no-session"
          ? zh ? "没有发送：还没有笔记会话（FL note --login 开通）。" : "not sent: no notes session (FL note --login opens one)."
          : sent.kind === "no-route"
            ? zh ? "没有发送：feast.meme 还不接收报告。把这个文件贴到支持对话里。" : "not sent: feast.meme does not take reports yet. Paste the file into the support chat."
            : sent.kind === "refused"
              ? zh ? `没有发送：feast.meme 拒绝了（HTTP ${sent.status}${sent.reason ? `：${clean(sent.reason, 120)}` : ""}）。` : `not sent: feast.meme refused it (HTTP ${sent.status}${sent.reason ? `: ${clean(sent.reason, 120)}` : ""}).`
              : zh ? `没有发送：feast.meme 没有回应（${sent.reason}）。` : `not sent: feast.meme did not answer (${sent.reason}).`;
  const ok = sent.kind === "sent";
  if (!ok) helpDue();
  print(json, { ok, report: shown, bytes: Buffer.byteLength(body), sent }, () => [zh ? `报告已保存：${shown}（${Buffer.byteLength(body)} 字节，已去掉钱包地址、密钥和路径）` : `report saved: ${shown} (${Buffer.byteLength(body)} bytes; wallet addresses, keys and paths scrubbed)`, said].join("\n"));
  return ok ? 0 : 2;
}

/** The wallet CLI the wallet skill needs (its `requiredCliVersion`), and how to get it. */
const BAW_REQUIRED_VERSION = "1.12.0";
const BAW_UPGRADE = "npm i -g @binance/agentic-wallet@latest";
function olderThan(have: string, need: string): boolean {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

async function doctor(home: string, json: boolean): Promise<number> {
  const checks: { what: string; ok: boolean; detail: string }[] = [];
  checks.push({ what: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  checks.push({ what: "home", ok: true, detail: home });
  // Run 19: the wallet CLI's own version against what the wallet skill needs (a CLI that answers --version is never
  // upgraded by the setup's own check); a missing CLI is the one line, not one per wallet check.
  const bawBin = process.env.FEAST_LEAGUE_BAW?.trim() || "baw";
  const found = bawBin.includes("/") ? existsSync(bawBin) : (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bawBin)));
  const version = found ? await execRunner(bawBin, 15_000)(["--version"]).catch(() => null) : null;
  const missing = !found;
  const got = version ? /(\d+)\.(\d+)\.(\d+)/.exec(version.stdout) : null;
  if (missing) checks.push({ what: "baw", ok: false, detail: `not installed here: ${BAW_UPGRADE}` });
  else if (!got) checks.push({ what: "baw", ok: false, detail: `its --version could not be read (${clean(version?.stdout || version?.stderr || "", 80) || "no answer"}): ${BAW_UPGRADE}` });
  else {
    const have = got.slice(1, 4).join(".");
    const old = olderThan(have, BAW_REQUIRED_VERSION);
    checks.push({ what: "baw", ok: !old, detail: old ? `${have} is older than the ${BAW_REQUIRED_VERSION} the wallet skill needs: ${BAW_UPGRADE}` : `${have} (the wallet skill needs ${BAW_REQUIRED_VERSION} or newer)` });
  }
  const signer = signerFor(home, null);
  if (!missing) {
    try {
      const status = await signer.status();
      const settings = await signer.settings().catch(() => null);
      const session = settings ? sessionView(settings) : null;
      const left = session?.end === null || session === null ? null : session.end - Date.now();
      // Run 19: signed out is one cause, so one line (it said UNCONNECTED and SESSION_EXPIRED, two NO lines).
      if (!status.connected) checks.push({ what: "wallet", ok: false, detail: `${status.status}${left !== null && left <= 0 ? ` (its sign-in ended at ${utc8(session!.end!)} UTC+8)` : ""}: sign in again with baw auth signin (scan the QR code)` });
      else checks.push({ what: "wallet", ok: true, detail: "connected" });
      if (settings) checks.push({ what: "developer mode", ok: settings.devModeEnabled && !settings.balanceExceeded, detail: settings.devModeEnabled ? (settings.balanceExceeded ? "on, but the balance is above its limit" : `on until ${settings.devModeExpiresAt ? new Date(settings.devModeExpiresAt * 1_000).toISOString() : "?"}`) : "off: turn it on in the Binance App" });
      if (status.connected) {
        checks.push({
          what: "session",
          ok: left === null || left > 0,
          detail: left === null ? "unknown" : left > 0 ? `ends in ${duration(left, "en")} (${session!.source}), at ${utc8(session!.end!)} UTC+8` : "ended: scan again (baw auth signin)",
        });
      }
    } catch (error) {
      checks.push({ what: "wallet", ok: false, detail: `the baw CLI did not answer: ${(error as Error).message}` });
    }
  }
  try {
    const r = await fetch(`${indexer()}/api/indexer/status`);
    const body = (await r.json()) as { verdict?: string; blocksBehind?: number };
    checks.push({ what: "indexer", ok: body.verdict === "serving", detail: `${body.verdict}, ${body.blocksBehind} blocks behind` });
  } catch (error) {
    checks.push({ what: "indexer", ok: false, detail: (error as Error).message });
  }
  try {
    const chain = new LeagueChain(MAINNET, rpc());
    const block = await chain.client.getBlockNumber();
    checks.push({ what: "BNB Smart Chain", ok: true, detail: `block ${block}` });
  } catch (error) {
    checks.push({ what: "BNB Smart Chain", ok: false, detail: (error as Error).message });
  }
  print(json, checks, () => checks.map((c) => `${c.ok ? "ok " : "NO "} ${c.what}: ${c.detail}`).join("\n"));
  if (!checks.every((c) => c.ok)) helpDue();
  return checks.every((c) => c.ok) ? 0 : 2;
}

main(process.argv.slice(2)).then(
  // Run 21: a manual command's heartbeat gets a moment to go out before the process ends.
  (code) => {
    if (help.due) sayHelp();
    return settleBeats().then(() => process.exit(code));
  },
  (error: unknown) => {
    console.error(`feast-league: ${error instanceof Error ? error.message : String(error)}`);
    sayHelp("err");
    void settleBeats().then(() => process.exit(1));
  },
);

export { PRESETS };
