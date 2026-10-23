import { getAddress, isAddress, type Address } from "viem";

import { failureOf, retrying, type Retry } from "../feed/backoff.ts";
import type { PresetId } from "../presets/specs.ts";

/**
 * The two unsigned claims a registration carries (docs/PLAN-941.md §2, §3):
 * the body coin, which the page accepts only when the chain says this wallet
 * launched it, and the X handle, matched against the pre-registration roster
 * for the early-bird mark.
 */

/** The body coin's fee split: the product's default (the launch form, the launch preset, packet §1): 20 points burned, 10 to referrers. */
export const BODY_COIN_SPLIT = { burn: 20, referrer: 10 } as const;

/** The pair a body coin launches against unless the user names a tokenized stock (the go's Q5). */
export const BODY_COIN_QUOTE = "WBNB";

/** An X handle as 930's roster stores it, from `@h`, `h`, or an x.com / twitter.com link. Null: not one. */
export function normalizeXHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  const link = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i.exec(text);
  if (link) text = link[1]!;
  text = text.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(text) ? text : null;
}

/** The body coin's name and ticker from the Agent ID: `<id>.ai` within 32 characters, the id upper-cased within 10. */
export function bodyCoinNames(agentId: string): { name: string; symbol: string } {
  return { name: `${agentId.slice(0, 29)}.ai`, symbol: agentId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) };
}

export type IndexedLaunch = { coin: Address; launchedAt: number };

/** The coins this wallet launched, newest first, from the indexer's `/v1/creators`; null when it cannot be read. */
export async function launchesBy(wallet: Address, options: { indexer: string; fetch?: typeof fetch; timeoutMs?: number; retry?: Retry }): Promise<IndexedLaunch[] | null> {
  try {
    // Under a retry policy (FL enter's, task 967) a 429, a 5xx or no answer is asked again after the backoff's wait.
    const ask = () => (options.fetch ?? fetch)(`${options.indexer.replace(/\/+$/, "")}/v1/creators`, { signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    const response = await retrying(options.retry, ask, (o) => ("error" in o ? { status: null, reason: "no answer" } : failureOf(o.value.status, o.value.headers.get("retry-after"), options.retry?.now() ?? Date.now())));
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    const who = wallet.toLowerCase();
    return body.data
      .filter((row): row is { coin: string; creator: string; launchedAt?: string } => typeof row?.coin === "string" && typeof row?.creator === "string" && isAddress(row.coin, { strict: false }))
      .filter((row) => row.creator.toLowerCase() === who)
      .map((row) => ({ coin: getAddress(row.coin), launchedAt: Date.parse(row.launchedAt ?? "") || 0 }))
      .sort((a, b) => b.launchedAt - a.launchedAt);
  } catch {
    return null;
  }
}

/** Who the factory says launched a coin: an address, null for no Feast coin, or unreadable. */
export type CreatorOf = (coin: Address) => Promise<Address | null | "unreadable">;

export type BodyCoinInput = {
  wallet: Address;
  /** `--body-coin`, as the user gave it. */
  named: string | null;
  /** What the page keeps for this wallet: once seated in a season, its body coin is fixed. */
  kept: { bodyCoin: string | null; seated: boolean } | null;
  /** This agent's own launch, receipt-checked when it was booked. */
  bookLaunch: Address | null;
  /** The indexer's list; null when it could not be read. */
  indexed: IndexedLaunch[] | null;
  /** The agent's preset, and whether it has launched. */
  preset: PresetId | null;
  creatorOf: CreatorOf;
};

export type BodyCoinPlan =
  | { kind: "coin"; coin: Address; why: "fixed" | "named" | "book" | "only" | "newest"; others: Address[]; launchedAt: number | null }
  | { kind: "bad-address"; given: string }
  | { kind: "not-yours"; coin: Address }
  | { kind: "unreadable" }
  | { kind: "ask-address" }
  | { kind: "await-preset-launch" }
  | { kind: "launch" };

/**
 * The decision tree of PLAN-941 §2, in its order. Every coin is checked on the
 * chain before it is proposed; a check the chain could not answer is never a
 * yes. The claim is always sent explicitly, so the page never falls back to
 * its "newest coin" read of an index that may lag a launch.
 */
export async function bodyCoinPlan(input: BodyCoinInput): Promise<BodyCoinPlan> {
  const mine = async (coin: Address): Promise<"yes" | "no" | "unreadable"> => {
    const creator = await input.creatorOf(coin).catch(() => "unreadable" as const);
    if (creator === "unreadable") return "unreadable";
    return creator !== null && creator.toLowerCase() === input.wallet.toLowerCase() ? "yes" : "no";
  };

  if (input.kept?.seated && input.kept.bodyCoin && isAddress(input.kept.bodyCoin, { strict: false })) {
    return { kind: "coin", coin: getAddress(input.kept.bodyCoin), why: "fixed", others: [], launchedAt: null };
  }
  if (input.named !== null) {
    if (!isAddress(input.named.trim(), { strict: false })) return { kind: "bad-address", given: input.named };
    const coin = getAddress(input.named.trim());
    const verdict = await mine(coin);
    if (verdict === "unreadable") return { kind: "unreadable" };
    return verdict === "yes" ? { kind: "coin", coin, why: "named", others: [], launchedAt: input.indexed?.find((l) => l.coin === coin)?.launchedAt ?? null } : { kind: "not-yours", coin };
  }
  if (input.bookLaunch) {
    const verdict = await mine(input.bookLaunch);
    if (verdict === "unreadable") return { kind: "unreadable" };
    if (verdict === "yes") return { kind: "coin", coin: input.bookLaunch, why: "book", others: (input.indexed ?? []).map((l) => l.coin).filter((c) => c !== input.bookLaunch), launchedAt: null };
  }
  if (input.indexed === null) return { kind: "ask-address" };
  for (const [i, launch] of input.indexed.entries()) {
    const verdict = await mine(launch.coin);
    if (verdict === "unreadable") return { kind: "unreadable" };
    if (verdict === "no") continue;
    const others = input.indexed.slice(i + 1).map((l) => l.coin);
    return { kind: "coin", coin: launch.coin, why: input.indexed.length === 1 ? "only" : "newest", others, launchedAt: launch.launchedAt || null };
  }
  if (input.preset === "launch") return { kind: "await-preset-launch" };
  return { kind: "launch" };
}
