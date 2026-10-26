import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseBook } from "../book.ts";
import { daemonLabel, unitName } from "../daemon.ts";
import { ENTRY_AGENT } from "../enter/constants.ts";
import { readGate } from "../season-gate.ts";
import { agentPaths, readJson, removeStop, writeStop } from "../store.ts";
import { openAboveDust, safePoint } from "./auto.ts";
import type { AgentControl, DoctorResult, Running, UpgradeDeps } from "./engine.ts";
import { skillFolders } from "./engine.ts";
import { RELEASE_PUBLIC_KEY } from "./release-key.ts";

/**
 * `FL upgrade`'s doors on a real machine (task 975, run 23): git or the tag's tarball, `npm ci`, the new runtime's own
 * `FL doctor`, `FL start` and `FL daemon --install`, the installed skill's folders. The engine (`engine.ts`) decides;
 * this only does. `FEAST_LEAGUE_RELEASES` and `FEAST_LEAGUE_RELEASE_GIT` point the fetch elsewhere (the dry run's
 * fixtures); by default it is the public repository's tag.
 */

export const RELEASE_REPO = "https://github.com/feastmeme/feast-agent";
export const TARBALLS = "https://codeload.github.com/feastmeme/feast-agent/tar.gz/refs/tags";
const MAX_TARBALL = 50 * 1024 * 1024;

export type Run = (command: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const run: Run = (command, args, o = {}) =>
  new Promise((done) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 120_000);
    child.stdout?.on("data", (d: Buffer) => (stdout.length < 4_000_000 ? (stdout += d.toString("utf8")) : undefined));
    child.stderr?.on("data", (d: Buffer) => (stderr.length < 400_000 ? (stderr += d.toString("utf8")) : undefined));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

export function activePointer(env: NodeJS.ProcessEnv = process.env): string {
  return env.FEAST_LEAGUE_RUNTIME?.trim() || join(homedir(), ".feast-league", "runtime");
}

/** The agents of a league home, and how each runs: by its daemon, or in the background with its flags. */
export function agentControl(o: { home: string; run: Run; isRunning: (name: string) => boolean; stopWaitMs?: number }): AgentControl {
  const platform = process.platform;
  const hasDaemon = (name: string) =>
    platform === "darwin" ? existsSync(join(homedir(), "Library", "LaunchAgents", `${daemonLabel(name)}.plist`)) : platform === "linux" ? existsSync(join(homedir(), ".config", "systemd", "user", unitName(name))) : false;
  const env = { ...process.env, FEAST_LEAGUE_HOME: o.home };
  const bin = (root: string) => join(root, "src", "league", "bin.mjs");
  return {
    running(): Running[] {
      const dir = join(o.home, "agents");
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((n) => n !== ENTRY_AGENT && o.isRunning(n))
        .map((name) => ({ name, daemon: hasDaemon(name), args: launchArgs(o.home, name) }));
    },
    async stop(names) {
      for (const n of names) writeStop(agentPaths(o.home, n).stop, "FL upgrade: restarting on the new release");
      const until = Date.now() + (o.stopWaitMs ?? 90_000);
      while (Date.now() < until && names.some((n) => o.isRunning(n))) await new Promise((r) => setTimeout(r, 500));
      for (const n of names) removeStop(agentPaths(o.home, n).stop);
      return names.filter((n) => o.isRunning(n));
    },
    async start(root, agents) {
      const failed: string[] = [];
      for (const a of agents) {
        if (a.daemon) {
          const out = await o.run(process.execPath, [bin(root), "daemon", a.name, "--install"], { env });
          if (out.code === 0) continue;
        }
        const out = await o.run(process.execPath, [bin(root), "start", a.name, ...a.args], { env });
        if (out.code !== 0) failed.push(a.name);
      }
      return failed;
    },
  };
}

/** The flags an agent was started with (`launch.json`, written at each background start), those worth keeping. */
export function launchArgs(home: string, name: string): string[] {
  const got = readJson<{ args?: unknown }>(join(agentPaths(home, name).dir, "launch.json"))?.args;
  if (!Array.isArray(got)) return [];
  const out: string[] = [];
  for (let i = 0; i < got.length; i++) {
    const a = got[i];
    if (a === "--live" || a === "--no-jitter" || a === "--auto-upgrade") out.push(a);
    else if ((a === "--poll" || a === "--max-runtime") && typeof got[i + 1] === "string" && /^\d{1,6}$/.test(got[i + 1] as string)) out.push(a, got[++i] as string);
  }
  return out;
}

/** The new (or old) runtime's own `FL doctor --json`: the checks that did not pass. */
export function doctorAt(o: { home: string; run: Run }) {
  return async (root: string): Promise<DoctorResult> => {
    const out = await o.run(process.execPath, [join(root, "src", "league", "bin.mjs"), "doctor", "--json"], { env: { ...process.env, FEAST_LEAGUE_HOME: o.home }, timeoutMs: 90_000 });
    try {
      const checks = JSON.parse(out.stdout) as { what: string; ok: boolean }[];
      if (!Array.isArray(checks)) throw new Error("not a list");
      const failed = checks.filter((c) => !c.ok).map((c) => String(c.what));
      return { ok: failed.length === 0, failed };
    } catch {
      return { ok: false, failed: [`FL doctor did not answer (${lastLine(out.stderr) || `exit ${out.code}`})`] };
    }
  };
}

export function realUpgradeDeps(o: { home: string; isRunning: (name: string) => boolean; say: (line: string) => void; env?: NodeJS.ProcessEnv; publicKey?: string | null }): UpgradeDeps {
  const env = o.env ?? process.env;
  const control = agentControl({ home: o.home, run, isRunning: o.isRunning });
  return {
    pointer: activePointer(env),
    skillDirs: skillFolders([env.FEAST_LEAGUE_SKILL_DIR?.trim() ?? "", join(homedir(), ".agents", "skills", "feast-league"), join(homedir(), ".claude", "skills", "feast-league")].filter(Boolean)),
    publicKey: o.publicKey === undefined ? RELEASE_PUBLIC_KEY : o.publicKey,
    async fetchRelease(tag, dest, layout) {
      if (layout === "git") {
        const repo = env.FEAST_LEAGUE_RELEASE_GIT?.trim() || RELEASE_REPO;
        const out = await run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, repo, dest], { timeoutMs: 300_000 });
        if (out.code !== 0) throw new Error(lastLine(out.stderr) || `git exited ${out.code}`);
        return;
      }
      const base = (env.FEAST_LEAGUE_RELEASES?.trim() || TARBALLS).replace(/\/+$/, "");
      const r = await fetch(`${base}/${tag}`, { signal: AbortSignal.timeout(300_000) });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > MAX_TARBALL) throw new Error("the tarball is over 50 MB");
      mkdirSync(dest, { recursive: true });
      const tgz = `${dest}.tar.gz`;
      writeFileSync(tgz, body);
      try {
        // --no-same-owner: no chown (a sandbox refuses it; its errors are why tar would fail there).
        const out = await run("tar", ["xzf", tgz, "-C", dest, "--strip-components=1", "--no-same-owner"]);
        if (out.code !== 0) throw new Error(lastLine(out.stderr) || `tar exited ${out.code}`);
      } finally {
        rmSync(tgz, { force: true });
      }
    },
    async install(dest) {
      const out = await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: dest, timeoutMs: 600_000 });
      if (out.code !== 0) throw new Error(lastLine(out.stderr) || `npm exited ${out.code}`);
    },
    agents: control,
    doctor: doctorAt({ home: o.home, run }),
    safePoint() {
      const running = control.running();
      let open = 0;
      let opensAt: number | null = null;
      for (const a of running) {
        const state = agentPaths(o.home, a.name).state;
        if (existsSync(state)) open += openAboveDust(parseBook(readFileSync(state, "utf8")).positions);
        const g = readGate(o.home, a.name);
        if (g?.opensAt) opensAt = Date.parse(g.opensAt);
      }
      return safePoint(Date.now(), open, opensAt);
    },
    async report(root, names) {
      for (const n of names) await run(process.execPath, [join(root, "src", "league", "bin.mjs"), "report", n], { env: { ...process.env, FEAST_LEAGUE_HOME: o.home } });
    },
    say: o.say,
  };
}
