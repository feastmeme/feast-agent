import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { appendJsonl, agentPaths } from "../store.ts";
import { splitHelp } from "../support.ts";

/** Run 22: the help line every refusal, error and status ends with, kept apart from the output the tests read. */
const helpOff = (stdout: string, stderr: string) => {
  const out = splitHelp(stdout);
  const err = splitHelp(stderr);
  return { stdout: out.text, stderr: err.text, help: out.help ?? err.help };
};

/**
 * The CLI as the skill runs it: `bin.mjs` in a child process, with a fake `baw`
 * executable (FEAST_LEAGUE_BAW) that answers in the wallet's envelopes and
 * writes down every command it is asked, and an RPC and a league page that do
 * not answer. Nothing here reaches a network.
 */

const BIN = join(import.meta.dirname, "../bin.mjs");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function fakeBawBinary(dir: string, connected: boolean): { path: string; calls: () => string[] } {
  const log = join(dir, "baw-calls.txt");
  const path = join(dir, "baw");
  writeFileSync(
    path,
    `#!${process.execPath}
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, args.slice(0, 2).join(" ") + "\\n");
const ok = (data) => console.log(JSON.stringify({ success: true, data }));
const command = args.slice(0, 2).join(" ");
if (command === "wallet status") ok({ status: ${connected ? '"CONNECTED"' : '"DISCONNECTED"'} });
else if (command === "wallet address") ok({ addresses: [{ binanceChainId: "56", address: "0x000000000000000000000000000000000000a11c" }] });
else if (command === "wallet settings") ok({ devMode: { enabled: true, expiresAt: null, dailyLimit: 1000, balanceExceeded: false }, signInMaxTime: "2026-10-30T10:34:11+08:00", sessionExpireTime: "2099-01-01T00:00:00+08:00" });
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

function setup(connected = true) {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-cli-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const planned = planAgent({ name: "maple", preset: "dca", params: { buyOnStart: false } });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirmAgent(planned.agent));
  const baw = fakeBawBinary(dir, connected);
  // Port 9 (discard) refuses at once: the chain and the page cannot be asked.
  const env = { FEAST_LEAGUE_HOME: home, FEAST_LEAGUE_BAW: baw.path, FEAST_MAINNET_RPC_URL: "http://127.0.0.1:9", FEAST_LEAGUE_SITE: "http://127.0.0.1:9" };
  return { home, env, baw };
}

describe("feast-league register and launch, through the binary", () => {
  it("register --check: a signed-out wallet is told to sign in, and nothing is signed", async () => {
    const { env, baw } = setup(false);
    const out = await run(["register", "maple", "--check"], env);
    expect(out.code).toBe(2);
    expect(out.stdout.trim()).toBe('Sign in first: say "sign in" and scan the code in the Binance App.');
    expect(baw.calls()).toEqual(["wallet status"]);
  }, 60_000);

  it("register --check --lang zh: an Agent ID the chain cannot give is never taken for none", async () => {
    const { env, baw } = setup();
    const out = await run(["register", "maple", "--check", "--lang", "zh", "--json"], env);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, stage: "check", result: "agent-id-unreadable", card: "暂时没能从 BNB Smart Chain 读到 Agent ID。没有签名，也没有发送任何东西。过一分钟再试。" });
    expect(baw.calls().some((c) => c.startsWith("sign-message"))).toBe(false);
  }, 60_000);

  it("launch without --yes: the body coin's card, the product's split, and no transaction", async () => {
    const { env, baw } = setup();
    const out = await run(["launch", "maple", "--name", "maplegrin.ai", "--symbol", "maplegrin", "--json"], env);
    expect(out.code).toBe(2);
    const answer = JSON.parse(out.stdout) as { stage: string; symbol: string; quote: string; burn: number; referrer: number; card: string };
    expect(answer).toMatchObject({ stage: "card", symbol: "MAPLEGRIN", quote: "WBNB", burn: 20, referrer: 10 });
    expect(answer.card).toContain("Launch maplegrin.ai's body coin");
    expect(answer.card).toContain("This sends a real transaction from your wallet as soon as you say yes.");
    expect(answer.card).toMatch(/Not launched: this needs the user's yes \(--yes\)\.$/);
    expect(baw.calls().some((c) => c.startsWith("contract-call"))).toBe(false);
  }, 60_000);

  it("launch refuses a pair that is not WBNB or a listed tokenized stock", async () => {
    const { env } = setup();
    const out = await run(["launch", "maple", "--name", "x.ai", "--symbol", "X", "--quote", "DOGE"], env);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/the pair is WBNB or a listed tokenized stock: WBNB, AAPLB/);
  }, 60_000);

  it("status shows what is new once, in the user's language, and then only the latest", async () => {
    const { home, env } = setup();
    appendJsonl(agentPaths(home, "maple").notifications, { at: "2026-10-30T02:00:00.000Z", kind: "session", code: "ended", text: "Your wallet's sign-in has ended.", endsAt: null });
    const first = await run(["status", "maple", "--no-league", "--lang", "zh"], env);
    expect(first.stdout).toContain("new since the last status:");
    expect(first.stdout).toContain("钱包登录已到期。");
    const second = await run(["status", "maple", "--no-league", "--json"], env);
    expect(JSON.parse(second.stdout)).toMatchObject({ unread: [], league: null });
  }, 60_000);
});
