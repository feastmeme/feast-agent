import { getAddress, isAddress, type Address } from "viem";

import { FLOW_WINDOW_MS } from "./picture.ts";

/**
 * Who in the league bought or sold what in the last two minutes (task 1020, the owner's ruling D for league-v5.1.4):
 * the snapshot's events tail, each trade's payer joined to a seat's name by the league's field (or its arena), so the
 * player's AI can play against its rivals. A payer with no seat is "someone"; this wallet's own trades are "you".
 * Never an address: the payer is used for the join and dropped. Names are other players' words: the pack shows them
 * inside an UNTRUSTED fence.
 */

export const PLAYER_TRADES_MAX = 12;

/** `who`: the seat's bare name (no `.ai`), or null for someone with no seat; `you`: this wallet's own trade. */
export type PlayerTrade = { who: string | null; you: boolean; side: "buy" | "sell"; coin: Address; bnb: number; at: number };

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
export function playerTrades(events: Record<string, unknown>[], now: number, roster: Map<string, string>, bnbPerQuote: (quote: string) => number | null, self: string | null, windowMs = FLOW_WINDOW_MS): PlayerTrade[] {
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
    out.push({ who: you ? null : roster.get(payer) ?? null, you, side: e.buy === true || e.side === "buy" ? "buy" : "sell", coin: getAddress(e.coin), bnb: Number(((Number(amount) / 1e18) * q).toFixed(6)), at, i });
  });
  return out
    .sort((a, b) => b.at - a.at || b.i - a.i)
    .slice(0, PLAYER_TRADES_MAX)
    .map(({ i: _i, ...t }) => t);
}
