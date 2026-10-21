# The confirmation card

`FL plan …` prints the card, and `FL card <name>` prints it again.

## Showing it

1. Show it to the user verbatim, as markdown.
2. Above it, add one line of your own: what you understood from their sentence.
3. Do not add anything below it.

## What it contains

- the preset, and what it will do, in one sentence (or, for a script: the file, the audit result and the warm-up)
- every parameter, marked **from your sentence** or **default**
- the hard limits L1–L16
- the cadence
- the signing method: Binance Agentic Wallet, Developer Mode contract calls, one transaction at a time
- the worst case: trades an hour, BNB a day, BNB in all
- **"This trades real BNB from your wallet as soon as you say yes. There is no practice mode."**
- how to stop

## Then

**A clear yes.** "yes", "start", "confirm", "go ahead" or "do it" mean yes. Run `FL start <name> --yes --detach`.

**Anything else** is not a yes: a question, a change, "maybe", "ok but…". Answer it.
- If something changed, plan again and show the new card.
- Never start on a partial yes.

**If the user changes a number**, put the new value into `FL plan` and show the new card. Do not edit the old one in conversation.
