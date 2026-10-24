import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AgentConfig } from "../agent.ts";
import { sha256Of } from "../audit/static.ts";
import { clean } from "../enter/copy.ts";
import { agentPaths, readJson, writeJsonAtomic } from "../store.ts";
import { PROMPT_MAX_BYTES } from "./constants.ts";

/**
 * Prompt mode on disk (task 963): the prompt file the user confirmed, and the
 * host's last action. The prompt is the player's text for their own agent; the
 * runtime hashes it and shows its first lines, and never reads it as
 * instructions. The host acts through `FL buy` and `FL sell`: each one the guard
 * lets through writes `agents/<name>/host.json` (task 975, the coordinator's
 * ruling C6), which the loop reads to know how long the host has gone without a
 * trade. `FL note`, `FL status` and `FL data` are not trades: they do not count.
 */

export type HostAction = { at: string; what: "buy" | "sell" | "note" };

export const hostPath = (home: string, name: string) => join(agentPaths(home, name).dir, "host.json");

export function recordHostAction(home: string, name: string, what: HostAction["what"], now = Date.now()): void {
  writeJsonAtomic(hostPath(home, name), { at: new Date(now).toISOString(), what } satisfies HostAction);
}

/** The host's last action, epoch ms, or null when it has not acted (or the file cannot be read). */
export function lastHostAction(home: string, name: string): { at: number; what: string } | null {
  try {
    const action = readJson<HostAction>(hostPath(home, name));
    const at = action ? Date.parse(action.at) : Number.NaN;
    return action && Number.isFinite(at) ? { at, what: String(action.what) } : null;
  } catch {
    return null;
  }
}

/** The newest fill in an agent's log (`buy.filled` or `sell.filled`), epoch ms; the log is read from its end. */
export function lastTradeAt(home: string, name: string): number | null {
  const path = agentPaths(home, name).log;
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  // The last 512 KiB holds weeks of a quiet agent's lines; past that, a trade is long enough ago to say so.
  const from = Math.max(0, size - 512 * 1024);
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(size - from);
  try {
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes(".filled")) continue;
    try {
      const entry = JSON.parse(line) as { at?: string; event?: string };
      if (entry.event === "buy.filled" || entry.event === "sell.filled") {
        const at = Date.parse(String(entry.at));
        if (Number.isFinite(at)) return at;
      }
    } catch {
      // A torn line is skipped.
    }
  }
  return null;
}

/** The runtime's newest `slept` line (task 975, addendum 3): when the machine fell asleep, and for how long; null when none. */
export function lastSleep(home: string, name: string): { at: number; minutes: number } | null {
  const path = agentPaths(home, name).log;
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  const from = Math.max(0, size - 512 * 1024);
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(size - from);
  try {
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]!.includes('"slept"')) continue;
    try {
      const entry = JSON.parse(lines[i]!) as { event?: string; from?: string; minutes?: unknown };
      const at = Date.parse(String(entry.from));
      if (entry.event === "slept" && Number.isFinite(at) && typeof entry.minutes === "number") return { at, minutes: entry.minutes };
    } catch {
      // A torn line is skipped.
    }
  }
  return null;
}

export type PromptRead = { ok: true; path: string; sha256: string; text: string } | { ok: false; error: string };

/** A prompt file as the user gave it: its absolute path and the sha256 of its bytes as text. */
export function readPrompt(path: string): PromptRead {
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isFile()) return { ok: false, error: `no prompt at ${full}` };
  if (statSync(full).size > PROMPT_MAX_BYTES) return { ok: false, error: `a prompt is at most ${PROMPT_MAX_BYTES / 1024} KB` };
  const text = readFileSync(full, "utf8");
  if (!text.trim()) return { ok: false, error: "the prompt is empty: write the strategy in it first" };
  return { ok: true, path: full, sha256: sha256Of(text), text };
}

/** The prompt's first lines with text in them, cleaned: what the card shows, so the user sees which prompt they confirm. */
export function promptHead(path: string, count = 3): string[] {
  const read = readPrompt(path);
  if (!read.ok) return [];
  return read.text
    .split(/\r?\n/)
    .map((line) => clean(line, 100))
    .filter(Boolean)
    .slice(0, count);
}

/** The prompt file no longer matches the one the agent was planned (and confirmed) with; null for an agent with no prompt. */
export function promptChanged(agent: AgentConfig): boolean | null {
  if (agent.track !== "prompt" || !agent.prompt) return null;
  const read = readPrompt(agent.prompt.path);
  return !read.ok || read.sha256 !== agent.prompt.sha256;
}

/** A promise's value, or null when it fails or takes longer than `ms` (the timer is cleared either way). */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise.catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The runtime's view of a loaded strategy, as far as the autopilot's gate needs it. */
type Callable<S, I> = {
  call(fn: "onTick" | "onEvent", snapshot: S, state: Record<string, unknown>, event?: unknown): Promise<{ intents: I[]; problems: string[]; logs: string[]; state: Record<string, unknown> }>;
};

/**
 * The autopilot's gate: the preset is asked, on a tick or an event, only while
 * the host has been silent long enough; otherwise it is not called at all and
 * answers nothing. Its intents then take the same road as any other: the guard.
 *
 * With `standby` (a preset that keeps its exits, `steady`; the coordinator's
 * ruling C7, task 975), it is asked while the host trades too, and only the
 * intents `standby` lets through (its sales) leave the gate: it opens nothing.
 */
export function autopilotGate<T extends Callable<S, I>, S, I>(loaded: T, silent: () => boolean, standby?: (intent: I) => boolean): T {
  return {
    ...loaded,
    call: async (fn: "onTick" | "onEvent", snapshot: S, state: Record<string, unknown>, event?: unknown) => {
      if (silent()) return loaded.call(fn, snapshot, state, event);
      if (!standby) return { intents: [], problems: [], logs: [], state };
      const out = await loaded.call(fn, snapshot, state, event);
      return { ...out, intents: out.intents.filter(standby) };
    },
  };
}
