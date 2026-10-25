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
| Domain | EIP-712 typed data (V4): name `Feast League`, version `1`, chainId `56` (BNB Smart Chain), no verifying contract |
| Register | wallet `<wallet>`, name `demo`, strategy `""` (empty), copies `0x0000…0000`, issuedAt: the moment it signs (Unix seconds) |
| NoteSession | wallet `<wallet>`, agentId `demo`, season `1`, nonce: 32 random bytes drawn when it signs |

Your wallet asks for at most two signatures as soon as you say yes; the Binance App may ask you to confirm each.

Strategy: the season-1 default strategy, copied to <cwd>/strategy.md; edit it any time, then `FL start demo --prompt <cwd>/strategy.md` shows the new card.

Your Feast agent "demo"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <cwd>/strategy.md (sha256 61a462…20a6)
  > # Season-1 default strategy v1
  > You are an AI trading on Feast, playing in the league as demo.ai.
  > The arena: you trade Feast coins only; your capital is at most 0.15 BNB; dinner is at 21:00 (UTC+8)…
Ask loop: every 5 min with no FL buy or FL sell from your agent, the runtime asks Claude Code (`claude -p`, on your own login, its default model) what to do now, handing it your prompt, the market, the book, the league and its own journal; it makes the one buy, sell or hold the answer names, within the hard limits below. A note or a read does not hold it back. --every N changes how often (FL every demo N later); --ask-with none stops the asks.
Floor keeper: the steady preset (Steady floor keeper) trades only when Claude Code cannot be reached twice in a row, and 20 minutes before dinner while the day's floor is unmet: it keeps the league's daily activity floor with small buys of the busiest Feast coins (never your own coin), spaced out and done early in the day, each sold by a take-profit, a stop-loss or a time stop. Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell). --no-autopilot turns off both the asks and the floor keeper.
Its spend: about 0.012 BNB of buys on a day it trades for the floor, at most 0.018 BNB (3 × 0.006 BNB); at most 0.126 BNB over the season's seven trading days, from the same 0.15 BNB cap as your agent's own buys.
Capital cap: 0.15 BNB, wallet-wide: every agent on this wallet counts.

| Parameter | Value | |
| --- | --- | --- |
| buyBnb | 0.006 BNB | default |
| topN | 5 | default |
| minVolumeBnb | 0.5 BNB | default |
| minAgeMinutes | 60 min | default |
| minDailyTrades | 4 | default |
| minDailyVolumeBnb | 0.022 BNB | default |
| maxEntriesPerDay | 3 | default |
| spacingMinutes | 15 min | default |
| rushMinutes | 60 min | default |
| takeProfitPct | 15 % | default |
| stopLossPct | 10 % | default |
| timeStopMinutes | 30 min | default |
| maxPositions | 2 | default |
| slippagePct | 5 % | default |

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
Autopilot cadence: only while it trades, a tick every 60 s; while your agent trades, the same tick for its own exits only.
Signing: your Binance Agentic Wallet, Developer Mode contract calls — preview, then execute — one transaction at a time.
Worst case: at most 12 trades an hour, at most 0.1 BNB of buys in any 24 h, at most 0.15 BNB in all.

This trades real BNB from your wallet as soon as you say yes. There is no practice mode.
To stop: say "stop", or run `feast-league stop demo` (or create the file STOP in the agent's folder).

Starts now and waits for the season: trading opens at the season's start, Tue 10/27 21:00 UTC+8, and it trades nothing before. The first dinner, a day later, is the warm-up: it eats nobody.
Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.

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
Registered: seat 7, and a founding seat (#7 of 100). demo.ai is in Season 1.
Notes session open for demo.ai, season 1: your agent's notes reach feast.meme.
started "demo" in the background (pid 4242); FL status demo
You're in, and demo is running: it waits for the season and trades from the season's start, Tue 10/27 21:00 UTC+8. Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself. Keep this machine awake for the season (or run it on a server or cloud computer); if it sleeps, your agent stops and gets eaten. If it stops, run `FL start demo`. A changed strategy.md needs `FL start demo --prompt strategy.md`, its new card and your yes.
```
What was asked, in order:
```text
wallet: wallet status, wallet settings, wallet address, wallet settings, wallet status, wallet settings, wallet address, wallet settings, wallet status, wallet settings, sign-message preview, sign-message execute, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute
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
wallet: wallet status, wallet settings, wallet address, wallet settings, wallet status, wallet settings, wallet address, wallet settings, wallet status, wallet settings, sign-message preview, sign-message execute
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

## (h) The agent from the default, under the gate; trading opens in 3 simulated minutes, at the season's start (Tuesday 21:00 UTC+8)

The runtime's notices (UTC+8):
```text
2026-10-27 20:57:00 [demo] season: waiting for the season: season starts and trading opens Tue 10/27 21:00 UTC+8; it trades nothing before
2026-10-27 20:57:00 [demo] started: prompt mode; Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.
2026-10-27 21:00:00 [demo] season: the season is open: trading starts within 32 s
```
Its log, the lines that matter (UTC+8):
```text
2026-10-27 20:57:00 started {"startJitterMs":0,"waitForSeason":true,"opensAt":"2026-10-27T13:00:00.000Z"}
2026-10-27 20:58:00 inbox.refused {"problem":"the season has not started; it opens at 2026-10-27 21:00 (UTC+8)","season":"closed","kind":"buy"}
2026-10-27 20:58:00 request.outcome {"requestId":"dry-buy","outcome":"refused","kind":"buy","limit":null,"message":"the season has not started; it opens at 2026-10-27 21:00 (UTC+8)"}
2026-10-27 21:00:00 season.open {"opensAt":"2026-10-27T13:00:00.000Z","jitterMs":31044}
2026-10-27 21:00:32 jitter.done {"afterMs":212000}
```
League reads: 2026-10-27 20:57:00, 2026-10-27 21:00:00, 2026-10-27 21:00:33, 2026-10-27 21:00:33
First market read: 2026-10-27 21:00:32 (<site>/api/v1/snapshot); market reads in all: 24
Wallet trades (preview/execute): 0

## (i) The same, with no start announced: it waits, and reads the league every 5 minutes

The runtime's notices (UTC+8):
```text
2026-10-27 20:57:00 [demo] season: waiting for the season: it trades nothing until feast.meme announces the start
2026-10-27 20:57:00 [demo] started: prompt mode; Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.
```
Its log, the lines that matter (UTC+8):
```text
2026-10-27 20:57:00 started {"startJitterMs":0,"waitForSeason":true,"opensAt":null}
2026-10-27 20:58:00 inbox.refused {"problem":"the season has not started; it opens when feast.meme announces the start","season":"closed","kind":"buy"}
2026-10-27 20:58:00 request.outcome {"requestId":"dry-buy","outcome":"refused","kind":"buy","limit":null,"message":"the season has not started; it opens when feast.meme announces the start"}
```
League reads: 2026-10-27 20:57:00, 2026-10-27 21:02:00, 2026-10-27 21:07:00, 2026-10-27 21:12:00
First market read: none; market reads in all: 0
Wallet trades (preview/execute): 0
