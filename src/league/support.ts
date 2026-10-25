import { join } from "node:path";

import type { LeagueRead } from "./register/site.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

/**
 * Where a player gets help (task 975, run 22; the owner's ruling: when players hit problems we must see them fast).
 * The "You're in" lines, `FL status` and every refusal or error end with one line naming it: the league page's own
 * support link, as `/api/league` gives it (`support.url`), kept here from the last read that had one; else the league
 * page's help. The runtime writes no link of its own (never a chat group's).
 */

const supportPath = (home: string) => join(home, "cache", "support.json");

/** A league read that carries the page's support link: kept for the lines that come without a read. */
export function keepSupport(home: string, read: LeagueRead | null | undefined): void {
  if (!read?.support) return;
  const kept = readJson<{ url?: string }>(supportPath(home));
  if (kept?.url !== read.support.url) writeJsonAtomic(supportPath(home), { url: read.support.url, at: new Date().toISOString() });
}

export function supportUrl(home: string): string | null {
  const url = readJson<{ url?: unknown }>(supportPath(home))?.url;
  return typeof url === "string" ? url : null;
}

export function supportLine(url: string | null, lang: "en" | "zh"): string {
  return lang === "zh" ? `需要帮助？${url ?? "feast.meme/league → 帮助"}` : `Need help? ${url ?? "feast.meme/league → Help"}`;
}

/** The help line split off a command's output (the CLI's tests read the rest as before, and the line on its own). */
export function splitHelp(text: string): { text: string; help: string | null } {
  const lines = text.replace(/\n$/, "").split("\n");
  const last = lines.at(-1) ?? "";
  if (!/^(Need help\? |需要帮助？)/.test(last)) return { text, help: null };
  lines.pop();
  return { text: lines.length ? `${lines.join("\n")}\n` : "", help: last };
}
