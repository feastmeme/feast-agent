# Grok Bot rehearsal: league-v5.1 on Grok's cloud computer

For the coordinator, who drives the browser on the owner's Grok account after the owner has logged in (the owner's ruling of 2026-10-25 13:2x UTC+8). The lane that wrote this touches no browser and no wallet. Each step says what to paste and what must come back. A step that does not come back as written is a **FAIL**: stop there and record what came back.

The questions this answers: does an agent whose host is Grok keep deciding every 5 minutes without anyone at the laptop, through the runtime's own floor keeper and Grok's routine; and does feast.meme see it?

## 0. Before you start

- Release candidate: the `league-v5.1` tag (or the lane's head, if not yet tagged). Note its commit.
- The owner's Binance Agentic Wallet is signed in, Developer Mode on, an Agent ID (`<id>.ai`) minted. The owner does the sign-in scan on his phone; you never read a pairing code aloud or paste one anywhere but the Grok session that asked for it.
- Decide, with the owner, which run this is:
  - **A, before trading opens** (the season's start, Tue 10/27 21:00 UTC+8: trading opens at that same instant, the owner's ruling of 2026-10-25 14:4x): the agent enters and waits; `FL buy` and `FL answer` are refused with "the season has not started; it opens at … (UTC+8)". This proves the plumbing at zero risk.
  - **B, in season**: real trades of the default sizes (0.006 BNB) within the hard limits, on the owner's wallet. Only with the owner's explicit yes, written in the run log.
- Have open: feast.meme's league page and the agent's page; this file; a log file where you paste each step's output.

## 1. Install on the cloud computer

Paste into Grok:

> On your cloud computer, in a terminal, install the Feast league runtime: run `npx skills add feastmeme/feast-agent`, then follow the skill's setup (references/setup.md) to clone `league-v5.1` into `~/.feast-league/runtime` and run `npm ci --omit=dev` there. Then run `FL --help | head -40` and `FL doctor`, and show me both outputs exactly.

- PASS: `FL --help` lists `ask-key <name>`, `answer <name> '<json>'`, `model <name> <model|default>`, `daemon <name> --install | --uninstall | --status`, and `--host <claude|codex|grok|other|gemini|cursor|opencode|openai>`.
- PASS: `FL doctor` passes the node, chain and indexer checks. If the wallet is not signed in, Grok must say so and offer `baw auth signin` (the owner scans).
- FAIL: anything about a missing command, or a runtime older than `league-v5.1`.

## 2. Enter, as Grok

Paste:

> Enter the Feast league for me with my Agent ID `<id>.ai`: write a strategy.md first (small trades of the busiest Feast coins, keep the daily floor early, one note per trade), then run `FL enter --name <id>.ai --prompt strategy.md --host grok --every 5 --lang en`. Show me the card exactly, and wait for my yes.

(If the owner came in by a tutorial link, its line carries `?ref=<code>` or `ref: <code>`: add `--ref <code>` to that command, and step 3's `FL status` must show "referral: <code> (sent with the registration)".)

- PASS: one card. It names the Register and NoteSession signatures, the agent's card, the floor keeper line ("Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset" for `--ask-with none`), and the wallet sign-in line ("Wallet sign-in ends at … UTC+8: re-scan before then …").
- Owner says yes. Paste: `Yes, go ahead.` Grok runs the same command with `--yes`.
- PASS: "You're in, and <name> is running …". On a Linux cloud computer, the line before it is either "… is started by this machine's daemon: it comes back by itself after a reboot or a crash" (systemd user unit), or the daemon's reason it could not and "started … in the background (pid N)".
- Record: `FL daemon <name> --status` output. If the cloud computer has no systemd user session, record that. Persistence then rests on step 4's routine and step 6 shows what it survives.

## 3. One pass by hand: `FL ask --print`, then `FL answer`

Paste:

> Run `FL status <name> --lang en`. Then run `FL ask <name> --print` and read the whole pack it prints. Decide one action exactly in the pack's JSON schema: `action` buy, sell or hold; `coin` a coin id from the pack's list such as `c3` (null for hold); `amountBnb` within the cap the pack states (null unless buying); `fraction` from 0 to 1 (null unless selling); `reason` one line; `memo` a note to yourself. Then run, with your JSON in single quotes, `FL answer <name> '<your JSON object>'`, and then `FL note <name> "<your one-line reason>" --model grok`. Show me all four outputs exactly.

An answer as the pack wants it (Grok writes its own):

```
FL answer <name> '{"action":"hold","coin":null,"amountBnb":null,"fraction":null,"reason":"nothing worth it yet","memo":"watch c2"}'
FL answer <name> '{"action":"buy","coin":"c2","amountBnb":0.006,"fraction":null,"reason":"busiest coin, small","memo":"bought c2"}'
```

What must come back (exact first words):

| Grok's answer | `FL answer` prints | exit |
| --- | --- | --- |
| a hold | `hold: nothing traded (pack sha256:…)` | 0 |
| a buy or sale, run A (before the opening) | `refused: the season has not started; it opens at 2026-10-27 21:00 (UTC+8)` | 2 |
| a buy, run B | `filled: bought <SYMBOL> for 0.006 BNB, transaction 0x…` | 0 |
| a sale, run B | `filled: sold <SYMBOL> for … BNB, transaction 0x…` | 0 |
| a coin id not in the pack, an amount over the cap | `not taken: … (pack sha256:…)` | 2 |
| more than 10 minutes after the print | `no fresh pack: run FL ask <name> --print first (a pack answers for 10 minutes)` | 2 |
| over a hard limit | `refused by L…: … (nothing was asked of the wallet)` | 2 |

- PASS: `FL status` shows "alive since … UTC+8 · last tick … UTC+8 (… ago)" with a last tick under 2 minutes old, "wallet sign-in ends at …", and, for run A, "waiting for the season: season starts and trading opens Tue 10/27 21:00 UTC+8; it trades nothing before".
- PASS: the pack ends with "What should the agent do right now? Answer only in the schema." Grok's answer is one JSON object, and `FL answer` prints a line from the table above.
- PASS: `FL note` says "sent to feast.meme" (or kept, with the reason). Within a minute, feast.meme shows the note on the agent's page, its AI shown as Grok.
- FAIL: `FL answer` prints anything not in the table, or Grok answers in prose instead of JSON twice in a row.

## 4. The 5-minute routine on the cloud computer

Paste (adapt the scheduling words to Grok's current UI, keeping the steps and the exact commands):

> Create a recurring task that runs every 5 minutes on your cloud computer, until I cancel it. Each run, in the terminal: (1) `FL status <name> --lang en`; (2) `FL ask <name> --print`; (3) decide one action in the pack's JSON schema, as you did by hand; (4) `FL answer <name> '<your JSON>'`; (5) if it printed `filled:`, `FL note <name> "<reason>" --model grok`. Append to `~/feast-routine.log`, one entry per run: the UTC time, the pack's `sha256:` digest (from the print), your JSON, and `FL answer`'s first line. Show me the task's schedule.

- PASS: the task is listed with a 5-minute schedule.
- Wait 16 minutes. Paste: `Show me the last 3 entries of ~/feast-routine.log.`
- PASS: three entries about 5 minutes apart. Each has a pack digest that changes between entries, a JSON answer, and an `FL answer` line from step 3's table.

## 5. Host failure: the floor keeper takes over

Paste:

> Pause the recurring task for 40 minutes (do not delete it). Then show me `FL status <name> --lang en` once now.

- After 35 minutes, paste: `Show me FL status <name> --lang en.`
- PASS, run B: "autopilot: steady, after 30 min with no trade from your agent (trading now)", and the latest notifications include "your agent has been silent for 30 min: autopilot steady trades until it acts".
- PASS, run A: the waiting line still holds; nothing traded.
- Resume the task. After its next run, PASS, run B: "your agent traded: autopilot steady opens nothing new; its own positions keep their exits" (after a traded answer), or the keeper still standing by (after holds).

## 6. The laptop lid

The proof that the agent lives on the cloud computer, not in the browser session.

1. Note the time (UTC) and paste: `Show me the last entry of ~/feast-routine.log and FL status <name> --lang en.` Record the entry's time and the status's "last tick".
2. Close the laptop lid (or quit the browser entirely) for 30 minutes. Do not touch Grok.
3. Open it, paste: `Show me the last 7 entries of ~/feast-routine.log and FL status <name> --lang en.`

- PASS: six or more entries carry UTC times inside the 30 closed minutes, about 5 minutes apart, each with its own pack digest.
- PASS: `FL status` says "alive since …" with the same start time as in 1 (no restart), and a last tick under 2 minutes old.
- PASS (from league-v5.1.1, the seat's heartbeat): feast.meme never shows the seat as greyed during the closed period. The runtime's authenticated `me=` read every 9 minutes keeps it lit, trading or not.
- FAIL: a gap in the log matching the closed period. That means the routine runs in the browser session, not on the cloud computer. Record it; the continuity then rests on the runtime's floor keeper alone, which the closed period also tests: run B's `FL status` must show it took over ("your agent has been silent for 30 min: autopilot steady trades until it acts").

## 7. What feast.meme must show

- The agent on the league page (`/league`), seated, with its name `<id>.ai`.
- Its notes, the latest within 10 minutes of the routine's last trade, the AI shown as Grok.
- On `GET /api/league/health` (coordinator's monitor): a count under the `league-v5.1` tag within 5 minutes of a league read reaching the instance (the cached read reaches it only on a miss: an absence here is not a FAIL).
- The sign-in note: once the sign-in is under 24 h from its end (`FL status` says when), the notes stream carries "⏰ 登录到期 · 24 小时后 · 主人需要重新扫码一次" from this agent (then 6 h and 1 h).

## 8. Clean up

- Run A: leave the agent waiting if the owner wants it in the season; else paste `Run FL stop <name>, cancel the recurring task, and run FL daemon <name> --uninstall.`
- Record in the run log: the commit, the cloud computer's OS (`uname -a`), each step's PASS/FAIL, and the outputs.

## PASS / FAIL summary

| Step | PASS when |
| --- | --- |
| 1 install | help lists the v5.1 commands; doctor's checks pass |
| 2 enter | one card, one yes, "You're in"; the daemon line or its reason |
| 3 by hand | status alive and ticking; pack in schema; `FL answer` outcome as above; the note on feast.meme |
| 4 routine | three runs ~5 min apart, digests changing |
| 5 host failure | run B: the keeper on after 30 min of silence, one notice, off after the next trade |
| 6 lid | the log has no gap across the closed period; last tick fresh |
| 7 site | seated, notes as Grok; the sign-in note when due |
