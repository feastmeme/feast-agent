import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { toHex, type Address, type Hex } from "viem";

import type { SignOptions, SignOutcome } from "../baw.ts";
import type { AgentIdRead } from "../chain.ts";
import { ENTRY_AGENT } from "../enter/constants.ts";
import { readLeagueRecord } from "../register/flow.ts";
import { AGENT_ID, joinSignature, shownName } from "../register/message.ts";
import type { LeagueSite, NoteSessionBody } from "../register/site.ts";
import type { Lang } from "../register/copy.ts";
import { agentPaths, readJson, writeJsonAtomic } from "../store.ts";
import { noteSessionSignatureMatches, type NoteSessionFields } from "./message.ts";

export { NOTE_SESSION_TYPES, noteSessionTypedData, noteSessionTypedDataJson, type NoteSessionFields } from "./message.ts";

/**
 * The notes session (the owner's ruling, 2026-10-24; task 964 builds the
 * route): once a season, the wallet signs one NoteSession message through the
 * same allowlisted road as Register, `POST /api/league/notes/session` answers
 * a bearer token, and every note is then sent with `Authorization: Bearer
 * <token>`. `FL enter` opens it after the launch, under the same yes;
 * `FL note --login` opens it on demand.
 *
 *   $FEAST_LEAGUE_HOME/notes-session.json   { agentId, season, token, expiresAt, at, invalid? }
 *
 * It sits in the home, beside the agents' note queues (one wallet, one session,
 * every agent's notes), mode 0600, and holds no wallet address: the token is
 * the page's, opaque here. A note sent on a background flush (`FL data`, the
 * runtime) never signs: on a 401 the session is marked spent and the notes
 * wait for `FL note`, which opens it again once. `LEAGUE_NOTES_DEV=1` sends
 * notes unsigned, with no session, for development against a local page.
 */

export type NoteSession = { version: 1; agentId: string; season: number; token: string; expiresAt: string | null; at: string; invalid?: boolean };

export type SessionSigner = { address(): Promise<Address>; signNoteSession(fields: NoteSessionFields, options?: SignOptions): Promise<SignOutcome> };

export type SessionOutcome =
  | { kind: "open"; session: NoteSession }
  | { kind: "dev" }
  | { kind: "unavailable"; reason: string }
  | { kind: "refused"; status: number; code: string | null }
  | { kind: "not-signed"; why: string; reason: string | null };

export const sessionPath = (home: string) => join(home, "notes-session.json");

export const notesDev = (env: Record<string, string | undefined> = process.env) => env.LEAGUE_NOTES_DEV === "1";

/** The stored session, or null when there is none or it cannot be read. */
export function readSession(home: string): NoteSession | null {
  try {
    const s = readJson<NoteSession>(sessionPath(home));
    if (!s || typeof s.token !== "string" || typeof s.season !== "number" || typeof s.agentId !== "string") return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(home: string, session: NoteSession): void {
  writeJsonAtomic(sessionPath(home), session);
}

/** A 401: the token is spent. It stays on disk, marked, so the next `FL note` knows to sign again. */
export function invalidateSession(home: string): void {
  const s = readSession(home);
  if (s) saveSession(home, { ...s, invalid: true });
}

/** The token to send, or null when there is no live session. */
export function liveToken(home: string): string | null {
  const s = readSession(home);
  return s && !s.invalid ? s.token : null;
}

const newNonce = (): Hex => toHex(randomBytes(32));

/** Sign one NoteSession, send it, keep the token. Nothing is sent unless the signature recovers this wallet. */
export async function openSession(deps: { home: string; signer: SessionSigner; site: LeagueSite; agentId: string; season: number; nonce?: Hex; now?: () => number; signOptions?: SignOptions }): Promise<SessionOutcome> {
  const now = deps.now ?? Date.now;
  if (!AGENT_ID.test(deps.agentId)) return { kind: "not-signed", why: "agent-id", reason: "not an Agent ID" };
  let wallet: Address;
  try {
    wallet = await deps.signer.address();
  } catch (error) {
    return { kind: "not-signed", why: "wallet", reason: (error as Error).message };
  }
  const fields: NoteSessionFields = { wallet, agentId: deps.agentId, season: deps.season, nonce: deps.nonce ?? newNonce() };
  let signed: SignOutcome;
  try {
    signed = await deps.signer.signNoteSession(fields, deps.signOptions);
  } catch (error) {
    signed = { kind: "refused", reason: `the wallet did not answer: ${(error as Error).message}` };
  }
  if (signed.kind !== "signed") return { kind: "not-signed", why: signed.kind, reason: "reason" in signed ? signed.reason : null };
  const joined = joinSignature(signed.signature, signed.recovery);
  if (!joined || !(await noteSessionSignatureMatches(fields, joined))) return { kind: "not-signed", why: "local-check", reason: "the signature does not recover this wallet over these fields" };
  const bare = signed.signature.trim().replace(/^0x/i, "");
  const body: NoteSessionBody = {
    wallet: wallet.toLowerCase(),
    agentId: fields.agentId,
    season: fields.season,
    nonce: fields.nonce,
    scheme: "eip712",
    ...(bare.length === 128 && signed.recovery !== null ? { signature: bare, signatureRecovery: signed.recovery } : { signature: joined }),
  };
  const answer = await deps.site.noteSession(body);
  if (answer.kind !== "open") return answer;
  const session: NoteSession = { version: 1, agentId: fields.agentId, season: answer.season ?? fields.season, token: answer.token, expiresAt: answer.expiresAt, at: new Date(now()).toISOString() };
  saveSession(deps.home, session);
  return { kind: "open", session };
}

/** What a session's opening came to, in one line: `FL enter`'s words (`entry`) or `FL note --login`'s. */
export function sessionSaid(outcome: SessionOutcome, view: { agentId: string; season: number }, lang: Lang, where: "entry" | "login"): string {
  const zh = lang === "zh";
  const who = shownName(view.agentId);
  switch (outcome.kind) {
    case "open":
      return zh ? `笔记会话已开通：${who}，第 ${outcome.session.season} 季；你的 agent 的笔记会送到 feast.meme。` : `Notes session open for ${who}, season ${outcome.session.season}: your agent's notes reach feast.meme.`;
    case "dev":
      return zh ? "笔记不签名发送（LEAGUE_NOTES_DEV=1）：没有签任何会话。" : "Notes go unsigned (LEAGUE_NOTES_DEV=1): no session was signed.";
    case "unavailable":
      if (where === "login") return zh ? `feast.meme 暂时还不收笔记（${outcome.reason.slice(0, 80)}）：笔记先留在这台电脑上；之后再运行 FL note --login。` : `feast.meme does not take notes yet (${outcome.reason.slice(0, 80)}): your notes stay on this machine; run FL note --login again later.`;
      return zh ? "笔记先留在这台电脑上：feast.meme 暂时还不收。之后用 FL note --login 开通会话。" : "Notes stay on this machine for now: feast.meme does not take them yet. FL note --login opens the session later.";
    case "refused": {
      const said = `HTTP ${outcome.status}${outcome.code ? `, ${outcome.code.replace(/[^\w.-]/g, "").slice(0, 40)}` : ""}`;
      if (where === "login") return zh ? `feast.meme 拒绝了笔记会话（${said}）。没有再发送别的。` : `feast.meme refused the notes session (${said}). Nothing more was sent.`;
      return zh ? `feast.meme 拒绝了笔记会话（${said}）。笔记先留在这台电脑上；FL note --login 会再试一次。` : `feast.meme refused the notes session (${said}). Your notes stay on this machine; FL note --login tries again.`;
    }
    case "not-signed":
      if (where === "login") return zh ? `笔记会话的签名没有完成（${outcome.why}）。没有发送任何东西。` : `The notes signature was not made (${outcome.why}). Nothing was sent.`;
      return zh ? `笔记会话的签名没有完成（${outcome.why}）。笔记先留在这台电脑上；FL note --login 会再问一次。` : `The notes signature was not made (${outcome.why}). Your notes stay on this machine; FL note --login asks again.`;
  }
}

/** The bare Agent ID this home entered or registered with; null when neither is recorded. */
export function recordedAgentId(home: string): string | null {
  const entry = readJson<{ agentId?: unknown }>(join(agentPaths(home, ENTRY_AGENT).dir, "entry.json"));
  const id = typeof entry?.agentId === "string" ? entry.agentId : readLeagueRecord(home)?.agentId ?? null;
  return typeof id === "string" && AGENT_ID.test(id) ? id : null;
}

/**
 * `FL note --login`: the Agent ID from this home's entry (or registration, or the chain), the season from
 * the league page (else the stored session's, else 1), one signature, one line. Exit 0 open, 1 a read or the
 * page unavailable, 2 nothing to sign for, or not signed, or refused.
 */
export async function notesLogin(
  deps: { home: string; signer: SessionSigner; site: LeagueSite; chain?: { agentIdOf(wallet: Address): Promise<AgentIdRead> }; now?: () => number; signOptions?: SignOptions; env?: Record<string, string | undefined> },
  lang: Lang = "en",
): Promise<{ code: 0 | 1 | 2; text: string; data: Record<string, unknown> }> {
  const zh = lang === "zh";
  let agentId = recordedAgentId(deps.home);
  if (!agentId && deps.chain) {
    let read: AgentIdRead;
    try {
      read = await deps.chain.agentIdOf(await deps.signer.address());
    } catch (error) {
      read = { state: "unreadable", reason: (error as Error).message };
    }
    if (read.state === "unreadable") return { code: 1, text: zh ? "暂时没能从 BNB Smart Chain 读到 Agent ID：过一分钟再试。没有签名。" : "The Agent ID could not be read from BNB Smart Chain just now: try again in a minute. Nothing was signed.", data: { ok: false, stage: "agent-id" } };
    if (read.id === null) return { code: 2, text: zh ? "这个钱包没有 Agent ID：先在 Binance App 里铸一个，再运行 FL enter。" : "This wallet has no Agent ID: mint one in the Binance App, then run FL enter.", data: { ok: false, stage: "agent-id" } };
    agentId = read.id;
  }
  if (!agentId) return { code: 2, text: zh ? "这台电脑上没有 Agent ID：先运行 FL enter。" : "No Agent ID on this machine: run FL enter first.", data: { ok: false, stage: "agent-id" } };
  const season = (await deps.site.league("today", null).catch(() => null))?.season.number ?? readSession(deps.home)?.season ?? 1;
  const view = { agentId, season };
  if (notesDev(deps.env)) return { code: 0, text: sessionSaid({ kind: "dev" }, view, lang, "login"), data: { ok: true, session: "dev" } };
  const outcome = await openSession({ home: deps.home, signer: deps.signer, site: deps.site, agentId, season, now: deps.now, signOptions: deps.signOptions });
  const code = outcome.kind === "open" ? 0 : outcome.kind === "unavailable" ? 1 : 2;
  return { code, text: sessionSaid(outcome, view, lang, "login"), data: { ok: outcome.kind === "open", session: outcome.kind, season: outcome.kind === "open" ? outcome.session.season : season } };
}
