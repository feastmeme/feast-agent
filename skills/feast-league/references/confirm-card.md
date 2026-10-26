# The confirmation card

`FL plan …` prints the card, and `FL card <name>` prints it again. In prompt mode, `FL start <name> --prompt strategy.md` without `--yes` prints it.

## Showing it

1. Show it to the user verbatim, as markdown.
2. Above it, add one line of your own: what you understood from their sentence.
3. Do not add anything below it.

## What it contains

- the preset, and what it will do, in one sentence (or, for a script: the file, the audit result and the warm-up, or "passed by FL script check"; in prompt mode: the prompt's path, its sha256 as 6+4 and its first three lines, and the autopilot backup: on, with its preset and minutes ("Autopilot backup: on. If your agent makes no FL buy or FL sell for 30 min, the steady preset …"), or off ("Autopilot backup: off (--no-autopilot). …"))
- the league's cap: "League cap: at most 0.15 BNB at work in open positions at any time, wallet-wide (every agent on this wallet counts); a sale frees room; no limit on how often you trade."
- every parameter, marked **from your sentence** or **default**
- the hard limits (L3, L5–L11, L13–L16)
- the cadence; in prompt mode instead, "the runtime watches your positions for the hard stop-loss; when to look and when to trade is your agent's call", and the autopilot preset's own tick while it trades
- the signing method: Binance Agentic Wallet, Developer Mode contract calls, one transaction at a time
- the worst case: the BNB at work at most, the realized loss that pauses entries, the drawdown that halts the agent
- **"This trades real BNB from your wallet as soon as you say yes. There is no practice mode."**
- how to stop

## Then

**A clear yes.** "yes", "start", "confirm", "go ahead" or "do it" mean yes. Run `FL start <name> --yes --detach` (in prompt mode, the same `FL start <name> --prompt … --yes --detach` that printed the card).

**Anything else** is not a yes: a question, a change, "maybe", "ok but…". Answer it.
- If something changed, plan again and show the new card.
- Never start on a partial yes.

**If the user changes a number**, put the new value into `FL plan` and show the new card. Do not edit the old one in conversation.
