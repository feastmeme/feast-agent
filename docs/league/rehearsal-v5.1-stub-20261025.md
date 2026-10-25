# league-v5.1: the new adapters on the stub rig, 2026-10-25 06:09–06:24 UTC

Commit `8efb583` (the lane's head when it ran), Node 24.19.0. The addendum-7 rig: the local stub site and chain, a fake `baw` with a made-up key, one throwaway home per run, a local port each. No mainnet, no network: the hosts were stubs on PATH (a `gemini` and a Cursor `agent` that log their argv, environment names, working folder and pack, then answer per a sequence), and the endpoint was a local OpenAI-compatible server.

**Not rehearsed for real.** No Gemini CLI, Cursor agent CLI or OpenCode is installed on the lane's machine, and the lane's environment holds no OpenAI-compatible key except Anthropic's. Real runs of all three are the coordinator's (see the report's ask).

Each run: `FL enter --name <id>.ai --prompt strategy.md --host <host> --every 2 --no-jitter` (the card, refused as designed), then the same with `--yes`. The sequence: decide, decide, decide, fail, fail, decide, decide. The sign-in end was set 23 h ahead.

| | G: `--host gemini` | U: `--host cursor` | O: `--host opencode --ask-with openai` |
|---|---|---|---|
| entry | exit 0; "no daemon: the league home is in the temporary folder …", then started in the background | same | same |
| asks 1–3 | buy, sell, buy: filled | same | same |
| floor | passed by ask 3 (3 trades, ~0.03 BNB) | same | same |
| asks 4–5 | "Gemini CLI answered an error: rehearsal stub: quota exceeded" ×2 | "Cursor answered an error: … agent unavailable" ×2 | "your AI endpoint answered HTTP 429: … rate limited" ×2 |
| takeover | `autopilot.on why=asks failing`, **one** notice; the floor keeper bought | same | same |
| recovery | ask 6 answered; `autopilot.off`, **one** notice ("answers again: the floor keeper (steady) steps back …") | same | same |
| day at the end | 7 trades, 0.0627 BNB: passed | 7, 0.0628 | 7, 0.0628 |
| sign-in note | "⏰ 登录到期 · 24 小时后 · 主人需要重新扫码一次", received by the stub's notes route at the start, byte-exact | same | same |

What each host saw (7 calls each):
- **Gemini**: a fresh `feast-ask-…/w` folder each call, empty; `GEMINI_CLI_SYSTEM_SETTINGS_PATH` set, its `tools.exclude` listing 29 tools; no `CLAUDE*`, `CODEX*`, `FEAST*`, `LEAGUE*` or `BAW*` variable.
- **Cursor**: the same fresh empty folder as `--workspace`, no `--force`; the same clean environment.
- **Endpoint**: `Authorization` the expected bearer on 7 of 7, one `user` message, `response_format: json_schema`, no `tools`, no streaming.

`FL status` at the end, for G (U and O alike, with "Cursor", "your AI endpoint … with stub-model"):

```text
tallowgem: running; prompt mode
alive since 2026-10-25 14:09 UTC+8 · last tick 2026-10-25 14:23 UTC+8 (1 min ago)
wallet sign-in ends at 2026-10-26 13:09 UTC+8: re-scan before then or the agent stops trading (FL login says how); once it ends nothing trades, …
asking Gemini CLI every 2 min with its default model · last ask … → buy (rehearsal: the busiest coin): filled · failures in a row 0
floor keeper: steady, when Gemini CLI fails twice in a row, and 20 min before dinner with the floor unmet
today: 7 trades, 0.062749 BNB of volume (the floor: 3 and 0.02 BNB, own coin left out): passed; …
```

Every request to the stub site carried `x-feast-runtime: league-v5.1` and `x-feast-host: other`. (The stub does not log `x-feast-host-detail`; its unit test does.)

Found and fixed during the run: the "You're in" line said "asks your gemini" and "if openai can't be reached". It now says "your Gemini CLI", "your Cursor", and "your AI endpoint … if that endpoint can't be reached" (`enter/copy.ts`, with a test).

All three agents were stopped with `FL stop`, and the stubs were stopped. No `feast-ask-` folder and no LaunchAgent were left behind.
