import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { runAgent } from "../runtime.ts";
import { agentPaths, writeStop } from "../store.ts";
import { tradeWorld } from "./fakes.ts";

/**
 * Task 963's commands as the skill runs them: `bin.mjs` in a child process,
 * a fake `baw` (FEAST_LEAGUE_BAW), and the chain, the indexer and feast.meme
 * on a closed port. Nothing here reaches a network.
 */

const BIN = join(import.meta.dirname, "../bin.mjs");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function fakeBaw(dir: string): string {
  const path = join(dir, "baw");
  writeFileSync(
    path,
    `#!${process.execPath}
const args = process.argv.slice(2);
const ok = (data) => console.log(JSON.stringify({ success: true, data }));
const command = args.slice(0, 2).join(" ");
if (command === "wallet status") ok({ status: "CONNECTED" });
else if (command === "wallet address") ok({ addresses: [{ binanceChainId: "56", address: "0x000000000000000000000000000000000000a11c" }] });
else if (command === "wallet settings") ok({ devMode: { enabled: true, expiresAt: null, dailyLimit: 1000, balanceExceeded: false } });
else console.log(JSON.stringify({ success: false, error: { name: "NOT_IN_THIS_TEST" } }));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-963-cli-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const planned = planAgent({ name: "maple", preset: "dca", params: { buyOnStart: false } });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirmAgent(planned.agent));
  const closed = "http://127.0.0.1:9";
  const env = { FEAST_LEAGUE_HOME: home, FEAST_LEAGUE_BAW: fakeBaw(dir), FEAST_MAINNET_RPC_URL: closed, FEAST_LEAGUE_SITE: closed, FEAST_LEAGUE_INDEXER: closed };
  const prompt = join(dir, "strategy.md");
  writeFileSync(prompt, "Ride coins whose volume is growing.\nSize 0.005 BNB.\nNote why.\n");
  return { dir, home, env, prompt };
}

describe("the CLI's new commands, through the binary", () => {
  it("--help lists data, note, script check and --prompt, and no tick", async () => {
    const { env } = setup();
    const out = await run(["--help"], env);
    expect(out.code).toBe(0);
    for (const word of ["data [<name>]", "note <name>", "script check <file.mjs>", "--prompt <strategy.md>", "--autopilot", "--idle-minutes", "--no-wait", "--model grok|codex|claude|other", "note --login"]) expect(out.stdout, word).toContain(word);
    expect(out.stdout).not.toMatch(/\btick <|FL tick/);
  }, 60_000);

  it("note with 281 characters: one error line, exit 2", async () => {
    const { env } = setup();
    const out = await run(["note", "maple", "x".repeat(281)], env);
    expect(out.code).toBe(2);
    expect(out.stdout.trim()).toBe("a note is 1–280 characters (got 281)");
  }, 60_000);

  it("note --model outside the four: one line, exit 2; note --login with no Agent ID readable: one plain line, nothing signed", async () => {
    const { env } = setup();
    const model = await run(["note", "maple", "bought it", "--model", "gpt"], env);
    expect(model.code).toBe(2);
    expect(model.stdout.trim()).toBe("--model is one of grok, codex, claude, other");
    const login = await run(["note", "--login"], env);
    expect(login.code).toBe(1);
    expect(login.stdout.trim()).toBe("The Agent ID could not be read from BNB Smart Chain just now: try again in a minute. Nothing was signed.");
  }, 60_000);

  it("data with feast.meme on a closed port: a plain failure line, exit 1", async () => {
    const { env } = setup();
    const out = await run(["data", "maple"], env);
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/feast\.meme's pools could not be read/);
    expect(out.stdout).not.toMatch(/at .*\.ts:\d+|Error:/);
  }, 60_000);

  it("set above the cap: refused with the cap's line, exit 2", async () => {
    const { env } = setup();
    const out = await run(["set", "maple", "--limit", "budgetBnb=0.2", "--yes"], env);
    expect(out.code).toBe(2);
    expect(out.stdout).toContain("the league caps capital at 0.15 BNB");
  }, 60_000);

  it("start --prompt: the card and exit 2 without --yes; a changed prompt on a confirmed agent prints a new card", async () => {
    const { env, prompt, home } = setup();
    const first = await run(["start", "demo", "--prompt", prompt, "--autopilot", "momentum"], env);
    expect(first.code).toBe(2);
    expect(first.stdout).toContain('Your Feast agent "demo"');
    expect(first.stdout).toContain("  > Ride coins whose volume is growing.");
    expect(first.stdout).toContain("Not started: this needs the user's explicit yes (--yes).");
    // The user said yes earlier (confirmed here directly); then the prompt file changes.
    const { loadAgent } = await import("../agent.ts");
    saveAgent(home, confirmAgent(loadAgent(home, "demo")!));
    writeFileSync(prompt, "Buy every new coin.\n");
    const changed = await run(["start", "demo", "--prompt", prompt, "--autopilot", "momentum"], env);
    expect(changed.code).toBe(2);
    expect(changed.stdout).toContain("  > Buy every new coin.");
    expect(loadAgent(home, "demo")!.confirmed).toBeNull();
    // --autopilot without --prompt, and a prompt with a script, are refused.
    expect((await run(["plan", "x", "--autopilot", "dca", "--preset", "dca"], env)).code).not.toBe(0);
  }, 60_000);
});

describe("FL buy into a running agent waits for the outcome", () => {
  it("prints the fill with its transaction, exit 0; a refusal, exit 2; --no-wait keeps queued", async () => {
    const { env, home, prompt } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const w = tradeWorld();
    const OTHER = "0x00000000000000000000000000000000000c0de9";
    w.notFeast.add(OTHER);
    const running = runAgent({ home, name: "demo", signer: w.signer, chain: w.chain, fetch: (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch, loopMs: 50, maxRuntimeMs: 50_000, out: () => {} });
    for (let i = 0; i < 100 && !existsSync(agentPaths(home, "demo").pid); i += 1) await new Promise((r) => setTimeout(r, 50));
    try {
      const filled = await run(["buy", "demo", "FEAST", "0.002"], env);
      expect(filled.stdout.trim()).toBe(`filled: bought FEAST for 0.002 BNB, transaction ${w.hashes[0]}`);
      expect(filled.code).toBe(0);
      const refused = await run(["buy", "demo", OTHER, "0.002"], env);
      expect(refused.code).toBe(2);
      expect(refused.stdout.trim()).toMatch(/^refused by L15: /);
      // Another coin: a second FEAST buy within 60 s is L13's, refused before anything is queued.
      const queued = await run(["buy", "demo", "0x00000000000000000000000000000000000c0dea", "0.002", "--no-wait"], env);
      expect(queued.code).toBe(0);
      expect(queued.stdout.trim()).toBe('queued for the running agent "demo"; feast-league status demo');
      expect(JSON.parse(readFileSync(join(agentPaths(home, "demo").dir, "host.json"), "utf8")).what).toBe("buy");
    } finally {
      writeStop(agentPaths(home, "demo").stop, "stop requested by the user");
      await running;
    }
  }, 60_000);
});

describe("task 975: the autopilot backup by default, through the binary", () => {
  it("start --prompt and plan --prompt with no flag: steady after 30 min, on the card and in agent.json", async () => {
    const { env, prompt, home } = setup();
    const { loadAgent } = await import("../agent.ts");
    for (const command of ["start", "plan"]) {
      const out = await run([command, `${command}-demo`, "--prompt", prompt], env);
      expect(out.stdout, command).toContain("Autopilot backup: on. If your agent makes no FL buy or FL sell for 30 min, the steady preset (Steady floor keeper)");
      expect(out.stdout, command).toContain("--no-autopilot turns it off.");
      expect(loadAgent(home, `${command}-demo`), command).toMatchObject({ track: "prompt", preset: "steady", autopilot: { idleMinutes: 30 } });
    }
  }, 60_000);

  it("--no-autopilot: off, no preset; --autopilot momentum: momentum; both: exit 2, one line, nothing saved; --no-autopilot --idle-minutes 5: refused", async () => {
    const { env, prompt, home } = setup();
    const { loadAgent } = await import("../agent.ts");
    const off = await run(["plan", "off", "--prompt", prompt, "--no-autopilot"], env);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("Autopilot backup: off (--no-autopilot).");
    expect(loadAgent(home, "off")).toMatchObject({ preset: null, autopilot: null });
    const momentum = await run(["plan", "mo", "--prompt", prompt, "--autopilot", "momentum"], env);
    expect(momentum.stdout).toContain("the momentum preset (Momentum)");
    const both = await run(["start", "both", "--prompt", prompt, "--autopilot", "momentum", "--no-autopilot"], env);
    expect(both.code).toBe(2);
    expect(both.stdout.trim()).toBe("choose --autopilot <preset> or --no-autopilot");
    expect(loadAgent(home, "both")).toBeNull();
    const idle = await run(["plan", "idle", "--prompt", prompt, "--no-autopilot", "--idle-minutes", "5"], env);
    expect(idle.code).toBe(2);
    expect(idle.stdout).toContain("--idle-minutes needs --autopilot <preset>");
    expect(loadAgent(home, "idle")).toBeNull();
    expect((await run(["plan", "x", "--preset", "dca", "--no-autopilot"], env)).code).not.toBe(0);
  }, 60_000);

  it("--help names --no-autopilot, the default steady and 30 min", async () => {
    const { env } = setup();
    const out = await run(["--help"], env);
    for (const word of ["--no-autopilot", "default steady, after 30 min", "enter --name <id>.ai", "--host <claude|codex|grok|other>"]) expect(out.stdout, word).toContain(word);
    expect(out.stdout).not.toContain("default 60");
  }, 60_000);
});

describe("task 975: FL status shows the day's count", () => {
  it("--json carries day; the human line says it, and that the floor is the host's while it trades", async () => {
    const { env, prompt, home } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const { appendJsonl } = await import("../store.ts");
    appendJsonl(agentPaths(home, "demo").log, { at: new Date().toISOString(), event: "buy.filled", coin: "0x00000000000000000000000000000000000c0e01", bnbInWei: "6000000000000000" });
    const out = await run(["status", "demo", "--json", "--no-league"], env);
    const data = JSON.parse(out.stdout) as { day: Record<string, unknown> };
    expect(data.day).toMatchObject({ trades: 1, volumeBnb: 0.006, floor: { trades: 3, volumeBnb: 0.02 }, passed: false, startsAt: expect.any(String), endsAt: expect.stringMatching(/T13:00:00\.000Z$/) });
    const human = await run(["status", "demo", "--no-league"], env);
    expect(human.stdout).toMatch(/today: 1 trade, 0\.006 BNB of volume \(the floor: 3 and 0\.02 BNB, own coin left out\): not yet; dinner at 21:00 UTC\+8, in /);
    expect(human.stdout).toContain("autopilot: steady, after 30 min with no trade from your agent");
  }, 60_000);
});

describe("task 975, addendum 2: FL status in season, and FL doctor's indexer", () => {
  it("once the season is open, FL status ends by telling the host to trade now (no league block needed)", async () => {
    const { env, prompt, home } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, { ...confirmAgent(planned.agent), league: { waitForSeason: true } });
    const { writeGate } = await import("../season-gate.ts");
    writeGate(home, "demo", { state: "open", opensAt: "2026-10-26T12:00:00.000Z", at: new Date().toISOString() });
    const out = await run(["status", "demo", "--no-league"], env);
    expect(out.stdout.trimEnd().split("\n").at(-1)).toBe("The season is on. Decide and trade now by strategy.md; if you go quiet for 30 minutes, autopilot (steady) takes over.");
    writeGate(home, "demo", { state: "waiting", opensAt: "2026-10-26T12:00:00.000Z", at: new Date().toISOString() });
    expect((await run(["status", "demo", "--no-league"], env)).stdout).not.toContain("Decide and trade now");
  }, 60_000);

  it("FL doctor asks the indexer FEAST_LEAGUE_INDEXER names, not the production one", async () => {
    const { createServer } = await import("node:http");
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ verdict: "serving", blocksBehind: 0 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const { env } = setup();
      const port = (server.address() as { port: number }).port;
      const out = await run(["doctor"], { ...env, FEAST_LEAGUE_INDEXER: `http://127.0.0.1:${port}` });
      expect(asked).toContain("/api/indexer/status");
      expect(out.stdout).toContain("ok  indexer: serving, 0 blocks behind");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});

describe("task 975, addendum 3: FL status says to keep the machine awake, and when it slept", () => {
  it("the awake line, and 'slept N minutes at <time>' from the log; --json carries slept", async () => {
    const { env, prompt, home } = setup();
    const planned = planAgent({ name: "demo", promptPath: prompt, preset: "steady" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const human = await run(["status", "demo", "--no-league"], env);
    expect(human.stdout).toContain("Keep this machine awake for the season (or run it on a server or cloud computer); if it sleeps, your agent stops and gets eaten.");
    expect(human.stdout).not.toContain("slept ");
    const zh = await run(["status", "demo", "--no-league", "--lang", "zh"], env);
    expect(zh.stdout).toContain("赛季期间保持这台电脑不休眠（或放到服务器 / 云电脑上跑）：它一睡，你的 agent 就停，开饭时会被吃掉。");
    const { appendJsonl } = await import("../store.ts");
    const from = Date.now() - 2 * 3_600_000;
    appendJsonl(agentPaths(home, "demo").log, { at: new Date(from + 45 * 60_000).toISOString(), event: "slept", from: new Date(from).toISOString(), minutes: 45 });
    const after = await run(["status", "demo", "--no-league"], env);
    const { utc8 } = await import("../register/copy.ts");
    expect(after.stdout).toContain(`slept 45 minutes at ${utc8(from)} UTC+8`);
    const data = JSON.parse((await run(["status", "demo", "--json", "--no-league"], env)).stdout) as { slept: unknown };
    expect(data.slept).toEqual({ at: new Date(from).toISOString(), minutes: 45 });
  }, 60_000);
});
