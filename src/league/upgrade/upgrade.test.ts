import { execFile, execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { patchStep, releaseParts } from "../version.ts";
import { autoUpgradeDecision, CANARY_MS, nearestDinner, openAboveDust, safePoint } from "./auto.ts";
import { installedTag, upgrade, type AgentControl, type Running, type UpgradeDeps } from "./engine.ts";
import { buildManifest, manifestBytes, MANIFEST_PATH, SIGNATURE_PATH, verifySignature, verifyTree } from "./manifest.ts";
import { realUpgradeDeps } from "./real.ts";
import { RELEASE_PUBLIC_KEY } from "./release-key.ts";

/**
 * Task 975, run 23: `FL upgrade` and the opt-in auto-upgrade, on fixture releases in temporary folders (a release is a
 * small tree: its RUNTIME_RELEASE, a stub `bin.mjs`, the skill, a manifest, a signature by a key made for the test).
 * Nothing here reaches a network but a server of the test's own on 127.0.0.1; no real runtime, home or skill is touched.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const temp = (what: string) => {
  const d = mkdtempSync(join(tmpdir(), `feast-league-975-up-${what}-`));
  dirs.push(d);
  return realpathSync(d);
};

const KEY = generateKeyPairSync("ed25519");
const PUBLIC = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const OTHER = generateKeyPairSync("ed25519");
const NOW = Date.parse("2026-11-04T06:00:00Z"); // 14:00 UTC+8: seven hours from the dinner.

/** A release's tree: its own RUNTIME_RELEASE, a stub CLI that answers doctor with no failing check, the skill. */
function tree(dir: string, tag: string, o: { sign?: "good" | "other" | "none"; manifest?: boolean } = {}) {
  mkdirSync(join(dir, "src", "league"), { recursive: true });
  writeFileSync(join(dir, "src", "league", "headers.ts"), `export const RUNTIME_RELEASE = "${tag}";\n`);
  writeFileSync(join(dir, "src", "league", "bin.mjs"), `const a = process.argv.slice(2); if (a[0] === "doctor") console.log(JSON.stringify([{ what: "node", ok: true, detail: "${tag}" }]));\n`);
  mkdirSync(join(dir, "skills", "feast-league", "references"), { recursive: true });
  writeFileSync(join(dir, "skills", "feast-league", "SKILL.md"), `---\nname: feast-league\n---\nthe skill of ${tag}\n`);
  writeFileSync(join(dir, "skills", "feast-league", "references", "setup.md"), `setup of ${tag}\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "feast-agent", version: "0.1.0", private: true }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "feast-agent", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "feast-agent", version: "0.1.0" } } }));
  if (o.manifest === false) return dir;
  const m = buildManifest(dir, tag);
  mkdirSync(join(dir, "release"), { recursive: true });
  writeFileSync(join(dir, MANIFEST_PATH), manifestBytes(m));
  const by = o.sign ?? "good";
  if (by !== "none") writeFileSync(join(dir, SIGNATURE_PATH), `${sign(null, manifestBytes(m), (by === "good" ? KEY : OTHER).privateKey).toString("base64")}\n`);
  return dir;
}

/** The machine: the active runtime (a plain folder), the releases one may fetch, the installed skill, the agents. */
function machine(o: { releases?: Record<string, Parameters<typeof tree>[2] & { tamper?: (dir: string) => void }>; running?: Running[]; doctor?: (root: string) => string[]; notStarting?: string[]; publicKey?: string | null } = {}) {
  const base = temp("m");
  const pointer = tree(join(base, "feast-league", "runtime"), "league-v5.1.4");
  const skill = join(base, "skills", "feast-league");
  cpSync(join(pointer, "skills", "feast-league"), skill, { recursive: true });
  const releases = join(base, "releases");
  for (const [tag, opt] of Object.entries(o.releases ?? { "league-v5.1.5": {} })) {
    tree(join(releases, tag), tag, opt);
    opt.tamper?.(join(releases, tag));
  }
  const calls: string[] = [];
  const fetched: string[] = [];
  let running = [...(o.running ?? [])];
  const agents: AgentControl = {
    running: () => running,
    stop: async (names) => (calls.push(`stop ${names.join(",")}`), (running = running.filter((r) => !names.includes(r.name))), []),
    start: async (root, list) => {
      calls.push(`start ${installedTag(root)} ${list.map((a) => `${a.name}${a.daemon ? "(daemon)" : ""}${a.args.length ? `[${a.args.join(" ")}]` : ""}`).join(",")}`);
      const failed = list.filter((a) => (o.notStarting ?? []).includes(a.name) && installedTag(root) !== "league-v5.1.4").map((a) => a.name);
      running = [...running, ...list.filter((a) => !failed.includes(a.name))];
      return failed;
    },
  };
  const deps: UpgradeDeps = {
    pointer,
    skillDirs: [skill],
    publicKey: o.publicKey === undefined ? PUBLIC : o.publicKey,
    fetchRelease: async (tag, dest) => {
      fetched.push(tag);
      if (!existsSync(join(releases, tag))) throw new Error("HTTP 404");
      cpSync(join(releases, tag), dest, { recursive: true });
    },
    install: async (dest) => void calls.push(`npm ci ${installedTag(dest)}`),
    agents,
    doctor: async (root) => {
      const failed = o.doctor?.(root) ?? [];
      calls.push(`doctor ${installedTag(root)}`);
      return { ok: failed.length === 0, failed };
    },
    safePoint: () => ({ ok: true }),
    report: async (root, names, why) => void calls.push(`report ${installedTag(root)} ${names.join(",")}: ${why}`),
    say: () => {},
    now: () => NOW,
  };
  return { base, pointer, skill, deps, calls, fetched, runningNow: () => running };
}
const latest = (tag: string, extra: Record<string, unknown> = {}) => ({ tag, publishedAt: NOW - 3 * CANARY_MS, minSupported: "league-v4", ...extra });
const skillOf = (dir: string) => readFileSync(join(dir, "SKILL.md"), "utf8");

describe("FL upgrade: a new folder, checked, switched, the agents restarted, FL doctor; twice is once", () => {
  it("from a plain folder: the release beside it, the folder parked, the pointer a link, the skill refreshed, the agents back as they ran", async () => {
    const m = machine({ running: [{ name: "maple", daemon: true, args: [] }, { name: "oak", daemon: false, args: ["--poll", "6", "--no-jitter"] }] });
    const out = await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false });
    expect(out).toEqual({ kind: "upgraded", from: "league-v5.1.4", to: "league-v5.1.5", restarted: ["maple", "oak"], signed: true });
    expect(lstatSync(m.pointer).isSymbolicLink()).toBe(true);
    expect(resolve(join(m.pointer, ".."), readlinkSync(m.pointer))).toBe(join(m.base, "feast-league", "runtimes", "league-v5.1.5"));
    expect(installedTag(m.pointer)).toBe("league-v5.1.5");
    expect(installedTag(join(m.base, "feast-league", "runtimes", "league-v5.1.4"))).toBe("league-v5.1.4");
    expect(skillOf(m.skill)).toContain("the skill of league-v5.1.5");
    expect(readFileSync(join(m.skill, "references", "setup.md"), "utf8")).toBe("setup of league-v5.1.5\n");
    expect(m.calls).toEqual(["npm ci league-v5.1.5", "doctor league-v5.1.4", "stop maple,oak", "start league-v5.1.5 maple(daemon),oak[--poll 6 --no-jitter]", "doctor league-v5.1.5"]);
    expect(JSON.parse(readFileSync(join(m.pointer, ".feast-installed"), "utf8"))).toMatchObject({ tag: "league-v5.1.5", signed: true });
    // Twice is once: nothing fetched, nothing stopped.
    const again = await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false });
    expect(again).toEqual({ kind: "current", tag: "league-v5.1.5" });
    expect(m.fetched).toEqual(["league-v5.1.5"]);
    expect(m.calls.filter((c) => c.startsWith("stop"))).toHaveLength(1);
  });

  it("from a link (the second upgrade): swapped in place; an older or equal release named is nothing to do", async () => {
    const m = machine({ releases: { "league-v5.1.5": {}, "league-v5.1.6": {} } });
    await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false });
    const out = await upgrade(m.deps, { latest: latest("league-v5.1.6"), auto: false });
    expect(out).toMatchObject({ kind: "upgraded", from: "league-v5.1.5", to: "league-v5.1.6" });
    expect(installedTag(m.pointer)).toBe("league-v5.1.6");
    expect(existsSync(join(m.base, "feast-league", "runtimes", "league-v5.1.5"))).toBe(true);
    expect(await upgrade(m.deps, { latest: latest("league-v5.1.2"), auto: false })).toEqual({ kind: "current", tag: "league-v5.1.6" });
  });

  it("a check FL doctor passed before and fails after: everything back (the folder, the skill), the agents restarted from the old one", async () => {
    const m = machine({ running: [{ name: "maple", daemon: false, args: [] }], doctor: (root) => (installedTag(root) === "league-v5.1.5" ? ["indexer"] : []) });
    const out = await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false });
    expect(out).toEqual({ kind: "rolled-back", from: "league-v5.1.4", to: "league-v5.1.5", why: "FL doctor: indexer", restarted: ["maple"] });
    expect(lstatSync(m.pointer).isDirectory()).toBe(true);
    expect(installedTag(m.pointer)).toBe("league-v5.1.4");
    expect(skillOf(m.skill)).toContain("the skill of league-v5.1.4");
    expect(m.calls.slice(-3)).toEqual(["doctor league-v5.1.5", "stop maple", "start league-v5.1.4 maple"]);
    // A manual rollback sends no report; the auto one does (below).
    expect(m.calls.some((c) => c.startsWith("report"))).toBe(false);
  });

  it("an agent that does not start on the new one: back, from a link too", async () => {
    const m = machine({ releases: { "league-v5.1.5": {}, "league-v5.1.6": {} }, running: [{ name: "maple", daemon: false, args: [] }] });
    await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false });
    const before = readlinkSync(m.pointer);
    m.deps.agents.start = async (root, list) => (installedTag(root) === "league-v5.1.6" ? list.map((a) => a.name) : []);
    const out = await upgrade(m.deps, { latest: latest("league-v5.1.6"), auto: false });
    expect(out).toMatchObject({ kind: "rolled-back", why: "maple did not start" });
    expect(readlinkSync(m.pointer)).toBe(before);
    expect(installedTag(m.pointer)).toBe("league-v5.1.5");
  });

  it("by hand, a check that failed before too holds nothing back; auto, a failing doctor before changes nothing", async () => {
    const m = machine({ doctor: () => ["wallet"] });
    expect(await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false })).toMatchObject({ kind: "upgraded" });
    const a = machine({ doctor: () => ["wallet"] });
    const out = await upgrade(a.deps, { latest: latest("league-v5.1.5", { autoUpgradeFrom: NOW - 2 * CANARY_MS }), auto: true });
    expect(out).toEqual({ kind: "failed", why: "FL doctor fails before the upgrade (wallet): nothing changed" });
    expect(lstatSync(a.pointer).isDirectory()).toBe(true);
    expect(existsSync(join(a.base, "feast-league", "runtimes", "league-v5.1.5"))).toBe(false);
  });
});

describe("rail (a): every file against the manifest, and the signature, before anything switches", () => {
  const cases: [string, Parameters<typeof machine>[0], string][] = [
    ["a changed file", { releases: { "league-v5.1.5": { tamper: (d) => writeFileSync(join(d, "src", "league", "bin.mjs"), "evil()\n") } } }, "a file differs from the manifest: src/league/bin.mjs"],
    ["a file the manifest does not name", { releases: { "league-v5.1.5": { tamper: (d) => writeFileSync(join(d, "src", "league", "extra.ts"), "x\n") } } }, "a file the manifest does not name: src/league/extra.ts"],
    ["no manifest", { releases: { "league-v5.1.5": { manifest: false } } }, "the release carries no manifest (release/manifest.json)"],
    ["signed by another key", { releases: { "league-v5.1.5": { sign: "other" } } }, "the release's signature does not verify with this runtime's release key"],
    ["not signed while this runtime has a key", { releases: { "league-v5.1.5": { sign: "none" } } }, "the release's signature does not verify with this runtime's release key"],
    ["a manifest for another tag", { releases: { "league-v5.1.5": { tamper: (d) => writeFileSync(join(d, MANIFEST_PATH), readFileSync(join(d, MANIFEST_PATH), "utf8").replace('"tag": "league-v5.1.5"', '"tag": "league-v5.1.9"')) } } }, "the release's manifest is for league-v5.1.9, not league-v5.1.5"],
    ["not fetched", { releases: {} }, "the release could not be fetched: HTTP 404"],
  ];
  for (const [what, o, why] of cases) {
    it(`${what}: not installed, nothing changed`, async () => {
      const m = machine(o);
      expect(await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false })).toEqual({ kind: "failed", why });
      expect(lstatSync(m.pointer).isDirectory()).toBe(true);
      expect(installedTag(m.pointer)).toBe("league-v5.1.4");
      expect(existsSync(join(m.base, "feast-league", "runtimes", "league-v5.1.5"))).toBe(false);
      expect(m.calls.filter((c) => c.startsWith("stop"))).toEqual([]);
    });
  }

  it("no release key in this runtime yet: by hand it installs on the manifest's file check alone, and says so; never auto", async () => {
    const m = machine({ publicKey: null, releases: { "league-v5.1.5": { sign: "none" } } });
    expect(await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: false })).toMatchObject({ kind: "upgraded", signed: false });
    const a = machine({ publicKey: null });
    expect(await upgrade(a.deps, { latest: latest("league-v5.1.5", { autoUpgradeFrom: NOW - 2 * CANARY_MS }), auto: true })).toEqual({ kind: "refused", why: "this runtime carries no release key: auto-upgrade needs a signed release" });
  });

  it("the manifest's checks on their own: a link in the tree, an odd path; the signature over the exact bytes", () => {
    const d = tree(temp("t"), "league-v5.1.5");
    const m = buildManifest(d, "league-v5.1.5");
    expect(verifyTree(d, m)).toEqual({ ok: true, files: Object.keys(m.files).length });
    expect(verifyTree(d, { ...m, files: { ...m.files, "../escape": "00" } })).toMatchObject({ ok: false });
    const sig = sign(null, manifestBytes(m), KEY.privateKey).toString("base64");
    expect(verifySignature(manifestBytes(m), sig, PUBLIC)).toBe(true);
    expect(verifySignature(Buffer.concat([manifestBytes(m), Buffer.from(" ")]), sig, PUBLIC)).toBe(false);
    expect(verifySignature(manifestBytes(m), null, PUBLIC)).toBe(false);
  });
});

describe("badVersions, and the patch step", () => {
  it("a release on badVersions is never installed; the step is patch-only on one line", async () => {
    const m = machine();
    expect(await upgrade(m.deps, { latest: latest("league-v5.1.5", { badVersions: ["league-v5.1.5"] }), auto: false })).toEqual({ kind: "refused", why: "league-v5.1.5 is on feast.meme's bad versions: not installed" });
    expect(m.fetched).toEqual([]);
    expect(releaseParts("league-v5.1")).toEqual([5, 1, 0]);
    expect(patchStep("league-v5.1.3", "league-v5.1.4")).toBe(true);
    expect(patchStep("league-v5.1", "league-v5.1.1")).toBe(true);
    for (const [a, b] of [["league-v5.1.4", "league-v5.2"], ["league-v5.1.4", "league-v5.2.0"], ["league-v5.1.4", "league-v6"], ["league-v5.1.4", "league-v5.1.4"], ["league-v5.1.4", "league-v5.1.3"], ["league-v5.1.4", "v5.1.5"]]) expect(patchStep(a!, b!), `${a} → ${b}`).toBe(false);
  });
});

describe("the auto-upgrade's rails", () => {
  type Input = Parameters<typeof autoUpgradeDecision>[0];
  const ok: Input = { current: "league-v5.1.4", latest: latest("league-v5.1.5", { autoUpgradeFrom: NOW - CANARY_MS }), now: NOW, publicKey: PUBLIC, openPositions: 0, opensAt: null };
  it("all hold: it goes; each one alone holds it back, with its reason", () => {
    expect(autoUpgradeDecision(ok)).toEqual({ go: true, tag: "league-v5.1.5" });
    const no = (over: Partial<Input>) => autoUpgradeDecision({ ...ok, ...over });
    expect(no({ latest: latest("league-v5.2.0", { autoUpgradeFrom: NOW - CANARY_MS }) })).toEqual({ go: false, why: "league-v5.2.0 is not a patch of league-v5.1.4: only FL upgrade, by hand, crosses a minor" });
    expect(no({ latest: latest("league-v5.1.5", { autoUpgradeFrom: NOW - CANARY_MS, badVersions: ["league-v5.1.5"] }) })).toEqual({ go: false, why: "league-v5.1.5 is on feast.meme's bad versions" });
    expect(no({ publicKey: null })).toEqual({ go: false, why: "this runtime carries no release key: auto-upgrade needs a signed release" });
    expect(no({ latest: latest("league-v5.1.5") })).toEqual({ go: false, why: "feast.meme has not marked league-v5.1.5 canary-passed" });
    expect(no({ latest: latest("league-v5.1.5", { autoUpgradeFrom: NOW - CANARY_MS + 1 }) })).toEqual({ go: false, why: "league-v5.1.5 was marked canary-passed less than 60 minutes ago" });
    expect(no({ openPositions: 1 })).toEqual({ go: false, why: "an open position (1): it waits until nothing is held" });
    expect(no({ current: "league-v5.1.5" })).toEqual({ go: false, why: "already on the newest release" });
    expect(no({ latest: null })).toEqual({ go: false, why: "feast.meme names no release" });
  });

  it("the safe point: 20 minutes on either side of 21:00 UTC+8, the first 20 minutes after the opening, dust is no position", () => {
    const dinner = Date.parse("2026-11-04T13:00:00Z");
    expect(nearestDinner(dinner + 5 * 3_600_000)).toBe(dinner);
    expect(nearestDinner(dinner + 13 * 3_600_000)).toBe(dinner + 86_400_000);
    for (const [at, safe] of [[dinner - 21 * 60_000, true], [dinner - 20 * 60_000, false], [dinner, false], [dinner + 20 * 60_000, false], [dinner + 21 * 60_000, true]] as const) expect(safePoint(at, 0, null).ok, new Date(at).toISOString()).toBe(safe);
    const opens = dinner - 4 * 3_600_000;
    expect(safePoint(opens + 19 * 60_000, 0, opens)).toEqual({ ok: false, why: "within the first 20 minutes after the season's opening" });
    expect(safePoint(opens + 20 * 60_000, 0, opens).ok).toBe(true);
    expect(safePoint(opens - 60_000, 0, opens).ok).toBe(true);
    expect(openAboveDust({ a: { coins: 5n, costWei: 10n ** 13n }, b: { coins: 0n, costWei: 10n ** 16n }, c: { coins: 5n, costWei: 10n ** 15n } })).toBe(1);
  });

  it("the upgrade itself holds the rails again: a minor step, no canary, no safe point: refused, nothing fetched; all hold: upgraded", async () => {
    const m = machine({ releases: { "league-v5.1.5": {}, "league-v5.2.0": {} } });
    const canary = { autoUpgradeFrom: NOW - CANARY_MS };
    expect(await upgrade(m.deps, { latest: latest("league-v5.2.0", canary), auto: true })).toMatchObject({ kind: "refused", why: "league-v5.2.0 is not a patch of league-v5.1.4: auto-upgrade never crosses a minor" });
    expect(await upgrade(m.deps, { latest: latest("league-v5.1.5"), auto: true })).toMatchObject({ kind: "refused" });
    m.deps.safePoint = () => ({ ok: false, why: "an open position (1): it waits until nothing is held" });
    expect(await upgrade(m.deps, { latest: latest("league-v5.1.5", canary), auto: true })).toEqual({ kind: "refused", why: "an open position (1): it waits until nothing is held" });
    expect(m.fetched).toEqual([]);
    m.deps.safePoint = () => ({ ok: true });
    expect(await upgrade(m.deps, { latest: latest("league-v5.1.5", canary), auto: true })).toMatchObject({ kind: "upgraded", to: "league-v5.1.5", signed: true });
  });

  it("rail (d), auto: FL doctor fails on the new one: rolled back, and the failure sent with FL report from the old one", async () => {
    const m = machine({ running: [{ name: "maple", daemon: false, args: [] }], doctor: (root) => (installedTag(root) === "league-v5.1.5" ? ["BNB Smart Chain"] : []) });
    const out = await upgrade(m.deps, { latest: latest("league-v5.1.5", { autoUpgradeFrom: NOW - CANARY_MS }), auto: true });
    expect(out).toMatchObject({ kind: "rolled-back", why: "FL doctor: BNB Smart Chain" });
    expect(m.calls.at(-1)).toBe("report league-v5.1.4 maple: FL doctor: BNB Smart Chain");
    expect(installedTag(m.pointer)).toBe("league-v5.1.4");
  });
});

describe("the real doors: the tag's tarball (no git) and a git clone, then npm ci and the release's own FL doctor", () => {
  const signedTree = (dir: string, tag: string) => tree(dir, tag);

  it("a sandbox's way: the tarball over HTTP, unpacked without chown, npm ci, the stub's doctor; the pointer switched", async () => {
    const base = temp("tar");
    const src = signedTree(join(base, "src", "feast-agent-league-v5.1.5"), "league-v5.1.5");
    execFileSync("tar", ["czf", join(base, "release.tgz"), "-C", join(base, "src"), "feast-agent-league-v5.1.5"]);
    expect(existsSync(src)).toBe(true);
    const server = createServer((req, res) => {
      if (req.url === "/league-v5.1.5") res.end(readFileSync(join(base, "release.tgz")));
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      const pointer = tree(join(base, "fl", "runtime"), "league-v5.1.4");
      const said: string[] = [];
      const deps = realUpgradeDeps({ home: join(base, "home"), isRunning: () => false, say: (l) => said.push(l), env: { ...process.env, FEAST_LEAGUE_RUNTIME: pointer, FEAST_LEAGUE_RELEASES: `http://127.0.0.1:${port}`, FEAST_LEAGUE_SKILL_DIR: "" }, publicKey: PUBLIC });
      deps.skillDirs = [];
      const out = await upgrade(deps, { latest: latest("league-v5.1.5"), auto: false });
      expect(out).toEqual({ kind: "upgraded", from: "league-v5.1.4", to: "league-v5.1.5", restarted: [], signed: true });
      expect(installedTag(pointer)).toBe("league-v5.1.5");
      expect(said.join("\n")).toContain("the release's tarball");
      expect(existsSync(join(base, "fl", "runtimes", "league-v5.1.5.tar.gz"))).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 120_000);

  it("a git clone's way: the current runtime is a clone, so the release is cloned at its tag", async () => {
    const base = temp("git");
    const repo = signedTree(join(base, "repo"), "league-v5.1.5");
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "release");
    git("tag", "league-v5.1.5");
    const pointer = tree(join(base, "fl", "runtime"), "league-v5.1.4");
    mkdirSync(join(pointer, ".git"));
    const said: string[] = [];
    const deps = realUpgradeDeps({ home: join(base, "home"), isRunning: () => false, say: (l) => said.push(l), env: { ...process.env, FEAST_LEAGUE_RUNTIME: pointer, FEAST_LEAGUE_RELEASE_GIT: repo }, publicKey: PUBLIC });
    deps.skillDirs = [];
    const out = await upgrade(deps, { latest: latest("league-v5.1.5"), auto: false });
    expect(out).toMatchObject({ kind: "upgraded", to: "league-v5.1.5" });
    expect(said.join("\n")).toContain("a git clone");
    expect(existsSync(join(pointer, ".git"))).toBe(true);
  }, 120_000);
});

describe("tools/release-sign.mjs: the bytes it signs are the bytes the runtime checks", () => {
  it("keygen outside the repository only; manifest from git ls-files; sign; verify; and the runtime agrees", () => {
    const tool = join(import.meta.dirname, "..", "..", "..", "tools", "release-sign.mjs");
    const node = (...a: string[]) => execFileSync(process.execPath, [tool, ...a], { encoding: "utf8" });
    expect(() => node("keygen", "--out", join(import.meta.dirname, "..", "..", "..", "tmp-key-here"))).toThrow();
    expect(existsSync(join(import.meta.dirname, "..", "..", "..", "tmp-key-here", "feast-release.key"))).toBe(false);
    rmSync(join(import.meta.dirname, "..", "..", "..", "tmp-key-here"), { recursive: true, force: true });
    const keys = temp("keys");
    expect(node("keygen", "--out", keys)).toContain("-----BEGIN PUBLIC KEY-----");
    expect(lstatSync(join(keys, "feast-release.key")).mode & 0o777).toBe(0o600);
    const repo = tree(join(temp("rel"), "r"), "league-v5.1.5", { manifest: false });
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a]);
    git("init", "-q");
    git("add", "-A");
    node("manifest", "--tag", "league-v5.1.5", "--root", repo);
    node("sign", "--key", join(keys, "feast-release.key"), "--root", repo);
    expect(node("verify", "--pub", join(keys, "feast-release.pub"), "--root", repo)).toContain("verified: league-v5.1.5");
    const bytes = readFileSync(join(repo, MANIFEST_PATH));
    const m = JSON.parse(bytes.toString("utf8"));
    expect(manifestBytes(m).equals(bytes)).toBe(true);
    expect(verifyTree(repo, m)).toMatchObject({ ok: true });
    expect(verifySignature(bytes, readFileSync(join(repo, SIGNATURE_PATH), "utf8").trim(), readFileSync(join(keys, "feast-release.pub"), "utf8"))).toBe(true);
    expect(() => node("manifest", "--tag", "league-v5.1.6", "--root", repo)).toThrow();
  });
});

describe("FL upgrade and the notices, through the binary (a site of the test's own, a fixture runtime, HOME a temp folder)", () => {
  const BIN = join(import.meta.dirname, "..", "bin.mjs");
  const cli = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 120_000 }, (error, stdout, stderr) => done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
      child.stdin?.end();
    });

  async function site(pointerFor: () => Record<string, unknown>, tarball?: string) {
    const { leagueWire } = await import("../register/fakes.ts");
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/league")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(Date.now() + 3_600_000).toISOString() }, latestRuntime: pointerFor() })));
      } else if (tarball && req.url === "/releases/league-v5.1.5") res.end(readFileSync(tarball));
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("--check says what it would do; with the release key shipped (amendment G), FL upgrade refuses an unsigned release and leaves the runtime as it was", async () => {
    // Run 26: this runtime carries the coordinator's public key now; a release with no signature, or another key's, is
    // never installed. The signed road is the engine's tests' (a test key: this lane never signs with the real one).
    const base = temp("cli");
    tree(join(base, "src", "feast-agent-league-v5.1.5"), "league-v5.1.5", { sign: "none" });
    execFileSync("tar", ["czf", join(base, "release.tgz"), "-C", join(base, "src"), "feast-agent-league-v5.1.5"]);
    const s = await site(() => ({ tag: "league-v5.1.5", publishedAt: new Date().toISOString(), minSupported: "league-v4" }), join(base, "release.tgz"));
    try {
      const pointer = tree(join(base, "fl", "runtime"), "league-v5.1.4");
      const env = { HOME: join(base, "user"), FEAST_LEAGUE_HOME: join(base, "fl", "home"), FEAST_LEAGUE_RUNTIME: pointer, FEAST_LEAGUE_SITE: s.url, FEAST_LEAGUE_RELEASES: `${s.url}/releases`, FEAST_LEAGUE_SKILL_DIR: "", FEAST_LEAGUE_DAEMON: "off" };
      const check = await cli(["upgrade", "--check"], env);
      expect(check.code).toBe(0);
      expect(check.stdout).toContain("this runtime: league-v5.1.4");
      expect(check.stdout).toContain("feast.meme's newest: league-v5.1.5, oldest supported league-v4");
      expect(check.stdout).toContain("FL upgrade would install it");
      expect(check.stdout).not.toContain("this runtime carries no release key");
      const up = await cli(["upgrade"], env);
      expect(up.code).not.toBe(0);
      expect(up.stdout).toContain("the release's signature does not verify with this runtime's release key");
      expect(installedTag(pointer)).toBe("league-v5.1.4");
      expect(existsSync(join(base, "fl", "runtimes", "league-v5.1.5"))).toBe(false);
    } finally {
      await s.close();
    }
  }, 180_000);

  it("FL status: the update line; a bad version said; FL start --auto-upgrade kept and shown; a non-entered manual agent is told no gate holds it", async () => {
    const base = temp("st");
    // Run 26: newer than this build (league-v5.1.8).
    let pointer: Record<string, unknown> = { tag: "league-v5.1.9", publishedAt: new Date().toISOString(), minSupported: "league-v4" };
    const s = await site(() => pointer);
    try {
      const home = join(base, "home");
      const { confirmAgent, planAgent, saveAgent, loadAgent } = await import("../agent.ts");
      writeFileSync(join(base, "strategy.md"), "Small.\n");
      const planned = planAgent({ name: "demo", promptPath: join(base, "strategy.md"), preset: "steady", ask: { every: 5, with: "none", model: null } });
      if (!planned.ok) throw new Error("plan");
      saveAgent(home, confirmAgent(planned.agent));
      const env = { HOME: join(base, "user"), FEAST_LEAGUE_HOME: home, FEAST_LEAGUE_SITE: s.url, FEAST_LEAGUE_INDEXER: s.url, FEAST_LEAGUE_BAW: "/nonexistent", FEAST_MAINNET_RPC_URL: "http://127.0.0.1:9", FEAST_LEAGUE_DAEMON: "off" };
      expect((await cli(["status", "demo"], env)).stdout).toContain("runtime league-v5.1.9 is out, run FL upgrade");
      pointer = { ...pointer, badVersions: ["league-v5.1.8"] };
      expect((await cli(["status", "demo"], env)).stdout).toContain("this runtime (league-v5.1.8) is marked bad by feast.meme: run FL upgrade (league-v5.1.9 is out)");
      const manual = await cli(["start", "demo", "--manual", "--auto-upgrade"], env);
      expect(manual.stdout).toContain("This agent is not an entered seat, so no season gate holds it: FL buy trades whenever you run it.");
      expect(loadAgent(home, "demo")).toMatchObject({ manual: true, autoUpgrade: true });
      expect((await cli(["status", "demo", "--no-league"], env)).stdout).toContain("auto-upgrade: on (patch releases only: signed, canary-passed, at a safe point; rolled back if FL doctor fails)");
      await cli(["start", "demo", "--manual", "--no-auto-upgrade"], env);
      expect(loadAgent(home, "demo")!.autoUpgrade).toBeUndefined();
    } finally {
      await s.close();
    }
  }, 180_000);
});

describe("run 26, amendment G: the shipped release key", () => {
  it("parses as an Ed25519 public key (SPKI PEM), and is a public key only", () => {
    expect(RELEASE_PUBLIC_KEY).not.toBeNull();
    const key = createPublicKey(RELEASE_PUBLIC_KEY!);
    expect(key.type).toBe("public");
    expect(key.asymmetricKeyType).toBe("ed25519");
    expect(key.export({ type: "spki", format: "der" }).length).toBe(44);
    expect(RELEASE_PUBLIC_KEY).not.toMatch(/PRIVATE/);
    // A signature by any other key does not verify with it.
    const other = generateKeyPairSync("ed25519");
    expect(verifySignature(Buffer.from("manifest"), sign(null, Buffer.from("manifest"), other.privateKey).toString("base64"), RELEASE_PUBLIC_KEY!)).toBe(false);
  });
});

