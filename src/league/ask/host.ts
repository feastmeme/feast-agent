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
 * environment (the runtime is usually started from inside a Claude Code session); 120 s, then the child's whole process
 * group is killed and the ask has failed, whether or not a grandchild still holds its pipes (addendum 7).
 *
 * `--bare` is not passed to `claude`, though the brief named it: its help says that under `--bare` "Anthropic auth is
 * strictly ANTHROPIC_API_KEY … (OAuth and keychain are never read)", which would refuse the player's own login, the
 * whole point. The empty working directory keeps project CLAUDE.md files out instead.
 */

export const ASK_WITH = ["claude", "codex", "none"] as const;
export type AskWith = (typeof ASK_WITH)[number];
export const ASK_TIMEOUT_MS = 120_000;
/** After the host exits, how long its pipes may stay open (a grandchild holding them) before the group is killed. */
export const EXIT_GRACE_MS = 2_000;
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
      // No tools, no MCP server, no slash command or skill, one turn: the pack's untrusted text has nothing to drive.
      args: ["-p", "--output-format", "json", "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--json-schema", JSON.stringify(ANSWER_SCHEMA), ...(o.model ? ["--model", o.model] : [])],
    };
  // The prompt is read from stdin: no positional argument (codex exec reads stdin when none is given).
  return { command: "codex", args: ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", o.cwd, "--output-schema", o.schemaPath, "-o", o.lastMessagePath, ...(o.model ? ["-m", o.model] : [])] };
}

/**
 * The child's environment: the parent's, without the runtime's own settings (`FEAST_*`, `LEAGUE_*`, `BAW*`: an RPC URL
 * may carry a key, and the child needs none of them) and without the session of whatever started the runtime
 * (addenda 7 and 10): `CLAUDECODE`, every `CLAUDE_*` (the session's `CLAUDE_CODE_*`, its hook variables
 * `CLAUDE_PID`, `CLAUDE_PROJECT_DIR`, …, and its settings such as `CLAUDE_EFFORT`), `CODEX_*`, and anything naming a
 * `_CHILD_`, `_BRIDGE_` or `_MESSAGING_` channel: the child is a new session of its own, on its own defaults. PATH,
 * HOME, the locale and the rest stay: the player's login may live in any of it.
 *
 * `LOGIN_KEPT` is the login, not a session, and is why five such names stay (not verified by a real `claude -p` call
 * here: the tests make none; each is a documented way the player's own login is found):
 * - `CLAUDE_CONFIG_DIR`: where Claude Code keeps its settings and credentials when the player moved them; without it a
 *   child reads `~/.claude` and is "Not logged in".
 * - `CLAUDE_CODE_OAUTH_TOKEN`: the long-lived token `claude setup-token` makes; for a player who uses it, it is the login.
 * - `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`: the player's provider; without them a child asks Anthropic's
 *   API with no key and fails.
 * - `CODEX_HOME`: where Codex keeps `auth.json` when the player moved it.
 * The session itself never sets any of these.
 */
export const LOGIN_KEPT = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CODEX_HOME"] as const;
const SESSION = /^(CLAUDECODE$|CLAUDE_|CODEX_)|(^|_)(CHILD|BRIDGE|MESSAGING)_/;

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if ((LOGIN_KEPT as readonly string[]).includes(key)) continue;
    if (/^(FEAST_|LEAGUE_|BAW)/.test(key) || SESSION.test(key)) delete out[key];
  }
  return out;
}

/** A child's words, fit to show: the tail, one line, no URL (it may carry a key). */
const tail = (text: string) => clean(text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").trim().split("\n").slice(-3).join(" "), 200);

/** The groups of the asks in flight: killed if the runtime exits mid-ask (a detached group gets no ^C of its own). */
const live = new Set<number>();
let exitHook = false;
function track(pid: number | undefined): void {
  if (!pid) return;
  live.add(pid);
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    for (const p of live) {
      try {
        process.kill(-p, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  });
}

/** The child and everything it started (its process group, `detached`), killed; the streams let go so nothing holds the loop. */
function killGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is gone already.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Gone.
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

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
    let done = false;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: { code: number | null; error: NodeJS.ErrnoException | null; timedOut: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (child?.pid) live.delete(child.pid);
      resolve({ ...r, stdout, stderr });
    };
    try {
      // Its own process group (addendum 7): a grandchild that keeps stdout open goes with it when the timer fires.
      child = spawn(command, args, { cwd, env: childEnv(o.env ?? process.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (error) {
      finish({ code: null, error: error as NodeJS.ErrnoException, timedOut: false });
      return;
    }
    const proc = child;
    track(proc.pid);
    timer = setTimeout(() => {
      killGroup(proc);
      // Failed when the timer fires, whatever the pipes are doing: a later close is ignored.
      finish({ code: null, error: null, timedOut: true });
    }, timeoutMs);
    proc.stdout?.on("data", (d: Buffer) => (stdout.length < 2_000_000 ? (stdout += d.toString("utf8")) : undefined));
    proc.stderr?.on("data", (d: Buffer) => (stderr.length < 200_000 ? (stderr += d.toString("utf8")) : undefined));
    proc.stdin?.on("error", () => undefined);
    proc.on("error", (error) => finish({ code: null, error, timedOut: false }));
    // The host itself has exited: its pipes get a moment to drain, then whatever it left holding them goes.
    proc.on("exit", (code) => {
      grace = setTimeout(() => {
        killGroup(proc);
        finish({ code, error: null, timedOut: false });
      }, EXIT_GRACE_MS);
    });
    proc.on("close", (code) => {
      killGroup(proc);
      finish({ code, error: null, timedOut: false });
    });
    proc.stdin?.end(o.pack);
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
