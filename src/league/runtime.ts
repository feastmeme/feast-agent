import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { MAINNET, type FeastNetwork } from "../sdk/networks.ts";
import { loadAgent, type AgentConfig } from "./agent.ts";
import { sha256Of } from "./audit/static.ts";
import { auditRefusal } from "./audit/verdict.ts";
import { BawError, type Signer } from "./baw.ts";
import { bookView, clearPause, emptyBook, pendingBuysWei, markArmed, parseBook, positionOf, recordBuy, recordClaim, recordFailure, recordGas, recordRefusal, recordSell, serializeBook, withEquity, type Book } from "./book.ts";
import { DEFAULT_MAINNET_RPC, LeagueChain } from "./chain.ts";
import { ENTRY_AGENT } from "./enter/constants.ts";
import { autopilotLine } from "./enter/copy.ts";
import { Executor } from "./executor.ts";
import { backstopExits } from "./exits.ts";
import { Backoff } from "./feed/backoff.ts";
import { MarketFeed } from "./feed/feed.ts";
import { drawStartJitter } from "./feed/snapshot.ts";
import { guard, warmupActive, warmupAfter, type GuardInput, type GuardVerdict, type Intent, type WalletState } from "./guard.ts";
import { WARMUP_SIZE_BNB, WARMUP_TRADES, bnbToWei, resolveLimits, weiToBnb, type Limits } from "./limits.ts";
import { Market } from "./market.ts";
import { flushNotes, readNotes } from "./notes/queue.ts";
import { presetStrategy } from "./presets/logic.ts";
import { PRESETS } from "./presets/specs.ts";
import { SAFETY_PASS_SECONDS } from "./prompt/constants.ts";
import { dayCount, leftOut } from "./prompt/floor.ts";
import { autopilotGate, lastHostAction, promptChanged, recordHostAction } from "./prompt/host.ts";
import { callHost, hostShown, type HostCall } from "./ask/host.ts";
import { appendJournal, readAskState, writeAskState, type AskState } from "./ask/journal.ts";
import { gatherPack } from "./ask/gather.ts";
import { validateAnswer, type JournalRow, type Pack } from "./ask/pack.ts";
import { impacts } from "./quote.ts";
import { nextDinner } from "./prompt/floor.ts";
import { nextSlowRead, pollCadence, writeCadence, type Cadence } from "./feed/cadence.ts";
import { sessionNotice, utc8 } from "./register/copy.ts";
import { LeagueSite, siteFromEnv, type LeagueRead } from "./register/site.ts";
import { GATE_READ_MS, SEASON_OVER_LINE, seasonClosedLine, seasonOver, tradingOpens, warmUpDinner, writeGate } from "./season-gate.ts";
import { leagueDayKey, readVersion, versionNotice, versionPath, versionView, writeVersion } from "./version.ts";
import { healthFlag, withHealth, type Health } from "./headers.ts";
import { scriptCheckPassed } from "./script/check.ts";
import { ScriptSandbox } from "./script/sandbox.ts";
import { freshMemory, pastEnd, sessionStep, sessionView, type SessionMemory, type SessionView } from "./session.ts";
import { addToLedger, acquireWalletLock, agentPaths, bootId, otherBoot, pidAlive, appendJsonl, readJson, readLedger, stopReason, writeFileAtomic, writeJsonAtomic, writeStop } from "./store.ts";
import { makeApi, normalizeIntent, type IntentRequest, type Meta, type PresetExtras, type Snapshot, type StrategyEvent } from "./strategy.ts";

/**
 * The runtime (PLAN.md §2): one process per wallet, no model anywhere in it.
 *
 * Every second it checks the stop files and its inbox; every 5–8 s (`--poll`)
 * it reads feast.meme's cached market snapshot when the strategy listens for
 * events or reads the board (`feed/`, PLAN.md §15: the indexer's legacy routes
 * while that route is not deployed, or with `--live`), under one backoff; on
 * its tick it marks the book on the chain, makes the runtime's own exits (the
 * backstop L6, the drawdown halt L8) and asks the strategy, which reads the
 * newest snapshot it holds, marked stale while the feed backs off. Every intent
 * then takes one road: the guard, the executor (allowlist, lock, preview, gate,
 * execute, receipt), the book. One at a time, exits first.
 *
 * `FL start` spreads the 20:00 start: the runtime's first read of the site, its
 * first strategy tick and its first autopilot decision wait `startJitterMs`;
 * the stop files, the inbox, the preflight, L6 and L8 run from the start.
 *
 * An agent `FL enter` started (task 968, `agent.league.waitForSeason`) waits for the season behind a gate: until
 * feast.meme's season opens (one hour before dinner 1) it reads no market, asks no strategy or autopilot, and answers
 * every `FL buy`, `FL sell` and launch request as refused; the stop files, the preflight, L6 and L8 run. At the
 * opening instant it draws the start jitter, logs `season.open` once, and runs as `FL start` would.
 *
 * A prompt agent (task 963) has no strategy of its own: the user's agent decides
 * and acts through `FL buy` and `FL sell`, which reach this loop as inbox
 * requests. The loop's tick is then only its safety pass. With an autopilot, the
 * preset is asked only after the host has made no trade for its idle threshold
 * (task 975: a note no longer counts); one that keeps its exits (`steady`) is
 * still asked while the host trades, for the sales of its own positions only.
 */

export type RunOutcome = { exit: "stopped" | "halted" | "refused" | "finished" | "error"; reason: string };

export type RuntimeDeps = {
  home: string;
  name: string;
  signer: Signer;
  network?: FeastNetwork;
  rpcUrl?: string;
  indexer?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One line per notification, for a terminal or a log file. */
  out?: (line: string) => void;
  /** Exit after this long (demonstrations and tests); a running agent normally runs until stopped. */
  maxRuntimeMs?: number;
  /** One-shot: run only these manual requests (and what follows from them, such as arming an exit), then exit. No strategy runs. */
  only?: IntentRequest[];
  /** The chain reads (tests pass a fake). */
  chain?: LeagueChain;
  /** How often a sent transaction whose receipt never came is asked for again. */
  unresolvedCheckMs?: number;
  /** The user's resume: clear an L14 pause at start. */
  clearPause?: boolean;
  /** feast.meme, for the notes flush (default `FEAST_LEAGUE_SITE` or https://feast.meme). */
  site?: string;
  loopMs?: number;
  /** The market snapshot's interval before its 0–3 s jitter (`--poll`; default 5 s, at least 3 s from the CLI). */
  pollMs?: number;
  preflightMs?: number;
  /** `--live`: the indexer's legacy reads instead of feast.meme's snapshot (task 967). */
  live?: boolean;
  /** FL start's wait before the first read of the site, the first strategy tick and the first autopilot decision. None by default. */
  startJitterMs?: number;
  /** The jitter's random (tests pass a seeded one). */
  random?: () => number;
  /**
   * Task 968: the season gate's read of `/api/league` (default: feast.meme's, one ask); null when it cannot be read.
   * Addendum 8: every 5 minutes for the whole run of a prompt agent, with the health flag it carries.
   */
  seasonRead?: (o: { health: Health }) => Promise<LeagueRead | null>;
  /** `--no-jitter`: the gate opens without the start jitter. */
  noJitter?: boolean;
  /** Task 975, addendum 4: the host's headless CLI (default `callHost`; tests pass a fake). */
  askHost?: (o: Parameters<typeof callHost>[0]) => Promise<HostCall>;
};

type Loaded = {
  meta: Meta;
  params: Record<string, unknown>;
  /** Coins to mark fresh from the chain in the next snapshot, besides meta.watch. */
  wants(state: Record<string, unknown>): string[];
  call(fn: "onTick" | "onEvent", snapshot: Snapshot, state: Record<string, unknown>, event?: StrategyEvent): Promise<{ intents: Intent[]; problems: string[]; logs: string[]; state: Record<string, unknown> }>;
  stop(): void;
};

/** A rest of the loop that ends this much late is the machine asleep (task 975, addendum 3). */
const SLEPT_MS = 10 * 60_000;

const PRIORITY: Record<Intent["kind"], number> = { sell: 0, arm: 1, claim: 2, launch: 3, buy: 4 };

/** Why the floor keeper (an autopilot) is on. */
type KeeperWhy = "asks failing" | "host silent" | "floor guard";

export async function runAgent(deps: RuntimeDeps): Promise<RunOutcome> {
  const clock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const network = deps.network ?? MAINNET;
  const rpcUrl = deps.rpcUrl ?? process.env.FEAST_MAINNET_RPC_URL?.trim() ?? DEFAULT_MAINNET_RPC;
  const paths = agentPaths(deps.home, deps.name);
  const out = deps.out ?? ((line: string) => process.stderr.write(`${line}\n`));
  const feast = network.platformCoin?.address;
  if (!feast) return { exit: "refused", reason: "this network has no platform coin" };

  // --- before anything touches the wallet ---------------------------------------------------
  let agent = loadAgent(deps.home, deps.name);
  if (!agent) return { exit: "refused", reason: `no agent "${deps.name}": plan it first` };
  if (!agent.confirmed) return { exit: "refused", reason: `agent "${deps.name}" was never confirmed: nothing runs before the user's yes` };
  // The league entry's own agent (task 961) runs one request at a time, as a one-shot, never a loop.
  if (agent.track === "entry" && !deps.only) return { exit: "refused", reason: `"${deps.name}" is FL enter's: it runs one request at a time, never a trading loop` };
  const checked = resolveLimits(agent.limits);
  if (!checked.ok) return { exit: "refused", reason: `the agent's limits do not validate: ${checked.errors.join("; ")}` };
  const atStart = stopReason(deps.home, deps.name);
  if (atStart) return { exit: "refused", reason: `a stop file is present (${atStart}); \`feast-league resume\` removes it` };
  // A script is read ONCE: the bytes checked here are the bytes the sandbox runs.
  let scriptSource: string | null = null;
  if (agent.track === "script") {
    scriptSource = readFileSync(agent.script!.path, "utf8");
    if (sha256Of(scriptSource) !== agent.script!.sha256) return { exit: "refused", reason: "the script changed since it was planned: plan and audit it again" };
    const why = auditRefusal(deps.home, agent.script!.path, scriptSource);
    if (why) return { exit: "refused", reason: why };
  }
  // A prompt is the user's text for their own agent: the runtime only checks it is the one they said yes to.
  if (agent.track === "prompt" && promptChanged(agent)) {
    return { exit: "refused", reason: `the prompt changed since you confirmed it (or is gone): \`feast-league start ${deps.name} --prompt ${agent.prompt?.path ?? "<file>"}\` shows the new card` };
  }

  let lock: { release: () => void };
  try {
    lock = acquireWalletLock(deps.home, deps.name);
  } catch (error) {
    return { exit: "refused", reason: (error as Error).message };
  }
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.pid, String(process.pid));
  writeJsonAtomic(`${paths.pid}.boot`, { boot: bootId() });
  let loaded: Loaded | null = null;
  /** Answers every request still queued when the loop ends, so no `FL buy` waits on one that will never run. */
  let dropQueued: ((reason: string) => void) | null = null;

  try {
    const wallet = await deps.signer.address();
    const self = wallet.toLowerCase();
    // Defense in depth: no line this runtime writes may carry the wallet's address.
    const scrub = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).split(wallet).join("self").split(self).join("self"));
    const log = (event: string, fields: Record<string, unknown> = {}) => appendJsonl(paths.log, scrub({ at: new Date(clock()).toISOString(), event, ...fields }));
    const said = new Map<string, number>();
    const notify = (kind: string, text: string, fields: Record<string, unknown> = {}, dedupeKey?: string) => {
      const key = dedupeKey ?? `${kind}:${text}`;
      const last = said.get(key) ?? 0;
      if (dedupeKey && clock() - last < 10 * 60_000) return;
      said.set(key, clock());
      const entry = scrub({ at: new Date(clock()).toISOString(), kind, text, ...fields });
      appendJsonl(paths.notifications, entry);
      out(`[${agent!.name}] ${kind}: ${String(entry.text)}`);
      const command = process.env.FEAST_LEAGUE_NOTIFY?.trim();
      if (command) {
        try {
          const child = spawn(command, [], { stdio: ["pipe", "ignore", "ignore"], detached: true });
          child.stdin?.end(JSON.stringify(entry));
          child.unref();
        } catch {
          // A notifier that fails never stops the runtime.
        }
      }
    };

    // Addendum 8: the RPC's fallback, logged when the endpoint in use changes (never the primary's URL).
    const chain = deps.chain ?? new LeagueChain(network, rpcUrl, 30_000, (change) => log("rpc.switch", change));
    const executor = new Executor({ signer: deps.signer, chain, wallet, network, rpcUrl, stopReason: () => stopReason(deps.home, deps.name), log, now: clock, fetch: deps.fetch });
    const market = new Market(chain, { indexer: deps.indexer, fetch: deps.fetch, log });

    // --- the wallet's state (L16) ------------------------------------------------------------
    const wallet0: WalletState = { connected: false, devMode: false, quotaLeftUsd: 0, balanceWei: 0n };
    let walletState = wallet0;
    let bnbUsd = 0;
    const expiryWarned = new Set<string>();
    // The sign-in (PLAN-941 §7): what the reminder has said for it, kept on disk so a restart never repeats it.
    let session: SessionMemory = readJson<SessionMemory>(paths.session) ?? freshMemory();
    let signedOut = false;
    const sessionSay = (reading: { connected: boolean; view: SessionView | null }) => {
      const step = sessionStep(session, reading, clock());
      session = step.memory;
      signedOut = step.signedOut;
      writeJsonAtomic(paths.session, session);
      for (const code of step.say) notify("session", sessionNotice(code, session.end, "en"), { code, endsAt: session.end !== null ? new Date(session.end).toISOString() : null });
    };
    const preflight = async (): Promise<void> => {
      let status: { connected: boolean; status: string };
      try {
        status = await deps.signer.status();
      } catch (error) {
        walletState = { ...walletState, connected: false };
        // Past the sign-in's known end, a wallet that cannot be read is a signed-out one: said once, not every 10 minutes.
        if (pastEnd(session, clock())) sessionSay({ connected: false, view: null });
        else notify("paused", `the wallet could not be read: ${error instanceof BawError ? error.message : String(error)}`, {}, "wallet-read");
        return;
      }
      if (!status.connected) {
        walletState = { ...walletState, connected: false };
        sessionSay({ connected: false, view: null });
        return;
      }
      try {
        const settings = await deps.signer.settings();
        const now = clock();
        const devExpires = settings.devModeExpiresAt === null ? null : settings.devModeExpiresAt * 1_000;
        const devMode = settings.devModeEnabled && (devExpires === null || devExpires > now) && !settings.balanceExceeded;
        const quotaLeftUsd = (settings.devModeDailyLimitUsd ?? Number.POSITIVE_INFINITY) - (settings.devModeQuotaUsedUsd ?? 0);
        sessionSay({ connected: true, view: sessionView(settings) });
        walletState = { ...walletState, connected: !signedOut, devMode, quotaLeftUsd };
        if (settings.balanceExceeded) notify("devmode", "the wallet's balance is above its Developer Mode daily limit: Developer Mode will not sign, not even an exit. Raise the limit in the Binance App or move funds.", {}, "balance-exceeded");
        if (devExpires !== null && devExpires - now < 24 * 3_600_000 && !expiryWarned.has("dev")) {
          expiryWarned.add("dev");
          notify("devmode", "Developer Mode expires within 24 h: renew it in the Binance App");
        }
      } catch (error) {
        walletState = { ...walletState, connected: false };
        notify("paused", `the wallet could not be read: ${error instanceof BawError ? error.message : String(error)}`, {}, "wallet-read");
      }
    };
    await preflight();
    if (!walletState.connected) return { exit: "refused", reason: "the wallet is not connected: sign in first (baw auth signin)" };
    if (!walletState.devMode) return { exit: "refused", reason: "Developer Mode is off, expired, or the balance is above its limit: fix it in the Binance App" };

    // --- the season gate (task 968) ------------------------------------------------------------
    const waits = agent.league?.waitForSeason === true && agent.track !== "entry";
    // Addendum 8: a prompt agent reads the league every 5 minutes for its whole run (the gate, the season's end, the
    // warm-up dinner, the runtime's release, and the health flag it carries), not only while it waits.
    const leagueReads = waits || (agent.track === "prompt" && !deps.only);
    const random = deps.random ?? Math.random;
    const gate = { open: !waits, opensAt: null as number | null, nextRead: 0, over: false, warmUpDinnerAt: null as number | null, day: null as number | null };
    const gateBackoff = new Backoff({ now: clock, random });
    const readSeason = deps.seasonRead ?? ((o: { health: Health }) => new LeagueSite(deps.site ?? siteFromEnv(), withHealth(deps.fetch ?? fetch, o.health), 8_000).league("today", null));
    /** The health flag the league read carries; set once the loop's figures exist. */
    let healthOf: () => Health = () => "ok";
    const saveGate = () =>
      writeGate(deps.home, deps.name, {
        state: gate.over ? "over" : gate.open ? "open" : "waiting",
        opensAt: gate.opensAt === null ? null : new Date(gate.opensAt).toISOString(),
        at: new Date(clock()).toISOString(),
        warmUpDinnerAt: gate.warmUpDinnerAt === null ? null : new Date(gate.warmUpDinnerAt).toISOString(),
        day: gate.day,
      });
    /** The runtime's release against the page's newest (addendum 8): said once a league day when behind; never acted on. */
    const noteRelease = (read: LeagueRead, now: number) => {
      const v = versionView(read.latestRuntime, now);
      if (!v) {
        // The page says nothing of it: nothing is said, and nothing old is shown.
        rmSync(versionPath(deps.home, deps.name), { force: true });
        return;
      }
      const day = leagueDayKey(now);
      const said = readVersion(deps.home, deps.name)?.saidFor ?? null;
      const tell = v.behind && said !== day;
      if (tell) {
        log("runtime.behind", { current: v.current, latest: v.latest, minSupported: v.minSupported });
        notify("version", versionNotice(v), { latest: v.latest, current: v.current });
      }
      writeVersion(deps.home, deps.name, { ...v, saidFor: tell ? day : said });
    };
    /** The dinner tonight is the warm-up's, which asks no floor (addendum 8): from the league's clock. */
    const warmUpTonight = (now: number) => gate.warmUpDinnerAt !== null && nextDinner(now) === gate.warmUpDinnerAt;
    /** One read of the league: when trading opens, whether the season is over, which dinner is the warm-up. A failed read keeps what was known, and asks again under the backoff. */
    const readGate = async () => {
      const now = clock();
      const read = await readSeason({ health: healthOf() }).catch(() => null);
      if (!read) {
        const wait = gateBackoff.fail({ status: null, reason: "the league could not be read" });
        // A closed gate asks again soon (its opening may be near); an open one has nothing urgent: the 5 minutes.
        gate.nextRead = now + (gate.open ? Math.max(wait, GATE_READ_MS) : wait);
        return;
      }
      gateBackoff.ok();
      noteRelease(read, now);
      const wasOver = gate.over;
      gate.over = seasonOver(read);
      gate.day = read.state === "season" ? read.season.day : null;
      const warm = warmUpDinner(read);
      if (warm !== null) gate.warmUpDinnerAt = warm;
      if (!gate.open) {
        const opening = tradingOpens(read);
        gate.opensAt = opening.kind === "open" ? now : opening.kind === "at" ? opening.at : null;
      }
      // Every 5 minutes, and once more at the opening instant.
      gate.nextRead = !gate.open && gate.opensAt !== null && gate.opensAt > now ? Math.min(now + GATE_READ_MS, gate.opensAt) : now + GATE_READ_MS;
      if (gate.over !== wasOver) {
        log(gate.over ? "season.over" : "season.resumed", { state: read.state });
        notify("season", gate.over ? "the season is over (feast.meme says so): nothing trades on its own but the hard stop-loss, and no buy is taken; FL sell still sells what is left" : "the league says the season is on again: trading resumes");
      }
      saveGate();
    };
    if (leagueReads) await readGate();

    // --- the book and the strategy --------------------------------------------------------
    /** This run's own token (addendum 8): its sends in flight are its own; any other's are a stopped run's. */
    const runToken = randomUUID();
    let book: Book = existsSync(paths.state) ? parseBook(readFileSync(paths.state, "utf8")) : emptyBook();
    // A passing FL script check on record for these exact bytes, with the audit passed above, is the warm-up done (task 963).
    const checkPassed = agent.track === "script" && scriptCheckPassed(deps.home, agent.script!.sha256);
    if (agent.track === "script" && book.warmup?.sha !== agent.script!.sha256) book = { ...book, warmup: { sha: agent.script!.sha256, trades: checkPassed ? WARMUP_TRADES : 0, consecutiveFailures: 0, launches: 0 } };
    else if (checkPassed && book.warmup && book.warmup.trades < WARMUP_TRADES) book = { ...book, warmup: { ...book.warmup, trades: WARMUP_TRADES } };
    if (checkPassed) log("warmup.passed", { by: "FL script check", sha: agent.script!.sha256 });
    // A prompt agent runs on a wallet whose body coin FL enter made: that is its launch, so a launch autopilot runs that
    // coin (its buybacks) and never launches a second one, and a buy of it is marked as the agent's own coin.
    if (agent.track === "prompt" && !book.launched) {
      const entryDir = agentPaths(deps.home, ENTRY_AGENT).dir;
      const body = readJson<{ bodyCoin?: string | null; launchTx?: string | null }>(join(entryDir, "entry.json"))?.bodyCoin;
      if (typeof body === "string" && isAddress(body, { strict: false })) {
        const entryBook = existsSync(join(entryDir, "state.json")) ? parseBook(readFileSync(join(entryDir, "state.json"), "utf8")) : null;
        const same = entryBook?.launched?.coin.toLowerCase() === body.toLowerCase() ? entryBook.launched : null;
        book = { ...book, launched: same ?? { coin: getAddress(body), poolId: "0x", at: 0, txHash: `0x${"0".repeat(64)}` } };
        log("launch.inherited", { coin: getAddress(body), from: ENTRY_AGENT });
      }
    }
    if (deps.clearPause && book.paused) {
      appendJsonl(paths.log, { at: new Date(clock()).toISOString(), event: "pause.cleared", by: "user", was: book.paused });
      book = clearPause(book);
    }
    const statePath = join(paths.dir, "strategy-state.json");
    const stored = readJson<{ key: string; state: Record<string, unknown> }>(statePath);
    const stateKey = agent.track === "script" ? agent.script!.sha256 : agent.track === "entry" ? "entry" : agent.track === "prompt" ? `prompt:${agent.preset ?? "none"}` : `preset:${agent.preset}`;
    let strategyState: Record<string, unknown> = stored?.key === stateKey ? stored.state : {};
    const save = () => {
      writeFileAtomic(paths.state, serializeBook(book));
      writeJsonAtomic(statePath, { key: stateKey, state: strategyState });
    };

    const queue: Intent[] = [];
    const enqueue = (intents: Intent[]) => {
      for (const intent of intents) {
        if (intent.kind === "sell" && queue.some((q) => q.kind === "sell" && q.coin?.toLowerCase() === intent.coin?.toLowerCase())) continue;
        queue.push(intent);
        log("intent.queued", { id: intent.id, kind: intent.kind, coin: intent.coin, bnb: intent.bnb, fraction: intent.fraction, source: intent.source, reason: intent.reason });
      }
      queue.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt - b.createdAt);
    };

    // A prompt agent's autopilot stands by while its host trades (set below, with the strategy).
    let standingBy = () => false;
    // Task 975, addendum 4: the floor guard, 20 minutes before the dinner with the day's floor unmet (set below).
    let guarding = () => false;
    const extras: PresetExtras = {
      claimAndBuyBack: (coin: Address, options) => {
        const intent: Intent = { id: `claim-${clock()}`, kind: "claim", coin, reason: options.reason, source: "preset", createdAt: clock(), claim: { buybackPct: options.buybackPct, minClaimBnb: options.minClaimBnb } };
        enqueue([intent]);
        return intent.id;
      },
      // Task 975: the day's trades and volume from this agent's log, as the page counts them; null when unreadable.
      day: () => {
        try {
          const count = dayCount(deps.home, deps.name, clock(), leftOut(deps.home, book.launched?.coin));
          // The warm-up dinner asks no floor (addendum 8): the floor keeper has none to keep tonight.
          return warmUpTonight(clock()) ? { ...count, passed: true, noFloor: true } : count;
        } catch {
          return null;
        }
      },
      standingBy: () => standingBy(),
      guard: () => guarding(),
    };

    const warmup = () =>
      agent!.track === "script" && book.warmup && warmupActive(book.warmup)
        ? { active: true, remaining: WARMUP_TRADES - book.warmup.trades, sizeBnb: Math.min(WARMUP_SIZE_BNB, agent!.limits.maxTradeBnb) }
        : null;
    const halt = (reason: string) => {
      writeStop(paths.stop, reason);
      log("halt", { reason });
      notify("halted", reason);
    };

    const runStrategy = async (fn: "onTick" | "onEvent", snapshot: Snapshot, event?: StrategyEvent) => {
      const result = await loaded!.call(fn, snapshot, strategyState, event);
      strategyState = result.state;
      for (const line of result.logs) log("strategy.log", { text: line });
      for (const problem of result.problems) log("strategy.problem", { problem });
      if (agent!.track === "script" && result.problems.some((p) => p.startsWith("the script failed"))) {
        book = recordFailure(book, result.problems[0]!, agent!.limits.maxConsecutiveFailures);
        if (book.warmup && warmupActive(book.warmup)) {
          const next = warmupAfter(book.warmup, "failure");
          book = { ...book, warmup: next.next };
          if (next.halt) halt(next.halt);
        }
      }
      enqueue(result.intents);
      save();
    };

    // --- one intent, start to finish -----------------------------------------------------
    /** What became of each intent a request from the CLI asked for, by the intent's id: `FL buy` and `FL sell` wait for it. */
    type Outcome = { outcome: "filled" | "refused" | "failed" | "unknown" | "stale" | "nothing" | "dropped"; [k: string]: unknown };
    const outcomes = new Map<string, Outcome>();
    const requested = new Map<string, string>();
    // Task 975, addendum 4: the ask's own trade, journaled with what became of it; its intents are not the host's.
    const askIds = new Set<string>();
    let askOutcome: { id: string; done: (outcome: Outcome) => void } | null = null;
    const settle = (intent: Intent, outcome: Outcome) => {
      if (askOutcome?.id === intent.id) {
        const done = askOutcome.done;
        askOutcome = null;
        done(outcome);
      }
      if (requested.has(intent.id)) outcomes.set(intent.id, outcome);
    };
    const report = (intentId: string) => {
      const requestId = requested.get(intentId);
      if (!requestId) return;
      requested.delete(intentId);
      log("request.outcome", { requestId, ...(outcomes.get(intentId) ?? { outcome: "dropped", reason: "the runtime did not act on it" }) });
      outcomes.delete(intentId);
    };
    dropQueued = (reason: string) => {
      if (askOutcome) {
        const done = askOutcome.done;
        askOutcome = null;
        done({ outcome: "dropped", reason });
      }
      for (const intentId of [...requested.keys()]) {
        if (!outcomes.has(intentId)) outcomes.set(intentId, { outcome: "dropped", reason });
        report(intentId);
      }
    };
    const refused = (intent: Intent, verdict: Extract<GuardVerdict, { ok: false }>) => {
      settle(intent, { outcome: "refused", kind: intent.kind, limit: verdict.limit, message: verdict.message });
      book = recordRefusal(book);
      log("intent.refused", { id: intent.id, kind: intent.kind, limit: verdict.limit, message: verdict.message, halt: verdict.halt });
      notify("refused", `${verdict.limit}: ${verdict.message}`, { limit: verdict.limit }, `refused:${verdict.limit}`);
      if (verdict.halt) halt(`${verdict.limit === "W" ? "warm-up" : verdict.limit}: ${verdict.message}`);
      save();
    };
    /**
     * A transaction whose outcome is not known: sent but with no receipt in 120 s, or one the wallet
     * may have sent when its execute failed or asked for an App confirmation. It is kept in the book
     * (a restart remembers it), entries pause, a pending buy counts against the spend limits, and every
     * 15 s the runtime asks again — a late fill is booked like any other, so a position never exists on
     * chain without the book and its exits knowing. A hash the node no longer knows, or an unknown
     * outcome that moved no balance, is released after 15 minutes.
     */
    const RELEASE_AFTER_MS = 15 * 60_000;
    const resolvePending = async () => {
      for (const item of [...book.unresolved]) {
        // A send of this run still in the wallet's hands: its own call settles it.
        if (item.sending && item.run === runToken) continue;
        const age = clock() - item.at;
        /** Left by a run that stopped before the wallet answered (addendum 8): reconciled now, not in 15 minutes. */
        const leftMidSend = item.sending === true;
        const release = (why: string) => {
          book = { ...book, unresolved: book.unresolved.filter((u) => u !== item) };
          log("unresolved.released", { id: item.intentId, txHash: item.txHash, kind: item.kind, why });
          notify("trade", `${item.kind} ${item.txHash ?? "(no hash)"}: ${why}`);
          save();
        };
        const info = { coin: item.coin, quote: item.quote, symbol: item.symbol, creator: item.coin, poolId: "0x" as Hex, coinIsCurrency0: true, name: item.symbol };
        if (item.txHash) {
          const receipt = await chain.client.getTransactionReceipt({ hash: item.txHash }).catch(() => null);
          if (!receipt) {
            if (age > RELEASE_AFTER_MS) {
              const known = await chain.client.getTransaction({ hash: item.txHash }).catch(() => null);
              const lock = await deps.signer.txLock().catch(() => "LOCKED" as const);
              if (!known && lock === "UNLOCKED") release("the network no longer knows this transaction: it was dropped or replaced, so nothing was traded");
            }
            continue;
          }
          book = { ...book, unresolved: book.unresolved.filter((u) => u !== item) };
          const gasWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
          if (receipt.status !== "success") {
            log("unresolved.reverted", { txHash: item.txHash });
            notify("trade", `${item.txHash} reverted after its receipt was late; nothing was traded`);
          } else if (item.kind === "buy") {
            const fills = executor.verifyBuy(receipt, { call: { to: item.coin, data: "0x", value: 0n }, info, quotedOut: 0n, minOut: 0n, impactPct: 0, sizeWei: item.sizeWei, payIn: item.payIn });
            if (!fills.ok) halt(`receipt mismatch on ${item.txHash}: ${fills.reason}`);
            else bookLateBuy(item, fills.coinsOut, item.payIn === "native" ? item.sizeWei : await chain.quoteToBnbWei(item.quote, fills.quoteIn), gasWei);
          } else if (item.kind === "sell") {
            const fills = executor.verifySell(receipt, { call: { to: item.coin, data: "0x", value: 0n }, info, coinsIn: item.sizeWei, quotedOut: 0n, minOut: 0n, quotedBy: "quoter" });
            if (!fills.ok) halt(`receipt mismatch on ${item.txHash}: ${fills.reason}`);
            else bookLateSell(item, fills.coinsIn, fills.bnbOutWei, gasWei);
          } else if (item.kind === "launch") {
            const made = executor.verifyLaunch(receipt);
            if (!made.ok) halt(`receipt mismatch on ${item.txHash}: ${made.reason}`);
            else {
              book = { ...recordGas(book, gasWei, "launches"), launched: { coin: made.coin, poolId: made.poolId, at: clock(), txHash: item.txHash } };
              log("launch.made", { id: item.intentId, txHash: item.txHash, late: true, coin: made.coin });
              notify("trade", `a late receipt: the launch landed (${item.txHash})`);
            }
          } else if (item.kind === "claim") {
            const paid = executor.verifyClaim(receipt);
            book = recordClaim(book, await chain.quoteToBnbWei(item.quote, paid), gasWei);
            log("claim.paid", { id: item.intentId, txHash: item.txHash, late: true, quoteAmount: paid });
          }
          save();
          continue;
        }
        // No hash: read the outcome from the coin's balance.
        if (item.balanceBefore !== null && (item.kind === "buy" || item.kind === "sell")) {
          const now = await chain.tokenBalance(item.coin, wallet).catch(() => null);
          if (now !== null && item.kind === "buy" && now >= item.balanceBefore + item.minCoins) {
            book = { ...book, unresolved: book.unresolved.filter((u) => u !== item) };
            // The cost is what it was sent with: the BNB, or the quote paid converted to BNB — never zero.
            bookLateBuy(item, now - item.balanceBefore, item.payIn === "native" ? item.sizeWei : await chain.quoteToBnbWei(item.quote, item.sizeWei), 0n);
            save();
            continue;
          }
          if (now !== null && item.kind === "sell" && now + item.sizeWei <= item.balanceBefore) {
            book = { ...book, unresolved: book.unresolved.filter((u) => u !== item) };
            // The BNB out is not known without the receipt: the floor the sale was sent with is booked.
            bookLateSell(item, item.sizeWei, item.minCoins, 0n);
            save();
            continue;
          }
        }
        if (leftMidSend && item.txHash === null && item.balanceBefore !== null && (await deps.signer.txLock().catch(() => "LOCKED" as const)) === "UNLOCKED") {
          // The wallet is free, gave no hash, and the coin's balance did not move: the last run stopped before it sent.
          release("the last run stopped before the wallet sent it, and no balance moved: nothing was traded");
          continue;
        }
        if (age > RELEASE_AFTER_MS && (await deps.signer.txLock().catch(() => "LOCKED" as const)) === "UNLOCKED") release("no balance moved in 15 minutes and the wallet is free: it was not sent");
      }
    };
    const bookLateBuy = (item: (typeof book.unresolved)[number], coinsOut: bigint, bnbIn: bigint, gasWei: bigint) => {
      book = recordBuy(book, { coin: item.coin, symbol: item.symbol, quote: item.quote, coinsOut, bnbInWei: bnbIn, gasWei, at: clock(), fundedBy: item.fundedBy, ownLaunch: book.launched?.coin.toLowerCase() === item.coin.toLowerCase(), source: item.source });
      if (item.fundedBy === "wallet" && bnbIn > 0n) addToLedger(deps.home, { at: clock(), agent: deps.name, wei: bnbIn, tx: item.txHash ?? "unknown" });
      log("buy.filled", { id: item.intentId, txHash: item.txHash, late: true, coin: item.coin, coinsOut, bnbInWei: bnbIn, payerIsWallet: item.txHash !== null });
      notify("trade", `a late outcome: bought ${item.symbol} for ${weiToBnb(bnbIn)} BNB (${item.txHash ?? "read from the balance"})`);
      enqueue([{ id: `arm-${clock()}`, kind: "arm", coin: item.coin, reason: "arm the exit", source: "runtime", createdAt: clock() }]);
    };
    const bookLateSell = (item: (typeof book.unresolved)[number], coinsIn: bigint, bnbOut: bigint, gasWei: bigint) => {
      book = recordSell(book, { coin: item.coin, coinsIn, bnbOutWei: bnbOut, gasWei, at: clock() });
      log("sell.filled", { id: item.intentId, txHash: item.txHash, late: true, coin: item.coin, coinsIn, bnbOutWei: bnbOut, estimated: item.txHash === null });
      notify("trade", `a late outcome: sold ${item.symbol} (${item.txHash ?? "read from the balance; the BNB out is the floor it was sent with"})`);
    };
    /** Keep a transaction whose outcome is not known. It never touches the L14 pause; `pauseReason` reads both. */
    const unresolvedSend = (
      intent: Intent,
      txHash: Hex | null,
      kind: "buy" | "sell" | "launch" | "claim",
      what: { coin: Address; quote: Address; symbol: string; payIn?: "native" | "quote"; sizeWei?: bigint; balanceBefore?: bigint | null; minCoins?: bigint },
      reason: string,
    ) => {
      book = {
        ...book,
        unresolved: [
          ...book.unresolved,
          {
            txHash,
            kind,
            at: clock(),
            intentId: intent.id,
            source: intent.source,
            fundedBy: intent.fundedBy ?? "wallet",
            coin: what.coin,
            symbol: what.symbol,
            quote: what.quote,
            payIn: what.payIn ?? "native",
            sizeWei: what.sizeWei ?? 0n,
            balanceBefore: what.balanceBefore ?? null,
            minCoins: what.minCoins ?? 0n,
          },
        ],
      };
      settle(intent, { outcome: "unknown", kind, txHash, reason });
      log("unresolved", { id: intent.id, txHash, kind, reason });
      notify("paused", `${kind} ${txHash ?? "(the wallet's answer was lost)"}: the outcome is not known yet (${reason}); entries pause until it resolves, and the runtime keeps checking`);
      save();
    };
    /** A send whose outcome is unknown — no receipt, a failed execute, an App confirmation — is kept, never just failed. */
    const unknownOutcome = (stage: string) => stage === "receipt" || stage === "execute" || stage === "confirmation";
    /**
     * A send, journal first (task 975, addendum 8, gap G3): the record is on disk before the wallet is asked, its hash
     * the moment the wallet gives one, and it leaves the book only with the outcome (the booking that follows saves
     * both at once). A run killed between the send and the receipt leaves it for the next start to reconcile.
     */
    const sendRecorded = async (
      intent: Intent,
      kind: "buy" | "sell" | "launch" | "claim",
      what: { coin: Address; quote: Address; symbol: string; payIn?: "native" | "quote"; sizeWei?: bigint; balanceBefore?: bigint | null; minCoins?: bigint },
      label: string,
      call: Parameters<Executor["send"]>[1],
    ) => {
      let record: Book["unresolved"][number] = {
        txHash: null,
        kind,
        at: clock(),
        intentId: intent.id,
        source: intent.source,
        fundedBy: intent.fundedBy ?? "wallet",
        coin: what.coin,
        symbol: what.symbol,
        quote: what.quote,
        payIn: what.payIn ?? "native",
        sizeWei: what.sizeWei ?? 0n,
        balanceBefore: what.balanceBefore ?? null,
        minCoins: what.minCoins ?? 0n,
        sending: true,
        run: runToken,
      };
      book = { ...book, unresolved: [...book.unresolved, record] };
      save();
      log("send.recorded", { id: intent.id, kind });
      const sent = await executor.send(label, call, (txHash) => {
        const next = { ...record, txHash };
        book = { ...book, unresolved: book.unresolved.map((u) => (u === record ? next : u)) };
        record = next;
        save();
      });
      book = { ...book, unresolved: book.unresolved.filter((u) => u !== record) };
      return sent;
    };

    const failed = (intent: Intent, stage: string, reason: string, txHash?: Hex) => {
      if (stage === "stopped" || stage === "busy") {
        settle(intent, { outcome: "dropped", kind: intent.kind, stage, reason });
        log("intent.dropped", { id: intent.id, stage, reason });
        save();
        return;
      }
      settle(intent, { outcome: "failed", kind: intent.kind, stage, reason, txHash });
      const wasPaused = book.paused;
      book = recordFailure(book, `${stage}: ${reason}`, agent!.limits.maxConsecutiveFailures);
      log("intent.failed", { id: intent.id, kind: intent.kind, stage, reason, txHash });
      notify("failure", `${intent.kind} failed at ${stage}: ${reason}`, { txHash });
      if (!wasPaused && book.paused) notify("paused", `entries are paused: ${book.paused}`);
      if (agent!.track === "script" && book.warmup && warmupActive(book.warmup)) {
        const next = warmupAfter(book.warmup, "failure");
        book = { ...book, warmup: next.next };
        if (next.halt) halt(next.halt);
      }
      save();
    };
    const traded = () => {
      if (agent!.track !== "script" || !book.warmup) return;
      const was = warmupActive(book.warmup);
      book = { ...book, warmup: warmupAfter(book.warmup, "trade").next };
      if (was && !warmupActive(book.warmup)) notify("warmup", `the script finished its warm-up: ${WARMUP_TRADES} clean trades; it now trades at its own sizes, within the limits`);
    };

    const arm = async (token: Address, intent: Intent): Promise<boolean> => {
      const calls = await executor.armCalls(token);
      if (!calls.ok) {
        failed(intent, "prepare", calls.reason);
        return false;
      }
      for (const step of calls.value) {
        const sent = await executor.send(step.label, step.call);
        if (!sent.ok) {
          failed(intent, sent.stage, `${step.label}: ${sent.reason}`, sent.txHash);
          return false;
        }
        book = recordGas(book, sent.gasWei, "arms");
        log("armed.step", { label: step.label, txHash: sent.txHash, gasWei: sent.gasWei });
        save();
      }
      book = markArmed(book, token);
      save();
      return true;
    };

    const processIntent = async (intent: Intent) => {
      const now = clock();
      if (intent.kind === "buy" && intent.expiresAt !== undefined && now > intent.expiresAt) {
        settle(intent, { outcome: "stale", kind: intent.kind });
        log("intent.stale", { id: intent.id, reason: intent.reason });
        return;
      }
      walletState = { ...walletState, balanceWei: await chain.balance(wallet).catch(() => walletState.balanceWei) };
      bnbUsd = await chain.bnbUsd(now).catch(() => bnbUsd);
      const coinIsFeast = intent.coin ? await chain.isFeastCoin(intent.coin).catch(() => false) : true;
      const input: GuardInput = {
        intent,
        limits: agent!.limits,
        now,
        wallet: walletState,
        bnbUsd,
        stopped: stopReason(deps.home, deps.name) !== null,
        coinIsFeast,
        book: bookView(book, intent.coin, now),
        walletSpentWei: readLedger(deps.home).spentWei + pendingBuysWei(book, "wallet"),
        claimFundsWei: book.claimFundsWei,
        warmup: agent!.track === "script" ? book.warmup : null,
      };
      const verdict = guard(input);
      if (!verdict.ok) return refused(intent, verdict);
      if (verdict.forced) log("warmup.forced", { id: intent.id, forced: verdict.forced });
      const approved = verdict.intent;
      // Task 975 (the coordinator's ruling C6): only the host's trade holds the autopilot back, an FL buy or FL sell the guard let through.
      if (agent!.track === "prompt" && approved.source === "manual" && !askIds.has(approved.id) && (approved.kind === "buy" || approved.kind === "sell")) recordHostAction(deps.home, deps.name, approved.kind, clock());

      if (approved.kind === "buy") {
        const coin = approved.coin!;
        const payIn = approved.payIn ?? "native";
        const amount = payIn === "quote" ? approved.quoteAmount ?? 0n : verdict.sizeWei!;
        const prepared = await executor.prepareBuy(coin, amount, approved.slippagePct!, payIn);
        if (!prepared.ok) return failed(approved, "prepare", prepared.reason);
        const again = guard({ ...input, impactPct: prepared.value.impactPct });
        if (!again.ok) return refused(approved, again);
        log("buy.prepared", { id: approved.id, coin, sizeWei: prepared.value.sizeWei, payIn, quotedOut: prepared.value.quotedOut, minOut: prepared.value.minOut, impactPct: prepared.value.impactPct });
        const balanceBefore = await chain.tokenBalance(coin, wallet).catch(() => null);
        const sent = await sendRecorded(approved, "buy", { ...prepared.value.info, payIn, sizeWei: prepared.value.sizeWei, balanceBefore, minCoins: prepared.value.minOut }, `buy ${prepared.value.info.symbol}`, prepared.value.call);
        if (!sent.ok && unknownOutcome(sent.stage)) {
          return unresolvedSend(approved, sent.txHash ?? null, "buy", { ...prepared.value.info, payIn, sizeWei: prepared.value.sizeWei, balanceBefore, minCoins: prepared.value.minOut }, `${sent.stage}: ${sent.reason}`);
        }
        if (!sent.ok) return failed(approved, sent.stage, sent.reason, sent.txHash);
        const fills = executor.verifyBuy(sent.receipt, prepared.value);
        if (!fills.ok) {
          failed(approved, "mismatch", fills.reason, sent.txHash);
          return halt(`receipt mismatch on ${sent.txHash}: ${fills.reason}`);
        }
        const bnbIn = payIn === "native" ? prepared.value.sizeWei : await chain.quoteToBnbWei(prepared.value.info.quote, fills.quoteIn);
        const fundedBy = approved.fundedBy ?? "wallet";
        book = recordBuy(book, {
          coin,
          symbol: prepared.value.info.symbol,
          quote: prepared.value.info.quote,
          coinsOut: fills.coinsOut,
          bnbInWei: bnbIn,
          gasWei: sent.gasWei,
          at: clock(),
          fundedBy,
          ownLaunch: book.launched?.coin.toLowerCase() === coin.toLowerCase(),
          source: approved.source,
        });
        if (fundedBy === "wallet") addToLedger(deps.home, { at: clock(), agent: deps.name, wei: bnbIn, tx: sent.txHash });
        traded();
        settle(approved, { outcome: "filled", kind: "buy", coin, symbol: prepared.value.info.symbol, bnb: weiToBnb(bnbIn), txHash: sent.txHash });
        log("buy.filled", { id: approved.id, txHash: sent.txHash, coin, coinsOut: fills.coinsOut, bnbInWei: bnbIn, feeQuote: fills.fee, gasWei: sent.gasWei, payerIsWallet: true });
        notify("trade", `bought ${prepared.value.info.symbol} for ${weiToBnb(bnbIn)} BNB (${sent.txHash})`, { txHash: sent.txHash });
        save();
        if (!positionOf(book, coin)?.armed && book.launched?.coin.toLowerCase() !== coin.toLowerCase()) {
          enqueue([{ id: `arm-${clock()}`, kind: "arm", coin, reason: "arm the exit: approve Permit2 and its allowance, so a sale is one transaction", source: "runtime", createdAt: clock() }]);
        }
        return;
      }

      if (approved.kind === "sell") {
        const coin = approved.coin!;
        const position = positionOf(book, coin);
        if (!position) {
          settle(approved, { outcome: "nothing", kind: "sell", coin });
          return log("sell.nothing", { id: approved.id, coin });
        }
        // Every sale re-checks the allowance on chain: Permit2's lasts 30 days, so "armed" once is not armed for ever.
        if (!(await arm(coin, approved))) return;
        const coins = (position.coins * BigInt(Math.round((approved.fraction ?? 1) * 1_000_000))) / 1_000_000n;
        const prepared = await executor.prepareSell(coin, coins, approved.slippagePct!);
        if (!prepared.ok) return failed(approved, "prepare", prepared.reason);
        log("sell.prepared", { id: approved.id, coin, coinsIn: prepared.value.coinsIn, quotedOut: prepared.value.quotedOut, minOut: prepared.value.minOut, quotedBy: prepared.value.quotedBy });
        const balanceBefore = await chain.tokenBalance(coin, wallet).catch(() => null);
        const sent = await sendRecorded(approved, "sell", { ...prepared.value.info, sizeWei: prepared.value.coinsIn, balanceBefore, minCoins: prepared.value.minOut }, `sell ${prepared.value.info.symbol}`, prepared.value.call);
        if (!sent.ok && unknownOutcome(sent.stage)) {
          return unresolvedSend(approved, sent.txHash ?? null, "sell", { ...prepared.value.info, sizeWei: prepared.value.coinsIn, balanceBefore, minCoins: prepared.value.minOut }, `${sent.stage}: ${sent.reason}`);
        }
        if (!sent.ok) return failed(approved, sent.stage, sent.reason, sent.txHash);
        const fills = executor.verifySell(sent.receipt, prepared.value);
        if (!fills.ok) {
          failed(approved, "mismatch", fills.reason, sent.txHash);
          return halt(`receipt mismatch on ${sent.txHash}: ${fills.reason}`);
        }
        book = recordSell(book, { coin, coinsIn: fills.coinsIn, bnbOutWei: fills.bnbOutWei, gasWei: sent.gasWei, at: clock() });
        traded();
        settle(approved, { outcome: "filled", kind: "sell", coin, symbol: prepared.value.info.symbol, bnb: weiToBnb(fills.bnbOutWei), txHash: sent.txHash });
        log("sell.filled", { id: approved.id, txHash: sent.txHash, coin, coinsIn: fills.coinsIn, bnbOutWei: fills.bnbOutWei, gasWei: sent.gasWei, payerIsWallet: true });
        notify("trade", `sold ${prepared.value.info.symbol} for ${weiToBnb(fills.bnbOutWei)} BNB (${sent.txHash})`, { txHash: sent.txHash });
        return save();
      }

      if (approved.kind === "arm") {
        await arm(approved.coin!, approved);
        return;
      }

      if (approved.kind === "launch") {
        // One launch at a time: while one's outcome is unknown, another would make a second coin.
        if (book.launched || book.unresolved.some((u) => u.kind === "launch")) return log("launch.skipped", { id: approved.id, why: book.launched ? "this agent has launched its coin" : "a launch's outcome is not known yet" });
        const prepared = await executor.prepareLaunch({ ...approved.launch!, quote: approved.launch!.quote });
        if (!prepared.ok) return failed(approved, "prepare", prepared.reason);
        const sent = await sendRecorded(approved, "launch", { coin: prepared.value.predicted, quote: prepared.value.quote, symbol: approved.launch!.symbol }, `launch ${approved.launch!.symbol}`, prepared.value.call);
        if (!sent.ok && unknownOutcome(sent.stage)) {
          return unresolvedSend(approved, sent.txHash ?? null, "launch", { coin: prepared.value.predicted, quote: prepared.value.quote, symbol: approved.launch!.symbol }, `${sent.stage}: ${sent.reason}`);
        }
        if (!sent.ok) return failed(approved, sent.stage, sent.reason, sent.txHash);
        const made = executor.verifyLaunch(sent.receipt);
        if (!made.ok) {
          failed(approved, "mismatch", made.reason, sent.txHash);
          return halt(`receipt mismatch on ${sent.txHash}: ${made.reason}`);
        }
        book = { ...recordGas(book, sent.gasWei, "launches"), launched: { coin: made.coin, poolId: made.poolId, at: clock(), txHash: sent.txHash } };
        if (book.warmup && warmupActive(book.warmup)) book = { ...book, warmup: warmupAfter(book.warmup, "launch").next };
        log("launch.made", { id: approved.id, txHash: sent.txHash, coin: made.coin, poolId: made.poolId });
        notify("trade", `launched ${approved.launch!.symbol} (${sent.txHash})`, { txHash: sent.txHash });
        return save();
      }

      if (approved.kind === "claim") {
        const coin = approved.coin!;
        const prepared = await executor.prepareClaim(coin);
        if (!prepared.ok) return failed(approved, "prepare", prepared.reason);
        if (!prepared.value) return log("claim.nothing", { id: approved.id, coin });
        const valueWei = await chain.quoteToBnbWei(prepared.value.quote, prepared.value.claimable);
        if (valueWei < bnbToWei(approved.claim?.minClaimBnb ?? 0)) return log("claim.small", { id: approved.id, valueWei });
        const sent = await sendRecorded(approved, "claim", { coin, quote: prepared.value.quote, symbol: "claim" }, "claim the creator's share", prepared.value.call);
        if (!sent.ok && unknownOutcome(sent.stage)) return unresolvedSend(approved, sent.txHash ?? null, "claim", { coin, quote: prepared.value.quote, symbol: "claim" }, `${sent.stage}: ${sent.reason}`);
        if (!sent.ok) return failed(approved, sent.stage, sent.reason, sent.txHash);
        const paid = executor.verifyClaim(sent.receipt);
        const paidBnb = await chain.quoteToBnbWei(prepared.value.quote, paid);
        book = recordClaim(book, paidBnb, sent.gasWei);
        log("claim.paid", { id: approved.id, txHash: sent.txHash, quoteAmount: paid, valueWei: paidBnb });
        save();
        const share = BigInt(Math.round(approved.claim?.buybackPct ?? 0));
        const quoteAmount = (paid * share) / 100n;
        if (quoteAmount > 0n && (await arm(prepared.value.quote, approved))) {
          // Floored to the gwei, so the size the guard reads never rounds above the claimed funds.
          const bnb = weiToBnb((((paidBnb * share) / 100n) / 1_000_000_000n) * 1_000_000_000n);
          enqueue([
            { id: `buyback-${clock()}`, kind: "buy", coin, bnb, payIn: "quote", quoteAmount, fundedBy: "claim", slippagePct: Math.min(3, agent!.limits.maxSlippagePct), reason: "buy back with the creator's claimed share", source: "preset", createdAt: clock() },
          ]);
        }
      }
    };

    // --- the inbox: requests from the CLI to this running runtime ---------------------------
    const drainInbox = () => {
      if (!existsSync(paths.inbox)) return;
      for (const file of readdirSync(paths.inbox).filter((f) => f.endsWith(".json")).sort()) {
        const full = join(paths.inbox, file);
        let request: { type?: string; request?: IntentRequest; slippagePct?: number; requestId?: unknown } | null = null;
        try {
          request = JSON.parse(readFileSync(full, "utf8"));
        } catch {
          request = null;
        }
        rmSync(full, { force: true });
        if (request?.type === "intent" && request.request && gate.over && request.request.kind !== "sell") {
          // The season is over (addendum 8): a sale still runs; nothing else is taken.
          const requestId = typeof request.requestId === "string" && /^[a-z0-9-]{1,64}$/i.test(request.requestId) ? request.requestId : null;
          log("inbox.refused", { problem: SEASON_OVER_LINE, season: "over", kind: request.request.kind });
          if (requestId) log("request.outcome", { requestId, outcome: "refused", kind: request.request.kind, limit: null, message: SEASON_OVER_LINE });
        } else if (request?.type === "intent" && request.request && !gate.open) {
          // The season has not opened: the request is answered at once, and nothing is queued.
          const requestId = typeof request.requestId === "string" && /^[a-z0-9-]{1,64}$/i.test(request.requestId) ? request.requestId : null;
          const message = seasonClosedLine(gate.opensAt);
          log("inbox.refused", { problem: message, season: "closed", kind: request.request.kind });
          if (requestId) log("request.outcome", { requestId, outcome: "refused", kind: request.request.kind, limit: null, message });
        } else if (request?.type === "intent" && request.request) {
          const slippage = typeof request.slippagePct === "number" ? request.slippagePct : Math.min(3, agent!.limits.maxSlippagePct);
          const normal = normalizeIntent(request.request, { snapshot: { feast, now: clock(), limits: agent!.limits }, source: "manual", slippagePct: slippage, ttlMs: 120_000 });
          // The CLI's own id for the request, so `FL buy` can wait for its outcome: a plain token, never a path.
          const requestId = typeof request.requestId === "string" && /^[a-z0-9-]{1,64}$/i.test(request.requestId) ? request.requestId : null;
          if ("error" in normal) {
            log("inbox.refused", { problem: normal.error });
            if (requestId) log("request.outcome", { requestId, outcome: "refused", kind: request.request.kind, limit: null, message: normal.error });
          } else {
            if (requestId) requested.set(normal.intent.id, requestId);
            enqueue([normal.intent]);
            // A sale of a coin already queued for sale is the same sale: its request is answered now, not left waiting.
            if (requestId && !queue.includes(normal.intent)) {
              settle(normal.intent, { outcome: "dropped", kind: normal.intent.kind, reason: "a sale of this coin is already queued" });
              report(normal.intent.id);
            }
          }
        } else if (request?.type === "unpause") {
          if (book.paused) {
            log("pause.cleared", { by: "user", was: book.paused });
            notify("started", "entries resume: the user cleared the pause");
          }
          book = clearPause(book);
          save();
        } else if (request?.type === "ask") {
          // `FL ask <name>` into a running agent: one ask now.
          askNow = true;
        } else if (request?.type === "reload") {
          const next = loadAgent(deps.home, deps.name);
          if (next?.confirmed) {
            agent = next;
            log("agent.reloaded", { tickSeconds: next.tickSeconds });
          }
        }
      }
    };

    // --- the loop -------------------------------------------------------------------------
    const startedAt = clock();
    // A prompt agent's safety pass (L6, L8) runs at least every SAFETY_PASS_SECONDS, whatever its autopilot's own tick;
    // the autopilot preset is asked on its own tick, below.
    const tickMs = () => (agent!.track === "prompt" ? Math.min(SAFETY_PASS_SECONDS, agent!.tickSeconds) : agent!.tickSeconds) * 1_000;
    let nextStrategyTick = 0;
    let nextTick = 0;
    /** The loop's passes that failed in a row (addendum 8): three are told, and count toward the health flag. */
    let tickFails = 0;
    let nextPreflight = clock() + (deps.preflightMs ?? 300_000);
    let nextUnresolvedCheck = 0;
    // The coins marked fresh from the chain in a snapshot: deduplicated and capped, whatever a strategy asks for.
    const watchList = () => [...new Set([...loaded!.meta.watch, ...loaded!.wants(strategyState)].map((w) => w.toLowerCase()))].slice(0, 20);
    const watched = () => new Set([...Object.keys(book.positions), ...loaded!.meta.watch.map((w) => (w.toUpperCase() === "FEAST" ? feast.toLowerCase() : w.toLowerCase()))]);
    // The one-shot comes before any strategy is loaded or listened for: it runs the manual requests and nothing else.
    if (deps.only) {
      // An agent that waits for the season takes no manual trade before it opens, running or not.
      if (waits && !(gate.opensAt !== null && clock() >= gate.opensAt)) return { exit: "refused", reason: seasonClosedLine(gate.opensAt) };
      // An outcome an earlier run could not learn is asked about first, so the guard reads a book that is up to date.
      if (book.unresolved.length > 0) await resolvePending().catch((error: unknown) => log("unresolved.check.failed", { reason: String((error as Error).message) }));
      for (const request of deps.only) {
        if (gate.over && request.kind !== "sell") return { exit: "refused", reason: SEASON_OVER_LINE };
        const normal = normalizeIntent(request, { snapshot: { feast, now: clock(), limits: agent.limits }, source: "manual", slippagePct: Math.min(3, agent.limits.maxSlippagePct), ttlMs: 120_000 });
        if ("error" in normal) return { exit: "refused", reason: normal.error };
        enqueue([normal.intent]);
      }
      log("one-shot", { requests: deps.only.length });
      while (queue.length > 0) {
        const stop = stopReason(deps.home, deps.name);
        if (stop) {
          save();
          return { exit: "stopped", reason: stop };
        }
        await processIntent(queue.shift()!);
      }
      save();
      return { exit: "finished", reason: "the manual request ran" };
    }

    // --- the strategy, for the loop only -------------------------------------------------
    // Prompt mode: the host's silence, from its last FL buy or FL sell (or the user's yes, if it has not traded).
    const silentFor = () => clock() - Math.max(lastHostAction(deps.home, deps.name)?.at ?? 0, Date.parse(agent!.confirmed?.at ?? "") || 0);
    const idleMs = () => (agent!.autopilot?.idleMinutes ?? 0) * 60_000;
    // Task 975, addendum 4: with the ask loop on, the preset is the floor keeper. It trades when the asks have failed
    // twice in a row, or 20 minutes before the dinner with the day's floor unmet; with no asks (`--ask-with none`) it
    // takes over after the host's silence, as in league-v5.
    const askMode = () => agent!.track === "prompt" && Boolean(agent!.preset && agent!.autopilot) && Boolean(agent!.ask) && agent!.ask!.with !== "none";
    const everyMs = () => (agent!.ask?.every ?? 5) * 60_000;
    let askState: AskState = readAskState(deps.home, deps.name);
    let askNow = false;
    let asking = false;
    const guardCache = { at: Number.NEGATIVE_INFINITY, on: false };
    guarding = () => {
      if (agent!.preset !== "steady" || !agent!.autopilot) return false;
      const now = clock();
      if (now - guardCache.at < 30_000) return guardCache.on;
      const day = extras.day!();
      guardCache.at = now;
      // The warm-up dinner asks no floor (addendum 8): no guard trades before it.
      guardCache.on = !warmUpTonight(now) && now >= nextDinner(now) - 20 * 60_000 && day !== null && !day.passed;
      return guardCache.on;
    };
    const keeper = () => (askMode() ? askState.streak >= 2 && silentFor() >= everyMs() : silentFor() >= idleMs());
    const silent = () => agent!.track === "prompt" && agent!.autopilot !== null && agent!.autopilot !== undefined && agent!.preset !== null && (keeper() || guarding());
    const keepsExits = agent.track === "prompt" && agent.preset !== null && Boolean(agent.autopilot) && PRESETS[agent.preset]?.keepsExits === true;
    if (agent.track === "prompt" && !agent.preset) {
      // No autopilot: no strategy. The loop only enforces: the inbox, the preflight, L6, L8, the unresolved check, the notes.
      loaded = {
        meta: { name: "prompt", tickSeconds: agent.tickSeconds, events: [], watch: [] },
        params: {},
        wants: () => [],
        call: async (_fn, _snapshot, state) => ({ intents: [], problems: [], logs: [], state }),
        stop() {},
      };
    } else if (agent.track === "preset" || agent.track === "prompt") {
      const strategy = presetStrategy(agent.preset!);
      const presetAgent = agent;
      loaded = {
        meta: { ...strategy.meta, tickSeconds: presetAgent.tickSeconds },
        params: presetAgent.params,
        wants: (state) => strategy.wants?.(state) ?? [],
        async call(fn, snapshot, state, event) {
          const ttl = fn === "onEvent" ? 30_000 : agent!.tickSeconds * 1_000;
          const logs: string[] = [];
          // The agent's current parameters: a `feast-league set` reloads them into a running runtime.
          const { api, intents, problems } = makeApi(snapshot, { params: agent!.params, state, source: "preset", ttlMs: ttl, log: (t) => logs.push(t) });
          if (fn === "onEvent" && event) strategy.onEvent?.(api, event, extras);
          else strategy.onTick(api, extras);
          return { intents, problems, logs, state };
        },
        stop() {},
      };
      // An autopilot is the same preset, asked only while the host is silent; its intents keep the source "preset".
      // One that keeps its exits (steady, ruling C7) is asked while the host trades too, and only its sales pass.
      if (agent.track === "prompt") {
        loaded = autopilotGate(loaded, silent, keepsExits ? (intent: Intent) => intent.kind === "sell" : undefined);
        standingBy = () => !silent();
      }
    } else {
      const sandbox = await ScriptSandbox.start(scriptSource!);
      const params = { ...sandbox.params, ...agent.params };
      const slippagePct = typeof params.slippagePct === "number" ? params.slippagePct : Math.min(3, agent.limits.maxSlippagePct);
      const scriptAgent = agent;
      loaded = {
        meta: { ...sandbox.meta, tickSeconds: scriptAgent.tickSeconds },
        params,
        wants: () => [],
        async call(fn, snapshot, state, event) {
          const result = await sandbox.call(fn, { snapshot, state, params, event }, fn === "onEvent" ? 250 : 1_000);
          if (!result.ok) return { intents: [], problems: [`the script failed: ${result.error}`], logs: [], state };
          const ttl = fn === "onEvent" ? 30_000 : scriptAgent.tickSeconds * 1_000;
          const intents: Intent[] = [];
          const problems: string[] = [];
          for (const request of result.requests) {
            const normal = normalizeIntent(request as IntentRequest, { snapshot, source: "script", slippagePct, ttlMs: ttl });
            if ("error" in normal) problems.push(normal.error);
            else intents.push(normal.intent);
          }
          return { intents, problems, logs: result.logs, state: result.state };
        },
        stop: () => sandbox.stop(),
      };
    }

    const listens = (loaded.meta.events ?? []).length > 0;
    // The board (every coin's market row) only for the strategies that read it: a DCA on FEAST alone does not.
    const needBoard = () => agent!.track === "script" || agent!.preset === "momentum" || agent!.preset === "steady" || (agent!.preset === "dca" && agent!.params.targets === "topHolders");
    // The market feed (task 967), only for a strategy that listens or reads the board: a prompt agent without an
    // autopilot, and the launch preset, read nothing; an autopilot reads only while it is on.
    const feed =
      listens || needBoard()
        ? new MarketFeed({
            site: deps.site ?? siteFromEnv(),
            indexer: deps.indexer,
            fetch: deps.fetch ?? fetch,
            now: clock,
            random: deps.random ?? Math.random,
            pollSeconds: (deps.pollMs ?? 5_000) / 1_000,
            live: deps.live,
            market,
            log,
            cache: { home: deps.home, wallet },
            onStale: (failure) => notify("market", `feast.meme's market data is not answering (${failure.reason}): the agent decides on its last good read, marked stale, and asks again with a growing wait; its exits and the drawdown halt read the chain`, {}, "feed-stale"),
          })
        : null;
    let feedOn = false;
    // Addendum 6: a prompt agent's cadence, and when its next slow read is due.
    let cadenceNow: Cadence | null = null;
    let slowReadAt = 0;
    const startJitterMs = gate.open ? Math.max(0, deps.startJitterMs ?? 0) : 0;
    let jitterUntil = startedAt + startJitterMs;
    let jitterDone = startJitterMs === 0;
    /** The gate opens: the start jitter is drawn now, and the loop runs as `FL start` would. Once a run. */
    const openGate = (now: number) => {
      gate.open = true;
      const jitter = deps.noJitter ? 0 : drawStartJitter(random);
      jitterUntil = now + jitter;
      jitterDone = jitter === 0;
      nextTick = 0;
      log("season.open", { opensAt: new Date(gate.opensAt ?? now).toISOString(), jitterMs: jitter });
      notify("season", `the season is open: trading starts${jitter > 0 ? ` within ${Math.ceil(jitter / 1_000)} s` : " now"}`);
      saveGate();
    };
    log("started", { track: agent.track, preset: agent.preset, tickSeconds: agent.tickSeconds, events: loaded.meta.events, warmup: warmup(), autopilot: agent.autopilot ?? null, feed: feed ? feed.mode : null, pollMs: deps.pollMs ?? 5_000, startJitterMs, ...(waits ? { waitForSeason: true, opensAt: gate.opensAt === null ? null : new Date(gate.opensAt).toISOString() } : {}) });
    // A start after the opening (a restart on day 2, a reboot) opens at once: no "waiting" is said for it.
    if (!gate.open && !(gate.opensAt !== null && gate.opensAt <= clock())) notify("season", gate.opensAt === null ? "waiting for the season: it trades nothing until feast.meme announces the start" : `waiting for the season: it trades nothing before ${utc8(gate.opensAt)} (UTC+8)`);
    if (agent.track === "prompt") {
      // Addendum 7: with the asks on, the unified line says what runs; without them, league-v5's first cut is still true.
      if (askMode()) notify("started", `prompt mode; ${autopilotLine({ preset: agent.preset!, idleMinutes: agent.autopilot!.idleMinutes, ask: agent.ask! }, "en")}`);
      else notify("started", `prompt mode; your agent decides; ${agent.preset && agent.autopilot ? `autopilot ${agent.preset} after ${agent.autopilot.idleMinutes} min of silence` : "no autopilot"}`);
    } else {
      const passed = checkPassed ? `; warm-up passed by FL script check (sha ${agent.script!.sha256.slice(0, 6)}…${agent.script!.sha256.slice(-4)})` : "";
      notify("started", `${agent.track === "preset" ? `preset ${agent.preset}` : "script"} running; tick ${agent.tickSeconds} s${warmup() ? `; warm-up: ${warmup()!.remaining} trades at ${warmup()!.sizeBnb} BNB` : passed}`);
    }
    save();

    // The notes the user's agent wrote (FL note), sent to feast.meme when it takes them: at most once every 10 minutes, at
    // most 20 a time, never awaited, so a slow page never holds the loop or a trade.
    let nextNotesFlush = 0;
    let flushing = false;
    const flushQueuedNotes = (now: number) => {
      if (flushing || now < nextNotesFlush) return;
      nextNotesFlush = now + 10 * 60_000;
      if (!readNotes(deps.home, deps.name).some((n) => n.state === "queued")) return;
      flushing = true;
      void flushNotes(deps.home, deps.name, wallet, { site: deps.site ?? siteFromEnv(), fetch: deps.fetch ?? fetch, now: clock, max: 20, log })
        .then((out) => {
          if (out.sent + out.refused > 0) log("notes.flushed", { sent: out.sent, refused: out.refused, kept: out.kept });
          // A refused note is told, not only logged (addendum 8): once a flush, with the page's status.
          if (out.refused > 0) notify("notes", `feast.meme refused ${out.refused} note${out.refused === 1 ? "" : "s"} (HTTP ${out.lastRefused}): kept on this machine and never sent again`);
          if (out.reason === "unauthorized" || out.reason === "no-session") notify("notes", "the notes session has ended (or was never opened): notes stay on this machine; run `FL note --login` to open it again", {}, "notes-session");
        })
        .catch(() => undefined)
        .finally(() => (flushing = false));
    };
    // The autopilot's state, said once each way: on after the host's silence, off when it acts.
    let autopilotOn = false;
    /** Why the floor keeper is on (null while off): its switch says each change once (addendum 7). */
    let autopilotWhy: KeeperWhy | null = null;
    /**
     * The loop's rest between passes (task 975, addendum 3). A rest that ends more than 10 minutes late means the
     * machine slept (or the process was suspended): nothing traded meanwhile. It is logged and told once, so
     * `FL status` can say "slept N minutes at <time>".
     */
    /**
     * One ask (task 975, addendum 4): the pack from the live book, the board and the disk; the host's answer, checked
     * against it; at most one intent, through the same road as `FL buy` and `FL sell` (the guard, the executor, the
     * book). Its outcome is journaled when it settles. A failed call or an invalid answer counts toward the streak.
     */
    const askTick = async (startedAt: number) => {
      const ask = agent!.ask!;
      askState = { ...askState, lastAskAt: startedAt };
      writeAskState(deps.home, deps.name, askState);
      save();
      // A read right before the ask (addendum 6): the pack sees the market as it is now, not as the slow cadence left it.
      if (feed && feed.due()) await feed.step({ events: false }).catch(() => []);
      // The pack (addenda 4 and 5): the book this runtime just saved, the snapshot the feed holds, the league, candles, impacts.
      const gathered = await gatherPack({ home: deps.home, agent: agent!, now: startedAt, wallet, chain, snapshot: feed?.held() ?? null, fetch: deps.fetch ?? fetch, site: deps.site ?? siteFromEnv(), gate: { opensAt: gate.opensAt, open: gate.open, noFloorTonight: warmUpTonight(startedAt), signInEndsAt: session.end }, feast, impacts: impacts(executor, chain) });
      const pack: Pack = gathered.pack;
      const input = gathered.input;
      log("ask.pack", { pack: pack.digest, chars: pack.text.length, coins: pack.ids.size, requests: gathered.requests });
      const host = hostShown(ask.with);
      const row = (fields: Partial<JournalRow> & { result: string }): JournalRow => ({ at: new Date(startedAt).toISOString(), pack: pack.digest, promptSha: input.prompt.sha256, action: "none", coin: null, symbol: null, amountBnb: null, fraction: null, reason: "", ...fields });
      const failed = (cause: string) => {
        askState = { ...askState, streak: askState.streak + 1, cause: askState.streak === 0 ? cause : askState.cause, promptSha: input.prompt.sha256, last: { at: startedAt, action: "none", reason: "", result: `error: ${cause}` } };
        // The takeover is said once, by the floor keeper's own switch, with the streak's first cause (addendum 7).
        if (askState.streak === 2) askState = { ...askState, floorKeeperSince: clock() };
        writeAskState(deps.home, deps.name, askState);
        appendJournal(deps.home, deps.name, row({ result: `error: ${cause}` }));
        log("ask", { pack: pack.digest, result: "error", cause, streak: askState.streak });
      };
      const call = await (deps.askHost ?? callHost)({ with: ask.with as "claude" | "codex", pack: pack.text, home: deps.home, name: deps.name, model: ask.model });
      if (!call.ok) return failed(call.cause);
      const checked = validateAnswer(call.answer, pack);
      if (!checked.ok) return failed(`invalid answer: ${checked.why}`);
      const d = checked.decision;
      askState = { ...askState, streak: 0, cause: null, floorKeeperSince: null, memo: d.memo || askState.memo, promptSha: input.prompt.sha256 };
      const decided = { action: d.action, coin: d.coin, symbol: d.symbol, amountBnb: d.amountBnb, fraction: d.fraction, reason: d.reason };
      const finish = (result: string) => {
        askState = { ...askState, last: { at: startedAt, action: d.action, reason: d.reason, result } };
        writeAskState(deps.home, deps.name, askState);
        appendJournal(deps.home, deps.name, row({ ...decided, result }));
        log("ask", { pack: pack.digest, action: d.action, coin: d.coin, amountBnb: d.amountBnb, fraction: d.fraction, result });
      };
      if (d.action === "hold") return finish("hold");
      const request: IntentRequest = d.action === "buy" ? { kind: "buy", coin: d.coin, bnb: d.amountBnb, reason: `ask: ${d.reason}` } : { kind: "sell", coin: d.coin, fraction: d.fraction, reason: `ask: ${d.reason}` };
      const normal = normalizeIntent(request, { snapshot: { feast, now: clock(), limits: agent!.limits }, source: "manual", slippagePct: Math.min(3, agent!.limits.maxSlippagePct), ttlMs: 120_000 });
      if ("error" in normal) return finish(`invalid: ${normal.error}`);
      askIds.add(normal.intent.id);
      askOutcome = {
        id: normal.intent.id,
        done: (o) => {
          const why = (k: string) => (typeof o[k] === "string" ? String(o[k]).slice(0, 160) : "");
          finish(
            o.outcome === "filled" ? "filled" : o.outcome === "refused" ? `rejected: ${why("limit")} ${why("message")}`.trim() : o.outcome === "failed" ? `failed: ${why("stage")}: ${why("reason")}` : o.outcome === "nothing" ? "dropped: nothing to sell" : o.outcome === "stale" ? "dropped: it expired before it ran" : o.outcome === "unknown" ? "unknown: its outcome is not known yet" : `dropped: ${why("reason")}`,
          );
        },
      };
      enqueue([normal.intent]);
    };

    const rest = async () => {
      const before = clock();
      const loopMs = deps.loopMs ?? 1_000;
      await sleep(loopMs);
      const late = clock() - before - loopMs;
      if (late > SLEPT_MS) {
        // From when the rest should have ended: the last instant the loop was due to run.
        const from = before + loopMs;
        const minutes = Math.round(late / 60_000);
        log("slept", { from: new Date(from).toISOString(), minutes });
        notify("slept", `slept ${minutes} minutes at ${utc8(from)} UTC+8: nothing traded while it slept. Keep this machine awake for the season (or run it on a server or cloud computer).`);
      }
    };

    // The one word the league read carries (addendum 8), from what the loop knows now.
    healthOf = () => {
      const oldest = book.unresolved.length > 0 ? clock() - Math.min(...book.unresolved.map((u) => u.at)) : null;
      return healthFlag({ tickFailsInARow: tickFails, oldestUnresolvedMs: oldest, rpcOnFallback: chain.rpcState?.().onFallback === true, askFailsInARow: askState.streak });
    };

    for (;;) {
      const now = clock();
      const stop = stopReason(deps.home, deps.name);
      if (stop) {
        log("halted", { reason: stop });
        notify("halted", `stopped: ${stop}`);
        dropQueued(`the agent stopped before it ran: ${stop}`);
        save();
        return { exit: existsSync(paths.stop) && readFileSync(paths.stop, "utf8").trim() !== "stop requested by the user" ? "halted" : "stopped", reason: stop };
      }
      if (deps.maxRuntimeMs !== undefined && now - startedAt >= deps.maxRuntimeMs) {
        log("finished", { afterMs: now - startedAt });
        dropQueued("the agent's run ended before it ran");
        save();
        return { exit: "finished", reason: "the run's time is up" };
      }
      // The league, every 5 minutes for a prompt agent (addendum 8); while the gate is closed, at its opening instant too.
      if (leagueReads && now >= gate.nextRead) await readGate();
      if (!gate.open && gate.opensAt !== null && clock() >= gate.opensAt) openGate(clock());
      drainInbox();
      // FL start's spread: until it is over, nothing reads the site and no strategy is asked; the safety runs.
      // The season gate holds the same back, longer.
      const spreading = now < jitterUntil;
      // After the season (addendum 8) the loop keeps only the safety: the hard stop-loss, the wallet, the outcomes, the player's sales.
      const warming = spreading || !gate.open || gate.over;
      if (!warming && !jitterDone) {
        jitterDone = true;
        nextTick = 0;
        log("jitter.done", { afterMs: now - startedAt });
      }
      if (gate.over && autopilotOn) {
        // The season's end is said once, by the gate; the floor keeper only stands down.
        autopilotOn = false;
        autopilotWhy = null;
        log("autopilot.off", { preset: agent.preset, why: "season over" });
      }
      if (gate.open && !gate.over && agent.track === "prompt" && agent.preset && agent.autopilot) {
        const on = silent();
        const why: KeeperWhy | null = !on ? null : keeper() ? (askMode() ? "asks failing" : "host silent") : "floor guard";
        const was: KeeperWhy | null = autopilotWhy;
        const keeperName = `the floor keeper (${agent.preset})`;
        const host = askMode() ? hostShown(agent.ask!.with) : null;
        const toDinner = () => `${Math.round((nextDinner(now) - now) / 60_000)} min to dinner and the day's floor is unmet`;
        // One notice for each takeover, each recovery and each change of reason; none from the ask itself.
        if (on !== autopilotOn) {
          autopilotOn = on;
          if (on) nextStrategyTick = 0;
          const minutes = agent.autopilot.idleMinutes;
          log(on ? "autopilot.on" : "autopilot.off", { preset: agent.preset, idleMinutes: minutes, silentMs: silentFor(), ...(why ? { why } : {}) });
          if (why === "floor guard") notify("autopilot", `${toDinner()}: ${keeperName} fills it`);
          else if (why === "asks failing") notify("autopilot", `${host} could not be reached: ${askState.cause ?? "no answer"}; ${keeperName} trades until it answers again`);
          else if (!on && askMode() && was === "asks failing" && askState.streak === 0) notify("autopilot", `${host} answers again: ${keeperName} steps back; its own positions keep their exits`);
          else if (!on && askMode()) notify("autopilot", `${keeperName} steps back; its own positions keep their exits`);
          else notify("autopilot", on ? `your agent has been silent for ${minutes} min: autopilot ${agent.preset} trades until it acts` : keepsExits ? `your agent traded: autopilot ${agent.preset} opens nothing new; its own positions keep their exits` : `your agent acted: autopilot ${agent.preset} steps back`);
        } else if (on && why !== was) {
          // On all along, for another reason now: the asks failed while the dinner guard held it, or they answer again.
          log("autopilot.why", { preset: agent.preset, from: was, why });
          if (why === "asks failing") notify("autopilot", `${host} could not be reached: ${askState.cause ?? "no answer"}; ${keeperName} trades until it answers again`);
          else if (why === "floor guard") notify("autopilot", `${was === "asks failing" && host ? `${host} answers again, but ` : ""}${toDinner()}: ${keeperName} keeps filling it`);
        }
        autopilotWhy = why;
      }
      // Task 975, addendum 4: the ask, once the host has been silent an interval since its last trade and the last ask.
      // The first ask waits for the market's first read (at most 2 minutes from the start), so its pack has coins in it.
      const marketRead = !feed || feed.mode !== "snapshot" || feed.held() !== null || now - startedAt > 2 * 60_000;
      if (gate.open && !warming && askMode() && !asking && !askOutcome && marketRead) {
        const since = Math.max(lastHostAction(deps.home, deps.name)?.at ?? 0, askState.lastAskAt ?? 0, Date.parse(agent.confirmed?.at ?? "") || 0);
        if (askNow || now - since >= everyMs()) {
          askNow = false;
          asking = true;
          void askTick(now)
            .catch((error: unknown) => log("ask.failed", { reason: String((error as Error).message).slice(0, 200) }))
            .finally(() => (asking = false));
        }
      }
      // Notes are not trades: the gate lets them through.
      if (!spreading) flushQueuedNotes(now);
      if (now >= nextPreflight) {
        await preflight();
        nextPreflight = now + (deps.preflightMs ?? 300_000);
      }
      if (feed && !warming) {
        // An autopilot listens only while it is on; when it steps back, the next read starts at the head again.
        const wanted = agent.track !== "prompt" || autopilotOn || askMode();
        if (!wanted && feedOn) feed.reset();
        feedOn = wanted;
        // A strategy that listens reads every interval; one that only reads the board, once a tick. A prompt agent reads
        // by need (addendum 6): fast while it holds, after a fill and before dinner, else every 30–60 s.
        let readNow = listens || (needBoard() && now >= nextTick);
        if (agent.track === "prompt" && !listens) {
          const cadence = pollCadence({ now, positions: Object.keys(book.positions).length, lastFillAt: book.trades.length > 0 ? Math.max(...book.trades) : null, dinnerAt: nextDinner(now) });
          if (cadence.mode !== cadenceNow?.mode || cadence.why !== cadenceNow?.why) {
            cadenceNow = cadence;
            const fast = (deps.pollMs ?? 5_000) / 1_000;
            writeCadence(deps.home, deps.name, { ...cadence, fastSeconds: `${fast}–${fast + 3}`, at: new Date(now).toISOString() });
            log("feed.cadence", { mode: cadence.mode, why: cadence.why });
          }
          readNow = cadence.mode === "fast" || now >= slowReadAt;
        }
        if (wanted && feed.due() && readNow) {
          if (agent.track === "prompt") slowReadAt = nextSlowRead(now, random);
          const events = await feed.step({ events: listens });
          try {
            if (events.length > 0) {
              const marks = await market.marks(book);
              const balanceWei = await chain.balance(wallet).catch(() => walletState.balanceWei);
              const snapshot = await market.snapshot({ now: clock(), balanceWei, limits: agent.limits, book, marks, warmup: warmup(), watch: watchList(), feast, needBoard: false, stale: feed.stale() });
              const seen = watched();
              for (const event of events) {
                for (const strategyEvent of await market.ingest(event, clock(), seen)) {
                  // Only fresh events reach a strategy: a replayed backlog is history, not a signal.
                  if (clock() - strategyEvent.at > 120_000) continue;
                  if (!loaded.meta.events.includes(strategyEvent.type)) continue;
                  await runStrategy("onEvent", snapshot, strategyEvent);
                }
              }
            }
          } catch (error) {
            log("events.failed", { reason: String((error as Error).message).slice(0, 200) });
          }
        }
      }
      if (book.unresolved.length > 0 && now >= nextUnresolvedCheck) {
        nextUnresolvedCheck = now + (deps.unresolvedCheckMs ?? 15_000);
        await resolvePending().catch((error: unknown) => log("unresolved.check.failed", { reason: String((error as Error).message) }));
      }
      if (now >= nextTick) {
        nextTick = now + tickMs();
        try {
          const balanceWei = await chain.balance(wallet);
          walletState = { ...walletState, balanceWei };
          bnbUsd = await chain.bnbUsd(now).catch(() => bnbUsd);
          const marks = await market.marks(book);
          book = withEquity(book, marks);
          const view = bookView(book, undefined, now);
          if (view.drawdownWei >= bnbToWei(agent.limits.maxDrawdownBnb)) halt(`L8: the agent is ${weiToBnb(view.drawdownWei)} BNB below its peak; the limit is ${agent.limits.maxDrawdownBnb} BNB`);
          enqueue(
            backstopExits(
              Object.entries(book.positions).map(([k, p]) => ({ coin: p.coin, costWei: p.costWei, coins: p.coins, markWei: marks[k] ?? null, ownLaunch: p.ownLaunch })),
              agent.limits,
              now,
            ),
          );
          // The strategy on its own tick: a prompt agent's autopilot only while it is on (one that keeps its exits, standing
          // by too, with no board), a preset's or a script's every tick.
          const asks = !warming && (agent.track !== "prompt" || ((autopilotOn || keepsExits) && now >= nextStrategyTick));
          if (asks) {
            if (agent.track === "prompt") nextStrategyTick = now + agent.tickSeconds * 1_000;
            const board = needBoard() && (agent.track !== "prompt" || autopilotOn);
            if (feed && board) await feed.prepareBoard(now);
            const snapshot = await market.snapshot({ now, balanceWei, limits: agent.limits, book, marks, warmup: warmup(), watch: watchList(), feast, needBoard: board, stale: feed?.stale() ?? null });
            await runStrategy("onTick", snapshot);
          } else save();
          tickFails = 0;
        } catch (error) {
          const reason = String((error as Error).message).slice(0, 300);
          tickFails += 1;
          log("tick.failed", { reason, inARow: tickFails });
          // Three in a row is told, once a streak (addendum 8): until then a passing RPC hiccup is the log's.
          if (tickFails === 3) notify("failure", `the loop's pass (balance, marks, exits) failed 3 times in a row: ${reason.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 160)}; it keeps trying, and its exits wait for a pass that works`);
        }
      }
      if (!signedOut && pastEnd(session, now)) {
        // The sign-in's known end passed between two wallet reads: ask the wallet now, before any trade can fail.
        await preflight();
        nextPreflight = now + (deps.preflightMs ?? 300_000);
      }
      if (signedOut && queue.length > 0) {
        // Signed out (PLAN-941 §7): nothing is asked of the wallet. Buys lapse at their expiry; sales wait for the next scan.
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          const held = queue[i]!;
          if (held.kind === "buy" && held.expiresAt !== undefined && now > held.expiresAt) {
            settle(held, { outcome: "stale", kind: held.kind, signedOut: true });
            log("intent.stale", { id: held.id, reason: held.reason, signedOut: true });
            queue.splice(i, 1);
            report(held.id);
          }
        }
        await rest();
        continue;
      }
      const next = queue.shift();
      if (next) {
        if (!stopReason(deps.home, deps.name)) await processIntent(next);
        report(next.id);
        continue;
      }
      await rest();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      dropQueued?.(`the runtime stopped on an error: ${reason.slice(0, 200)}`);
    } catch {
      // The outcome lines are best effort on the way out.
    }
    return { exit: "error", reason };
  } finally {
    loaded?.stop();
    lock.release();
    rmSync(paths.pid, { force: true });
    rmSync(`${paths.pid}.boot`, { force: true });
  }
}

/** What `feast-league status` shows: the book, the limits, and what the user has not seen yet. */
export function statusOf(home: string, name: string): { agent: AgentConfig | null; book: Book | null; notifications: unknown[]; stop: string | null; running: boolean } {
  const paths = agentPaths(home, name);
  const agent = loadAgent(home, name);
  const book = existsSync(paths.state) ? parseBook(readFileSync(paths.state, "utf8")) : null;
  const notifications = existsSync(paths.notifications)
    ? readFileSync(paths.notifications, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-20)
        .map((line) => JSON.parse(line) as unknown)
    : [];
  // Under a sandboxed host the probe may answer EPERM for a live runtime: that is running, not gone (task 975).
  // A pid file written under another boot names whatever process has that pid now (addendum 8): not running.
  const running = existsSync(paths.pid) && pidAlive(Number(readFileSync(paths.pid, "utf8").trim())) && !otherBoot(readJson<{ boot?: unknown }>(`${paths.pid}.boot`)?.boot);
  return { agent, book, notifications, stop: stopReason(home, name), running };
}

export type { Limits };
