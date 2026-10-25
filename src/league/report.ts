import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withHostHeaders } from "./headers.ts";
import { short } from "./register/copy.ts";
import { agentPaths, readJson, writeJsonAtomic } from "./store.ts";

/**
 * `FL report <name>` (task 975, run 22; the owner's ruling: when players hit problems we must see them fast): one
 * bundle of what a player's problem needs, `FL doctor`, `FL status`, the agent's last 200 log lines and the runtime's
 * release, scrubbed of what must never leave the machine, kept as a file the player can paste into a chat, and sent
 * to feast.meme (`POST /api/league/report`, the notes session's bearer token), at most once per 10 minutes per agent.
 *
 * Scrubbed: every wallet address and every 32-byte hash cut to its 6+4 form; every field named like a token, a key, a
 * secret, a password or an authorization replaced; keys by their own shapes (sk-…, AIza…, a bearer token), every
 * URL's userinfo, query and key-like path segments (20 or more letters and digits), and the values the caller names (the notes token, a keyed RPC URL) wherever they appear;
 * the home folders shown as `~` and `<league-home>`.
 */

export const REPORT_MAX_BYTES = 64 * 1024;
export const REPORT_EVERY_MS = 10 * 60_000;
export const REPORT_LOG_LINES = 200;

export type ReportBundle = { agentId: string | null; agent: string; runtime: string; host: string; doctor: unknown; status: unknown; logTail: unknown[]; at: string };

const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|private[-_]?key|seed|mnemonic|cookie/i;

/** The bundle with nothing in it that must not leave the machine. */
export function scrub<T>(value: T, o: { homes: { path: string; as: string }[]; secrets: string[] }): T {
  const secrets = o.secrets.filter((s) => s && s.length >= 6);
  const homes = o.homes.filter((h) => h.path && h.path.length > 1).sort((a, b) => b.path.length - a.path.length);
  const text = (s: string) => {
    let t = s;
    for (const secret of secrets) t = t.split(secret).join("<redacted>");
    for (const h of homes) t = t.split(h.path).join(h.as);
    return t
      .replace(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (h) => short(h))
      .replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, (a) => short(a))
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "<redacted>")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "<redacted>")
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
      // Any URL: no userinfo and no query (a keyed endpoint from any variable, a token in a parameter), the path kept.
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^@\s/"']+@)?([^/?#\s"']+)([^?#\s"']*)(?:\?[^#\s"',)]*)?/gi, (_m, scheme: string, host: string, path: string) => `${scheme}${host}${path.replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/<redacted>")}`);
  };
  const walk = (v: unknown, key: string | null): unknown => {
    if (key !== null && SECRET_KEY.test(key) && v !== null && v !== undefined && typeof v !== "boolean") return "<redacted>";
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x, k)]));
    return v;
  };
  return walk(value, null) as T;
}

/** The agent's last log lines, each as the JSON it was (a torn one as its text). */
export function logTail(home: string, name: string, lines = REPORT_LOG_LINES): unknown[] {
  const path = agentPaths(home, name).log;
  if (!existsSync(path)) return [];
  const all = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return all.slice(-lines).map((l) => {
    try {
      return JSON.parse(l) as unknown;
    } catch {
      return l.slice(0, 500);
    }
  });
}

/** At most 64 KB as JSON: the oldest log lines go first, then the status and the doctor are cut to a note. */
export function fit(bundle: ReportBundle, max = REPORT_MAX_BYTES): { bundle: ReportBundle; json: string } {
  let b = bundle;
  let json = JSON.stringify(b);
  while (Buffer.byteLength(json) > max && b.logTail.length > 0) {
    b = { ...b, logTail: b.logTail.slice(Math.max(1, Math.ceil(b.logTail.length / 10))) };
    json = JSON.stringify(b);
  }
  if (Buffer.byteLength(json) > max) {
    b = { ...b, status: "(cut: over 64 KB)", doctor: Array.isArray(b.doctor) ? b.doctor : "(cut: over 64 KB)" };
    json = JSON.stringify(b);
  }
  return { bundle: b, json };
}

/** The bundle as a file the player can paste into a chat: under the league home, mode 0600. */
export function saveReport(home: string, name: string, json: string, now = Date.now()): string {
  const dir = join(home, "reports");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, `${JSON.stringify(JSON.parse(json), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export type ReportSent =
  | { kind: "sent"; id: string | null }
  | { kind: "throttled"; next: number }
  | { kind: "no-session" }
  | { kind: "no-route" }
  | { kind: "refused"; status: number; reason: string | null }
  | { kind: "unreachable"; reason: string };

const sentPath = (home: string) => join(home, "cache", "report-sent.json");

/** `POST /api/league/report`, the notes session's bearer token, once per 10 minutes per agent. */
export async function sendReport(o: { home: string; name: string; site: string; fetch: typeof fetch; json: string; token: string | null; now?: number; timeoutMs?: number }): Promise<ReportSent> {
  const now = o.now ?? Date.now();
  const kept = readJson<Record<string, number>>(sentPath(o.home)) ?? {};
  const last = kept[o.name];
  if (typeof last === "number" && now - last < REPORT_EVERY_MS) return { kind: "throttled", next: last + REPORT_EVERY_MS };
  if (!o.token) return { kind: "no-session" };
  const site = o.site.replace(/\/+$/, "");
  try {
    const r = await withHostHeaders(o.fetch, [site])(`${site}/api/league/report`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${o.token}` }, body: o.json, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
    const body = (await r.json().catch(() => null)) as { id?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    if (r.status === 404 || r.status === 405) return { kind: "no-route" };
    if (r.status !== 200 && r.status !== 201 && r.status !== 202) return { kind: "refused", status: r.status, reason: typeof body?.error?.message === "string" ? body.error.message.slice(0, 160) : typeof body?.error?.code === "string" ? body.error.code : null };
    writeJsonAtomic(sentPath(o.home), { ...kept, [o.name]: now });
    // The id is the site's words, printed: a plain token or nothing.
    return { kind: "sent", id: typeof body?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.id) ? body.id : null };
  } catch (error) {
    return { kind: "unreachable", reason: (error as Error).name === "TimeoutError" ? "no answer in time" : "no answer" };
  }
}
