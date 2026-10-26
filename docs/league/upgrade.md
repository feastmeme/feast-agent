# FL upgrade, the update notices, and the opt-in auto-upgrade (league-v5.1.6)

Task 975, run 23; the owner approved the coordinator's five points as written.

## `FL upgrade`

One command, from the running release to the one feast.meme names (`/api/league` → `latestRuntime`):

1. **Fetch** the tag into a new folder beside the active runtime, `…/runtimes/<tag>`. Where the active runtime is a git clone, the release is cloned at its tag. Otherwise (an unpacked tarball, a sandbox with no git) the tag's tarball is fetched from GitHub's codeload and unpacked without `chown`. The current folder is not touched.
2. **Check** the fetched files against the release's manifest (`release/manifest.json`): every file the manifest names must have its sha256, and nothing else may be there. The manifest's tag must be the one asked for, and so must the tree's own `RUNTIME_RELEASE`. The signature (`release/manifest.sig`, Ed25519) is checked with the public key this runtime ships (`src/league/upgrade/release-key.ts`). Until that key exists, a manual `FL upgrade` installs on the manifest's file check alone and says "unsigned"; the auto-upgrade never does. Then `npm ci --omit=dev`.
3. **Switch.** The agents that run are stopped through their stop file, which is removed again. The active runtime path (`$HOME/.feast-league/runtime`, or `FEAST_LEAGUE_RUNTIME`) becomes a link to the new folder; the first time, the folder that was there is parked as `runtimes/<old tag>`. The installed skill's files (`npx skills add`'s folder) are refreshed from the release. Each agent starts again as it ran: a daemon's agent by `FL daemon --install` from the new release, a background one by `FL start` with the same flags (`launch.json`). A manual agent runs nothing and is not touched; its manual mode stays on its record.
4. **`FL doctor`** runs from the new release. Two things roll everything back: a check that fails now and passed before the upgrade (in auto mode, any failing check), or an agent that does not start again. The rollback restores the pointer and the skill's files and restarts the agents from the old release. The command says what failed, and an automatic rollback also sends `FL report`.

Run twice, it does nothing the second time: "already on <tag>, the newest release: nothing to do". `FL upgrade --check` says what it would do and changes nothing. macOS and Linux only; on Windows, install the new release by hand.

## The update notices

While feast.meme names a newer release, every `FL status` says one line: `runtime league-v5.1.6 is out, run FL upgrade`. The loop's notices say the same at most once an hour per process. A runtime on the page's `badVersions` is told `this runtime (<tag>) is marked bad by feast.meme: run FL upgrade`. A runtime below `minSupported` keeps the behaviour it had: the line adds "older than <minSupported> … upgrade before the next dinner", and the site refuses what it refuses.

For the site's agent.md (the coordinator adds it; the runtime does not edit the site): **"When FL status or a notice says an update is out, run `FL upgrade` (with your user's yes) and then `FL status`."**

## The opt-in auto-upgrade

**Off by default this season.** Turn it on per agent with `FL start <name> --auto-upgrade` (`--no-auto-upgrade` turns it off; the choice stays on the agent), or for a whole machine with `FL_AUTO_UPGRADE=1`. It takes patch releases only, on one line (league-v5.1.4 → league-v5.1.6, never across a minor), and fires only when all four rails hold. Each rail is checked by the loop, and again by the upgrade itself:

- **(a) Signed.** The release's manifest signature verifies with the key this runtime ships, and every file matches. With no key in the runtime it never fires.
- **(b) Canary-passed.** The page's `latestRuntime.autoUpgradeFrom` is set and at least 60 minutes old.
- **(c) A safe point.** No agent holds a position above dust (0.0001 BNB), it is more than 20 minutes from the dinner (21:00 UTC+8) on either side, and it is not in the first 20 minutes after the season's opening.
- **(d) FL doctor passes after the upgrade.** It must pass before as well; if it fails after, everything rolls back and `FL report` sends the failure.

A release on `badVersions` is never installed, by hand or automatically. The loop looks once an hour; when the rails hold it starts `FL upgrade --auto` detached, which stops and restarts the agent.

**Emergencies do not come this way.** An urgent fix raises `minSupported`, as before. The auto-upgrade waits for a canary, a signature and a safe point, which an emergency cannot.

## The site pointer (`/api/league` → `latestRuntime`)

```json
{
  "latestRuntime": {
    "tag": "league-v5.1.6",
    "publishedAt": "<ISO instant the release was published>",
    "minSupported": "league-v4",
    "autoUpgradeFrom": "<ISO instant the release passed its canary, or null>",
    "badVersions": ["<league-vN.M.P>", "…"]
  }
}
```

- `autoUpgradeFrom` and `badVersions` are optional; an older runtime ignores both.
- `autoUpgradeFrom` absent or null means no auto-upgrade to this release.
- `badVersions` holds at most 50 tags; anything that is not a release tag is dropped.

## Signing a release

The key pair is made once, on the coordinator's release machine:

```bash
node tools/release-sign.mjs keygen --out <a 0700 folder OUTSIDE any repository>
```

- `feast-release.key` (mode 0600) stays in that folder, with one offline backup. It never enters a repository: `*.key` is ignored, and the tool refuses a folder inside the repository.
- The printed public key goes into `src/league/upgrade/release-key.ts`. It must be there in the release before the one that is to be auto-installed: a runtime checks with the key it already has.

Each release, in a clean checkout of the commit to tag:

```bash
node tools/release-sign.mjs manifest --tag league-vN.M.P      # release/manifest.json from git ls-files
node tools/release-sign.mjs sign --key <folder>/feast-release.key
node tools/release-sign.mjs verify --pub <folder>/feast-release.pub
git add release/manifest.json release/manifest.sig && git commit -m "league-vN.M.P: the release manifest"
git tag -a league-vN.M.P -m "…" && git push origin main league-vN.M.P
```

Then the site pointer moves: `tag`, `publishedAt`, and later `autoUpgradeFrom` once the canary has passed.
