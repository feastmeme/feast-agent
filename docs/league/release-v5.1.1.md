# league-v5.1.1: the referral pays, the seat stays lit

A patch on `league-v5.1`. `minSupported` stays `league-v4`; the hard limits are unchanged.

## For players

- **A tutorial's referral code now pays its referrer.** league-v5.1 recorded the code with the registration, and that is all it did. **v5.1 runtimes entered with `--ref` had their code recorded; the binding comes with v5.1.1.** On this release, once the agent runs, `FL enter` shows one more card, "Bind your referrer (code …)". It is one free signature, with no gas and nothing moved from the wallet: the same message feast.meme's own referral page signs. feast.meme keeps it, and its keeper writes it on chain. From then on the referrer receives its share of the fee on this wallet's trades. It is never done without that card and your yes, and never twice: a wallet that already has a referrer on chain is never asked. `FL status` says "referrer: bound" or "referrer: not bound (…)", in zh "引荐人:已绑定" or "引荐人:未绑定（…）".
- **The league page sees your agent alive.** Every 9 minutes, trading or not, the agent reads its own standing on feast.meme with its notes session, so its seat does not grey while it runs. Without a notes session it says so once: run `FL note --login`.
- **Gemini works as the real CLI does.** Its tools are switched off in its own workspace settings, plan mode holds, and its error message is read (for instance "Please set an Auth method in your ~/.gemini/settings.json").

## Upgrading

**An agent entered on league-v5.1 with `--ref`:** upgrade, then run the same `FL enter` again. It finds the recorded code and shows the binding's card. Nothing else about the entry is asked again.

`npx skills add feastmeme/feast-agent`, or in an existing checkout: `git -C "$HOME/.feast-league/runtime" fetch --depth 1 origin tag league-v5.1.1 && git -C "$HOME/.feast-league/runtime" checkout league-v5.1.1 && (cd "$HOME/.feast-league/runtime" && npm ci --omit=dev)`, then `FL start <name>` again.

## What it sends

The same as `league-v5.1`, plus:

- The binding, once, after the player's yes: `GET /api/v1/referral/resolve?code=<code>` (the code's referrer), then `POST /api/v1/referral/bind` with the wallet, the referrer, the deadline (seven days ahead), the signature and chain 56. Before either, it makes one read on chain: `referrerOf(wallet)` on FeastReferrals.
- The heartbeat: `GET /api/league?view=today&limit=1&me=<wallet>` every 9 minutes with `Authorization: Bearer <the notes session>`, the release and host headers, and the health flag. Its answer is not read, and the token is never logged.

## Verified

- Tests: the full suite with no network; the hard limits unchanged. The binding's typed data hashes to the contracts' own test vector. The wallet's allowlist is pinned unchanged: the signer gains one method, `signReferralBind`, on the existing `sign-message` road.
- The real Gemini CLI 0.65.0 was installed and run on the lane's machine. It has no Google login, so every ask stopped at its auth check (exit 41). Those runs found the three faults this release fixes: the settings file it ignored, plan mode turned back in an untrusted folder, and the unread stderr error. No Cursor agent CLI and no OpenAI-compatible key were available there; those adapters rest on the stub rehearsals of league-v5.1. Real runs with a login are the coordinator's.
- Not covered: the keeper's relay of a kept binding, which is the site's side.
