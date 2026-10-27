import { join } from "node:path";

import { readJson, writeJsonAtomic } from "./store.ts";

/**
 * Who runs this agent, said to feast.meme (task 975, the owner's ruling B): every request the runtime and the CLI make
 * to feast.meme carries two headers, `x-feast-host` (which AI hosts the agent: claude, codex, grok or other) and
 * `x-feast-runtime` (the release that runs it). Recording them is the site's.
 *
 * Nothing else goes in them: never a wallet, a token, a path, a host name, a user name, an OS, a model version or the
 * prompt. They go to feast.meme only (the origins a caller names), never to the indexer, the chain's RPC or `baw`,
 * and they are never written under the home. They are the same for every player on a release and a host, so the
 * snapshot's GET carries them and the CDN still keeps one copy (the site's snapshot route must not `Vary` on them).
 */

export const HOST_HEADER = "x-feast-host";
export const RUNTIME_HEADER = "x-feast-runtime";
/** The release this runtime is; a docs test holds it equal to the CHANGELOG's newest `## league-vN`. */
export const RUNTIME_RELEASE = "league-v5.1.6";

/** The AI a note says wrote it (the owner's ruling, 2026-10-24), and the host the headers name: declared, never checked. */
export const MODELS = ["grok", "codex", "claude", "other"] as const;
export type Model = (typeof MODELS)[number];

export function checkModel(raw: string): { ok: true; model: Model } | { ok: false; reason: string } {
  const model = raw.trim().toLowerCase();
  return (MODELS as readonly string[]).includes(model) ? { ok: true, model: model as Model } : { ok: false, reason: `--model is one of ${MODELS.join(", ")}` };
}

/**
 * The host's hint: `FEAST_LEAGUE_MODEL` when it names one of the four; else the host `FL enter --host` declared for
 * this home (the CLI hands it on as `FEAST_LEAGUE_HOST`, the coordinator's ruling C8): one of the four as itself, and
 * gemini, cursor, opencode or openai as "other" (the site's accepted set is the four; run 19: a declared Gemini under
 * Claude Code's environment said "claude"); else what the host's own environment says of it (Claude Code sets
 * `CLAUDECODE=1`; the Codex CLI's sandbox sets `CODEX_SANDBOX`); else "other". `FL note`'s `--model` default and the
 * `x-feast-host` header are this one function. The declared host always wins over the environment.
 */
export function modelHint(env: Record<string, string | undefined> = process.env): Model {
  const given = checkModel(env.FEAST_LEAGUE_MODEL ?? "");
  if (given.ok) return given.model;
  const declared = checkHost(env.FEAST_LEAGUE_HOST ?? "");
  if (declared.ok) return declared.model;
  if (env.CLAUDECODE === "1") return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return "codex";
  return "other";
}

/**
 * Hosts beyond the four (addendum 11): the site's `x-feast-host` keeps its accepted set (claude, codex, grok, other:
 * these four say `other` there), and the host itself goes in a second header, `x-feast-host-detail`, that an older
 * site simply ignores.
 */
// Run 21: `binance` (Binance AI Pro, in its sandbox; no headless CLI, so nobody is asked: manual mode). The site's
// accepted set (src/lib/league/models.ts: grok, codex, claude, other) does not name it yet, so it says `other` there.
export const HOST_DETAILS = ["gemini", "cursor", "opencode", "openai", "binance"] as const;
export type HostDetail = (typeof HOST_DETAILS)[number];
export const HOST_DETAIL_HEADER = "x-feast-host-detail";

/** `FL enter --host`: one of the four, or one of the details (which is `other` to the site). */
export function checkHost(raw: string): { ok: true; model: Model; detail: HostDetail | null } | { ok: false; reason: string } {
  const v = raw.trim().toLowerCase();
  if ((HOST_DETAILS as readonly string[]).includes(v)) return { ok: true, model: "other", detail: v as HostDetail };
  const m = checkModel(v);
  return m.ok ? { ok: true, model: m.model, detail: null } : { ok: false, reason: `--host is one of ${[...MODELS, ...HOST_DETAILS].join(", ")}` };
}

/** The detail, when the host is one of them: declared (`FEAST_LEAGUE_HOST`), else the Gemini CLI's own marker. */
export function hostDetailHint(env: Record<string, string | undefined> = process.env): HostDetail | null {
  const declared = (env.FEAST_LEAGUE_HOST ?? "").trim().toLowerCase();
  if ((HOST_DETAILS as readonly string[]).includes(declared)) return declared as HostDetail;
  if (checkModel(declared).ok) return null;
  if (env.GEMINI_CLI === "1") return "gemini";
  return null;
}

/** The headers' values under an environment: the two, and the detail when there is one. */
export function hostHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const detail = hostDetailHint(env);
  return { [HOST_HEADER]: modelHint(env), [RUNTIME_HEADER]: RUNTIME_RELEASE, ...(detail ? { [HOST_DETAIL_HEADER]: detail } : {}) };
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * A fetch that, for a request to one of `sites` (compared by origin), sets the two headers and keeps every other one
 * (`accept`, `content-type`, `if-none-match`, `authorization` …), whether they come as a plain object, a `Headers`
 * or on a `Request`. Any other origin passes through untouched. Wrapping twice sets the same values again. The
 * environment is read on each request (`env` defaults to `process.env`).
 */
export function withHostHeaders(fetchImpl: typeof fetch, sites: readonly string[], env?: Record<string, string | undefined>): typeof fetch {
  const origins = new Set(sites.map(originOf).filter((o): o is string => o !== null));
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const origin = originOf(url);
    if (origin === null || !origins.has(origin)) return fetchImpl(input, init);
    const ours = hostHeaders(env ?? process.env);
    const given = init?.headers;
    if (!(input instanceof Request) && (given === undefined || (typeof given === "object" && !(given instanceof Headers) && !Array.isArray(given)))) {
      // A plain object stays a plain object, its own keys as they were, so a caller (or a test) reading it keeps working.
      const kept = Object.fromEntries(Object.entries((given ?? {}) as Record<string, string>).filter(([k]) => k.toLowerCase() !== HOST_HEADER && k.toLowerCase() !== RUNTIME_HEADER && k.toLowerCase() !== HOST_DETAIL_HEADER));
      return fetchImpl(input, { ...init, headers: { ...kept, ...ours } });
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (given !== undefined) new Headers(given).forEach((value, key) => headers.set(key, value));
    for (const [key, value] of Object.entries(ours)) headers.set(key, value);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

// --- FL enter --host: the host a player declares for this home (the coordinator's ruling C8) ---------------------

export const declaredHostPath = (home: string) => join(home, "league-host.json");

/** The host `FL enter --host` declared here (one of the four, or a detail), or null. */
export function readDeclaredHost(home: string): Model | HostDetail | null {
  try {
    const got = readJson<{ host?: unknown }>(declaredHostPath(home));
    const checked = checkHost(typeof got?.host === "string" ? got.host : "");
    return checked.ok ? (checked.detail ?? checked.model) : null;
  } catch {
    return null;
  }
}

export function declareHost(home: string, host: Model | HostDetail, now = Date.now()): void {
  writeJsonAtomic(declaredHostPath(home), { host, at: new Date(now).toISOString() });
}

// --- the health flag (task 975, addendum 8, gap G7) --------------------------------------------------------------

/**
 * One word on the runtime's 5-minute league read, and on nothing else: `ok`, `degraded` (the chain's RPC is on a
 * fallback, or an ask has failed) or `failing` (three failed passes of the loop in a row, or a transaction whose
 * outcome has been unknown for more than 10 minutes). No count, no reason, no wallet: the site adds them up by
 * release and host, and a widespread fault shows as one, not as players gone quiet.
 */
export const HEALTH_HEADER = "x-feast-health";
export const HEALTH = ["ok", "degraded", "failing"] as const;
export type Health = (typeof HEALTH)[number];

export function healthFlag(o: { tickFailsInARow: number; oldestUnresolvedMs: number | null; rpcOnFallback: boolean; askFailsInARow: number }): Health {
  if (o.tickFailsInARow >= 3 || (o.oldestUnresolvedMs !== null && o.oldestUnresolvedMs > 10 * 60_000)) return "failing";
  if (o.rpcOnFallback || o.askFailsInARow > 0) return "degraded";
  return "ok";
}

/** A fetch that sets the health flag on every request it makes (used for the league read alone). */
export function withHealth(fetchImpl: typeof fetch, health: Health): typeof fetch {
  const value: Health = (HEALTH as readonly string[]).includes(health) ? health : "ok";
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers !== undefined) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    headers.set(HEALTH_HEADER, value);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}
