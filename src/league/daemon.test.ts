import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { daemon, daemonPath, unitFile, type Runner } from "./daemon.ts";
import { bootId, otherBoot } from "./store.ts";

/**
 * Task 975, addendum 8 (gap G4): FL daemon's units for macOS and Linux, and its install, status and uninstall against
 * a fake `launchctl` / `systemctl` (nothing is loaded on this machine). The paths are a temporary folder's.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function where() {
  const dir = mkdtempSync(join(tmpdir(), "feast-league-975-daemon-"));
  dirs.push(dir);
  return { userHome: join(dir, "u"), home: join(dir, "u", ".feast-league"), node: "/opt/node/bin/node", bin: "/opt/feast-agent/src/league/bin.mjs", path: "/opt/node/bin:/usr/bin:/bin" };
}
function runner(codes: Record<string, number> = {}, says: Record<string, string> = { "launchctl print": "gui/501/meme.feast.league.maplegrin = {\n\tstate = running\n}", "systemctl --user is-active": "active\n" }) {
  const calls: string[] = [];
  const run: Runner = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const hit = Object.entries(codes).find(([k]) => line.startsWith(k));
    const said = Object.entries(says).find(([k]) => line.startsWith(k));
    return { code: hit ? hit[1] : 0, stdout: said ? said[1] : "", stderr: hit && hit[1] !== 0 ? "Bootstrap failed: 5: Input/output error" : "" };
  };
  return { calls, run };
}

describe("the units", () => {
  it("macOS: a LaunchAgent running FL run <name> --supervised, restarted only after an error, PATH and the home only", () => {
    const w = where();
    const u = unitFile({ platform: "darwin", name: "maplegrin", ...w });
    expect(u.path).toBe(join(w.userHome, "Library", "LaunchAgents", "meme.feast.league.maplegrin.plist"));
    for (const piece of ["<key>Label</key><string>meme.feast.league.maplegrin</string>", `<string>${w.node}</string>`, `<string>${w.bin}</string>`, "<string>run</string>", "<string>maplegrin</string>", "<string>--supervised</string>", "<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>", "<key>ThrottleInterval</key><integer>60</integer>", `<key>FEAST_LEAGUE_HOME</key><string>${w.home}</string>`, `<key>PATH</key><string>${w.path}</string>`]) expect(u.text, piece).toContain(piece);
    expect(u.text.match(/<key>[A-Z_]+<\/key><string>/g)!.filter((k) => /PATH|FEAST/.test(k))).toHaveLength(2);
    expect(u.text).not.toMatch(/RPC|KEY|TOKEN/);
  });

  it("Linux: a systemd user unit, Restart=on-failure, the same command and environment", () => {
    const w = where();
    const u = unitFile({ platform: "linux", name: "maplegrin", ...w });
    expect(u.path).toBe(join(w.userHome, ".config", "systemd", "user", "feast-league-maplegrin.service"));
    expect(u.text).toContain(`ExecStart="${w.node}" "${w.bin}" "run" "maplegrin" "--supervised"`);
    expect(u.text).toContain(`Environment="PATH=${w.path}"`);
    expect(u.text).toContain(`Environment="FEAST_LEAGUE_HOME=${w.home}"`);
    expect(u.text).toContain("Restart=on-failure\nRestartSec=60");
    expect(u.text).toContain("WantedBy=default.target");
  });

  it("the PATH: node's folder, the folders baw, claude and codex are found in, then the system's; nothing else of the environment", () => {
    expect(daemonPath({ PATH: "/nowhere", SECRET: "x" }, "/opt/node/bin/node")).toBe("/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("run 19: the Gemini CLI's and Cursor's folders too (an agent on them under the daemon found no CLI)", () => {
    const local = mkdtempSync(join(tmpdir(), "feast-league-975-path-"));
    dirs.push(local);
    writeFileSync(join(local, "cursor-agent"), "");
    writeFileSync(join(local, "gemini"), "");
    expect(daemonPath({ PATH: `/nowhere:${local}` }, "/opt/node/bin/node").split(":")).toContain(local);
  });
});

describe("install, status, uninstall", () => {
  it("macOS: written, bootstrapped into the user's GUI domain; status reads it; uninstall boots it out and removes it", async () => {
    const w = where();
    const r = runner();
    const base = { platform: "darwin" as const, name: "maplegrin", ...w, uid: 501, run: r.run, running: false, tempOk: true, sleep: async () => {} };
    const installed = await daemon({ ...base, action: "install" });
    expect(installed).toMatchObject({ ok: true, installed: true, loaded: true, running: true });
    // Run 19: kicked once (never -k), then its state read.
    expect(r.calls).toEqual([`launchctl bootstrap gui/501 ${installed.unit}`, "launchctl kickstart gui/501/meme.feast.league.maplegrin", "launchctl print gui/501/meme.feast.league.maplegrin"]);
    expect(readFileSync(installed.unit!, "utf8")).toContain("--supervised");
    expect(installed.lines[0]).toBe('"maplegrin" is now kept running by a LaunchAgent: it starts at log-in and after a reboot, and comes back within a minute after a crash. FL stop maplegrin stops it until FL resume maplegrin; FL daemon maplegrin --uninstall removes it.');
    // Installed again: the loaded one is booted out first.
    r.calls.length = 0;
    await daemon({ ...base, action: "install" });
    expect(r.calls.slice(0, 2)).toEqual(["launchctl bootout gui/501/meme.feast.league.maplegrin", `launchctl bootstrap gui/501 ${installed.unit}`]);
    const status = await daemon({ ...base, action: "status" });
    expect(status).toMatchObject({ installed: true, loaded: true });
    const gone = await daemon({ ...base, action: "uninstall" });
    expect(gone.ok).toBe(true);
    expect(existsSync(installed.unit!)).toBe(false);
    expect((await daemon({ ...base, action: "status" })).lines[0]).toMatch(/has no daemon/);
  });

  it("run 19: launchd takes the bootstrap and defers the spawn: the truth, and the command that starts it; never 'is kept running'", async () => {
    const w = where();
    const pending = runner({}, { "launchctl print": "gui/501/meme.feast.league.maplegrin = {\n\tstate = not running\n\tproperties = pending spawn | on-demand-only\n}" });
    let slept = 0;
    const base = { platform: "darwin" as const, name: "maplegrin", ...w, uid: 501, run: pending.run, running: false, tempOk: true, sleep: async (ms: number) => void (slept += ms) };
    const out = await daemon({ ...base, action: "install" });
    expect(out).toMatchObject({ ok: true, installed: true, running: false, startCommand: "launchctl kickstart gui/501/meme.feast.league.maplegrin" });
    expect(out.lines[0]).toBe('"maplegrin" has a LaunchAgent now (it starts at log-in and after a reboot), but launchd has not started it: its state is "not running", and the agent is NOT running. Start it now with `launchctl kickstart gui/501/meme.feast.league.maplegrin` (or FL start maplegrin).');
    expect(out.lines.join("\n")).not.toContain("is now kept running");
    expect(pending.calls.filter((c) => c.startsWith("launchctl kickstart"))).toEqual(["launchctl kickstart gui/501/meme.feast.league.maplegrin"]);
    expect(pending.calls.some((c) => c.includes("kickstart -k"))).toBe(false);
    // About ten seconds of looking, no more.
    expect(slept).toBe(10_000);
    // The agent's own alive record counts too (launchd's state may lag it).
    const alive = await daemon({ ...base, action: "install", isRunning: () => true });
    expect(alive.running).toBe(true);
    expect(alive.lines[0]).toMatch(/is now kept running by a LaunchAgent/);
  });

  it("run 19, Linux: enabled but not active: the same truth, with systemctl's own start", async () => {
    const w = where();
    const idle = runner({}, { "systemctl --user is-active": "inactive\n" });
    const out = await daemon({ platform: "linux", name: "maplegrin", ...w, uid: 1000, run: idle.run, running: false, tempOk: true, sleep: async () => {}, action: "install" });
    expect(out).toMatchObject({ running: false, startCommand: "systemctl --user start feast-league-maplegrin.service" });
    expect(out.lines[0]).toContain('but systemd has not started it: its state is "inactive", and the agent is NOT running. Start it now with `systemctl --user start feast-league-maplegrin.service` (or FL start maplegrin).');
  });

  it("Linux: daemon-reload, enable --now; a failure to load is said in one line", async () => {
    const w = where();
    const r = runner();
    const base = { platform: "linux" as const, name: "maplegrin", ...w, uid: 1000, run: r.run, running: true, tempOk: true };
    const installed = await daemon({ ...base, action: "install" });
    expect(r.calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now feast-league-maplegrin.service"]);
    expect(installed.lines).toContain("to start it at boot before anyone logs in: loginctl enable-linger (once, your choice)");
    expect(installed.lines).toContain("it is running now: the daemon's own start found it running and stood down; it takes over at the next log-in or reboot");
    const bad = runner({ "systemctl --user enable": 1 });
    const failed = await daemon({ ...base, run: bad.run, action: "install" });
    expect(failed.ok).toBe(false);
    expect(failed.lines[0]).toMatch(/could not be loaded: Bootstrap failed/);
  });

  it("a name that is not an agent's is refused before anything is written", async () => {
    const w = where();
    const r = runner();
    const out = await daemon({ platform: "darwin", name: "../x", ...w, uid: 1, run: r.run, running: false, action: "install" });
    expect(out.ok).toBe(false);
    expect(r.calls).toEqual([]);
  });
});

describe("after a reboot", () => {
  it("a lock or a pid file written under another boot is a stopped runtime's; an unknown boot never is (fails closed)", () => {
    expect(otherBoot("boot-a", "boot-b")).toBe(true);
    expect(otherBoot("boot-a", "boot-a")).toBe(false);
    // Written before addendum 8 (no boot), or this machine's boot unreadable: believed live.
    expect(otherBoot(undefined, "boot-a")).toBe(false);
    expect(otherBoot("boot-a", null)).toBe(false);
    // Read on this machine: the same each time, and the lock this process would write is of this boot.
    expect(bootId()).toBe(bootId());
    expect(otherBoot(bootId())).toBe(false);
  });
});
