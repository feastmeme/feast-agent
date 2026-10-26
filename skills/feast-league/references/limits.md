# The hard limits

The runtime applies these to every trade, from every strategy: presets, scripts and manual trades.

- **Tightening.** The user may tighten any limit (`--limit key=value`).
- **Loosening.** They may loosen one only up to its ceiling.
- **Never off.** Zero, a negative, "off" and empty are refused.
- **Refusals.** A refused trade is never retried or resized silently. The one exception is the warm-up tier's documented size.

| Id | Key | Limit | Default | Range | On hit |
| --- | --- | --- | --- | --- | --- |
| L3 | `maxAtWorkBnb` | The league's cap: BNB at work in open positions (their cost, every agent on this wallet) | 0.15 BNB | 0.001 – 0.15 | buys refused until a sale frees room |
| L5 | `maxOpenPositions` | Open positions | 5 | 1 – 20 | no new coins |
| L6 | `backstopStopLossPct` | Backstop stop-loss | 50 % | 5 – 90 % | the runtime sells the position (never the agent's own launch) |
| L7 | `maxDailyLossBnb` | Realized loss in any 24 h | 0.05 BNB | 0.001 – 0.5 | entries pause |
| L8 | `maxDrawdownBnb` | Drawdown from the agent's peak | 0.1 BNB | 0.001 – 0.15 | the agent halts |
| L9 | `maxSlippagePct` | Slippage bound | 10 % | 0.1 – 20 % | a trade asking more is refused |
| L10 | `maxPriceImpactPct` | Price impact of a buy | 8 % | 0.5 – 25 % | that buy is refused |
| L11 | `gasReserveBnb` | BNB never spent | 0.003 BNB | 0.001 – 0.1 | a buy dipping into it is refused |
| L13 | `coinCooldownSeconds` | Between entries into one coin | 60 s | 15 – 3600 | the buy is refused |
| L14 | `maxConsecutiveFailures` | Consecutive failures | 3 | 2 – 10 | the agent pauses |
| L15 | — | Feast coins and our own contracts only | always | — | refused |
| L16 | — | Wallet connected, Developer Mode on, quota left, no stop file | always | — | refused or paused |

**The league's cap (league-v5.1.4).** At most **0.15 BNB at work in open positions at any time; a sale frees room; no limit on how often you trade.** L3 counts the cost of the open positions (fee included) of every agent on this wallet, and the buys still waiting for their receipt. A sale frees its share of the position's cost at once. 0.15 is L3's default and its ceiling: the user may set it lower (`--limit maxAtWorkBnb=0.1`), never higher; `plan` and `set` refuse more with "the league caps capital at work at 0.15 BNB in open positions (a sale frees room)". What the wallet has bought in all is still counted, as a figure in `FL status`, never as a limit.

**Removed in league-v5.1.4 (the owner's ruling).** There is no limit on the size of one trade (L1), on the BNB bought in 24 h (L2) or on the trades in an hour (L12), and L4 (open exposure) became L3. The ids are retired, never reused. `--limit maxTradeBnb=…`, `maxDailySpendBnb`, `maxTradesPerHour`, `budgetBnb` or `maxExposureBnb` is refused with what became of it; an agent planned by an earlier runtime has them folded into L3 when it is read (never above 0.15, never looser than a lower cap the user chose). The smallest trade stays: 0.001 BNB.

**Sales are never blocked by limits on buying.** An exit needs only:

- the wallet
- Developer Mode
- no stop file
- a Feast coin
- a slippage within L9
