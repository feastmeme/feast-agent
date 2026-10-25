# Grok Bot rehearsal: league-v5.1 on Grok's cloud computer

For the coordinator, who drives the browser on the owner's Grok account after the owner has logged in (the owner's ruling of 2026-10-25 13:2x UTC+8). The lane that wrote this touches no browser and no wallet. Each step says what to paste and what must come back. A step that does not come back as written is a **FAIL**: stop there and record what came back.

The questions this answers: does an agent whose host is Grok keep deciding every 5 minutes without anyone at the laptop, through the runtime's own floor keeper and Grok's routine; and does feast.meme see it?

## 0. Before you start

- Release candidate: the `league-v5.1` tag (or the lane's head, if not yet tagged). Note its commit.
- The owner's Binance Agentic Wallet is signed in, Developer Mode on, an Agent ID (`<id>.ai`) minted. The owner does the sign-in scan on his phone; you never read a pairing code aloud or paste one anywhere but the Grok session that asked for it.
- Decide, with the owner, which run this is:
  - **A, before trading opens** (Wed 10/28 20:00 UTC+8): the agent enters and waits; `FL buy` and `FL answer` are refused with "the season has not started; it opens at … (UTC+8)". This proves the plumbing at zero risk.
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

- PASS: one card. It names the Register and NoteSession signatures, the agent's card, the floor keeper line ("Autopilot backup is on: if you make no trade for 30 minutes, it trades by the steady preset" for `--ask-with none`), and the wallet sign-in line ("Wallet sign-in ends at … UTC+8: re-scan before then …").
- Owner says yes. Paste: `Yes, go ahead.` Grok runs the same command with `--yes`.
- PASS: "You're in, and <name> is running …". On a Linux cloud computer, the line before it is either "… is started by this machine's daemon: it comes back by itself after a reboot or a crash" (systemd user unit), or the daemon's reason it could not and "started … in the background (pid N)".
- Record: `FL daemon <name> --status` output. If the cloud computer has no systemd user session, record that. Persistence then rests on step 4's routine and step 6 shows what it survives.

## 3. One pass by hand

Paste:

> Run `FL status <name> --lang en`, then `FL ask <name> --print`. Read the pack. Decide one action exactly in the pack's JSON schema (buy, sell or hold, a coin id like c3 from the pack, an amount within the cap it states). Then run `FL answer <name> '<your JSON object>'` with your answer, and `FL note <name> "<your one-line reason>" --model grok`. Show me all four outputs exactly.

- PASS: `FL status` shows "alive since … UTC+8 · last tick … UTC+8 (… ago)" with a last tick under 2 minutes old, "wallet sign-in ends at …", and, for run A, "waiting for the season (opens 2026-10-28 20:00 UTC+8)".
- PASS: the pack ends with "What should the agent do right now? Answer only in the schema." Grok's answer is one JSON object.
- PASS, run A: `FL answer` prints "hold: nothing traded (pack sha256:…)" for a hold. For a buy or a sale it prints "not started … the season has not started; it opens at …" or the season-closed refusal (exit 2).
- PASS, run B: a filled buy or sale ("bought … for … BNB (0x…)"), or "hold: nothing traded".
- PASS: `FL note` says "sent to feast.meme" (or kept, with the reason); on feast.meme the agent's page shows the note within a minute, its AI shown as Grok.

## 4. The 5-minute routine on the cloud computer

Paste (adapt the scheduling words to Grok's current UI, keeping the steps):

> Create a recurring task that runs every 5 minutes on your cloud computer, until I cancel it. Each run: (1) `FL status <name> --lang en`; (2) `FL ask <name> --print`; (3) decide one action in the pack's schema; (4) `FL answer <name> '<your JSON>'`; (5) if it traded, `FL note <name> "<reason>" --model grok`. Keep each run's four outputs in a log file `~/feast-routine.log` with a UTC timestamp. Show me the task's schedule.

- PASS: the task is listed with a 5-minute schedule.
- Wait 16 minutes. Paste: `Show me the last 3 entries of ~/feast-routine.log.`
- PASS: three entries, about 5 minutes apart, each with a pack digest (`sha256:` and 16 hex) that changes between entries, and an `FL answer` outcome.

## 5. Host failure: the floor keeper takes over

Paste:

> Pause the recurring task for 40 minutes (do not delete it). Then show me `FL status <name> --lang en` once now.

- After 35 minutes, paste: `Show me FL status <name> --lang en.`
- PASS, run B: "autopilot: steady, after 30 min with no trade from your agent (trading now)", and the latest notifications include "your agent has been silent for 30 min: autopilot steady trades until it acts".
- PASS, run A: the waiting line still holds; nothing traded.
- Resume the task. After its next run, PASS, run B: "your agent traded: autopilot steady opens nothing new; its own positions keep their exits" (after a traded answer), or the keeper still standing by (after holds).

## 6. The laptop lid

1. Close the laptop lid (or quit the browser) for 30 minutes. Do not touch Grok.
2. Open it, paste: `Show me the last 6 entries of ~/feast-routine.log and FL status <name> --lang en.`
- PASS: entries continued about every 5 minutes through the closed period (their UTC timestamps span it), and `FL status`'s last tick is under 2 minutes old.
- PASS: feast.meme still shows the agent seated; for run B, its trade count rose during the closed period, or notes kept arriving.
- FAIL: a gap in the log matching the closed period. That means the routine runs in the browser session, not on the cloud computer. Record it; the continuity then rests on the floor keeper alone.

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
