import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { clean } from "../enter/copy.ts";
import type { Model } from "../headers.ts";
import { agentPaths } from "../store.ts";
import { ANSWER_SCHEMA, parseAnswerText } from "./pack.ts";

/**
 * The host's headless CLI, asked by the runtime (task 975, addendum 4): `claude -p` or `codex exec`, on the player's
 * own login, as a child process. Argv only, never a shell string; the pack goes on stdin, which is always given (both
 * CLIs wait for ever on a terminal's stdin); the child's working directory is an empty folder inside the agent's home,
 * so no project's instructions are picked up but the player's own; `CLAUDECODE` is taken out of the child's
 * environment (the runtime is usually started from inside a Claude Code session); 120 s, then the child is killed.
 *
 * `--bare` is not passed to `claude`, though the brief named it: its help says that under `--bare` "Anthropic auth is
 * strictly ANTHROPIC_API_KEY … (OAuth and keychain are never read)", which would refuse the player's own login, the
 * whole point. The empty working directory keeps project CLAUDE.md files out instead.
 */

export const ASK_WITH = ["claude", "codex", "none"] as const;
export type AskWith = (typeof ASK_WITH)[number];
export const ASK_TIMEOUT_MS = 120_000;
export const ASK_EVERY_DEFAULT = 5;
export const ASK_EVERY_MIN = 2;
export const ASK_EVERY_MAX = 120;

/** The adapter for a host: Claude Code and Codex have a headless CLI; Grok and the rest are asked by nobody (none). */
export const askWithFor = (host: Model): AskWith => (host === "claude" ? "claude" : host === "codex" ? "codex" : "none");

/** How the copy names the host. */
export const hostShown = (w: AskWith) => (w === "claude" ? "Claude Code" : w === "codex" ? "Codex" : "no host");

/** The ask's folders: an empty working directory, and beside it the files Codex reads and writes. */
export function askDirs(home: string, name: string): { cwd: string; io: string } {
  const dir = agentPaths(home, name).dir;
  return { cwd: join(dir, "ask-cwd"), io: join(dir, "ask-io") };
}

export function askArgv(w: "claude" | "codex", o: { cwd: string; schemaPath: string; lastMessagePath: string; model?: string | null }): { command: string; args: string[] } {
  if (w === "claude")
    return {
      command: "claude",
      args: ["-p", "--output-format", "json", "--max-turns", "1", "--tools", "", "--no-session-persistence", "--json-schema", JSON.stringify(ANSWER_SCHEMA), ...(o.model ? ["--model", o.model] : [])],
    };
  // The prompt is read from stdin: no positional argument (codex exec reads stdin when none is given).
  return { command: "codex", args: ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", o.cwd, "--output-schema", o.schemaPath, "-o", o.lastMessagePath, ...(o.model ? ["-m", o.model] : [])] };
}

/** The child's environment: the parent's, without `CLAUDECODE`, so a runtime started inside a Claude Code session can still call `claude -p`. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.CLAUDECODE;
  return out;
}

/** A child's words, fit to show: the tail, one line, no URL (it may carry a key). */
const tail = (text: string) => clean(text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").trim().split("\n").slice(-3).join(" "), 200);

export type HostCall = { ok: true; answer: unknown } | { ok: false; cause: string };

export async function callHost(o: { with: "claude" | "codex"; pack: string; home: string; name: string; model?: string | null; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<HostCall> {
  const { cwd, io } = askDirs(o.home, o.name);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(io, { recursive: true });
  const schemaPath = join(io, "answer.schema.json");
  const lastMessagePath = join(io, "last-message.json");
  writeFileSync(schemaPath, JSON.stringify(ANSWER_SCHEMA));
  rmSync(lastMessagePath, { force: true });
  const { command, args } = askArgv(o.with, { cwd, schemaPath, lastMessagePath, model: o.model });
  const who = o.with === "claude" ? "Claude Code" : "Codex";
  const timeoutMs = o.timeoutMs ?? ASK_TIMEOUT_MS;
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string; error: NodeJS.ErrnoException | null; timedOut: boolean }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, env: childEnv(o.env ?? process.env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout, stderr, error: error as NodeJS.ErrnoException, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout.length < 2_000_000 ? (stdout += d.toString("utf8")) : undefined));
    child.stderr?.on("data", (d: Buffer) => (stderr.length < 200_000 ? (stderr += d.toString("utf8")) : undefined));
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error: null, timedOut });
    });
    child.stdin?.end(o.pack);
  });
  if (run.error?.code === "ENOENT") return { ok: false, cause: `${who} is not installed here (no \`${command}\` on PATH)` };
  if (run.error) return { ok: false, cause: `${who} could not be started: ${tail(run.error.message)}` };
  if (run.timedOut) return { ok: false, cause: `${who} did not answer within ${Math.round(timeoutMs / 1_000)} s` };
  if (o.with === "claude") {
    const out = parseAnswerText(run.stdout);
    const result = Array.isArray(out) ? [...out].reverse().find((e) => (e as { type?: unknown })?.type === "result") : out;
    const r = (result ?? {}) as { is_error?: unknown; result?: unknown; structured_output?: unknown };
    if (run.code !== 0 || r.is_error === true) return { ok: false, cause: `${who} answered an error: ${tail(typeof r.result === "string" && r.result ? r.result : run.stderr || run.stdout || `exit ${run.code}`)}` };
    const answer = r.structured_output ?? (typeof r.result === "string" ? parseAnswerText(r.result) : undefined);
    return answer === undefined ? { ok: false, cause: `${who}'s answer was not JSON` } : { ok: true, answer };
  }
  if (run.code !== 0) return { ok: false, cause: `${who} exited ${run.code}: ${tail(run.stderr || run.stdout)}` };
  const text = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, "utf8") : "";
  const answer = parseAnswerText(text);
  return answer === undefined ? { ok: false, cause: `${who}'s answer was not JSON` } : { ok: true, answer };
}
