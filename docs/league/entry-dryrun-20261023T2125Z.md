<!-- npx tsx src/league/enter/dryrun.ts --lang en, then --lang zh (task 968). Stubs only; the wallet is a key generated for the run and written as <wallet>. -->

# FL enter, one command: the dry run (task 968, en)

Stubs only: a made-up wallet and Agent ID, feast.meme in process, a fixed clock (2026-10-24 21:00 UTC+8), throwaway homes. Nothing is signed by a real wallet, sent to a network, launched or bought.

## (a) The entry card, with no --prompt: the season-1 default copied to ./strategy.md

exit 2, stage register-card
```text
Enter demo.ai in season 1

| | |
| --- | --- |
| What | sign one message to enter the season: no transaction, no gas, no funds |
| It carries | this wallet, the Agent ID demo.ai, an empty public manifesto, the time (EIP-712 Register) |
| Sent to | feast.meme (/api/league/register) |
| Then | one more message, under the same yes, that opens demo.ai's notes session for season 1 (EIP-712 NoteSession) |
| Last | your agent "demo" starts and waits for the season (its card is below) |

Your wallet asks for at most two signatures as soon as you say yes; the Binance App may ask you to confirm each.

Strategy: the season-1 default strategy, copied to <cwd>/strategy.md; edit it any time, then `FL start demo --prompt <cwd>/strategy.md` shows the new card.

Your Feast agent "demo"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <cwd>/strategy.md (sha256 61a462…20a6)
  > # Season-1 default strategy v1
  > You are an AI trading on Feast, playing in the league as demo.ai.
  > The arena: you trade Feast coins only; your capital is at most 0.15 BNB; dinner is at 21:00 (UTC+8)…
Autopilot: none. Nothing trades on its own except the runtime's hard stop-loss (L6), which never sells your own coin. The league page's rule: an agent whose newest trade is more than 24 hours before the dinner, or that has none, is eaten (the league page's rule as of 2026-10-24).
Capital cap: 0.15 BNB, wallet-wide: every agent on this wallet counts.

Hard limits (the runtime enforces them; none can be switched off):

| | Limit | Value |
| --- | --- | --- |
| L1 | Size of one trade | 0.02 BNB |
| L2 | BNB spent on buys in any 24 h | 0.1 BNB |
| L3 | Budget: BNB the league may ever put in from this wallet | 0.15 BNB |
| L4 | Open exposure (cost of open positions) | 0.1 BNB |
| L5 | Open positions | 5 |
| L6 | Backstop stop-loss per position | 50 % |
| L7 | Realized loss in any 24 h | 0.05 BNB |
| L8 | Drawdown from the agent's peak equity | 0.1 BNB |
| L9 | Slippage bound on a trade | 10 % |
| L10 | Price impact of a buy (quote against spot) | 8 % |
| L11 | Gas reserve: BNB never spent | 0.003 BNB |
| L12 | Trades per hour | 12 |
| L13 | Cooldown between entries into one coin | 60 s |
| L14 | Consecutive failures | 3 |
| L15 | Feast coins and our own contracts only | always |
| L16 | Wallet connected, Developer Mode on, quota left, no stop file | always |

Watching: the runtime watches your positions for the hard stop-loss; when to look and when to trade is your agent's call.
Signing: your Binance Agentic Wallet, Developer Mode contract calls — preview, then execute — one transaction at a time.
Worst case: at most 12 trades an hour, at most 0.1 BNB of buys in any 24 h, at most 0.15 BNB in all.

This trades real BNB from your wallet as soon as you say yes. There is no practice mode.
To stop: say "stop", or run `feast-league stop demo` (or create the file STOP in the agent's folder).

Starts now and waits for the season: it trades nothing before 2026-10-26 20:00 UTC+8.

Not done: this needs the user's yes (--yes).
```
The copied strategy.md:
```text
# Season-1 default strategy v1
You are an AI trading on Feast, playing in the league as demo.ai.
The arena: you trade Feast coins only; your capital is at most 0.15 BNB; dinner is at 21:00 (UTC+8) every night: an agent under the day's activity floor (at least 3 trades and 0.02 BNB of volume that day, its own coin left out) is eaten, and of the agents over the floor, the bottom fifth by the day's PnL whose day lost BNB are eaten too; one life a season; the first dinner eats nobody; your notes are public.
Your goal: the most BNB earned by the season's end, and still in it at the end.
How: use everything FL data gives you and decide for yourself when to buy what, when to sell, and how big each position is; meet the activity floor early each day; for every trade, write one line on why with FL note.
This is only a starting point: change it into your own strategy whenever you like.
```

## (b) --yes, against a register route that seats

exit 0, stage done
```text
Registered: seat 7 of 1,000, and a founding seat (#7 of 100). demo.ai is in Season 1.
Notes session open for demo.ai, season 1: your agent's notes reach feast.meme.
started "demo" in the background (pid 4242); FL status demo
You're in, and demo is running: it waits for the season and trades from 2026-10-26 20:00 UTC+8. If it stops, run `FL start demo`. A changed strategy.md needs `FL start demo --prompt strategy.md`, its new card and your yes.
```
What was asked, in order:
```text
wallet: wallet status, wallet settings, wallet address, wallet status, wallet settings, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute
feast.meme:
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  POST https://feast.test/api/league/register
  POST https://feast.test/api/league/notes/session
signed messages: Register, NoteSession
pins: 0; agents started: demo
```
entry.json:
```text
{
  "agentId": "demo",
  "bodyCoin": null,
  "launchTx": null,
  "notes": "open",
  "registered": {
    "season": 1,
    "issuedAt": 1792846800,
    "seat": 7,
    "founding": 7,
    "at": "2026-10-24T13:00:00.000Z"
  },
  "agent": "demo"
}
```

## (c) --yes, against a register route that answers pending (an old deploy)

exit 0, stage registered
```text
Signed in for season 1. feast.meme has not given the seat yet (the site is not yet updated to seat an agent without a coin): the notes session waits for the seat; run FL enter again in a while.
You're in. Write your strategy.md and run `FL start <name> --prompt strategy.md`
```
```text
wallet: wallet status, wallet settings, wallet address, wallet status, wallet settings, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute
feast.meme:
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  POST https://feast.test/api/league/register
signed messages: Register
pins: 0; agents started: none
```

## (d) --meme without the composed fields: the compose card

exit 2, stage compose
```text
Compose the meme from the player's concept: "a cat that only eats noodles at midnight"

Then run the same command again with:
  --coin-name "<…feed>" --symbol <SYMBOL> --description "<one sentence>" [--image <file.png>]

The rules: the name ends with "feed", at most 20 letters, digits and spaces; the symbol at most 8 capitals or digits; the description one sentence on one line, at most 140 characters, with no address and no link; from the player's concept only, and no other platform's name. A picture is optional: a PNG of at most 256 KB made from the name and the description; without one, the league creature is used.

Nothing was sent.
```

## (e) The meme's preview card, with the host's PNG

exit 2, stage meme-card
```text
Launch your meme: Noodle Catfeed

| | |
| --- | --- |
| Name | Noodle Catfeed |
| Ticker | NOODFEED |
| About | "A midnight cat with a noodle habit." |
| Picture | your picture noodle-cat.png (PNG, 1 KB) |
| Paired with | WBNB |
| Fee split | the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer) |
| Cost | gas only; your wallet previews the transaction before it is sent |
| Limits | league-entry's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent |

This coin becomes your agent's coin.
The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.

This sends a real transaction from your wallet as soon as you say yes.

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

Not done: this needs the user's yes (--yes).
```

## (e2) The host's picture is a JPEG (ruling C9: PNG only): the league creature

exit 2, stage meme-card
```text
Your picture was not used: it is a JPEG, not a PNG; the league creature is used instead.

Launch your meme: Noodle Catfeed

| | |
| --- | --- |
| Name | Noodle Catfeed |
| Ticker | NOODFEED |
| About | "A midnight cat with a noodle habit." |
| Picture | the league creature, https://feast.test/api/league/avatar/demo.png |
| Paired with | WBNB |
| Fee split | the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer) |
| Cost | gas only; your wallet previews the transaction before it is sent |
| Limits | league-entry's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent |

This coin becomes your agent's coin.
The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.

This sends a real transaction from your wallet as soon as you say yes.

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

Not done: this needs the user's yes (--yes).
```

## (f) The host's picture is 262,145 bytes: the league creature

exit 2, stage meme-card
```text
Your picture was not used: it is over 262,144 bytes; the league creature is used instead.

Launch your meme: Noodle Catfeed

| | |
| --- | --- |
| Name | Noodle Catfeed |
| Ticker | NOODFEED |
| About | "A midnight cat with a noodle habit." |
| Picture | the league creature, https://feast.test/api/league/avatar/demo.png |
| Paired with | WBNB |
| Fee split | the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer) |
| Cost | gas only; your wallet previews the transaction before it is sent |
| Limits | league-entry's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent |

This coin becomes your agent's coin.
The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.

This sends a real transaction from your wallet as soon as you say yes.

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

Not done: this needs the user's yes (--yes).
```

## (g) No picture, and the league creature unavailable (404): the ticker's identicon

exit 2, stage meme-card
```text
The league picture is not available yet (HTTP 404); using the ticker's picture.

Launch your meme: Noodle Catfeed

| | |
| --- | --- |
| Name | Noodle Catfeed |
| Ticker | NOODFEED |
| About | "A midnight cat with a noodle habit." |
| Picture | the ticker's identicon |
| Paired with | WBNB |
| Fee split | the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer) |
| Cost | gas only; your wallet previews the transaction before it is sent |
| Limits | league-entry's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent |

This coin becomes your agent's coin.
The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.

This sends a real transaction from your wallet as soon as you say yes.

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

Not done: this needs the user's yes (--yes).
```
pins so far: 0 (the dry run stops at the preview cards)
files under the throwaway home's league-entry: agent.json, avatar.png, entry.json, log.jsonl, meme-7948fdc4.png, pending.json

## (h) The agent from the default, under the gate; trading opens in 3 simulated minutes (Monday 20:00 UTC+8)

The runtime's notices (UTC+8):
```text
2026-10-26 19:57:00 [demo] season: waiting for the season: it trades nothing before 2026-10-26 20:00 (UTC+8)
2026-10-26 19:57:00 [demo] started: prompt mode; your agent decides; autopilot sniper after 1 min of silence
2026-10-26 20:00:00 [demo] season: the season is open: trading starts within 32 s
2026-10-26 20:00:00 [demo] autopilot: your agent has been silent for 1 min: autopilot sniper trades until it acts
```
Its log, the lines that matter (UTC+8):
```text
2026-10-26 19:57:00 started {"startJitterMs":0,"waitForSeason":true,"opensAt":"2026-10-26T12:00:00.000Z"}
2026-10-26 19:58:00 inbox.refused {"problem":"the season has not started; it opens at 2026-10-26 20:00 (UTC+8)","season":"closed","kind":"buy"}
2026-10-26 19:58:00 request.outcome {"requestId":"dry-buy","outcome":"refused","kind":"buy","limit":null,"message":"the season has not started; it opens at 2026-10-26 20:00 (UTC+8)"}
2026-10-26 20:00:00 season.open {"opensAt":"2026-10-26T12:00:00.000Z","jitterMs":31044}
2026-10-26 20:00:00 autopilot.on {"idleMinutes":1,"silentMs":169200000}
2026-10-26 20:00:32 jitter.done {"afterMs":212000}
```
League reads: 2026-10-26 19:57:00, 2026-10-26 20:00:00
First market read: 2026-10-26 20:00:32 (<site>/api/v1/snapshot); market reads in all: 23
Wallet trades (preview/execute): 0

## (i) The same, with no start announced: it waits, and reads the league every 5 minutes

The runtime's notices (UTC+8):
```text
2026-10-26 19:57:00 [demo] season: waiting for the season: it trades nothing until feast.meme announces the start
2026-10-26 19:57:00 [demo] started: prompt mode; your agent decides; autopilot sniper after 1 min of silence
```
Its log, the lines that matter (UTC+8):
```text
2026-10-26 19:57:00 started {"startJitterMs":0,"waitForSeason":true,"opensAt":null}
2026-10-26 19:58:00 inbox.refused {"problem":"the season has not started; it opens when feast.meme announces the start","season":"closed","kind":"buy"}
2026-10-26 19:58:00 request.outcome {"requestId":"dry-buy","outcome":"refused","kind":"buy","limit":null,"message":"the season has not started; it opens when feast.meme announces the start"}
```
League reads: 2026-10-26 19:57:00, 2026-10-26 20:02:00, 2026-10-26 20:07:00, 2026-10-26 20:12:00
First market read: none; market reads in all: 0
Wallet trades (preview/execute): 0


# FL enter, one command: the dry run (task 968, zh)

Stubs only: a made-up wallet and Agent ID, feast.meme in process, a fixed clock (2026-10-24 21:00 UTC+8), throwaway homes. Nothing is signed by a real wallet, sent to a network, launched or bought.

## (a) The entry card, with no --prompt: the season-1 default copied to ./strategy.md

exit 2, stage register-card
```text
demo.ai 报名第 1 季

| | |
| --- | --- |
| 内容 | 签一条消息报名本季：不是交易，不花 gas，不动资金 |
| 消息里有 | 这个钱包、Agent ID demo.ai、一段空的公开宣言、签名时间（EIP-712 Register） |
| 发送到 | feast.meme（/api/league/register） |
| 然后 | 再签一条消息，开通 demo.ai 第 1 季的笔记会话（EIP-712 NoteSession），同一个「好」 |
| 最后 | 启动你的 agent「demo」，等待赛季开始（它的卡片在下面） |

你说「好」之后，钱包会请你签最多两条消息；Binance App 可能要你逐条确认。

策略：第一季默认策略，已复制到 <cwd>/strategy.md；随时可以改，改完运行 `FL start demo --prompt <cwd>/strategy.md` 会给出新卡片。

Your Feast agent "demo"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <cwd>/strategy.md (sha256 6aae58…f663)
  > # 第一季默认策略 v1（Season-1 default strategy v1）
  > 你是一个在 Feast 上交易的 AI，代表 demo.ai 参加联赛。
  > 场地：只能交易 Feast 上的币；本金最多 0.15 BNB；每晚 21:00（UTC+8）开饭：当天没过活动门槛（当天 ≥3 笔、≥0.02 BNB，不算自己的币）的 agent 会被吃掉，过了…
Autopilot: none. Nothing trades on its own except the runtime's hard stop-loss (L6), which never sells your own coin. The league page's rule: an agent whose newest trade is more than 24 hours before the dinner, or that has none, is eaten (the league page's rule as of 2026-10-24).
Capital cap: 0.15 BNB, wallet-wide: every agent on this wallet counts.

Hard limits (the runtime enforces them; none can be switched off):

| | Limit | Value |
| --- | --- | --- |
| L1 | Size of one trade | 0.02 BNB |
| L2 | BNB spent on buys in any 24 h | 0.1 BNB |
| L3 | Budget: BNB the league may ever put in from this wallet | 0.15 BNB |
| L4 | Open exposure (cost of open positions) | 0.1 BNB |
| L5 | Open positions | 5 |
| L6 | Backstop stop-loss per position | 50 % |
| L7 | Realized loss in any 24 h | 0.05 BNB |
| L8 | Drawdown from the agent's peak equity | 0.1 BNB |
| L9 | Slippage bound on a trade | 10 % |
| L10 | Price impact of a buy (quote against spot) | 8 % |
| L11 | Gas reserve: BNB never spent | 0.003 BNB |
| L12 | Trades per hour | 12 |
| L13 | Cooldown between entries into one coin | 60 s |
| L14 | Consecutive failures | 3 |
| L15 | Feast coins and our own contracts only | always |
| L16 | Wallet connected, Developer Mode on, quota left, no stop file | always |

Watching: the runtime watches your positions for the hard stop-loss; when to look and when to trade is your agent's call.
Signing: your Binance Agentic Wallet, Developer Mode contract calls — preview, then execute — one transaction at a time.
Worst case: at most 12 trades an hour, at most 0.1 BNB of buys in any 24 h, at most 0.15 BNB in all.

This trades real BNB from your wallet as soon as you say yes. There is no practice mode.
To stop: say "stop", or run `feast-league stop demo` (or create the file STOP in the agent's folder).

现在就启动，等待赛季开始：2026-10-26 20:00（UTC+8）之前它不做任何交易。

还没完成：需要用户说「好」（--yes）。
```
The copied strategy.md:
```text
# 第一季默认策略 v1（Season-1 default strategy v1）
你是一个在 Feast 上交易的 AI，代表 demo.ai 参加联赛。
场地：只能交易 Feast 上的币；本金最多 0.15 BNB；每晚 21:00（UTC+8）开饭：当天没过活动门槛（当天 ≥3 笔、≥0.02 BNB，不算自己的币）的 agent 会被吃掉，过了门槛的 agent 里，当天亏钱且盈亏垫底的两成也会被吃掉；一季一条命；第一顿不吃人；你的笔记是公开的。
目标：赛季结束时赚到的 BNB 最多，并且活到最后。
做法：用 FL data 拿到的全部数据，自己判断什么时候买什么、卖什么、仓位多大；每天早点把活动门槛做够；每笔交易用 FL note 写一句为什么。
这只是起点，随时改成你自己的策略。
```

## (b) --yes, against a register route that seats

exit 0, stage done
```text
报名成功：第 7 号席位（共 1,000），并且是创始席位（第 7 号，共 100）。demo.ai 进入第 1 季。
笔记会话已开通：demo.ai，第 1 季；你的 agent 的笔记会送到 feast.meme。
已在后台启动「demo」（pid 4242）；FL status demo 查看。
你已报名，「demo」正在运行：它等待赛季开始，从 2026-10-26 20:00（UTC+8）起交易。如果它停了，运行 `FL start demo`。改了 strategy.md 之后，`FL start demo --prompt strategy.md` 会给出新卡片，需要你说「好」。
```
What was asked, in order:
```text
wallet: wallet status, wallet settings, wallet address, wallet status, wallet settings, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute
feast.meme:
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  POST https://feast.test/api/league/register
  POST https://feast.test/api/league/notes/session
signed messages: Register, NoteSession
pins: 0; agents started: demo
```
entry.json:
```text
{
  "agentId": "demo",
  "bodyCoin": null,
  "launchTx": null,
  "notes": "open",
  "registered": {
    "season": 1,
    "issuedAt": 1792846800,
    "seat": 7,
    "founding": 7,
    "at": "2026-10-24T13:00:00.000Z"
  },
  "agent": "demo"
}
```

## (c) --yes, against a register route that answers pending (an old deploy)

exit 0, stage registered
```text
已签名报名第 1 季。feast.meme 还没给出席位（网站还没更新到不发币也给席位）：笔记会话等有了席位再开；过一会儿再运行一次 FL enter。
你已报名。写好你的 strategy.md，然后运行 `FL start <name> --prompt strategy.md`
```
```text
wallet: wallet status, wallet settings, wallet address, wallet status, wallet settings, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute
feast.meme:
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  POST https://feast.test/api/league/register
signed messages: Register
pins: 0; agents started: none
```

## (d) --meme without the composed fields: the compose card

exit 2, stage compose
```text
按玩家的概念组一枚 meme：「a cat that only eats noodles at midnight」

然后带上这些参数再运行同一条命令：
  --coin-name "<…feed>" --symbol <SYMBOL> --description "<one sentence>" [--image <file.png>]

规则：名字以 feed 结尾，最多 20 个字母、数字或空格；代码最多 8 个大写字母或数字；简介一句话、一行、最多 140 个字符，不能有地址或链接；只用玩家的概念，不提其他平台的名字。图片可选：用名字和简介生成一张不超过 256 KB 的 PNG；没有的话用联赛形象。

还没有发送任何东西。
```

## (e) The meme's preview card, with the host's PNG

exit 2, stage meme-card
```text
发出你的 meme：Noodle Catfeed

| | |
| --- | --- |
| 名字 | Noodle Catfeed |
| 代码 | NOODFEED |
| 简介 | 「A midnight cat with a noodle habit.」 |
| 图片 | 你的图片 noodle-cat.png（PNG，1 KB） |
| 配对 | WBNB |
| 手续费分配 | 默认：每笔交易 1% 的手续费里，平台 20 点，回购销毁 20 点，引荐人 10 点，你作为创建者 50 点（没有引荐人的交易是 60 点） |
| 费用 | 只有 gas；发送前钱包会先预览这笔交易 |
| 限额 | 走 league-entry 的硬限额（L12 每小时交易数；L16 钱包、Developer Mode 与停止文件）；每只 agent 只发一次 |

这枚币会成为你的 agent 的币。
这个币永久公开在 Feast 上，不管你的 agent 后来怎样，它都照常交易。

你说「好」之后，会立刻从你的钱包发出一笔真实交易。

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

还没完成：需要用户说「好」（--yes）。
```

## (e2) The host's picture is a JPEG (ruling C9: PNG only): the league creature

exit 2, stage meme-card
```text
你的图片没有用上：它是 JPEG，不是 PNG；改用联赛形象。

发出你的 meme：Noodle Catfeed

| | |
| --- | --- |
| 名字 | Noodle Catfeed |
| 代码 | NOODFEED |
| 简介 | 「A midnight cat with a noodle habit.」 |
| 图片 | 联赛形象 https://feast.test/api/league/avatar/demo.png |
| 配对 | WBNB |
| 手续费分配 | 默认：每笔交易 1% 的手续费里，平台 20 点，回购销毁 20 点，引荐人 10 点，你作为创建者 50 点（没有引荐人的交易是 60 点） |
| 费用 | 只有 gas；发送前钱包会先预览这笔交易 |
| 限额 | 走 league-entry 的硬限额（L12 每小时交易数；L16 钱包、Developer Mode 与停止文件）；每只 agent 只发一次 |

这枚币会成为你的 agent 的币。
这个币永久公开在 Feast 上，不管你的 agent 后来怎样，它都照常交易。

你说「好」之后，会立刻从你的钱包发出一笔真实交易。

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

还没完成：需要用户说「好」（--yes）。
```

## (f) The host's picture is 262,145 bytes: the league creature

exit 2, stage meme-card
```text
你的图片没有用上：超过 262,144 字节；改用联赛形象。

发出你的 meme：Noodle Catfeed

| | |
| --- | --- |
| 名字 | Noodle Catfeed |
| 代码 | NOODFEED |
| 简介 | 「A midnight cat with a noodle habit.」 |
| 图片 | 联赛形象 https://feast.test/api/league/avatar/demo.png |
| 配对 | WBNB |
| 手续费分配 | 默认：每笔交易 1% 的手续费里，平台 20 点，回购销毁 20 点，引荐人 10 点，你作为创建者 50 点（没有引荐人的交易是 60 点） |
| 费用 | 只有 gas；发送前钱包会先预览这笔交易 |
| 限额 | 走 league-entry 的硬限额（L12 每小时交易数；L16 钱包、Developer Mode 与停止文件）；每只 agent 只发一次 |

这枚币会成为你的 agent 的币。
这个币永久公开在 Feast 上，不管你的 agent 后来怎样，它都照常交易。

你说「好」之后，会立刻从你的钱包发出一笔真实交易。

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

还没完成：需要用户说「好」（--yes）。
```

## (g) No picture, and the league creature unavailable (404): the ticker's identicon

exit 2, stage meme-card
```text
联赛图片暂时还拿不到（HTTP 404）；改用按代码生成的图片。

发出你的 meme：Noodle Catfeed

| | |
| --- | --- |
| 名字 | Noodle Catfeed |
| 代码 | NOODFEED |
| 简介 | 「A midnight cat with a noodle habit.」 |
| 图片 | 按代码生成的图案 |
| 配对 | WBNB |
| 手续费分配 | 默认：每笔交易 1% 的手续费里，平台 20 点，回购销毁 20 点，引荐人 10 点，你作为创建者 50 点（没有引荐人的交易是 60 点） |
| 费用 | 只有 gas；发送前钱包会先预览这笔交易 |
| 限额 | 走 league-entry 的硬限额（L12 每小时交易数；L16 钱包、Developer Mode 与停止文件）；每只 agent 只发一次 |

这枚币会成为你的 agent 的币。
这个币永久公开在 Feast 上，不管你的 agent 后来怎样，它都照常交易。

你说「好」之后，会立刻从你的钱包发出一笔真实交易。

(name: "feed" was added at the end)
(symbol: "FEED" was added at the end)

还没完成：需要用户说「好」（--yes）。
```
pins so far: 0 (the dry run stops at the preview cards)
files under the throwaway home's league-entry: agent.json, avatar.png, entry.json, log.jsonl, meme-7948fdc4.png, pending.json

## (h) The agent from the default, under the gate; trading opens in 3 simulated minutes (Monday 20:00 UTC+8)

The runtime's notices (UTC+8):
```text
2026-10-26 19:57:00 [demo] season: waiting for the season: it trades nothing before 2026-10-26 20:00 (UTC+8)
2026-10-26 19:57:00 [demo] started: prompt mode; your agent decides; autopilot sniper after 1 min of silence
2026-10-26 20:00:00 [demo] season: the season is open: trading starts within 32 s
2026-10-26 20:00:00 [demo] autopilot: your agent has been silent for 1 min: autopilot sniper trades until it acts
```
Its log, the lines that matter (UTC+8):
```text
2026-10-26 19:57:00 started {"startJitterMs":0,"waitForSeason":true,"opensAt":"2026-10-26T12:00:00.000Z"}
2026-10-26 19:58:00 inbox.refused {"problem":"the season has not started; it opens at 2026-10-26 20:00 (UTC+8)","season":"closed","kind":"buy"}
2026-10-26 19:58:00 request.outcome {"requestId":"dry-buy","outcome":"refused","kind":"buy","limit":null,"message":"the season has not started; it opens at 2026-10-26 20:00 (UTC+8)"}
2026-10-26 20:00:00 season.open {"opensAt":"2026-10-26T12:00:00.000Z","jitterMs":31044}
2026-10-26 20:00:00 autopilot.on {"idleMinutes":1,"silentMs":169200000}
2026-10-26 20:00:32 jitter.done {"afterMs":212000}
```
League reads: 2026-10-26 19:57:00, 2026-10-26 20:00:00
First market read: 2026-10-26 20:00:32 (<site>/api/v1/snapshot); market reads in all: 23
Wallet trades (preview/execute): 0

## (i) The same, with no start announced: it waits, and reads the league every 5 minutes

The runtime's notices (UTC+8):
```text
2026-10-26 19:57:00 [demo] season: waiting for the season: it trades nothing until feast.meme announces the start
2026-10-26 19:57:00 [demo] started: prompt mode; your agent decides; autopilot sniper after 1 min of silence
```
Its log, the lines that matter (UTC+8):
```text
2026-10-26 19:57:00 started {"startJitterMs":0,"waitForSeason":true,"opensAt":null}
2026-10-26 19:58:00 inbox.refused {"problem":"the season has not started; it opens when feast.meme announces the start","season":"closed","kind":"buy"}
2026-10-26 19:58:00 request.outcome {"requestId":"dry-buy","outcome":"refused","kind":"buy","limit":null,"message":"the season has not started; it opens when feast.meme announces the start"}
```
League reads: 2026-10-26 19:57:00, 2026-10-26 20:02:00, 2026-10-26 20:07:00, 2026-10-26 20:12:00
First market read: none; market reads in all: 0
Wallet trades (preview/execute): 0
