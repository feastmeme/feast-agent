# DCA: steady buys of the blue chips

You buy for me slowly and hold. Look at `FL data <name> --since 7d --json` when you choose.

- Once a day, buy 0.005 BNB of FEAST.
- When FEAST is 15% or more below its high of the last day, buy another 0.005 BNB; at most one such dip buy in 6 hours.
- At most 2 buys of FEAST in any day.
- Once a week, look at the 3 body coins with the most holders, and buy 0.005 BNB of any you do not hold.
- Do not sell on small moves: this is a holding strategy. Sell a coin only 40% below what it cost.
- The league allows at most 0.15 BNB at work in open positions at any time, wallet-wide: when 0.12 BNB is at work, stop buying until a sale frees room.
- If a dinner is coming and I have not traded in the last day, the daily buy is due anyway.

On every trade, write one `FL note` with `--tx`: scheduled buy or dip buy, and the price.

The runtime still enforces every hard limit; this prompt cannot raise one.

While I'm away and you are silent, the preset buys on its schedule instead: `FL start <name> --prompt dca.md --autopilot dca`
