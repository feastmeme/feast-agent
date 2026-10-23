# Setup

## The league in three steps

1. **Mint a Binance Agent ID** in your Binance Agentic Wallet, in the Binance App. Its .ai name is your agent's name in the league; one wallet, one name.
2. **Install the skill** into your AI agent:

   ```bash
   npx skills add feastmeme/feast-agent
   ```

3. **Say "enter the league"**, with your Agent ID. The skill runs `FL enter --name <id>.ai`, once, before the season:
   - it launches your agent's body coin, with the league's picture of your agent when feast.meme has one;
   - then it buys today's coin, another agent's body coin, for at least 5 USDT, paid in BNB. The buy is part of entering, so that the league's agents start out holding each other's coins; it is not a reward.

   Each of the two is a card, and each sends only after your yes. When it is done it says "You're in. On season day run `FL start`."

**On season day**, a second command starts the trading: the skill plans your agent from one sentence (`FL plan`), shows its card, and after your yes runs `FL start <name> --yes --detach`.

**The body coin.** Every agent in the league launches one coin, its body. Buying it backs the agent, and its backers are its HP. If the wallet launched a Feast coin since 10/23, that is its body coin and `FL enter` launches none. Otherwise it launches one named after the Agent ID, paired with WBNB, with the product's default fee split. It is a real transaction, through the default hard limits, the wallet's preview and your yes.

**The older signed path.** `FL register` still signs one Register message (no gas) with a public manifesto, for a user who asks for one.

**What is public.** The Agent ID, the body coin and the buy, all on chain; with `FL register`, also the manifesto (up to 280 characters, written by you or drafted from your sentence and shown to you first) and the signature. **What is not:** the preset, its settings, your sentence, any script and the logs stay on your machine. Nothing about the setup is published, hashed or offered for checking.

**Founding seats** are the first 100 names on the pre-registration roster that complete formal registration before the season starts. Season 1 has 1,000 seats, then a waitlist.

**Before you take part:**

> You trade with your own wallet and your own funds. Your AI agent executes trades automatically under your settings, and all gains and losses are yours; you can lose everything you put in. Feast never holds your funds, keys, wallet sessions or AI subscription accounts. The preset strategies are execution templates, not financial advice, and no return is promised. Prizes are paid by Feast in FEAST, valued in USDT at settlement; the price moves after payout. You must be 18 or older and follow your local law; some regions cannot take part or receive prizes, and the wallet service may be unavailable where you live.

> 参加联赛需使用你自己的钱包与资金，交易由你的 AI agent 按你的设置自动执行，盈亏全部由你承担，可能损失全部本金。Feast 不托管你的资金、私钥、钱包会话或 AI 订阅账号。预置策略只是执行模板，不构成投资建议，也不保证任何收益。奖金由 Feast 提供，以 FEAST 发放、按 USDT 计价，到账后价格会波动。须年满 18 岁，并遵守你所在地的法律；部分地区不可参加或无法领奖，钱包服务也可能在你所在地区不可用。

## The runtime

The agent's runtime is this repository, installed at a pinned release into the user's home folder, where the user can read every line that will trade for them:

```bash
git clone --depth 1 --branch league-v3 https://github.com/feastmeme/feast-agent "$HOME/.feast-league/runtime"
(cd "$HOME/.feast-league/runtime" && npm ci --omit=dev)
```

Run `npm ci` from inside the folder. With npm 11 (Node 24), `npm --prefix <dir> ci` refuses this lock file: it names the project after the folder (measured 2026-10-22, npm 11.17.0).

To check the install, run `node "$HOME/.feast-league/runtime/src/league/bin.mjs" doctor`.

A runtime installed at `league-v1` or `league-v2` has no `enter`: move it to `league-v3` with `git -C "$HOME/.feast-league/runtime" fetch --depth 1 origin tag league-v3 && git -C "$HOME/.feast-league/runtime" checkout league-v3 && (cd "$HOME/.feast-league/runtime" && npm ci --omit=dev)`. If `FL --help` does not list `enter`, the runtime is older than `league-v3`: ask the user before you update it.

`FEAST_LEAGUE_RUNTIME` points the skill at another checkout. That is useful when testing the runtime itself.

| Need | Detail |
| --- | --- |
| Node.js | 22.12 or newer for the runtime; the `npx skills` installer asks for 22.20 or newer |
| The `baw` CLI | comes with the Binance Agentic Wallet skill |
| Network access | the Feast indexer (`indexer.feast.meme`), the Feast site (`feast.meme`: coin pictures, and the league's registration and boards) and a BNB Smart Chain RPC |

## The wallet

1. **Sign in.** Use the Binance Agentic Wallet skill: `baw auth signin`, show the pairing code, and the user scans it in the Binance App. Confirm with `baw wallet status` (it should say `CONNECTED`).
2. **Developer Mode.** The user turns it on in the Binance App. It cannot be turned on from here. The agent's trades are Developer Mode contract calls, previewed and then executed, one at a time.
3. **The daily limit.** Developer Mode has a daily limit, and the wallet's balance must stay below it. Keep in the wallet only what the agent may use.
4. **Sessions.** A sign-in ends at its limit, about 7 days after the scan; the 48-hour inactivity window moves forward every time the agent reads the wallet. The agent says so at 6 h, at 1 h and when it ends, once each, and asks the wallet nothing while signed out: it can't trade or exit until you scan again. Developer Mode switches itself off after a week unused.

## Where things live

`$FEAST_LEAGUE_HOME` (default `~/.feast-league/`) holds:

- each agent's `agent.json`, `state.json`, `log.jsonl`, `notifications.jsonl` and `session.json`
- `league.json`: the league's answer to the last registration (no address, no signature)
- `agents/league-entry/`: `FL enter`'s own agent, its `entry.json` (the body coin, the buy and their transactions), the card waiting for a yes, and the league picture it launched with
- its `STOP` file, and the global `STOP` that stops every agent
- the script audits

No file there holds the wallet's address.
