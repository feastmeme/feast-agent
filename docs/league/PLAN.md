# Feast agent league, v1: plan

Status: **approved on 2026-10-21 with the answers recorded in §12, and built.** It covers the runtime, the hard risk limits, the five presets, the advanced track (script, audit, warm-up), the skill that turns a sentence into one of the two, the test plan, and what is reused from this repository's SDK.

- §9.1 records what the build checked live.
- §9.2 records where the build departs from this text.

Read-only checks behind it, made on 2026-10-21: the Feast indexer's public routes (reachable from here, no auth), BNB Smart Chain public RPC behaviour, read-only MixedQuoter quotes, and the `baw` CLI 1.11.0 command surface. Nothing was signed or sent.

---

## 0. The user journey in one screen

**Ordinary user**

1. `npx skills add feastmeme/feast-agent` installs two skills, `feast-league` and `feast-audit`. The Binance Agentic Wallet skill, which brings the `baw` CLI, is the only other install.
2. They sign in to their Binance Agentic Wallet (pairing code, then a scan in the Binance App) and turn on Developer Mode in the App.
3. They say one sentence, for example: *"Snipe new coins with 0.005 BNB each and cut losses at 25%."*
4. The skill maps it to one preset (new-coin sniper) and its parameters. It asks back only what it cannot default, at most three questions. Then it shows one confirmation card: the preset, the parameters, the hard limits, and the line "this trades real BNB from your wallet". On "yes" it starts the runtime.
5. The runtime runs on the user's machine with no model in the loop. It polls the Feast indexer's event stream, ticks every 15 s to 1 h, and trades through the wallet with `contract-call preview → execute`, one transaction at a time.
6. Later the user can say "status", "make the stop 20%" or "stop". A `STOP` file halts everything.

**Advanced user**

Step 3 differs: *"run my script ./strategy.mjs"*, or *"write me a script that …"*. The skill runs the audit: static rules first, then a model read with a fixed checklist. It shows the verdict, confirms, and starts the script in the **warm-up tier**. The first 5 trades run at 0.001 BNB. The script halts on two consecutive failures or on any hard-limit hit, and the user is notified.

---

## 1. Fixed by the owner (2026-10-21), restated so the plan can be checked against it

- **Two tracks.**
  - Ordinary: five presets with tunable parameters, hard limits in the runtime that cannot be switched off, and one step to real money (no practice stage).
  - Advanced: a free script, then an audit skill (static rules plus a model read), then a warm-up tier. In warm-up the first N trades run at minimum size, and two consecutive failures or any limit hit stops the script and notifies.
- **Cadence.** Event-driven (new coin, price move, trade) plus a tick tunable from 15 s to 1 h. The model runs only when the prompt is written or changed, plus an optional hourly parameter review. It is never in the hot loop.
- **Presets.** ① new-coin sniper, ② momentum, ③ copy the leaderboard's top agents (a configured wallet list until a leaderboard exists), ④ launch-and-run, ⑤ DCA / dip-buy blue chips. Mean reversion is not offered.
- **Signing.** The user's Binance Agentic Wallet through `baw`.
  - Verified live on 2026-10-21: the wallet is a plain EOA, so the Feast hook credits `tx.origin`, which is the wallet.
  - Developer Mode `contract-call preview → execute` against the Universal Router and the FeastFactory passed the risk check with an empty risk list and `requireConfirmation = false`.
  - The wallet's own `market-order swap` refuses brand-new coins. So **launches and new-coin buys go through `contract-call`**.
  - Limits: the session lasts 48 h, Developer Mode has a daily quota that must exceed the balance, and the chain allows one pending transaction at a time.

---

## 2. Runtime architecture

```
 user's agent session (model)              feast-league runtime (no model)                  chain and services
 ────────────────────────────              ───────────────────────────────                  ──────────────────
 feast-league skill:
   sentence → preset + params   ──write──▶ agents/<name>/agent.json
   script  → feast-audit        ──write──▶ agents/<name>/audit/<sha256>.json
   card → explicit "yes"        ──start──▶ runtime (detached process, one per wallet)
                                             │
                                             ├─ event poller ◀────────────────── indexer /v1/events (launch, trade)
                                             ├─ market reader ◀───────────────── indexer /v1/board, /v1/movers, /v1/holders
                                             │                 ◀───────────────── BSC RPC eth_call (slot0, balances, quotes)
                                             ▼
                                        strategy: preset (in process) | script (sandbox)   → intents
                                             ▼
                                        risk guard: hard limits, warm-up                   → approved | refused (named)
                                             ▼
                                        executor, single flight:
                                          SDK calldata → baw preview → gate → baw execute ───▶ BNB Smart Chain
                                          receipt + hook Trade event ◀──────────────────────── BSC RPC
                                             ▼
                                        state.json · log.jsonl · notifications.jsonl · STOP
```

### 2.1 Process and files

- **One runtime per wallet.** The hook credits `tx.origin`, so on the league one wallet is one agent.
  - A second `start` on the same wallet is refused (`wallet.lock`).
  - Several agent configurations may exist, but only one runs at a time.
- **Detached.** `feast-league start --detach` runs the runtime as a detached process, so it outlives the agent session that started it. It runs while the machine is on.
- **Layout.** Everything lives under `FEAST_LEAGUE_HOME`, default `~/.feast-league/`:

| Path | What |
| --- | --- |
| `wallet.lock` | pid of the runtime that owns the wallet |
| `STOP` | global stop file: halts every agent |
| `ledger.json` | wallet-level spend ledger (the budget, L3, counts across agents) |
| `agents/<name>/agent.json` | track; preset and parameters, or script path and sha256; limits; tick; the user's sentence; the confirmed envelope (§2.10) |
| `agents/<name>/state.json` | the book: positions, spend windows, realized PnL, gas, event cursor, warm-up progress, failure streak, pause reason. Written atomically (temp file + rename) after every change |
| `agents/<name>/log.jsonl` | append-only: every decision, intent, refusal (with the limit's id), preview summary, execute result, receipt check, error |
| `agents/<name>/notifications.jsonl` | what the user must see (§2.9) |
| `agents/<name>/inbox/` | requests from the CLI to a running runtime (manual buy/sell, parameter changes) |
| `agents/<name>/STOP` | this agent's stop file |
| `agents/<name>/audit/<sha256>.json` | audit verdicts (advanced track) |

- **The wallet address.** The runtime reads it at start from `baw wallet address --json` (the chain-56 entry) and holds it in memory only.
  - It is never written to any of the files above: logs say `wallet: "self"`, and the receipt check (`payer == wallet`) runs in memory.
  - `status` does not print it unless asked with `--show-address`.

### 2.2 Event sources (checked from this machine on 2026-10-21)

- **There is no client-facing realtime feed.**
  - The indexer's ponder GraphQL is not public, and there is no SSE or WebSocket endpoint.
  - The website itself polls. Its only push is the coin-page chart, which watches the hook's `Trade` logs over BSC RPC directly.
  - **So the runtime polls the indexer.** This is the fallback the brief named, and the plan says so here.
- **Primary event source:** the indexer's event stream, `GET https://indexer.feast.meme/v1/events?types=launch,trade&cursor=<c>&limit=<n>`.
  - Ascending by (block, logIndex), cursor-paged, no auth, 300 requests/min per caller.
  - The poll runs every **2 s** (30 requests/min).
  - The start cursor is the indexer head (`asOf.block`). Without a cursor the stream replays from the chain's start.
  - Status from here: `verdict serving`, 1–2 blocks behind.
- **The 30-second cache.** The indexer caches each exact query for 30 s. During a quiet spell, a poll that repeats the same cursor can hide a new event for up to 30 s.
  - The poller varies `limit` inside its valid range, so consecutive polls are distinct queries and come back fresh. The build verifies that this works.
  - The clean fix is an indexer change: a short TTL at the head, or a push endpoint. That belongs to the indexer, not to this lane (Q6).
- **Normalized events.**
  - `coin.created`: coin, pool id, creator, quote, metadata hash, block, time.
  - `trade`: coin, side, payer, coin amount, quote amount, fee, price after, tx hash.
  - `price.move`: derived from `price after` on trades of watched coins, emitted when a coin has moved at least the threshold since its last evaluation.
- **Depth.** Events carry `depth` (latest or final). Strategies act on latest. Positions are reconciled from the runtime's own receipts, never from the feed.
- **Chain logs, optional, off by default.** The factory's `CoinCreated` and the hook's `Trade` events, with the indexed `payer` topic for copy, are the lowest-latency source. They need an RPC that serves `eth_getLogs`, and the public endpoints refused it today: the Binance dataseed answered "limit exceeded" even for a one-block range, and others rate-limited. A user who supplies such an RPC (`FEAST_MAINNET_RPC_URL`) can turn it on.
- **Market reads on each tick.**
  - `/v1/board`: coins with their market rows (`holders`, `volume24h`, `trades24h`, last price). The board sorts by volume; the runtime sorts by holders itself.
  - `/v1/movers?hours=N`: volume and distinct buyers.
  - `/v1/holders/:coin`: holder `total`.
  - `/v1/coin/:address`.
  - The app's `https://feast.meme/api/v1/pools` is the fallback only. Its rate limit is 60/min, shared across routes.
  - Volumes come in each coin's own quote token, WBNB or a stock token. The runtime converts them to BNB through the stock's price pool before comparing coins.
- **Chain reads, for anything that touches money.** These go to BSC RPC (default `https://bsc-dataseed.binance.org`, overridable):
  - pool spot price (`getSlot0`), balances and allowances
  - the MixedQuoter simulated **as the wallet**, so the hook's opening cap is asked about this wallet
  - receipts

### 2.3 The loop and the tick

- **Main loop: 1 s.** It checks `STOP`, drains the inbox, and hands new events from the poller to the strategy. Ticks are scheduled separately, so a 1-hour tick never delays a stop.
- **Tick.** `tickSeconds` is clamped to [15, 3600] and each preset has its own default (§4). Each tick, in order:
  1. wallet preflight (every 5 min, or after an error)
  2. refresh the market snapshot
  3. runtime exits: the backstop stop-loss, then the preset's exits
  4. `strategy.onTick`
  5. intents
  6. the guard
  7. the executor queue
- **Events.** An event calls `strategy.onEvent` at once, debounced to 1 s per coin. The sniper and copy presets therefore react within one poll: about 2 s plus 1–2 blocks of indexer lag.
- **Priorities.** Exits run before entries, and a sell outranks every queued buy. A buy intent expires (30 s for event-driven, one tick otherwise), so a stale signal never trades.

### 2.4 The strategy interface (shared by presets and scripts)

Every strategy, each of the five presets and any user script, has the same shape:

```js
export const meta = { name: "…", tickSeconds: 60, events: ["coin.created", "trade", "price.move"], watch: ["FEAST"] };
export const params = { /* declared tunables, with defaults */ };
export function onTick(api) { /* read the snapshot, enqueue intents */ }
export function onEvent(api, event) { /* optional */ }
```

| `api` member | What it does |
| --- | --- |
| `api.read.coins({ sort: "new" \| "holders" \| "volume", limit })` | coins with age, holders, 24 h volume in BNB, trades, price in BNB |
| `api.read.coin(coinOrSymbol)` | one coin; fresh chain price for watched coins |
| `api.read.trades(coin, { limit })` | recent trades from the event stream |
| `api.read.positions()`, `api.read.position(coin)` | coins held, cost in BNB, mark in BNB, PnL, opened at, peak |
| `api.read.balance()` | spendable BNB (above the gas reserve) |
| `api.read.limits()`, `api.read.warmup()`, `api.read.now()` | effective limits, warm-up status, the time |
| `api.buy({ coin, bnb, reason })` | enqueue a buy intent |
| `api.sell({ coin, fraction \| coins, reason })` | enqueue a sell intent |
| `api.launch({ name, symbol, quote, description, burn, referrer })` | enqueue a launch intent |
| `api.state` | a JSON object the runtime persists, at most 64 KB |
| `api.params`, `api.log(text)` | parameters; a log line |

- **Synchronous.** Every read comes from a snapshot the runtime prepared before the call. `buy`, `sell` and `launch` only enqueue intents: nothing is ever sent from inside a strategy.
- **Time budget.** `onTick` must return within 1 s and `onEvent` within 250 ms.
- **Where they run.** Presets are trusted modules in the runtime process. Scripts run in a sandbox (§5.2). Intents from both go through the same guard and the same executor.

### 2.5 Execution: from intent to receipt

For one approved intent:

1. **Build the call with the SDK.** These are pure functions with no signer.
   - **Buy.** Universal Router `execute`: `WRAP_ETH` → [`V3_SWAP_EXACT_IN` WBNB → quote, for a stock-paired coin] → `INFI_SWAP[SETTLE, CL_SWAP_EXACT_IN_SINGLE(Feast pool, hookData), TAKE_ALL(coin, minOut)]`. `value` is the BNB. It is byte-identical to the feast.meme site's encoder (checked in tests, §8).
   - **Sell.** `INFI_SWAP[CL_SWAP_EXACT_IN_SINGLE, SETTLE_ALL(coin, via Permit2), TAKE(quote)]` → [`V3_SWAP_EXACT_IN` quote → WBNB] → `UNWRAP_WETH(caller, minOut)`. `value` is 0.
   - **Launch.** `FeastFactory.create(CreateParams)`, after the metadata is pinned through the site's `/api/pin`. This is the existing SDK path.
   - **Claim and buy back (launch-and-run).** `FeastHook.claimCreator(key)` pays the creator in the pool's own quote token. The buyback then pays in that token: `INFI_SWAP[SETTLE(quote, amount, payer = caller via Permit2), CL_SWAP_EXACT_IN_SINGLE, TAKE_ALL(coin)]`, the site's "paid in the quote" path. No conversion and no unwrap are needed. (`claimAsBnb` would deliver WBNB as an ERC-20 anyway, not native BNB.)
   - **Arm.** Once per token, after its first buy, the runtime sends `token.approve(Permit2, max)` and `Permit2.approve(token, router, max160, now + 30 days)`. When an exit is needed, it is then a single transaction.
   - **`minOut`.** A fresh MixedQuoter quote simulated as the wallet, times (1 − slippage).
   - **Deadline.** Chain time + **5 minutes**, not the site's 30. A delayed signal must not fill.
2. **Check before preview.** `STOP` is absent, and `baw wallet tx-lock --binanceChainId 56` reports `UNLOCKED`.
3. **Preview.** `baw contract-call preview --binanceChainId 56 --from <wallet> --to <to> --value <wei> --inputData <hex> --json`.
4. **The gate.** Execute only if every item holds:
   - `success` is true and there is a `requestId`
   - `simulationCode` is `"000000000"` with no error detail
   - `risks.riskDetails` is empty, and no address in `risks.addresses` carries risk
   - `requireConfirmation` is false
   - `expiresAt` is in the future
   - the target is on the allowlist: Universal Router, FeastFactory, FeastHook, Permit2, or a factory-made coin or a pool's quote token (the last two for `approve(Permit2)` only)
   - the selector is one the runtime builds
   - the native value equals the intent's
   
   Anything else fails the intent and logs the preview's own words. Nothing is executed.
5. **Check `STOP` again.** A stop that arrives between preview and execute wins.
6. **Execute.** `baw contract-call execute --requestId <id> --json` should return `BROADCASTED` with a `txHash`. If it returns `PENDING_CONFIRMATION` instead, the runtime sends nothing further, notifies "approve or reject it in the Binance App", and counts a failure.
7. **The receipt (BSC RPC, 120 s timeout).**
   - Status must be success.
   - The fills are the hook's `Trade` events, emitted by the hook address, with `payer == wallet` and `coin` equal to the intended coin, summed over the receipt.
   - The native leg comes from WBNB's `Deposit` / `Withdrawal` by the router.
   - A launch is the factory's `CoinCreated` with `creator == wallet`.
   - Any mismatch is a failure and pauses the agent.
8. **Book update.** Positions, cost basis, spend windows, realized PnL and gas are updated, then a log line and any notification are written.

**Route.** In v1 every action goes through `contract-call`.

- Launches and new-coin buys must use it anyway.
- One route keeps one gate and one receipt check.
- The wallet's `market-order swap` (which has MEV protection) for established coins is an option for the DCA preset only (Q4).

### 2.6 The one-pending-transaction rule

- **In the process.** The executor is single-flight: the next intent waits until the previous receipt is final or the intent has failed.
- **On the machine.** `wallet.lock` allows one runtime per wallet. Manual `feast-league buy` / `sell` either go through the running runtime's inbox or, when none is running, take the lock themselves.
- **Against the wallet.** `wallet tx-lock` must report `UNLOCKED` before every preview.
  - If it reports `LOCKED`, the executor waits (polling every 3 s, up to 60 s). This happens when a transaction was sent from elsewhere, such as the user's phone, or when an App confirmation is pending.
  - If it is still locked, the intent is dropped with "wallet busy".
- **A stuck transaction.** If a receipt is still missing after 120 s, the runtime stops sending, notifies, and re-checks on every tick. It never speeds up or cancels a transaction; that is the user's call.

### 2.7 The stop file

- **Where.** `agents/<name>/STOP`, or the global `$FEAST_LEAGUE_HOME/STOP`.
- **When it is checked.** At the top of every 1 s loop, before every preview, between preview and execute, and before every arm step.
- **What happens when it is there.**
  - No new preview or execute is made.
  - A transaction already broadcast is waited for and recorded (at most 120 s).
  - State is written, `halted` is logged, the user is notified, and the process exits 0.
- **Who writes and removes it.**
  - The runtime never deletes `STOP`.
  - `feast-league stop` writes it and waits for the process to exit.
  - `feast-league resume` removes it and starts again, and only on the user's word.
  - The runtime writes `STOP` itself, with the reason inside, when a rule halts it: a warm-up stop, the drawdown halt, or a receipt mismatch.

### 2.8 Wallet preflight (`baw`)

- **Checked at start and every 5 minutes:**
  - `wallet status` is `CONNECTED`.
  - `wallet settings`: `devMode.enabled` and `devMode.expiresAt`; quota left (`devMode.dailyLimit − developerModeQuotaUsed`); `devMode.balanceExceeded`; `sessionExpireTime`; `inactiveSignOutTime`.
- **New actions are refused when:**
  - the wallet is not connected
  - Developer Mode is off or has expired
  - the balance exceeds the Developer Mode quota (then even exits cannot be sent, so this is notified loudly)
  - an action's dollar value exceeds the quota left (BNB's price comes from the USDT/WBNB pool)
- **Notifications** go out when the session expires in under 6 h and again under 1 h, and when Developer Mode expires in under 24 h.
- **On sign-out** the runtime pauses (it does not stop) and resumes on its own when status is `CONNECTED` again.
- **The runtime's `baw` surface is an allowlist** checked in code:
  - `wallet status | address | settings | tx-lock | balance`
  - `contract-call preview | execute`
  - only if Q4 says yes: `market-order quote | swap | list`
  
  It never calls `wallet send` or `approvals revoke`, or anything else. It never changes wallet settings, and it cannot: they are App-only.

### 2.9 Notifications

- **Channels.**
  - every notification is appended to `notifications.jsonl`
  - one line goes to stderr
  - optionally, a user-chosen command `FEAST_LEAGUE_NOTIFY` receives the JSON on stdin
- **Kinds:** started, trade, refused (with the limit's id), paused, halted, warm-up stop, session expiring, Developer Mode expiring, failure, review change.
- **Where the user sees them.** `feast-league status` shows unread notifications first, and the skill shows them whenever the user next talks to their agent.

### 2.10 Where the model is, and where it is not

- **When the prompt is written or changed,** the skill translates it (§6).
- **The optional hourly review** is scheduled by the user's agent with its own scheduler.
  - It reads `feast-league review --json`: the last hour's trades, PnL, refusals and market notes.
  - It may change preset parameters, but only **inside the envelope the user confirmed**. It may tighten anything and retune thresholds. It may not raise a size, budget or limit above the confirmed value, and `feast-league set` enforces this.
  - Every change is logged and notified.
- **Never in the loop.** The loop never calls a model. We never call a model ourselves, and we never handle anyone's model credentials.

---

## 3. Hard risk limits

**Rules for every limit:**

- **Where it applies.** In the runtime, to every intent from every strategy: presets, scripts, and manual `feast-league buy` / `sell`.
- **What the user can change.** Any limit can be tightened. It can be loosened only up to its ceiling, and it cannot be switched off: config validation refuses 0, negative, empty, NaN and Infinity.
- **Refusals.** A refused intent is logged with the limit's id. It is never retried silently and never resized silently. The only resize is the warm-up's documented forcing (§5.4).

| Id | Limit | Default | User range | On hit |
| --- | --- | --- | --- | --- |
| L1 | Size of one trade | 0.02 BNB | 0.001 – 0.25 | that intent refused |
| L2 | BNB spent on buys in any 24 h | 0.1 BNB | L1 – 1 | buys refused until the window frees room |
| L3 | Budget: BNB the league may ever put in from this wallet (gross, all agents) | 0.25 BNB | L2 – 10 | buys refused; "budget used" notified |
| L4 | Open exposure (cost basis of open positions) | 0.1 BNB | L1 – 2 | buys refused |
| L5 | Open positions | 5 | 1 – 20 | buys refused |
| L6 | Backstop stop-loss: mark ≤ entry × (1 − x) | 50 % | 5 – 90 % | the runtime sells the position, whatever the strategy says (not the agent's own launch: Q3) |
| L7 | Realized loss in any 24 h | 0.05 BNB | 0.001 – 0.5 | entries paused 24 h; notified |
| L8 | Drawdown from the agent's peak equity (realized + unrealized PnL) | 0.1 BNB | 0.001 – L3 | agent halts (`STOP` written); notified |
| L9 | Slippage bound on a trade | 10 % | 0.1 – 20 % | intent refused if the strategy asks for more |
| L10 | Price impact of a buy (quote against spot) | 8 % | 0.5 – 25 % | buy refused |
| L11 | Gas reserve: BNB never spent | 0.003 BNB | 0.001 – 0.1 | intent refused |
| L12 | Trades per hour | 12 | 1 – 60 | intent refused |
| L13 | Cooldown between entries into one coin | 60 s | 15 – 3600 s | buy refused |
| L14 | Consecutive failures | 3 | 2 – 10 | agent paused; notified (warm-up: 2, then stop) |
| L15 | Feast only: the coin is factory-made (`getCoin`) or FEAST; target and selector on the allowlist (§2.5) | always on | not configurable | intent refused |
| L16 | Wallet state: connected, Developer Mode on, quota left ≥ value, `tx-lock` unlocked, no stop file | always on | not configurable | intent refused, or agent paused |

**Notes on individual limits:**

- **L3 (budget).** Buybacks in the launch-and-run preset are paid with claimed creator fees, not with the wallet's BNB. They count toward L1 and L2 but not toward L3.
- **Evaluation order.** L16 → L15 → L11 → L1 → L9 → L10 → L5 → L4 → L2 → L3 → L12 → L13 → L7 (pause state) → warm-up forcing. The first refusal wins and is the one logged.
- **Units.** Limits are in BNB. The trade's dollar value is used only for the Developer Mode quota check (L16).
- **This lane's own live tests** run with L1 = 0.005 BNB, L2 = 0.03 and L3 = 0.03. L3 is wallet-level, so the 0.03 cap holds across both demonstrations.

---

## 4. The five presets

**Shared across presets:**

- Every size parameter is bounded by L1, every stop-loss by L6, and every slippage by L9.
- "Mark" is the position's value in BNB at the pool's spot price, through the quote's price pool for stock-paired coins.
- "Entry" is the BNB actually paid, divided by the coins actually received, both read from the receipt.

### ① `sniper`: new-coin sniper

Buys a coin within seconds of its launch, in small size, then exits by a hard stop-loss, a take-profit or a time stop.

- Fires on `coin.created`. Tick 15 s (exits). Exits also run on every trade event of a held coin.
- The hook caps each wallet's buy at 0.5 % of supply in a pool's first two traded blocks. Quoting as the wallet exposes the cap; a capped buy is skipped, not retried.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `buyBnb` | 0.005 | 0.001 – L1 | size of each snipe |
| `maxAgeSeconds` | 90 | 10 – 900 | only coins launched less than this long ago |
| `quotes` | all | WBNB and listed stock tokens | which pairs to snipe |
| `requireMetadata` | true | true / false | skip coins launched without metadata (zero hash) |
| `maxCreatorLaunches24h` | 3 | 1 – 50 | skip creators who launched more than this in 24 h |
| `snipesPerHour` | 3 | 1 – 20 | at most this many entries per hour |
| `slippagePct` | 8 | 1 – L9 | |
| `stopLossPct` | 25 | 5 – L6 | hard stop: sell all at mark ≤ entry × 0.75 |
| `takeProfitPct` | 100 | 10 – 1000 | sell `takeProfitSellPct` at mark ≥ entry × 2 |
| `takeProfitSellPct` | 100 | 10 – 100 | |
| `timeStopMinutes` | 30 | 1 – 1440 | sell what is left after this long |

### ② `momentum`

Enters coins whose volume and holder count are growing, and exits when that is exhausted.

- Tick 60 s.
- Events: `trade` on held coins (exits) and `price.move`.
- Data:
  - holder counts are snapshotted each tick (`/v1/holders`, or the board's `holders`)
  - volume and buyers come from the event stream plus `/v1/movers`

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `lookbackMinutes` | 15 | 5 – 240 | the entry window |
| `minVolumeBnb` | 0.5 | 0.01 – 100 | volume in the window, in BNB |
| `minNewHolders` | 10 | 1 – 1000 | holder-count growth in the window |
| `minPriceChangePct` | 10 | 0 – 500 | price rise in the window |
| `minAgeMinutes` | 10 | 0 – 10080 | skip a coin's first minutes |
| `maxAgeHours` | 72 | 1 – 720 | |
| `buyBnb` | 0.01 | 0.001 – L1 | |
| `maxPositions` | 3 | 1 – L5 | |
| `exhaustionWindowMinutes` | 5 | 1 – 60 | |
| `exhaustionRatio` | 0.3 | 0.05 – 1 | exit when the volume rate in the last window falls below this × the entry window's rate |
| `trailingStopPct` | 15 | 3 – 50 | exit when the mark falls this far below its peak since entry |
| `stopLossPct` | 20 | 5 – L6 | |
| `timeStopHours` | 24 | 1 – 168 | |
| `slippagePct` | 3 | 0.1 – L9 | |

### ③ `copy`: follow the top agents' buys

- Until a league leaderboard API exists, it follows a configured wallet list, as the owner ruled. Switching the source to the leaderboard is a parameter for later.
- It watches the event stream's trades and filters them by payer itself, because the stream has no per-wallet filter.
- The hook's payer is `tx.origin`. A leader trading through a smart account therefore appears as its bundler, and the skill says so.
- Tick 15 s.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `source` | `wallets` | `wallets` (`leaderboard` later) | |
| `wallets` | asked | 1 – 20 addresses | whom to follow |
| `topN` | 5 | 1 – 20 | leaderboard source only |
| `delaySeconds` | 5 | 0 – 600 | wait before copying |
| `sizeMode` | `fixed` | `fixed` / `proportional` | |
| `buyBnb` | 0.005 | 0.001 – L1 | fixed size |
| `proportionalPct` | 10 | 1 – 100 | share of the leader's BNB size, capped by L1 |
| `minLeaderBuyBnb` | 0.01 | 0 – 10 | ignore leader buys smaller than this (bait) |
| `maxChasePct` | 10 | 0 – 100 | skip if the price has risen more than this since the leader's fill |
| `copySells` | true | true / false | when a leader sells a copied coin, sell the same fraction |
| `stopLossPct` | 30 | 5 – L6 | |
| `timeStopHours` | 48 | 1 – 720 | |
| `slippagePct` | 5 | 0.1 – L9 | |

### ④ `launch`: launch-and-run

Launches one coin themed by the prompt, holds an opening buy, and buys the coin back on a schedule with the creator's fee share.

- **Launch.** The existing SDK path: pin the picture and the metadata, `predictCoin`, `createParams` (the site's algorithm), then `create`. No pre-buy: a pre-buy needs the quote token and a 7-day vest, so the opening buy is a normal buy right after the launch.
- **Buyback cycle.**
  1. Read `claimable(key, wallet)`.
  2. If it is above `minClaimBnb` (converted to BNB), send `claimCreator(key)`.
  3. Arm the quote token once: `approve(Permit2)` and a Permit2 allowance.
  4. Buy the coin paying in the quote (§2.5).
- **Exits.** None on the agent's own coin: it never sells its own launch on its own initiative (Q3).
- Tick 300 s.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `name`, `symbol`, `description` | from the prompt | name ≤ 32 chars; ticker 1–10 letters or digits | confirmed on the card |
| `image` | generated | a file path, or generated | |
| `quote` | WBNB | WBNB or a listed stock token | the pair |
| `burnPoints` | 20 | 0 – 30 | points of the 1 % fee bought back and burned |
| `referrerPoints` | 10 | 0 – 30 | points for referrers; the creator keeps the rest of 80 |
| `openingBuyBnb` | 0.005 | 0 – L1 | bought right after the launch and held |
| `buybackEveryMinutes` | 60 | 15 – 1440 | |
| `minClaimBnb` | 0.0005 | 0 – 1 | skip smaller claims (gas) |
| `buybackPct` | 100 | 0 – 100 | share of each claim spent on the buyback |

### ⑤ `dca`: DCA / dip-buy blue chips

The low-risk entry: one target bought on a schedule, with an extra buy on a dip.

- The target is FEAST, or the N coins with the most holders (re-read daily from the board).
- Tick 3600 s. `price.move` events trigger the dip buys.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `targets` | `FEAST` | `FEAST` / `topHolders` | |
| `topN` | 3 | 1 – 10 | `topHolders` only |
| `buyOnStart` | true | true / false | first buy as soon as it starts |
| `everyMinutes` | 1440 | 60 – 10080 | |
| `buyBnb` | 0.005 | 0.001 – L1 | |
| `dipPct` | 15 | 0 – 80 | extra buy when mark ≤ 24 h high × (1 − dip); 0 turns dip buys off |
| `dipBuyBnb` | 0.005 | 0.001 – L1 | |
| `maxBuysPerDay` | 2 | 1 – 24 | |
| `takeProfitPct` | off | off, or 10 – 1000 | DCA holds by default |
| `slippagePct` | 1 | 0.1 – L9 | |

---

## 5. The advanced track

### 5.1 The script interface

- **What a script is.** One ES module file in the shape of §2.4, with no imports.
- **What it can call.** It gets the runtime's functions and nothing else: `api.buy`, `api.sell`, `api.launch`, `api.read.*`, `api.state`, `api.params` and `api.log`.
- **What it ships with.** `skills/feast-league/references/script-api.md` documents the interface with types and two examples. That is what the user's own AI writes against.

### 5.2 The sandbox: defense in depth behind the audit

- **A child process.** The script runs under `node --permission --allow-fs-read=<harness>,<script> --disallow-code-generation-from-strings --max-old-space-size=128 harness.mjs`. That means:
  - no file writes, and no reading anything but the harness and the script
  - no child processes, so no `baw`
  - no workers and no addons
  - no secrets held in the process
- **A vm context inside it.**
  - Code generation from strings and wasm are disabled.
  - There is no `process`, no `fetch` and no timers.
  - The module is linked with no imports, so any `import` fails to link.
- **The only channel is IPC with the runtime.** The snapshot goes in and intents come out. The runtime guards every intent exactly as it guards a preset's.
- **A time budget per call.** `onTick` gets 1 s and `onEvent` 250 ms, enforced by the vm timeout. An overrun kills the call and counts as a failure.
- Node 24's permission model has no network switch. The vm context with no network globals, plus the audit rule A3, covers network access.

### 5.3 The audit skill (`feast-audit`)

**Two stages, keyed by hash.** Both stages must pass for this exact file, keyed by its sha256. Any edit means a new audit and a new warm-up. The runtime refuses to start a script without both passes on record.

**Static rules.** These are deterministic code (`feast-league audit <file>`). They walk the syntax tree (acorn); string literals and simple concatenations are folded before matching, so `"ba" + "w"` counts as `baw`.

| Id | Rule | Refuses, for example |
| --- | --- | --- |
| A1 | No direct wallet or process access | `baw` anywhere (code or strings); `child_process`, `exec`, `spawn`, `fork`, `process`, `worker_threads`, `Deno`, `Bun` |
| A2 | No imports of any kind | `import … from`, `export … from`, `import()`, `require`, `import.meta` |
| A3 | No network beyond our endpoints | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `net`, `http`, `https`, `dgram`, `tls`, `dns`; URL literals other than feast.meme and indexer.feast.meme (and those are pointless: data comes through `api.read`) |
| A4 | No secrets | private-key-shaped hex (0x + 64 hex), seed-phrase-shaped word runs, API-key prefixes, `.env`, key-file paths, `PRIVATE_KEY` |
| A5 | No dynamic code, no reaching for globals | `eval`, `Function`, `new Function`, string timers, `vm`, `WebAssembly`, `globalThis`, `global`, `self`, `window`, `constructor`, `prototype`, `__proto__`, `Reflect`, `with` |
| A6 | Bounded loops, no timers | `while`, `do … while`, `for (;;)`, a `for` whose bound is not a numeric literal ≤ 1000, recursion (a function that calls itself), `setInterval`, `setTimeout`, `setImmediate`, `queueMicrotask` |
| A7 | Shape | exports other than `meta`, `params`, `onTick`, `onEvent`; `meta.tickSeconds` outside 15–3600; top-level statements other than declarations; over 64 KB; non-ASCII identifiers |
| A8 | Only the runtime's functions | any `api` member other than `buy`, `sell`, `launch`, `read.*`, `state`, `params`, `log`; computed access on `api` |
| A9 | Sizes (warning only) | literal sizes above the user's L1; the runtime refuses those trades anyway |

**Model read.** The user's own agent reads the script and follows `skills/feast-audit/references/checklist.md`. We never call a model.

| Id | Question the reader must answer in writing |
| --- | --- |
| M1 | Intent: does the script do what the user asked? Two sentences. |
| M2 | Frequency: what are the worst-case trades per hour and per day? Is there a path that buys on every tick? |
| M3 | Exits: does every entry have a way out? (The runtime's backstop applies anyway.) |
| M4 | Units: BNB vs wei vs coin units, price direction, division by zero. |
| M5 | Obfuscation and misdirection: encoded strings, character codes, names or comments that disagree with the code. |
| M6 | Scope: only Feast coins? Launches: how many, and are the names offensive or impersonating? |
| M7 | State: does `api.state` stay bounded? |
| M8 | Anything the static rules could miss. |

**The verdict.** `pass` or `refuse` with reasons, recorded with `feast-league audit <file> --model-verdict pass|refuse --notes "…"` in `audit/<sha256>.json` next to the static result.

### 5.4 The warm-up tier

- **N = 5.** A newly audited script hash runs its first five trades (buys or sells) at the minimum size.
  - Buys run at **0.001 BNB**, or at L1 if L1 is lower.
  - A sell sells the whole warm-up position.
  - At most one launch is allowed during warm-up, with no opening buy above 0.001 BNB.
- **Stop rule.** The runtime halts the script when either happens:
  - two consecutive failures: preview refused, simulation failed, a revert, a receipt mismatch, a timeout, or the script throwing or overrunning
  - any hard-limit hit: an intent refused under §3
  
  It writes `STOP` with the reason and notifies. A re-audit or the user's explicit `resume` is needed to go on.
- **Graduation.** After five clean trades the script trades at its requested sizes, still within §3. From then on a limit hit refuses that trade, and L14 (three consecutive failures) pauses the agent.
- **Reset.** Any change to the file resets the warm-up.

---

## 6. The skill: a sentence becomes a preset or a script

**Layout and install**

- **Layout.** `skills/feast-league/SKILL.md` with `references/` (`presets.md`, `limits.md`, `script-api.md`, `confirm-card.md`, `setup.md`), and `skills/feast-audit/SKILL.md` with `references/checklist.md`.
- **Install.** `npx skills add feastmeme/feast-agent` discovers both under `skills/`. The build verifies this layout.
- **Host compatibility.** The skills use only shell commands and files, so they run unchanged in both target hosts (Claude Code and Codex). Nothing in them is host-specific.
- **The runtime.**
  - If `feast-league doctor` is missing, the skill installs this repository at a pinned tag into `~/.feast-league/runtime` (`git clone` + `npm ci`). There the user can read every line that will trade for them (Q1).
  - The skill calls it as `node ~/.feast-league/runtime/src/league/bin.mjs …`. `FEAST_LEAGUE_RUNTIME` points it at a checkout instead, which is how this lane's demonstrations run it.

**The contract the skill follows**

1. **Preflight, every session.**
   - Runtime present.
   - `baw wallet status` is `CONNECTED`; otherwise guide the sign-in through the Binance Agentic Wallet skill.
   - `baw wallet settings`: Developer Mode is on (otherwise: "turn it on in the Binance App; it can't be done from here"), and the balance is below the Developer Mode quota.
   - The BNB balance covers the smallest trade plus the gas reserve.
   - Unread notifications are shown first.
2. **Classify the sentence.**

| Kind | What it looks like | What the skill does |
| --- | --- | --- |
| ordinary | the sentence fits a preset | step 3 |
| advanced | a script path, code, or "write me a script" | step 6 |
| change | "make the stop 20 %" | `feast-league set` |
| control | status, stop, resume | the CLI command |
| out of scope | mean reversion ("not offered as a preset"), non-Feast tokens, leverage, withdrawals | say so; offer the closest preset or the advanced track |

3. **Ordinary: one preset.**
   - Exactly one preset is chosen.
   - Parameters come from the sentence, and everything else takes its default.
   - Everything is validated against the preset's ranges and the hard limits: `feast-league plan --preset <p> --set k=v … --card`.
4. **Ask back only what cannot be defaulted.** At most three questions, in one message, each with a proposed answer.
   - **No size in the sentence.** Propose the defaults once: "0.005 BNB a trade, at most 0.1 BNB a day: ok?"
   - **Copy.** Which wallets to follow (required).
   - **Launch.** The name, ticker and one-line theme (proposed from the prompt), and the pair.
   - **DCA.** Which coin, if not FEAST; how often, if not daily.
   - **A number outside its range.** The nearest allowed value is proposed, never applied silently.
5. **Confirm with one card.** `feast-league plan … --card` prints it. The card shows:
   - the preset, and what it will do, in one sentence
   - the parameters table, each marked "from your sentence" or "default"
   - the hard-limits table
   - the cadence
   - the signing method: Binance Agentic Wallet, Developer Mode contract calls, one transaction at a time
   - the worst case: trades a day, and BNB a day
   - **"This trades real BNB from your wallet as soon as you say yes. There is no practice mode."**
   - how to stop
   
   It starts only on an explicit yes ("yes", "start", "confirm"). Anything else is a no.
6. **Advanced.**
   1. The script goes to `feast-audit`. On a static refusal, every rule hit is shown with its line number; the skill offers to fix it (if the agent wrote it) and re-audits.
   2. On a static pass, the agent does the model read against the checklist, and the verdict is recorded.
   3. The card: a summary of the script, and the warm-up spelled out ("5 trades at 0.001 BNB; it stops on 2 failures in a row or on any limit hit").
   4. Explicit yes, then start.
   
   "Write me a script" is allowed: the agent drafts it against `script-api.md`, and it is audited like any other script. Code the agent wrote gets no exemption.
7. **After start.**
   - Show `feast-league status`.
   - Offer the optional hourly review, with the envelope rule (§2.10).
   - Changes go through `feast-league set`, which validates them, with a one-line confirmation.
   - Stopping is `feast-league stop`.
8. **Never:**
   - call `baw contract-call`, `market-order swap` or `wallet send` itself for league trades
   - edit `state.json`
   - write or remove `STOP` except through the CLI
   - handle the user's model or exchange credentials
   - promise or claim profits

---

## 7. What is reused from this repository's SDK

| | What |
| --- | --- |
| **Kept as is** | `networks.ts` (mainnet contracts and every stock token's v3 hops); `abi.ts` (factory, hook, coin); `launch-params.ts` (`createParams`, the site's algorithm); `metadata.ts` (`/api/pin`); `price.ts`; `split.ts`; `predict.ts`; `errors.ts` (refusal decoding, the venue's `WrappedError`); the `FeastClient` reads (`coin`, `quotes`, `predictCoin`, `poolInfo`, `referrerOf`, `bnbUsdPrice`, `stockUsdPrice`, balances); `receipts.creationsOf` |
| **Extended** | `abi.ts`: Universal Router, Permit2, MixedQuoter, WBNB events, hook claims. `errors.ts`: the router's and quoter's errors (`ExecutionFailed`, `TransactionDeadlinePassed`, unwrapping `UnexpectedRevertBytes`). `networks.ts`: the FEAST pool id. `receipts.ts`: the hook's `Trade` fills and WBNB legs, bound to the hook, the router and the payer |
| **New in the SDK** | `infinity.ts`: pure calldata builders for buy and sell (with v3 hops), buy paid in the quote, `approve`, `Permit2.approve`, `claimCreator`; byte-checked against the site's encoder. `quoter.ts`: MixedQuoter quotes simulated as the wallet |
| **Not used by the league** | `FeastClient.buy` / `sell` / `launch` sign with a private key, through the sandbox router, and refuse mainnet. They stay as they are for the sandbox demo, MCP server and CLI. The league never holds a key: it builds calldata with the SDK and signs only through `baw`, behind the runtime's guard |
| **New package code** | `src/league/` (runtime, guard, executor, `baw` signer, events, market snapshot, presets, sandbox, audit, CLI); `skills/` (the two skills); `examples/scripts/`; a `feast-league` bin; one new dependency (`acorn`, for the audit's syntax tree) |

---

## 8. Test plan

### 8.1 Offline tests, red first

| File | What it holds |
| --- | --- |
| `risk.test.ts` | every limit below, at and above its value; each one refused when switched off (0, negative, NaN, Infinity, missing); ceilings; rolling windows; evaluation order; first refusal named |
| `warmup.test.ts` | forced sizes, the counter, the stop on two failures and on any limit hit, reset on a hash change |
| `audit.test.ts` | for every rule, a refusing fixture and a passing one; an obfuscation set (`"ba"+"w"`, `globalThis["pro"+"cess"]`, `this.constructor.constructor`, `import("child_"+"process")`, `while(true)`, recursion, timers, key-shaped hex); `examples/scripts/calls-baw.mjs` refused |
| `infinity.test.ts` | buy and sell calldata byte-equal to the site's encoder for FEAST (WBNB pool, no hops) and for a stock-paired coin with hops; the buy equal to the probe tool's recorded sample |
| `baw.test.ts` | recorded `baw` JSON shapes parsed; the gate's refusals (risk listed, confirmation required, simulation failed, preview expired); the command allowlist; `tx-lock` waits |
| `executor.test.ts` | with a fake signer: preview → execute → receipt → book. A `STOP` between preview and execute means no execute. A receipt for another payer or coin means a failure and a pause |
| `presets/*.test.ts` | each preset's decisions over synthetic snapshots |
| `sandbox.test.ts` | a script cannot read a file, spawn a process, fetch, or eval; overruns are killed |
| `events.test.ts` | cursor paging, cache-aware polling, normalization |
| CLI | `plan --card` validation and the card's contents |

### 8.2 Read-only and preview-only checks, before any trade

These send nothing. A preview creates no transaction.

- **The indexer.** The head cursor for `/v1/events`, and freshness of the polls against the 30 s cache.
- **MixedQuoter sell quotes on a brand-new coin.** The live test saw `0x6190b2b0`, which is the quoter's `UnexpectedRevertBytes(bytes)` wrapping an inner refusal. FEAST quotes fine both ways today. The build decodes the inner revert. If it cannot be avoided, the fallback is to compute the Feast leg from the pool's own liquidity (one position), take the hops from the v3 quote, and let the preview's simulation re-check the result.
- **`contract-call preview` with no execute,** through the runtime's own signer (`feast-league preview …`), for each call shape: `approve(Permit2)`, `Permit2.approve`, a sell, `claimCreator`, `create`. Each preview's risk list and `requireConfirmation` are recorded. Approvals are the call shapes not yet seen live.

### 8.3 The live demonstrations

They run on this machine with the test wallet and the lane caps (0.005 BNB a trade, 0.03 BNB in all). `FEAST_LEAGUE_HOME` is under `.runs/league/home/`, which is git-ignored. Evidence goes under `.runs/league/`: transcripts, the agent configs, logs and tx hashes, with no wallet address in any of them.

**A. Ordinary track: one sentence, a preset, a real trade.**

- **The sentence:** *"Buy FEAST with 0.002 BNB now and every day after, and buy another 0.002 if it dips 15 %."*
- **The run.**
  1. Following `SKILL.md`, this session acts as the user's agent and translates the sentence into `dca` with targets FEAST, `buyBnb` 0.002, `everyMinutes` 1440, `dipPct` 15, `dipBuyBnb` 0.002 and `buyOnStart` true, under the lane limits.
  2. The card is shown and the yes is recorded.
  3. `start`, then the first buy: preview, gate, execute.
- **Pass:**
  - the transaction is mined with status success
  - the hook's `Trade` has payer equal to the wallet (checked in memory, logged as `payerIsWallet: true`), coin FEAST, side buy and 0.002 BNB in
  - the position is in `state.json`
  - the spend is in the ledger

**B. Advanced track: a small script, the audit, warm-up, a real trade.**

- **The script:** `examples/scripts/round-trip.mjs`. It asks to buy FEAST for 0.002 BNB, then sells it two minutes later.
- **The run.**
  1. The static audit passes.
  2. The model read (this session, following the checklist) is recorded.
  3. `start`. The warm-up forces the buy to 0.001 BNB, and the log shows `warm-up: 0.002 → 0.001`.
  4. The buy is mined.
  5. The exit is armed (`approve`, then `Permit2.approve`, both mined).
  6. The sell is mined.
- **Pass:**
  - both `Trade` events have payer equal to the wallet
  - BNB came back on the sell
  - the warm-up counter is at 2 of 5
- This also proves the exit path that every stop-loss depends on, which has not yet been run live (Q5).

**C. A trade over the per-trade cap is refused.** `feast-league buy FEAST 0.006` with L1 = 0.005.

- Pass: refused as L1 before any `baw` call. The signer logs every invocation it makes, and its log has none for this intent.

**D. The stop file halts the loop.** A running agent (A's, idle after its buy); then `STOP` is written.

- Pass:
  - `halted` is logged within 2 s
  - no preview after the stop
  - the process has exited and the wallet lock is released

**E. The audit refuses a script that calls `baw` directly.** `examples/scripts/calls-baw.mjs` imports `child_process` and runs `baw contract-call …`.

- Pass:
  - the static audit refuses it under A1 and A2, with line numbers
  - `start` refuses it ("no passing audit for this file")

**Budget.** About 0.003 BNB gross: A's 0.002, B's 0.001, and gas for about five transactions (under 0.0005 BNB at today's gas prices). The lane's cap is 0.03.

---

## 9. Risks and unknowns

| Risk | Mitigation |
| --- | --- |
| No realtime feed; the indexer caches answers for 30 s | 2 s cache-aware polling (verified in build); ask for an indexer change (Q6); optional chain logs with the user's own RPC |
| Sell quotes for brand-new coins revert in the MixedQuoter | decode the inner refusal; fallback pool-math quote; the preview's simulation re-checks (§8.2) |
| Binance's risk scoring of approvals and Permit2 calls is unverified | preview-only checks first; fallback: the site's EIP-712 Permit2 signature through `sign-message` |
| MEV: the mempool route of a `contract-call` is unknown | tight slippage per preset, a 5-minute deadline, quote-vs-spot impact limit (L10) |
| The session (48 h), Developer Mode expiry, and the balance having to stay below the quota | preflight every 5 minutes; notifications ahead of expiry; the runtime pauses and never works around them |
| One pending transaction: a burst of signals queues | exits first, buy intents expire, about one transaction every few seconds |
| The public RPC is slow or refuses | retries with backoff; `FEAST_MAINNET_RPC_URL` |
| The leaderboard copy needs does not exist | the wallet list, as ruled; `source: leaderboard` later |
| Attribution assumes the wallet is a plain EOA | verified live 2026-10-21; the receipt check (payer = wallet) fails loudly if that ever changes |
| Developer Mode quota accounting for sells is unknown | read `developerModeQuotaUsed` after each transaction and learn it; never let it block exits silently (notify) |

### 9.1 Checked live during the build (2026-10-21)

Every row went through the runtime's own signer on this machine, with the test wallet.

- **Preview-only rows** sent nothing.
- **Signing.** `sign-message execute` is not on the signer's allowlist, so nothing could be signed.

| Check | Result |
| --- | --- |
| The indexer's `/v1/events` cursor and cache | A constructed head cursor is accepted and exclusive. A repeated query returned the cached page (the same `wallClock`); another `limit` came back fresh. The cache-aware poller works |
| `eth_getLogs` on public BNB Smart Chain RPCs | refused: the dataseed answers "limit exceeded" even for one block, and publicnode rate-limits. Chain logs stay optional (§2.2) |
| Preview of a buy through the Universal Router | clean: simulation `000000000`, empty risk list, `requireConfirmation: false` |
| Preview of `approve(Permit2, max)` on a coin | clean. The unlimited approval is not flagged |
| Preview of `Permit2.approve(coin, router, max160, +30 days)` | clean |
| Preview of a sale before the coin is armed | refused by the wallet: `351805` "Transaction simulation failed: execution reverted". The gate refused it, as it must |
| A sale after arming (demonstration B) | clean preview, executed, and the hook's `Trade` was paid by the wallet. The sale was quoted by the MixedQuoter, not the spot fallback |
| Preview of `claimCreator` on a coin the wallet launched | clean |
| Preview of `create` (no metadata) | clean |
| **The league registration (task 927):** `sign-message preview` of EIP-712 typed data with domain `{ name: "Feast League", version: "1", chainId: 56 }` and **no `verifyingContract`**, primary type `Register(address wallet, string name, string strategy, address copies, uint256 issuedAt)` | **Accepted:** a request id, `parsedMessage` of type `SignTypedData` V4 with an empty `preCheckCode`, empty risk lists, `requireConfirmation: false`. Previewed only, never signed |
| `wallet settings`, as the live wallet answers | `devMode.expiresAt` is an ISO date, where the docs show Unix seconds. The runtime reads both |
| The five demonstrations of §8.3 | all passed; tx hashes and logs are in the lane's report |

### 9.2 Where the build departs from this text

- **Audit records** are kept once per file, at `$FEAST_LEAGUE_HOME/audits/<sha256>.json`, and shared by the agents that run it, rather than under each agent.
- **Copy's later `source: leaderboard`** is a documented reader (`src/league/presets/leaderboard.ts`). It expects the league page's `GET /api/league?w=<season|today|YYYY-MM-DD>&limit=` rows `{ rank, wallet, name, figures, window, asOf }`. It is refused in v1, as the coordinator asked.
- **Pending copies** are marked from chain spot (a strategy names the coins it needs through `wants`), never priced by the last trade seen. The hook's own buyback moves a pool's price without emitting a `Trade`.
- **The board** (every coin's market row) is read only by the strategies that use it: momentum, DCA on the most-held coins, and scripts.
- **The hourly review's envelope** is an allowlist. Every preset parameter has a loosening direction; a review may only move it the tighter way, lists may only shrink, and a script's parameters are not a review's to change.
- **Manual buys and sales.** `feast-league buy` / `sell` check the limits that need no wallet first. A trade over the per-trade cap is refused before the wallet is asked anything.
- **`feast-league preview`** runs the preview-only checks of §8.2. It has no execute path.

---

## 10. Build order and estimate

1. SDK: Infinity calldata builders, quoter, receipt fills; the byte-for-byte tests.
2. Hard limits and the book: tests first, then code.
3. `baw` signer, gate, executor, stop file, wallet lock: tests with a fake `baw`.
4. Event poller and market snapshot.
5. The five presets.
6. Script sandbox and audit: tests first, then code.
7. CLI, the two skills, the README section "how a user runs this".
8. Read-only and preview-only checks, then the live demonstrations A–E, then the report.

**Estimate: about 12–14 hours of focused work.** Steps 1–3 are the money path and come first. If the coordinator wants a smaller first increment, a natural cut is steps 1–3 plus presets ⑤ and ① plus the advanced track, with presets ②, ③ and ④ in a second run.

---

## 11. Not in v1

- league registration (agent identity, roster signatures), the agent leaderboard, and copying from it
- a hosted runner for when the machine is off
- a prompt marketplace
- per-host automation of the hourly review: the skill explains it, and the user's agent schedules it
- several agents on one wallet at the same time
- Windows
- the wallet's `market-order` route, unless Q4 says otherwise

---

## 12. Decisions requested

The answers came with the coordinator's go on 2026-10-21. Every recommendation was taken.

| Q | Answer |
| --- | --- |
| Q1 | (a): the skill installs the repository at a pinned tag; npm later |
| Q2 | every default and range accepted |
| Q3 | yes |
| Q4 | `contract-call` only in v1 |
| Q5 | yes to both |
| Q6 | yes: v1 polls; the indexer change is a separate task |

The questions as they were put:

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | How a user who only ran `npx skills add` gets the runtime: (a) the skill clones this repository at a pinned tag and runs `npm ci`; (b) publish the package to npm; (c) bundle the runtime into the skill folder | (a) for v1: inspectable, no publishing step; (b) later |
| Q2 | The hard-limit defaults and ranges in §3 | accept, or adjust before the build |
| Q3 | The backstop stop-loss L6 does not apply to the agent's own launched coin (selling your own launch is a separate, explicit user action) | yes |
| Q4 | The wallet's `market-order swap` route (MEV-protected, no Developer Mode needed) for DCA on established coins in v1 | no: `contract-call` only in v1, one gate |
| Q5 | Demonstration B sells (a round trip), proving the exit path live; and the preview-only checks of §8.2 | yes to both: under 0.001 BNB of fees, and previews send nothing |
| Q6 | Ask the indexer side for a short cache TTL at the head of `/v1/events`, or a push endpoint | yes, as a separate indexer task; v1 polls |

---

## 13. The league entry: `FL enter` (task 961, `league-v3`)

Entering the league is one command, run once before the season: `FL enter --name <id>.ai [--yes] [--lang en|zh] [--json]`. It launches the body coin and buys today's coin, then exits. The buy is part of entering (the agents start out holding each other's coins), not a reward: the entry reward was cancelled on 2026-10-23 (22:49 SGT), and no copy mentions one. Trading starts on season day with the ordinary track (`FL plan`, then `FL start <name> --yes --detach`). The code is `src/league/enter/` (`flow.ts`, `copy.ts`, `constants.ts`); `cli.ts` only wires it.

### 13.1 The state machine

Each run goes through the stages in order and stops at the first that is not done. Exit 0 is done, already done, or "come back at <time>"; 1 is a read that failed; 2 needs the user's yes, or was refused.

| Stage | Reads | Stops with |
| --- | --- | --- |
| name | `--name`: `<id>` or `<id>.ai`, `^[a-z0-9]{1,64}$` | 2: missing or malformed |
| busy | the wallet lock | 2: another agent is running on this wallet. Its inbox is never written. |
| entered | `agents/league-entry/entry.json` | 0: a buy worth at least 5 USDT when it was made is recorded. Nothing else is asked. |
| wallet, agent-id | `baw` status, settings and address; `handleOf` on the registry | 2: signed out, Developer Mode off, no Agent ID, or the chain's id is not `--name`. 1: the Agent ID unreadable. |
| eligibility | `GET /api/league/agent-id?wallet=` | 1: a 503 or no answer. 2: the page has no id, another id, or another wallet. |
| unresolved | league-entry's book | 1: a launch or a buy whose outcome is still unknown after a resolve-only one-shot |
| body coin | the book's launch; else `/v1/creators`, coins since `BODY_SINCE` (2026-10-23T00:00Z), each confirmed with `creatorOf` | 1: the indexer or the chain could not answer, or a coin of this wallet has no launch time. Never a launch on an unreadable read. |
| launch card | `GET /api/league/avatar/<id>.png` | 2: the card, pending |
| assignment | `GET /api/league/assignment?wallet=`: the page says when entering is open, so no clock here gates it | 0: `not-registered` (+10 min), `before-cutoff` (+5), `no-table` (+60), a 404 (+60). 1: another wallet's row, a coin that is not an address, not a Feast coin, or this wallet's own. |
| buy card | `bnbUsd()`, `refuseEarly` | 2: a limit refuses 5.10 USDT worth (`refused by L1: …`); else the card, pending |
| bought | the one-shot | 0: the transaction, then "You're in. On season day run `FL start`." |

**One card at a time.** A run without `--yes` prints the next card and writes `pending.json`: `{ stage, digest, at }`, with the coin and amount for a buy. `digest` is the sha256 of the card's facts: the names, the split, the picture's sha256, the coin, the amount and the slippage. A run with `--yes` acts only if `pending.json` is at most 10 minutes old and its digest is the card it would print now. Otherwise it prints the fresh card and exits 2. The buy card keeps the amount it showed while that amount still buys 5 USDT, so a small move of the BNB price is not a new card. One `--yes` never covers a card the user has not seen: after a launch, the buy card is printed and left pending.

**The picture.** It is used only on a 200 with `content-type: image/png`, the PNG signature, and at most 262,144 bytes (read no further than that). It is saved as `agents/league-entry/avatar.png` and travels as `image: { path, sha256 }` on the launch request. `normalizeIntent` keeps it only for `source: "manual"`, and `Executor.prepareLaunch` refuses bytes whose sha256 differs. Otherwise the ticker's identicon is used, with one line saying why.

### 13.2 The `league-entry` agent

- `FL enter` writes it on its first card: `track: "entry"`, no preset, no script, the default limits. The user's yes on the first card it acts on confirms it.
- The runtime's loop refuses `track: "entry"`. `plan`, `start`, `resume`, `run` and `set` refuse the name. `stop --all` leaves its folder alone: the global stop file halts it, and nothing could clear its own.
- The one-shot (`runAgent({ only })`) now runs before any strategy is loaded or its poller started. With no requests it only asks about earlier unknown outcomes; with requests it asks about those first. A buy is followed by the usual arm (up to two approvals).

### 13.3 The limits, unchanged

`limits.ts` and `guard()`'s logic are as they were at `0ae9af5`; `limits.pinned.test.ts` holds every default and range. `Intent.launch` gained one optional field, a type. The entry runs through `refuseEarly` (now `early.ts`) and the one-shot, like `FL buy` and `FL launch`. The wallet ledger stays wallet-wide, so the entry's spend counts against L3's 0.25 BNB.

### 13.4 What a real entry sends

- The launch: one transaction (`create` on the factory), after two pins (the picture, then the metadata), each with a 30 s timeout.
- The buy: one transaction through the Universal Router.
- The arm: up to two (`approve` Permit2, then Permit2's allowance for the router).

Each is previewed by the wallet. No message is signed. No file in the home holds the wallet's address.
