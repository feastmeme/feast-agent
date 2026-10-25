import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clean } from "../enter/copy.ts";
import type { HostDetail, Model } from "../headers.ts";
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

/**
 * Addendum 11: besides `claude` and `codex`, the Gemini CLI headless (`gemini`), Cursor's agent CLI headless (`cursor`),
 * and any OpenAI-compatible chat endpoint the player names (`openai`: DeepSeek, Qwen, Kimi, xAI, OpenRouter, a local
 * server; the runtime asks it over HTTP, no CLI). The same answer contract, the same 120 s, the same check of the
 * answer, and the pack's untrusted text drives nothing: no tool is offered to any of them.
 */
export const ASK_WITH = ["claude", "codex", "gemini", "cursor", "openai", "none"] as const;
export type AskWith = (typeof ASK_WITH)[number];
/** The adapters that run a CLI as a child process. */
export type CliAsk = "claude" | "codex" | "gemini" | "cursor";
export const ASK_TIMEOUT_MS = 120_000;
/** After the host exits, how long its pipes may stay open (a grandchild holding them) before the group is killed. */
export const EXIT_GRACE_MS = 2_000;
export const ASK_EVERY_DEFAULT = 5;
export const ASK_EVERY_MIN = 2;
export const ASK_EVERY_MAX = 120;

/**
 * The adapter for a host by default: Claude Code, Codex, the Gemini CLI and Cursor have a headless CLI; OpenCode's
 * endpoint is asked directly (`openai`, once its base URL and model are given); Grok and the rest are asked by nobody
 * (none) unless the player names an endpoint.
 */
export const askWithFor = (host: Model, detail: HostDetail | null = null): AskWith =>
  detail === "gemini" ? "gemini" : detail === "cursor" ? "cursor" : detail === "opencode" || detail === "openai" ? "openai" : host === "claude" ? "claude" : host === "codex" ? "codex" : "none";

/** How the copy names the host. */
export const hostShown = (w: AskWith) => (w === "claude" ? "Claude Code" : w === "codex" ? "Codex" : w === "gemini" ? "Gemini CLI" : w === "cursor" ? "Cursor" : w === "openai" ? "your AI endpoint" : "no host");

/** Cursor's agent CLI: `cursor-agent` where it is installed under that name, else `agent` (its newer name). */
export function cursorCommand(env: NodeJS.ProcessEnv = process.env): string {
  for (const dir of (env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "cursor-agent"))) return "cursor-agent";
  return "agent";
}

/** The ask's folders: an empty working directory, and beside it the files Codex reads and writes. */
export function askDirs(home: string, name: string): { cwd: string; io: string } {
  const dir = agentPaths(home, name).dir;
  return { cwd: join(dir, "ask-cwd"), io: join(dir, "ask-io") };
}

/**
 * The Gemini CLI's tools, every built-in one (addendum 11, after a security review): off, through a system settings
 * file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`): the system level overrides the user's and the project's settings (its
 * configuration reference). Not rehearsed on a real Gemini CLI here (none is installed): the coordinator's rehearsal
 * checks that a pack asking it to read a file is answered without one.
 */
export const GEMINI_TOOLS = [
  // Its tools reference (geminicli.com/docs/reference/tools): every one, the legacy names too.
  "run_shell_command", "glob", "grep_search", "search_file_content", "list_directory", "read_file", "read_many_files", "replace", "edit", "write_file",
  "ask_user", "write_todos", "save_memory", "activate_skill", "get_internal_docs", "list_mcp_resources", "read_mcp_resource",
  "google_web_search", "web_fetch", "enter_plan_mode", "exit_plan_mode", "complete_task", "update_topic",
  "tracker_create_task", "tracker_update_task", "tracker_get_task", "tracker_list_tasks", "tracker_add_dependency", "tracker_visualize",
];
export function geminiSettings(): Record<string, unknown> {
  // `tools.exclude` (its settings reference), the flat `excludeTools` older releases read, and no extension at all.
  return { tools: { exclude: GEMINI_TOOLS }, excludeTools: GEMINI_TOOLS, admin: { extensions: { enabled: false } } };
}

/**
 * Where Gemini and Cursor run (addendum 11): a fresh empty folder in the system's temp folder, made for one ask and
 * removed after it, never inside the agent's home (its key file, its notes token): the pack's untrusted text finds
 * nothing to read there, whatever a tool were to do.
 */
function freshWorkspace(): { root: string; cwd: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), "feast-ask-"));
  const cwd = join(root, "w");
  mkdirSync(cwd);
  return { root, cwd, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** What the Gemini CLI and Cursor are told besides the pack: the pack itself says the rest. */
export const ASK_INSTRUCTION = "Answer the Feast league pack above with exactly one JSON object in its schema, and nothing else. Use no tool.";

export function askArgv(w: CliAsk, o: { cwd: string; schemaPath: string; lastMessagePath: string; model?: string | null; pack?: string; env?: NodeJS.ProcessEnv }): { command: string; args: string[] } {
  // Gemini CLI: the pack on stdin, the instruction appended by -p (non-interactive); plan mode (it changes nothing);
  // JSON out. Headless, a tool that needs approval is refused; plan mode leaves it read-only besides.
  // No extension, no MCP server (an allowlist naming none); its tools off by the system settings `geminiSettings` writes.
  if (w === "gemini") return { command: "gemini", args: ["-p", ASK_INSTRUCTION, "--output-format", "json", "--approval-mode", "plan", "-e", "none", "--allowed-mcp-server-names", "none", ...(o.model ? ["-m", o.model] : [])] };
  // Cursor's agent: print mode, JSON out, ask mode (no edits), its sandbox on, never --force (nothing runs without an
  // approval no one gives), no MCP approved, a fresh empty temp folder as its workspace (`--trust` trusts only that
  // empty folder, which headless needs); the pack is the prompt (its docs name no stdin).
  if (w === "cursor") return { command: cursorCommand(o.env), args: ["-p", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled", "--trust", "--workspace", o.cwd, ...(o.model ? ["--model", o.model] : []), `${o.pack ?? ""}\n\n${ASK_INSTRUCTION}`] };
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

// --- the OpenAI-compatible endpoint (addendum 11) -----------------------------------------------------------------

/** The agent's own key file for the endpoint (`FL ask-key`): mode 0600, beside its book; read at each ask, never shown. */
export const askKeyPath = (home: string, name: string) => join(agentPaths(home, name).dir, "ask-key");

/** A base URL the runtime may send a key to: https, or http on this machine (a local server); no credentials in it. */
export function checkBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "--ask-base-url is not a URL" };
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return { ok: false, reason: "--ask-base-url is https (http only on this machine)" };
  if (u.username || u.password || u.search || u.hash) return { ok: false, reason: "--ask-base-url carries no credentials, query or fragment: the key goes in an environment variable (--ask-key-env) or FL ask-key" };
  return { ok: true, url: u.href.replace(/\/+$/, "") };
}

/** The key, from the named environment variable, else the agent's key file; null when neither has one. */
export function endpointKey(o: { home: string; name: string; keyEnv?: string | null; env?: NodeJS.ProcessEnv }): string | null {
  const env = o.env ?? process.env;
  const fromEnv = o.keyEnv ? env[o.keyEnv]?.trim() : undefined;
  if (fromEnv) return fromEnv;
  const path = askKeyPath(o.home, o.name);
  const fromFile = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  return fromFile || null;
}

/**
 * One ask of an OpenAI-compatible endpoint: `POST <base>/chat/completions`, the pack as the one user message, the
 * answer's JSON schema as `response_format` (an endpoint that refuses it, a 400 or 422, is asked once more without
 * it: the pack itself asks for the JSON), no tools, no stream, 120 s. The key goes to that endpoint only, never to a
 * log, a notice or an error line.
 */
async function callEndpoint(o: CallInput): Promise<HostCall> {
  const who = "your AI endpoint";
  const base = o.baseUrl ? checkBaseUrl(o.baseUrl) : { ok: false as const, reason: "no --ask-base-url" };
  if (!base.ok) return { ok: false, cause: `${who} is not set up: ${base.reason}` };
  if (!o.model) return { ok: false, cause: `${who} is not set up: no --ask-model` };
  const key = endpointKey(o);
  if (!key) return { ok: false, cause: `${who} has no key: set ${o.keyEnv ?? "the variable --ask-key-env names"} or run FL ask-key ${o.name}` };
  const timeoutMs = o.timeoutMs ?? ASK_TIMEOUT_MS;
  const doFetch = o.fetch ?? fetch;
  const hide = (text: string) => tail(text.split(key).join("<key>"));
  const ask = async (structured: boolean) => {
    const body = {
      model: o.model,
      messages: [{ role: "user", content: o.pack }],
      stream: false,
      max_tokens: 2_000,
      ...(structured ? { response_format: { type: "json_schema", json_schema: { name: "feast_answer", strict: true, schema: ANSWER_SCHEMA } } } : {}),
    };
    return doFetch(`${base.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  };
  let response: Response;
  try {
    response = await ask(true);
    if (response.status === 400 || response.status === 422) {
      await response.body?.cancel().catch(() => undefined);
      response = await ask(false);
    }
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, cause: `${who} did not answer within ${Math.round(timeoutMs / 1_000)} s` };
    return { ok: false, cause: `${who} could not be reached: ${hide((error as Error).message ?? String(error))}` };
  }
  const text = await response.text().catch(() => "");
  if (response.status !== 200) {
    const said = (() => {
      try {
        const e = (JSON.parse(text) as { error?: { message?: unknown } | string }).error;
        return typeof e === "string" ? e : typeof e?.message === "string" ? e.message : text;
      } catch {
        return text;
      }
    })();
    return { ok: false, cause: `${who} answered HTTP ${response.status}: ${hide(said)}` };
  }
  let content: unknown;
  try {
    content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  } catch {
    content = undefined;
  }
  const answer = typeof content === "string" ? parseAnswerText(content) : undefined;
  return answer === undefined ? { ok: false, cause: `${who}'s answer was not JSON` } : { ok: true, answer };
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

export type CallInput = {
  with: CliAsk | "openai";
  pack: string;
  home: string;
  name: string;
  model?: string | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** `openai`: the endpoint, and where its key is (an environment variable's name; else the agent's key file). */
  baseUrl?: string | null;
  keyEnv?: string | null;
  fetch?: typeof fetch;
};

export async function callHost(o: CallInput): Promise<HostCall> {
  if (o.with === "openai") return callEndpoint(o);
  return callCli({ ...o, with: o.with });
}

async function callCli(o: CallInput & { with: CliAsk }): Promise<HostCall> {
  const fresh = o.with === "gemini" || o.with === "cursor" ? freshWorkspace() : null;
  try {
    return await callCliIn(o, fresh);
  } finally {
    fresh?.remove();
  }
}

async function callCliIn(o: CallInput & { with: CliAsk }, fresh: { root: string; cwd: string } | null): Promise<HostCall> {
  const dirs = askDirs(o.home, o.name);
  const cwd = fresh?.cwd ?? dirs.cwd;
  const io = dirs.io;
  mkdirSync(cwd, { recursive: true });
  mkdirSync(io, { recursive: true });
  const schemaPath = join(io, "answer.schema.json");
  const lastMessagePath = join(io, "last-message.json");
  writeFileSync(schemaPath, JSON.stringify(ANSWER_SCHEMA));
  rmSync(lastMessagePath, { force: true });
  const { command, args } = askArgv(o.with, { cwd, schemaPath, lastMessagePath, model: o.model, pack: o.pack, env: o.env });
  // Gemini's tools off: its system settings, beside (not in) its workspace.
  const extraEnv: NodeJS.ProcessEnv = {};
  if (o.with === "gemini" && fresh) {
    const settings = join(fresh.root, "system-settings.json");
    writeFileSync(settings, JSON.stringify(geminiSettings()), { mode: 0o600 });
    extraEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settings;
  }
  const who = hostShown(o.with);
  // Cursor takes the pack as its prompt; the others read it on stdin.
  const stdin = o.with === "cursor" ? "" : o.pack;
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
      child = spawn(command, args, { cwd, env: { ...childEnv(o.env ?? process.env), ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], detached: true });
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
    proc.stdin?.end(stdin);
  });
  if (run.error?.code === "ENOENT") return { ok: false, cause: `${who} is not installed here (no \`${command}\` on PATH)` };
  if (run.error) return { ok: false, cause: `${who} could not be started: ${tail(run.error.message)}` };
  if (run.timedOut) return { ok: false, cause: `${who} did not answer within ${Math.round(timeoutMs / 1_000)} s` };
  if (o.with === "gemini") {
    // `{ response, stats, error? }` (its headless docs).
    const out = parseAnswerText(run.stdout) as { response?: unknown; error?: { message?: unknown } | null } | undefined;
    if (run.code !== 0 || (out && out.error)) return { ok: false, cause: `${who} answered an error: ${tail(typeof out?.error?.message === "string" ? out.error.message : run.stderr || run.stdout || `exit ${run.code}`)}` };
    const answer = typeof out?.response === "string" ? parseAnswerText(out.response) : undefined;
    return answer === undefined ? { ok: false, cause: `${who}'s answer was not JSON` } : { ok: true, answer };
  }
  if (o.with === "claude" || o.with === "cursor") {
    // Both print one result object (`type: "result"`, `is_error`, `result`).
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
