import { getAddress, isAddress, type Address } from "viem";

import { FLOW_WINDOW_MS } from "./picture.ts";

/**
 * Who in the league bought or sold what in the last two minutes (task 1020, the owner's ruling D for league-v5.1.4):
 * the snapshot's events tail, each trade's payer joined to a seat's name by the league's field (or its arena), so the
 * player's AI can play against its rivals. A payer with no seat is "someone"; this wallet's own trades are "you".
 * Never an address: the payer is used for the join and dropped. Names are other players' words: the pack shows them
 * inside an UNTRUSTED fence.
 */

/** Run 26 (item 8, the owner's 08:0x ruling): at most 20 rows. */
export const PLAYER_TRADES_MAX = 20;
/** Run 26 (item 8): the window is since this agent's previous pack, at most 15 minutes (the first pack: 15). */
export const PLAYER_WINDOW_MAX_MS = 15 * 60_000;

/**
 * `who`: the seat's bare name (no `.ai`), or null for someone with no seat; `you`: this wallet's own trade; `rank`
 * (run 26, item 7): the seat's rank in the league read the pack already makes, or null (someone, you, or unranked).
 */
export type PlayerTrade = { who: string | null; you: boolean; side: "buy" | "sell"; coin: Address; bnb: number; at: number; rank?: number | null };

/** Item 8: the players' window for a pack built `now`, the previous one built at `previousAt` (null: none yet). */
export function playersWindowMs(now: number, previousAt: number | null | undefined): number {
  if (previousAt === null || previousAt === undefined || !Number.isFinite(previousAt) || previousAt >= now) return PLAYER_WINDOW_MAX_MS;
  return Math.min(PLAYER_WINDOW_MAX_MS, now - previousAt);
}

/** The seats' ranks by wallet (lowercase), from the same rows as `rosterOf`. */
export function ranksOf(rows: { wallet: string | null; rank?: number | null }[] | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows ?? []) if (r.wallet && /^0x[0-9a-fA-F]{40}$/.test(r.wallet) && typeof r.rank === "number" && Number.isInteger(r.rank) && r.rank > 0) out.set(r.wallet.toLowerCase(), r.rank);
  return out;
}

/**
 * Item 10 (the owner's 08:1x ruling, the cold arena): the league's trades in the last `windowMs` (default 15 minutes),
 * any coin: a seated player's or this wallet's; a wallet with no seat is not counted.
 */
export function leagueTradeCount(events: readonly Record<string, unknown>[], now: number, roster: Map<string, string>, self: string | null, windowMs = PLAYER_WINDOW_MAX_MS): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "trade" || typeof e.payer !== "string") continue;
    const at = Date.parse(String(e.at));
    if (!Number.isFinite(at) || at > now || now - at > windowMs) continue;
    const payer = e.payer.toLowerCase();
    if (payer === "self" || (self !== null && payer === self.toLowerCase()) || roster.has(payer)) n += 1;
  }
  return n;
}

const wei = (raw: unknown) => (typeof raw === "string" && /^\d{1,80}$/.test(raw) ? BigInt(raw) : null);

/** The seats' names by wallet (lowercase), from the field's or the arena's rows. */
export function rosterOf(rows: { wallet: string | null; name: string }[] | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows ?? []) if (r.wallet && /^0x[0-9a-fA-F]{40}$/.test(r.wallet)) out.set(r.wallet.toLowerCase(), r.name.trim().replace(/\.ai$/i, ""));
  return out;
}

/**
 * The tail's trades of the last `windowMs`, newest first, at most PLAYER_TRADES_MAX. A trade's BNB is its quote
 * amount at the quote's BNB value (`bnbPerQuote`: 1 for WBNB; null skips the trade). `self`: this wallet, or null
 * (the home's cache writes it as "self").
 */
export function playerTrades(events: Record<string, unknown>[], now: number, roster: Map<string, string>, bnbPerQuote: (quote: string) => number | null, self: string | null, windowMs = FLOW_WINDOW_MS, ranks: Map<string, number> = new Map()): PlayerTrade[] {
  const out: (PlayerTrade & { i: number })[] = [];
  events.forEach((e, i) => {
    if (e.type !== "trade" || typeof e.coin !== "string" || !isAddress(e.coin, { strict: false }) || typeof e.quote !== "string" || typeof e.payer !== "string") return;
    const at = Date.parse(String(e.at));
    if (!Number.isFinite(at) || at > now || now - at > windowMs) return;
    const q = bnbPerQuote(e.quote.toLowerCase());
    const amount = wei(e.quoteAmount);
    if (q === null || amount === null) return;
    const payer = e.payer.toLowerCase();
    const you = payer === "self" || (self !== null && payer === self.toLowerCase());
    const who = you ? null : roster.get(payer) ?? null;
    out.push({ who, you, side: e.buy === true || e.side === "buy" ? "buy" : "sell", coin: getAddress(e.coin), bnb: Number(((Number(amount) / 1e18) * q).toFixed(6)), at, ...(who !== null ? { rank: ranks.get(payer) ?? null } : {}), i });
  });
  return out
    .sort((a, b) => b.at - a.at || b.i - a.i)
    .slice(0, PLAYER_TRADES_MAX)
    .map(({ i: _i, ...t }) => t);
}
