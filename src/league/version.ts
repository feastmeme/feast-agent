import { join } from "node:path";

import { RUNTIME_RELEASE } from "./headers.ts";
import type { LeagueRead } from "./register/site.ts";
import { agentPaths, readJson, writeJsonAtomic } from "./store.ts";

/**
 * Is this runtime the newest release (task 975, addendum 8, gap G1)? `/api/league` names the latest release and the
 * oldest still supported (`latestRuntime`); the runtime compares them with its own (`RUNTIME_RELEASE`) on every league
 * read and, when it is behind, says so: once a day in a notification, and in `FL status`. It never upgrades itself:
 * the player (or their host) runs the command. A page that does not say says nothing here.
 */

export const UPGRADE_COMMAND = "npx skills add feastmeme/feast-agent";

/**
 * `league-vN`, `league-vN.M` or `league-vN.M.P` (addendum 11: league-v5.1; run 17: league-v5.1.1; run 19: league-v5.1.2; run 21: league-v5.1.3; task 1020: league-v5.1.4; task 975 run 24: league-v5.1.5; task 975 run 26: league-v5.1.6) → one number that
 * orders them (N + M/1000 + P/1000000); null for anything else.
 */
export const releaseNumber = (tag: string | null | undefined): number | null => {
  const m = /^league-v(\d{1,4})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?$/.exec(tag ?? "");
  return m ? Number(m[1]) + Number(m[2] ?? 0) / 1_000 + Number(m[3] ?? 0) / 1_000_000 : null;
};

export type VersionView = { current: string; latest: string; minSupported: string | null; publishedAt: string | null; behind: boolean; unsupported: boolean; at: string };

/** The comparison, or null when the page says nothing (or says it in a form not understood). */
export function versionView(latest: LeagueRead["latestRuntime"] | null | undefined, now: number, current = RUNTIME_RELEASE): VersionView | null {
  if (!latest) return null;
  const mine = releaseNumber(current);
  const newest = releaseNumber(latest.tag);
  if (mine === null || newest === null) return null;
  const floor = releaseNumber(latest.minSupported);
  return {
    current,
    latest: latest.tag,
    minSupported: latest.minSupported,
    publishedAt: latest.publishedAt === null ? null : new Date(latest.publishedAt).toISOString(),
    behind: mine < newest,
    unsupported: floor !== null && mine < floor,
    at: new Date(now).toISOString(),
  };
}

/** The `FL status` line; null when current (or unknown). */
export function versionLine(v: VersionView | null): string | null {
  if (!v || !v.behind) return null;
  return `runtime ${v.current} · latest ${v.latest} · upgrade: ${UPGRADE_COMMAND}${v.unsupported ? ` (${v.current} is older than ${v.minSupported}, the oldest feast.meme still supports: upgrade before the next dinner)` : ""}`;
}

/** The once-a-day notification's text. */
export function versionNotice(v: VersionView): string {
  return `a newer runtime is out: ${v.latest} (this one is ${v.current}). Upgrade with \`${UPGRADE_COMMAND}\`, then \`FL start <name>\` again; nothing upgrades by itself.${v.unsupported ? ` ${v.current} is older than ${v.minSupported}, the oldest still supported.` : ""}`;
}

/** The "You're in" sentence when behind, en and zh. */
export function upgradeSentence(v: VersionView | null, lang: "en" | "zh"): string | null {
  if (!v || !v.behind) return null;
  return lang === "zh" ? `有更新的运行时 ${v.latest}（当前 ${v.current}）：运行 \`${UPGRADE_COMMAND}\` 升级，它不会自动升级。` : `A newer runtime is out (${v.latest}; this is ${v.current}): upgrade with \`${UPGRADE_COMMAND}\`; it never upgrades by itself.`;
}

export const versionPath = (home: string, name: string) => join(agentPaths(home, name).dir, "runtime-version.json");
/** The last comparison the runtime made, and the day it last said so. */
export type VersionMemory = VersionView & { saidFor: string | null };
export const readVersion = (home: string, name: string) => readJson<VersionMemory>(versionPath(home, name));
export const writeVersion = (home: string, name: string, v: VersionMemory) => writeJsonAtomic(versionPath(home, name), v);

/** The day a notification belongs to: the league's, dinner to dinner (13:00 UTC). */
export const leagueDayKey = (now: number) => new Date(now - 13 * 3_600_000).toISOString().slice(0, 10);
