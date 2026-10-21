import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
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
  };
}

export const globalStopPath = (home: string) => join(home, "STOP");
export const walletLockPath = (home: string) => join(home, "wallet.lock");
export const ledgerPath = (home: string) => join(home, "ledger.json");

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One runtime per wallet: the lock holds the owner's pid and agent name. A lock
 * whose process is gone is stale and is taken over; a live one refuses.
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
      const held = readJson<{ pid: number; agent: string }>(path);
      if (held && alive(held.pid)) throw new Error(`the wallet is in use by agent "${held.agent}" (pid ${held.pid}); stop it first`);
      rmSync(path, { force: true });
    }
  }
  throw new Error("could not take the wallet lock");
}

export function walletLockHolder(home: string): { pid: number; agent: string } | null {
  const held = readJson<{ pid: number; agent: string }>(walletLockPath(home));
  return held && alive(held.pid) ? held : null;
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
