import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { confirmAgent, loadAgent, saveAgent, type AgentConfig } from "../agent.ts";
import type { Signer } from "../baw.ts";
import type { Book } from "../book.ts";
import type { AgentIdRead, CoinInfo, LeagueChain } from "../chain.ts";
import { refuseEarly } from "../early.ts";
import { INDEXER_URL } from "../events.ts";
import { DEFAULT_LIMITS, resolveLimits } from "../limits.ts";
import { BODY_COIN_QUOTE, BODY_COIN_SPLIT, bodyCoinNames, launchesBy } from "../register/claims.ts";
import { agentIdUnreadable, launchCard, launchedLine, noAgentIdCard, walletNotReady, type Lang } from "../register/copy.ts";
import { readLeagueRecord, readWallet, type WalletRead } from "../register/flow.ts";
import { AGENT_ID } from "../register/message.ts";
import type { LeagueSite } from "../register/site.ts";
import { runAgent, statusOf, type RunOutcome } from "../runtime.ts";
import { agentPaths, appendJsonl, readJson, walletLockHolder, writeJsonAtomic } from "../store.ts";
import type { IntentRequest } from "../strategy.ts";
import { AVATAR_MAX_BYTES, BODY_SINCE, BUFFER, ENTRY_AGENT, ENTRY_USDT, PENDING_MAX_AGE_MS, STEP1_OPEN } from "./constants.ts";
import * as copy from "./copy.ts";

/**
 * `FL enter --name <id>.ai` (task 961): the league entry, once. Read the wallet
 * and its Agent ID, ask feast.meme whether it may enter, launch the body coin
 * with the league's picture (unless the wallet launched one since 10/23), then
 * buy today's coin for 5 USDT worth of BNB. It never starts a trading loop and
 * never touches another agent: the launch and the buy go through the runtime's
 * one-shot, under `league-entry`'s own agent and the default hard limits.
 *
 * Each stage is a card. A run without --yes prints the next card and leaves it
 * pending; a run with --yes acts on that one card only if it was printed in
 * the last 10 minutes and nothing on it changed, then prints the next. Every
 * dependency is injected, so a test runs the whole entry against fakes.
 */

export type EnterChain = {
  agentIdOf(wallet: Address): Promise<AgentIdRead>;
  creatorOf(coin: Address): Promise<Address | null | "unreadable">;
  coinInfo(coin: Address): Promise<CoinInfo | null>;
  isFeastCoin(coin: Address): Promise<boolean>;
  bnbUsd(now?: number): Promise<number>;
};

/** What a one-shot run of league-entry did, read back from its book and its log. */
export type OneShotResult = {
  exit: RunOutcome["exit"];
  reason: string;
  launched: { coin: Address; txHash: Hex | null } | null;
  bought: { coin: Address; txHash: Hex; bnbWei: bigint } | null;
  /** The last refusal or failure of the run, for the user. */
  failure: string | null;
  /** A launch or a buy was sent and its outcome is not known yet (the runtime keeps it, and asks again on the next run). */
  unresolved?: boolean;
};

/** The runtime's one-shot for league-entry: these requests and what follows from them (an arm after a buy), then exit. No requests: only ask about earlier outcomes not known. */
export type OneShot = (requests: IntentRequest[]) => Promise<OneShotResult>;

export type EnterDeps = {
  home: string;
  signer: Pick<Signer, "status" | "settings" | "address">;
  chain: EnterChain;
  site: LeagueSite;
  indexer?: string;
  /** The indexer's fetch (tests pass a fake). */
  fetch?: typeof fetch;
  now?: () => number;
  oneShot: OneShot;
};

export type EnterInput = { name: string | undefined; yes: boolean; lang: Lang };

export type EnterResult = { code: 0 | 1 | 2; ok: boolean; stage: string; data: Record<string, unknown>; text: string };

export type EntryRecord = {
  agentId: string;
  bodyCoin: Address | null;
  launchTx: Hex | null;
  buy: { coin: Address; txHash: Hex; bnb: number; usdtAtBuy: number; at: string } | null;
};

type Pending = { stage: "launch" | "buy"; digest: string; at: string; coin?: Address; bnb?: number };

const ID_NAME = /^([a-z0-9]{1,64})(\.ai)?$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The entry's size in BNB: 5.10 USDT at this price, rounded up to the micro-BNB (a float's 8500.000000001 is 8500). */
export function entryBnb(bnbUsd: number): number {
  const micro = (ENTRY_USDT * BUFFER * 1e6) / bnbUsd;
  const near = Math.round(micro);
  return (Math.abs(micro - near) < 1e-6 ? near : Math.ceil(micro)) / 1e6;
}

/** league-entry as `FL enter` writes it: no strategy, the default limits, never started as a loop. */
export function entryAgent(now = new Date()): AgentConfig {
  const limits = resolveLimits({});
  if (!limits.ok) throw new Error(limits.errors.join("; "));
  return { version: 1, name: ENTRY_AGENT, track: "entry", preset: null, script: null, params: {}, given: [], limits: limits.limits, tickSeconds: 3_600, sentence: null, createdAt: now.toISOString(), confirmed: null };
}

const sameLimits = (a: unknown) => JSON.stringify(a) === JSON.stringify(DEFAULT_LIMITS);
const isEntryAgent = (a: AgentConfig) => a.track === "entry" && a.preset === null && a.script === null && sameLimits(a.limits) && (a.confirmed === null || sameLimits(a.confirmed.limits));

export function entryPaths(home: string) {
  const dir = agentPaths(home, ENTRY_AGENT).dir;
  return { dir, entry: join(dir, "entry.json"), pending: join(dir, "pending.json"), avatar: join(dir, "avatar.png") };
}

export const readEntry = (home: string) => readJson<EntryRecord>(entryPaths(home).entry);

const qualifies = (buy: EntryRecord["buy"]) => buy !== null && buy.usdtAtBuy >= ENTRY_USDT && Date.parse(buy.at) >= Date.parse(STEP1_OPEN);

/** A reason fit to print: the first line, no URL (an RPC URL may carry a key), cleaned. */
const reasonOf = (error: unknown) => copy.clean(String((error as Error)?.message ?? error).split("\n")[0]!.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"));

export async function enter(deps: EnterDeps, input: EnterInput): Promise<EnterResult> {
  const now = deps.now ?? Date.now;
  const lang = input.lang;
  const lines: string[] = [];
  const end = (code: 0 | 1 | 2, ok: boolean, stage: string, text: string | string[], data: Record<string, unknown> = {}): EnterResult => ({ code, ok, stage, data, text: [...lines, ...(Array.isArray(text) ? text : [text])].join("\n") });

  // --- the name, and what is already on this machine (no call to anyone) ---------------------
  if (input.name === undefined || input.name.trim() === "") return end(2, false, "name", copy.nameMissing(lang));
  const named = ID_NAME.exec(input.name.trim());
  if (!named) return end(2, false, "name", copy.nameBad(input.name, lang));
  const given = named[1]!;
  const holder = walletLockHolder(deps.home);
  if (holder) return end(2, false, "busy", copy.walletBusy(holder.agent, lang), { agent: holder.agent });
  const paths = entryPaths(deps.home);
  const stored = loadAgent(deps.home, ENTRY_AGENT);
  if (stored && !isEntryAgent(stored)) return end(2, false, "agent", copy.entryAgentChanged(lang));
  let record = readEntry(deps.home);
  if (record && record.agentId === given && record.buy && qualifies(record.buy)) {
    const buy = record.buy;
    return end(0, true, "entered", copy.alreadyEntered({ agentId: given, coin: buy.coin, txHash: buy.txHash, atMs: Date.parse(buy.at) }, lang), { agentId: given, bodyCoin: record.bodyCoin, buy });
  }

  // --- the wallet and its Agent ID ------------------------------------------------------------
  let read: WalletRead;
  try {
    read = await readWallet(deps.signer, deps.chain);
  } catch (error) {
    return end(1, false, "wallet", copy.walletReadFailed(reasonOf(error), lang));
  }
  if (read.kind === "not-ready") return end(2, false, "wallet", walletNotReady(read.reason, lang), { result: read.reason });
  if (read.kind === "no-agent-id") return end(2, false, "agent-id", noAgentIdCard(lang), { result: "no-agent-id" });
  if (read.kind === "agent-id-unreadable") return end(1, false, "agent-id", agentIdUnreadable(lang), { result: "agent-id-unreadable" });
  const { wallet, agentId } = read;
  if (agentId !== given) return end(2, false, "agent-id", copy.nameMismatch(agentId, input.name.trim(), lang), { agentId });
  if (record && record.agentId !== agentId) return end(2, false, "agent-id", copy.foreignHome(record.agentId, agentId, lang));
  // Defense in depth: no line this entry writes may carry the wallet's address.
  const scrub = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).split(wallet).join("self").split(wallet.toLowerCase()).join("self"));
  const log = (event: string, fields: Record<string, unknown> = {}) => appendJsonl(agentPaths(deps.home, ENTRY_AGENT).log, scrub({ at: new Date(now()).toISOString(), event, ...fields }));

  // --- eligibility ----------------------------------------------------------------------------------
  const page = await deps.site.agentIdOnPage(wallet);
  if (page.state === "unavailable") return end(1, false, "eligibility", copy.siteUnreadable(page.reason, lang));
  if (page.state === "unreadable") return end(2, false, "eligibility", copy.notEligible("unreadable", page.reason, lang));
  if (page.wallet !== wallet.toLowerCase()) return end(2, false, "eligibility", copy.notEligible("wallet", null, lang));
  if (page.agentId === null) return end(2, false, "eligibility", copy.notEligible("no-agent-id", null, lang));
  if (page.agentId !== agentId) return end(2, false, "eligibility", copy.notEligible("differs", page.agentId, lang));

  // --- outcomes an earlier run could not learn -------------------------------------------------
  const book = (): Book | null => statusOf(deps.home, ENTRY_AGENT).book;
  const open = () => book()?.unresolved.find((u) => u.kind === "launch" || u.kind === "buy") ?? null;
  if (open()) {
    // Only asked about: the one-shot with no request learns what it can, and sends nothing.
    await deps.oneShot([]);
    const still = open();
    if (still) return end(1, false, "unresolved", copy.pendingOutcome(still.kind, lang), { kind: still.kind, txHash: still.txHash });
  }

  let agent = stored ?? entryAgent(new Date(now()));
  if (!stored) saveAgent(deps.home, agent);
  const confirm = () => {
    if (!agent.confirmed) {
      agent = confirmAgent(agent, new Date(now()));
      saveAgent(deps.home, agent);
      log("enter.confirmed", { agentId });
    }
  };
  const pendingNow = (): Pending | null => {
    const p = readJson<Pending>(paths.pending);
    if (!p || typeof p.at !== "string") return null;
    const at = Date.parse(p.at);
    return Number.isFinite(at) && now() - at <= PENDING_MAX_AGE_MS && at <= now() + 60_000 ? p : null;
  };
  /** The card stays pending for the user's yes: exit 2. With a --yes that did not match, say so first. */
  const ask = (stage: "launch" | "buy", digest: string, card: string, data: Record<string, unknown>, extra: Partial<Pending> = {}, consumed = false): EnterResult => {
    writeJsonAtomic(paths.pending, { stage, digest, at: new Date(now()).toISOString(), ...extra } satisfies Pending);
    log("enter.card", { stage, digest });
    const parts = input.yes && !consumed ? [copy.cardChanged(lang), "", card] : [card];
    return end(2, true, `${stage}-card`, [...parts, "", copy.needsYes(lang)], { ...data, digest });
  };
  const yesFor = (stage: "launch" | "buy", digest: string) => {
    if (!input.yes) return false;
    const p = pendingNow();
    return p !== null && p.stage === stage && p.digest === digest;
  };

  // --- the body coin --------------------------------------------------------------------------------
  let body: { coin: Address; symbol: string | null } | null = null;
  let consumed = false;
  const launched = book()?.launched ?? null;
  if (launched) body = { coin: launched.coin, symbol: await symbolOf(deps.chain, launched.coin) };
  else {
    const found = await bodyCoinSince(wallet, deps);
    if (found === "unreadable") return end(1, false, "body-coin", copy.launchCheckUnreadable(lang));
    if (found) body = { coin: found, symbol: await symbolOf(deps.chain, found) };
  }

  if (body) {
    lines.push(copy.alreadyLaunched(body.symbol, body.coin, lang));
    if (!record || record.bodyCoin === null) {
      record = { agentId, bodyCoin: body.coin, launchTx: launched?.txHash ?? null, buy: record?.buy ?? null };
      writeJsonAtomic(paths.entry, record);
    }
  } else {
    const names = bodyCoinNames(agentId);
    const description = readLeagueRecord(deps.home)?.manifesto?.trim().slice(0, 280) || null;
    const picture = await leaguePicture(deps.site, agentId, paths.avatar);
    const facts = { stage: "launch", agentId, name: names.name, symbol: names.symbol, quote: BODY_COIN_QUOTE, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, description, picture: picture.source === "league" ? picture.sha256 : "ticker" };
    const digest = sha256(JSON.stringify(facts));
    const card = launchCard({ agentId, name: names.name, symbol: names.symbol, quote: BODY_COIN_QUOTE, description, picture: picture.source === "league" ? "league" : "ticker-fallback" }, lang);
    const shown = { ...names, quote: BODY_COIN_QUOTE, description, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, picture: picture.source === "league" ? { source: "league", sha256: picture.sha256 } : { source: "ticker", reason: picture.reason } };
    const notice = picture.source === "ticker" ? [copy.avatarFallback(picture.reason, lang), ""] : [];
    const request: IntentRequest = { kind: "launch", name: names.name, symbol: names.symbol, quote: BODY_COIN_QUOTE, description: description ?? undefined, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, reason: "the league entry's body coin", ...(picture.source === "league" ? { image: { path: paths.avatar, sha256: picture.sha256 } } : {}) };
    // The limits that need no wallet are read before the card, so a yes is never asked for a launch they refuse.
    const early = refuseEarly(deps.home, agent, request, now());
    if (early) return end(2, false, "limits", copy.refusedLine(early.limit, early.message, lang), { refused: early });
    if (!yesFor("launch", digest)) return ask("launch", digest, [...notice, card].join("\n"), shown);

    // The user's yes on this card confirms league-entry, and the one launch goes through its limits.
    confirm();
    rmSync(paths.pending, { force: true });
    log("enter.launch", { symbol: names.symbol, picture: facts.picture });
    const result = await deps.oneShot([request]);
    if (!result.launched && result.unresolved) return end(1, false, "unresolved", copy.pendingOutcome("launch", lang), { kind: "launch" });
    if (!result.launched) return end(result.exit === "error" ? 1 : 2, false, "launch", copy.launchFailed(result.failure ?? `${result.exit}: ${result.reason}`, lang), { exit: result.exit });
    body = { coin: result.launched.coin, symbol: names.symbol };
    record = { agentId, bodyCoin: body.coin, launchTx: result.launched.txHash, buy: null };
    writeJsonAtomic(paths.entry, record);
    lines.push(launchedLine(names.symbol, body.coin, result.launched.txHash, lang), "");
    consumed = true;
  }

  // --- today's coin -----------------------------------------------------------------------------------
  const open1 = Date.parse(STEP1_OPEN);
  if (now() < open1) return end(0, true, "wait", copy.beforeStep1(open1, lang), { bodyCoin: body.coin, retryAt: new Date(open1).toISOString() });
  const assignment = await deps.site.assignment(wallet);
  const wait = (what: copy.Wait, reason: string | null, minutes: number, extra: Record<string, unknown>) => {
    const at = now() + minutes * 60_000;
    return end(0, true, "wait", copy.comeBack(what, reason, at, lang), { bodyCoin: body!.coin, waiting: what, retryAt: new Date(at).toISOString(), ...extra });
  };
  if (assignment.kind === "missing") return wait("missing", null, 60, { status: assignment.status });
  if (assignment.kind === "unreadable") return end(1, false, "assignment", copy.assignmentUnreadable(assignment.reason, lang));
  if (assignment.kind === "status") {
    const minutes = { "not-registered": 10, "before-cutoff": 5, "no-table": 60 }[assignment.status];
    return wait(assignment.status, assignment.reason, minutes, { day: copy.clean(assignment.day), reason: copy.clean(assignment.reason) });
  }
  const bad = (why: copy.BadRow) => end(1, false, "assignment", copy.badRow(why, lang), { problem: why });
  if (assignment.wallet.toLowerCase() !== wallet.toLowerCase()) return bad("wallet");
  if (!isAddress(assignment.coin, { strict: false })) return bad("address");
  const coin = getAddress(assignment.coin);
  if (coin.toLowerCase() === body.coin.toLowerCase()) return bad("own-coin");
  let feast: boolean;
  try {
    feast = await deps.chain.isFeastCoin(coin);
  } catch {
    return bad("unchecked");
  }
  if (!feast) return bad("not-feast");
  const symbol = copy.SAFE_SYMBOL.test(assignment.symbol) ? assignment.symbol : null;

  let bnbUsd: number;
  try {
    bnbUsd = await deps.chain.bnbUsd(now());
    if (!(Number.isFinite(bnbUsd) && bnbUsd > 0)) throw new Error("no price");
  } catch {
    return end(1, false, "price", copy.priceUnreadable(lang));
  }
  // The amount on a card the user was just shown stays while it still buys 5 USDT, so a price that moved a little is no new card.
  const before = pendingNow();
  const kept = before?.stage === "buy" && before.coin === coin && typeof before.bnb === "number" && before.bnb * bnbUsd >= ENTRY_USDT ? before.bnb : null;
  const bnb = kept ?? entryBnb(bnbUsd);
  const slippagePct = Math.min(3, agent.limits.maxSlippagePct);
  const request: IntentRequest = { kind: "buy", coin, bnb, reason: "the league entry: today's coin" };
  const early = refuseEarly(deps.home, agent, request, now());
  if (early) return end(2, false, "limits", copy.refusedLine(early.limit, early.message, lang), { refused: early, coin, bnb });
  const facts = { stage: "buy", agentId, coin, symbol, bnb, slippagePct, approvals: 2 };
  const digest = sha256(JSON.stringify(facts));
  const card = copy.buyCard({ agentId, coin, symbol, bnb, usdt: bnb * bnbUsd, slippagePct, maxTradeBnb: agent.limits.maxTradeBnb, budgetBnb: agent.limits.budgetBnb, maxDailySpendBnb: agent.limits.maxDailySpendBnb }, lang);
  const shown = { bodyCoin: body.coin, coin, symbol, day: copy.clean(assignment.day), source: copy.clean(assignment.source), bnb, usdt: Number((bnb * bnbUsd).toFixed(2)), slippagePct };
  if (consumed || !yesFor("buy", digest)) return ask("buy", digest, card, shown, { coin, bnb }, consumed);

  confirm();
  rmSync(paths.pending, { force: true });
  log("enter.buy", { coin, bnb, bnbUsd });
  const result = await deps.oneShot([request]);
  if (!result.bought && result.unresolved) return end(1, false, "unresolved", copy.pendingOutcome("buy", lang), { kind: "buy", coin });
  if (!result.bought) return end(result.exit === "error" ? 1 : 2, false, "buy", copy.buyFailed(result.failure ?? `${result.exit}: ${result.reason}`, lang), { exit: result.exit, coin });
  const buy = { coin, txHash: result.bought.txHash, bnb, usdtAtBuy: Number((bnb * bnbUsd).toFixed(6)), at: new Date(now()).toISOString() };
  writeJsonAtomic(paths.entry, { ...(record ?? { agentId, bodyCoin: body.coin, launchTx: null }), buy } satisfies EntryRecord);
  log("enter.bought", { coin, txHash: buy.txHash, bnb });
  return end(0, true, "bought", [copy.boughtLine(symbol, coin, buy.txHash, lang), copy.holdLine(lang), copy.doneLine(lang)], { bodyCoin: body.coin, buy });
}

/** A coin's ticker from the chain, cleaned; null when it is not a plain one or cannot be read. */
async function symbolOf(chain: EnterChain, coin: Address): Promise<string | null> {
  const symbol = copy.clean((await chain.coinInfo(coin).catch(() => null))?.symbol ?? "", 10);
  return copy.SAFE_SYMBOL.test(symbol) ? symbol : null;
}

/**
 * The body coin this wallet launched since BODY_SINCE, by the indexer and then the chain: the coin,
 * null for none, or "unreadable". A read either could not answer is never a "none": a second body
 * coin is the failure to avoid.
 */
async function bodyCoinSince(wallet: Address, deps: EnterDeps): Promise<Address | null | "unreadable"> {
  const options = { indexer: deps.indexer ?? INDEXER_URL, fetch: deps.fetch };
  const indexed = (await launchesBy(wallet, options)) ?? (await launchesBy(wallet, options));
  if (indexed === null) return "unreadable";
  const since = Date.parse(BODY_SINCE);
  // A launch whose time the indexer does not give may be a recent one: it cannot be ruled out.
  const candidates = indexed.filter((l) => l.launchedAt === 0 || l.launchedAt >= since).sort((a, b) => a.launchedAt - b.launchedAt);
  for (const launch of candidates) {
    const creator = await deps.chain.creatorOf(launch.coin).catch(() => "unreadable" as const);
    if (creator === "unreadable") return "unreadable";
    if (creator === null || creator.toLowerCase() !== wallet.toLowerCase()) continue;
    if (launch.launchedAt === 0) return "unreadable";
    return launch.coin;
  }
  return null;
}

type Picture = { source: "league"; sha256: string } | { source: "ticker"; reason: string };

/** The league's picture of this agent, saved for the launch when it is a PNG of at most AVATAR_MAX_BYTES; otherwise why not. */
async function leaguePicture(site: LeagueSite, agentId: string, path: string): Promise<Picture> {
  if (!AGENT_ID.test(agentId)) return { source: "ticker", reason: "no Agent ID to ask for" };
  const got = await site.avatar(agentId, AVATAR_MAX_BYTES);
  if (got.state === "unavailable") return { source: "ticker", reason: got.reason };
  const type = got.contentType.split(";")[0]!.trim().toLowerCase();
  if (got.status !== 200) return { source: "ticker", reason: `HTTP ${got.status}` };
  if (type !== "image/png") return { source: "ticker", reason: `it came as ${type || "no type"}, not image/png` };
  if (got.truncated || got.bytes.length > AVATAR_MAX_BYTES) return { source: "ticker", reason: `it is over ${AVATAR_MAX_BYTES} bytes` };
  if (got.bytes.length < PNG.length || PNG.some((b, i) => got.bytes[i] !== b)) return { source: "ticker", reason: "its bytes are not a PNG" };
  writeBytesAtomic(path, got.bytes);
  return { source: "league", sha256: sha256(got.bytes) };
}

/** Bytes through a temporary file and a rename, as every file in the home is written. */
function writeBytesAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The production one-shot: `runAgent` for league-entry, then what it did, from its book and its log. */
export function entryOneShot(options: { home: string; signer: Signer; rpcUrl?: string; chain?: LeagueChain; fetch?: typeof fetch; out?: (line: string) => void }): OneShot {
  return async (requests) => {
    const log = agentPaths(options.home, ENTRY_AGENT).log;
    const from = existsSync(log) ? statSync(log).size : 0;
    const launchedBefore = statusOf(options.home, ENTRY_AGENT).book?.launched?.coin ?? null;
    const outcome = await runAgent({ home: options.home, name: ENTRY_AGENT, signer: options.signer, rpcUrl: options.rpcUrl, chain: options.chain, fetch: options.fetch, out: options.out, only: requests });
    const after = statusOf(options.home, ENTRY_AGENT).book;
    const lines = (existsSync(log) ? readFileSync(log).subarray(from).toString("utf8") : "")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const wanted = requests.find((r) => r.kind === "buy");
    const filled = wanted ? lines.find((l) => l.event === "buy.filled" && typeof l.coin === "string" && l.coin.toLowerCase() === String(wanted.coin).toLowerCase() && typeof l.txHash === "string") : undefined;
    const last = [...lines].reverse().find((l) => l.event === "intent.failed" || l.event === "intent.refused");
    const failure = last ? (last.event === "intent.refused" ? `refused by ${String(last.limit)}: ${String(last.message)}` : `failed at ${String(last.stage)}: ${String(last.reason)}`) : null;
    return {
      exit: outcome.exit,
      reason: outcome.reason,
      launched: after?.launched && after.launched.coin !== launchedBefore ? { coin: after.launched.coin, txHash: after.launched.txHash ?? null } : null,
      bought: filled ? { coin: getAddress(String(filled.coin)), txHash: filled.txHash as Hex, bnbWei: BigInt(String(filled.bnbInWei ?? "0")) } : null,
      failure,
      unresolved: (after?.unresolved ?? []).some((u) => u.kind === "launch" || u.kind === "buy"),
    };
  };
}
