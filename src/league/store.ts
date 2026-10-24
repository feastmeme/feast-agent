import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, uptime as osUptime } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where an agent lives on disk (PLAN.md §2.1), and the three small mechanisms
 * the runtime's safety leans on: atomic writes, the wallet lock (one runtime
 * per wallet) and the stop files.
 *
 *   $FEAST_LEAGUE_HOME/            default ~/.feast-league
 *     wallet.lock                  pid of the runtime that owns the wallet
 *     STOP                         global stop file: halts every agent
 *     ledger.json                  the league's lifetime spend from this wallet (L3)
 *     agents/<name>/agent.json     the strategy, its parameters, the limits, the confirmed envelope
 *     agents/<name>/state.json     the book
 *     agents/<name>/log.jsonl      every decision, refusal, preview, execute, receipt
 *     agents/<name>/notifications.jsonl
 *     agents/<name>/inbox/         requests from the CLI to a running runtime
 *     agents/<name>/STOP           this agent's stop file
 *     agents/<name>/audit/<sha>.json
 *
 * No file here ever holds the wallet's address.
 */

export function leagueHome(env: Record<string, string | undefined> = process.env): string {
  return env.FEAST_LEAGUE_HOME?.trim() || join(homedir(), ".feast-league");
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function checkAgentName(name: string): string {
  if (!NAME.test(name)) throw new Error(`an agent's name is 1–40 lowercase letters, digits or dashes (got "${name}")`);
  return name;
}

export type AgentPaths = {
  dir: string;
  agent: string;
  state: string;
  log: string;
  notifications: string;
  inbox: string;
  stop: string;
  audit: string;
  pid: string;
  /** What the session reminder has said for the current sign-in (docs/PLAN-941.md §7). */
  session: string;
  /** How many notifications `status` has shown the user. */
  seen: string;
};

export function agentPaths(home: string, name: string): AgentPaths {
  const dir = join(home, "agents", checkAgentName(name));
  return {
    dir,
    agent: join(dir, "agent.json"),
    state: join(dir, "state.json"),
    log: join(dir, "log.jsonl"),
    notifications: join(dir, "notifications.jsonl"),
    inbox: join(dir, "inbox"),
    stop: join(dir, "STOP"),
    audit: join(dir, "audit"),
    pid: join(dir, "runtime.pid"),
    session: join(dir, "session.json"),
    seen: join(dir, "notifications.seen"),
  };
}

export const globalStopPath = (home: string) => join(home, "STOP");
export const walletLockPath = (home: string) => join(home, "wallet.lock");
export const ledgerPath = (home: string) => join(home, "ledger.json");
/** The wallet's league registration as the page answered it: no address and no signature (a signature with its message gives the address back). */
export const leagueRecordPath = (home: string) => join(home, "league.json");

/** The notifications the user has not been shown yet; `mark` moves the cursor past them. */
export function unreadNotifications(home: string, name: string, mark: boolean): unknown[] {
  const paths = agentPaths(home, name);
  if (!existsSync(paths.notifications)) return [];
  const lines = readFileSync(paths.notifications, "utf8").split("\n").filter(Boolean);
  const seen = existsSync(paths.seen) ? Number(readFileSync(paths.seen, "utf8").trim()) : 0;
  const from = Number.isInteger(seen) && seen >= 0 && seen <= lines.length ? seen : 0;
  if (mark) writeFileAtomic(paths.seen, String(lines.length));
  return lines.slice(from).map((line) => JSON.parse(line) as unknown);
}

/** Write through a temporary file and a rename, so a crash never leaves half a file. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`, { mode: 0o600 });
}

// --- stop files -----------------------------------------------------------------------

export function stopReason(home: string, name: string): string | null {
  for (const path of [agentPaths(home, name).stop, globalStopPath(home)]) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim();
      return text || `stop file ${path}`;
    }
  }
  return null;
}

/** The runtime writes a stop file when a rule halts it; it never deletes one. */
export function writeStop(path: string, reason: string): void {
  writeFileAtomic(path, `${reason}\n`);
}

export function removeStop(path: string): void {
  rmSync(path, { force: true });
}

// --- the wallet lock ----------------------------------------------------------------------

/**
 * A process with this pid exists. EPERM means it does, but this process may not signal it (a host's sandbox, such as
 * Codex's seatbelt, or another user's process): alive, never "gone" (task 975, from the host rehearsal). A pid that is
 * not a positive whole number is no process (0 or a negative would name a process group).
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
const alive = pidAlive;

/**
 * When this machine last booted, ms (task 975, addendum 8): a lock or a pid file older than the boot was left by a
 * runtime the reboot ended, whatever process now has its pid.
 */
export function bootTime(now = Date.now(), uptimeSeconds = osUptime()): number {
  return now - uptimeSeconds * 1_000;
}
/** Written before this boot (a minute's slack for the clock): left by a runtime a reboot ended. */
export const beforeBoot = (at: number, boot = bootTime()) => Number.isFinite(at) && at < boot - 60_000;

/**
 * One runtime per wallet: the lock holds the owner's pid and agent name. A lock
 * whose process is gone, or that was written before the machine last booted, is
 * stale and is taken over; a live one refuses.
 */
export function acquireWalletLock(home: string, agent: string): { release: () => void } {
  const path = walletLockPath(home);
  mkdirSync(home, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, agent, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      return {
        release: () => {
          const held = readJson<{ pid: number }>(path);
          if (held?.pid === process.pid) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = readJson<{ pid: number; agent: string; at?: string }>(path);
      if (held && alive(held.pid) && !beforeBoot(Date.parse(held.at ?? ""))) throw new Error(`the wallet is in use by agent "${held.agent}" (pid ${held.pid}); stop it first`);
      rmSync(path, { force: true });
    }
  }
  throw new Error("could not take the wallet lock");
}

export function walletLockHolder(home: string): { pid: number; agent: string } | null {
  const held = readJson<{ pid: number; agent: string; at?: string }>(walletLockPath(home));
  return held && alive(held.pid) && !beforeBoot(Date.parse(held.at ?? "")) ? { pid: held.pid, agent: held.agent } : null;
}

// --- the wallet ledger (L3) -------------------------------------------------------------

export type Ledger = { spentWei: bigint; entries: { at: number; agent: string; wei: bigint; tx: string }[] };

export function readLedger(home: string): Ledger {
  const raw = readJson<{ spentWei: string; entries: { at: number; agent: string; wei: string; tx: string }[] }>(ledgerPath(home));
  if (!raw) return { spentWei: 0n, entries: [] };
  return { spentWei: BigInt(raw.spentWei), entries: raw.entries.map((e) => ({ ...e, wei: BigInt(e.wei) })) };
}

export function addToLedger(home: string, entry: { at: number; agent: string; wei: bigint; tx: string }): Ledger {
  const ledger = readLedger(home);
  const next = { spentWei: ledger.spentWei + entry.wei, entries: [...ledger.entries, entry] };
  writeJsonAtomic(ledgerPath(home), next);
  return next;
}
