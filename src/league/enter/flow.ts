import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";

import { confirmAgent, loadAgent, saveAgent, type AgentConfig, type PlanInput } from "../agent.ts";
import type { RegistrationSigner, Signer, SignOptions, SignOutcome } from "../baw.ts";
import { renderCard } from "../card.ts";
import { backoffWait, type Retry } from "../feed/backoff.ts";
import type { Book } from "../book.ts";
import type { AgentIdRead, CoinInfo, LeagueChain } from "../chain.ts";
import { refuseEarly } from "../early.ts";
import { DEFAULT_LIMITS, resolveLimits } from "../limits.ts";
import { BODY_COIN_QUOTE, BODY_COIN_SPLIT } from "../register/claims.ts";
import { openSession, notesDev, sessionSaid, type SessionOutcome, type SessionSigner } from "../notes/session.ts";
import { agentIdUnreadable, noAgentIdCard, noAnswerLine, previewMismatch, refusalLine, seatedLine, signingLine, walletNotReady, type Lang } from "../register/copy.ts";
import { readWallet, submit, type FlowDeps, type Prepared, type WalletRead } from "../register/flow.ts";
import { AGENT_ID, joinSignature, nextIssuedAt } from "../register/message.ts";
import { bindDeadline, bindSignatureRecovers, REFERRALS_CHAIN_ID, type BindFields, type ReferralDeps } from "../register/referral.ts";
import type { KeptAgent, LeagueSite } from "../register/site.ts";
import { runAgent, statusOf, type RunOutcome } from "../runtime.ts";
import { tradingOpens } from "../season-gate.ts";
import { sessionView } from "../session.ts";
import { askChoice, autopilotChoice, prepareStart, shapeOf } from "../start.ts";
import { hostDetailHint, modelHint } from "../headers.ts";
import { agentPaths, appendJsonl, readJson, removeStop, walletLockHolder, writeJsonAtomic, writeStop } from "../store.ts";
import type { IntentRequest } from "../strategy.ts";
import { upgradeSentence, versionView } from "../version.ts";
import { keepSupport } from "../support.ts";
import { AVATAR_MAX_BYTES, ENTRY_AGENT, PENDING_MAX_AGE_MS } from "./constants.ts";
import * as copy from "./copy.ts";
import { composeMeme, hostPicture, type Meme } from "./meme.ts";
import { parseRef } from "./ref.ts";
import { ensureStrategy } from "./strategy.ts";

/**
 * `FL enter --name <id>.ai [--prompt strategy.md] [--meme "<concept>" …] [--no-start]` (tasks 961, 963, 968): one
 * command enters the league and runs the player's AI. It reads the wallet and its Agent ID, asks feast.meme
 * whether it may enter and what it keeps for this wallet, and after the user's one yes signs the site's EIP-712
 * Register message once (the road `FL register` took; no coin is needed, the owner's ruling of 2026-10-24), opens
 * the season's notes session (one more signed message), and starts the trading agent detached, waiting for the
 * season (`season-gate.ts`): it trades nothing before. Without `--prompt` it copies the season-1 default strategy
 * to `./strategy.md` first. A wallet the site already keeps is never asked to sign Register again.
 *
 * `--meme` (and `FL meme` after the entry) launches one coin from the player's concept, composed by the host and
 * held to the league's rules (`meme.ts`), on its own preview card and its own yes, through `league-entry`'s
 * one-shot and its default hard limits. It is never implied by the entry's yes.
 *
 * Each stage is a card. A run without --yes prints the next card and leaves it pending; a run with --yes acts on
 * that one card only if it was printed in the last 10 minutes and nothing on it changed, then prints the next.
 * Every dependency is injected, so a test runs the whole entry against fakes.
 */

export type EnterChain = {
  agentIdOf(wallet: Address): Promise<AgentIdRead>;
  creatorOf(coin: Address): Promise<Address | null | "unreadable">;
  coinInfo(coin: Address): Promise<CoinInfo | null>;
  isFeastCoin(coin: Address): Promise<boolean>;
};

/** What a one-shot run of league-entry did, read back from its book and its log. */
export type OneShotResult = {
  exit: RunOutcome["exit"];
  reason: string;
  launched: { coin: Address; txHash: Hex | null } | null;
  /** The last refusal or failure of the run, for the user. */
  failure: string | null;
  /** A launch was sent and its outcome is not known yet (the runtime keeps it, and asks again on the next run). */
  unresolved?: boolean;
};

/** The runtime's one-shot for league-entry: these requests, then exit. No requests: only ask about earlier outcomes not known. */
export type OneShot = (requests: IntentRequest[]) => Promise<OneShotResult>;

export type EnterDeps = {
  home: string;
  signer: Pick<Signer, "status" | "settings" | "address"> & SessionSigner & Pick<RegistrationSigner, "signRegistration"> & { signReferralBind?: (fields: BindFields, options?: SignOptions) => Promise<SignOutcome> };
  /** Run 17: the site's referral doors and the registry's read, for the referral binding; absent, nothing is bound. */
  referrals?: ReferralDeps;
  chain: EnterChain;
  site: LeagueSite;
  indexer?: string;
  fetch?: typeof fetch;
  now?: () => number;
  oneShot: OneShot;
  /** LEAGUE_NOTES_DEV=1: no notes signature (the default reads the environment). */
  notesDev?: boolean;
  /** How the signatures wait for the App's confirmation (tests make it instant). */
  signOptions?: SignOptions;
  /** Task 967: the GETs back off; task 968: a seat the site has not given yet is asked for again under it. */
  retry?: Retry;
  /** Task 968: start the trading agent in the background (the CLI's detached `run`); its pid. Tests pass a fake. */
  start?: (name: string, options: { noJitter: boolean }) => Promise<number>;
  /**
   * Addendum 11: keep the agent running across reboots and crashes, as FL enter's last step (unless --no-daemon): the
   * machine's own supervisor starts it. `ok: false` (Windows, a home in the temp folder, a supervisor that said no):
   * its lines are said and the agent is started in the background as before.
   */
  daemon?: (name: string) => Promise<{ ok: boolean; lines: string[]; /** Run 19: whether the supervisor really started it (null: not known). */ running?: boolean | null; startCommand?: string | null }>;
  /** Where `./strategy.md` is looked for and the default copied (the CLI: the working directory). */
  cwd?: string;
  /** Wait for an agent's runtime to exit after its stop file is written; false when it did not in time (the CLI: 150 s). */
  waitForExit?: (name: string) => Promise<boolean>;
};

export type MemeInput = { concept: string; name?: string; symbol?: string; description?: string; image?: string };

export type EnterInput = {
  name: string | undefined;
  yes: boolean;
  lang: Lang;
  /** The player's strategy; without it, the season-1 default copied to `./strategy.md`. */
  prompt?: string;
  /** Register (and the notes, and a meme if asked) only: nothing is planned or started. */
  noStart?: boolean;
  /** The trading agent's name; default the bare Agent ID when it fits. */
  agent?: string;
  autopilot?: string;
  /** Task 975: no autopilot backup (by default the agent gets `steady`). */
  noAutopilot?: boolean;
  /** Task 975, addendum 4: the ask loop: every N minutes (default 5), with which host's CLI, which model. */
  every?: number;
  askWith?: string;
  askModel?: string;
  /** Addendum 11: `--ask-base-url` and `--ask-key-env` (the openai adapter). */
  askBaseUrl?: string;
  askKeyEnv?: string;
  /** Addendum 11: the player said no to the daemon. */
  noDaemon?: boolean;
  /**
   * Run 21: manual mode: registered and signed in as ever, the agent recorded, and no loop and no daemon (a host whose
   * background processes die, Binance AI Pro's sandbox). The player drives it with FL data, buy, sell, note, status.
   */
  manual?: boolean;
  /** Addendum 12: a tutorial's referral code: bare, or the pasted line with `?ref=<code>` or `ref: <code>`. */
  ref?: string;
  idleMinutes?: number;
  noJitter?: boolean;
  meme?: MemeInput;
  /** `FL meme`: only the meme, for a home that has entered. */
  memeOnly?: boolean;
};

export type EnterResult = { code: 0 | 1 | 2; ok: boolean; stage: string; data: Record<string, unknown>; text: string };

export type EntryRecord = {
  agentId: string;
  /** The agent's coin: its meme, or a pre-968 body coin, or the coin the site names for it; null when it has none. */
  bodyCoin: Address | null;
  launchTx: Hex | null;
  /** What the notes session came to when the entry asked for it; null until it has. */
  notes?: SessionOutcome["kind"] | null;
  /** A record from before the owner's ruling of 2026-10-24 kept its buy here; nothing writes one now. */
  buy?: { coin: Address; txHash: Hex; bnb: number; usdtAtBuy?: number; at: string } | null;
  /** Task 968: the Register the site keeps for this season; `seat` null while the site has not given one. */
  registered?: { season: number; issuedAt: number; seat: number | null; founding: number | null; at: string } | null;
  /** Addendum 12: the referral code sent with the registration (`FL enter --ref`); here and nowhere else. */
  ref?: string | null;
  /**
   * Run 17: where the wallet's referral binding stands; signed by itself since run 18 (the code is the consent), and
   * never again once kept, bound or the wallet's own. `referrer` is the code's referrer, when the site named it.
   */
  refBinding?: { state: "pending" | "sent" | "bound" | "refused" | "unknown" | "self"; referrer: string | null; deadline: number | null; at: string; refusal?: string | null; /** Run 19: the registry's referrer once read as bound (it never changes, so it is not read again). */ onChain?: string | null } | null;
  /** Task 968: the meme launched with `--meme` or `FL meme`. */
  meme?: { coin: Address; symbol: string; name: string; txHash: Hex | null; concept: string } | null;
  /** Task 968: the trading agent the entry started. */
  agent?: string | null;
};

type Stage = "launch" | "notes" | "register" | "meme" | "start";
type Pending = { stage: Stage; digest: string; at: string };

const ID_NAME = /^([a-z0-9]{1,64})(\.ai)?$/;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

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

/** Entered: a Register kept (or a pre-968 body coin) and the notes session asked for once; or a league-v3 record with its buy. */
export const isEntered = (record: EntryRecord | null, agentId: string) =>
  record !== null && record.agentId === agentId && (Boolean(record.buy) || ((Boolean(record.registered) || record.bodyCoin !== null) && (record.notes ?? null) !== null));

/** A reason fit to print: the first line, no URL (an RPC URL may carry a key), cleaned. */
const reasonOf = (error: unknown) => copy.clean(String((error as Error)?.message ?? error).split("\n")[0]!.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"));

export async function enter(deps: EnterDeps, input: EnterInput): Promise<EnterResult> {
  const now = deps.now ?? Date.now;
  const lang = input.lang;
  const lines: string[] = [];
  /** Task 975: the planned agent's autopilot backup, in the JSON of every answer once it is planned. */
  let autopilotData: { autopilot: copy.AutopilotShown } | Record<string, never> = {};
  const end = (code: 0 | 1 | 2, ok: boolean, stage: string, text: string | string[], data: Record<string, unknown> = {}): EnterResult => ({ code, ok, stage, data: { ...autopilotData, ...data }, text: [...lines, ...(Array.isArray(text) ? text : [text])].join("\n") });
  const paths = entryPaths(deps.home);

  // --- the name, the meme's composition, the agent's name: no call to anyone ----------------------
  let record = readEntry(deps.home);
  let rawName = input.name;
  if (input.memeOnly) {
    if (!record) return end(2, false, "entry", copy.memeNoEntry(lang));
    rawName = record.agentId;
  }
  if (rawName === undefined || rawName.trim() === "") return end(2, false, "name", copy.nameMissing(lang));
  const named = ID_NAME.exec(rawName.trim());
  if (!named) return end(2, false, "name", copy.nameBad(rawName, lang));
  const given = named[1]!;

  let composed: Meme | null = null;
  if (input.meme) {
    const m = input.meme;
    const concept = copy.clean(m.concept ?? "", 200);
    if (m.name === undefined || m.symbol === undefined || m.description === undefined) {
      const precheck = composeMeme({ concept: m.concept ?? "", name: "x", symbol: "X", description: "x" });
      if (!precheck.ok) return end(2, false, "compose", copy.memeRefused(precheck.reason, lang), { reason: precheck.reason });
      return end(2, true, "compose", copy.composeCard(concept, lang), { concept: { untrusted: true, text: concept }, rules: lang === "zh" ? copy.MEME_RULES_ZH : copy.MEME_RULES_EN, needs: ["--coin-name", "--symbol", "--description"], optional: ["--image"] });
    }
    const c = composeMeme({ concept: m.concept, name: m.name, symbol: m.symbol, description: m.description });
    if (!c.ok) return end(2, false, "compose", copy.memeRefused(c.reason, lang), { reason: c.reason });
    composed = c;
  }

  const startWanted = !input.noStart && !input.memeOnly;
  const choice = autopilotChoice({ autopilot: input.autopilot, noAutopilot: input.noAutopilot });
  if (!choice.ok) return end(2, false, "plan", choice.error);
  const asked = askChoice({ noAutopilot: input.noAutopilot, every: input.every, askWith: input.askWith, askModel: input.askModel, askBaseUrl: input.askBaseUrl, askKeyEnv: input.askKeyEnv, host: modelHint(), detail: hostDetailHint() });
  if (!asked.ok) return end(2, false, "plan", asked.error);
  // Addendum 12: a tutorial's referral code, bare or in the pasted line; a malformed one stops here, nothing asked or sent.
  const refRead = parseRef(input.ref);
  if (!refRead.ok) return end(2, false, "input", refRead.reason);
  const ref = refRead.ref;
  let refSent = false;
  /** A code given when the registration is already behind this wallet: said, never sent, never kept. */
  const refLate = () => (ref && !refSent && readEntry(deps.home)?.ref !== ref ? [copy.refNotSent(ref, lang)] : []);
  let agentName: string | null = null;
  if (startWanted) {
    if (input.agent !== undefined) {
      if (!AGENT_NAME.test(input.agent) || input.agent === ENTRY_AGENT) return end(2, false, "agent", copy.agentNameBad(input.agent, lang));
      agentName = input.agent;
    } else if (AGENT_NAME.test(given) && given !== ENTRY_AGENT) agentName = given;
    else return end(2, false, "agent", copy.agentNameNeeded(given, lang), { agentId: given });
  }
  // Run 21: manual mode, asked now or kept on the agent (a rerun without the flag keeps it; FL start switches it to the loop).
  const manual = startWanted && (input.manual === true || (agentName !== null && loadAgent(deps.home, agentName)?.manual === true));
  // The wallet held by the agent this entry started is ours: a meme pauses it for the launch.
  const holder = walletLockHolder(deps.home);
  const ours = agentName ?? record?.agent ?? null;
  if (holder && holder.agent !== ours) return end(2, false, "busy", copy.walletBusy(holder.agent, lang), { agent: holder.agent });
  const stored = loadAgent(deps.home, ENTRY_AGENT);
  if (stored && !isEntryAgent(stored)) return end(2, false, "agent", copy.entryAgentChanged(lang));
  if (record && record.agentId !== given) return end(2, false, "agent-id", copy.foreignHome(record.agentId, given, lang));
  const entered = isEntered(record, given);

  // --- the pending card, and the yes ------------------------------------------------------------------
  let yesUsed = false;
  const pendingNow = (): Pending | null => {
    const p = readJson<Pending>(paths.pending);
    if (!p || typeof p.at !== "string") return null;
    const at = Date.parse(p.at);
    return Number.isFinite(at) && now() - at <= PENDING_MAX_AGE_MS && at <= now() + 60_000 ? p : null;
  };
  const yesFor = (stage: Stage, digest: string) => {
    if (!input.yes || yesUsed) return false;
    const p = pendingNow();
    if (p === null || p.stage !== stage || p.digest !== digest) return false;
    yesUsed = true;
    rmSync(paths.pending, { force: true });
    return true;
  };
  // Before the wallet is read there is no address to scrub; nothing logged here carries one.
  let scrub = (value: unknown) => value;
  const log = (event: string, fields: Record<string, unknown> = {}) => appendJsonl(agentPaths(deps.home, ENTRY_AGENT).log, scrub({ at: new Date(now()).toISOString(), event, ...fields }));
  /** The card stays pending for the user's yes: exit 2. With a --yes that did not match, say so first. */
  const ask = (stage: Stage, digest: string, card: string, data: Record<string, unknown>): EnterResult => {
    writeJsonAtomic(paths.pending, { stage, digest, at: new Date(now()).toISOString() } satisfies Pending);
    log("enter.card", { stage, digest });
    const parts = input.yes && !yesUsed ? [copy.cardChanged(lang), "", card] : [card];
    return end(2, true, `${stage}-card`, [...parts, "", copy.needsYes(lang)], { ...data, digest });
  };

  // --- the trading agent: planned now, so its card is under the entry's ---------------------------------
  type Planned = { name: string; agent: AgentConfig; card: string; shape: string; needsYes: boolean; strategy: copy.StrategyShown; autopilot: copy.AutopilotShown };
  let planned = null as Planned | null;
  const plan = (): Planned | EnterResult => {
    const name = agentName!;
    let strategy: copy.StrategyShown;
    let promptPath: string;
    if (input.prompt !== undefined) {
      promptPath = input.prompt;
      strategy = { kind: "given", path: input.prompt };
    } else {
      const file = ensureStrategy(deps.cwd ?? process.cwd(), given, lang);
      if (file.copied) log("enter.strategy", { copied: "season-1 default" });
      promptPath = file.path;
      strategy = { kind: file.copied ? "default" : "existing", path: file.path };
    }
    const planInput: PlanInput = { name, promptPath, preset: choice.preset, idleMinutes: input.idleMinutes, ...(asked.ask ? { ask: asked.ask } : {}), params: {}, limits: {} };
    const checked = prepareStart(deps.home, name, { plan: planInput, yes: false, confirm: true, now: new Date(now()), ...(manual ? { manual: true } : {}) });
    if (checked.kind === "not-planned") return end(2, false, "plan", copy.notPlanned(checked.errors, lang), { errors: checked.errors });
    if (checked.kind === "running") return end(2, false, "running", copy.runningOtherCard(name, lang), { agent: name });
    if (checked.kind === "refused") return end(2, false, "start", copy.startRefused(checked.why, lang), { agent: name });
    if (checked.kind === "no-agent") return end(2, false, "plan", copy.notPlanned(["no agent was planned"], lang));
    const agent = checked.agent;
    const autopilot = agent.preset && agent.autopilot ? { preset: agent.preset, idleMinutes: agent.autopilot.idleMinutes, ...(agent.ask ? { ask: { every: agent.ask.every, with: agent.ask.with } } : {}) } : null;
    return { name, agent, card: checked.kind === "needs-yes" ? checked.card : renderCard(agent), shape: shapeOf(agent), needsYes: checked.kind === "needs-yes", strategy, autopilot };
  };
  /**
   * The referral binding (run 17): when this entry carries a referral code (given now, or kept from a v5.1 entry), and
   * the wallet has no referrer on chain, its own card asks the player once to sign the free `Bind` message; the site
   * keeps it and the keeper relays it. Never silent, never twice: a wallet bound on chain (to anyone), or a binding
   * already kept and not expired, is never asked again. `null`: nothing to ask; else the card, or the lines it said.
   */
  /**
   * The referral binding (run 17), signed by itself (run 18, the owner's ruling "自动签"): a code the player put in
   * the entry line is their word on who referred them, so no card and no second yes. Everything else holds: nothing
   * when the wallet has a referrer on chain (anyone's) or a kept binding is still live; the signature checked here
   * before it is sent; a failure is one line and the next `FL enter` tries again, never a failed entry.
   */
  const bindStep = async (): Promise<string[]> => {
    const kept = readEntry(deps.home);
    const code = (refSent ? ref : null) ?? kept?.ref ?? null;
    if (!code || !deps.referrals || !deps.signer.signReferralBind) return [];
    return bindWith(code, kept).catch((error: unknown) => {
      log("enter.bind", { result: "failed", why: (error as Error).name });
      return [copy.referrerLine({ kind: "failed", code }, lang)];
    });
  };
  const bindWith = async (code: string, kept: EntryRecord | null): Promise<string[]> => {
    if (!deps.referrals || !deps.signer.signReferralBind) return [];
    const said = (r: copy.ReferrerSaid) => [copy.referrerLine(r, lang)];
    const b = kept?.refBinding ?? null;
    // Run 19: kept or bound already: nothing signed, and one line so the rerun does not leave the player wondering.
    if (b && (b.state === "bound" || b.state === "sent" || (b.state === "pending" && b.deadline !== null && b.deadline * 1_000 > now()))) {
      if (b.state === "bound" && b.onChain && b.referrer) return said({ kind: b.onChain.toLowerCase() === b.referrer.toLowerCase() ? "bound" : "other", code });
      return said({ kind: "kept-before", code });
    }
    if (b?.state === "self") return [];
    const at = () => new Date(now()).toISOString();
    const keep = (refBinding: NonNullable<EntryRecord["refBinding"]>) => {
      const latest = readEntry(deps.home);
      if (latest) writeJsonAtomic(paths.entry, { ...latest, refBinding });
    };
    let wallet: Address;
    try {
      wallet = getAddress(await deps.signer.address());
    } catch {
      return said({ kind: "later", code, who: "wallet" });
    }
    const referrals = deps.referrals;
    /** Bound on chain already: kept as bound, and said whether it is this code's referrer. */
    const boundAlready = async (onChain: Address | null) => {
      const r = await referrals.resolve(code);
      const referrer = r.kind === "address" ? r.referrer.toLowerCase() : null;
      keep({ state: "bound", referrer, deadline: null, at: at(), onChain: onChain?.toLowerCase() ?? null });
      log("enter.bind", { result: "already-bound" });
      if (referrer === null || onChain === null) return said({ kind: "bound-unread", code });
      return said({ kind: referrer === onChain.toLowerCase() ? "bound" : "other", code });
    };
    const onChain = await referrals.referrerOf(wallet);
    if (onChain === "unreadable") return said({ kind: "later", code, who: "chain" });
    if (onChain !== null) return boundAlready(onChain);
    const resolved = await referrals.resolve(code);
    if (resolved.kind === "unreadable") return said({ kind: "later", code, who: "site" });
    if (resolved.kind === "unknown") {
      keep({ state: "unknown", referrer: null, deadline: null, at: at() });
      log("enter.bind", { result: "unknown-code" });
      return said({ kind: "unknown", code });
    }
    if (resolved.referrer.toLowerCase() === wallet.toLowerCase()) {
      keep({ state: "self", referrer: null, deadline: null, at: at() });
      log("enter.bind", { result: "own-code" });
      return said({ kind: "self", code });
    }
    const referrer = resolved.referrer;
    const fields: BindFields = { wallet, referrer, deadline: bindDeadline(now()) };
    const signed = await deps.signer.signReferralBind(fields, deps.signOptions);
    if (signed.kind !== "signed") {
      log("enter.bind", { result: "not-signed", why: signed.kind });
      return said({ kind: "not-signed", code, why: signed.kind });
    }
    const signature = joinSignature(signed.signature, signed.recovery);
    if (!signature || !(await bindSignatureRecovers(fields, signature))) {
      log("enter.bind", { result: "local-check-failed" });
      return said({ kind: "not-signed", code, why: "local-check" });
    }
    const answer = await referrals.submit({ wallet: wallet.toLowerCase(), referrer: referrer.toLowerCase(), deadline: fields.deadline.toString(), signature, chainId: REFERRALS_CHAIN_ID });
    log("enter.bind", { result: answer.kind, ...(answer.kind === "refused" ? { status: answer.status, refusal: answer.name } : {}) });
    if (answer.kind === "kept") {
      keep({ state: answer.status === "sent" ? "sent" : "pending", referrer: referrer.toLowerCase(), deadline: Number(fields.deadline), at: at() });
      return said({ kind: "kept", code });
    }
    if (answer.kind === "already-bound") {
      const now2 = await referrals.referrerOf(wallet);
      keep({ state: "bound", referrer: referrer.toLowerCase(), deadline: null, at: at(), onChain: now2 === "unreadable" || now2 === null ? null : now2.toLowerCase() });
      if (now2 === "unreadable" || now2 === null) return said({ kind: "bound-unread", code });
      return said({ kind: now2.toLowerCase() === referrer.toLowerCase() ? "bound" : "other", code });
    }
    if (answer.kind === "refused") {
      const name = answer.name ?? answer.code ?? `HTTP ${answer.status}`;
      keep({ state: "refused", referrer: referrer.toLowerCase(), deadline: Number(fields.deadline), at: at(), refusal: name });
      return said({ kind: "refused", code, name });
    }
    return said({ kind: "later", code, who: "site" });
  };

  /** The wallet's sign-in end, for the entry card (addendum 8); null when it cannot be read. */
  const signInEndNow = async () => deps.signer.settings().then((s) => sessionView(s).end).catch(() => null);
  /** Planned once, where its card is needed: after the wallet is read on a first entry, at once on a rerun. */
  const planOnce = (): EnterResult | null => {
    if (!startWanted || planned) return null;
    const p = plan();
    if ("code" in p) return p;
    planned = p;
    autopilotData = { autopilot: p.autopilot };
    return null;
  };

  /** After a yes that covered it: confirm the agent, mark it to wait for the season, and start it once. */
  const startStep = async (): Promise<string[]> => {
    if (!planned) return [];
    const checked = prepareStart(deps.home, planned.name, { plan: null, yes: true, confirm: true, league: { waitForSeason: true }, now: new Date(now()), ...(manual ? { manual: true } : {}) });
    if (checked.kind !== "ready") return [copy.startRefused(checked.kind === "refused" ? checked.why : checked.kind, lang)];
    record = { ...(record ?? { agentId: given, bodyCoin: null, launchTx: null }), agent: planned.name };
    writeJsonAtomic(paths.entry, record);
    // Run 21: manual mode starts nothing and installs nothing; the closing lines say how to drive it.
    if (manual) {
      log("enter.manual", { agent: planned.name, waitForSeason: true });
      return [];
    }
    if (statusOf(deps.home, planned.name).running) return [copy.alreadyRunning(planned.name, lang)];
    const lock = walletLockHolder(deps.home);
    if (lock) return [copy.walletBusy(lock.agent, lang)];
    // Addendum 11: the daemon first (it starts the agent itself, and again after a reboot or a crash).
    const kept = deps.daemon && !input.noDaemon ? await deps.daemon(planned.name).catch((error: unknown) => ({ ok: false, running: null, lines: [String((error as Error).message)] })) : null;
    if (kept?.ok && kept.running !== false) {
      log("enter.started", { agent: planned.name, waitForSeason: true, daemon: true });
      return [copy.daemonLine(planned.name, lang)];
    }
    if (!deps.start) return [copy.startRefused("this run cannot start an agent", lang)];
    const pid = await deps.start(planned.name, { noJitter: input.noJitter === true });
    // Run 19: the daemon is installed, but its supervisor has not started the agent (launchd's deferred spawn): it runs
    // in the background now, and the line says so, never that the daemon started it.
    if (kept?.ok) {
      log("enter.started", { agent: planned.name, waitForSeason: true, daemon: "installed, not started" });
      return [copy.startedLine(planned.name, pid, lang), copy.daemonNotStartedLine(planned.name, lang)];
    }
    log("enter.started", { agent: planned.name, waitForSeason: true, daemon: false });
    return [copy.startedLine(planned.name, pid, lang), ...(kept ? kept.lines : []), ...(input.noDaemon ? [copy.noDaemonLine(planned.name, lang)] : [])];
  };

  // --- entered, and nothing to launch: the start alone, with no signature -------------------------------------
  if (entered && !composed) {
    const refused = planOnce();
    if (refused) return refused;
    const head = copy.alreadyEntered({ agentId: given, coin: record!.bodyCoin, notes: record!.notes ?? null, season: record!.registered?.season ?? null, seat: record!.registered?.seat ?? null }, lang);
    // Run 17: the referral binding, on a rerun too (a v5.1 entry's recorded code binds here, by itself since run 18).
    lines.push(...(input.memeOnly ? [] : await bindStep()));
    if (!planned) return end(0, true, "entered", [head, ...refLate(), ...(input.memeOnly ? [] : [copy.doneLine(lang)])], { agentId: given, bodyCoin: record!.bodyCoin, notes: record!.notes ?? null });
    if (manual && statusOf(deps.home, planned.name).running) return end(2, false, "running", [head, copy.manualWhileRunning(planned.name, lang)], { agentId: given, agent: planned.name, running: true });
    if (statusOf(deps.home, planned.name).running && !planned.needsYes) return end(0, true, "entered", [head, ...refLate(), copy.alreadyRunning(planned.name, lang)], { agentId: given, agent: planned.name, running: true });
    const rerunRead = await deps.site.league("today", null).catch(() => null);
    keepSupport(deps.home, rerunRead);
    const opens = tradingOpens(rerunRead);
    const upgrade = upgradeSentence(versionView(rerunRead?.latestRuntime, now()), lang);
    const signInEnd = await signInEndNow();
    if (planned.needsYes) {
      const digest = sha256(JSON.stringify({ stage: "start", agentId: given, start: planned.shape, ...(manual ? { manual } : {}) }));
      if (!yesFor("start", digest)) {
        lines.push(head, ...refLate());
        return ask("start", digest, [copy.startCard(lang), "", copy.agentSection({ strategy: planned.strategy, name: planned.name, card: planned.card, opens, autopilot: planned.autopilot, signInEnd, manual }, lang)].join("\n"), { agent: planned.name });
      }
    }
    lines.push(head, ...refLate(), ...(await startStep()));
    if (manual) return end(0, true, "done", copy.doneManual(planned.name, opens, lang, true), { agent: planned.name, manual: true });
    return end(0, true, "done", copy.doneRunning(planned.name, opens, lang, planned.autopilot, basename(planned.agent.prompt?.path ?? "strategy.md"), upgrade), { agent: planned.name });
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
  if (agentId !== given) return end(2, false, "agent-id", copy.nameMismatch(agentId, rawName.trim(), lang), { agentId });
  // Defense in depth: no line this entry writes may carry the wallet's address.
  scrub = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).split(wallet).join("self").split(wallet.toLowerCase()).join("self"));

  // --- eligibility ----------------------------------------------------------------------------------
  const page = await deps.site.agentIdOnPage(wallet);
  if (page.state === "unavailable") return end(1, false, "eligibility", copy.siteUnreadable(page.reason, lang));
  if (page.state === "unreadable") return end(2, false, "eligibility", copy.notEligible("unreadable", page.reason, lang));
  if (page.wallet !== wallet.toLowerCase()) return end(2, false, "eligibility", copy.notEligible("wallet", null, lang));
  if (page.agentId === null) return end(2, false, "eligibility", copy.notEligible("no-agent-id", null, lang));
  if (page.agentId !== agentId) return end(2, false, "eligibility", copy.notEligible("differs", page.agentId, lang));

  // --- a launch an earlier run could not learn the outcome of ------------------------------------
  const book = (): Book | null => statusOf(deps.home, ENTRY_AGENT).book;
  const open = () => book()?.unresolved.find((u) => u.kind === "launch") ?? null;
  if (open()) {
    // Only asked about: the one-shot with no request learns what it can, and sends nothing.
    await deps.oneShot([]);
    const still = open();
    if (still) return end(1, false, "unresolved", copy.pendingOutcome(still.kind, lang), { kind: still.kind, txHash: still.txHash });
  }

  const refused = planOnce();
  if (refused) return refused;

  let entry = stored ?? entryAgent(new Date(now()));
  if (!stored) saveAgent(deps.home, entry);
  const confirmEntry = () => {
    if (!entry.confirmed) {
      entry = confirmAgent(entry, new Date(now()));
      saveAgent(deps.home, entry);
      log("enter.confirmed", { agentId });
    }
  };

  // The season: the page says which, and when trading opens; a page that does not answer leaves it at 1, unknown.
  const leagueRead = await deps.site.league("today", null).catch(() => null);
  keepSupport(deps.home, leagueRead);
  const season = leagueRead?.season.number ?? 1;
  const opens = tradingOpens(leagueRead);
  const upgrade = upgradeSentence(versionView(leagueRead?.latestRuntime, now()), lang);
  const signInEnd = await signInEndNow();
  const dev = deps.notesDev ?? notesDev();
  const save = (next: EntryRecord) => {
    record = next;
    writeJsonAtomic(paths.entry, record);
  };
  const base = (): EntryRecord => record ?? { agentId, bodyCoin: null, launchTx: null, notes: null };
  /** The notes session, under a yes already given: one signature, or none in dev mode. Never stops the entry. */
  const notesStep = async (): Promise<string> => {
    const outcome: SessionOutcome = dev ? { kind: "dev" } : await openSession({ home: deps.home, signer: deps.signer, site: deps.site, agentId, season, now, signOptions: deps.signOptions });
    save({ ...base(), notes: outcome.kind });
    log("enter.notes", { session: outcome.kind, season });
    return sessionSaid(outcome, { agentId, season }, lang, "entry");
  };
  const registeredFrom = (kept: KeptAgent): NonNullable<EntryRecord["registered"]> => ({ season: kept.season ?? season, issuedAt: kept.issuedAt, seat: kept.seatNo, founding: kept.foundingNo, at: new Date(now()).toISOString() });
  const agentSection = () => (planned ? copy.agentSection({ strategy: planned.strategy, name: planned.name, card: planned.card, opens, autopilot: planned.autopilot, signInEnd, manual }, lang) : null);
  const finish = async (): Promise<EnterResult> => {
    lines.push(...refLate());
    if (planned) lines.push(...(await startStep()));
    // Run 17: the agent runs; then the referral binding, signed by itself (run 18) when this entry carries a code.
    lines.push(...(await bindStep()));
    lines.push(planned ? (manual ? copy.doneManual(planned.name, opens, lang) : copy.doneRunning(planned.name, opens, lang, planned.autopilot, basename(planned.agent.prompt?.path ?? "strategy.md"), upgrade)) : copy.doneLine(lang));
    if (composed) return memeStep(composed);
    // Signed in, and the site has not given the seat yet: "registered", not done; a rerun picks it up.
    return end(0, true, record?.registered && record.registered.seat === null ? "registered" : "done", [], { agentId, season, registered: record?.registered ?? null, notes: record?.notes ?? null, agent: planned?.name ?? null });
  };

  // --- the meme: its own card and its own yes ------------------------------------------------------------
  const memeStep = async (c: Meme): Promise<EnterResult> => {
    const launched = book()?.launched ?? null;
    const coin = record?.meme?.coin ?? record?.bodyCoin ?? launched?.coin ?? null;
    if (coin) {
      const symbol = record?.meme?.symbol ?? (await symbolOf(deps.chain, coin));
      return end(0, true, "meme-exists", copy.secondMeme(symbol, coin, lang), { coin });
    }
    let picture: { source: "host"; sha256: string; path: string; name: string; bytes: number } | Picture;
    const notices: string[] = [];
    const host = input.meme?.image !== undefined ? hostPicture(input.meme.image, deps.cwd ?? process.cwd()) : null;
    if (host?.ok) {
      const path = join(paths.dir, `meme-${host.sha256.slice(0, 8)}.png`);
      writeBytesAtomic(path, host.bytes);
      picture = { source: "host", sha256: host.sha256, path, name: host.name, bytes: host.bytes.length };
    } else {
      if (host && !host.ok) notices.push(copy.hostPictureNotUsed(host.why, lang));
      picture = await leaguePicture(deps.site, agentId, paths.avatar);
      if (picture.source === "ticker") notices.push(copy.avatarFallback(picture.reason, lang));
    }
    const imagePath = picture.source === "host" ? picture.path : picture.source === "league" ? paths.avatar : null;
    const facts = { stage: "meme", agentId, name: c.name, symbol: c.symbol, description: c.description, quote: BODY_COIN_QUOTE, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, picture: picture.source === "ticker" ? "ticker" : picture.sha256 };
    const digest = sha256(JSON.stringify(facts));
    const shownPicture: copy.MemePictureShown = picture.source === "host" ? { source: "host", name: picture.name, bytes: picture.bytes } : picture.source === "league" ? { source: "league", url: `${deps.site.base}/api/league/avatar/${agentId}.png` } : { source: "ticker" };
    // One runtime per wallet: the agent this entry started pauses for the launch, and starts again after it.
    const pausing = record?.agent && statusOf(deps.home, record.agent).running ? record.agent : null;
    const card = [copy.memeCard({ name: c.name, symbol: c.symbol, description: c.description, quote: BODY_COIN_QUOTE, picture: shownPicture, first: true }, lang), ...(pausing ? ["", copy.memePause(pausing, lang)] : [])].join("\n");
    const shown = { meme: { name: c.name, symbol: c.symbol, description: { untrusted: true, text: c.description }, changed: c.changed, quote: BODY_COIN_QUOTE, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, picture: picture.source === "ticker" ? { source: "ticker", reason: picture.reason } : { source: picture.source, sha256: picture.sha256 } } };
    const request: IntentRequest = { kind: "launch", name: c.name, symbol: c.symbol, quote: BODY_COIN_QUOTE, description: c.description, burn: BODY_COIN_SPLIT.burn, referrer: BODY_COIN_SPLIT.referrer, reason: "the player's meme", ...(imagePath && picture.source !== "ticker" ? { image: { path: imagePath, sha256: picture.sha256 } } : {}) };
    // The limits that need no wallet are read before the card, so a yes is never asked for a launch they refuse.
    const early = refuseEarly(deps.home, entry, request, now());
    if (early) return end(2, false, "limits", copy.refusedLine(early.limit, early.message, lang), { refused: early });
    if (!yesFor("meme", digest)) return ask("meme", digest, [...notices, ...(notices.length ? [""] : []), card, ...(c.changed.length ? ["", ...c.changed.map((x) => `(${x})`)] : [])].join("\n"), shown);

    // The user's yes on this card confirms league-entry, and the one launch goes through its limits.
    confirmEntry();
    log("enter.meme", { symbol: c.symbol, picture: facts.picture });
    let result: OneShotResult;
    if (pausing) {
      const stop = agentPaths(deps.home, pausing).stop;
      writeStop(stop, "paused for the meme's launch (FL meme)");
      const exited = deps.waitForExit ? await deps.waitForExit(pausing) : false;
      if (!exited) {
        removeStop(stop);
        return end(1, false, "paused", copy.pauseFailed(pausing, lang), { agent: pausing });
      }
      log("enter.paused", { agent: pausing });
      try {
        result = await deps.oneShot([request]);
      } finally {
        removeStop(stop);
        const pid = deps.start ? await deps.start(pausing, { noJitter: input.noJitter === true }) : null;
        if (pid !== null) lines.push(copy.startedLine(pausing, pid, lang));
      }
    } else result = await deps.oneShot([request]);
    if (!result.launched && result.unresolved) return end(1, false, "unresolved", copy.pendingOutcome("launch", lang), { kind: "launch" });
    if (!result.launched) return end(result.exit === "error" ? 1 : 2, false, "launch", copy.launchFailed(result.failure ?? `${result.exit}: ${result.reason}`, lang), { exit: result.exit });
    const r = base();
    save({ ...r, meme: { coin: result.launched.coin, symbol: c.symbol, name: c.name, txHash: result.launched.txHash, concept: c.concept }, bodyCoin: r.bodyCoin ?? result.launched.coin, launchTx: r.launchTx ?? result.launched.txHash });
    lines.push(copy.launchedTx(c.symbol, result.launched.coin, result.launched.txHash, lang));
    // The seat is the site's: read once, never signed for again.
    const after = await deps.site.kept(wallet);
    const seat = after.state === "read" && after.agent && after.agent.agentId === agentId ? after.agent.seatNo : null;
    return end(0, true, "launched", copy.seatAfterLaunch(seat, lang), { coin: result.launched.coin, launchTx: result.launched.txHash, seat });
  };

  if (entered) return memeStep(composed!);
  if (input.memeOnly) {
    if (!record?.registered && !record?.bodyCoin) return end(2, false, "entry", copy.memeNoEntry(lang));
    return memeStep(composed!);
  }

  // --- what feast.meme keeps for this wallet -------------------------------------------------------------
  const kept = await deps.site.kept(wallet);
  if (kept.state === "unreadable") return end(1, false, "kept", copy.keptUnreadable(kept.reason, lang));
  const mine = kept.agent && kept.agent.agentId === agentId && (kept.agent.season === null || kept.agent.season === season) ? kept.agent : null;

  if (mine) {
    // Kept for this season already: never signed again (a new signature gains nothing, and costs one of three a minute).
    const registered = registeredFrom(mine);
    if (JSON.stringify(record?.registered ?? null) === "null" || record?.registered?.seat !== registered.seat) save({ ...base(), registered, bodyCoin: base().bodyCoin ?? mine.bodyCoin });
    const seated = mine.seatNo !== null;
    const notesNeeded = seated && !dev && (record?.notes ?? null) === null;
    if (!seated) lines.push(copy.seatPending(season, lang));
    if (notesNeeded || planned?.needsYes) {
      const digest = sha256(JSON.stringify({ stage: notesNeeded ? "notes" : "start", agentId, season, start: planned?.shape ?? null, ...(manual ? { manual } : {}) }));
      const stage: Stage = notesNeeded ? "notes" : "start";
      if (!yesFor(stage, digest)) {
        const card = [notesNeeded ? copy.notesCard({ agentId, season, wallet }, lang) : copy.startCard(lang), ...(planned ? ["", agentSection()!] : [])].join("\n");
        return ask(stage, digest, card, { season, seat: mine.seatNo });
      }
    }
    if (seated && (record?.notes ?? null) === null) lines.push(await notesStep());
    return finish();
  }

  // --- the entry card: the Register signature, the notes, the start, under one yes ---------------------------
  // The yes covers the referral code too: it is in the card and in its digest.
  const digest = sha256(JSON.stringify({ stage: "register", agentId, season, notes: dev ? "dev" : season, start: planned?.shape ?? null, ...(ref ? { ref } : {}), ...(manual ? { manual } : {}) }));
  if (!yesFor("register", digest)) {
    const card = [copy.entryCard({ agentId, season, notes: !dev, agent: planned?.name ?? null, wallet, seasonOn: opens.kind === "open", ref, manual }, lang), ...(planned ? ["", agentSection()!] : [])].join("\n");
    return ask("register", digest, card, { season, agent: planned?.name ?? null, opens: opens.kind === "at" ? new Date(opens.at).toISOString() : opens.kind });
  }
  confirmEntry();
  const issuedAt = nextIssuedAt(now(), kept.agent?.issuedAt ?? null);
  const prepared: Prepared = {
    fields: { wallet, name: agentId, strategy: "", issuedAt },
    bodyCoin: null,
    xHandle: null,
    view: { agentId, bodyCoin: null, manifesto: "", length: 0, xHandle: null, issuedAt, replaces: kept.agent ? { issuedAt: kept.agent.issuedAt, seated: kept.agent.seatNo !== null } : null },
    ref,
  };
  refSent = ref !== null;
  const flowDeps: FlowDeps = { home: deps.home, name: ENTRY_AGENT, signer: deps.signer, chain: deps.chain, site: deps.site, now, log };
  const outcome = await submit(flowDeps, prepared, deps.signOptions);
  if (outcome.kind === "not-signed") {
    const why = outcome.why;
    const text = why.kind === "declined" ? signingLine("declined", lang) : why.kind === "expired" ? signingLine("expired", lang) : why.kind === "not-ready" ? walletNotReady(why.reason, lang) : previewMismatch(why.reason, lang);
    return end(2, false, "sign", text, { answer: { kind: "not-sent", why: why.kind } });
  }
  if (outcome.kind === "local-check-failed") return end(2, false, "sign", signingLine("local-check", lang, outcome.reason), { answer: { kind: "not-sent", why: "local-check" } });
  if (outcome.kind === "too-old") return end(2, false, "sign", signingLine("expired", lang), { answer: { kind: "not-sent", why: "too-old" } });
  const answer = outcome.answer;
  if (answer.kind === "refused") return end(2, false, "answer", refusalLine(answer.code, answer.field, agentId, lang), { answer: { kind: "refused", status: answer.status, code: answer.code, field: answer.field } });
  if (answer.kind === "no-answer") return end(2, false, "answer", noAnswerLine(outcome.reconciled, lang), { answer: { kind: "no-answer", reconciled: outcome.reconciled } });
  if (outcome.reconciled) lines.push(noAnswerLine(true, lang));

  let seating = answer.seating;
  // An old deploy answers "pending, no coin" (ruling C1): asked again a little later, under the backoff, never signed again.
  for (let k = 0; seating.kind === "pending" && deps.retry && k < 2; k += 1) {
    await deps.retry.sleep(backoffWait(k, deps.retry.random));
    const again = await deps.site.kept(wallet);
    if (again.state === "read" && again.agent && again.agent.agentId === agentId && again.agent.seatNo !== null) seating = { kind: "seated", seatNo: again.agent.seatNo, founding: again.agent.founding, foundingNo: again.agent.foundingNo, waitlisted: again.agent.waitlisted, place: null };
  }
  const coin = answer.agent?.bodyCoin ?? null;
  save({ ...base(), registered: { season: answer.agent?.season ?? season, issuedAt, seat: seating.kind === "seated" ? seating.seatNo : null, founding: seating.kind === "seated" ? seating.foundingNo : null, at: new Date(now()).toISOString() }, bodyCoin: base().bodyCoin ?? coin, ...(ref ? { ref } : {}) });
  if (seating.kind === "seated") {
    lines.push(seatedLine(seating, agentId, season, lang));
    lines.push(await notesStep());
  } else lines.push(copy.seatPending(season, lang));
  return finish();
}

/** A coin's ticker from the chain, cleaned; null when it is not a plain one or cannot be read. */
async function symbolOf(chain: EnterChain, coin: Address): Promise<string | null> {
  const symbol = copy.clean((await chain.coinInfo(coin).catch(() => null))?.symbol ?? "", 10);
  return copy.SAFE_SYMBOL.test(symbol) ? symbol : null;
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
    const last = [...lines].reverse().find((l) => l.event === "intent.failed" || l.event === "intent.refused");
    const failure = last ? (last.event === "intent.refused" ? `refused by ${String(last.limit)}: ${String(last.message)}` : `failed at ${String(last.stage)}: ${String(last.reason)}`) : null;
    return {
      exit: outcome.exit,
      reason: outcome.reason,
      launched: after?.launched && after.launched.coin !== launchedBefore ? { coin: after.launched.coin, txHash: after.launched.txHash ?? null } : null,
      failure,
      unresolved: (after?.unresolved ?? []).some((u) => u.kind === "launch"),
    };
  };
}

/**
 * `FL status`'s referrer line (run 18): from the entry's code, the registry's live read and the kept binding. Null when
 * the entry carries no code: an entry with no code says nothing about referrals.
 */
export function referrerStatus(entry: Pick<EntryRecord, "ref" | "refBinding"> | null, onChain: Address | null | "unreadable", nowMs: number): copy.ReferrerSaid | null {
  const code = entry?.ref ?? null;
  if (!code) return null;
  const b = entry?.refBinding ?? null;
  if (onChain === "unreadable") return { kind: "unread", code };
  if (onChain !== null) {
    if (!b?.referrer) return { kind: "bound-unread", code };
    return { kind: b.referrer.toLowerCase() === onChain.toLowerCase() ? "bound" : "other", code };
  }
  if (b?.state === "sent" || (b?.state === "pending" && b.deadline !== null && b.deadline * 1_000 > nowMs)) return { kind: "kept", code };
  if (b?.state === "refused") return { kind: "refused", code, name: b.refusal ?? "refused" };
  if (b?.state === "unknown") return { kind: "unknown", code };
  if (b?.state === "self") return { kind: "self", code };
  return { kind: "next", code };
}

/**
 * Run 19: `FL status`'s registry read, once: a referrer read as bound is kept in the entry's record (a wallet's
 * referrer never changes), so later reads skip the chain. `keptReferrer` is that kept read, null when there is none.
 */
export function keptReferrer(entry: Pick<EntryRecord, "refBinding"> | null): Address | null {
  const on = entry?.refBinding?.onChain;
  return on ? getAddress(on) : null;
}
export function keepReferrerRead(home: string, onChain: Address, nowMs: number): void {
  const latest = readEntry(home);
  if (!latest?.ref) return;
  const b = latest.refBinding ?? null;
  writeJsonAtomic(entryPaths(home).entry, { ...latest, refBinding: { ...(b ?? { referrer: null, deadline: null }), state: "bound", at: b?.at ?? new Date(nowMs).toISOString(), onChain: onChain.toLowerCase() } });
}
