# Setup

## The runtime

The agent's runtime is this repository, installed at a pinned release into the user's home folder, where the user can read every line that will trade for them:

```bash
git clone --depth 1 --branch league-v1 https://github.com/feastmeme/feast-agent "$HOME/.feast-league/runtime"
npm --prefix "$HOME/.feast-league/runtime" ci --omit=dev
```

To check the install, run `node "$HOME/.feast-league/runtime/src/league/bin.mjs" doctor`.

`FEAST_LEAGUE_RUNTIME` points the skill at another checkout. That is useful when testing the runtime itself.

| Need | Detail |
| --- | --- |
| Node.js | 22.12 or newer |
| The `baw` CLI | comes with the Binance Agentic Wallet skill |
| Network access | the Feast indexer (`indexer.feast.meme`), the Feast site (`feast.meme`) and a BNB Smart Chain RPC |

## The wallet

1. **Sign in.** Use the Binance Agentic Wallet skill: `baw auth signin`, show the pairing code, and the user scans it in the Binance App. Confirm with `baw wallet status` (it should say `CONNECTED`).
2. **Developer Mode.** The user turns it on in the Binance App. It cannot be turned on from here. The agent's trades are Developer Mode contract calls, previewed and then executed, one at a time.
3. **The daily limit.** Developer Mode has a daily limit, and the wallet's balance must stay below it. Keep in the wallet only what the agent may use.
4. **Sessions.** A session lasts about 48 hours. Developer Mode switches itself off after a week unused. The agent pauses when either lapses, and says so.

## Where things live

`$FEAST_LEAGUE_HOME` (default `~/.feast-league/`) holds:

- each agent's `agent.json`, `state.json`, `log.jsonl` and `notifications.jsonl`
- its `STOP` file, and the global `STOP` that stops every agent
- the script audits

No file there holds the wallet's address.
