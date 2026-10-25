import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ASK_INSTRUCTION, askWorkspaces, geminiSettings, askArgv, askDirs, askKeyPath, askWithFor, callHost, checkBaseUrl, childEnv, cursorCommand, endpointKey, forgetPlainEndpoints, LOGIN_KEPT, STALE_WORKSPACE_MS, sweepWorkspaces, tail } from "./host.ts";
import { ANSWER_SCHEMA } from "./pack.ts";

/**
 * Task 975, addendum 4: the host adapters against a fake host CLI on PATH: a stub `claude` and a stub `codex` that
 * write down their argv, their stdin, their working directory and their environment, then answer as told (an
 * answer, bad JSON, a non-zero exit, a sleep past the timeout). No real CLI and no network.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  forgetPlainEndpoints();
});

const ANSWER = { action: "buy", coin: "c1", amountBnb: 0.006, fraction: null, reason: "floor first", memo: "bought c1 at 14:30" };

type Mode = "answer" | "bad-json" | "exit" | "sleep" | "is-error" | "grandchild-exits" | "grandchild-hangs" | "grandchild-answers";

/** A stub CLI: `mode` decides what it does; everything it saw goes in `<seen>/<name>.json`. */
function stubs(mode: Mode) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-hostcli-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const seen = join(dir, "seen");
  mkdirSync(bin);
  mkdirSync(seen);
  const body = (name: string) => `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.writeFileSync(${JSON.stringify(seen)} + "/${name}.json", JSON.stringify({ args, stdin, cwd: process.cwd(), env: process.env, workspace: fs.readdirSync(process.cwd()), geminiSettings: fs.existsSync(".gemini/settings.json") ? JSON.parse(fs.readFileSync(".gemini/settings.json", "utf8")) : null }));
  const mode = ${JSON.stringify(mode)};
  if (mode.startsWith("grandchild")) {
    // A grandchild that inherits stdout and keeps it open long after the host is done.
    const g = require("node:child_process").spawn("/bin/sleep", ["600"], { stdio: ["ignore", "inherit", "inherit"] });
    g.unref();
    fs.writeFileSync(${JSON.stringify(seen)} + "/grandchild.pid", String(g.pid));
    if (mode === "grandchild-hangs") return setTimeout(() => {}, 60000);
    if (mode === "grandchild-exits") process.exit(0);
  }
  if (mode === "sleep") return setTimeout(() => {}, 60000);
  if (mode === "exit") { process.stderr.write("You have hit your usage limit. Try again later.\\n"); process.exit(3); }
  const answer = ${JSON.stringify(JSON.stringify(ANSWER))};
  if ("${name}" === "claude" || "${name}" === "agent") {
    if (mode === "is-error") return console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: mode === "bad-json" ? "I think you should buy something" : answer }));
  } else if ("${name}" === "gemini") {
    // As the real CLI 0.65.0 fails (run 17): a pretty-printed object on stderr, nothing on stdout, exit 41.
    if (mode === "is-error") { process.stderr.write("Approval mode note\\n" + JSON.stringify({ session_id: "s", error: { type: "Error", message: "Please set an Auth method in your " + require("node:os").homedir() + "/.gemini/settings.json", code: 41 } }, null, 2) + "\\n"); process.exit(41); }
    console.log(JSON.stringify({ response: mode === "bad-json" ? "buy something" : "\\u0060\\u0060\\u0060json\\n" + answer + "\\n\\u0060\\u0060\\u0060", stats: { models: {} } }));
  } else {
    const o = args[args.indexOf("-o") + 1];
    fs.writeFileSync(o, mode === "bad-json" ? "not json at all" : answer);
    console.log(JSON.stringify({ type: "turn.completed" }));
  }
});
`;
  for (const name of ["claude", "codex", "gemini", "agent"]) {
    writeFileSync(join(bin, name), body(name));
    chmodSync(join(bin, name), 0o755);
  }
  const home = join(dir, "home");
  // The machine's own Gemini key never reaches a stub (and the tests do not depend on whether it has one).
  const { GEMINI_API_KEY: _machineKey, ...machine } = process.env;
  const env = { ...machine, PATH: `${bin}:${process.env.PATH ?? ""}`, FEAST_MAINNET_RPC_URL: "https://rpc.example/with-a-key" };
  const read = (name: string) => JSON.parse(readFileSync(join(seen, `${name}.json`), "utf8")) as { args: string[]; stdin: string; cwd: string; env: Record<string, string | undefined>; workspace: string[]; geminiSettings: unknown };
  const grandchild = () => Number(readFileSync(join(seen, "grandchild.pid"), "utf8"));
  return { home, env, read, grandchild };
}

describe("the adapters' argv", () => {
  it("claude: print mode, JSON out, one turn, no tools, no MCP, no slash commands, no session kept, the schema; --model only when named; never --bare", () => {
    const o = { cwd: "/c", schemaPath: "/io/s.json", lastMessagePath: "/io/l.json" };
    expect(askArgv("claude", o)).toEqual({ command: "claude", args: ["-p", "--output-format", "json", "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--json-schema", JSON.stringify(ANSWER_SCHEMA)] });
    expect(askArgv("claude", { ...o, model: "haiku" }).args.slice(-2)).toEqual(["--model", "haiku"]);
    expect(askArgv("claude", o).args).not.toContain("--bare");
  });

  it("codex: exec, JSON events, a read-only sandbox, no git check, ephemeral, the empty folder, the schema file, the last message to a file; -m only when named", () => {
    const o = { cwd: "/c", schemaPath: "/io/s.json", lastMessagePath: "/io/l.json" };
    expect(askArgv("codex", o)).toEqual({ command: "codex", args: ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", "/c", "--output-schema", "/io/s.json", "-o", "/io/l.json"] });
    expect(askArgv("codex", { ...o, model: "gpt-5-mini" }).args.slice(-2)).toEqual(["-m", "gpt-5-mini"]);
  });

  it("the child's environment: no CLAUDECODE, none of the runtime's own settings, the rest kept", () => {
    const env = childEnv({ CLAUDECODE: "1", FEAST_MAINNET_RPC_URL: "x", LEAGUE_NOTES_DEV: "1", BAW_SOMETHING: "y", HOME: "/h", PATH: "/p", ANTHROPIC_API_KEY: "k" });
    expect(env).toEqual({ HOME: "/h", PATH: "/p", ANTHROPIC_API_KEY: "k" });
  });

  it("addendum 7: no session of the parent's reaches the child; PATH, HOME, the locale and the login stay", () => {
    const session = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "/x",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_BRIDGE_SESSION_ID: "b",
      CLAUDE_CODE_MESSAGING_SOCKET: "/sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      _CHILD_SESSION: "1",
      _BRIDGE_PORT: "1",
      _BRIDGE_TOKEN: "t",
      _MESSAGING_SOCKET: "/sock",
      _MESSAGING_TOKEN: "t",
      CODEX_COMPANION_SESSION_ID: "c",
      CODEX_SANDBOX: "seatbelt",
      CLAUDE_PID: "1",
      CLAUDE_PROJECT_DIR: "/proj",
      // Addendum 10: every CLAUDE_*, the session's settings too.
      CLAUDE_EFFORT: "high",
      CLAUDE_PLUGIN_DATA: "/p",
      CLAUDE_ANYTHING_NEW: "x",
    };
    const kept = { PATH: "/p", HOME: "/h", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm", USER: "u", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "o", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_CODE_USE_BEDROCK: "1", CODEX_HOME: "/ch", __CF_USER_TEXT_ENCODING: "0x0" };
    const env = childEnv({ ...session, ...kept });
    for (const key of Object.keys(session)) expect(env, key).not.toHaveProperty(key);
    expect(env).toEqual(kept);
  });
});

describe("callHost, against the stub CLIs", () => {
  for (const parentHas of [true, false]) {
    it(`claude: the pack on stdin, an empty folder in the agent's home, CLAUDECODE absent though the parent ${parentHas ? "has" : "lacks"} it; the answer read`, async () => {
      const s = stubs("answer");
      const env: NodeJS.ProcessEnv = { ...s.env };
      if (parentHas) env.CLAUDECODE = "1";
      else delete env.CLAUDECODE;
      const out = await callHost({ with: "claude", pack: "THE PACK", home: s.home, name: "demo", env });
      expect(out).toEqual({ ok: true, answer: ANSWER });
      const seen = s.read("claude");
      expect(seen.stdin).toBe("THE PACK");
      expect(seen.env.CLAUDECODE).toBeUndefined();
      expect(seen.env.FEAST_MAINNET_RPC_URL).toBeUndefined();
      // The folder the runtime made, empty (macOS may show it under /private).
      expect(seen.cwd.endsWith(askDirs(s.home, "demo").cwd.replace(/^\/private/, ""))).toBe(true);
      expect(seen.args).toContain("--json-schema");
    });
  }

  it("addendum 7: the argv and the environment the child actually got: no session variable of the parent's", async () => {
    const s = stubs("answer");
    const env = { ...s.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_CHILD_SESSION: "1", _CHILD_SESSION: "1", _BRIDGE_TOKEN: "t", _MESSAGING_SOCKET: "/sock", _MESSAGING_TOKEN: "t", CODEX_COMPANION_SESSION_ID: "c", CLAUDE_EFFORT: "high", CLAUDE_PID: "1", CLAUDE_CONFIG_DIR: "/cfg", LANG: "en_US.UTF-8", ANTHROPIC_API_KEY: "k" };
    expect(await callHost({ with: "claude", pack: "p", home: s.home, name: "demo", env })).toEqual({ ok: true, answer: ANSWER });
    const seen = s.read("claude");
    expect(seen.args).toEqual(askArgv("claude", { cwd: "", schemaPath: "", lastMessagePath: "" }).args);
    // Addendum 10: no CLAUDE_* at all but the login's own (`LOGIN_KEPT`).
    expect(Object.keys(seen.env).filter((k) => (/^(CLAUDECODE|CLAUDE_|CODEX_|_CHILD_|_BRIDGE_|_MESSAGING_|FEAST_|LEAGUE_|BAW)/.test(k) || /_(CHILD|BRIDGE|MESSAGING)_/.test(k)) && !(LOGIN_KEPT as readonly string[]).includes(k))).toEqual([]);
    expect(seen.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/cfg", LANG: "en_US.UTF-8", ANTHROPIC_API_KEY: "k", HOME: process.env.HOME, PATH: env.PATH });
  });

  it("codex: the pack on stdin, no positional prompt, the answer from the last-message file", async () => {
    const s = stubs("answer");
    expect(await callHost({ with: "codex", pack: "THE PACK", home: s.home, name: "demo", env: s.env })).toEqual({ ok: true, answer: ANSWER });
    const seen = s.read("codex");
    expect(seen.stdin).toBe("THE PACK");
    expect(seen.args[0]).toBe("exec");
    expect(seen.args.filter((a) => !a.startsWith("-") && !a.startsWith("/") && a !== "exec" && a !== "read-only")).toEqual([]);
  });

  it("the failures, in plain words: bad JSON, an error answer, a non-zero exit with the quota message, a timeout, no CLI at all", async () => {
    const bad = stubs("bad-json");
    expect(await callHost({ with: "claude", pack: "p", home: bad.home, name: "demo", env: bad.env })).toEqual({ ok: false, cause: "Claude Code's answer was not JSON" });
    const e = stubs("is-error");
    expect(await callHost({ with: "claude", pack: "p", home: e.home, name: "demo", env: e.env })).toEqual({ ok: false, cause: "Claude Code answered an error: Not logged in · Please run /login" });
    const x = stubs("exit");
    expect(await callHost({ with: "codex", pack: "p", home: x.home, name: "demo", env: x.env })).toEqual({ ok: false, cause: "Codex exited 3: You have hit your usage limit. Try again later." });
    const slow = stubs("sleep");
    const started = Date.now();
    expect(await callHost({ with: "claude", pack: "p", home: slow.home, name: "demo", env: slow.env, timeoutMs: 800 })).toEqual({ ok: false, cause: "Claude Code did not answer within 1 s" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const none = stubs("answer");
    expect(await callHost({ with: "codex", pack: "p", home: none.home, name: "demo", env: { ...none.env, PATH: "/nonexistent" } })).toEqual({ ok: false, cause: "Codex is not installed here (no `codex` on PATH)" });
  }, 30_000);

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number) => {
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    return !alive(pid);
  };

  for (const mode of ["grandchild-hangs", "grandchild-exits"] as const) {
    it(`addendum 7: the timeout holds when a grandchild keeps stdout open (${mode === "grandchild-hangs" ? "the host hangs too" : "the host has exited"}); the whole group is killed`, async () => {
      const s = stubs(mode);
      const started = Date.now();
      // The timer (1.5 s) fires before the exit grace (2 s) would: the ask has failed, on time.
      const out = await callHost({ with: "claude", pack: "p", home: s.home, name: "demo", env: s.env, timeoutMs: 1_500 });
      const took = Date.now() - started;
      expect(out).toEqual({ ok: false, cause: "Claude Code did not answer within 2 s" });
      expect(took).toBeLessThan(5_000);
      expect(await gone(s.grandchild())).toBe(true);
    }, 20_000);
  }

  it("addendum 7: a host that answered and exited is read, though a grandchild still holds its stdout; the grandchild is killed", async () => {
    const s = stubs("grandchild-answers");
    const started = Date.now();
    expect(await callHost({ with: "claude", pack: "p", home: s.home, name: "demo", env: s.env, timeoutMs: 20_000 })).toEqual({ ok: true, answer: ANSWER });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(await gone(s.grandchild())).toBe(true);
  }, 30_000);
});

// --- addendum 11: Gemini CLI, Cursor's agent, an OpenAI-compatible endpoint --------------------------------------

describe("addendum 11: the new adapters", () => {
  it("argv: Gemini headless in plan mode, JSON out; Cursor in print, ask mode, its sandbox on, never --force; -m/--model only when named", () => {
    expect(askArgv("gemini", { cwd: "/w", schemaPath: "", lastMessagePath: "" })).toEqual({ command: "gemini", args: ["-p", ASK_INSTRUCTION, "--output-format", "json", "--approval-mode", "plan", "-e", "none", "--allowed-mcp-server-names", "none"] });
    expect(askArgv("gemini", { cwd: "/w", schemaPath: "", lastMessagePath: "", model: "gemini-2.5-flash" }).args.slice(-2)).toEqual(["-m", "gemini-2.5-flash"]);
    const cursor = askArgv("cursor", { cwd: "/w", schemaPath: "", lastMessagePath: "", pack: "PACK", env: { PATH: "/nowhere" } });
    expect(cursor.command).toBe("agent");
    expect(cursor.args.slice(0, 9)).toEqual(["-p", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled", "--trust", "--workspace"]);
    expect(cursor.args).not.toContain("--force");
    expect(cursor.args).not.toContain("--yolo");
    expect(cursor.args).not.toContain("--approve-mcps");
    expect(cursor.args.at(-1)).toBe(`PACK\n\n${ASK_INSTRUCTION}`);
    expect(askWithFor("other", "gemini")).toBe("gemini");
    expect(askWithFor("other", "cursor")).toBe("cursor");
    expect(askWithFor("other", "opencode")).toBe("openai");
    expect(askWithFor("grok")).toBe("none");
  });

  it("Gemini CLI: the pack on stdin, the answer read from its JSON's response (fenced or not); its errors in plain words", async () => {
    const s = stubs("answer");
    expect(await callHost({ with: "gemini", pack: "THE PACK", home: s.home, name: "demo", env: s.env })).toEqual({ ok: true, answer: ANSWER });
    const seen = s.read("gemini");
    expect(seen.stdin).toBe("THE PACK");
    expect(seen.env.CLAUDECODE).toBeUndefined();
    // After the security review: its tools off by system settings, in a fresh temp workspace outside the agent's home, gone after.
    // Run 17, on the real CLI: the exclusion in the workspace's own settings (a system file is read only from a root-owned
    // folder), the folder trusted so it is read and plan mode holds; nothing else in the folder.
    expect(seen.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
    expect(seen.env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
    expect(seen.workspace).toEqual([".gemini"]);
    expect(seen.geminiSettings).toEqual(geminiSettings());
    expect(geminiSettings()).toMatchObject({ tools: { exclude: expect.arrayContaining(["run_shell_command", "read_file", "read_many_files", "web_fetch", "google_web_search", "write_file", "glob", "grep_search", "list_directory"]) }, admin: { extensions: { enabled: false } } });
    // A failure's object on stderr, pretty-printed, as the real CLI 0.65.0 prints it: its message read, the home as ~.
    // Run 17, after a security review: in the league home's own 0700 ask-workspaces, outside the agent's folder.
    expect(seen.cwd.replace(/^\/private/, "")).toMatch(new RegExp(`^${askWorkspaces(s.home).replace(/^\/private/, "")}/feast-ask-[^/]+/w$`));
    expect(seen.cwd.includes(join("agents", "demo"))).toBe(false);
    expect(statSync(askWorkspaces(s.home)).mode & 0o777).toBe(0o700);
    expect(existsSync(seen.cwd)).toBe(false);
    const e = stubs("is-error");
    expect(await callHost({ with: "gemini", pack: "p", home: e.home, name: "demo", env: e.env })).toEqual({ ok: false, cause: "Gemini CLI answered an error: Please set an Auth method in your ~/.gemini/settings.json" });
    const b = stubs("bad-json");
    expect(await callHost({ with: "gemini", pack: "p", home: b.home, name: "demo", env: b.env })).toEqual({ ok: false, cause: "Gemini CLI's answer was not JSON" });
    const slow = stubs("grandchild-hangs");
    expect(await callHost({ with: "gemini", pack: "p", home: slow.home, name: "demo", env: slow.env, timeoutMs: 1_000 })).toEqual({ ok: false, cause: "Gemini CLI did not answer within 1 s" });
  }, 30_000);

  it("Cursor: the pack as its prompt, an empty stdin, the result read; the same timeout", async () => {
    const s = stubs("answer");
    expect(await callHost({ with: "cursor", pack: "THE PACK", home: s.home, name: "demo", env: s.env })).toEqual({ ok: true, answer: ANSWER });
    const seen = s.read("agent");
    expect(seen.stdin).toBe("");
    expect(seen.args.at(-1)).toContain("THE PACK");
    const workspace = seen.args[seen.args.indexOf("--workspace") + 1]!;
    expect(workspace.replace(/^\/private/, "")).toMatch(new RegExp(`^${askWorkspaces(s.home).replace(/^\/private/, "")}/feast-ask-[^/]+/w$`));
    expect(workspace.includes(join("agents", "demo"))).toBe(false);
    expect(seen.cwd.replace(/^\/private/, "")).toBe(workspace.replace(/^\/private/, ""));
    expect(existsSync(workspace)).toBe(false);
    expect(seen.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
    expect(seen.workspace).toEqual([]);
    const e = stubs("is-error");
    expect(await callHost({ with: "cursor", pack: "p", home: e.home, name: "demo", env: e.env })).toEqual({ ok: false, cause: "Cursor answered an error: Not logged in · Please run /login" });
  }, 30_000);

  describe("an OpenAI-compatible endpoint", () => {
    const KEY = "sk-test-0000";
    const BASE = "https://llm.example/v1";
    function endpoint(answer: (body: Record<string, unknown>, n: number) => Response | Promise<Response>) {
      const asked: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
      const f = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        asked.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
        return answer(body, asked.length);
      }) as unknown as typeof fetch;
      return { asked, f };
    }
    const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });
    const home = () => {
      const dir = mkdtempSync(join(tmpdir(), "feast-league-975-openai-"));
      dirs.push(dir);
      return dir;
    };

    it("the pack as the one user message, the schema as response_format, no tools, the key in the header only, from the variable named", async () => {
      const e = endpoint(() => ok(JSON.stringify(ANSWER)));
      const out = await callHost({ with: "openai", pack: "THE PACK", home: home(), name: "demo", model: "deepseek-chat", baseUrl: BASE, keyEnv: "DEEPSEEK_API_KEY", env: { DEEPSEEK_API_KEY: KEY }, fetch: e.f });
      expect(out).toEqual({ ok: true, answer: ANSWER });
      expect(e.asked).toHaveLength(1);
      const [a] = e.asked;
      expect(a!.url).toBe(`${BASE}/chat/completions`);
      expect(a!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(a!.body).toMatchObject({ model: "deepseek-chat", messages: [{ role: "user", content: "THE PACK" }], stream: false, response_format: { type: "json_schema", json_schema: { name: "feast_answer", strict: true, schema: ANSWER_SCHEMA } } });
      expect(a!.body).not.toHaveProperty("tools");
      expect(JSON.stringify(a!.body)).not.toContain(KEY);
    });

    it("an endpoint that refuses response_format is asked once more without it; a fenced answer is read", async () => {
      const e = endpoint((body) => (body.response_format ? new Response(JSON.stringify({ error: { message: "response_format is not supported" } }), { status: 400 }) : ok("```json\n" + JSON.stringify(ANSWER) + "\n```")));
      expect(await callHost({ with: "openai", pack: "p", home: home(), name: "demo", model: "m", baseUrl: BASE, keyEnv: "K", env: { K: KEY }, fetch: e.f })).toEqual({ ok: true, answer: ANSWER });
      expect(e.asked.map((a) => "response_format" in a.body)).toEqual([true, false]);
    });

    it("the key from FL ask-key's file when the variable is not set (as under FL daemon); none at all: one plain line", async () => {
      const h = home();
      const e = endpoint(() => ok(JSON.stringify(ANSWER)));
      expect(await callHost({ with: "openai", pack: "p", home: h, name: "demo", model: "m", baseUrl: BASE, keyEnv: "K", env: {}, fetch: e.f })).toEqual({ ok: false, cause: "your AI endpoint has no key: set K or run FL ask-key demo" });
      expect(e.asked).toHaveLength(0);
      mkdirSync(join(h, "agents", "demo"), { recursive: true });
      writeFileSync(askKeyPath(h, "demo"), `${KEY}\n`, { mode: 0o600 });
      expect(endpointKey({ home: h, name: "demo", keyEnv: "K", env: {} })).toBe(KEY);
      expect(await callHost({ with: "openai", pack: "p", home: h, name: "demo", model: "m", baseUrl: BASE, keyEnv: "K", env: {}, fetch: e.f })).toEqual({ ok: true, answer: ANSWER });
    });

    it("its failures in plain words, the key never in them; the timeout holds", async () => {
      const h = home();
      const says = (r: () => Response | Promise<Response>) => callHost({ with: "openai", pack: "p", home: h, name: "demo", model: "m", baseUrl: BASE, keyEnv: "K", env: { K: KEY }, fetch: endpoint(r).f, timeoutMs: 300 });
      expect(await says(() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 }))).toEqual({ ok: false, cause: "your AI endpoint answered HTTP 401: Incorrect API key provided: <key>" });
      expect(await says(() => ok("I would buy"))).toEqual({ ok: false, cause: "your AI endpoint's answer was not JSON" });
      const hung = endpoint((_b) => new Promise<Response>(() => {}));
      const started = Date.now();
      const timed = await callHost({ with: "openai", pack: "p", home: h, name: "demo", model: "m", baseUrl: BASE, keyEnv: "K", env: { K: KEY }, fetch: (async (u: string, i?: RequestInit) => {
        const signal = i?.signal;
        return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
      }) as unknown as typeof fetch, timeoutMs: 300 });
      expect(timed).toEqual({ ok: false, cause: "your AI endpoint did not answer within 0 s" });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(hung.asked).toHaveLength(0);
    });

    it("a base URL the key may go to: https, or http on this machine; never one carrying credentials", () => {
      expect(checkBaseUrl("https://llm.example/v1/")).toEqual({ ok: true, url: "https://llm.example/v1" });
      expect(checkBaseUrl("http://127.0.0.1:8080/v1")).toEqual({ ok: true, url: "http://127.0.0.1:8080/v1" });
      expect(checkBaseUrl("http://llm.example/v1").ok).toBe(false);
      expect(checkBaseUrl("https://user:pass@llm.example/v1").ok).toBe(false);
      expect(checkBaseUrl("https://llm.example/v1?key=abc").ok).toBe(false);
    });
  });
});

describe("run 19: what the real rehearsals found", () => {
  it("Gemini with an API key: the workspace's settings select it, merged with the tool exclusion; the key reaches the child only by env", async () => {
    const s = stubs("answer");
    const env = { ...s.env, GEMINI_API_KEY: "AIza-test-0000" };
    expect(await callHost({ with: "gemini", pack: "p", home: s.home, name: "demo", env })).toEqual({ ok: true, answer: ANSWER });
    const seen = s.read("gemini");
    expect(seen.geminiSettings).toEqual(geminiSettings({ apiKey: true }));
    expect(seen.geminiSettings).toMatchObject({ security: { auth: { selectedType: "gemini-api-key" } }, tools: { exclude: expect.arrayContaining(["run_shell_command"]) }, admin: { extensions: { enabled: false } } });
    expect(seen.env.GEMINI_API_KEY).toBe("AIza-test-0000");
    expect(seen.args.join(" ")).not.toContain("AIza-test-0000");
    // No key: no auth type written (the CLI's own login, where it still has one).
    const none = stubs("answer");
    await callHost({ with: "gemini", pack: "p", home: none.home, name: "demo", env: none.env });
    expect(none.read("gemini").geminiSettings).not.toHaveProperty("security");
  });

  it("Gemini's key from FL ask-key's file when GEMINI_API_KEY is not set (as under FL daemon)", async () => {
    const s = stubs("answer");
    mkdirSync(join(s.home, "agents", "demo"), { recursive: true });
    writeFileSync(askKeyPath(s.home, "demo"), "AIza-file-0000\n", { mode: 0o600 });
    await callHost({ with: "gemini", pack: "p", home: s.home, name: "demo", env: s.env });
    const seen = s.read("gemini");
    expect(seen.env.GEMINI_API_KEY).toBe("AIza-file-0000");
    expect(seen.geminiSettings).toMatchObject({ security: { auth: { selectedType: "gemini-api-key" } } });
  });

  it("an error under a stack keeps its own first line, not the last three frames", () => {
    const err = "IneligibleTierError: This account is not eligible: migrate to Antigravity\n    at setupUser (file:///x/gemini.js:1:2)\n    at async main (file:///x/gemini.js:3:4)\n    at async run (file:///x/gemini.js:5:6)";
    expect(tail(err)).toBe("IneligibleTierError: This account is not eligible: migrate to Antigravity");
    expect(tail("one\ntwo\nthree\nfour")).toBe("two three four");
  });

  it("an endpoint that refused the schema is asked without it for the rest of the run; another model is asked with it", async () => {
    const asked: boolean[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      asked.push("response_format" in body);
      return body.response_format ? new Response(JSON.stringify({ error: { message: "This response_format type is unavailable now" } }), { status: 400 }) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const h = mkdtempSync(join(tmpdir(), "feast-league-975-plain-"));
    dirs.push(h);
    const o = { with: "openai" as const, pack: "p", home: h, name: "demo", baseUrl: "https://llm.example/v1", keyEnv: "K", env: { K: "sk-test" }, fetch: f };
    for (let i = 0; i < 3; i++) expect(await callHost({ ...o, model: "deepseek-chat" })).toEqual({ ok: true, answer: ANSWER });
    expect(asked).toEqual([true, false, false, false]);
    await callHost({ ...o, model: "deepseek-v4-pro" });
    expect(asked.slice(4)).toEqual([true, false]);
  });

  it("Cursor's CLI: whichever of cursor-agent and agent comes first on PATH", () => {
    const a = mkdtempSync(join(tmpdir(), "feast-league-975-cur-a-"));
    const b = mkdtempSync(join(tmpdir(), "feast-league-975-cur-b-"));
    dirs.push(a, b);
    writeFileSync(join(a, "agent"), "");
    writeFileSync(join(b, "cursor-agent"), "");
    expect(cursorCommand({ PATH: `${a}:${b}` })).toBe("agent");
    expect(cursorCommand({ PATH: `${b}:${a}` })).toBe("cursor-agent");
    expect(cursorCommand({ PATH: "/nowhere" })).toBe("agent");
  });

  it("a workspace a dead process left is swept at the next ask; one younger than an ask's longest life is kept", () => {
    const h = mkdtempSync(join(tmpdir(), "feast-league-975-sweep-"));
    dirs.push(h);
    const parent = askWorkspaces(h);
    mkdirSync(join(parent, "feast-ask-old", "w"), { recursive: true });
    mkdirSync(join(parent, "feast-ask-young", "w"), { recursive: true });
    mkdirSync(join(parent, "keep-me"));
    const now = Date.now();
    const old = (now - STALE_WORKSPACE_MS - 60_000) / 1_000;
    utimesSync(join(parent, "feast-ask-old"), old, old);
    utimesSync(join(parent, "keep-me"), old, old);
    sweepWorkspaces(parent, now);
    expect(readdirSync(parent).sort()).toEqual(["feast-ask-young", "keep-me"]);
  });

  it("FL stop mid-ask (the runtime exits while the host still thinks): the ask's workspace goes with it", async () => {
    const s = stubs("sleep");
    const code = `
      const { callHost } = await import(${JSON.stringify(join(import.meta.dirname, "host.ts"))});
      callHost({ with: "gemini", pack: "p", home: ${JSON.stringify(s.home)}, name: "demo", env: { ...process.env } });
      setTimeout(() => process.exit(0), 1500);
    `;
    await new Promise<void>((done) => execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: join(import.meta.dirname, "..", "..", ".."), env: s.env, timeout: 30_000 }, () => done()));
    // It did start an ask (the stub saw it) and nothing of it is left.
    expect(existsSync(join(askWorkspaces(s.home)))).toBe(true);
    expect(readdirSync(askWorkspaces(s.home)).filter((n) => n.startsWith("feast-ask-"))).toEqual([]);
  }, 30_000);
});
