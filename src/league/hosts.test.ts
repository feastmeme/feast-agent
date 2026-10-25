import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, loadAgent, planAgent, saveAgent } from "./agent.ts";
import { aliveLine } from "./alive.ts";
import { autopilotLine } from "./enter/copy.ts";
import { askKeyPath } from "./ask/host.ts";
import { inTemp, windowsLines } from "./daemon.ts";
import { checkHost, HOST_DETAIL_HEADER, hostDetailHint, hostHeaders, modelHint } from "./headers.ts";
import { askChoice } from "./start.ts";
import { agentPaths } from "./store.ts";

/**
 * Task 975, addendum 11: the hosts beyond Claude Code and Codex (the site's header contract kept), the endpoint's
 * plan, FL model and FL ask-key through the binary, the daemon's temp-home rule and the Windows line, the heartbeat.
 */

const BIN = join(import.meta.dirname, "bin.mjs");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-hosts-"));
  dirs.push(dir);
  const prompt = join(dir, "strategy.md");
  writeFileSync(prompt, "Keep it small.\n");
  const home = join(dir, "home");
  const env = { FEAST_LEAGUE_HOME: home, FEAST_LEAGUE_MODEL: "other", FEAST_LEAGUE_BAW: "/nonexistent", FEAST_MAINNET_RPC_URL: "http://127.0.0.1:9", FEAST_LEAGUE_SITE: "http://127.0.0.1:9", FEAST_LEAGUE_DAEMON: "off" };
  return { dir, prompt, home, env };
}
function run(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

describe("the site's header contract", () => {
  it("a new host is other to x-feast-host, and itself in x-feast-host-detail; the four keep their header and send no detail", () => {
    expect(checkHost("gemini")).toEqual({ ok: true, model: "other", detail: "gemini" });
    expect(checkHost("Claude")).toEqual({ ok: true, model: "claude", detail: null });
    expect(checkHost("gpt").ok).toBe(false);
    expect(hostHeaders({ FEAST_LEAGUE_HOST: "cursor" })).toEqual({ "x-feast-host": "other", "x-feast-runtime": expect.any(String), [HOST_DETAIL_HEADER]: "cursor" });
    expect(hostHeaders({ FEAST_LEAGUE_HOST: "codex" })).not.toHaveProperty(HOST_DETAIL_HEADER);
    expect(hostHeaders({ GEMINI_CLI: "1" })[HOST_DETAIL_HEADER]).toBe("gemini");
    expect(modelHint({ FEAST_LEAGUE_HOST: "opencode" })).toBe("other");
    expect(hostDetailHint({})).toBeNull();
  });
});

describe("the ask's plan", () => {
  it("defaults by host: Gemini and Cursor their CLI; OpenCode and the rest nobody until an endpoint is named; an endpoint named is openai", () => {
    expect(askChoice({ host: "other", detail: "gemini" })).toEqual({ ok: true, ask: { every: 5, with: "gemini", model: null } });
    expect(askChoice({ host: "other", detail: "cursor", askModel: "auto", every: 10 })).toEqual({ ok: true, ask: { every: 10, with: "cursor", model: "auto" } });
    expect(askChoice({ host: "other", detail: "opencode" })).toEqual({ ok: true, ask: { every: 5, with: "none", model: null } });
    expect(askChoice({ host: "grok", askBaseUrl: "https://llm.example/v1", askModel: "grok-4", askKeyEnv: "XAI_API_KEY" })).toEqual({ ok: true, ask: { every: 5, with: "openai", model: "grok-4", baseUrl: "https://llm.example/v1", keyEnv: "XAI_API_KEY" } });
  });

  it("openai needs a base URL and a model; the URL never carries a key; a key variable is a name; the others take neither", () => {
    const { prompt } = setup();
    const plan = (ask: Record<string, unknown>) => planAgent({ name: "demo", promptPath: prompt, preset: "steady", ask: ask as never });
    expect(plan({ with: "openai", model: "deepseek-chat", baseUrl: "https://llm.example/v1/", keyEnv: "DEEPSEEK_API_KEY" })).toMatchObject({ ok: true, agent: { ask: { with: "openai", model: "deepseek-chat", baseUrl: "https://llm.example/v1", keyEnv: "DEEPSEEK_API_KEY" } } });
    expect(plan({ with: "openai", model: "openrouter/auto", baseUrl: "https://llm.example/api/v1" }).ok).toBe(true);
    const errors = (ask: Record<string, unknown>) => {
      const out = plan(ask);
      return out.ok ? [] : out.errors;
    };
    expect(errors({ with: "openai", model: "m" })).toContain("--ask-with openai needs --ask-base-url <the endpoint's OpenAI-compatible base URL>");
    expect(errors({ with: "openai", baseUrl: "https://llm.example/v1" })).toContain("--ask-with openai needs --ask-model <the endpoint's model name>");
    expect(errors({ with: "openai", model: "m", baseUrl: "https://llm.example/v1?api_key=sk-1" }).join()).toMatch(/carries no credentials/);
    expect(errors({ with: "openai", model: "m", baseUrl: "https://llm.example/v1", keyEnv: "sk-live-123 456" }).join()).toMatch(/an environment variable's name/);
    expect(errors({ with: "claude", baseUrl: "https://llm.example/v1" })).toContain("--ask-base-url and --ask-key-env go with --ask-with openai");
  });
});

describe("FL model and FL ask-key, through the binary", () => {
  it("FL model changes the model without a new card; default is the host's; an endpoint has no default", async () => {
    const { prompt, home, env } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady", ask: { every: 5, with: "claude", model: null } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const set = await run(["model", "demo", "claude-haiku-5-5"], env);
    expect(set.code).toBe(0);
    expect(set.stdout.trim()).toBe('"demo" asks Claude Code with claude-haiku-5-5 from its next ask on');
    expect(loadAgent(home, "demo")).toMatchObject({ ask: { model: "claude-haiku-5-5" }, confirmed: { at: expect.any(String) } });
    expect((await run(["model", "demo", "default"], env)).stdout.trim()).toBe('"demo" asks Claude Code with its default model from its next ask on');
    expect(loadAgent(home, "demo")!.ask!.model).toBeNull();
    const bad = await run(["model", "demo", "--rm"], env);
    expect(bad.code).not.toBe(0);
  }, 60_000);

  it("FL ask-key reads the key on stdin, keeps it at mode 0600, never prints it; refuses a host that needs none", async () => {
    const { prompt, home, env } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady", ask: { every: 5, with: "openai", model: "deepseek-chat", baseUrl: "https://llm.example/v1", keyEnv: "DEEPSEEK_API_KEY" } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const KEY = "sk-test-0123456789";
    const kept = await run(["ask-key", "demo"], env, `${KEY}\n`);
    expect(kept.code).toBe(0);
    expect(kept.stdout + kept.stderr).not.toContain(KEY);
    expect(readFileSync(askKeyPath(home, "demo"), "utf8").trim()).toBe(KEY);
    expect(statSync(askKeyPath(home, "demo")).mode & 0o777).toBe(0o600);
    expect(readFileSync(agentPaths(home, "demo").log, "utf8")).not.toContain(KEY);
    const status = await run(["status", "demo", "--no-league"], env);
    expect(status.stdout).toContain("asking your AI endpoint every 5 min with deepseek-chat");
    expect(status.stdout + status.stderr).not.toContain(KEY);
    const other = planAgent({ name: "other", promptPath: prompt, preset: "steady", ask: { every: 5, with: "claude", model: null } });
    if (!other.ok) throw new Error(other.errors.join("; "));
    saveAgent(home, confirmAgent(other.agent));
    expect((await run(["ask-key", "other"], env, "x\n")).code).not.toBe(0);
  }, 60_000);
});

describe("staying up", () => {
  it("no daemon for a league home in the temp folder (a reboot clears it); the Windows line to run once", () => {
    expect(inTemp(join(tmpdir(), "x", "home"))).toBe(true);
    expect(inTemp("/Users/someone/.feast-league", "/var/folders/zz/T")).toBe(false);
    const lines = windowsLines({ name: "maplegrin", node: "C:\\Program Files\\nodejs\\node.exe", bin: "C:\\feast-agent\\src\\league\\bin.mjs" });
    expect(lines[1]).toBe('schtasks /Create /SC ONLOGON /TN "FeastLeague-maplegrin" /TR "\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\feast-agent\\src\\league\\bin.mjs\\" run maplegrin --supervised" /RL LIMITED /F');
    expect(lines[2]).toContain('schtasks /Delete /TN "FeastLeague-maplegrin" /F');
  });

  it("alive since … · last tick …, and after a stop the last tick stays", () => {
    const now = Date.parse("2026-10-29T06:30:00Z");
    const a = { since: "2026-10-29T04:00:00.000Z", lastTick: "2026-10-29T06:29:00.000Z", lastLoop: "2026-10-29T06:29:30.000Z", pid: 1 };
    expect(aliveLine(a, true, now)).toBe("alive since 2026-10-29 12:00 UTC+8 · last tick 2026-10-29 14:29 UTC+8 (1 min ago)");
    expect(aliveLine(a, false, now + 3 * 3_600_000)).toBe("not running · last tick 2026-10-29 14:29 UTC+8 (3 h 1 min ago)");
    expect(aliveLine(null, false, now)).toBe("not running · no tick yet");
  });
});

describe("FL answer, the Grok routine's hands", () => {
  const C1 = "0x000000000000000000000000000000000000c0e1";
  function agent() {
    const { prompt, home, env } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady", ask: { every: 5, with: "none", model: null } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const printed = (at: number, maxBuyBnb = 0.02) => writeFileSync(join(agentPaths(home, "demo").dir, "printed-pack.json"), JSON.stringify({ at, digest: "sha256:0123456789abcdef", maxBuyBnb, ids: [["c1", { coin: C1, symbol: "NOODFEED", held: false }]] }));
    return { home, env, printed };
  }
  const answer = (a: Record<string, unknown>) => JSON.stringify({ action: "hold", coin: null, amountBnb: null, fraction: null, reason: "r", memo: "", ...a });

  it("a hold: nothing traded; an id the pack does not have: not taken; no fresh pack: says how to get one", async () => {
    const { env, printed } = agent();
    expect((await run(["answer", "demo", answer({})], env)).stdout.trim()).toBe("no fresh pack: run FL ask demo --print first (a pack answers for 10 minutes)");
    printed(Date.now() - 11 * 60_000);
    expect((await run(["answer", "demo", answer({})], env)).code).toBe(2);
    printed(Date.now());
    const held = await run(["answer", "demo", answer({})], env);
    expect([held.code, held.stdout.trim()]).toEqual([0, "hold: nothing traded (pack sha256:0123456789abcdef)"]);
    const unknown = await run(["answer", "demo", answer({ action: "buy", coin: "c9", amountBnb: 0.006 })], env);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toMatch(/^not taken: .*c9/);
  }, 60_000);

  it("a buy the pack allows goes through FL buy's road: the hard limits still refuse it before any wallet call", async () => {
    const { home, env, printed } = agent();
    printed(Date.now(), 1);
    const out = await run(["answer", "demo", answer({ action: "buy", coin: "c1", amountBnb: 0.5, reason: "big" })], env);
    expect(out.code).toBe(2);
    expect(out.stdout).toMatch(/^refused by L1: .*\(nothing was asked of the wallet\)$/m);
    const log = readFileSync(agentPaths(home, "demo").log, "utf8");
    expect(log).toContain('"event":"answer.taken"');
    expect(log).toContain('"event":"intent.refused"');
  }, 60_000);
});

describe("the entry's line names the new hosts", () => {
  it("Gemini CLI, Cursor, your AI endpoint (then that endpoint), en and zh", () => {
    const line = (w: string, lang: "en" | "zh" = "en") => autopilotLine({ preset: "steady", idleMinutes: 30, ask: { every: 5, with: w } }, lang);
    expect(line("gemini")).toBe("Every 5 minutes it asks your Gemini CLI what to do (while you are not trading yourself); if Gemini CLI can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.");
    expect(line("cursor")).toContain("it asks your Cursor what to do");
    expect(line("openai")).toBe("Every 5 minutes it asks your AI endpoint what to do (while you are not trading yourself); if that endpoint can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.");
    expect(line("openai", "zh")).toContain("这个接口 联系不上");
    expect(line("claude")).toBe("Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.");
  });
});


describe("addendum 12: the referral code in FL status", () => {
  it("shown from the entry's record; absent, no line", async () => {
    const { prompt, home, env } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady", ask: { every: 5, with: "none", model: null } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    expect((await run(["status", "demo", "--no-league"], env)).stdout).not.toContain("referral:");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(agentPaths(home, "league-entry").dir, { recursive: true });
    writeFileSync(join(agentPaths(home, "league-entry").dir, "entry.json"), JSON.stringify({ agentId: "maplegrin", bodyCoin: null, launchTx: null, ref: "H7KMQ2" }));
    const status = await run(["status", "demo", "--no-league"], env);
    expect(status.stdout).toContain("referral: H7KMQ2 (sent with the registration)");
    expect(JSON.parse((await run(["status", "demo", "--json", "--no-league"], env)).stdout)).toMatchObject({ referral: "H7KMQ2" });
    // Run 17: the binding's line; with no wallet to read (this test's), it cannot tell, and says so.
    expect(status.stdout).toContain("referrer: not bound (the chain could not be read just now)");
    expect((await run(["status", "demo", "--no-league", "--lang", "zh"], env)).stdout).toContain("引荐人:未绑定（链暂时读不到）");
    const bad = await run(["enter", "--name", "maplegrin.ai", "--ref", "nope!"], env);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("--ref is a referral code");
  }, 60_000);
});
