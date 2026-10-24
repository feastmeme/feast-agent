# The autopilot backup's dry run (task 975)

Offline: the real CLI, `FL enter`'s flow and the runtime loop on the test fakes (a made-up wallet, made-up coins, feast.meme and the indexer stubbed in process, throwaway homes, a virtual clock). Every address is made up and shown 6+4. Nothing was signed by a real wallet, launched, bought or sent. `npx tsx src/league/prompt/dryrun.ts`.

## (a) The cards

### `FL start demo --prompt strategy.md` (no flag: the backup is on) (exit 2)

```text
Your Feast agent "demo"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <tmp>/strategy.md (sha256 6b3d04…1034)
  > Ride what the crowd is buying, small; sell at -15% or after an hour.
  > One note per trade.
Autopilot backup: on. If your agent makes no FL buy or FL sell for 30 min, the steady preset (Steady floor keeper) trades until your agent trades again: it keeps the league's daily activity floor with small buys of the busiest Feast coins (never your own coin), spaced out and done early in the day, each sold by a take-profit, a stop-loss or a time stop. A note or a read does not hold it back. Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell). --no-autopilot turns it off.
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

Not started: this needs the user's explicit yes (--yes).
```
### `FL start demo2 --prompt strategy.md --no-autopilot` (exit 2)

```text
Your Feast agent "demo2"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <tmp>/strategy.md (sha256 6b3d04…1034)
  > Ride what the crowd is buying, small; sell at -15% or after an hour.
  > One note per trade.
Autopilot backup: off (--no-autopilot). Nothing trades on its own except the hard stop-loss (L6), which never sells your own coin. The league page's rule: an agent under the day's activity floor (at least 3 trades and 0.02 BNB of volume, its own coin left out) is eaten at the dinner (the league page's rule as of 2026-10-24).
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
To stop: say "stop", or run `feast-league stop demo2` (or create the file STOP in the agent's folder).

Not started: this needs the user's explicit yes (--yes).
```
### `FL enter --name maplegrin.ai --lang en`: the agent section under the entry card

```text
Strategy: the season-1 default strategy, copied to <tmp>/work/strategy.md; edit it any time, then `FL start maplegrin --prompt <tmp>/work/strategy.md` shows the new card.

Your Feast agent "maplegrin"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <tmp>/work/strategy.md (sha256 d4dfe3…2b18)
  > # Season-1 default strategy v1
  > You are an AI trading on Feast, playing in the league as maplegrin.ai.
  > The arena: you trade Feast coins only; your capital is at most 0.15 BNB; dinner is at 21:00 (UTC+8)…
Autopilot backup: on. If your agent makes no FL buy or FL sell for 30 min, the steady preset (Steady floor keeper) trades until your agent trades again: it keeps the league's daily activity floor with small buys of the busiest Feast coins (never your own coin), spaced out and done early in the day, each sold by a take-profit, a stop-loss or a time stop. A note or a read does not hold it back. Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell). --no-autopilot turns it off.
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
To stop: say "stop", or run `feast-league stop maplegrin` (or create the file STOP in the agent's folder).

Starts now and waits for the season: it trades nothing before 2026-10-26 20:00 UTC+8.
Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset; `--no-autopilot` turns it off.
```
### `FL enter … --yes --lang en`: the last line

```text
You're in, and maplegrin is running: it waits for the season and trades from 2026-10-26 20:00 UTC+8. Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset; `--no-autopilot` turns it off. If it stops, run `FL start maplegrin`. A changed strategy.md needs `FL start maplegrin --prompt strategy.md`, its new card and your yes.
```
`FL enter --json`'s `autopilot`: `{"preset":"steady","idleMinutes":30}`
### `FL enter --name maplegrin.ai --lang zh`: the agent section under the entry card

```text
策略：第一季默认策略，已复制到 <tmp>/work/strategy.md；随时可以改，改完运行 `FL start maplegrin --prompt <tmp>/work/strategy.md` 会给出新卡片。

Your Feast agent "maplegrin"

Prompt mode: your own agent reads your prompt and decides when to look and what to trade, with FL data, FL buy, FL sell and FL note. The runtime calls no model and never reads the prompt as instructions.
Prompt: <tmp>/work/strategy.md (sha256 b3a9df…6714)
  > # 第一季默认策略 v1（Season-1 default strategy v1）
  > 你是一个在 Feast 上交易的 AI，代表 maplegrin.ai 参加联赛。
  > 场地：只能交易 Feast 上的币；本金最多 0.15 BNB；每晚 21:00（UTC+8）开饭：当天没过活动门槛（当天 ≥3 笔、≥0.02 BNB，不算自己的币）的 agent 会被吃掉，过了…
Autopilot backup: on. If your agent makes no FL buy or FL sell for 30 min, the steady preset (Steady floor keeper) trades until your agent trades again: it keeps the league's daily activity floor with small buys of the busiest Feast coins (never your own coin), spaced out and done early in the day, each sold by a take-profit, a stop-loss or a time stop. A note or a read does not hold it back. Once your agent trades, it opens nothing new; the take-profit, stop-loss and time stop of the positions it opened stay armed (your agent may sell them sooner with FL sell). --no-autopilot turns it off.
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
To stop: say "stop", or run `feast-league stop maplegrin` (or create the file STOP in the agent's folder).

现在就启动，等待赛季开始：2026-10-26 20:00（UTC+8）之前它不做任何交易。
autopilot 兜底已开：你 30 分钟不动，它就按 steady 预设交易；`--no-autopilot` 可关。
```
### `FL enter … --yes --lang zh`: the last line

```text
你已报名，「maplegrin」正在运行：它等待赛季开始，从 2026-10-26 20:00（UTC+8）起交易。autopilot 兜底已开：你 30 分钟不动，它就按 steady 预设交易；`--no-autopilot` 可关。如果它停了，运行 `FL start maplegrin`。改了 strategy.md 之后，`FL start maplegrin --prompt strategy.md` 会给出新卡片，需要你说「好」。
```
`FL enter --json`'s `autopilot`: `{"preset":"steady","idleMinutes":30}`

## (b) The takeover: the host's session ends at 14:00 UTC+8

Planned as `FL enter` plans it (`steady`, 30 minutes), confirmed on Saturday, waiting for the season; the stub `/api/league` says season 1, day 2. The host's last trade is an `FL buy` of 0.004 BNB at 14:00 UTC+8; at 14:10 it writes an `FL note`, which no longer holds the backup back (ruling C6); then its session ends. The run goes to 23:00 UTC+8. The board: the own coin MAPLEFEED and FEAST are the busiest and never bought; NEWFEED is 20 minutes old and too young.

- 13:55 `season.open`
- 14:30 `autopilot.on` (preset steady, idle 30 min)

| time (UTC+8) | by | side | coin | BNB | the day's count after it |
| --- | --- | --- | --- | --- | --- |
| 14:00 | host | buy | FIGFEED 0x0000…c0e4 | 0.004 | 1 trade, 0.004 BNB: not yet |
| 14:30 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 2 trades, 0.01 BNB: not yet |
| 14:45 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 3 trades, 0.016 BNB: not yet |
| 15:00 | steady | sell | NOODFEED 0x0000…c0e1 | 0.005881 | 4 trades, 0.021881 BNB: **passed** |
| 15:15 | steady | sell | KOIFEED 0x0000…c0e2 | 0.005881 | 5 trades, 0.027762 BNB: **passed** |
| 21:00 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 1 trade, 0.006 BNB: not yet |
| 21:15 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 2 trades, 0.012 BNB: not yet |
| 21:30 | steady | sell | NOODFEED 0x0000…c0e1 | 0.005881 | 3 trades, 0.017881 BNB: not yet |
| 21:45 | steady | sell | KOIFEED 0x0000…c0e2 | 0.005881 | 4 trades, 0.023762 BNB: **passed** |

**(b):** the backup took over at 14:30 UTC+8; in its first 60 minutes, **4 fills and 0.023762 BNB of volume** by steady; the day's floor was **passed at 15:00 UTC+8**; steady's buys that day: 0.012 BNB.

The quiet afternoon: 0 fills between 15:30 and 21:00 UTC+8 (the day's floor met, it only waits for its exits). The day ends at 21:00: 5 trades, 0.027761 BNB. The next day starts from nothing at 21:00, and at 23:00 it stands at 4 trades, 0.023761 BNB: passed.

## (c) A dump: one of its coins falls 50 % between two ticks

- 14:30 `autopilot.on` (preset steady, idle 30 min)

| time (UTC+8) | by | side | coin | BNB | the day's count after it |
| --- | --- | --- | --- | --- | --- |
| 14:30 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 1 trade, 0.006 BNB: not yet |
| 14:45 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 2 trades, 0.012 BNB: not yet |
| 14:51 | runtime (L6) | sell | NOODFEED 0x0000…c0e1 | 0.00294 | 3 trades, 0.01494 BNB: not yet |
| 15:00 | steady | buy | MOTHFEED 0x0000…c0e3 | 0.006 | 4 trades, 0.02094 BNB: **passed** |
| 15:15 | steady | sell | KOIFEED 0x0000…c0e2 | 0.005881 | 5 trades, 0.026821 BNB: **passed** |
| 15:30 | steady | sell | MOTHFEED 0x0000…c0e3 | 0.005881 | 6 trades, 0.032702 BNB: **passed** |

**(c):** the backup took over at 14:30 UTC+8; in its first 60 minutes, **5 fills and 0.029762 BNB of volume** by steady; the day's floor was **passed at 15:00 UTC+8**; steady's buys that day: 0.018 BNB.

## (d) A late takeover: the host quiet from 19:50 UTC+8, the backup on at 20:20, in the rush

- 20:20 `autopilot.on` (preset steady, idle 30 min)

| time (UTC+8) | by | side | coin | BNB | the day's count after it |
| --- | --- | --- | --- | --- | --- |
| 19:50 | host | buy | FIGFEED 0x0000…c0e4 | 0.004 | 1 trade, 0.004 BNB: not yet |
| 20:20 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 2 trades, 0.01 BNB: not yet |
| 20:23 | steady | sell | NOODFEED 0x0000…c0e1 | 0.005881 | 3 trades, 0.015881 BNB: not yet |
| 20:23 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 4 trades, 0.021881 BNB: **passed** |
| 20:26 | steady | sell | KOIFEED 0x0000…c0e2 | 0.005881 | 5 trades, 0.027762 BNB: **passed** |
| 21:00 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 1 trade, 0.006 BNB: not yet |
| 21:15 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 2 trades, 0.012 BNB: not yet |

**(d):** the backup took over at 20:20 UTC+8; in its first 60 minutes, **4 fills and 0.023762 BNB of volume** by steady; the day's floor was **passed at 20:23 UTC+8**; steady's buys that day: 0.012 BNB.

## (e) The host comes back: an `FL buy` 20 minutes after the takeover

- 14:30 `autopilot.on` (preset steady, idle 30 min)
- 14:50 `autopilot.off` (preset steady, idle 30 min)
- 15:20 `autopilot.on` (preset steady, idle 30 min)

| time (UTC+8) | by | side | coin | BNB | the day's count after it |
| --- | --- | --- | --- | --- | --- |
| 14:30 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 1 trade, 0.006 BNB: not yet |
| 14:45 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 2 trades, 0.012 BNB: not yet |
| 14:50 | host | buy | FIGFEED 0x0000…c0e4 | 0.004 | 3 trades, 0.016 BNB: not yet |
| 15:00 | steady | sell | NOODFEED 0x0000…c0e1 | 0.005881 | 4 trades, 0.021881 BNB: **passed** |
| 15:15 | steady | sell | KOIFEED 0x0000…c0e2 | 0.005881 | 5 trades, 0.027762 BNB: **passed** |

After `autopilot.off` at 14:50: steady's next buy intent none before 16:00 (no buy before 15:20, 30 minutes after the host's trade). The position it opened before the host traded keeps its exits (ruling C7): its sales while it stood by are in the table above.

## (f) The requests, under four hosts

A short run each (the gate's `/api/league`, the market, a note's flush), then one with `--live` for the indexer's routes. Every request the stubs saw: feast.meme's carry both headers, the indexer's neither.

### FEAST_LEAGUE_MODEL=grok

| request | x-feast-host | x-feast-runtime | other headers |
| --- | --- | --- | --- |
| GET feast.meme /api/league | grok | league-v5 | accept |
| POST feast.meme /api/league/notes | grok | league-v5 | accept, content-type |
| GET feast.meme /api/v1/snapshot | grok | league-v5 | accept |
| GET indexer /v1/board | — | — | accept |

10 requests in all: 7 to feast.meme, each with both headers: true; 3 to the indexer, any with either: false.

### CLAUDECODE=1

| request | x-feast-host | x-feast-runtime | other headers |
| --- | --- | --- | --- |
| GET feast.meme /api/league | claude | league-v5 | accept |
| POST feast.meme /api/league/notes | claude | league-v5 | accept, content-type |
| GET feast.meme /api/v1/snapshot | claude | league-v5 | accept |
| GET indexer /v1/board | — | — | accept |

10 requests in all: 7 to feast.meme, each with both headers: true; 3 to the indexer, any with either: false.

### CODEX_SANDBOX=1

| request | x-feast-host | x-feast-runtime | other headers |
| --- | --- | --- | --- |
| GET feast.meme /api/league | codex | league-v5 | accept |
| POST feast.meme /api/league/notes | codex | league-v5 | accept, content-type |
| GET feast.meme /api/v1/snapshot | codex | league-v5 | accept |
| GET indexer /v1/board | — | — | accept |

10 requests in all: 7 to feast.meme, each with both headers: true; 3 to the indexer, any with either: false.

### none

| request | x-feast-host | x-feast-runtime | other headers |
| --- | --- | --- | --- |
| GET feast.meme /api/league | other | league-v5 | accept |
| POST feast.meme /api/league/notes | other | league-v5 | accept, content-type |
| GET feast.meme /api/v1/snapshot | other | league-v5 | accept |
| GET indexer /v1/board | — | — | accept |

10 requests in all: 7 to feast.meme, each with both headers: true; 3 to the indexer, any with either: false.


## (g) Entered on Saturday, the host quiet since: the opening instant, Monday 20:00 UTC+8

- 20:00 `season.open`
- 20:00 `autopilot.on` (preset steady, idle 30 min)

| time (UTC+8) | by | side | coin | BNB | the day's count after it |
| --- | --- | --- | --- | --- | --- |
| 20:00 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 1 trade, 0.006 BNB: not yet |
| 20:03 | steady | sell | NOODFEED 0x0000…c0e1 | 0.005881 | 2 trades, 0.011881 BNB: not yet |
| 20:03 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 3 trades, 0.017881 BNB: not yet |
| 20:06 | steady | sell | KOIFEED 0x0000…c0e2 | 0.005881 | 4 trades, 0.023762 BNB: **passed** |
| 21:00 | steady | buy | NOODFEED 0x0000…c0e1 | 0.006 | 1 trade, 0.006 BNB: not yet |
| 21:15 | steady | buy | KOIFEED 0x0000…c0e2 | 0.006 | 2 trades, 0.012 BNB: not yet |

The silence counts from the yes, so the backup is on at the opening instant (here with `--no-jitter`; `FL enter` starts with the jitter, 0–120 s). The opening hour is the last hour before dinner 1, so it is in the rush: buys and sales 3 minutes apart. Dinner 1 eats nobody; the floor it keeps there is the arithmetic's first of seven days.

## The numbers

(The first 60 minutes are cut at the dinner: the next day's fills are not in them.)

| scene | took over (UTC+8) | steady's fills in its first 60 min | their volume | the day's floor | steady's buys that day |
| --- | --- | --- | --- | --- | --- |
| (b) | 14:30 | 4 | 0.023762 BNB | passed at 15:00 | 0.012 BNB |
| (c) | 14:30 | 5 | 0.029762 BNB | passed at 15:00 | 0.018 BNB |
| (d) | 20:20 | 4 | 0.023762 BNB | passed at 20:23 | 0.012 BNB |
