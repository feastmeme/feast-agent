import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Address, Hex } from "viem";

import { MAINNET, type FeastNetwork } from "../sdk/networks.ts";
import { loadAgent, type AgentConfig } from "./agent.ts";
import { sha256Of } from "./audit/static.ts";
import { auditRefusal } from "./audit/verdict.ts";
import { BawError, type Signer } from "./baw.ts";
import { bookView, emptyBook, markArmed, parseBook, positionOf, recordBuy, recordClaim, recordFailure, recordGas, recordRefusal, recordSell, serializeBook, withEquity, type Book } from "./book.ts";
import { DEFAULT_MAINNET_RPC, LeagueChain } from "./chain.ts";
import { IndexerPoller } from "./events.ts";
import { Executor } from "./executor.ts";
import { backstopExits } from "./exits.ts";
import { guard, warmupActive, warmupAfter, type GuardInput, type GuardVerdict, type Intent, type WalletState } from "./guard.ts";
import { WARMUP_SIZE_BNB, WARMUP_TRADES, bnbToWei, resolveLimits, weiToBnb, type Limits } from "./limits.ts";
import { Market } from "./market.ts";
import { presetStrategy } from "./presets/logic.ts";
import { ScriptSandbox } from "./script/sandbox.ts";
import { addToLedger, acquireWalletLock, agentPaths, appendJsonl, readJson, readLedger, stopReason, writeFileAtomic, writeJsonAtomic, writeStop } from "./store.ts";
import { makeApi, normalizeIntent, type IntentRequest, type Meta, type PresetExtras, type Snapshot, type StrategyEvent } from "./strategy.ts";

/**
 * The runtime (PLAN.md §2): one process per wallet, no model anywhere in it.
 *
 * Every second it checks the stop files and its inbox; every 2 s it polls the
 * indexer's event stream when the strategy listens for events; on its tick it
 * refreshes the snapshot, makes the runtime's own exits (the backstop L6, the
 * drawdown halt L8) and asks the strategy. Every intent then takes one road:
 * the guard, the executor (allowlist, lock, preview, gate, execute, receipt),
 * the book. One at a time, exits first.
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
  loopMs?: number;
  pollMs?: number;
  preflightMs?: number;
};

type Loaded = {
  meta: Meta;
  params: Record<string, unknown>;
  /** Coins to mark fresh from the chain in the next snapshot, besides meta.watch. */
  wants(state: Record<string, unknown>): string[];
  call(fn: "onTick" | "onEvent", snapshot: Snapshot, state: Record<string, unknown>, event?: StrategyEvent): Promise<{ intents: Intent[]; problems: string[]; logs: string[]; state: Record<string, unknown> }>;
  stop(): void;
};

const PRIORITY: Record<Intent["kind"], number> = { sell: 0, arm: 1, claim: 2, launch: 3, buy: 4 };

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
  const checked = resolveLimits(agent.limits);
  if (!checked.ok) return { exit: "refused", reason: `the agent's limits do not validate: ${checked.errors.join("; ")}` };
  const atStart = stopReason(deps.home, deps.name);
  if (atStart) return { exit: "refused", reason: `a stop file is present (${atStart}); \`feast-league resume\` removes it` };
  if (agent.track === "script") {
    const why = auditRefusal(deps.home, agent.script!.path);
    if (why) return { exit: "refused", reason: why };
    const now = readFileSync(agent.script!.path, "utf8");
    if (sha256Of(now) !== agent.script!.sha256) return { exit: "refused", reason: "the script changed since it was planned: plan and audit it again" };
  }

  let lock: { release: () => void };
  try {
    lock = acquireWalletLock(deps.home, deps.name);
  } catch (error) {
    return { exit: "refused", reason: (error as Error).message };
  }
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.pid, String(process.pid));
  let loaded: Loaded | null = null;

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

    const chain = deps.chain ?? new LeagueChain(network, rpcUrl);
    const executor = new Executor({ signer: deps.signer, chain, wallet, network, rpcUrl, stopReason: () => stopReason(deps.home, deps.name), log, now: clock });
    const market = new Market(chain, { indexer: deps.indexer, fetch: deps.fetch, log });

    // --- the wallet's state (L16) ------------------------------------------------------------
    const wallet0: WalletState = { connected: false, devMode: false, quotaLeftUsd: 0, balanceWei: 0n };
    let walletState = wallet0;
    let bnbUsd = 0;
    const expiryWarned = new Set<string>();
    const preflight = async (): Promise<void> => {
      try {
        const status = await deps.signer.status();
        const settings = await deps.signer.settings();
        const now = clock();
        const devExpires = settings.devModeExpiresAt === null ? null : settings.devModeExpiresAt * 1_000;
        const devMode = settings.devModeEnabled && (devExpires === null || devExpires > now) && !settings.balanceExceeded;
        const quotaLeftUsd = (settings.devModeDailyLimitUsd ?? Number.POSITIVE_INFINITY) - (settings.devModeQuotaUsedUsd ?? 0);
        walletState = { ...walletState, connected: status.connected, devMode, quotaLeftUsd };
        if (settings.balanceExceeded) notify("devmode", "the wallet's balance is above its Developer Mode daily limit: Developer Mode will not sign, not even an exit. Raise the limit in the Binance App or move funds.", {}, "balance-exceeded");
        if (!status.connected) notify("paused", "the wallet is signed out: sign in again (baw auth signin) and the agent resumes", {}, "signed-out");
        const session = settings.sessionExpireTime ? Date.parse(settings.sessionExpireTime) : Number.NaN;
        for (const hours of [6, 1]) {
          if (Number.isFinite(session) && session - now < hours * 3_600_000 && !expiryWarned.has(`s${hours}`)) {
            expiryWarned.add(`s${hours}`);
            notify("session", `the wallet's session ends in under ${hours} h (${settings.sessionExpireTime}): sign in again before then`);
          }
        }
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

    // --- the book and the strategy --------------------------------------------------------
    let book: Book = existsSync(paths.state) ? parseBook(readFileSync(paths.state, "utf8")) : emptyBook();
    if (agent.track === "script" && book.warmup?.sha !== agent.script!.sha256) book = { ...book, warmup: { sha: agent.script!.sha256, trades: 0, consecutiveFailures: 0, launches: 0 } };
    const statePath = join(paths.dir, "strategy-state.json");
    const stored = readJson<{ key: string; state: Record<string, unknown> }>(statePath);
    const stateKey = agent.track === "script" ? agent.script!.sha256 : `preset:${agent.preset}`;
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

    const extras: PresetExtras = {
      claimAndBuyBack: (coin: Address, options) => {
        const intent: Intent = { id: `claim-${clock()}`, kind: "claim", coin, reason: options.reason, source: "preset", createdAt: clock(), claim: { buybackPct: options.buybackPct, minClaimBnb: options.minClaimBnb } };
        enqueue([intent]);
        return intent.id;
      },
    };

    if (agent.track === "preset") {
      const strategy = presetStrategy(agent.preset!);
      const presetAgent = agent;
      loaded = {
        meta: { ...strategy.meta, tickSeconds: presetAgent.tickSeconds },
        params: presetAgent.params,
        wants: (state) => strategy.wants?.(state) ?? [],
        async call(fn, snapshot, state, event) {
          const ttl = fn === "onEvent" ? 30_000 : presetAgent.tickSeconds * 1_000;
          const logs: string[] = [];
          const { api, intents, problems } = makeApi(snapshot, { params: presetAgent.params, state, source: "preset", ttlMs: ttl, log: (t) => logs.push(t) });
          if (fn === "onEvent" && event) strategy.onEvent?.(api, event, extras);
          else strategy.onTick(api, extras);
          return { intents, problems, logs, state };
        },
        stop() {},
      };
    } else {
      const sandbox = await ScriptSandbox.start(readFileSync(agent.script!.path, "utf8"));
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
    const refused = (intent: Intent, verdict: Extract<GuardVerdict, { ok: false }>) => {
      book = recordRefusal(book);
      log("intent.refused", { id: intent.id, kind: intent.kind, limit: verdict.limit, message: verdict.message, halt: verdict.halt });
      notify("refused", `${verdict.limit}: ${verdict.message}`, { limit: verdict.limit }, `refused:${verdict.limit}`);
      if (verdict.halt) halt(`${verdict.limit === "W" ? "warm-up" : verdict.limit}: ${verdict.message}`);
      save();
    };
    const failed = (intent: Intent, stage: string, reason: string, txHash?: Hex) => {
      if (stage === "stopped" || stage === "busy") {
        log("intent.dropped", { id: intent.id, stage, reason });
        return;
      }
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
        walletSpentWei: readLedger(deps.home).spentWei,
        claimFundsWei: book.claimFundsWei,
        warmup: agent!.track === "script" ? book.warmup : null,
      };
      const verdict = guard(input);
      if (!verdict.ok) return refused(intent, verdict);
      if (verdict.forced) log("warmup.forced", { id: intent.id, forced: verdict.forced });
      const approved = verdict.intent;

      if (approved.kind === "buy") {
        const coin = approved.coin!;
        const payIn = approved.payIn ?? "native";
        const amount = payIn === "quote" ? approved.quoteAmount ?? 0n : verdict.sizeWei!;
        const prepared = await executor.prepareBuy(coin, amount, approved.slippagePct!, payIn);
        if (!prepared.ok) return failed(approved, "prepare", prepared.reason);
        const again = guard({ ...input, impactPct: prepared.value.impactPct });
        if (!again.ok) return refused(approved, again);
        log("buy.prepared", { id: approved.id, coin, sizeWei: prepared.value.sizeWei, payIn, quotedOut: prepared.value.quotedOut, minOut: prepared.value.minOut, impactPct: prepared.value.impactPct });
        const sent = await executor.send(`buy ${prepared.value.info.symbol}`, prepared.value.call);
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
        if (!position) return log("sell.nothing", { id: approved.id, coin });
        if (!position.armed && !(await arm(coin, approved))) return;
        const coins = (position.coins * BigInt(Math.round((approved.fraction ?? 1) * 1_000_000))) / 1_000_000n;
        const prepared = await executor.prepareSell(coin, coins, approved.slippagePct!);
        if (!prepared.ok) return failed(approved, "prepare", prepared.reason);
        log("sell.prepared", { id: approved.id, coin, coinsIn: prepared.value.coinsIn, quotedOut: prepared.value.quotedOut, minOut: prepared.value.minOut, quotedBy: prepared.value.quotedBy });
        const sent = await executor.send(`sell ${prepared.value.info.symbol}`, prepared.value.call);
        if (!sent.ok) return failed(approved, sent.stage, sent.reason, sent.txHash);
        const fills = executor.verifySell(sent.receipt, prepared.value);
        if (!fills.ok) {
          failed(approved, "mismatch", fills.reason, sent.txHash);
          return halt(`receipt mismatch on ${sent.txHash}: ${fills.reason}`);
        }
        book = recordSell(book, { coin, coinsIn: fills.coinsIn, bnbOutWei: fills.bnbOutWei, gasWei: sent.gasWei, at: clock() });
        traded();
        log("sell.filled", { id: approved.id, txHash: sent.txHash, coin, coinsIn: fills.coinsIn, bnbOutWei: fills.bnbOutWei, gasWei: sent.gasWei, payerIsWallet: true });
        notify("trade", `sold ${prepared.value.info.symbol} for ${weiToBnb(fills.bnbOutWei)} BNB (${sent.txHash})`, { txHash: sent.txHash });
        return save();
      }

      if (approved.kind === "arm") {
        await arm(approved.coin!, approved);
        return;
      }

      if (approved.kind === "launch") {
        const prepared = await executor.prepareLaunch({ ...approved.launch!, quote: approved.launch!.quote });
        if (!prepared.ok) return failed(approved, "prepare", prepared.reason);
        const sent = await executor.send(`launch ${approved.launch!.symbol}`, prepared.value.call);
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
        const sent = await executor.send("claim the creator's share", prepared.value.call);
        if (!sent.ok) return failed(approved, sent.stage, sent.reason, sent.txHash);
        const paid = executor.verifyClaim(sent.receipt);
        const paidBnb = await chain.quoteToBnbWei(prepared.value.quote, paid);
        book = recordClaim(book, paidBnb, sent.gasWei);
        log("claim.paid", { id: approved.id, txHash: sent.txHash, quoteAmount: paid, valueWei: paidBnb });
        save();
        const share = BigInt(Math.round(approved.claim?.buybackPct ?? 0));
        const quoteAmount = (paid * share) / 100n;
        if (quoteAmount > 0n && (await arm(prepared.value.quote, approved))) {
          const bnb = weiToBnb((paidBnb * share) / 100n);
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
        let request: { type?: string; request?: IntentRequest; slippagePct?: number } | null = null;
        try {
          request = JSON.parse(readFileSync(full, "utf8"));
        } catch {
          request = null;
        }
        rmSync(full, { force: true });
        if (request?.type === "intent" && request.request) {
          const slippage = typeof request.slippagePct === "number" ? request.slippagePct : Math.min(3, agent!.limits.maxSlippagePct);
          const normal = normalizeIntent(request.request, { snapshot: { feast, now: clock(), limits: agent!.limits }, source: "manual", slippagePct: slippage, ttlMs: 120_000 });
          if ("error" in normal) log("inbox.refused", { problem: normal.error });
          else enqueue([normal.intent]);
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
    const tickMs = () => agent!.tickSeconds * 1_000;
    const listens = (loaded.meta.events ?? []).length > 0;
    const poller = listens ? new IndexerPoller({ base: deps.indexer, fetch: deps.fetch }) : null;
    if (poller) await poller.start().catch((error: unknown) => log("events.start.failed", { reason: String((error as Error).message) }));
    let nextPoll = 0;
    let nextTick = 0;
    let nextPreflight = clock() + (deps.preflightMs ?? 300_000);
    const watched = () => new Set([...Object.keys(book.positions), ...loaded!.meta.watch.map((w) => (w.toUpperCase() === "FEAST" ? feast.toLowerCase() : w.toLowerCase()))]);
    if (deps.only) {
      for (const request of deps.only) {
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
    log("started", { track: agent.track, preset: agent.preset, tickSeconds: agent.tickSeconds, events: loaded.meta.events, warmup: warmup() });
    notify("started", `${agent.track === "preset" ? `preset ${agent.preset}` : "script"} running; tick ${agent.tickSeconds} s${warmup() ? `; warm-up: ${warmup()!.remaining} trades at ${warmup()!.sizeBnb} BNB` : ""}`);
    save();

    for (;;) {
      const now = clock();
      const stop = stopReason(deps.home, deps.name);
      if (stop) {
        log("halted", { reason: stop });
        notify("halted", `stopped: ${stop}`);
        save();
        return { exit: existsSync(paths.stop) && readFileSync(paths.stop, "utf8").trim() !== "stop requested by the user" ? "halted" : "stopped", reason: stop };
      }
      if (deps.maxRuntimeMs !== undefined && now - startedAt >= deps.maxRuntimeMs) {
        log("finished", { afterMs: now - startedAt });
        save();
        return { exit: "finished", reason: "the run's time is up" };
      }
      drainInbox();
      if (now >= nextPreflight) {
        await preflight();
        nextPreflight = now + (deps.preflightMs ?? 300_000);
      }
      if (poller && now >= nextPoll) {
        nextPoll = now + (deps.pollMs ?? 2_000);
        try {
          const events = await poller.poll();
          if (events.length > 0) {
            const marks = await market.marks(book);
            const balanceWei = await chain.balance(wallet).catch(() => walletState.balanceWei);
            const snapshot = await market.snapshot({ now: clock(), balanceWei, limits: agent.limits, book, marks, warmup: warmup(), watch: [...loaded.meta.watch, ...loaded.wants(strategyState)], feast, needBoard: false });
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
          // The board (every coin's market row) only for the strategies that read it: a DCA on FEAST alone does not.
          const needBoard = agent.track === "script" || agent.preset === "momentum" || (agent.preset === "dca" && agent.params.targets === "topHolders");
          const snapshot = await market.snapshot({ now, balanceWei, limits: agent.limits, book, marks, warmup: warmup(), watch: [...loaded.meta.watch, ...loaded.wants(strategyState)], feast, needBoard });
          await runStrategy("onTick", snapshot);
        } catch (error) {
          log("tick.failed", { reason: String((error as Error).message).slice(0, 300) });
        }
      }
      const next = queue.shift();
      if (next) {
        if (!stopReason(deps.home, deps.name)) await processIntent(next);
        continue;
      }
      await sleep(deps.loopMs ?? 1_000);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exit: "error", reason };
  } finally {
    loaded?.stop();
    lock.release();
    rmSync(paths.pid, { force: true });
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
  let running = false;
  if (existsSync(paths.pid)) {
    try {
      process.kill(Number(readFileSync(paths.pid, "utf8")), 0);
      running = true;
    } catch {
      running = false;
    }
  }
  return { agent, book, notifications, stop: stopReason(home, name), running };
}

export type { Limits };
