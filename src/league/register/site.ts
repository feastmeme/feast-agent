import { getAddress, isAddress, type Address } from "viem";

import { failureOf, retrying, type Failure, type Retry } from "../feed/backoff.ts";
import { withHostHeaders } from "../headers.ts";

/**
 * The league page's API, as an agent's runtime reads it (docs/PLAN-941.md §4).
 *
 * Bound to 927's `plans/league-20261021/API.md` as of its run 5 — the shipped
 * shapes of `src/app/api/league/register/route.ts` and `src/app/api/league/route.ts`
 * — and tolerant of the two earlier shapes: the sealed route before run 5
 * (no `place`, no `foundingNo`, no `me`) and PLAN-v2 §3's `seat | pending`.
 * Branch on `code`, never on a message: the page writes messages in the
 * request's locale.
 *
 * A POST is never retried here. An answer that never came is reconciled by
 * reading `GET /api/league/register?wallet=` (the flow does that).
 */

export const DEFAULT_SITE = "https://feast.meme";
export const SEAT_CAP = 1_000;

export function siteFromEnv(env: Record<string, string | undefined> = process.env): string {
  return (env.FEAST_LEAGUE_SITE?.trim() || DEFAULT_SITE).replace(/\/+$/, "");
}

export type Prereg = "matched" | "none" | "no-agent-id" | "unavailable" | "unclaimed";

export type Seating =
  | { kind: "seated"; seatNo: number; founding: boolean; foundingNo: number | null; waitlisted: boolean; place: number | null }
  | { kind: "pending"; reason: "no-body-coin" | "no-agent-id" };

/** What the page keeps for a wallet. Only the fields the agent reads. */
export type KeptAgent = {
  agentId: string | null;
  manifesto: string;
  issuedAt: number;
  bodyCoin: Address | null;
  season: number | null;
  seatNo: number | null;
  founding: boolean;
  foundingNo: number | null;
  waitlisted: boolean;
  xHandle: string | null;
  earlyBird: boolean;
};

export type RegisterAnswer =
  | { kind: "kept"; seating: Seating; prereg: Prereg; agent: KeptAgent | null }
  | { kind: "refused"; status: number; code: string; field: string | null }
  | { kind: "no-answer"; reason: string };

export type RegisterBody = {
  wallet: string;
  name: string;
  strategy: string;
  copies: null;
  issuedAt: number;
  scheme: "eip712";
  signature: string;
  signatureRecovery?: string;
  bodyCoin?: string;
  xHandle?: string;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const addr = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null);
const PREREG: readonly Prereg[] = ["matched", "none", "no-agent-id", "unavailable", "unclaimed"];

/** The waitlist place: the page's own `place`, else `seatNo − 1000` (927 API.md: 1 for the 1,001st). */
const placeOf = (seatNo: number, waitlisted: boolean, given: unknown): number | null => (waitlisted ? (num(given) ?? Math.max(1, seatNo - SEAT_CAP)) : null);

export function parseKept(raw: unknown): KeptAgent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const issuedAt = num(a.issuedAt);
  if (issuedAt === null) return null;
  return {
    agentId: typeof a.agentId === "string" ? a.agentId : typeof a.name === "string" ? a.name : null,
    manifesto: typeof a.manifesto === "string" ? a.manifesto : typeof a.strategy === "string" ? a.strategy : "",
    issuedAt,
    bodyCoin: addr(a.bodyCoin),
    season: num(a.season),
    seatNo: num(a.seatNo),
    founding: a.founding === true,
    foundingNo: num(a.foundingNo),
    waitlisted: a.waitlisted === true,
    xHandle: typeof a.xHandle === "string" ? a.xHandle : null,
    earlyBird: a.earlyBird === true,
  };
}

/** The seating a kept agent stands in, read from its own fields. */
export function seatingOfKept(agent: KeptAgent): Seating {
  if (agent.seatNo === null) return { kind: "pending", reason: agent.agentId === null ? "no-agent-id" : "no-body-coin" };
  return { kind: "seated", seatNo: agent.seatNo, founding: agent.founding, foundingNo: agent.foundingNo, waitlisted: agent.waitlisted, place: placeOf(agent.seatNo, agent.waitlisted, null) };
}

function parseSeating(body: Record<string, unknown>, agent: KeptAgent | null): Seating | null {
  const s = body.seating as Record<string, unknown> | undefined;
  if (s && s.state === "seated" && num(s.seatNo) !== null) {
    const seatNo = num(s.seatNo)!;
    const waitlisted = s.waitlisted === true;
    return { kind: "seated", seatNo, founding: s.founding === true, foundingNo: num(s.foundingNo), waitlisted, place: placeOf(seatNo, waitlisted, s.place) };
  }
  if (s && s.state === "pending") return { kind: "pending", reason: s.reason === "no-agent-id" ? "no-agent-id" : "no-body-coin" };
  // PLAN-v2 §3's shape.
  const seat = body.seat as Record<string, unknown> | undefined;
  if (seat && num(seat.no) !== null) {
    const seatNo = num(seat.no)!;
    const waitlisted = seat.waitlisted === true;
    return { kind: "seated", seatNo, founding: seat.founding === true, foundingNo: num(seat.foundingNo), waitlisted, place: placeOf(seatNo, waitlisted, seat.place) };
  }
  if (body.pending === "no-agent-id" || body.pending === "no-body-coin") return { kind: "pending", reason: body.pending };
  return agent ? seatingOfKept(agent) : null;
}

/** One answer of `POST /api/league/register`, read. */
export function parseRegisterAnswer(status: number, body: unknown): RegisterAnswer {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (status === 201 || status === 200) {
    const agent = parseKept(b.agent);
    const seating = parseSeating(b, agent);
    if (!seating) return { kind: "no-answer", reason: "the page answered 201 without a seating" };
    const prereg = PREREG.includes(b.prereg as Prereg) ? (b.prereg as Prereg) : "unclaimed";
    return { kind: "kept", seating, prereg, agent };
  }
  const error = (b.error ?? {}) as Record<string, unknown>;
  const code = typeof error.code === "string" ? error.code : status === 429 ? "rate-limited" : status === 413 || status === 415 ? "bad-request" : status >= 500 ? "unavailable" : "";
  if (!code) return { kind: "no-answer", reason: `the page answered ${status} without a code` };
  return { kind: "refused", status, code, field: typeof error.field === "string" ? error.field : null };
}

// --- GET /api/league ------------------------------------------------------------------------

export type LeagueState = "coming-soon" | "warm-up" | "season" | "over" | "unavailable";

export type EarnerRow = { rank: number | null; wallet: string; name: string; pnlUsd: number; trades: number; hp: number; eatenDay: number | null };
export type BackedRow = { rank: number | null; wallet: string; name: string; hp: number; eatenDay: number | null };

export type LeagueRead = {
  schema: number;
  state: LeagueState;
  season: { number: number; day: number | null; countdownTo: number | null };
  seats: { taken: number; cap: number; founding: number; foundingCap: number; waitlist: number } | null;
  earners: EarnerRow[];
  backed: BackedRow[];
  counts: { earners: number; backed: number };
  /** `me`'s rows from the whole boards (API.md §3); undefined when the page sent none. */
  me?: { earners: EarnerRow | null; backed: BackedRow | null; eaten: { day: number; reason: string | null } | null } | null;
  /** Task 975, addendum 5: the page's `arena.set`, every seated agent in BNB; undefined when the page sent none. */
  arena?: ArenaRow[];
};

/** One agent of the arena (`/api/league`'s `arena.set[]`): names and notes are other players' words. */
export type ArenaRow = { name: string; wallet: string | null; pnlBnb: number; pnlUsd: number | null; seasonBnb: number | null; trades: number; model: string; note: string | null; bodyCoin: string | null; danger: boolean; eaten: boolean; viewer: boolean };

function arenaRow(raw: unknown): ArenaRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const pnl = num(r.pnlBnb);
  if (typeof r.name !== "string" || pnl === null) return null;
  const address = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);
  return {
    name: r.name.slice(0, 64),
    wallet: address(r.wallet),
    pnlBnb: pnl,
    pnlUsd: num(r.pnlUsd),
    seasonBnb: num(r.seasonBnb),
    trades: num(r.trades) ?? 0,
    model: typeof r.model === "string" ? r.model.slice(0, 16) : "other",
    note: typeof r.note === "string" ? r.note.slice(0, 280) : null,
    bodyCoin: address(r.bodyCoin),
    danger: r.danger === true,
    eaten: r.eaten === true,
    viewer: r.viewer === true,
  };
}

const STATES: readonly LeagueState[] = ["coming-soon", "warm-up", "season", "over", "unavailable"];

function earnerRow(raw: unknown): EarnerRow | null {
  const r = (raw ?? null) as Record<string, unknown> | null;
  if (!r || typeof r.wallet !== "string" || typeof r.name !== "string") return null;
  return { rank: num(r.rank), wallet: r.wallet.toLowerCase(), name: r.name, pnlUsd: num(r.pnlUsd) ?? 0, trades: num(r.trades) ?? 0, hp: num(r.hp) ?? 0, eatenDay: num(r.eatenDay) };
}
function backedRow(raw: unknown): BackedRow | null {
  const r = (raw ?? null) as Record<string, unknown> | null;
  if (!r || typeof r.wallet !== "string" || typeof r.name !== "string") return null;
  return { rank: num(r.rank), wallet: r.wallet.toLowerCase(), name: r.name, hp: num(r.hp) ?? 0, eatenDay: num(r.eatenDay) };
}
function eatenOf(raw: unknown): { day: number; reason: string | null } | null {
  if (typeof raw === "number") return { day: raw, reason: null };
  if (typeof raw === "object" && raw !== null && num((raw as { day?: unknown }).day) !== null) {
    const e = raw as { day: number; reason?: unknown };
    return { day: e.day, reason: typeof e.reason === "string" ? e.reason : null };
  }
  return null;
}

/** `GET /api/league`, read: v2's `LeagueWire`, or v1 (what is live before 927 ships), which reads as coming soon. */
export function parseLeague(body: unknown): LeagueRead | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const season = (b.season ?? {}) as Record<string, unknown>;
  if (b.schemaVersion === 1) {
    return { schema: 1, state: "coming-soon", season: { number: num(season.number) ?? 1, day: null, countdownTo: null }, seats: null, earners: [], backed: [], counts: { earners: 0, backed: 0 } };
  }
  if (b.schemaVersion !== 2 || !STATES.includes(b.state as LeagueState)) return null;
  const boards = (b.boards ?? {}) as { earners?: unknown[]; backed?: unknown[] };
  const counts = (b.counts ?? {}) as Record<string, unknown>;
  const seats = b.seats as Record<string, unknown> | null | undefined;
  const countdown = typeof season.countdownTo === "string" ? Date.parse(season.countdownTo) : Number.NaN;
  const read: LeagueRead = {
    schema: 2,
    state: b.state as LeagueState,
    season: { number: num(season.number) ?? 1, day: num(season.day), countdownTo: Number.isFinite(countdown) ? countdown : null },
    seats: seats && num(seats.taken) !== null ? { taken: num(seats.taken)!, cap: num(seats.cap) ?? SEAT_CAP, founding: num(seats.founding) ?? 0, foundingCap: num(seats.foundingCap) ?? 100, waitlist: num(seats.waitlist) ?? 0 } : null,
    earners: (boards.earners ?? []).map(earnerRow).filter((r): r is EarnerRow => r !== null),
    backed: (boards.backed ?? []).map(backedRow).filter((r): r is BackedRow => r !== null),
    counts: { earners: num(counts.earners) ?? 0, backed: num(counts.backed) ?? 0 },
  };
  const arena = (b.arena ?? null) as { set?: unknown } | null;
  if (arena && Array.isArray(arena.set)) read.arena = arena.set.slice(0, 2_000).map(arenaRow).filter((r): r is ArenaRow => r !== null);
  if ("me" in b) {
    const me = b.me as Record<string, unknown> | null;
    read.me = me ? { earners: earnerRow(me.earners), backed: backedRow(me.backed), eaten: eatenOf(me.eaten) } : null;
  }
  return read;
}

// --- the league entry's reads (task 960's routes, for `FL enter`) ---------------------------
// The assignment route (`/api/league/assignment`) may still exist on the site: since the owner's ruling
// of 2026-10-24 the entry is the launch only, and the runtime never reads it.

/** The notes session's request (task 964): the four signed fields, and the signature in the Register body's form. */
export type NoteSessionBody = { wallet: string; agentId: string; season: number; nonce: string; scheme: "eip712"; signature: string; signatureRecovery?: string };

export type NoteSessionAnswer = { kind: "open"; token: string; expiresAt: string | null; season: number | null } | { kind: "unavailable"; reason: string } | { kind: "refused"; status: number; code: string | null };

/** `GET /api/league/agent-id?wallet=`: the page's own read of the wallet's Agent ID and its coins. */
export type PageAgentId =
  | { state: "read"; wallet: string | null; agentId: string | null; coins: { coin: Address; launchedAt: number }[] | null }
  /** 503, a timeout, or no answer at all: ask again in a few minutes. */
  | { state: "unavailable"; reason: string }
  /** Any other answer: not one this agent can read. */
  | { state: "unreadable"; reason: string };

/** `GET /api/league/avatar/<id>.png`, as it came: the agent decides whether to use it. */
export type AvatarAnswer = { state: "answered"; status: number; contentType: string; bytes: Uint8Array; truncated: boolean } | { state: "unavailable"; reason: string };

/** A body read up to `max` bytes and no further: a picture that is too big is known to be, without holding it. */
async function readCapped(response: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, max + 1));
  let at = 0;
  for (const part of parts) {
    const take = part.subarray(0, Math.min(part.length, bytes.length - at));
    bytes.set(take, at);
    at += take.length;
    if (at >= bytes.length) break;
  }
  return { bytes, truncated: size > max };
}

const isTransportError = (error: unknown) => !(error instanceof SyntaxError);

// --- the client ----------------------------------------------------------------------------

export class LeagueSite {
  /** Every request to the site carries the host's and the release's headers (task 975). */
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly base: string = siteFromEnv(),
    fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
    /** Task 967: the GETs back off on a 429, a 5xx or no answer (FL enter's: at most 3 asks, 2 minutes). Never a POST. */
    private readonly retry?: Retry,
  ) {
    this.fetchImpl = withHostHeaders(fetchImpl, [base]);
  }

  /** An answer's status as a failure to ask again after, under the retry policy; null to take it. */
  private failed(status: number, retryAfter: string | null): Failure | null {
    return failureOf(status, retryAfter, this.retry?.now() ?? Date.now());
  }

  private async getJson(path: string, timeoutMs = this.timeoutMs): Promise<{ status: number; body: unknown } | { error: string }> {
    const once = async (): Promise<{ status: number; body: unknown; retryAfter: string | null } | { error: string; status?: number; retryAfter?: string | null }> => {
      try {
        const response = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
        const text = await response.text();
        const retryAfter = response.headers.get("retry-after");
        try {
          return { status: response.status, body: JSON.parse(text) as unknown, retryAfter };
        } catch {
          return { error: `the page answered ${response.status}, not JSON`, status: response.status, retryAfter };
        }
      } catch (error) {
        return { error: (error as Error).message };
      }
    };
    const got = await retrying(this.retry, once, (o) => {
      if ("error" in o) return null;
      const v = o.value;
      if (v.status === undefined) return { status: null, reason: "no answer" };
      return this.failed(v.status, v.retryAfter ?? null);
    });
    return "error" in got ? { error: got.error } : { status: got.status, body: got.body };
  }

  /** What the page keeps for this wallet: an agent, null for none, or unreadable. */
  async kept(wallet: Address): Promise<{ state: "read"; agent: KeptAgent | null } | { state: "unreadable"; reason: string }> {
    const got = await this.getJson(`/api/league/register?wallet=${wallet.toLowerCase()}`);
    if ("error" in got) return { state: "unreadable", reason: got.error };
    if (got.status !== 200) return { state: "unreadable", reason: `the page answered ${got.status}` };
    const agent = (got.body as { agent?: unknown }).agent;
    return { state: "read", agent: agent === null || agent === undefined ? null : parseKept(agent) };
  }

  async register(body: RegisterBody): Promise<RegisterAnswer> {
    try {
      const response = await this.fetchImpl(`${this.base}/api/league/register`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A gateway's page, not the route's answer: whether the POST reached the route is unknown.
        return { kind: "no-answer", reason: `the page answered ${response.status}, not JSON` };
      }
      return parseRegisterAnswer(response.status, parsed);
    } catch (error) {
      return { kind: "no-answer", reason: (error as Error).message };
    }
  }

  /** One GET, asked again once if no answer came (a timeout, a refused connection); an answer, whatever its status, is never asked again. */
  private async getOnce<T>(ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (!isTransportError(error)) throw error;
      return ask();
    }
  }

  /** A GET under the retry policy when there is one (by its status, or no answer); otherwise `getOnce`, as before. */
  private asked<T extends { status: number; retryAfter?: string | null }>(ask: () => Promise<T>): Promise<T> {
    if (!this.retry) return this.getOnce(ask);
    return retrying(this.retry, ask, (o) => ("error" in o ? (isTransportError(o.error) ? { status: null, reason: "no answer" } : null) : this.failed(o.value.status, o.value.retryAfter ?? null)));
  }

  private async getRaw(path: string): Promise<{ status: number; text: string; contentType: string; retryAfter: string | null }> {
    const response = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    return { status: response.status, text: await response.text(), contentType: response.headers.get("content-type") ?? "", retryAfter: response.headers.get("retry-after") };
  }

  /** The page's read of this wallet's Agent ID (task 960): `{ wallet, agentId, coins }`, or 503 `upstream-unavailable`. */
  async agentIdOnPage(wallet: Address): Promise<PageAgentId> {
    let got: { status: number; text: string };
    try {
      got = await this.asked(() => this.getRaw(`/api/league/agent-id?wallet=${wallet.toLowerCase()}`));
    } catch (error) {
      return { state: "unavailable", reason: (error as Error).message };
    }
    if (got.status === 503) return { state: "unavailable", reason: "HTTP 503" };
    if (got.status !== 200) return { state: "unreadable", reason: `HTTP ${got.status}` };
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(got.text) as Record<string, unknown>;
    } catch {
      return { state: "unreadable", reason: "HTTP 200, not JSON" };
    }
    if (typeof body !== "object" || body === null || !("agentId" in body)) return { state: "unreadable", reason: "HTTP 200 without an agentId" };
    const coins = Array.isArray(body.coins)
      ? body.coins.flatMap((c: unknown) => {
          const row = c as { coin?: unknown; launchedAt?: unknown };
          const coin = addr(row?.coin);
          return coin ? [{ coin, launchedAt: Date.parse(typeof row.launchedAt === "string" ? row.launchedAt : "") || 0 }] : [];
        })
      : null;
    return { state: "read", wallet: typeof body.wallet === "string" ? body.wallet.toLowerCase() : null, agentId: typeof body.agentId === "string" ? body.agentId : null, coins };
  }

  /** The league's picture of an agent (task 960), read up to `maxBytes` (and one byte more, to know it is too big). */
  async avatar(agentId: string, maxBytes: number): Promise<AvatarAnswer> {
    try {
      return await this.asked(async () => {
        const response = await this.fetchImpl(`${this.base}/api/league/avatar/${agentId}.png`, { headers: { accept: "image/png" }, signal: AbortSignal.timeout(this.timeoutMs) });
        const declared = Number(response.headers.get("content-length") ?? "");
        const contentType = response.headers.get("content-type") ?? "";
        if (response.status !== 200 || (Number.isFinite(declared) && declared > maxBytes)) {
          await response.body?.cancel().catch(() => {});
          return { state: "answered" as const, status: response.status, contentType, bytes: new Uint8Array(), truncated: response.status === 200 };
        }
        const { bytes, truncated } = await readCapped(response, maxBytes);
        return { state: "answered" as const, status: response.status, contentType, bytes, truncated };
      });
    } catch (error) {
      return { state: "unavailable", reason: (error as Error).message };
    }
  }

  /**
   * `POST /api/league/notes/session` (task 964): one signed NoteSession for a bearer token, season-scoped.
   * 404, 405, 429, a 5xx or no answer: the route is not there (yet). Any other 4xx: refused, with the page's code.
   * The token goes into a header later, so only a plain one (printable, no spaces, at most 4 KB) is taken.
   */
  async noteSession(body: NoteSessionBody): Promise<NoteSessionAnswer> {
    let status: number;
    let parsed: Record<string, unknown> = {};
    try {
      const response = await this.fetchImpl(`${this.base}/api/league/notes/session`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = response.status;
      const text = await response.text();
      try {
        const json = JSON.parse(text) as unknown;
        if (typeof json === "object" && json !== null) parsed = json as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    } catch (error) {
      return { kind: "unavailable", reason: (error as Error).message };
    }
    if (status >= 200 && status < 300) {
      const token = parsed.token;
      if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token)) return { kind: "unavailable", reason: `HTTP ${status} without a token this agent can use` };
      const expiresAt = typeof parsed.expiresAt === "string" && Number.isFinite(Date.parse(parsed.expiresAt)) ? new Date(Date.parse(parsed.expiresAt)).toISOString() : null;
      return { kind: "open", token, expiresAt, season: num(parsed.season) };
    }
    if (status === 404 || status === 405 || status === 429 || status >= 500) return { kind: "unavailable", reason: `HTTP ${status}` };
    const error = (parsed.error ?? {}) as Record<string, unknown>;
    const code = typeof parsed.code === "string" ? parsed.code : typeof error.code === "string" ? error.code : null;
    return { kind: "refused", status, code };
  }

  /** The league for one view; `me` adds the wallet's own rows (uncached on the page's side). */
  async league(view: "today" | "season", me: Address | null, timeoutMs = 8_000): Promise<LeagueRead | null> {
    const got = await this.getJson(`/api/league?view=${view}&limit=100${me ? `&me=${me.toLowerCase()}` : ""}`, timeoutMs);
    if ("error" in got || got.status !== 200) return null;
    return parseLeague(got.body);
  }
}
