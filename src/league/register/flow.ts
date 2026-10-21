import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";

import type { RegistrationSigner, SignOptions, SignOutcome } from "../baw.ts";
import { parseBook } from "../book.ts";
import type { AgentIdRead, CoinInfo } from "../chain.ts";
import { INDEXER_URL } from "../events.ts";
import type { PresetId } from "../presets/specs.ts";
import { agentPaths, leagueRecordPath, readJson, writeJsonAtomic } from "../store.ts";
import { bodyCoinNames, bodyCoinPlan, launchesBy, normalizeXHandle, type BodyCoinPlan } from "./claims.ts";
import type { CoinShown, RegisterView } from "./copy.ts";
import { joinSignature, nextIssuedAt, normalizeManifesto, RESIGN_AFTER_SECONDS, signatureMatches, type Manifesto, type RegisterFields } from "./message.ts";
import { seatingOfKept, type KeptAgent, type LeagueRead, type LeagueSite, type Prereg, type RegisterAnswer, type RegisterBody, type Seating } from "./site.ts";

/**
 * The registration, A to F (docs/PLAN-941.md §1): read what is there, prepare
 * the message and the claims, then — after the user's yes — sign, check the
 * signature here, send, and read the answer. Every dependency is injected, so
 * a test runs the whole flow against a fake wallet and a fake page.
 *
 * Nothing about the agent's setup leaves the machine: the page is sent the
 * wallet, the Agent ID, the manifesto and the two claims, nothing else.
 */

export type FlowChain = {
  agentIdOf(wallet: Address): Promise<AgentIdRead>;
  creatorOf(coin: Address): Promise<Address | null | "unreadable">;
  coinInfo(coin: Address): Promise<CoinInfo | null>;
};

export type FlowDeps = {
  home: string;
  /** The agent this registration is made from: its book's launch, its log. It need not exist. */
  name: string;
  signer: RegistrationSigner;
  chain: FlowChain;
  site: LeagueSite;
  indexer?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export type LeagueRecord = {
  season: number | null;
  agentId: string;
  bodyCoin: string | null;
  issuedAt: number;
  registeredAt: string;
  seating: Seating;
  prereg: Prereg;
  manifesto: string;
  xHandle: string | null;
};

export const readLeagueRecord = (home: string) => readJson<LeagueRecord>(leagueRecordPath(home));

export type CheckResult =
  | { kind: "not-ready"; reason: "signed-out" | "devmode" }
  | { kind: "no-agent-id" }
  | { kind: "agent-id-unreadable"; reason: string }
  | {
      kind: "ready";
      wallet: Address;
      agentId: string;
      plan: BodyCoinPlan;
      coin: CoinShown | null;
      kept: KeptAgent | null;
      keptSeating: Seating | null;
      keptUnreadable: boolean;
      league: LeagueRead | null;
      launch: { name: string; symbol: string };
      preset: PresetId | null;
    };

/** This agent's own launch and preset, from its files; nothing when it does not exist. */
function agentFacts(home: string, name: string): { bookLaunch: Address | null; preset: PresetId | null } {
  try {
    const paths = agentPaths(home, name);
    const book = existsSync(paths.state) ? parseBook(readFileSync(paths.state, "utf8")) : null;
    const agent = readJson<{ preset?: PresetId | null }>(paths.agent);
    return { bookLaunch: book?.launched?.coin ?? null, preset: agent?.preset ?? null };
  } catch {
    return { bookLaunch: null, preset: null };
  }
}

/** A. What is there: the wallet, its Agent ID, its body coin, what the page keeps, the season. Reads only. */
export async function check(deps: FlowDeps, options: { named?: string | null } = {}): Promise<CheckResult> {
  const status = await deps.signer.status();
  if (!status.connected) return { kind: "not-ready", reason: "signed-out" };
  if (!(await deps.signer.settings()).devModeEnabled) return { kind: "not-ready", reason: "devmode" };
  const wallet = await deps.signer.address();
  const id = await deps.chain.agentIdOf(wallet);
  if (id.state === "unreadable") return { kind: "agent-id-unreadable", reason: id.reason };
  if (id.id === null) return { kind: "no-agent-id" };

  const [kept, league, indexed] = await Promise.all([
    deps.site.kept(wallet),
    deps.site.league("today", null),
    launchesBy(wallet, { indexer: deps.indexer ?? INDEXER_URL, fetch: deps.fetch }),
  ]);
  const keptAgent = kept.state === "read" ? kept.agent : null;
  const facts = agentFacts(deps.home, deps.name);
  const plan = await bodyCoinPlan({
    wallet,
    named: options.named ?? null,
    kept: keptAgent ? { bodyCoin: keptAgent.bodyCoin, seated: keptAgent.seatNo !== null && (league === null || keptAgent.season === null || keptAgent.season === league.season.number) } : null,
    bookLaunch: facts.bookLaunch,
    indexed,
    preset: facts.preset,
    creatorOf: (coin) => deps.chain.creatorOf(coin),
  });
  const coin = plan.kind === "coin" ? { coin: plan.coin, symbol: (await deps.chain.coinInfo(plan.coin).catch(() => null))?.symbol ?? null } : null;
  deps.log?.("register.check", { agentId: id.id, plan: plan.kind, why: plan.kind === "coin" ? plan.why : null, kept: kept.state === "read" ? keptAgent !== null : "unreadable", league: league?.state ?? null });
  return {
    kind: "ready",
    wallet,
    agentId: id.id,
    plan,
    coin,
    kept: keptAgent,
    keptSeating: keptAgent ? seatingOfKept(keptAgent) : null,
    keptUnreadable: kept.state === "unreadable",
    league,
    launch: bodyCoinNames(id.id),
    preset: facts.preset,
  };
}

export type Prepared = { fields: RegisterFields; bodyCoin: CoinShown | null; xHandle: string | null; view: RegisterView };

export type PrepareProblem =
  | { kind: "manifesto"; reason: Extract<Manifesto, { ok: false }>["reason"]; length: number }
  | { kind: "x-handle"; given: string }
  | { kind: "body-coin"; plan: BodyCoinPlan };

/** D. The message and the claims, as the card shows them; or what is missing. `pending`: the user chose to sign up without a body coin. */
export function prepare(
  ready: Extract<CheckResult, { kind: "ready" }>,
  input: { manifesto: string; xHandle?: string | null; pending?: boolean },
  now: number,
): { ok: true; prepared: Prepared } | { ok: false; problem: PrepareProblem } {
  const manifesto = normalizeManifesto(input.manifesto);
  if (!manifesto.ok) return { ok: false, problem: { kind: "manifesto", reason: manifesto.reason, length: manifesto.length } };
  let xHandle: string | null = null;
  if (input.xHandle !== undefined && input.xHandle !== null && input.xHandle.trim() !== "") {
    xHandle = normalizeXHandle(input.xHandle);
    if (!xHandle) return { ok: false, problem: { kind: "x-handle", given: input.xHandle } };
  }
  const bodyCoin = ready.plan.kind === "coin" ? ready.coin : null;
  if (!bodyCoin && !(input.pending && (ready.plan.kind === "launch" || ready.plan.kind === "await-preset-launch"))) return { ok: false, problem: { kind: "body-coin", plan: ready.plan } };
  const fields: RegisterFields = { wallet: ready.wallet, name: ready.agentId, strategy: manifesto.text, issuedAt: nextIssuedAt(now, ready.kept?.issuedAt ?? null) };
  return {
    ok: true,
    prepared: {
      fields,
      bodyCoin,
      xHandle,
      view: {
        agentId: ready.agentId,
        bodyCoin,
        manifesto: manifesto.text,
        length: manifesto.length,
        xHandle,
        issuedAt: fields.issuedAt,
        replaces: ready.kept ? { issuedAt: ready.kept.issuedAt, seated: ready.kept.seatNo !== null } : null,
      },
    },
  };
}

export type SubmitOutcome =
  | { kind: "not-signed"; why: Exclude<SignOutcome, { kind: "signed" }> }
  | { kind: "local-check-failed"; reason: string }
  | { kind: "too-old" }
  | { kind: "answer"; answer: RegisterAnswer; reconciled: boolean | null };

/** E and F. After the user's yes: sign, check here, send, read the answer; a lost answer is reconciled, never guessed. */
export async function submit(deps: FlowDeps, prepared: Prepared, options: SignOptions = {}): Promise<SubmitOutcome> {
  const now = deps.now ?? Date.now;
  const { fields } = prepared;
  let signed: SignOutcome;
  try {
    signed = await deps.signer.signRegistration(fields, options);
  } catch (error) {
    signed = { kind: "refused", reason: `the wallet did not answer: ${(error as Error).message}` };
  }
  if (signed.kind !== "signed") {
    deps.log?.("register.not-signed", { why: signed.kind, reason: "reason" in signed ? signed.reason : null });
    return { kind: "not-signed", why: signed };
  }
  const joined = joinSignature(signed.signature, signed.recovery);
  if (!joined) return { kind: "local-check-failed", reason: "the wallet's signature has a shape this agent cannot read" };
  if (!(await signatureMatches(fields, joined))) return { kind: "local-check-failed", reason: "it does not recover this wallet over these fields" };
  deps.log?.("register.signed", { issuedAt: fields.issuedAt });
  if (Math.floor(now() / 1_000) - fields.issuedAt > RESIGN_AFTER_SECONDS) return { kind: "too-old" };

  const bare = signed.signature.trim().replace(/^0x/i, "");
  const body: RegisterBody = {
    wallet: fields.wallet.toLowerCase(),
    name: fields.name,
    strategy: fields.strategy,
    copies: null,
    issuedAt: fields.issuedAt,
    scheme: "eip712",
    ...(bare.length === 128 && signed.recovery !== null ? { signature: bare, signatureRecovery: signed.recovery } : { signature: joined }),
    ...(prepared.bodyCoin ? { bodyCoin: prepared.bodyCoin.coin.toLowerCase() } : {}),
    ...(prepared.xHandle ? { xHandle: prepared.xHandle } : {}),
  };
  deps.log?.("register.sent", { issuedAt: fields.issuedAt, bodyCoin: body.bodyCoin ?? null, xHandle: body.xHandle !== undefined });
  let answer = await deps.site.register(body);
  let reconciled: boolean | null = null;
  // A lost answer, a replay, or a 5xx (the route's last 503 comes after its save is tried): did it land?
  if (answer.kind === "no-answer" || (answer.kind === "refused" && (answer.code === "replayed" || answer.status >= 500))) {
    // Did it land? Ours is the kept one exactly when its issuedAt and manifesto are ours.
    const kept = await deps.site.kept(fields.wallet);
    if (kept.state === "read" && kept.agent && kept.agent.issuedAt === fields.issuedAt && kept.agent.manifesto === fields.strategy) {
      answer = { kind: "kept", seating: seatingOfKept(kept.agent), prereg: "unclaimed", agent: kept.agent };
      reconciled = true;
    } else if (answer.kind === "no-answer") reconciled = kept.state === "read" ? false : null;
  }
  deps.log?.("register.answer", answer.kind === "kept" ? { kind: "kept", seating: answer.seating, prereg: answer.prereg, reconciled } : answer.kind === "refused" ? { kind: "refused", status: answer.status, code: answer.code, field: answer.field } : { kind: "no-answer", reason: answer.reason, reconciled });
  if (answer.kind === "kept") {
    const record: LeagueRecord = {
      season: answer.agent?.season ?? null,
      agentId: fields.name,
      bodyCoin: prepared.bodyCoin?.coin.toLowerCase() ?? answer.agent?.bodyCoin?.toLowerCase() ?? null,
      issuedAt: fields.issuedAt,
      registeredAt: new Date(now()).toISOString(),
      seating: answer.seating,
      prereg: answer.prereg,
      manifesto: fields.strategy,
      xHandle: prepared.xHandle,
    };
    writeJsonAtomic(leagueRecordPath(deps.home), record);
  }
  return { kind: "answer", answer, reconciled };
}
