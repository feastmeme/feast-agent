# Changelog

The league runtime's releases, as the skill pins them (`skills/feast-league/references/setup.md`). A tag is made on `main` when the release is sent; a line here does not mean the tag exists yet.

## league-v4

- **Prompt mode** (the owner's ruling, 2026-10-24: the league is a game of prompts). `FL plan|start <name> --prompt <strategy.md> [--autopilot <preset>] [--idle-minutes N]`: the player writes the strategy, and their own agent decides by it. The runtime calls no model and never reads the prompt as instructions: it records the prompt's sha256 and path, shows its first three lines on the card, and keeps the boundary. A changed prompt needs a new card and a new yes. There is no tick command and no fixed cadence: the agent looks when it chooses.
- **The autopilot.** With `--autopilot <preset>`, the preset trades only after the agent has been silent (no `FL buy`, `FL sell` or `FL note`) for 60 minutes, or `--idle-minutes N`, and steps back as soon as it acts; `autopilot.on` and `autopilot.off` are logged and notified once each. The presets stay, as autopilots, and become example prompts in `docs/prompts/` (sniper, momentum, copy, launch, dca), with a README on writing one. A prompt agent inherits the wallet's body coin from `FL enter`, so a launch autopilot never launches a second coin.
- **`FL data [<name>] [--since 24h|90m|7d|<iso>] [--coin 0x…] [--json]`**: one read of every Feast coin (price, 24 h volume, trades, holders, launch time, creator, body coin or not), the agent's own positions and PnL, the league's clock, newest dinner and boards, and with `--since` hourly history. From feast.meme's public `/api/v1/pools` and `/api/v1/ohlcv` (sqrt prices turned into BNB per coin) and `/api/league`, at most 1 + pages + 1 + 20 requests a call, cached 30 s and 5 min. Names, symbols and board names are marked untrusted in JSON and cleaned in human output.
- **`FL note <name> "<text>" [--tx <hash>]`**: one reason of at most 280 characters, kept on this machine (`notes.jsonl`, no address in it) and POSTed to `/api/league/notes` when that route answers; kept and retried while it does not, never blocking a trade.
- **The capital cap: 0.15 BNB**, wallet-wide, on every agent the user plans. `plan` and `set` refuse a `budgetBnb` above it ("the league caps capital at 0.15 BNB"). It lives outside `limits.ts`: L3's own default and ceiling are unchanged, and the cap only tightens.
- **Every amount in BNB.** `FL data` and `FL status` report PnL in BNB, with a USDT figure only as an optional reference read at display time. `FL enter`'s buy is **0.01 BNB** of today's coin (it was 5 USDT worth, paid in BNB); the BNB price now only adds a reference to its card, and its record no longer keeps `usdtAtBuy` (a league-v3 record of 5 USDT worth still counts as entered).
- **`FL buy` and `FL sell` into a running agent wait for the outcome** (up to 90 s): the fill with its transaction (exit 0), the limit's refusal (exit 2), or a failure (exit 1). A request still queued when the agent stops is answered as dropped; one with no answer in 90 s may still fill, and the line says not to send it again. `--no-wait` keeps the old "queued".
- **`FL status`** shows, for a prompt agent, the prompt and its sha256, the autopilot, the time since the agent's last action and last trade, and the cap's use.
- **`FL script check <file>`**: the script in the sandbox against a stub world (8 coins, 36 snapshots, a fixed seed), through the real guard; a pass needs at least one approved buy and one sale. A pass on record, with the audit passed, counts as the warm-up done for that exact file (`audits/<sha256>.check.json`); any edit is a new check.
- **The safety pass** of a prompt agent (L6, L8) runs at least every 60 s, whatever its autopilot's own tick.
- `limits.ts` and `guard()` are unchanged. `FL --help` exits 0.

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
