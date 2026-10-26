import type { LeagueRead } from "../register/site.ts";
import { patchStep } from "../version.ts";

/**
 * The opt-in auto-upgrade (task 975, run 23; the owner's approval of the five-point proposal): off unless the player turns it on
 * (`FL start <name> --auto-upgrade`, or `FL_AUTO_UPGRADE=1`), and even then it fires only when every rail holds:
 *
 * - a patch step on the same line (league-v5.1.5 → league-v5.1.6; never across minors), to a release not on the
 *   page's `badVersions`;
 * - (a) a release key in this runtime: the release's manifest signature is checked with it (in the upgrade itself);
 * - (b) the canary gate: the page marks the release canary-passed (`latestRuntime.autoUpgradeFrom`), 60 minutes ago
 *   or more;
 * - (c) a safe point: no open position, more than 20 minutes from the dinner (21:00 UTC+8) on either side, and not in
 *   the first 20 minutes after the season's opening;
 * - (d) the upgrade's own `FL doctor` passes, or it rolls back (in the upgrade itself).
 *
 * Emergencies never come this way: they raise `minSupported`, as before.
 */

export const CANARY_MS = 60 * 60_000;
export const DINNER_CLEAR_MS = 20 * 60_000;
export const OPENING_CLEAR_MS = 20 * 60_000;
/** A position that cost less than this (0.0001 BNB) is dust: it holds no upgrade back. */
export const DUST_WEI = 10n ** 14n;
/** The loop asks at most this often. */
export const AUTO_TRY_MS = 60 * 60_000;

export type Decision = { go: true; tag: string } | { go: false; why: string };

/** The nearest 21:00 UTC+8 (13:00 UTC), before or after `now`. */
export function nearestDinner(now: number): number {
  const day = 86_400_000;
  const today = Math.floor(now / day) * day + 13 * 3_600_000;
  return [today - day, today, today + day].reduce((best, t) => (Math.abs(t - now) < Math.abs(best - now) ? t : best));
}

/** Rail (c). `openPositions`: the positions above dust, over every agent the upgrade would restart. */
export function safePoint(now: number, openPositions: number, opensAt: number | null): { ok: true } | { ok: false; why: string } {
  if (openPositions > 0) return { ok: false, why: `an open position (${openPositions}): it waits until nothing is held` };
  if (Math.abs(now - nearestDinner(now)) <= DINNER_CLEAR_MS) return { ok: false, why: "within 20 minutes of the dinner (21:00 UTC+8)" };
  if (opensAt !== null && now >= opensAt && now - opensAt < OPENING_CLEAR_MS) return { ok: false, why: "within the first 20 minutes after the season's opening" };
  return { ok: true };
}

export function autoUpgradeDecision(o: { current: string; latest: LeagueRead["latestRuntime"] | null | undefined; now: number; publicKey: string | null; openPositions: number; opensAt: number | null }): Decision {
  const l = o.latest;
  if (!l) return { go: false, why: "feast.meme names no release" };
  if (l.badVersions?.includes(l.tag)) return { go: false, why: `${l.tag} is on feast.meme's bad versions` };
  if (!patchStep(o.current, l.tag)) return { go: false, why: l.tag === o.current ? "already on the newest release" : `${l.tag} is not a patch of ${o.current}: only FL upgrade, by hand, crosses a minor` };
  if (!o.publicKey) return { go: false, why: "this runtime carries no release key: auto-upgrade needs a signed release" };
  if (l.autoUpgradeFrom === undefined || l.autoUpgradeFrom === null) return { go: false, why: `feast.meme has not marked ${l.tag} canary-passed` };
  if (o.now - l.autoUpgradeFrom < CANARY_MS) return { go: false, why: `${l.tag} was marked canary-passed less than 60 minutes ago` };
  const safe = safePoint(o.now, o.openPositions, o.opensAt);
  if (!safe.ok) return { go: false, why: safe.why };
  return { go: true, tag: l.tag };
}

/** The positions above dust in a book's positions. */
export const openAboveDust = (positions: Record<string, { coins: bigint; costWei: bigint }>) => Object.values(positions).filter((p) => p.coins > 0n && p.costWei >= DUST_WEI).length;
