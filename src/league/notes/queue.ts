import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";

import { normalizeManifesto } from "../register/message.ts";
import { checkModel, modelHint, withHostHeaders, type Model } from "../headers.ts";
import { within } from "../prompt/host.ts";
import { agentPaths, appendJsonl } from "../store.ts";
import { invalidateSession, liveToken, notesDev } from "./session.ts";

/**
 * `FL note <name> "<text>" [--tx <hash>] [--model grok|codex|claude|other]`
 * (task 963): one reason, at most 280 characters, for the trade the user's
 * agent just made, or the one it chose not to make, with the AI it declares
 * wrote it. It is kept on this machine first, in `agents/<name>/notes.jsonl`
 * (append-only, and with no wallet address in it), then POSTed to feast.meme's
 * `/api/league/notes` with the season's notes session (`session.ts`). A route
 * that is not there yet, a 5xx or no answer leaves it queued for a later flush;
 * a 409 drops it (the page has it); any other 4xx refuses it for good. A note
 * never touches the wallet, the book or a limit, and never blocks a trade.
 *
 * The POST is `{ id, wallet, ts, text, model, tx? }` with `Authorization:
 * Bearer <token>`; the wallet is added at send time only.
 */

export const NOTE_MAX = 280;
export const NOTE_TIMEOUT_MS = 10_000;
export const KEPT = "kept on this machine; sent when feast.meme takes notes";
export const KEPT_NO_SESSION = "kept on this machine; sent once your notes session is open (FL note --login)";
const TX = /^0x[0-9a-f]{64}$/;
const ADDRESS = /(?:0x)?[0-9a-f]{40}/gi;

/** The AI a note says wrote it, and the host's hint: one source with the `x-feast-host` header (task 975). */
export { checkModel, MODELS, modelHint, type Model } from "../headers.ts";

export type NoteState = { id: string; ts: string; text: string; tx: string | null; model: Model; state: "queued" | "sent" | "refused" | "dropped"; status?: number; at?: string };

type Line = { id: string; ts?: string; text?: string; tx?: string | null; model?: string; sent?: boolean; refused?: number; dropped?: number; at?: string };

export const notesPath = (home: string, name: string) => join(agentPaths(home, name).dir, "notes.jsonl");

/** A note's text as the page counts it (the manifesto's rule: NFKC, whitespace folded), or why it is not one. */
export function checkNote(raw: string, wallet: Address | null): { ok: true; text: string } | { ok: false; reason: string } {
  const normal = normalizeManifesto(raw);
  if (!normal.ok && normal.reason !== "too-long") return { ok: false, reason: normal.reason === "not-text" ? "a note is text" : "a note has no control or direction characters" };
  const text = normal.ok ? normal.text : raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = [...text].length;
  if (length < 1 || length > NOTE_MAX) return { ok: false, reason: `a note is 1–${NOTE_MAX} characters (got ${length})` };
  if (wallet && text.toLowerCase().includes(wallet.slice(2).toLowerCase())) return { ok: false, reason: "a note never carries the wallet's address" };
  return { ok: true, text };
}

/** Every note, folded to its latest state (the first sent, refused or dropped mark wins). Oldest first. */
export function readNotes(home: string, name: string): NoteState[] {
  const path = notesPath(home, name);
  if (!existsSync(path)) return [];
  const notes = new Map<string, NoteState>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (typeof line.id !== "string") continue;
    const known = notes.get(line.id);
    if (typeof line.text === "string" && !known) {
      const model = checkModel(line.model ?? "");
      notes.set(line.id, { id: line.id, ts: String(line.ts), text: line.text, tx: line.tx ?? null, model: model.ok ? model.model : "other", state: "queued" });
    } else if (known && known.state === "queued" && line.sent === true) notes.set(line.id, { ...known, state: "sent", at: line.at });
    else if (known && known.state === "queued" && typeof line.refused === "number") notes.set(line.id, { ...known, state: "refused", status: line.refused, at: line.at });
    else if (known && known.state === "queued" && typeof line.dropped === "number") notes.set(line.id, { ...known, state: "dropped", status: line.dropped, at: line.at });
  }
  return [...notes.values()];
}

export type SendDeps = {
  site: string;
  fetch: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  max?: number;
  /** LEAGUE_NOTES_DEV=1: unsigned, with no session (the default reads the environment). */
  dev?: boolean;
  /** Open the session again after a 401, once (`FL note` only: a background flush never signs). True when it opened. */
  relogin?: () => Promise<boolean>;
};
export type Flushed = { sent: number; kept: number; refused: number; dropped: number; lastRefused: number | null; reason: string | null };

/**
 * The queued notes, oldest first, at most `max`, each with the season's bearer token. With no live session
 * (and not in dev mode) nothing is sent. It stops at the first answer that says the route is not there (404,
 * 405, 429, a 5xx, no answer): the rest wait for the next flush. A 401 spends the session: `relogin` opens it
 * again once and the note is sent again; without one, the session is marked spent. A 409 is a note the page
 * has already: the copy here is dropped. Any other 4xx refuses the note for good.
 */
export async function flushNotes(home: string, name: string, wallet: Address, deps: SendDeps): Promise<Flushed> {
  const now = deps.now ?? Date.now;
  const dev = deps.dev ?? notesDev();
  const queued = readNotes(home, name).filter((n) => n.state === "queued");
  const out: Flushed = { sent: 0, kept: queued.length, refused: 0, dropped: 0, lastRefused: null, reason: null };
  let token = dev ? null : liveToken(home);
  if (!dev && !token) return queued.length > 0 ? { ...out, reason: "no-session" } : out;
  let relogged = false;
  const settle = (note: NoteState, mark: Record<string, unknown>) => {
    appendJsonl(notesPath(home, name), { id: note.id, ...mark, at: new Date(now()).toISOString() });
    out.kept -= 1;
  };
  for (let i = 0; i < Math.min(queued.length, deps.max ?? 20); i += 1) {
    const note = queued[i]!;
    let status: number;
    try {
      const response = await withHostHeaders(deps.fetch, [deps.site])(`${deps.site.replace(/\/+$/, "")}/api/league/notes`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ id: note.id, wallet, ts: note.ts, text: note.text, model: note.model, ...(note.tx ? { tx: note.tx } : {}) }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? NOTE_TIMEOUT_MS),
      });
      status = response.status;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      out.reason = (error as Error).name === "TimeoutError" ? "no answer in time" : "no answer";
      break;
    }
    if (status >= 200 && status < 300) {
      settle(note, { sent: true });
      out.sent += 1;
      continue;
    }
    if (status === 401 && !dev) {
      if (deps.relogin && !relogged) {
        relogged = true;
        token = (await deps.relogin().catch(() => false)) ? liveToken(home) : null;
        if (token) {
          i -= 1;
          continue;
        }
      }
      invalidateSession(home);
      out.reason = "unauthorized";
      break;
    }
    if (status === 409) {
      settle(note, { dropped: 409 });
      out.dropped += 1;
      continue;
    }
    if (status === 404 || status === 405 || status === 429 || status >= 500) {
      out.reason = `HTTP ${status}`;
      break;
    }
    settle(note, { refused: status });
    out.refused += 1;
    out.lastRefused = status;
  }
  return out;
}

export type NoteDeps = SendDeps & { home: string; name: string; wallet: () => Promise<Address | null>; env?: Record<string, string | undefined> };

/** `FL note`: check, keep, then try to send the queue (oldest first). Exit 2 only for a note that is not one. */
export async function noteCommand(deps: NoteDeps, input: { text: string; tx?: string; model?: string }): Promise<{ code: 0 | 1 | 2; text: string; data: Record<string, unknown> }> {
  const now = deps.now ?? Date.now;
  const tx = input.tx === undefined ? null : input.tx.trim().toLowerCase();
  if (tx !== null && !TX.test(tx)) return { code: 2, text: "--tx must be a transaction hash: 0x and 64 hex digits", data: { ok: false, problem: "tx" } };
  const declared = input.model === undefined ? { ok: true as const, model: modelHint(deps.env) } : checkModel(input.model);
  if (!declared.ok) return { code: 2, text: declared.reason, data: { ok: false, problem: "model" } };
  const first = checkNote(input.text, null);
  if (!first.ok) return { code: 2, text: first.reason, data: { ok: false, problem: first.reason } };
  const wallet = await within(deps.wallet(), 5_000);
  const checked = checkNote(input.text, wallet);
  if (!checked.ok) return { code: 2, text: checked.reason, data: { ok: false, problem: checked.reason } };
  // With the wallet unread, a full address in the text cannot be told apart from the wallet's: it is not kept.
  if (!wallet && [...checked.text.matchAll(ADDRESS)].length > 0) {
    return { code: 1, text: "the wallet could not be read to check this note's address; nothing was kept: try again in a minute", data: { ok: false, problem: "wallet-unread" } };
  }
  // A note is not a trade: it does not hold the autopilot back (task 975, the coordinator's ruling C6).
  const id = randomUUID();
  appendJsonl(notesPath(deps.home, deps.name), { id, ts: new Date(now()).toISOString(), text: checked.text, tx, model: declared.model, sent: false });
  if (!wallet) return { code: 0, text: KEPT, data: { ok: true, id, model: declared.model, state: "queued" } };
  const flushed = await flushNotes(deps.home, deps.name, wallet, deps);
  const mine = readNotes(deps.home, deps.name).find((n) => n.id === id)!;
  const data = { ok: true, id, model: declared.model };
  if (mine.state === "sent") return { code: 0, text: "sent to feast.meme", data: { ...data, state: "sent" } };
  if (mine.state === "dropped") return { code: 0, text: "feast.meme has this note already; the copy here is dropped", data: { ...data, state: "dropped" } };
  if (mine.state === "refused") return { code: 0, text: `feast.meme refused this note (HTTP ${mine.status}); it stays on this machine and is never sent again`, data: { ...data, state: "refused", status: mine.status } };
  const noSession = flushed.reason === "no-session" || flushed.reason === "unauthorized";
  return { code: 0, text: noSession ? KEPT_NO_SESSION : KEPT, data: { ...data, state: "queued", reason: flushed.reason } };
}
