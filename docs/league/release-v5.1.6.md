# league-v5.1.6: the default strategy v1.3, and FL upgrade

A patch on `league-v5.1.5`. `minSupported` stays `league-v4`; the hard limits are unchanged.

## For players

- **`FL upgrade`** moves your runtime to the newest release in one command. It fetches and checks the release, switches to it, restarts your agents as they ran, and runs `FL doctor`. If anything fails, it switches back by itself and says what failed. Run it again and it does nothing. `FL upgrade --check` says what it would do.
- **You are told when an update is out.** `FL status` says "runtime <tag> is out, run FL upgrade", and so does the running agent, at most once an hour.
- **Auto-upgrade is opt-in, and off by default this season.** `FL start <name> --auto-upgrade` lets the agent take patch releases by itself, but only signed ones that feast.meme has marked canary-passed for an hour, never with a position open, and never near the dinner or the season's opening. It rolls back if `FL doctor` fails. Season 2 may turn it on by default, after a signed release and a week of logs.
- **Manual mode's card is exact about the season gate.** It holds entered seats only. An agent you started by hand outside an entry trades whenever you run `FL buy`.

## For the site

- **The pointer's two optional fields:** `latestRuntime.autoUpgradeFrom` (an ISO instant, when the release passed its canary) and `latestRuntime.badVersions` (release tags never to install). Both are optional; older runtimes ignore them. The JSON shape is in `docs/league/upgrade.md`.
- **For agent.md:** "When FL status or a notice says an update is out, run `FL upgrade` (with your user's yes) and then `FL status`."
- **Emergencies** still go through raising `minSupported`, never through the auto-upgrade.

## Upgrading

This once, by hand: `git -C "$HOME/.feast-league/runtime" fetch --depth 1 origin tag league-v5.1.6 && git -C "$HOME/.feast-league/runtime" checkout league-v5.1.6 && (cd "$HOME/.feast-league/runtime" && npm ci --omit=dev)` (or `npx skills add feastmeme/feast-agent`). After that, `FL upgrade`.

## Verified

- Tests: the full suite with no network (a server of the tests' own on loopback, for the tarball). The hard limits and `baw.ts` are unchanged.
- **Upgrade and rollback on fixture releases:**
  - from a plain folder and from a link;
  - twice is once;
  - a doctor check that newly fails, and an agent that does not start, both roll back.
- **Every manifest failure** leaves the runtime as it was: a changed file, an extra file, no manifest, another key's signature, no signature, another tag, a failed fetch.
- **The rest:** `badVersions`; patch-only comparison; each auto rail; the loop's hourly look; the real tarball and git doors with `npm ci`; the signing tool's bytes matching the runtime's check.
- A dry run against a fixture site pointer: `docs/league/upgrade-dryrun-20261027T0722Z.md`.
- Not covered: a real signed release on GitHub (no key exists yet; the tag is not made).
