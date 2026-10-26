/**
 * `FL upgrade`'s dry run (task 975, run 23): the real doors (the tag's tarball over HTTP, tar, npm ci, the release's own
 * `FL doctor`) against FIXTURES only: a site pointer and the releases served by a server of its own on 127.0.0.1,
 * fixture runtimes in a temporary folder, a release key made for this run and thrown away. No real runtime, home,
 * skill, site or repository is touched; nothing is published.
 *
 *   npx tsx src/league/upgrade/dryrun.ts > docs/league/upgrade-dryrun-<UTC stamp>.md
 */
import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { leagueWire } from "../register/fakes.ts";
import { autoUpgradeDecision, CANARY_MS } from "./auto.ts";
import { installedTag, upgrade } from "./engine.ts";
import { buildManifest, manifestBytes, MANIFEST_PATH, SIGNATURE_PATH } from "./manifest.ts";
import { realUpgradeDeps } from "./real.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "feast-league-upgrade-dryrun-")));
const KEY = generateKeyPairSync("ed25519");
const PUBLIC = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const out: string[] = [];
const hide = (t: string) => t.split(base).join("<tmp>");
const say = (l = "") => out.push(hide(l));
const block = (t: string) => say(["```text", t.trimEnd(), "```"].join("\n"));

function release(dir: string, tag: string, o: { doctorFails?: string; signed?: boolean } = {}) {
  mkdirSync(join(dir, "src", "league"), { recursive: true });
  writeFileSync(join(dir, "src", "league", "headers.ts"), `export const RUNTIME_RELEASE = "${tag}";\n`);
  const checks = JSON.stringify([{ what: "node", ok: true, detail: tag }, ...(o.doctorFails ? [{ what: o.doctorFails, ok: false, detail: "fixture failure" }] : [])]);
  writeFileSync(join(dir, "src", "league", "bin.mjs"), `if (process.argv[2] === "doctor") console.log(${JSON.stringify(checks)});\n`);
  mkdirSync(join(dir, "skills", "feast-league"), { recursive: true });
  writeFileSync(join(dir, "skills", "feast-league", "SKILL.md"), `---\nname: feast-league\n---\n${tag}\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "feast-agent", version: "0.1.0", private: true }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "feast-agent", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "feast-agent", version: "0.1.0" } } }));
  const m = buildManifest(dir, tag);
  mkdirSync(join(dir, "release"), { recursive: true });
  writeFileSync(join(dir, MANIFEST_PATH), manifestBytes(m));
  if (o.signed !== false) writeFileSync(join(dir, SIGNATURE_PATH), `${sign(null, manifestBytes(m), KEY.privateKey).toString("base64")}\n`);
  return dir;
}
function tarball(tag: string, o: Parameters<typeof release>[2] = {}, tamper?: (dir: string) => void) {
  const src = join(base, "build", tag);
  release(join(src, `feast-agent-${tag}`), tag, o);
  tamper?.(join(src, `feast-agent-${tag}`));
  execFileSync("tar", ["czf", join(base, "build", `${tag}.tgz`), "-C", src, `feast-agent-${tag}`]);
}
const pointerState = (p: string) => (lstatSync(p).isSymbolicLink() ? `a link to ${hide(readlinkSync(p))} (${installedTag(p)})` : `a folder (${installedTag(p)})`);

const NOW = Date.now();
let site: Record<string, unknown> = {};
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/league")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(leagueWire({ state: "season", season: { number: 1, day: 2, countdownTo: new Date(NOW + 3_600_000).toISOString() }, latestRuntime: site })));
  } else if (req.url?.startsWith("/releases/") && existsSync(join(base, "build", `${req.url.slice(10)}.tgz`))) res.end(readFileSync(join(base, "build", `${req.url.slice(10)}.tgz`)));
  else res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const BIN = join(import.meta.dirname, "..", "bin.mjs");
const cli = (args: string[], env: Record<string, string>) => new Promise<string>((done) => execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 120_000 }, (_e, stdout, stderr) => done(`${stdout}${stderr}`)));

try {
  say("# FL upgrade: the dry run (task 975, run 23)");
  say();
  say("Fixtures only: a site pointer and the releases served on this machine's loopback, fixture runtimes (each a small tree: its RUNTIME_RELEASE, a stub CLI that answers FL doctor, the skill, a manifest), a release key made for this run. The doors are the real ones: fetch, tar, npm ci, the release's own FL doctor. Paths are shown as <tmp>.");
  const pointer = release(join(base, "fl", "runtime"), "league-v5.1.5");
  const env = { HOME: join(base, "user"), FEAST_LEAGUE_HOME: join(base, "fl", "home"), FEAST_LEAGUE_RUNTIME: pointer, FEAST_LEAGUE_SITE: url, FEAST_LEAGUE_RELEASES: `${url}/releases`, FEAST_LEAGUE_SKILL_DIR: "", FEAST_LEAGUE_DAEMON: "off" };
  const deps = () => {
    const d = realUpgradeDeps({ home: env.FEAST_LEAGUE_HOME, isRunning: () => false, say: (l) => say(`  · ${l}`), env: { ...process.env, ...env }, publicKey: PUBLIC });
    d.skillDirs = [];
    return d;
  };
  site = { tag: "league-v5.1.6", publishedAt: new Date(NOW - 3 * CANARY_MS).toISOString(), minSupported: "league-v4", autoUpgradeFrom: new Date(NOW - 2 * CANARY_MS).toISOString(), badVersions: ["league-v5.1.2"] };
  tarball("league-v5.1.6");

  say("\n## (a) The site's pointer, and `FL upgrade --check` (the binary; this runtime ships no release key yet)\n");
  block(JSON.stringify({ latestRuntime: site }, null, 2));
  block(await cli(["upgrade", "--check"], env));

  say("\n## (b) The upgrade, with a release key (the engine, the real doors): fetched, checked, switched, FL doctor\n");
  say(`Before: the pointer is ${pointerState(pointer)}.`);
  const latest = { tag: "league-v5.1.6", publishedAt: NOW - 3 * CANARY_MS, minSupported: "league-v4", autoUpgradeFrom: NOW - 2 * CANARY_MS, badVersions: ["league-v5.1.2"] };
  const b = await upgrade(deps(), { latest, auto: false });
  block(JSON.stringify(b, null, 2));
  say(`After: the pointer is ${pointerState(pointer)}; the old folder is parked at <tmp>/fl/runtimes/league-v5.1.5 (${installedTag(join(base, "fl", "runtimes", "league-v5.1.5"))}).`);

  say("\n## (c) The same again: nothing to do\n");
  block(JSON.stringify(await upgrade(deps(), { latest, auto: false }), null, 2));

  say("\n## (d) A release with one file changed after it was signed: not installed, nothing changed\n");
  tarball("league-v5.1.7", {}, (d) => writeFileSync(join(d, "src", "league", "bin.mjs"), "console.log('changed after signing')\n"));
  block(JSON.stringify(await upgrade(deps(), { latest: { ...latest, tag: "league-v5.1.7" }, auto: false }), null, 2));
  say(`The pointer is still ${pointerState(pointer)}.`);

  say("\n## (e) A release whose FL doctor fails a check that passed before: switched, then rolled back\n");
  tarball("league-v5.1.8", { doctorFails: "indexer" });
  block(JSON.stringify(await upgrade(deps(), { latest: { ...latest, tag: "league-v5.1.8" }, auto: false }), null, 2));
  say(`The pointer is back: ${pointerState(pointer)}.`);

  say("\n## (f) A release on the page's badVersions: never fetched\n");
  block(JSON.stringify(await upgrade(deps(), { latest: { ...latest, tag: "league-v5.1.8", badVersions: ["league-v5.1.8"] }, auto: false }), null, 2));

  say("\n## (g) The auto-upgrade's rails, one at a time (from league-v5.1.6)\n");
  const dinner = (() => {
    const day = 86_400_000;
    const t = Math.floor(NOW / day) * day + 13 * 3_600_000;
    return t > NOW ? t : t + day;
  })();
  const rows: [string, Parameters<typeof autoUpgradeDecision>[0]][] = [
    ["all rails hold", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.1.7" }, now: dinner - 3 * 3_600_000, publicKey: PUBLIC, openPositions: 0, opensAt: null }],
    ["a minor step (v5.2.0)", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.2.0" }, now: dinner - 3 * 3_600_000, publicKey: PUBLIC, openPositions: 0, opensAt: null }],
    ["no release key", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.1.7" }, now: dinner - 3 * 3_600_000, publicKey: null, openPositions: 0, opensAt: null }],
    ["not canary-passed", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.1.7", autoUpgradeFrom: null }, now: dinner - 3 * 3_600_000, publicKey: PUBLIC, openPositions: 0, opensAt: null }],
    ["canary-passed 30 minutes ago", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.1.7", autoUpgradeFrom: dinner - 3 * 3_600_000 - 30 * 60_000 }, now: dinner - 3 * 3_600_000, publicKey: PUBLIC, openPositions: 0, opensAt: null }],
    ["an open position", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.1.7" }, now: dinner - 3 * 3_600_000, publicKey: PUBLIC, openPositions: 1, opensAt: null }],
    ["10 minutes before the dinner", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.1.7" }, now: dinner - 10 * 60_000, publicKey: PUBLIC, openPositions: 0, opensAt: null }],
    ["10 minutes after the season's opening", { current: "league-v5.1.6", latest: { ...latest, tag: "league-v5.1.7" }, now: dinner - 3 * 3_600_000, publicKey: PUBLIC, openPositions: 0, opensAt: dinner - 3 * 3_600_000 - 10 * 60_000 }],
  ];
  say("| case | decision |");
  say("| --- | --- |");
  for (const [what, input] of rows) {
    const d = autoUpgradeDecision(input);
    say(`| ${what} | ${d.go ? `go: ${d.tag}` : `waits: ${d.why}`} |`);
  }
  say("\nThe dry run started no agent and left no process; its folder is removed.");
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
}
process.stdout.write(`${out.join("\n")}\n`);
