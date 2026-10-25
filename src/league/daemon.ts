import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { checkAgentName } from "./store.ts";

/**
 * `FL daemon <name> --install | --uninstall | --status` (task 975, addendum 8, gap G4): the agent kept running across
 * a reboot, a crash or a log-out, by the machine's own supervisor, never by a process of ours.
 *
 * - macOS: a LaunchAgent, `~/Library/LaunchAgents/meme.feast.league.<name>.plist`, loaded into the user's GUI domain
 *   (`launchctl bootstrap gui/<uid>`), so the wallet's and the AI's logins in the user's keychain are there.
 * - Linux: a systemd user unit, `~/.config/systemd/user/feast-league-<name>.service`, enabled with `systemctl --user`.
 *   It starts at log-in; at boot without a log-in only with `loginctl enable-linger` (the player's choice, said).
 *
 * It runs `FL run <name> --supervised`: an exit on an error is restarted (at most once a minute); a stop file, a
 * signed-out wallet or any other refusal exits 0 and is not (no loop of restarts against a wallet that says no; the
 * next log-in or reboot tries again). `FL stop <name>` stops it for good until `FL resume <name>`.
 *
 * The unit carries no secret: its environment is a PATH built from where `node`, `baw` and the hosts' CLIs are
 * found, and `FEAST_LEAGUE_HOME`. Nothing of the shell's environment is copied into it; a keyed RPC URL
 * (`FEAST_MAINNET_RPC_URL`) is the player's to add to the unit by hand, never written by this command.
 */

export type DaemonPlatform = "darwin" | "linux";
export type Runner = (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const daemonLabel = (name: string) => `meme.feast.league.${name}`;
export const unitName = (name: string) => `feast-league-${name}.service`;

/** The tools the agent runs, found on PATH now: their folders, then the system's. Paths only, no other value. */
export function daemonPath(env: Record<string, string | undefined>, node: string): string {
  const dirs = new Set<string>([dirname(node)]);
  // Run 19: every host's CLI (a Gemini or Cursor agent under the daemon found no CLI of its own).
  for (const tool of ["baw", "claude", "codex", "gemini", "cursor-agent", "agent"]) {
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      if (dir && existsSync(join(dir, tool))) {
        dirs.add(dir);
        break;
      }
    }
  }
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) dirs.add(dir);
  return [...dirs].join(":");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** systemd's quoting: a word in double quotes, with `"`, `\` escaped and `%` doubled. */
const sd = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export type UnitInput = { platform: DaemonPlatform; name: string; home: string; userHome: string; node: string; bin: string; path: string };

export function unitFile(u: UnitInput): { path: string; text: string } {
  const args = [u.node, u.bin, "run", u.name, "--supervised"];
  const out = join(u.home, "agents", u.name, "runtime.out");
  if (u.platform === "darwin") {
    return {
      path: join(u.userHome, "Library", "LaunchAgents", `${daemonLabel(u.name)}.plist`),
      text: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `  <key>Label</key><string>${xml(daemonLabel(u.name))}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        ...args.map((a) => `    <string>${xml(a)}</string>`),
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        `    <key>PATH</key><string>${xml(u.path)}</string>`,
        `    <key>FEAST_LEAGUE_HOME</key><string>${xml(u.home)}</string>`,
        "  </dict>",
        "  <key>RunAtLoad</key><true/>",
        "  <!-- Restarted after an exit on an error; a refusal or a stop exits 0 and stays down. -->",
        "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "  <key>ThrottleInterval</key><integer>60</integer>",
        `  <key>StandardOutPath</key><string>${xml(out)}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(out)}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    };
  }
  return {
    path: join(u.userHome, ".config", "systemd", "user", unitName(u.name)),
    text: [
      "[Unit]",
      `Description=Feast league agent ${u.name}`,
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      `ExecStart=${args.map(sd).join(" ")}`,
      `Environment=${sd(`PATH=${u.path}`)}`,
      `Environment=${sd(`FEAST_LEAGUE_HOME=${u.home}`)}`,
      "# Restarted after an exit on an error; a refusal or a stop exits 0 and stays down.",
      "Restart=on-failure",
      "RestartSec=60",
      `StandardOutput=append:${out}`,
      `StandardError=append:${out}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  };
}

/**
 * `running`: after an install, whether the supervisor really started the agent (run 19: launchd took the bootstrap and
 * deferred the spawn, "pending spawn, domain in on-demand-only mode", and the line said it was running). Null when
 * not asked (status, uninstall). `startCommand`: the supervisor's own command to start it now, when it is not running.
 */
export type DaemonResult = { ok: boolean; installed: boolean; loaded: boolean | null; unit: string | null; lines: string[]; running?: boolean | null; startCommand?: string | null };

/** How long an install waits to see the agent running (the supervisor's state, or the agent's own alive record). */
export const DAEMON_VERIFY_MS = 10_000;

/**
 * A league home in the system's temporary folder (addendum 11) is gone after a reboot, and a unit pointing at it would
 * start an agent with no book: no daemon is installed for one (`tempOk` is the tests' own, for their fake supervisor).
 */
export function inTemp(path: string, temp: string = tmpdir()): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  // Both the path as given and its real one (macOS's /var is /private/var), against both forms of each temp folder.
  const paths = [resolve(path), real(path)];
  const temps = [temp, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].flatMap((t) => [resolve(t), real(t)]);
  return paths.some((p) => temps.some((t) => p === t || p.startsWith(`${t}/`)));
}

/** Windows has no FL daemon (addendum 11): the Task Scheduler line the player runs once, at log-on, and its removal. */
export function windowsLines(o: { name: string; node: string; bin: string }): string[] {
  const task = `FeastLeague-${o.name}`;
  return [
    `Windows: no daemon is installed by FL. To start "${o.name}" at every log-on, run once in a Command Prompt:`,
    `schtasks /Create /SC ONLOGON /TN "${task}" /TR "\\"${o.node}\\" \\"${o.bin}\\" run ${o.name} --supervised" /RL LIMITED /F`,
    `(remove it with: schtasks /Delete /TN "${task}" /F). A machine that sleeps still stops it: keep it awake for the season.`,
  ];
}

export async function daemon(
  o: UnitInput & {
    action: "install" | "uninstall" | "status";
    uid: number;
    run: Runner;
    running: boolean;
    tempOk?: boolean;
    /** The agent's own alive record, read again while the install waits (run 19). */
    isRunning?: () => boolean;
    verifyMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DaemonResult> {
  try {
    checkAgentName(o.name);
  } catch (error) {
    return { ok: false, installed: false, loaded: null, unit: null, lines: [(error as Error).message] };
  }
  if (o.action === "install" && !o.tempOk && inTemp(o.home)) return { ok: false, installed: false, loaded: null, unit: null, lines: [`no daemon: the league home is in the temporary folder, which a reboot clears (${o.home}); FEAST_LEAGUE_HOME elsewhere first`] };
  // Run 21 (the Grok cloud rehearsal): a Linux with no systemd user manager (a container, a cloud computer) has no
  // unit to install or to read: say so, never "a systemd user unit".
  if (o.platform === "linux" && o.action !== "uninstall" && !(await userManager(o.run))) {
    const lines = [NO_MANAGER_LINE, ...(o.action === "status" ? [`the agent: ${o.running ? "running" : "not running"}`] : [])];
    return { ok: o.action === "status", installed: false, loaded: null, unit: null, lines, running: o.action === "install" ? false : null };
  }
  const unit = unitFile(o);
  const domain = `gui/${o.uid}`;
  const loaded = async (): Promise<boolean | null> => {
    const got = o.platform === "darwin" ? await o.run("launchctl", ["print", `${domain}/${daemonLabel(o.name)}`]).catch(() => null) : await o.run("systemctl", ["--user", "is-enabled", unitName(o.name)]).catch(() => null);
    return got ? got.code === 0 : null;
  };
  const where = o.platform === "darwin" ? "a LaunchAgent" : "a systemd user unit";
  if (o.action === "status") {
    const installed = existsSync(unit.path);
    const isLoaded = installed ? await loaded() : false;
    return {
      ok: true,
      installed,
      loaded: isLoaded,
      unit: installed ? unit.path : null,
      lines: [installed ? `"${o.name}" is kept running by ${where} (${isLoaded ? "loaded" : isLoaded === null ? "its state could not be read" : "not loaded"}): it starts at log-in and after a crash` : `"${o.name}" has no daemon: it runs only while this session's process lives; FL daemon ${o.name} --install keeps it up across reboots`, `the agent: ${o.running ? "running" : "not running"}`],
    };
  }
  if (o.action === "uninstall") {
    if (o.platform === "darwin") await o.run("launchctl", ["bootout", `${domain}/${daemonLabel(o.name)}`]).catch(() => null);
    else await o.run("systemctl", ["--user", "disable", "--now", unitName(o.name)]).catch(() => null);
    const had = existsSync(unit.path);
    rmSync(unit.path, { force: true });
    if (o.platform === "linux") await o.run("systemctl", ["--user", "daemon-reload"]).catch(() => null);
    return { ok: true, installed: false, loaded: false, unit: null, lines: [had ? `the daemon for "${o.name}" is removed: it no longer starts by itself (a running agent keeps running; FL stop ${o.name} stops it)` : `"${o.name}" had no daemon`] };
  }
  mkdirSync(dirname(unit.path), { recursive: true });
  const before = existsSync(unit.path) ? readFileSync(unit.path, "utf8") : null;
  writeFileSync(unit.path, unit.text, { mode: 0o644 });
  let started: { code: number; stderr: string } | null;
  if (o.platform === "darwin") {
    // A unit loaded already is unloaded first, so the file just written is the one that runs.
    if (before !== null) await o.run("launchctl", ["bootout", `${domain}/${daemonLabel(o.name)}`]).catch(() => null);
    started = await o.run("launchctl", ["bootstrap", domain, unit.path]).catch((error: unknown) => ({ code: 1, stderr: String((error as Error).message) }));
  } else {
    await o.run("systemctl", ["--user", "daemon-reload"]).catch(() => null);
    started = await o.run("systemctl", ["--user", "enable", "--now", unitName(o.name)]).catch((error: unknown) => ({ code: 1, stderr: String((error as Error).message) }));
  }
  const ok = started !== null && started.code === 0;
  if (!ok) return { ok, installed: true, loaded: false, unit: unit.path, running: false, lines: [`the unit is written (${unit.path}) but could not be loaded: ${(started?.stderr ?? "").trim().split("\n").slice(-1)[0] || "no answer"}`] };
  // Run 19: loaded is not running. launchd may defer the spawn: kick it once (never `-k`, which would restart a running
  // one), then look, for up to ten seconds, at the supervisor's own state and at the agent's alive record.
  const startCommand = supervisorStart(o.platform, o.uid, o.name);
  let running = o.running;
  let state: string | null = null;
  if (!running) ({ running, state } = await kickAndLook({ ...o, kick: o.platform === "darwin" }));
  const lines = running
    ? [
        `"${o.name}" is now kept running by ${where}: it starts at log-in and after a reboot, and comes back within a minute after a crash. FL stop ${o.name} stops it until FL resume ${o.name}; FL daemon ${o.name} --uninstall removes it.`,
        ...(o.running ? [`it is running now: the daemon's own start found it running and stood down; it takes over at the next log-in or reboot`] : []),
        ...(o.platform === "linux" ? ["to start it at boot before anyone logs in: loginctl enable-linger (once, your choice)"] : []),
        "its environment is PATH and FEAST_LEAGUE_HOME only: a keyed FEAST_MAINNET_RPC_URL is not copied; add it to the unit yourself if you use one",
      ]
    : [
        `"${o.name}" has ${where} now (it starts at log-in and after a reboot), but ${o.platform === "darwin" ? "launchd" : "systemd"} has not started it: ${state ? `its state is "${state}"` : "its state could not be read"}, and the agent is NOT running. Start it now with \`${startCommand}\` (or FL start ${o.name}).`,
        "its environment is PATH and FEAST_LEAGUE_HOME only: a keyed FEAST_MAINNET_RPC_URL is not copied; add it to the unit yourself if you use one",
      ];
  return { ok, installed: true, loaded: true, unit: unit.path, lines, running, startCommand: running ? null : startCommand };
}

/** The supervisor's own command that starts the agent now (said to the player when it did not). */
export const supervisorStart = (platform: DaemonPlatform, uid: number, name: string) => (platform === "darwin" ? `launchctl kickstart gui/${uid}/${daemonLabel(name)}` : `systemctl --user start ${unitName(name)}`);

type Look = { platform: DaemonPlatform; name: string; uid: number; run: Runner; isRunning?: () => boolean; verifyMs?: number; sleep?: (ms: number) => Promise<void>; kick: boolean };
/**
 * Run 19: start it once (launchd's `kickstart`, never `-k`, which would restart a running one; systemd's `start`), then
 * look, for up to ten seconds, at the supervisor's own state and at the agent's alive record.
 */
async function kickAndLook(o: Look): Promise<{ running: boolean; state: string | null }> {
  const label = `gui/${o.uid}/${daemonLabel(o.name)}`;
  if (o.kick) await (o.platform === "darwin" ? o.run("launchctl", ["kickstart", label]) : o.run("systemctl", ["--user", "start", unitName(o.name)])).catch(() => null);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = o.verifyMs ?? DAEMON_VERIFY_MS;
  let state: string | null = null;
  for (let waited = 0; ; waited += 500) {
    const read = o.platform === "darwin" ? await o.run("launchctl", ["print", label]).catch(() => null) : await o.run("systemctl", ["--user", "is-active", unitName(o.name)]).catch(() => null);
    state = o.platform === "darwin" ? (/^\s*state = (.+)$/m.exec(read?.stdout ?? "")?.[1]?.trim() ?? null) : read?.stdout.trim() || null;
    const running = (o.platform === "darwin" ? state === "running" : state === "active") || o.isRunning?.() === true;
    if (running || waited >= until) return { running, state };
    await sleep(500);
  }
}

/**
 * `FL start` with a daemon installed (run 19): the daemon starts it (so it outlives the player's shell and comes back
 * after a crash), and the result is looked at, not assumed. `installed: false` when this agent has no daemon.
 */
export async function kickDaemon(o: Omit<Look, "kick"> & { userHome: string }): Promise<{ installed: boolean; running: boolean; state: string | null; startCommand: string }> {
  const startCommand = supervisorStart(o.platform, o.uid, o.name);
  const path = o.platform === "darwin" ? join(o.userHome, "Library", "LaunchAgents", `${daemonLabel(o.name)}.plist`) : join(o.userHome, ".config", "systemd", "user", unitName(o.name));
  if (!existsSync(path)) return { installed: false, running: false, state: null, startCommand };
  const seen = await kickAndLook({ ...o, kick: true });
  return { installed: true, ...seen, startCommand };
}

export const NO_MANAGER_LINE = "no service manager here: keep it running yourself, or FL start on a schedule";

/** Whether `systemctl --user` has a manager to talk to (missing, or "Failed to connect to bus": none). */
async function userManager(run: Runner): Promise<boolean> {
  const got = await run("systemctl", ["--user", "is-system-running"]).catch(() => null);
  if (!got || got.code === 127) return false;
  const said = `${got.stdout}\n${got.stderr}`;
  if (/failed to connect|not been booted|no such file|command not found|offline/i.test(said)) return false;
  return /\b(running|degraded|starting|initializing|maintenance|stopping)\b/.test(got.stdout);
}
