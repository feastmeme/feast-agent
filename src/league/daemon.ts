import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

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
 * The unit carries no secret: its environment is a PATH built from where `node`, `baw`, `claude` and `codex` are
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
  for (const tool of ["baw", "claude", "codex"]) {
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

export type DaemonResult = { ok: boolean; installed: boolean; loaded: boolean | null; unit: string | null; lines: string[] };

export async function daemon(o: UnitInput & { action: "install" | "uninstall" | "status"; uid: number; run: Runner; running: boolean }): Promise<DaemonResult> {
  try {
    checkAgentName(o.name);
  } catch (error) {
    return { ok: false, installed: false, loaded: null, unit: null, lines: [(error as Error).message] };
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
  const lines = ok
    ? [
        `"${o.name}" is now kept running by ${where}: it starts at log-in and after a reboot, and comes back within a minute after a crash. FL stop ${o.name} stops it until FL resume ${o.name}; FL daemon ${o.name} --uninstall removes it.`,
        ...(o.running ? [`it is running now: the daemon's own start found it running and stood down; it takes over at the next log-in or reboot`] : []),
        ...(o.platform === "linux" ? ["to start it at boot before anyone logs in: loginctl enable-linger (once, your choice)"] : []),
        "its environment is PATH and FEAST_LEAGUE_HOME only: a keyed FEAST_MAINNET_RPC_URL is not copied; add it to the unit yourself if you use one",
      ]
    : [`the unit is written (${unit.path}) but could not be loaded: ${(started?.stderr ?? "").trim().split("\n").slice(-1)[0] || "no answer"}`];
  return { ok, installed: true, loaded: ok, unit: unit.path, lines };
}
