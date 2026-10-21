# The model read: eight questions

Answer each one in writing for the exact file you were given. Quote line numbers.

**M1 · Intent.** Does the script do what the user asked? Say what it does in two sentences.
- Name anything it does that they did not ask for.

**M2 · Frequency.** What are the worst-case trades per hour, and per day?
- Is there a path that buys on every tick or on every event with no condition?
- Is there a path that buys again while a position is already open, when the user did not ask for that?

**M3 · Exits.** Does every entry have a way out: a stop, a target, a time, a signal?
- Is the way out reachable?
- (The runtime's backstop stop-loss sells at −50 % anyway. Say whether the script relies on it.)

**M4 · Units.** Are amounts in BNB, as `api.buy` takes them? Is there a mix-up of wei or coin units?
- Do prices go the right way (BNB per coin)?
- Can anything divide by zero, or by a value that may be null (`priceBnb`, `pnlPct`, `markBnb`)?

**M5 · Obfuscation and misdirection.**
- Encoded strings, character codes, odd identifiers, minified code.
- Comments or names that say one thing while the code does another.
- Refuse anything you cannot read plainly.

**M6 · Scope.**
- Does it trade only Feast coins, through `api`?
- If it launches: how many coins, and with what names? Refuse anything offensive, misleading, or impersonating a person, a project or a brand.

**M7 · State.** Does `api.state` stay small and bounded, or can it grow without limit (lists that are never trimmed)?

**M8 · What the rules cannot see.** Anything else a careful reader would want the user to know before real money moves.

**The verdict is `pass` only if** no answer above is a real concern. Otherwise `refuse`, and give the reason in the notes.
