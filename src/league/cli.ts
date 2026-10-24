#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { ASK_EVERY_MAX, ASK_EVERY_MIN, hostShown } from "./ask/host.ts";
import { gatherPack } from "./ask/gather.ts";
import { journalPath, readAskState, readJournal } from "./ask/journal.ts";
import { readSnapshotCache, SnapshotClient, CACHE_FRESH_MS } from "./feed/snapshot.ts";
import { bnbToWei, weiToBnb } from "./limits.ts";
import { noteCommand } from "./notes/queue.ts";
import { notesLogin, recordedAgentId } from "./notes/session.ts";
import { checkModel, declareHost, modelHint, readDeclaredHost } from "./headers.ts";
import { PAGE_IDLE_RULE } from "./prompt/constants.ts";
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
import { autopilotLine, awakeLine, clean, tradeNowLine } from "./enter/copy.ts";
import { enter, entryOneShot, readEntry } from "./enter/flow.ts";
import { normalizeManifesto, previewDescribes, signRequestMessage } from "./register/message.ts";
import { LeagueSite, seatingOfKept, siteFromEnv } from "./register/site.ts";
import { runAgent, statusOf } from "./runtime.ts";
import { checkLines, checkScript, scriptCheckPassed, writeCheckReport } from "./script/check.ts";
import { standingLines, type StandingInput } from "./season-card.ts";
import { readGate } from "./season-gate.ts";
import { sessionView } from "./session.ts";
import { askChoice, autopilotChoice, prepareStart } from "./start.ts";
import { agentPaths, appendJsonl, checkAgentName, leagueHome, readLedger, removeStop, stopReason, unreadNotifications, walletLockHolder, writeJsonAtomic, writeStop } from "./store.ts";
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
  start <name> --yes [--detach]   the user said yes: confirm and start (real BNB, no practice mode)
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
  plan|start|enter … [--every N] [--ask-with claude|codex|none] [--ask-model <name>]
                                  the ask loop: every N minutes (default 5, 2–120) without a buy or sell from your agent,
                                  the runtime asks your AI's headless CLI (claude -p, codex exec; default the host's own)
                                  what to do, and makes its one buy, sell or hold within the hard limits; the floor keeper
                                  (steady) trades when it fails twice in a row, and 20 minutes before dinner with the floor
                                  unmet. --ask-with none: no asks, the floor keeper after 30 min (v5)
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
        [--agent <name>] [--host <claude|codex|grok|other>] [--no-jitter]
                                  one command enters the league and runs your AI: one card and one yes sign the league's
                                  Register (no coin needed, no gas) and the notes session, then start the agent detached,
                                  waiting for the season: it trades nothing before. Without --prompt, the season-1 default
                                  is copied to ./strategy.md (never over one that is there). --no-start registers only.
                                  --meme launches one coin, composed by your agent, on its own card and its own yes
                                  (--name is the wallet's Agent ID here; FL start <name> restarts the agent). The agent's
                                  autopilot backup is on (default steady, after 30 min); --no-autopilot turns it off.
                                  --host names the AI that runs it, for feast.meme (kept here; default: the host's hint)
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
const print = (json: boolean, data: unknown, human: () => string) => console.log(json ? JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) : human());

function detach(home: string, name: string, extra: string[] = []): number {
  const paths = agentPaths(home, name);
  mkdirSync(paths.dir, { recursive: true });
  const outFd = openSync(join(paths.dir, "runtime.out"), "a", 0o600);
  const child = spawn(process.execPath, [BIN, "run", name, ...extra], { detached: true, stdio: ["ignore", outFd, outFd], env: { ...process.env, FEAST_LEAGUE_HOME: home } });
  child.unref();
  return child.pid ?? 0;
}

/** What `FL start` says of an agent that waits for the season (task 968). */
const waitingLine = (name: string) => `"${name}" waits for the season: it trades nothing before it opens; feast-league status ${name} shows when`;

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
      all: { type: "boolean", default: false },
      wait: { type: "string" },
      json: { type: "boolean", default: false },
      "model-verdict": { type: "string" },
      notes: { type: "string" },
      "max-runtime": { type: "string" },
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
  // Task 975 (the coordinator's ruling C8): the AI this home's agent runs on, declared once by FL enter --host; every
  // request to feast.meme names it (x-feast-host), and FL note's --model defaults to it.
  if (values.host !== undefined) {
    const host = checkModel(values.host);
    if (command !== "enter" || !host.ok) {
      const line = command !== "enter" ? "--host goes with enter" : host.ok ? "" : host.reason.replace("--model", "--host");
      print(json, { ok: false, error: line }, () => line);
      return 2;
    }
    declareHost(home, host.model);
  }
  const declared = readDeclaredHost(home);
  if (declared) process.env.FEAST_LEAGUE_HOST = declared;
  const need = (value: string | undefined, what: string) => {
    if (!value) throw new Error(`missing ${what}; see feast-league --help`);
    return value;
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
    if ((values.every !== undefined || values["ask-with"] !== undefined || values["ask-model"] !== undefined) && values.prompt === undefined) throw new Error("--every and --ask-with are a prompt agent's: give the prompt with --prompt <strategy.md>");
    const asked = askChoice({ noAutopilot: values["no-autopilot"], every: wholeOrNaN(values.every), askWith: values["ask-with"], askModel: values["ask-model"], host: modelHint() });
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
  const askFlags = askChoice({ noAutopilot: values["no-autopilot"], every: wholeOrNaN(values.every), askWith: values["ask-with"], askModel: values["ask-model"], host: modelHint() });
  const conflict = !both.ok ? both : !askFlags.ok ? askFlags : null;
  if (conflict && !conflict.ok && (command === "plan" || command === "start" || command === "enter")) {
    print(json, { ok: false, error: conflict.error }, () => conflict.error);
    return 2;
  }

  switch (command) {
    case "plan": {
      const name = notEntry(need(args[0], "an agent name"));
      const planned = planAgent(planInput(name));
      if (!planned.ok) {
        print(json, { ok: false, errors: planned.errors }, () => `not planned:\n- ${planned.errors.join("\n- ")}`);
        return 2;
      }
      const existing = loadAgent(home, name);
      if (existing && statusOf(home, name).running) throw new Error(`agent "${name}" is running; stop it, or change it with feast-league set`);
      saveAgent(home, planned.agent);
      if (planned.audit) auditFile(home, planned.agent.script!.path, { maxTradeBnb: planned.agent.limits.maxTradeBnb });
      print(json, { ok: true, agent: planned.agent, audit: planned.audit, card: renderCard(planned.agent, planned.audit) }, () => renderCard(planned.agent, planned.audit));
      return 0;
    }
    case "card": {
      const agent = loadAgent(home, need(args[0], "an agent name"));
      if (!agent) throw new Error("no such agent");
      console.log(renderCard(agent, null, { warmupPassed: agent.track === "script" && scriptCheckPassed(home, agent.script!.sha256) }));
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
      const name = notEntry(need(args[0], "an agent name"));
      if (values.prompt !== undefined && command !== "start") throw new Error("--prompt goes with plan or start");
      if (command === "resume") {
        if (!loadAgent(home, name)) throw new Error(`no agent "${name}": plan it first`);
        removeStop(agentPaths(home, name).stop);
        if (existsSync(join(home, "STOP"))) {
          if (!values.all) throw new Error("the global stop file is present too (feast-league stop --all wrote it); resume with --all to remove it");
          removeStop(join(home, "STOP"));
        }
      }
      // start --prompt: plan first when there is no agent yet, or its prompt, autopilot, parameters or limits changed.
      const checked = prepareStart(home, name, { plan: values.prompt !== undefined ? planInput(name) : null, yes: values.yes === true, confirm: command !== "run" });
      if (checked.kind === "not-planned") {
        print(json, { ok: false, errors: checked.errors }, () => `not planned:\n- ${checked.errors.join("\n- ")}`);
        return 2;
      }
      if (checked.kind === "running") throw new Error(`agent "${name}" is running; stop it first (feast-league stop ${name}), then start it with the new prompt`);
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
      if (values.detach && command !== "run") {
        const holder = walletLockHolder(home);
        if (holder) throw new Error(`the wallet is in use by agent "${holder.agent}"; stop it first`);
        const pid = detach(home, name, [...extra, ...(command === "resume" ? ["--clear-pause"] : []), ...(jitterMs > 0 ? ["--start-jitter", String(Math.ceil(jitterMs / 1_000))] : [])]);
        console.log(`started "${name}" in the background (pid ${pid}); feast-league status ${name}`);
        if (jitterLine) console.log(jitterLine);
        if (agent.league?.waitForSeason) console.log(waitingLine(name));
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
      return outcome.exit === "error" ? 1 : outcome.exit === "refused" ? 2 : 0;
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
      const name = need(args[0], "an agent name");
      const s = statusOf(home, name);
      if (!s.agent) throw new Error("no such agent");
      const view = s.book ? bookView(s.book, undefined, Date.now()) : null;
      const lang = langOf(values.lang);
      const unread = unreadNotifications(home, name, true);
      // Task 975, addendum 2: a prompt agent's own line closes the status: in season, the host is told to trade now.
      const shownAutopilot = s.agent.preset && s.agent.autopilot ? { preset: s.agent.preset, idleMinutes: s.agent.autopilot.idleMinutes, ...(s.agent.ask ? { ask: { every: s.agent.ask.every, with: s.agent.ask.with } } : {}) } : null;
      const standingAgent = { track: s.agent.track, autopilot: shownAutopilot, promptFile: basename(s.agent.prompt?.path ?? "strategy.md") };
      const league = values["no-league"] ? null : await leagueStanding(home, lang, standingAgent).catch(() => null);
      // The agent's figures in BNB (task 963), marked on the chain only when it holds something; a USDT figure is a reference.
      const holds = Object.keys(s.book?.positions ?? {}).length > 0;
      const chain = new LeagueChain(MAINNET, rpc());
      const statusWallet = await within(signerFor(home, null).address(), 5_000).catch(() => null);
      const mine = await selfView(home, name, { chain, now: Date.now(), wallet: statusWallet, marksTimeoutMs: holds ? 8_000 : 4_000 }).catch(() => null);
      const bnbUsd = mine && (holds || mine.pnl.realizedBnb !== 0) ? await within(chain.bnbUsd(), 8_000) : null;
      const usdRef = typeof bnbUsd === "number" && bnbUsd > 0 ? { bnbUsd: Number(bnbUsd.toFixed(4)), at: new Date().toISOString() } : null;
      const sleptAt = lastSleep(home, name);
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
        // Task 968: an agent FL enter started waits for the season's opening.
        season: s.agent.league?.waitForSeason ? (readGate(home, name) ?? { state: "waiting", opensAt: null, at: null }) : null,
      };
      const gate = data.season;
      const waiting = gate && gate.state === "waiting" ? [`waiting for the season (${gate.opensAt ? `opens ${utc8(Date.parse(gate.opensAt))} UTC+8` : "opens when feast.meme announces the start"}): it trades nothing before`] : [];
      const ago = (at: string | null) => (at ? `${duration(Date.now() - Date.parse(at), "en")} ago` : "never");
      const signed = (n: number) => `${n >= 0 ? "+" : ""}${Number(n.toPrecision(6))} BNB`;
      const selfLines = mine
        ? [
            `PnL: realized ${signed(mine.pnl.realizedBnb)}, unrealized ${holds ? signed(mine.pnl.unrealizedBnb) : "none"}${usdRef ? ` (≈ ${((mine.pnl.realizedBnb + mine.pnl.unrealizedBnb) * usdRef.bnbUsd).toFixed(2)} USDT)` : ""}; capital: ${mine.capital.spentBnb} of ${mine.capital.capBnb} BNB, wallet-wide`,
            ...(mine.prompt
              ? [
                  `prompt: ${mine.prompt.path} (sha256 ${mine.prompt.sha256.slice(0, 6)}…${mine.prompt.sha256.slice(-4)})${mine.prompt.changed ? `; CHANGED since the user's yes: feast-league start ${name} --prompt ${mine.prompt.path} shows the new card` : ""}`,
                  ...(s.agent!.ask && s.agent!.ask.with !== "none"
                    ? [
                        `asking ${hostShown(s.agent!.ask.with)} every ${s.agent!.ask.every} min · last ask ${askState.last ? `${utc8(askState.last.at)} UTC+8 → ${askState.last.action}${askState.last.reason ? ` (${clean(askState.last.reason, 80)})` : ""}: ${clean(askState.last.result, 80)}` : "none yet"} · failures in a row ${askState.streak}${askState.floorKeeperSince !== null ? ` · on floor keeper since ${utc8(askState.floorKeeperSince)} UTC+8` : ""}`,
                        mine.autopilot ? `floor keeper: ${mine.autopilot.preset}, when ${hostShown(s.agent!.ask.with)} fails twice in a row, and 20 min before dinner with the floor unmet` : "floor keeper: none",
                      ]
                    : [mine.autopilot ? `autopilot: ${mine.autopilot.preset}, after ${mine.autopilot.idleMinutes} min with no trade from your agent (${mine.autopilot.active ? "trading now" : "standing by"})` : "autopilot: none; nothing trades on its own but the hard stop-loss"]),
                  ...(cadenceLine(readCadence(home, name)) ? [cadenceLine(readCadence(home, name))!] : []),
                  ...activeWaits(home, name, Date.now()).concat(activeWaits(home, ENTRY_AGENT, Date.now())).map((w) => `feast.meme asked ${w.door === "notes" ? "the notes" : w.door === "session" ? "the notes session" : w.door} to wait until ${utc8(w.until)} UTC+8 (429): nothing is sent there before`),
                  ...(mine.wallet ? [`wallet: ${mine.wallet.balanceBnb} BNB, ${mine.wallet.spendableBnb} spendable (${mine.wallet.gasReserveBnb} kept for gas); left today ${mine.headroom.leftTodayBnb} BNB, this season ${mine.headroom.leftSeasonBnb} BNB`] : []),
                  `last trade ${ago(mine.lastTradeAt)}; last action by your agent ${ago(mine.lastActionAt)}`,
                  ...(mine.day ? [dayLine(mine.day, Date.now())] : []),
                  ...(mine.day && !mine.day.passed && !mine.autopilot?.active
                    ? [
                        // Addendum 7: in ask mode the unified line (the asks, then the floor keeper), not league-v5's first cut.
                        s.agent!.ask && s.agent!.ask.with !== "none" && mine.autopilot
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
          `${name}: ${s.running ? "running" : "not running"}${s.stop ? ` (stop file: ${s.stop})` : ""}; ${s.agent!.track === "preset" ? `preset ${s.agent!.preset}` : s.agent!.track === "entry" ? "the league entry (FL enter)" : s.agent!.track === "prompt" ? "prompt mode" : "script"}`,
          `positions: ${data.positions.length ? data.positions.map((p) => `${p.symbol} ${p.costBnb} BNB${p.armed ? "" : " (exit not armed)"}`).join(", ") : "none"}`,
          `spent in 24 h: ${data.spent24hBnb} BNB; the league in all: ${data.leagueSpentBnb} BNB of ${s.agent!.limits.budgetBnb}; realized ${data.realizedBnb} BNB; gas ${data.gasBnb} BNB`,
          ...waiting,
          // It runs on this machine: say so, and when it last slept (task 975, addendum 3).
          ...(s.agent!.track !== "entry" ? [awakeLine(lang)] : []),
          ...(sleptAt ? [`slept ${sleptAt.minutes} minutes at ${utc8(sleptAt.at)} UTC+8: nothing traded while it slept`] : []),
          ...(data.paused ? [`paused: ${data.paused}`] : []),
          ...(data.warmup ? [`warm-up: ${data.warmup.trades >= 5 ? "done" : `${data.warmup.trades} of 5 trades`}`] : []),
          ...selfLines,
          ...(unread.length > 0 ? ["new since the last status:", ...unreadShown(unread).map((n) => (typeof n === "string" ? n : noticeLine(n, lang)))] : ["latest:", ...s.notifications.slice(-8).map((n) => noticeLine(n, lang))]),
          ...(league ? ["", ...league.lines] : []),
          // No league block (or it could not be read), and the gate says the season is open: the instruction still ends it.
          ...(!league?.lines.length && s.agent!.track === "prompt" && gate?.state === "open" ? [tradeNowLine(shownAutopilot, standingAgent.promptFile, lang)] : []),
        ].join("\n"),
      );
      return 0;
    }
    case "set": {
      const name = notEntry(need(args[0], "an agent name"));
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
      const name = need(args[0], "an agent name");
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
            rule: "the review may tighten anything and retune thresholds with `feast-league set <name> --review`; it may not raise a size, a stop-loss, a slippage or a limit past the envelope",
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
        : auditFile(home, file, { maxTradeBnb: 0.02 });
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
      const name = need(args[0], "an agent name");
      const agent = loadAgent(home, name);
      if (!agent?.confirmed) throw new Error(`no confirmed agent "${name}"`);
      const coin = need(args[1], "a coin (an address or FEAST)");
      const amount = need(args[2], command === "buy" ? "an amount of BNB" : "a fraction (0–1) or all");
      const request =
        command === "buy"
          ? { kind: "buy" as const, coin, bnb: Number(amount), reason: "manual buy" }
          : { kind: "sell" as const, coin, fraction: amount === "all" ? 1 : Number(amount), reason: "manual sale" };
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
        if (values["no-wait"]) {
          print(json, { ok: true, queued: true, requestId: sent.requestId }, () => `queued for the running agent "${name}"; feast-league status ${name}`);
          return 0;
        }
        const outcome = await waitForOutcome(home, name, sent);
        const line = outcomeLine(outcome, name);
        print(json, { ok: line.code === 0, requestId: sent.requestId, outcome }, () => line.text);
        return line.code;
      }
      const outcome = await runAgent({ home, name, signer: signerFor(home, name), rpcUrl: rpc(), only: [request] });
      console.log(`${name}: ${outcome.exit} — ${outcome.reason}`);
      return outcome.exit === "finished" ? 0 : 2;
    }
    case "data": {
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
      const name = notEntry(checkAgentName(need(args[0], "an agent name")));
      if (!loadAgent(home, name)) throw new Error(`no agent "${name}": plan it first`);
      if (args[1] === undefined) throw new Error('missing the note\'s text: feast-league note <name> "<text>"');
      // A 401 opens the session again, once, here only: a background flush never signs.
      const relogin = async () => (await login()).code === 0;
      const out = await noteCommand({ home, name, site: siteFromEnv(), fetch, wallet: () => signer.address(), relogin }, { text: args[1], tx: values.tx, model: values.model });
      print(json, out.data, () => out.text);
      return out.code;
    }
    case "script": {
      if (args[0] !== "check") throw new Error("feast-league script check <file.mjs>");
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
      return enterCommand(home, { ...values, meme: need(args[0], 'the meme\'s one-line concept: feast-league meme "<concept>"') }, json, true);
    case "register":
      return registerCommand(home, checkAgentName(need(args[0], "an agent name")), values, json);
    case "launch":
      return launchCommand(home, checkAgentName(need(args[0], "an agent name")), values, json);
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
      const name = notEntry(need(args[0], "an agent name"));
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
    case "ask": {
      // Task 975, addendum 4: --print shows the exact pack (nothing is sent to any AI); without it, one ask now.
      const name = notEntry(need(args[0], "an agent name"));
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
        const gathered = await gatherPack({ home, agent, now: Date.now(), wallet, chain, snapshot, fetch, site: siteFromEnv(), gate: { opensAt, open: g ? g.state === "open" : !agent.league?.waitForSeason }, feast: MAINNET.platformCoin?.address ?? null, impacts: impacts(quoter, chain) });
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
    case "doctor":
      return doctor(home, json);
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
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
  return [...(dropped > 0 ? [`  (${dropped} older trade lines: feast-league status --json lists them)`] : []), ...unread.filter((n) => shown.has(n))];
}

/** One notification as the status card shows it; a session notice in the user's language. */
function noticeLine(n: unknown, lang: Lang): string {
  const entry = n as { at: string; kind: string; text: string; code?: SessionCode; endsAt?: string | null };
  const text = entry.kind === "session" && entry.code ? sessionNotice(entry.code, entry.endsAt ? Date.parse(entry.endsAt) : null, lang) : entry.text;
  return `  ${entry.at} ${entry.kind}: ${text}`;
}

/** The league block of `status` (PLAN-941 §6). Best effort: it never fails `status`. */
async function leagueStanding(home: string, lang: Lang, agent: StandingInput["agent"] = null): Promise<{ lines: string[]; data: Record<string, unknown> }> {
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
  const season = today && (today.state === "season" || today.state === "over") ? await site.league("season", me) : null;
  const lines = standingLines({ agentId, seating, today, season, now: Date.now(), site: siteFromEnv(), entered, agent, standing: ranked.standing }, lang);
  // The page's own rows, without the wallet's address: printed output keeps the home's rule.
  const own = today?.me ? { earners: today.me.earners ? { ...today.me.earners, wallet: undefined } : null, backed: today.me.backed ? { ...today.me.backed, wallet: undefined } : null, eaten: today.me.eaten } : (today?.me ?? null);
  return { lines, data: { state: today?.state ?? "unreadable", season: today?.season ?? null, agentId, seating, me: own } };
}

/** `feast-league enter` and `feast-league meme` (tasks 961, 968): `src/league/enter/flow.ts` is the whole of it. */
async function enterCommand(home: string, values: Values, json: boolean, memeOnly = false): Promise<number> {
  const signer = signerFor(home, ENTRY_AGENT);
  const idle = str(values["idle-minutes"]);
  const concept = str(values.meme);
  const result = await enter(
    {
      home,
      signer,
      chain: new LeagueChain(MAINNET, rpc()),
      // FL enter's GETs back off (task 967): at most 3 asks and 2 minutes each; its POSTs are never asked twice.
      site: new LeagueSite(siteFromEnv(), fetch, 15_000, realRetry(), { home, name: ENTRY_AGENT }),
      retry: realRetry(),
      oneShot: entryOneShot({ home, signer, rpcUrl: rpc() }),
      signOptions: { onPending: () => process.stderr.write("Confirm the signature in the Binance App; waiting up to 10 minutes.\n") },
      // The trading agent, detached as FL start --detach starts it; it waits for the season itself.
      start: async (name, options) => detach(home, name, options.noJitter ? ["--no-jitter"] : []),
      waitForExit: (name) => waitForExit(home, name, 150),
      cwd: process.cwd(),
    },
    {
      name: memeOnly ? undefined : str(values.name),
      yes: values.yes === true,
      lang: langOf(values.lang),
      prompt: str(values.prompt),
      noStart: values["no-start"] === true,
      agent: str(values.agent),
      autopilot: str(values.autopilot),
      noAutopilot: values["no-autopilot"] === true,
      every: wholeOrNaN(str(values.every)),
      askWith: str(values["ask-with"]),
      askModel: str(values["ask-model"]),
      idleMinutes: idle !== undefined ? Number(idle) : undefined,
      noJitter: values["no-jitter"] === true,
      meme: concept !== undefined ? { concept, name: str(values["coin-name"]), symbol: str(values.symbol), description: str(values.description), image: str(values.image) } : undefined,
      memeOnly,
    },
  );
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

async function doctor(home: string, json: boolean): Promise<number> {
  const checks: { what: string; ok: boolean; detail: string }[] = [];
  checks.push({ what: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  checks.push({ what: "home", ok: true, detail: home });
  const signer = signerFor(home, null);
  try {
    const status = await signer.status();
    checks.push({ what: "wallet", ok: status.connected, detail: status.connected ? "connected" : `${status.status}: sign in with baw auth signin` });
    const settings = await signer.settings();
    checks.push({ what: "developer mode", ok: settings.devModeEnabled && !settings.balanceExceeded, detail: settings.devModeEnabled ? (settings.balanceExceeded ? "on, but the balance is above its limit" : `on until ${settings.devModeExpiresAt ? new Date(settings.devModeExpiresAt * 1_000).toISOString() : "?"}`) : "off: turn it on in the Binance App" });
    const session = sessionView(settings);
    const left = session.end === null ? null : session.end - Date.now();
    checks.push({
      what: "session",
      ok: left === null || left > 0,
      detail: left === null ? "unknown" : left > 0 ? `ends in ${duration(left, "en")} (${session.source}), at ${utc8(session.end!)} UTC+8` : "ended: scan again (baw auth signin)",
    });
  } catch (error) {
    checks.push({ what: "wallet", ok: false, detail: `the baw CLI did not answer: ${(error as Error).message}` });
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
  return checks.every((c) => c.ok) ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`feast-league: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);

export { PRESETS };
