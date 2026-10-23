import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAddress, isAddress, type Address } from "viem";

import { RECHECK_MS } from "../feed/snapshot.ts";
import { readJson, writeJsonAtomic } from "../store.ts";
import { untrusted, type Untrusted } from "./untrusted.ts";

/**
 * `FL data`'s read-only `notes` section (task 968; the coordinator's addendum 2, gap C13): the public notes feed,
 * `GET <site>/api/league/notes?since=<2 h ago>&limit=100` (task 964), so a host can read the crowd. At most one
 * request a call, none when the home's copy is fresher than 60 s, and none for 10 minutes after the route answered
 * 404 (not deployed): the section is then empty, with `available: false`. Each note is
 * `{ agent, model, coin, symbol, side, sizeBnb, text, ts }`; the agent, the symbol and the text are other players'
 * words, marked untrusted. Per coin: how many distinct agents noted it, and their share of all noting agents. No
 * wallet address is written to the home: an agent the feed names only by its wallet is counted by a hash of it.
 */

export const NOTES_WINDOW_MS = 2 * 3_600_000;
export const NOTES_LIMIT = 100;
export const NOTES_TTL_MS = 60_000;

export type NoteOut = { agent: Untrusted | null; model: string; coin: Address | null; symbol: Untrusted | null; side: "buy" | "sell" | null; sizeBnb: number | null; text: Untrusted; ts: string };
export type CrowdRow = { coin: Address; symbol: Untrusted | null; agents: number; share: number };
export type NotesSection = { available: boolean; since: string; items: NoteOut[]; crowd: CrowdRow[]; agents: number; stale?: { since: string; reason: string } };

type Kept = NoteOut & { key: string };
type CacheFile = { version: 1; at: number | null; unavailableAt: number | null; since: string | null; items: Kept[] };

export const notesCachePath = (home: string) => join(home, "cache", "notes.json");

const MODELS = new Set(["grok", "codex", "claude", "other"]);

/** One note of the feed, read: null when it is not one. The wallet stays in memory, as a key only. */
function noteOf(raw: unknown): Kept | null {
  const n = (raw ?? {}) as Record<string, unknown>;
  const agent = (n.agent ?? {}) as { name?: unknown; wallet?: unknown };
  const ts = typeof n.ts === "string" && Number.isFinite(Date.parse(n.ts)) ? new Date(Date.parse(n.ts)).toISOString() : null;
  if (!ts || typeof n.text !== "string") return null;
  const name = typeof agent.name === "string" && agent.name.length > 0 ? agent.name : null;
  const wallet = typeof agent.wallet === "string" ? agent.wallet.toLowerCase() : null;
  const key = name ? `n:${name.toLowerCase()}` : wallet ? `w:${createHash("sha256").update(wallet).digest("hex").slice(0, 12)}` : null;
  if (!key) return null;
  const coin = (n.coin ?? null) as { address?: unknown; symbol?: unknown } | null;
  const address = coin && typeof coin.address === "string" && isAddress(coin.address, { strict: false }) ? getAddress(coin.address) : null;
  const size = typeof n.sizeBnb === "number" && Number.isFinite(n.sizeBnb) ? n.sizeBnb : null;
  return {
    key,
    agent: name ? untrusted(name) : null,
    model: typeof n.model === "string" && MODELS.has(n.model) ? n.model : "other",
    coin: address,
    symbol: address && typeof coin?.symbol === "string" ? untrusted(coin.symbol) : null,
    side: n.side === "buy" || n.side === "sell" ? n.side : null,
    sizeBnb: size,
    text: untrusted(n.text),
    ts,
  };
}

/** The crowd: per coin, the distinct agents that noted it, and their share of every agent that noted a coin. */
export function crowdOf(items: { key: string; coin: Address | null; symbol: Untrusted | null }[]): { crowd: CrowdRow[]; agents: number } {
  const byCoin = new Map<string, { coin: Address; symbol: Untrusted | null; keys: Set<string> }>();
  const all = new Set<string>();
  for (const item of items) {
    if (!item.coin) continue;
    all.add(item.key);
    const k = item.coin.toLowerCase();
    const row = byCoin.get(k) ?? { coin: item.coin, symbol: item.symbol, keys: new Set<string>() };
    row.keys.add(item.key);
    byCoin.set(k, row);
  }
  const crowd = [...byCoin.values()].map((r) => ({ coin: r.coin, symbol: r.symbol, agents: r.keys.size, share: all.size > 0 ? Number((r.keys.size / all.size).toFixed(3)) : 0 })).sort((a, b) => b.agents - a.agents || a.coin.localeCompare(b.coin));
  return { crowd, agents: all.size };
}

const section = (available: boolean, since: string, items: Kept[], stale?: NotesSection["stale"]): NotesSection => {
  const { crowd, agents } = crowdOf(items);
  return { available, since, items: items.map(({ key: _key, ...rest }) => rest), crowd, agents, ...(stale ? { stale } : {}) };
};

/**
 * The section, by at most one GET through `get` (FL data's own: asked again once only if no answer came; a 429 stops
 * the reads). A failure that is not a 404 keeps the home's last copy, marked stale; never a problem of the call.
 */
export async function notesSection(o: { home: string; site: string; now: number; get: (url: string) => Promise<{ status: number; body: unknown } | { error: string }> }): Promise<NotesSection> {
  const path = notesCachePath(o.home);
  const cache = readJson<CacheFile>(path);
  const since = new Date(o.now - NOTES_WINDOW_MS).toISOString();
  const recent = (items: Kept[]) => items.filter((i) => Date.parse(i.ts) >= o.now - NOTES_WINDOW_MS);
  if (cache?.version === 1 && cache.unavailableAt !== null && o.now - cache.unavailableAt >= 0 && o.now - cache.unavailableAt < RECHECK_MS) return section(false, since, []);
  if (cache?.version === 1 && cache.at !== null && o.now - cache.at >= 0 && o.now - cache.at < NOTES_TTL_MS) return section(true, cache.since ?? since, recent(cache.items));
  const got = await o.get(`${o.site}/api/league/notes?since=${encodeURIComponent(since)}&limit=${NOTES_LIMIT}`);
  if (!("error" in got) && (got.status === 404 || got.status === 410)) {
    writeJsonAtomic(path, { version: 1, at: null, unavailableAt: o.now, since: null, items: [] } satisfies CacheFile);
    return section(false, since, []);
  }
  const notes = !("error" in got) && got.status === 200 ? (got.body as { notes?: unknown })?.notes : undefined;
  if (!Array.isArray(notes)) {
    const reason = "error" in got ? got.error : `HTTP ${got.status}`;
    const held = cache?.version === 1 && cache.at !== null ? recent(cache.items) : [];
    return section(held.length > 0, since, held, cache?.at ? { since: new Date(cache.at).toISOString(), reason } : { since, reason });
  }
  const items = notes.map(noteOf).filter((n): n is Kept => n !== null).slice(0, NOTES_LIMIT);
  writeJsonAtomic(path, { version: 1, at: o.now, unavailableAt: null, since, items } satisfies CacheFile);
  return section(true, since, items);
}
