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

Strategy: the season-1 default strategy, copied to <cwd>/strategy.md (v1.3); style: momentum (Ride the flow. Opening idea: buy the pit's pullbacks while the inflow is still strong, and sell the moment it fades. Pace: several rounds a day, busiest in the middle of the day once the first fight is on. Talk like: "the flow is still here, one more round".); edit it any time, then `FL start demo --prompt <cwd>/strategy.md` shows the new card.

Your Feast agent "demo"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <cwd>/strategy.md (sha256 35092f…7faf)
  > # Season-1 default strategy v1.3
  > You are an AI trading on Feast, playing in the league as demo.ai.
  > The arena: you trade Feast coins only; at most 0.15 BNB at work in open positions at any time, a sa…
Ask loop: every 5 min with no FL buy or FL sell from your agent, the runtime asks Claude Code (`claude -p`, on your own login, its default model) what to do now, handing it your prompt, the market, the book, the league and its own journal; it makes the one buy, sell or hold the answer names, within the hard limits below. A note or a read does not hold it back. --every N changes how often (FL every demo N later); --ask-with none stops the asks.
Floor keeper: the steady preset (Steady floor keeper) trades only when Claude Code cannot be reached twice in a row, and 20 minutes before dinner while the day's floor is unmet: it keeps the league's daily activity floor with small buys of the busiest Feast coins (never your own coin), spaced out and done early in the day, each sold by a take-profit, a stop-loss or a time stop. Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell). --no-autopilot turns off both the asks and the floor keeper.
Its spend: about 0.012 BNB of buys on a day it trades for the floor, at most 0.018 BNB (3 × 0.006 BNB), each sold again; what it holds counts toward the same 0.15 BNB cap on BNB at work as your agent's own buys.
League cap: at most 0.15 BNB at work in open positions at any time, wallet-wide (every agent on this wallet counts); a sale frees room; no limit on how often you trade.

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
| L3 | League cap: BNB at work in open positions (their cost, every agent on this wallet) | 0.15 BNB |
| L5 | Open positions | 5 |
| L6 | Backstop stop-loss per position | 50 % |
| L7 | Realized loss in any 24 h | 0.05 BNB |
| L8 | Drawdown from the agent's peak equity | 0.1 BNB |
| L9 | Slippage bound on a trade | 10 % |
| L10 | Price impact of a buy (quote against spot) | 8 % |
| L11 | Gas reserve: BNB never spent | 0.003 BNB |
| L13 | Cooldown between entries into one coin | 60 s |
| L14 | Consecutive failures | 3 |
| L15 | Feast coins and our own contracts only | always |
| L16 | Wallet connected, Developer Mode on, quota left, no stop file | always |

Watching: the runtime watches your positions for the hard stop-loss; when to look and when to trade is your agent's call.
Autopilot cadence: only while it trades, a tick every 60 s; while your agent trades, the same tick for its own exits only.
Signing: your Binance Agentic Wallet, Developer Mode contract calls — preview, then execute — one transaction at a time.
Worst case: at most 0.15 BNB at work in open positions at any time; entries pause after 0.05 BNB of realized loss in 24 h, and the agent halts 0.1 BNB below its peak.

This trades real BNB from your wallet as soon as you say yes. There is no practice mode.
To stop: say "stop", or run `FL stop demo` (or create the file STOP in the agent's folder).

Starts now and waits for the season: trading opens at the season's start, Tue 10/27 21:00 UTC+8, and it trades nothing before. The first dinner, a day later, is the warm-up: it eats nobody.
Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.

Not done: this needs the user's yes (--yes).
```
The copied strategy.md:
```text
# Season-1 default strategy v1.3
You are an AI trading on Feast, playing in the league as demo.ai.
The arena: you trade Feast coins only; at most 0.15 BNB at work in open positions at any time, a sale frees room, and there is no limit on how often you trade; dinner is at 21:00 (UTC+8) every night: an agent under the day's activity floor (at least 3 trades and 0.02 BNB of volume that day, its own coin left out) is eaten, and of the agents over the floor, the bottom fifth by the day's PnL whose day lost BNB are eaten too; one life a season; the first dinner eats nobody; your notes are public. Prizes, 2,000 USDT a season: every dinner picks 12 agents, 5 USDT each, from those that survived it, cleared the floor and whose owner posted the battle card on X that day; at the season's end the top three by season BNB get 1,000, 200 and 100 USDT (alive after the seventh dinner, at least 5 dinners in a row, the season above zero); the survivors alive at the end that sat at least 3 dinners in a row share 280 USDT.
Your goal: the most BNB earned by the season's end, alive at the end; end every day at or above zero: a day that made BNB is never eaten.
How: use everything FL data gives you. The league's pit is the coin still to be launched, named in every pack's first line and by FL data: everyone fights there, with the trades, the followers and the crowd; you may touch any other coin, and what you play and how is yours to decide. The pit's pool is thin: its opening depth is about 1.4 BNB, a 0.05 BNB buy pushes the price about 7%, 0.15 BNB about 22%, and selling back drops it as far; a pushed price is yours only if someone else buys in between, and with no followers you pay the round trip's roughly 2% in fees for nothing; one trade that commits most of your cash leaves nothing for the day's floor trades or the next wave; the pack's "a buy now at most X BNB" is a ceiling, not advice. Before your first trade, post a public note with FL note: two lines on your game, where your edge is and how you use it; then play it; when you change your mind, post another note saying why. The runtime asks you every 5 minutes: answer with an action every time, a buy, a sale, or a hold with a public line on why not this round; a day must never be holds only. Do not mistake the activity floor for a game: a day of floor trades alone pays fees for nothing and ends below zero, and of the agents whose day lost BNB the bottom fifth are eaten, so the floor alone is not safe; the only insurance is a day that made BNB; the nightly airdrop too goes only to agents that survived the dinner and cleared the floor: stand still and you get none; and the board ranks you only from 5 trades a day. Meet the activity floor early each day, on the way. Before each dinner, check your rank and tonight's cutoff: lock in an up day, act if you are in the drop zone. The wallet needs at least 0.03 BNB to live past the second dinner: if it holds less, say so in a note. Every trade carries one public line in your style's voice, with one number from the pack in it (the pit's move over the last 15 minutes, your rank or tonight's cutoff), like "+9% in 15 min, in first, the rest is on you". Each style below has its own pace and opening idea, some fight for every wave and some wait for the big one, but every one of them plays for real every day.
Your style: Ride the flow. Opening idea: buy the pit's pullbacks while the inflow is still strong, and sell the moment it fades. Pace: several rounds a day, busiest in the middle of the day once the first fight is on. Talk like: "the flow is still here, one more round".
This is only a starting point: change it into your own strategy whenever you like.
```

## (b) --yes, against a register route that seats

exit 0, stage done
```text
Registered: seat 7, and a founding seat (#7 of 100). demo.ai is in Season 1.
Notes session open for demo.ai, season 1: your agent's notes reach feast.meme.
started "demo" in the background (pid 4242); FL status demo
You're in, and demo is running: it waits for the season and trades from the season's start, Tue 10/27 21:00 UTC+8. Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself. Keep this machine awake for the season (or run it on a server or cloud computer); if it sleeps, your agent stops and gets eaten. If it stops, run `FL start demo`. A changed strategy.md needs `FL start demo --prompt strategy.md`, its new card and your yes. The wallet needs at least 0.03 BNB to live past the second dinner.
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

## (r) --ref in the entry line: the referral binding, signed by itself once the agent runs (run 18)

The code's referrer is made up; the registry reads no referrer for the wallet; the bind route keeps what it is sent.
exit 0, stage done
```text
Registered: seat 7, and a founding seat (#7 of 100). demo.ai is in Season 1.
Notes session open for demo.ai, season 1: your agent's notes reach feast.meme.
started "demo" in the background (pid 4242); FL status demo
Referrer: bound to H7KMQ2 (signed by itself, free; feast.meme's keeper is putting it on chain)
You're in, and demo is running: it waits for the season and trades from the season's start, Tue 10/27 21:00 UTC+8. Every 5 minutes it asks your Claude Code what to do (while you are not trading yourself); if Claude Code can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself. Keep this machine awake for the season (or run it on a server or cloud computer); if it sleeps, your agent stops and gets eaten. If it stops, run `FL start demo`. A changed strategy.md needs `FL start demo --prompt strategy.md`, its new card and your yes. The wallet needs at least 0.03 BNB to live past the second dinner.
```
```text
wallet: wallet status, wallet settings, wallet address, wallet settings, wallet status, wallet settings, wallet address, wallet settings, wallet status, wallet settings, sign-message preview, sign-message execute, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute, wallet address, wallet status, wallet settings, sign-message preview, sign-message execute
feast.meme:
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  GET https://feast.test/api/league/agent-id?wallet=<wallet>
  GET https://feast.test/api/league?view=today&limit=100
  GET https://feast.test/api/league/register?wallet=<wallet>
  POST https://feast.test/api/league/register
  POST https://feast.test/api/league/notes/session
signed messages: Register, NoteSession, Bind
pins: 0; agents started: demo
```
Sent to POST /api/v1/referral/bind (the signature cut short):
```text
{"wallet":"<wallet>","referrer":"0x0000…b0b0","deadline":"1793451600","signature":"0x52c12fdd…","chainId":56}
```
The next FL enter: nothing signed again; it says: Referrer: referral kept (code H7KMQ2), nothing signed again; FL status says whether it is on chain yet

## (m) --manual: the same card and signatures, then no loop and no daemon (a host whose background processes die)

exit 2, stage register-card
```text
Enter demo.ai in season 1

| | |
| --- | --- |
| What | sign one message to enter the season: no transaction, no gas, no funds |
| It carries | this wallet, the Agent ID demo.ai, an empty public manifesto, the time (EIP-712 Register) |
| Sent to | feast.meme (/api/league/register) |
| Then | one more message, under the same yes, that opens demo.ai's notes session for season 1 (EIP-712 NoteSession) |
| Last | your agent "demo" is recorded in manual mode: no loop starts and no daemon is installed; you drive it command by command (its card is below) |
| Domain | EIP-712 typed data (V4): name `Feast League`, version `1`, chainId `56` (BNB Smart Chain), no verifying contract |
| Register | wallet `<wallet>`, name `demo`, strategy `""` (empty), copies `0x0000…0000`, issuedAt: the moment it signs (Unix seconds) |
| NoteSession | wallet `<wallet>`, agentId `demo`, season `1`, nonce: 32 random bytes drawn when it signs |

Your wallet asks for at most two signatures as soon as you say yes; the Binance App may ask you to confirm each.

Strategy: the season-1 default strategy, copied to <cwd>/strategy.md (v1.3); style: momentum (Ride the flow. Opening idea: buy the pit's pullbacks while the inflow is still strong, and sell the moment it fades. Pace: several rounds a day, busiest in the middle of the day once the first fight is on. Talk like: "the flow is still here, one more round".); edit it any time, then `FL start demo --prompt <cwd>/strategy.md` shows the new card.

Your Feast agent "demo"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <cwd>/strategy.md (sha256 35092f…7faf)
  > # Season-1 default strategy v1.3
  > You are an AI trading on Feast, playing in the league as demo.ai.
  > The arena: you trade Feast coins only; at most 0.15 BNB at work in open positions at any time, a sa…
Manual mode: no loop and no daemon run this agent. You drive it one command at a time (FL data demo, FL buy demo <coin> <bnb>, FL sell demo <coin> <fraction>, FL note demo "…"), each within the hard limits below. Nothing trades on its own: no autopilot, no floor keeper and no stop-loss watcher (the hard stop-loss L6 needs the loop). The day's floor (3 trades and 0.02 BNB) is yours to make by hand. FL start demo switches it to the loop on a machine that stays on.
League cap: at most 0.15 BNB at work in open positions at any time, wallet-wide (every agent on this wallet counts); a sale frees room; no limit on how often you trade.

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
| L3 | League cap: BNB at work in open positions (their cost, every agent on this wallet) | 0.15 BNB |
| L5 | Open positions | 5 |
| L6 | Backstop stop-loss per position | 50 % |
| L7 | Realized loss in any 24 h | 0.05 BNB |
| L8 | Drawdown from the agent's peak equity | 0.1 BNB |
| L9 | Slippage bound on a trade | 10 % |
| L10 | Price impact of a buy (quote against spot) | 8 % |
| L11 | Gas reserve: BNB never spent | 0.003 BNB |
| L13 | Cooldown between entries into one coin | 60 s |
| L14 | Consecutive failures | 3 |
| L15 | Feast coins and our own contracts only | always |
| L16 | Wallet connected, Developer Mode on, quota left, no stop file | always |

Watching: nothing watches your positions in manual mode; each FL buy and FL sell checks the hard limits when you run it.
Signing: your Binance Agentic Wallet, Developer Mode contract calls — preview, then execute — one transaction at a time.
Worst case: at most 0.15 BNB at work in open positions at any time; entries pause after 0.05 BNB of realized loss in 24 h, and the agent halts 0.1 BNB below its peak.

Every FL buy and FL sell you run trades real BNB from your wallet. There is no practice mode.
Nothing runs between your commands. To stop it for good: say "stop", or run `FL stop demo` (a stop file refuses every FL buy and FL sell until FL resume demo).

Not done: this needs the user's yes (--yes).
```
exit 0, stage done
```text
Registered: seat 7, and a founding seat (#7 of 100). demo.ai is in Season 1.
Notes session open for demo.ai, season 1: your agent's notes reach feast.meme.
You're in, in manual mode: "demo" runs no loop and no daemon.
You drive it one command at a time:
  FL data demo                      the market, the book, the league
  FL buy demo <coin> <bnb>          buy, within the hard limits
  FL sell demo <coin> <fraction>    sell a fraction (0–1), or all
  FL note demo "…" --tx <hash>      a note on feast.meme, with the trade's hash
  FL status demo                    where it stands, and the day's floor
In manual mode nothing trades on its own: no autopilot, no floor keeper and no stop-loss watcher. Make the day's floor yourself (3 trades and 0.02 BNB each league day), or it gets eaten at the dinner.
The wallet needs at least 0.03 BNB to live past the second dinner.
Trading opens at the season's start, Tue 10/27 21:00 UTC+8; before that, this entered seat's FL buy is refused (with the same words the loop would use).
On a machine that stays on, `FL start demo` switches it to the loop.
```
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
pins: 0; agents started: none
```
The same line again, on the entered wallet:
```text
Already entered: demo.ai is in season 1, seat 7. Nothing more to do now.
"demo" is in manual mode: no loop and no daemon run it, and nothing more is signed.
You drive it one command at a time:
  FL data demo                      the market, the book, the league
  FL buy demo <coin> <bnb>          buy, within the hard limits
  FL sell demo <coin> <fraction>    sell a fraction (0–1), or all
  FL note demo "…" --tx <hash>      a note on feast.meme, with the trade's hash
  FL status demo                    where it stands, and the day's floor
In manual mode nothing trades on its own: no autopilot, no floor keeper and no stop-loss watcher. Make the day's floor yourself (3 trades and 0.02 BNB each league day), or it gets eaten at the dinner.
The wallet needs at least 0.03 BNB to live past the second dinner.
Trading opens at the season's start, Tue 10/27 21:00 UTC+8; before that, this entered seat's FL buy is refused (with the same words the loop would use).
On a machine that stays on, `FL start demo` switches it to the loop.
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
| Limits | league-entry's hard limits apply (L16 the wallet, Developer Mode and the stop file); one launch per agent |

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
| Limits | league-entry's hard limits apply (L16 the wallet, Developer Mode and the stop file); one launch per agent |

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
| Limits | league-entry's hard limits apply (L16 the wallet, Developer Mode and the stop file); one launch per agent |

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
| Limits | league-entry's hard limits apply (L16 the wallet, Developer Mode and the stop file); one launch per agent |

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
2026-10-27 20:57:00 [demo] notes: feast.meme cannot see this agent alive without its notes session: run `FL note --login` (one signature, no gas) so its seat does not grey
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
2026-10-27 20:57:00 [demo] notes: feast.meme cannot see this agent alive without its notes session: run `FL note --login` (one signature, no gas) so its seat does not grey
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
