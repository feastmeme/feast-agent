import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { splitHelp } from "../support.ts";

/** Run 22: the help line every refusal, error and status ends with, kept apart from the output the tests read. */
const helpOff = (stdout: string, stderr: string) => {
  const out = splitHelp(stdout);
  const err = splitHelp(stderr);
  return { stdout: out.text, stderr: err.text, help: out.help ?? err.help };
};

/**
 * `FL enter` as the skill runs it: `bin.mjs` in a child process, a fake `baw`
 * executable (FEAST_LEAGUE_BAW) that writes down every command it is asked,
 * and an RPC and a league page on a closed port. Nothing here reaches a network.
 */

const BIN = join(import.meta.dirname, "../bin.mjs");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function fakeBawBinary(dir: string): { path: string; calls: () => string[] } {
  const log = join(dir, "baw-calls.txt");
  const path = join(dir, "baw");
  writeFileSync(
    path,
    `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, args.slice(0, 2).join(" ") + "\\n");
const ok = (data) => console.log(JSON.stringify({ success: true, data }));
const command = args.slice(0, 2).join(" ");
if (command === "wallet status") ok({ status: "CONNECTED" });
else if (command === "wallet address") ok({ addresses: [{ binanceChainId: "56", address: "0x000000000000000000000000000000000000a11c" }] });
else if (command === "wallet settings") ok({ devMode: { enabled: true, expiresAt: null, dailyLimit: 1000, balanceExceeded: false } });
else console.log(JSON.stringify({ success: false, error: { name: "NOT_IN_THIS_TEST" } }));
`,
  );
  chmodSync(path, 0o755);
  return { path, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; help: string | null }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, ...helpOff(stdout, stderr) });
    });
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-enter-cli-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const baw = fakeBawBinary(dir);
  // Port 9 (discard) refuses at once: the chain and the page cannot be asked.
  const env = { FEAST_LEAGUE_HOME: home, FEAST_LEAGUE_MODEL: "other", FEAST_LEAGUE_BAW: baw.path, FEAST_MAINNET_RPC_URL: "http://127.0.0.1:9", FEAST_LEAGUE_SITE: "http://127.0.0.1:9" };
  return { home, env, baw };
}

describe("feast-league enter, through the binary", () => {
  it("--help lists enter with its prompt, meme, image and no-start, and meme", async () => {
    const { env } = setup();
    const out = await run(["--help"], env);
    expect(out.stdout).toContain('enter --name <id>.ai [--prompt <strategy.md>] [--meme "<concept>"] [--image <path>] [--no-start] [--yes] [--lang en|zh] [--json]');
    expect(out.stdout).toContain('meme "<concept>" [--coin-name "<…feed>"] [--symbol T] [--description "…"] [--image <file.png>] [--yes]');
    expect(out.stdout).toContain("waiting for the season: it trades nothing before");
    expect(out.stdout).not.toMatch(/body coin, and open the notes session|it never starts trading/);
    const enterHelp = await run(["enter", "--help"], env);
    expect(enterHelp.code).toBe(0);
    expect(enterHelp.stdout).toContain("enter --name <id>.ai");
  }, 60_000);

  it("without --name: one error line, and the wallet is not asked", async () => {
    const { env, baw } = setup();
    const out = await run(["enter"], env);
    expect(out.code).toBe(2);
    expect(out.stdout.trim().split("\n")).toHaveLength(1);
    expect(out.stdout).toMatch(/--name/);
    expect(baw.calls()).toEqual([]);
  }, 60_000);

  it("--name Bad.ai is refused before the wallet is asked", async () => {
    const { env, baw } = setup();
    const out = await run(["enter", "--name", "Bad.ai", "--json"], env);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, stage: "name" });
    expect(baw.calls()).toEqual([]);
  }, 60_000);

  it("the RPC and the page unreachable: one plain line, exit 1, and nothing sent", async () => {
    const { env, baw } = setup();
    const out = await run(["enter", "--name", "demo.ai"], env);
    expect(out.code).toBe(1);
    expect(out.stdout.trim()).toBe("The Agent ID couldn't be read from BNB Smart Chain just now. Nothing was signed or sent. Try again in a minute.");
    expect(out.stdout).not.toContain("127.0.0.1");
    expect(baw.calls().every((c) => c.startsWith("wallet "))).toBe(true);
  }, 60_000);
});

describe("feast-league meme, through the binary", () => {
  it("with no entry on this machine: exit 2, one line, nothing asked of the wallet; a GIF given is never read", async () => {
    const { env, baw } = setup();
    const dir = mkdtempSync(join(tmpdir(), "feast-league-meme-cli-"));
    dirs.push(dir);
    writeFileSync(join(dir, "cat.gif"), "GIF89a, a cat");
    const out = await run(["meme", "a cat that eats noodles", "--coin-name", "Noodle Cat", "--symbol", "NOOD", "--description", "A cat.", "--image", join(dir, "cat.gif")], env);
    expect(out.code).toBe(2);
    expect(out.stdout.trim()).toBe("No entry on this machine: run FL enter first.");
    expect(baw.calls()).toEqual([]);
  }, 60_000);

  it("without a concept: one error line", async () => {
    const { env, baw } = setup();
    const out = await run(["meme"], env);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/the meme's one-line concept/);
    expect(baw.calls()).toEqual([]);
  }, 60_000);
});

describe("league-entry is FL enter's own", () => {
  for (const args of [
    ["plan", "league-entry", "--preset", "dca"],
    ["start", "league-entry", "--yes"],
    ["resume", "league-entry"],
    ["run", "league-entry"],
    // owner ruling 2026-10-26: cap = capital at work (0.15, sells free room); no per-trade / hourly / daily volume limits
    ["set", "league-entry", "--limit", "maxAtWorkBnb=0.1", "--yes"],
  ]) {
    it(`${args[0]} refuses it, in one line`, async () => {
      const { env, home, baw } = setup();
      const planned = planAgent({ name: "league-entry", preset: "dca" });
      if (!planned.ok) throw new Error(planned.errors.join("; "));
      saveAgent(home, confirmAgent(planned.agent));
      const out = await run(args, env);
      expect(out.code).toBe(1);
      expect(out.stderr.trim()).toBe("feast-league: league-entry is FL enter's; plan your season agent under another name");
      expect(baw.calls()).toEqual([]);
    }, 60_000);
  }
});

describe("task 975: FL enter --host", () => {
  it("one of the four, or (addendum 11) a host the site sees as other, is kept for this home; anything else is one line, exit 2, nothing kept", async () => {
    const { env, home } = setup();
    const bad = await run(["enter", "--name", "maplegrin.ai", "--host", "gpt"], env);
    expect(bad.code).toBe(2);
    expect(bad.stdout.trim()).toBe("--host is one of grok, codex, claude, other, gemini, cursor, opencode, openai, binance");
    expect(existsSync(join(home, "league-host.json"))).toBe(false);
    await run(["enter", "--name", "maplegrin.ai", "--host", "grok"], env);
    expect(JSON.parse(readFileSync(join(home, "league-host.json"), "utf8"))).toMatchObject({ host: "grok" });
    await run(["enter", "--name", "maplegrin.ai", "--host", "gemini"], env);
    expect(JSON.parse(readFileSync(join(home, "league-host.json"), "utf8"))).toMatchObject({ host: "gemini" });
  }, 60_000);
});
