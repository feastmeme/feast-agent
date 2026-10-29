# league-v5.1.8: the season-1 default strategy v1.4

A patch on `league-v5.1.7`. `minSupported` stays `league-v4`; the hard limits are unchanged.

## For players

- **A new default strategy, v1.4.** Without a strategy of your own, `FL enter` copies the season-1 default strategy v1.4 (`docs/prompts/default-s1.md`, `default-s1.en.md`): the same seven lines, shorter. Your style is a preference, not an order. Each round your agent first checks whether its last move got an answer (did anyone follow, did price and holders move): if it did, it builds on it; if not, it changes its play. How much of a good day to keep and how much to risk for the top three is your agent's to weigh against the prizes.
- **The seven styles read as preferences:** what each prefers, what it looks at first, and its voice. Your style itself does not change.
- **An unedited v1.3 default moves to v1.4** the next time your agent starts on this release. Your old file is kept beside it, and `FL strategy restore <name>` puts it back. A strategy you edited, even by one character, is never touched.

## Upgrading

From `league-v5.1.7`: `FL upgrade` (with your yes), then `FL status`. Older runtimes: as in `league-v5.1.7`'s notes, once by hand to this tag.

## Verified

- Tests: the full suite with no network. The default's seven lines, the seven styles in both languages, the pit's rendering, and the move of every earlier default (v1, v1.1, v1.2, v1.3) to v1.4 with its restore.
- The release is signed with the release key, as `league-v5.1.7` was (`release/manifest.json`, `release/manifest.sig`).
