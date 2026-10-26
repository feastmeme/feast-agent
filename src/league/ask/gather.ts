import { join } from "node:path";
import type { Address } from "viem";

import type { AgentConfig } from "../agent.ts";
import { notesCachePath } from "../data/notes.ts";
import { exitImpacts, picture, type Picture } from "../data/picture.ts";
import { playerTrades, rosterOf } from "../data/players.ts";
import { selfView, type SelfChain } from "../data/self.ts";
import { fromArena, fromField, readStanding, RULES, standing } from "../data/standing.ts";
import type { FeastSnapshot } from "../feed/snapshot.ts";
import { leftOut } from "../prompt/floor.ts";
import { readPrompt } from "../prompt/host.ts";
import { LeagueSite, type LeagueRead } from "../register/site.ts";
import { readJson } from "../store.ts";
import { readAskState, readJournal } from "./journal.ts";
import { buildPack, type Pack, type PackInput, type PackNote } from "./pack.ts";

/**
 * The pack's input, gathered (task 975, addenda 4 and 5), the same way for the runtime's ask and `FL ask --print`:
 * the agent's own figures from `selfView` (the book the runtime saves, marked on the chain, its wallet, headroom,
 * fills), the league's arena from one `/api/league?view=today&limit=100`, and the market picture (`picture.ts`) from
 * the snapshot the caller holds, 5-minute candles for the coins that matter, and the quoter's impacts. Every request
 * to feast.meme is counted; with the candles cached 60 s a tick stays under about 30.
 */

export type GatherDeps = {
  home: string;
  agent: AgentConfig;
  now: number;
  wallet: Address | null;
  chain: SelfChain & { quoteBnbE18(quote: Address): Promise<bigint> };
  snapshot: FeastSnapshot | null;
  fetch: typeof fetch;
  site: string;
  gate: { opensAt: number | null; open: boolean; noFloorTonight?: boolean; signInEndsAt?: number | null };
  feast: Address | null;
  impacts?: { buy: (coin: Address, bnb: number) => Promise<number | null>; exit: (coin: Address, coins: bigint) => Promise<number | null> };
  /** The league's read, when the caller already has it (tests); default one GET. */
  league?: LeagueRead | null;
};

/** The public notes `FL data` last cached here (`data/notes.ts`): their text and symbols are other players' words. */
export function cachedNotes(home: string, count = 5): PackNote[] {
  const cache = readJson<{ items?: unknown[] }>(notesCachePath(home));
  const text = (v: unknown) => (typeof v === "string" ? v : typeof (v as { text?: unknown })?.text === "string" ? String((v as { text: string }).text) : null);
  return (Array.isArray(cache?.items) ? cache.items : [])
    .map((raw) => {
      const n = (raw ?? {}) as { ts?: unknown; side?: unknown; symbol?: unknown; text?: unknown };
      return { ts: typeof n.ts === "string" ? n.ts : "", side: typeof n.side === "string" ? n.side : null, symbol: text(n.symbol), text: text(n.text) ?? "" };
    })
    .filter((n) => n.ts && n.text)
    .slice(-count);
}

export async function gatherPack(d: GatherDeps): Promise<{ pack: Pack; input: PackInput; requests: number; quotes: number; from: Picture["from"] | null }> {
  let requests = 0;
  const counted = ((input: string | URL | Request, init?: RequestInit) => ((requests += 1), d.fetch(input, init))) as typeof fetch;
  const get = async (url: string): Promise<{ status: number; body: unknown } | { error: string }> => {
    try {
      const response = await counted(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      const text = await response.text();
      return { status: response.status, body: (() => { try { return JSON.parse(text) as unknown; } catch { return null; } })() };
    } catch (error) {
      return { error: String((error as Error).message).slice(0, 120) };
    }
  };
  const mine = await selfView(d.home, d.agent.name, { chain: d.chain, now: d.now, wallet: d.wallet });
  // The cached field, never the uncached me= read unless the site is older (addendum 6).
  const leagueRead = d.league !== undefined ? { read: d.league, standing: d.league?.field ? { ...standing(fromField(d.league.field), d.wallet), from: "field" as const } : d.league?.arena ? { ...standing(fromArena(d.league.arena), d.wallet), from: "arena" as const } : null } : await readStanding(new LeagueSite(d.site, counted, 8_000), d.wallet);
  const league = leagueRead.read;
  const own = leftOut(d.home, mine.ownCoin[0]?.coin ?? null);
  for (const c of mine.ownCoin) own.add(c.coin.toLowerCase());
  const pictured = await picture({
    now: d.now,
    snapshot: d.snapshot,
    quoteBnb: async (q) => Number(await d.chain.quoteBnbE18(q)) / 1e18,
    get,
    site: d.site,
    cacheDir: join(d.home, "cache"),
    impact: d.impacts?.buy,
    held: [...mine.positions, ...mine.ownCoin].map((p) => p.coin),
    own,
  });
  // The exit impacts after the picture (addendum 6): the server's sale table first, the local quoter only where it falls short.
  const exits = await exitImpacts([...mine.positions, ...mine.ownCoin], pictured, d.impacts?.exit);
  const read = d.agent.prompt ? readPrompt(d.agent.prompt.path) : null;
  const state = readAskState(d.home, d.agent.name);
  const sha = read?.ok ? read.sha256 : null;
  const input: PackInput = {
    name: d.agent.name,
    now: d.now,
    limits: d.agent.limits,
    prompt: { text: read?.ok ? read.text : null, sha256: sha, changed: state.promptSha !== null && sha !== null && state.promptSha !== sha },
    season: { opensAt: d.gate.opensAt, open: d.gate.open, state: league?.state ?? null, day: league?.season.day ?? null, noFloorTonight: d.gate.noFloorTonight === true },
    signInEndsAt: d.gate.signInEndsAt ?? null,
    day: mine.day,
    wallet: mine.wallet,
    headroom: mine.headroom,
    positions: [...mine.positions, ...mine.ownCoin],
    pnl: { realizedBnb: mine.pnl.realizedBnb, unrealizedBnb: mine.pnl.unrealizedBnb, gasBnb: mine.pnl.gasBnb },
    lastTradeAt: mine.lastTradeAt,
    fills: mine.recentFills,
    avgGasBnb: mine.avgGasBnb,
    gas: { buyBnb: mine.gasEstimate.buyBnb, sellBnb: mine.gasEstimate.sellBnb },
    market: d.snapshot ? pictured.market : null,
    coins: pictured.coins,
    launches: pictured.launches,
    // Task 1020: who in the league bought or sold what in the last 2 minutes, joined by the field's (or the arena's) wallets.
    players: playerTrades(d.snapshot?.events ?? [], d.now, rosterOf(league?.field ?? league?.arena), (q) => pictured.bnbPerQuote?.[q] ?? null, d.wallet),
    quiet: pictured.quiet,
    standing: leagueRead.standing,
    rules: RULES,
    own,
    notes: cachedNotes(d.home),
    journal: readJournal(d.home, d.agent.name),
    memo: state.memo,
  };
  return { pack: buildPack(input), input, requests, quotes: (pictured.quotes ?? 0) + exits.quoted, from: pictured.from ?? null };
}
