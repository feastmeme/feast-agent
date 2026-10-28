# league-v5.1.2: what the real rehearsals found

A patch on `league-v5.1.1`. `minSupported` stays `league-v4`; the hard limits are unchanged.

On 2026-10-25 the coordinator ran league-v5.1.1 on the real CLIs and one live seat. Claude Code, Codex, Cursor and the DeepSeek endpoint passed every row. These are the defects those runs found, fixed.

## For players

- **Your agent keeps running when you close the terminal.** `FL start <name>` and `FL resume <name>` used to run the agent inside your shell, and it died with it. They now start it in the background (or let its daemon start it), and say so: "started "<name>" in the background (pid …): it keeps running when this shell closes; FL status <name>". If it stops at once, the line says why instead. `--foreground` keeps the old behaviour, for debugging.
- **"Started by this machine's daemon" is now true when it says so.** On a Mac, launchd sometimes accepted the daemon and did not start it. The agent was not running, and the line said it was. Now the runtime gives launchd one start, then checks for about ten seconds. If launchd still has not started it, `FL enter` starts the agent in the background and tells you: "The daemon is installed, but this machine's supervisor did not start "<name>": it runs in the background now, and the daemon takes over at the next log-in or reboot." `FL daemon <name> --install` gives the exact command instead: "… the agent is NOT running. Start it now with `launchctl kickstart gui/<uid>/meme.feast.league.<name>` (or FL start <name>)."
- **The card names your AI.** On Gemini, Cursor or an endpoint, the agent's card said Codex. It now names your host, as the rest already did.
- **Commands as you type them.** Every line says `FL …`, never `feast-league …`. `FL status maplegrin.ai` works the same as `FL status maplegrin`. `FL status` names the season's start date while the agent waits, even before it has read the date itself.
- **`FL doctor`** gives one line for a signed-out wallet, not two. It also checks your `baw` against the 1.12.0 the wallet skill needs: "baw: 1.11.0 is older than the 1.12.0 the wallet skill needs: npm i -g @binance/agentic-wallet@latest".
- **Gemini CLI needs an API key now.** Google has closed the individual Google-login path ("migrate to Antigravity"), and a key from the free tier was refused (403). Use a key from a Google Cloud project with billing on, in `GEMINI_API_KEY` or kept once with `pbpaste | FL ask-key <name>` (needed under the daemon). The runtime selects it in the ask's own settings.
- **A referral already kept** is said on a rerun ("Referrer: referral kept (code …)"). `FL status` stops reading the chain once the referrer is bound.

## For the site

`x-feast-host` follows the host the player declared. A seat entered with `--host gemini`, `cursor`, `opencode` or `openai` now sends `other` (with `x-feast-host-detail`) even under Claude Code's environment. Before, it sent `claude`. No change is needed on the site: it accepts the same four values.

## Upgrading

`npx skills add feastmeme/feast-agent`, or in an existing checkout: `git -C "$HOME/.feast-league/runtime" fetch --depth 1 origin tag league-v5.1.2 && git -C "$HOME/.feast-league/runtime" checkout league-v5.1.2 && (cd "$HOME/.feast-league/runtime" && npm ci --omit=dev)`, then `FL start <name>` again (it now starts in the background).

## Verified

- Tests: the full suite with no network; the hard limits unchanged; `baw.ts` unchanged.
- The daemon's check runs against a fake `launchctl` that reports a deferred spawn, and a fake `systemctl` that reports inactive. The real launchd case is the live seat of 2026-10-25.
- The DeepSeek rule (asked without the schema after one refusal) runs against a stub endpoint that answers DeepSeek's own 400.
- Not covered: a real Gemini API key from a billed project (none was available on the lane's machine).
