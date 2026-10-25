import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";

/**
 * Task 967's flags as the skill runs them: `bin.mjs` in a child process, a fake `baw`, and the chain, the indexer
 * and feast.meme on a closed port. Nothing here reaches a network.
 */

const BIN = join(import.meta.dirname, "../bin.mjs");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-967-cli-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const planned = planAgent({ name: "maple", preset: "dca", params: { buyOnStart: false } });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirmAgent(planned.agent));
  const baw = join(dir, "baw");
  writeFileSync(
    baw,
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
  chmodSync(baw, 0o755);
  const closed = "http://127.0.0.1:9";
  return { home, env: { FEAST_LEAGUE_HOME: home, FEAST_LEAGUE_BAW: baw, FEAST_MAINNET_RPC_URL: closed, FEAST_LEAGUE_SITE: closed, FEAST_LEAGUE_INDEXER: closed } };
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe("--poll, --live and --no-jitter, through the binary", () => {
  it("--help lists them", async () => {
    const { env } = setup();
    const out = await run(["--help"], env);
    expect(out.code).toBe(0);
    for (const word of ["--poll <s>", "--live", "--no-jitter"]) expect(out.stdout, word).toContain(word);
    expect(out.stdout).toMatch(/data \[<name>\][^\n]*--live/);
  }, 60_000);

  it("start --poll 2: one line, exit 2, nothing started; resume and run refuse it too", async () => {
    const { env } = setup();
    for (const command of [["start", "maple", "--yes"], ["resume", "maple"], ["run", "maple"]]) {
      const out = await run([...command, "--poll", "2"], env);
      expect(out.code, command.join(" ")).toBe(2);
      expect(out.stdout.trim()).toBe("the poll is at least 3 s");
      expect(out.stderr.trim()).toBe("");
    }
  }, 60_000);

  it("start in the foreground says when it starts reading the market; --no-jitter says nothing of the kind", async () => {
    const { env } = setup();
    const jittered = await run(["start", "maple", "--yes", "--max-runtime", "2", "--foreground"], env);
    expect(jittered.stdout).toMatch(/^starts reading the market within \d{1,3} s$/m);
    const n = Number(/within (\d+) s/.exec(jittered.stdout)![1]);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(120);
    const plain = await run(["start", "maple", "--yes", "--max-runtime", "2", "--no-jitter", "--poll", "3", "--foreground"], env);
    expect(plain.stdout).not.toMatch(/starts reading the market/);
    expect(plain.stdout).toMatch(/maple: finished/);
  }, 60_000);
});

describe("run 19: FL start runs the agent in the background by default", () => {
  it("started in the background, and it keeps running when the command that started it is gone", async () => {
    const { env, home } = setup();
    const out = await run(["start", "maple", "--yes", "--max-runtime", "6", "--no-jitter"], { ...env, FEAST_LEAGUE_DAEMON: "off" });
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^started "maple" in the background \(pid \d+\): it keeps running when this shell closes; FL status maple$/m);
    // The command has exited; the agent has not (yet): its own line comes when its max runtime is up.
    const outFile = join(home, "agents", "maple", "runtime.out");
    expect(existsSync(outFile) ? readFileSync(outFile, "utf8") : "").not.toMatch(/maple: finished/);
    for (let i = 0; i < 60 && !(existsSync(outFile) && /maple: finished/.test(readFileSync(outFile, "utf8"))); i++) await new Promise((r) => setTimeout(r, 250));
    expect(readFileSync(outFile, "utf8")).toMatch(/maple: finished/);
  }, 60_000);

  it("a start that exits at once is said with its own line, never 'started'; a stopped agent is sent to FL resume", async () => {
    const { env } = setup();
    const dir = mkdtempSync(join(tmpdir(), "feast-league-975-signedout-"));
    dirs.push(dir);
    const out = join(dir, "baw");
    writeFileSync(out, `#!${process.execPath}\nconst c = process.argv.slice(2, 4).join(" ");\nif (c === "wallet status") console.log(JSON.stringify({ success: true, data: { status: "UNCONNECTED" } }));\nelse console.log(JSON.stringify({ success: false, error: { name: "NOT_IN_THIS_TEST" } }));\n`);
    chmodSync(out, 0o755);
    const ended = await run(["start", "maple", "--yes", "--no-jitter"], { ...env, FEAST_LEAGUE_BAW: out, FEAST_LEAGUE_DAEMON: "off" });
    expect(ended.code).toBe(2);
    expect(ended.stdout).toMatch(/^"maple" did not keep running: maple: (refused|error) — /m);
    expect(ended.stdout).not.toMatch(/started "maple"/);
    expect((await run(["stop", "maple"], env)).code).toBe(0);
    const stopped = await run(["start", "maple", "--yes"], { ...env, FEAST_LEAGUE_DAEMON: "off" });
    expect(stopped.code).toBe(2);
    expect(stopped.stdout.trim()).toBe('"maple" is stopped (stop requested by the user): FL resume maple removes the stop and starts it');
  }, 60_000);
});

describe("run 21: a manual agent's FL buy with no process running", () => {
  it("the one-shot runs it under the season gate: refused with the loop's words, the last manual action kept, nothing left running", async () => {
    const { env, home } = setup();
    const dir = mkdtempSync(join(tmpdir(), "feast-league-975-manualbuy-"));
    dirs.push(dir);
    writeFileSync(join(dir, "strategy.md"), "Trade by hand.\n");
    const planned = planAgent({ name: "handy", promptPath: join(dir, "strategy.md"), preset: "steady" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, { ...confirmAgent(planned.agent), league: { waitForSeason: true }, manual: true });
    const out = await run(["buy", "handy", "FEAST", "0.006"], { ...env, FEAST_LEAGUE_DAEMON: "off" });
    expect(out.code).toBe(2);
    expect(out.stdout.trim()).toBe("handy: refused — the season has not started; it opens when feast.meme announces the start");
    const last = JSON.parse(readFileSync(join(home, "agents", "handy", "manual-last.json"), "utf8")) as { what: string };
    expect(last.what).toBe("buy: handy: refused — the season has not started; it opens when feast.meme announces the start");
    expect(existsSync(join(home, "agents", "handy", "alive.json"))).toBe(false);
  }, 60_000);
});
