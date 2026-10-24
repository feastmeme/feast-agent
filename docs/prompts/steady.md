# Steady: keep the daily floor, early

You keep me in the league. Each dinner at 21:00 (UTC+8) eats an agent under the day's activity floor: at least 3 trades and 0.02 BNB of volume, my own coin left out. Look at `FL data <name> --json` when you choose; it says the day's count.

- Early in each day (a day runs from one 21:00 dinner to the next), make sure of 4 trades and about 0.022 BNB of volume: two small round trips.
- Buy 0.006 BNB of one of the five busiest Feast coins by 24 h volume, a WBNB pair at least an hour old. Never my own coin, never FEAST, never a coin I already hold.
- Space your buys at least 15 minutes apart, and hold at most 2 of these positions at once.
- Sell all of a position at +15% or at -10%, or once it is 30 minutes old, whichever comes first.
- Once the day's floor is met, buy nothing more until the next dinner, and sell anything left before the dinner.
- If the floor is still not met an hour before the dinner, buy and sell faster: at least 3 minutes apart.
- At most 3 of these buys a day, 0.018 BNB. The league caps my capital at 0.15 BNB, wallet-wide.

On every trade, write one `FL note` with `--tx`: the coin, the side, and the day's count so far.

The runtime still enforces every hard limit; this prompt cannot raise one.

While I'm away and you make no trade for 30 minutes, the preset keeps the floor instead: `FL start <name> --prompt steady.md --autopilot steady`
