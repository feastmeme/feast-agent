# FL enter, a dry run with stubs (task 961)

Run on 2026-10-23 at 14:09 UTC, on branch `todo/f448b5458f8fb1f2` at `9c21f77`.

**Nothing here was signed, launched or bought, and nothing reached a network.**
- The wallet is made up (`0x0000…a11c`), and so is its Agent ID (`demo`).
- (a) and (b) are `src/league/enter/dryrun.ts`: the real flow and the real cards, wired to the test fakes (`src/league/enter/fakes.ts`).
  - feast.meme's three routes and the indexer's `/v1/creators` are answered in process.
  - The chain is a fake. The home is a throwaway folder under the system's temp folder, removed after the run.
  - There is no `--yes`, and the one-shot there refuses to run.
- (c) and (d) are the binary, `src/league/bin.mjs`, with a fake `baw` executable (`FEAST_LEAGUE_BAW`) and the RPC and the league page on a closed local port.

Environment values below are placeholders: `<fake baw>` is a script in a temp folder, `<closed port>` a local port nothing listens on, and `<temp home>` a throwaway folder.

## (a) The league picture served: up to the launch card

```
npx tsx src/league/enter/dryrun.ts --avatar served
```

```
exit 2, stage launch-card

Launch demo.ai's body coin

| | |
| --- | --- |
| Name | demo.ai (from your Agent ID) |
| Ticker | DEMO |
| Paired with | WBNB |
| About | none |
| Picture | the league creature from feast.meme |
| Fee split | the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer) |
| Cost | gas only; your wallet previews the transaction before it is sent |
| Limits | this agent's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent |

Every agent in the league launches one coin: its body. Buying it backs the agent, and its backers are its HP.
The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.

This sends a real transaction from your wallet as soon as you say yes.

Not done: this needs the user's yes (--yes).

--- what was asked ---
baw: wallet status, wallet settings, wallet address
chain: agentIdOf
feast.meme and the indexer:
  GET https://feast.test/api/league/agent-id?wallet=0x0000…a11c
  GET https://indexer.test/v1/creators
  GET https://feast.test/api/league/avatar/demo.png
pins: 0
files written under the throwaway home: agent.json, avatar.png, log.jsonl, pending.json
```

**Where it stopped:** the launch card, exit 2, pending its yes. The picture row is "the league creature from feast.meme". The fixture PNG was saved as `avatar.png`, and its sha256 is on the pending card's digest. Nothing was pinned.

## (b) The league picture missing (a 404): up to the launch card with the notice

```
npx tsx src/league/enter/dryrun.ts --avatar 404
```

```
exit 2, stage launch-card

The league picture is not available yet (HTTP 404); using the ticker's picture.

Launch demo.ai's body coin

| | |
| --- | --- |
| Name | demo.ai (from your Agent ID) |
| Ticker | DEMO |
| Paired with | WBNB |
| About | none |
| Picture | drawn from the ticker (the league picture was not available) |
| Fee split | the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer) |
| Cost | gas only; your wallet previews the transaction before it is sent |
| Limits | this agent's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent |

Every agent in the league launches one coin: its body. Buying it backs the agent, and its backers are its HP.
The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.

This sends a real transaction from your wallet as soon as you say yes.

Not done: this needs the user's yes (--yes).

--- what was asked ---
baw: wallet status, wallet settings, wallet address
chain: agentIdOf
feast.meme and the indexer:
  GET https://feast.test/api/league/agent-id?wallet=0x0000…a11c
  GET https://indexer.test/v1/creators
  GET https://feast.test/api/league/avatar/demo.png
pins: 0
files written under the throwaway home: agent.json, log.jsonl, pending.json
```

**Where it stopped:** the launch card, exit 2, pending its yes. The notice line is printed once, above the card, and the picture row is "drawn from the ticker (the league picture was not available)". No `avatar.png` was written.

## (c) The binary's help lists `enter`

```
FEAST_LEAGUE_HOME=<temp home> FEAST_LEAGUE_BAW=<fake baw> FEAST_MAINNET_RPC_URL=<closed port> FEAST_LEAGUE_SITE=<closed port> node src/league/bin.mjs enter --help
```

```
feast-league — run a Feast agent with your Binance Agentic Wallet

  plan <name> --preset <sniper|momentum|copy|launch|dca> [--set key=value]… [--limit key=value]… [--tick s] [--sentence "…"]
  plan <name> --script <file.mjs> [--limit key=value]… [--tick s] [--sentence "…"]
                                  validate and save an agent, and print its confirmation card
  card <name>                     print the confirmation card again
  start <name> --yes [--detach]   the user said yes: confirm and start (real BNB, no practice mode)
  stop <name> | --all             write the stop file and wait for the agent to halt
  resume <name> [--all] [--detach] remove the stop file (--all: the global one too) and start again
  status <name> [--json] [--lang en|zh] [--no-league]
                                  the book, the limits, what is new since the last status, and the league
  set <name> [--set k=v]… [--limit k=v]… [--tick s] (--yes | --review)
                                  change a confirmed agent (--review may only tighten)
  review <name>                   the last hour, as JSON, for the optional hourly review
  audit <file.mjs> [--model-verdict pass|refuse --notes "…"]
                                  the script audit: static rules, then the model read's verdict
  buy <name> <coin|FEAST> <bnb>   one guarded buy, through the agent's limits
  sell <name> <coin|FEAST> <fraction|all>
  enter --name <id>.ai [--yes] [--lang en|zh] [--json]
                                  the league entry, once: launch the body coin and buy today's coin; never starts trading
                                  (--name is the wallet's Agent ID here; each card needs its own --yes)
  register <name> --check [--body-coin 0x…] [--lang en|zh]
                                  the league registration check: Agent ID, body coin, seat (reads only)
  register <name> --manifesto "…" [--body-coin 0x…] [--x handle] [--pending] [--lang en|zh] [--yes]
                                  the registration card; with --yes (the user's word): sign (no gas) and send to the league page
  launch <name> [--name "…"] [--symbol T] [--quote WBNB|<stock>] [--description "…"] [--lang en|zh] [--yes]
                                  the body coin's card; with --yes: one launch through the agent's limits
  preview <buy|approve|permit2|sell|claim|create|register> [--coin c] [--bnb x]
                                  preview-only checks: the wallet's answer, nothing executed
  agents                          the agents on this machine
  doctor                          is everything in place?

Home: $FEAST_LEAGUE_HOME (default ~/.feast-league). RPC: $FEAST_MAINNET_RPC_URL (default the Binance dataseed).
(exit 0)
```

## (d) The binary with the RPC and the page unreachable

```
FEAST_LEAGUE_HOME=<temp home> FEAST_LEAGUE_BAW=<fake baw> FEAST_MAINNET_RPC_URL=<closed port> FEAST_LEAGUE_SITE=<closed port> node src/league/bin.mjs enter --name demo.ai
```

```
The Agent ID couldn't be read from BNB Smart Chain just now. Nothing was signed or sent. Try again in a minute.
(exit 1)
```

The fake `baw` was asked: wallet status, wallet settings, wallet address. These are reads only, no `contract-call` and no `sign-message`.

**Where it stopped:** the Agent ID read, the first thing that needs the chain. It printed one plain line and exited 1, with no URL in it. The league page was never reached: eligibility comes after the Agent ID.
