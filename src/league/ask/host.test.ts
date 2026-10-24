import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { askArgv, askDirs, callHost, childEnv, LOGIN_KEPT } from "./host.ts";
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
  fs.writeFileSync(${JSON.stringify(seen)} + "/${name}.json", JSON.stringify({ args, stdin, cwd: process.cwd(), env: process.env }));
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
  if ("${name}" === "claude") {
    if (mode === "is-error") return console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: mode === "bad-json" ? "I think you should buy something" : answer }));
  } else {
    const o = args[args.indexOf("-o") + 1];
    fs.writeFileSync(o, mode === "bad-json" ? "not json at all" : answer);
    console.log(JSON.stringify({ type: "turn.completed" }));
  }
});
`;
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), body(name));
    chmodSync(join(bin, name), 0o755);
  }
  const home = join(dir, "home");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FEAST_MAINNET_RPC_URL: "https://rpc.example/with-a-key" };
  const read = (name: string) => JSON.parse(readFileSync(join(seen, `${name}.json`), "utf8")) as { args: string[]; stdin: string; cwd: string; env: Record<string, string | undefined> };
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
