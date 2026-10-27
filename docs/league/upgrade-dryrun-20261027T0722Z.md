# FL upgrade: the dry run (task 975, run 23)

Fixtures only: a site pointer and the releases served on this machine's loopback, fixture runtimes (each a small tree: its RUNTIME_RELEASE, a stub CLI that answers FL doctor, the skill, a manifest), a release key made for this run. The doors are the real ones: fetch, tar, npm ci, the release's own FL doctor. Paths are shown as <tmp>.

## (a) The site's pointer, and `FL upgrade --check` (the binary; this runtime ships no release key yet)

```text
{
  "latestRuntime": {
    "tag": "league-v5.1.6",
    "publishedAt": "2026-10-27T04:26:04.015Z",
    "minSupported": "league-v4",
    "autoUpgradeFrom": "2026-10-27T05:26:04.015Z",
    "badVersions": [
      "league-v5.1.2"
    ]
  }
}
```
```text
this runtime: league-v5.1.5 (<tmp>/fl/runtime); feast.meme's newest: league-v5.1.6, oldest supported league-v4
FL upgrade would install it
auto-upgrade (when on, at a safe point): would take it
```

## (b) The upgrade, with a release key (the engine, the real doors): fetched, checked, switched, FL doctor

Before: the pointer is a folder (league-v5.1.5).
  · fetching league-v5.1.6 (the release's tarball) into <tmp>/fl/runtimes/league-v5.1.6
  · checked: 5 files against the manifest, the signature good
  · switched: <tmp>/fl/runtime → <tmp>/fl/runtimes/league-v5.1.6
```text
{
  "kind": "upgraded",
  "from": "league-v5.1.5",
  "to": "league-v5.1.6",
  "restarted": [],
  "signed": true
}
```
After: the pointer is a link to <tmp>/fl/runtimes/league-v5.1.6 (league-v5.1.6); the old folder is parked at <tmp>/fl/runtimes/league-v5.1.5 (league-v5.1.5).

## (c) The same again: nothing to do

```text
{
  "kind": "current",
  "tag": "league-v5.1.6"
}
```

## (d) A release with one file changed after it was signed: not installed, nothing changed

  · fetching league-v5.1.7 (the release's tarball) into <tmp>/fl/runtimes/league-v5.1.7
```text
{
  "kind": "failed",
  "why": "a file differs from the manifest: src/league/bin.mjs"
}
```
The pointer is still a link to <tmp>/fl/runtimes/league-v5.1.6 (league-v5.1.6).

## (e) A release whose FL doctor fails a check that passed before: switched, then rolled back

  · fetching league-v5.1.8 (the release's tarball) into <tmp>/fl/runtimes/league-v5.1.8
  · checked: 5 files against the manifest, the signature good
  · switched: <tmp>/fl/runtime → <tmp>/fl/runtimes/league-v5.1.8
  · rolling back: FL doctor: indexer
```text
{
  "kind": "rolled-back",
  "from": "league-v5.1.6",
  "to": "league-v5.1.8",
  "why": "FL doctor: indexer",
  "restarted": []
}
```
The pointer is back: a link to <tmp>/fl/runtimes/league-v5.1.6 (league-v5.1.6).

## (f) A release on the page's badVersions: never fetched

```text
{
  "kind": "refused",
  "why": "league-v5.1.8 is on feast.meme's bad versions: not installed"
}
```

## (g) The auto-upgrade's rails, one at a time (from league-v5.1.6)

| case | decision |
| --- | --- |
| all rails hold | go: league-v5.1.7 |
| a minor step (v5.2.0) | waits: league-v5.2.0 is not a patch of league-v5.1.6: only FL upgrade, by hand, crosses a minor |
| no release key | waits: this runtime carries no release key: auto-upgrade needs a signed release |
| not canary-passed | waits: feast.meme has not marked league-v5.1.7 canary-passed |
| canary-passed 30 minutes ago | waits: league-v5.1.7 was marked canary-passed less than 60 minutes ago |
| an open position | waits: an open position (1): it waits until nothing is held |
| 10 minutes before the dinner | waits: within 20 minutes of the dinner (21:00 UTC+8) |
| 10 minutes after the season's opening | waits: within the first 20 minutes after the season's opening |

The dry run started no agent and left no process; its folder is removed.
