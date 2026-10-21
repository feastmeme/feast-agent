import { getAddress, isAddress, type Address } from "viem";

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
};

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
  if ("me" in b) {
    const me = b.me as Record<string, unknown> | null;
    read.me = me ? { earners: earnerRow(me.earners), backed: backedRow(me.backed), eaten: eatenOf(me.eaten) } : null;
  }
  return read;
}

// --- the client ----------------------------------------------------------------------------

export class LeagueSite {
  constructor(
    readonly base: string = siteFromEnv(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private async getJson(path: string, timeoutMs = this.timeoutMs): Promise<{ status: number; body: unknown } | { error: string }> {
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text) as unknown };
      } catch {
        return { error: `the page answered ${response.status}, not JSON` };
      }
    } catch (error) {
      return { error: (error as Error).message };
    }
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
        return response.status >= 500 || response.status === 429 ? parseRegisterAnswer(response.status, null) : { kind: "no-answer", reason: `the page answered ${response.status}, not JSON` };
      }
      return parseRegisterAnswer(response.status, parsed);
    } catch (error) {
      return { kind: "no-answer", reason: (error as Error).message };
    }
  }

  /** The league for one view; `me` adds the wallet's own rows (uncached on the page's side). */
  async league(view: "today" | "season", me: Address | null, timeoutMs = 8_000): Promise<LeagueRead | null> {
    const got = await this.getJson(`/api/league?view=${view}&limit=100${me ? `&me=${me.toLowerCase()}` : ""}`, timeoutMs);
    if ("error" in got || got.status !== 200) return null;
    return parseLeague(got.body);
  }
}
