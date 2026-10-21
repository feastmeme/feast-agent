import { getAddress, isAddress, type Address } from "viem";

/**
 * STUB, NOT USED IN V1: the copy preset's later `source: leaderboard`.
 *
 * The league page will expose `GET /api/league?w=<season|today|YYYY-MM-DD>&limit=<n>`,
 * rows `{ rank, wallet, name, figures, window, asOf }`. When it is live, the copy
 * preset follows the wallets of its top `topN` rows instead of a configured list.
 * Until then `resolveParams` refuses `source: leaderboard`, and nothing calls
 * this reader outside its tests. It expects exactly that shape and refuses
 * anything else, so a change on the page's side fails loudly here rather than
 * copying the wrong wallets.
 */

export type LeaderboardWindow = "season" | "today" | `${number}-${number}-${number}`;

export type LeaderboardRow = { rank: number; wallet: Address; name: string; figures: Record<string, unknown>; window: string; asOf: string };

export function leaderboardUrl(siteUrl: string, window: LeaderboardWindow, limit: number): string {
  if (!(window === "season" || window === "today" || /^\d{4}-\d{2}-\d{2}$/.test(window))) throw new Error(`a leaderboard window is season, today or YYYY-MM-DD (got ${window})`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("a leaderboard limit is 1–100");
  return `${siteUrl.replace(/\/+$/, "")}/api/league?w=${window}&limit=${limit}`;
}

/** The rows, validated; refuses a page whose rows are not the agreed shape. */
export function parseLeaderboard(body: unknown): LeaderboardRow[] {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { rows?: unknown }).rows) ? (body as { rows: unknown[] }).rows : null;
  if (!rows) throw new Error("the league leaderboard answered without rows");
  return rows.map((row, i) => {
    const r = row as Record<string, unknown>;
    const ok =
      typeof r.rank === "number" &&
      Number.isInteger(r.rank) &&
      typeof r.wallet === "string" &&
      isAddress(r.wallet, { strict: false }) &&
      typeof r.name === "string" &&
      r.figures !== null &&
      typeof r.figures === "object" &&
      typeof r.window === "string" &&
      typeof r.asOf === "string";
    if (!ok) throw new Error(`leaderboard row ${i} is not { rank, wallet, name, figures, window, asOf }`);
    return { rank: r.rank as number, wallet: getAddress(r.wallet as string), name: r.name as string, figures: r.figures as Record<string, unknown>, window: r.window as string, asOf: r.asOf as string };
  });
}

/** The top `topN` wallets of a window, by rank. */
export async function leaderWallets(siteUrl: string, window: LeaderboardWindow, topN: number, fetchImpl: typeof fetch = fetch): Promise<Address[]> {
  const response = await fetchImpl(leaderboardUrl(siteUrl, window, topN), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`the league leaderboard answered HTTP ${response.status}`);
  return parseLeaderboard(await response.json())
    .sort((a, b) => a.rank - b.rank)
    .slice(0, topN)
    .map((row) => row.wallet);
}
