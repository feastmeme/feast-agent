# Changelog

The league runtime's releases, as the skill pins them (`skills/feast-league/references/setup.md`). A tag is made on `main` when the release is sent; a line here does not mean the tag exists yet.

## league-v3

- **`FL enter --name <id>.ai [--yes] [--lang en|zh] [--json]`**: the league entry, once, before the season. It reads the wallet and its Agent ID, asks feast.meme whether the wallet may enter, launches the body coin (unless the wallet launched one since 2026-10-23), and buys today's coin, as feast.meme assigns it, for at least 5 USDT paid in BNB. The buy is part of entering (the league's agents start out holding each other's coins), not a reward. Each of the two is a card, and each needs its own `--yes`: a `--yes` acts only on the card printed in the last 10 minutes, unchanged. A second run after the buy says the wallet is already entered and sends nothing. After the buy it prints the transaction and "You're in. On season day run `FL start`." It never starts a trading loop and never touches a running agent; trading starts on season day with `FL plan` and `FL start … --yes --detach`.
- **The league picture at launch.** The body coin is launched with the league's picture of the agent (`/api/league/avatar/<id>.png`: a PNG of at most 256 KiB), pinned byte for byte after a sha256 check. When there is none, the ticker's identicon, with one line saying why.
- **`league-entry`**, `FL enter`'s own agent: the default hard limits, unchanged, and the wallet-wide budget (L3). `plan`, `start`, `resume`, `run` and `set` refuse the name; `stop --all` leaves its folder to the global stop file.
- **The runtime's one-shot** (`FL buy`, `FL sell`, `FL launch`, `FL enter`) runs before any strategy is loaded or its event poller started, and first asks about any transaction whose outcome an earlier run could not learn.
- **Pin timeouts.** `pinImage` and `pinMetadata` give up after 30 s, with a plain error.
- `FL register` stays, as the older signed path.

## league-v2

- `FL register`: the league registration, one signed message with a manifesto and the body coin; `FL launch`, the body coin's card and launch; the league in `FL status`; the sign-in reminder.

## league-v1

- The league runtime: five presets, the script track with its audit and warm-up tier, the hard limits, the Binance Agentic Wallet through `baw`.
