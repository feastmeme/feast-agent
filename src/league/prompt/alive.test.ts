import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "../agent.ts";
import { statusOf } from "../runtime.ts";
import { agentPaths, pidAlive, walletLockHolder, walletLockPath } from "../store.ts";

/**
 * Task 975, from the host rehearsal: under a sandboxed host (Codex's seatbelt) `process.kill(pid, 0)` answers EPERM
 * for a runtime that is alive. That is running: `FL status` must not say "not running", or the host starts a second one.
 */

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const probe = (code: string) =>
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(code), { code });
  });

function home() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-alive-"));
  dirs.push(dir);
  const promptPath = join(dir, "strategy.md");
  writeFileSync(promptPath, "Keep it small.\n");
  const planned = planAgent({ name: "demo", promptPath, preset: "steady" });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  const h = join(dir, "home");
  saveAgent(h, confirmAgent(planned.agent));
  writeFileSync(agentPaths(h, "demo").pid, "424242");
  writeFileSync(walletLockPath(h), JSON.stringify({ pid: 424242, agent: "demo", at: new Date().toISOString() }));
  return h;
}

describe("a live runtime the host may not signal", () => {
  it("EPERM is alive: FL status says running, and the wallet lock is held", () => {
    const h = home();
    probe("EPERM");
    expect(pidAlive(424242)).toBe(true);
    expect(statusOf(h, "demo").running).toBe(true);
    expect(walletLockHolder(h)).toMatchObject({ agent: "demo", pid: 424242 });
  });

  it("ESRCH is gone: not running, and the lock is stale", () => {
    const h = home();
    probe("ESRCH");
    expect(statusOf(h, "demo").running).toBe(false);
    expect(walletLockHolder(h)).toBeNull();
  });

  it("a pid file that holds no pid is no process (0 would name the process group)", () => {
    const h = home();
    const kill = vi.spyOn(process, "kill");
    for (const text of ["", "0", "-1", "abc"]) {
      writeFileSync(agentPaths(h, "demo").pid, text);
      expect(statusOf(h, "demo").running, JSON.stringify(text)).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
    expect(pidAlive(process.pid)).toBe(true);
  });
});
