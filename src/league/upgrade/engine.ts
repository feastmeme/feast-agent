import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { LeagueRead } from "../register/site.ts";
import { patchStep, releaseNumber } from "../version.ts";
import { CANARY_MS } from "./auto.ts";
import { readManifest, verifySignature, verifyTree } from "./manifest.ts";

/**
 * `FL upgrade` (task 975, run 23): one command from this release to the one feast.meme names, and back if it fails.
 *
 * 1. The release is fetched into a NEW folder beside the current one (`<…>/runtimes/<tag>`): a git clone where the
 *    current runtime is one, else the tag's tarball (a sandbox has no git). Nothing in the current one is touched.
 * 2. It is checked: every file against the release's manifest, the manifest's tag, the signature with the release key
 *    this runtime ships (auto-upgrade never runs without one); then `npm ci`.
 * 3. The agents that run are stopped (their stop file, then it is removed again), the pointer is switched (the active
 *    runtime path becomes a link to the new folder; the first time, the folder there is parked under `runtimes/`),
 *    the installed skill's files are refreshed from the release, and the agents start again from it, each as it ran
 *    (a daemon's agent by its daemon, a background one with the same flags). Manual agents run nothing: untouched.
 * 4. `FL doctor` runs from the new one. A check that fails now and passed before (auto: any check), or an agent that
 *    does not start again, rolls everything back: the pointer, the skill's files, the agents restarted from the old
 *    one; what failed is said (and, auto, sent with `FL report`).
 *
 * Twice is once: on the newest release already, it says so and does nothing.
 */

export type Running = { name: string; daemon: boolean; args: string[] };
export type AgentControl = {
  running(): Running[];
  /** The names that did not stop. */
  stop(names: string[]): Promise<string[]>;
  /** The names that did not start, from `root`. */
  start(root: string, agents: Running[]): Promise<string[]>;
};
export type DoctorResult = { ok: boolean; failed: string[] };

export type UpgradeDeps = {
  /** The active runtime path (`$HOME/.feast-league/runtime`, or `FEAST_LEAGUE_RUNTIME`): a folder, or a link to one. */
  pointer: string;
  /** The installed skill's folders (`npx skills add`'s), refreshed with the runtime. */
  skillDirs: string[];
  publicKey: string | null;
  fetchRelease(tag: string, dest: string, layout: "git" | "tarball"): Promise<void>;
  install(dest: string): Promise<void>;
  agents: AgentControl;
  doctor(root: string): Promise<DoctorResult>;
  /** Auto only: rail (c), over every agent that would restart. */
  safePoint?(): { ok: true } | { ok: false; why: string };
  /** Auto only: a rollback is sent with `FL report` from the old runtime. */
  report?(root: string, names: string[], why: string): Promise<void>;
  say(line: string): void;
  now?(): number;
};

export type UpgradeOutcome =
  | { kind: "current"; tag: string }
  | { kind: "refused"; why: string }
  /** Before the switch: nothing changed. */
  | { kind: "failed"; why: string }
  | { kind: "upgraded"; from: string; to: string; restarted: string[]; signed: boolean }
  | { kind: "rolled-back"; from: string; to: string; why: string; restarted: string[] };

/** The release a runtime folder is, from its own `RUNTIME_RELEASE`. */
export function installedTag(root: string): string | null {
  try {
    return /RUNTIME_RELEASE = "(league-v[0-9.]+)"/.exec(readFileSync(join(root, "src", "league", "headers.ts"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

export const runtimesDir = (pointer: string) => join(dirname(pointer), "runtimes");

export async function upgrade(deps: UpgradeDeps, o: { latest: NonNullable<LeagueRead["latestRuntime"]>; auto: boolean }): Promise<UpgradeOutcome> {
  const now = deps.now ?? Date.now;
  if (process.platform === "win32") return { kind: "refused", why: "FL upgrade runs on macOS and Linux; on Windows, install the new release by hand" };
  let oldRoot: string;
  try {
    oldRoot = realpathSync(deps.pointer);
  } catch {
    return { kind: "refused", why: `no runtime at ${deps.pointer}` };
  }
  const current = installedTag(oldRoot);
  if (!current) return { kind: "refused", why: "the active runtime's release cannot be read" };
  const target = o.latest.tag;
  if (o.latest.badVersions?.includes(target)) return { kind: "refused", why: `${target} is on feast.meme's bad versions: not installed` };
  const mine = releaseNumber(current);
  const theirs = releaseNumber(target);
  if (mine === null || theirs === null || theirs <= mine) return { kind: "current", tag: current };
  if (o.auto) {
    if (!patchStep(current, target)) return { kind: "refused", why: `${target} is not a patch of ${current}: auto-upgrade never crosses a minor` };
    if (!deps.publicKey) return { kind: "refused", why: "this runtime carries no release key: auto-upgrade needs a signed release" };
    if (o.latest.autoUpgradeFrom === undefined || o.latest.autoUpgradeFrom === null || now() - o.latest.autoUpgradeFrom < CANARY_MS) return { kind: "refused", why: `${target} is not canary-passed for 60 minutes yet` };
    const safe = deps.safePoint?.() ?? { ok: false as const, why: "no safe point was checked" };
    if (!safe.ok) return { kind: "refused", why: safe.why };
  }

  // 1–2: the new folder, fetched and checked; nothing of the current one is touched.
  const runtimes = runtimesDir(deps.pointer);
  mkdirSync(runtimes, { recursive: true });
  const dest = join(runtimes, target);
  const layout = existsSync(join(oldRoot, ".git")) ? "git" : "tarball";
  const drop = (why: string): UpgradeOutcome => {
    rmSync(dest, { recursive: true, force: true });
    return { kind: "failed", why };
  };
  rmSync(dest, { recursive: true, force: true });
  deps.say(`fetching ${target} (${layout === "git" ? "a git clone" : "the release's tarball"}) into ${dest}`);
  try {
    await deps.fetchRelease(target, dest, layout);
  } catch (error) {
    return drop(`the release could not be fetched: ${(error as Error).message}`);
  }
  const read = readManifest(dest);
  if ("error" in read) return drop(read.error);
  if (read.manifest.tag !== target) return drop(`the release's manifest is for ${read.manifest.tag}, not ${target}`);
  const tree = verifyTree(dest, read.manifest);
  if (!tree.ok) return drop(tree.why);
  const signed = deps.publicKey !== null;
  if (signed && !verifySignature(read.bytes, read.signature, deps.publicKey!)) return drop("the release's signature does not verify with this runtime's release key");
  if (installedTag(dest) !== target) return drop(`the release's own RUNTIME_RELEASE is not ${target}`);
  deps.say(`checked: ${tree.files} files against the manifest${signed ? ", the signature good" : " (unsigned: this runtime carries no release key yet)"}`);
  try {
    await deps.install(dest);
  } catch (error) {
    return drop(`npm ci failed: ${(error as Error).message}`);
  }
  writeFileSync(join(dest, ".feast-installed"), `${JSON.stringify({ tag: target, at: new Date(now()).toISOString(), layout, signed })}\n`);

  // 3: the agents stopped, the pointer and the skill switched, the agents started from the new one.
  const before = await deps.doctor(oldRoot);
  if (o.auto && !before.ok) return drop(`FL doctor fails before the upgrade (${before.failed.join(", ")}): nothing changed`);
  const running = deps.agents.running();
  const names = running.map((r) => r.name);
  const notStopped = await deps.agents.stop(names);
  if (notStopped.length > 0) {
    await deps.agents.start(oldRoot, running.filter((r) => !notStopped.includes(r.name)));
    return drop(`could not stop ${notStopped.join(", ")}: nothing changed`);
  }
  const pointer = switchPointer(deps.pointer, dest, join(runtimes, current));
  const skills = refreshSkills(deps.skillDirs, dest, join(runtimes, ".skill-backup", current));
  deps.say(`switched: ${deps.pointer} → ${dest}`);
  const notStarted = await deps.agents.start(dest, running);

  // 4: its doctor, or everything back.
  const after = await deps.doctor(dest);
  const failing = o.auto ? after.failed : after.failed.filter((f) => !before.failed.includes(f));
  if (notStarted.length === 0 && failing.length === 0) return { kind: "upgraded", from: current, to: target, restarted: names, signed };
  const why = [...(notStarted.length ? [`${notStarted.join(", ")} did not start`] : []), ...(failing.length ? [`FL doctor: ${failing.join(", ")}`] : [])].join("; ");
  deps.say(`rolling back: ${why}`);
  await deps.agents.stop(names.filter((n) => !notStarted.includes(n)));
  skills.restore();
  pointer.restore();
  const back = realpathSync(deps.pointer);
  const notBack = await deps.agents.start(back, running);
  if (o.auto) await deps.report?.(back, names, why).catch(() => undefined);
  return { kind: "rolled-back", from: current, to: target, why, restarted: names.filter((n) => !notBack.includes(n)) };
}

/** The pointer to `target`: a link swapped atomically, or (the first time) the folder there parked and a link made. */
export function switchPointer(pointer: string, target: string, parkAs: string): { restore: () => void } {
  const st = lstatSync(pointer);
  if (st.isSymbolicLink()) {
    const prev = resolve(dirname(pointer), readlinkSync(pointer));
    swapLink(pointer, target);
    return { restore: () => swapLink(pointer, prev) };
  }
  let parked = parkAs;
  if (existsSync(parked)) parked = `${parkAs}-${Date.now()}`;
  renameSync(pointer, parked);
  symlinkSync(target, pointer, "dir");
  return {
    restore: () => {
      unlinkSync(pointer);
      renameSync(parked, pointer);
    },
  };
}

function swapLink(link: string, target: string): void {
  const tmp = `${link}.next-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp, "dir");
  renameSync(tmp, link);
}

/** The installed skill's files (`npx skills add`'s folder) replaced by the release's, kept to put back. */
export function refreshSkills(dirs: string[], root: string, backupBase: string): { restore: () => void } {
  const src = join(root, "skills", "feast-league");
  if (!existsSync(join(src, "SKILL.md"))) return { restore: () => {} };
  const done: { dir: string; backup: string }[] = [];
  const empty = (dir: string) => {
    for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
  };
  for (const [i, raw] of dirs.entries()) {
    let dir: string;
    try {
      dir = realpathSync(raw);
    } catch {
      continue;
    }
    const backup = join(backupBase, String(i));
    rmSync(backup, { recursive: true, force: true });
    mkdirSync(dirname(backup), { recursive: true });
    cpSync(dir, backup, { recursive: true });
    empty(dir);
    cpSync(src, dir, { recursive: true });
    done.push({ dir, backup });
  }
  return {
    restore: () => {
      for (const d of done) {
        empty(d.dir);
        cpSync(d.backup, d.dir, { recursive: true });
      }
    },
  };
}

/** The installed skill's folders that are this skill's (`name: feast-league`), each once. */
export function skillFolders(candidates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    try {
      const real = realpathSync(c);
      if (seen.has(real) || !/^name:\s*feast-league\s*$/m.test(readFileSync(join(real, "SKILL.md"), "utf8"))) continue;
      seen.add(real);
      out.push(c);
    } catch {
      // Not there.
    }
  }
  return out;
}
