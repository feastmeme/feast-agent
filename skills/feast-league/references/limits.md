# The hard limits

The runtime applies these to every trade, from every strategy: presets, scripts and manual trades.

- **Tightening.** The user may tighten any limit (`--limit key=value`).
- **Loosening.** They may loosen one only up to its ceiling.
- **Never off.** Zero, a negative, "off" and empty are refused.
- **Refusals.** A refused trade is never retried or resized silently. The one exception is the warm-up tier's documented size.

| Id | Key | Limit | Default | Range | On hit |
| --- | --- | --- | --- | --- | --- |
| L1 | `maxTradeBnb` | Size of one trade | 0.02 BNB | 0.001 – 0.25 | that trade is refused |
| L2 | `maxDailySpendBnb` | BNB spent on buys in any 24 h | 0.1 BNB | L1 – 1 | buys wait for the window |
| L3 | `budgetBnb` | BNB the league may ever put in from this wallet | 0.25 BNB | L2 – 10 | buys refused; the user is told |
| L4 | `maxExposureBnb` | Cost of open positions | 0.1 BNB | L1 – 2 | buys refused |
| L5 | `maxOpenPositions` | Open positions | 5 | 1 – 20 | no new coins |
| L6 | `backstopStopLossPct` | Backstop stop-loss | 50 % | 5 – 90 % | the runtime sells the position (never the agent's own launch) |
| L7 | `maxDailyLossBnb` | Realized loss in any 24 h | 0.05 BNB | 0.001 – 0.5 | entries pause |
| L8 | `maxDrawdownBnb` | Drawdown from the agent's peak | 0.1 BNB | 0.001 – L3 | the agent halts |
| L9 | `maxSlippagePct` | Slippage bound | 10 % | 0.1 – 20 % | a trade asking more is refused |
| L10 | `maxPriceImpactPct` | Price impact of a buy | 8 % | 0.5 – 25 % | that buy is refused |
| L11 | `gasReserveBnb` | BNB never spent | 0.003 BNB | 0.001 – 0.1 | a buy dipping into it is refused |
| L12 | `maxTradesPerHour` | Trades per hour | 12 | 1 – 60 | the trade is refused |
| L13 | `coinCooldownSeconds` | Between entries into one coin | 60 s | 15 – 3600 | the buy is refused |
| L14 | `maxConsecutiveFailures` | Consecutive failures | 3 | 2 – 10 | the agent pauses |
| L15 | — | Feast coins and our own contracts only | always | — | refused |
| L16 | — | Wallet connected, Developer Mode on, quota left, no stop file | always | — | refused or paused |

**The league's capital cap (task 963).** Every agent the user plans, on any track, has its L3 budget capped at **0.15 BNB** (the owner's ruling, 2026-10-24: every on-chain amount in BNB). L3's ledger is wallet-wide: every agent on this wallet counts. `plan` and `set` refuse a `budgetBnb` above 0.15 with "the league caps capital at 0.15 BNB"; a lower one is kept. L3's own default (0.25) and ceiling (10) are unchanged: the cap only tightens.

**Sales are never blocked by limits on buying.** An exit needs only:

- the wallet
- Developer Mode
- no stop file
- a Feast coin
- a slippage within L9
