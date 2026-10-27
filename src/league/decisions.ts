import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentConfig } from "./agent.ts";
import { clean } from "./enter/copy.ts";
import { defaultPersonaOf, type PersonaKey } from "./enter/strategy.ts";
import { HOST_DETAIL_HEADER, HOST_HEADER, hostHeaders, RUNTIME_RELEASE } from "./headers.ts";
import { recordedAgentId } from "./notes/session.ts";
import { readPrompt } from "./prompt/host.ts";
import { scrub } from "./report.ts";
import { agentPaths, appendJsonl, readJson, writeFileAtomic, writeJsonAtomic } from "./store.ts";

/**
 * Each round's decision, said to feast.meme (task 1018; the row is the contract fixed in briefs 1018 and 1019, the
 * site's `POST /api/league/decisions`). Three writers append one row per decision to the agent's ring: the ask loop
 * (`runtime-ask`, from the same values as its journal row), `FL answer` (`host-answer`, a separate process) and the
 * floor keeper (`keeper`: each of its trades, and a hold at most once an ask interval while it is on and decides
 * nothing). The running runtime's heartbeat uploads the ring, oldest first, at most 3 rows a beat, and moves its
 * cursor only when the site takes them; anything else leaves them for the next beat.
 *
 *   agents/<name>/decisions.jsonl       at most 30 rows; past 30, rewritten whole, the newest 30 kept
 *   agents/<name>/decisions-state.json  `sentThrough`, the `at` of the newest row the site took, and the runtime's
 *                                       floor keeper switch, for `FL answer`'s rows
 *
 * Neither holds a wallet address, a key or a path: every line is scrubbed as `FL report` scrubs (an address or a hash
 * as its 6+4, a home folder as `~`). The strategy's text never leaves this machine: only its kind and the first 8 hex
 * of a sha256 (the prompt's, the script file's, or the preset's canonical parameters).
 */

export const DECISIONS_KEPT = 30;
export const DECISIONS_PER_BEAT = 3;
export const DECISIONS_TIMEOUT_MS = 10_000;
export const DECISION_REASON_MAX = 140;
export const DECISION_RESULT_MAX = 160;
/** `strategy.kind`, `keeper.mode`, `runtime` and `host`. */
const SHORT_MAX = 32;
/** The site takes an `at` up to 24 h old: a row older than 23 h by this machine's clock is not sent, and waits for nothing. */
const SEND_BACK_MS = 23 * 3_600_000;

export type DecisionSource = "runtime-ask" | "host-answer" | "keeper";
export type DecisionAction = "hold" | "buy" | "sell" | "none";
/** `persona`: the style of the season-1 default, when the strategy is still that default word for word (the site ignores it). */
export type DecisionStrategy = { kind: string; sha8: string; persona?: PersonaKey };
export type DecisionKeeper = { on: boolean; mode: string };
export type DecisionRow = {
  at: string;
  source: DecisionSource;
  action: DecisionAction;
  reason: string;
  result: string;
  strategy: DecisionStrategy;
  keeper: DecisionKeeper;
  runtime: string;
  host: string;
};

export type DecisionsState = { sentThrough: string | null; keeper: (DecisionKeeper & { at: string }) | null };

export const decisionsPath = (home: string, name: string) => join(agentPaths(home, name).dir, "decisions.jsonl");
export const decisionsStatePath = (home: string, name: string) => join(agentPaths(home, name).dir, "decisions-state.json");

export const KEEPER_OFF: DecisionKeeper = { on: false, mode: "off" };
/** The runtime's switch as a row says it: `off`, or why the keeper is on (its `KeeperWhy`, verbatim). */
export const keeperOf = (on: boolean, why: string | null): DecisionKeeper => (on ? { on: true, mode: clean(why ?? "on", SHORT_MAX) } : KEEPER_OFF);

// --- one line of a row ------------------------------------------------------------------------------------------

/** One line, at most `max` characters: the wallet as `self`, any address or hash as its 6+4, no key or token, the home folders as `~`. */
export function decisionLine(text: string, max: number, o: { home?: string; wallet?: string | null } = {}): string {
  let t = text;
  if (o.wallet) t = t.split(o.wallet).join("self").split(o.wallet.toLowerCase()).join("self");
  const homes = [{ path: homedir(), as: "~" }, ...(o.home ? [{ path: o.home, as: "<league-home>" }] : [])];
  return clean(scrub(t, { homes, secrets: [] }), max);
}

const RESULT = /^(?:ok|refused|failed)(?:: .+)?$/;

/** `ok`, `refused` or `failed`, and its one sentence when there is one. */
export function decisionResult(kind: "ok" | "refused" | "failed", sentence = "", o: { home?: string; wallet?: string | null } = {}): string {
  const said = decisionLine(sentence, DECISION_RESULT_MAX - kind.length - 2, o);
  return said ? `${kind}: ${said}` : kind;
}

/** The ask journal's `result` as a row's: filled or hold → ok; rejected or dropped by a limit → refused; the rest → failed. */
export function resultOfJournal(result: string): string {
  const m = /^([a-z]+)(?::\s*([\s\S]*))?$/.exec(result.trim());
  const word = m?.[1] ?? "";
  const rest = m?.[2] ?? "";
  if (word === "filled" || word === "hold") return decisionResult("ok", word);
  if (word === "rejected" || word === "dropped") return decisionResult("refused", rest);
  if (word === "failed" || word === "error") return decisionResult("failed", rest);
  if (word === "invalid") return decisionResult("failed", `invalid: ${rest}`);
  if (word === "unknown") return decisionResult("failed", "sent, its outcome is not known yet");
  return decisionResult("failed", result);
}

/** What became of a trade (the runtime's outcome, as `FL buy` reads it) as a row's result: never a transaction hash. */
export function resultOfOutcome(o: { outcome: string; [k: string]: unknown } | null): string {
  if (!o) return decisionResult("failed", "no outcome within 90 s; the running agent may still make it");
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  switch (o.outcome) {
    case "filled":
      return decisionResult("ok", `${o.kind === "sell" ? "sold" : "bought"} ${s("symbol") || "the coin"}${typeof o.bnb === "number" ? ` for ${o.bnb} BNB` : ""}`);
    case "refused":
      return decisionResult("refused", [s("limit"), s("message")].filter(Boolean).join(": "));
    case "failed":
      return decisionResult("failed", [s("stage"), s("reason")].filter(Boolean).join(": "));
    case "unknown":
      return decisionResult("failed", "sent, its outcome is not known yet");
    case "stale":
      return decisionResult("refused", "it went stale before its turn");
    case "nothing":
      return decisionResult("refused", "nothing to sell");
    default:
      return decisionResult("refused", s("reason") || "the runtime did not act on it");
  }
}

// --- the strategy: its kind and 8 hex of its sha256, never its text ---------------------------------------------

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Keys sorted at every depth: the same parameters, the same text. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(walk) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk((v as Record<string, unknown>)[k])])) : typeof v === "bigint" ? v.toString() : v;
  return JSON.stringify(walk(value)) ?? "null";
}

const personas = new Map<string, PersonaKey | null>();
/** The default's style when the text is one of its twelve renderings (six styles, en and zh) for this agent's Agent ID. */
function defaultOf(home: string, name: string, text: string, sha: string): PersonaKey | null {
  let recorded: string | null = null;
  try {
    recorded = recordedAgentId(home);
  } catch {
    recorded = null;
  }
  for (const id of new Set([name, ...(recorded ? [recorded] : [])])) {
    const key = `${id}\n${sha}`;
    if (!personas.has(key)) {
      let persona: PersonaKey | null = null;
      try {
        persona = defaultPersonaOf(text, id);
      } catch {
        // The shipped template cannot be read: the text is taken for the player's own.
      }
      personas.set(key, persona);
    }
    const persona = personas.get(key);
    if (persona) return persona;
  }
  return null;
}

/**
 * `strategy.kind` and `strategy.sha8`: a script → `script` and the script file's bytes; a preset → `preset:<name>` and
 * its canonical parameters; a prompt → `default` (with its style) when it is the shipped default word for word, in
 * either language and any of the six styles, with `<id>` this agent's Agent ID; else `custom`. The prompt's sha256 is
 * the one the pack reads.
 */
export function strategyOf(home: string, agent: Pick<AgentConfig, "name" | "track" | "preset" | "script" | "prompt" | "params">): DecisionStrategy {
  if (agent.track === "script" && agent.script) {
    let sha = agent.script.sha256;
    try {
      sha = sha256Hex(readFileSync(agent.script.path));
    } catch {
      // The file is gone: the bytes it was planned with.
    }
    return { kind: "script", sha8: sha.slice(0, 8) };
  }
  if (agent.track === "preset" && agent.preset) return { kind: `preset:${agent.preset}`.slice(0, SHORT_MAX), sha8: sha256Hex(canonicalJson(agent.params ?? {})).slice(0, 8) };
  const read = agent.prompt ? readPrompt(agent.prompt.path) : null;
  if (!read?.ok) return { kind: "custom", sha8: (agent.prompt?.sha256 ?? sha256Hex("")).slice(0, 8) };
  const persona = defaultOf(home, agent.name, read.text, read.sha256);
  return persona ? { kind: "default", sha8: read.sha256.slice(0, 8), persona } : { kind: "custom", sha8: read.sha256.slice(0, 8) };
}

/** `x-feast-host`, and `/<detail>` when `x-feast-host-detail` is set: who hosts the agent, as the headers say it. */
export function hostTag(env: Record<string, string | undefined> = process.env): string {
  const h = hostHeaders(env);
  return `${h[HOST_HEADER]}${h[HOST_DETAIL_HEADER] ? `/${h[HOST_DETAIL_HEADER]}` : ""}`.slice(0, SHORT_MAX);
}

// --- the row and the ring ---------------------------------------------------------------------------------------

/** One row in the contract's shape: every field within its limit, the reason and the result scrubbed to one line. */
export function decisionRow(
  d: { at: number | string; source: DecisionSource; action: DecisionAction; reason: string; result: string; strategy: DecisionStrategy; keeper: DecisionKeeper },
  o: { home?: string; wallet?: string | null; env?: Record<string, string | undefined> } = {},
): DecisionRow {
  const result = decisionLine(d.result, DECISION_RESULT_MAX, o);
  return {
    at: new Date(d.at).toISOString(),
    source: d.source,
    action: d.action,
    reason: decisionLine(d.reason, DECISION_REASON_MAX, o),
    result: RESULT.test(result) ? result : decisionResult("failed", d.result, o),
    strategy: { kind: d.strategy.kind.slice(0, SHORT_MAX), sha8: d.strategy.sha8, ...(d.strategy.persona ? { persona: d.strategy.persona } : {}) },
    keeper: { on: d.keeper.on, mode: clean(d.keeper.mode, SHORT_MAX) },
    runtime: RUNTIME_RELEASE.slice(0, SHORT_MAX),
    host: hostTag(o.env),
  };
}

/** The ring, oldest first; torn lines skipped. */
export function readDecisions(home: string, name: string): DecisionRow[] {
  const path = decisionsPath(home, name);
  if (!existsSync(path)) return [];
  const rows: DecisionRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as DecisionRow;
      if (typeof row?.at === "string" && Number.isFinite(Date.parse(row.at))) rows.push(row);
    } catch {
      // A torn line is skipped, and gone at the next rewrite.
    }
  }
  return rows;
}

/**
 * One row onto the ring. Its `at` is the ring's order, the cursor's and the site's key, so a row is never at or before
 * the one above it (a decision settled after a later one was written goes 1 ms after it). Past 30 rows, the ring is
 * rewritten whole, atomically, with the newest 30.
 */
export function appendDecision(home: string, name: string, row: DecisionRow): DecisionRow {
  const rows = readDecisions(home, name);
  const lastMs = rows.length > 0 ? Date.parse(rows[rows.length - 1]!.at) : Number.NEGATIVE_INFINITY;
  const kept = Date.parse(row.at) <= lastMs ? { ...row, at: new Date(lastMs + 1).toISOString() } : row;
  if (rows.length + 1 > DECISIONS_KEPT) writeFileAtomic(decisionsPath(home, name), [...rows, kept].slice(-DECISIONS_KEPT).map((r) => `${JSON.stringify(r)}\n`).join(""));
  else appendJsonl(decisionsPath(home, name), kept);
  return kept;
}

export function readDecisionsState(home: string, name: string): DecisionsState {
  try {
    const got = readJson<Partial<DecisionsState>>(decisionsStatePath(home, name));
    const keeper = got?.keeper && typeof got.keeper.on === "boolean" && typeof got.keeper.mode === "string" && typeof got.keeper.at === "string" ? got.keeper : null;
    return { sentThrough: typeof got?.sentThrough === "string" ? got.sentThrough : null, keeper };
  } catch {
    return { sentThrough: null, keeper: null };
  }
}

const writeState = (home: string, name: string, state: DecisionsState) => writeJsonAtomic(decisionsStatePath(home, name), state);

/** The runtime's floor keeper switch, kept for `FL answer`'s rows (another process). Written by the runtime alone. */
export const writeKeeper = (home: string, name: string, keeper: DecisionKeeper, now: number) => writeState(home, name, { ...readDecisionsState(home, name), keeper: { ...keeper, at: new Date(now).toISOString() } });

/** `FL answer`'s row: the running runtime's keeper switch, off when no runtime runs. */
export function appendHostAnswer(home: string, agent: Pick<AgentConfig, "name" | "track" | "preset" | "script" | "prompt" | "params">, d: { at: number; action: DecisionAction; reason: string; result: string }, running: boolean): DecisionRow {
  const kept = readDecisionsState(home, agent.name).keeper;
  const keeper = running && kept ? { on: kept.on, mode: kept.mode } : KEEPER_OFF;
  return appendDecision(home, agent.name, decisionRow({ ...d, source: "host-answer", strategy: strategyOf(home, agent), keeper }, { home }));
}

/** The rows the site has not taken, oldest first: newer than the cursor, and young enough for the site to take. */
export function pendingDecisions(home: string, name: string, now: number): DecisionRow[] {
  const through = readDecisionsState(home, name).sentThrough;
  const throughMs = through !== null && Number.isFinite(Date.parse(through)) ? Date.parse(through) : Number.NEGATIVE_INFINITY;
  return readDecisions(home, name).filter((r) => Date.parse(r.at) > throughMs && Date.parse(r.at) >= now - SEND_BACK_MS);
}

// --- the upload, with the heartbeat -----------------------------------------------------------------------------

export type DecisionsSent = { sent: number; status: number | null; left: number };

/**
 * The oldest rows the site has not taken, at most 3, in one `POST /api/league/decisions` with the notes session's
 * bearer token (`fetch` is the heartbeat's own, so the runtime's headers ride along). The cursor moves only on a 2xx.
 * Anything else (no session, a 4xx, a 5xx, a 404 while the route is not deployed, no answer in 10 s) leaves the rows
 * for the next beat and logs one `decisions.failed` line; it never throws and never tells the player.
 */
export async function sendDecisions(o: { home: string; name: string; site: string; fetch: typeof fetch; token: string | null; now: number; log: (event: string, fields?: Record<string, unknown>) => void; timeoutMs?: number }): Promise<DecisionsSent> {
  let pending: DecisionRow[] = [];
  try {
    pending = pendingDecisions(o.home, o.name, o.now);
    if (pending.length === 0) return { sent: 0, status: null, left: 0 };
    if (!o.token) {
      o.log("decisions.failed", { status: null, why: "no notes session", pending: pending.length });
      return { sent: 0, status: null, left: pending.length };
    }
    const batch = pending.slice(0, DECISIONS_PER_BEAT);
    let answer: Response;
    try {
      answer = await o.fetch(`${o.site.replace(/\/+$/, "")}/api/league/decisions`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ rows: batch }),
        signal: AbortSignal.timeout(o.timeoutMs ?? DECISIONS_TIMEOUT_MS),
      });
    } catch (error) {
      o.log("decisions.failed", { status: null, why: (error as Error).name === "TimeoutError" ? "no answer in time" : "no answer", pending: pending.length });
      return { sent: 0, status: null, left: pending.length };
    }
    const body = (await answer.json().catch(() => null)) as { stored?: unknown; ignored?: unknown; error?: { code?: unknown } } | null;
    if (answer.status < 200 || answer.status > 299) {
      const code = typeof body?.error?.code === "string" ? clean(body.error.code, 40) : null;
      o.log("decisions.failed", { status: answer.status, ...(code ? { code } : {}), pending: pending.length });
      return { sent: 0, status: answer.status, left: pending.length };
    }
    writeState(o.home, o.name, { ...readDecisionsState(o.home, o.name), sentThrough: batch[batch.length - 1]!.at });
    o.log("decisions.sent", { rows: batch.length, stored: typeof body?.stored === "number" ? body.stored : null, ignored: typeof body?.ignored === "number" ? body.ignored : null, left: pending.length - batch.length });
    return { sent: batch.length, status: answer.status, left: pending.length - batch.length };
  } catch (error) {
    o.log("decisions.failed", { status: null, why: clean((error as Error).message, 120) || "the ring could not be read" });
    return { sent: 0, status: null, left: pending.length };
  }
}
