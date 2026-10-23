# Writing a strategy script

**What a script is.** One ES module file that gets everything through `api` and nothing else.

**What the runtime does with it.**
1. Audits it, with static rules and then a model read.
2. Runs it in a sandbox: a separate process with no files, no network, no environment and no wallet.
3. Sends every trade it asks for through the same hard limits as a preset.

**The warm-up.** A new script's first 5 trades run at 0.001 BNB. `FL script check <file>` runs the script against a stub world through the real guard; a pass on record for the file's sha256, with its audit passed, counts as the warm-up done, and the script trades at its own sizes from its first trade.

## Shape

```js
export const meta = { name: "my-strategy", tickSeconds: 60, events: ["coin.created", "trade", "price.move"], watch: ["FEAST"] };
export const params = { size: 0.002 };            // optional: your own tunables

export function onTick(api) {                      // every tickSeconds (15–3600)
  // read, decide, ask
}

export function onEvent(api, event) {             // optional: on the events listed in meta.events
  // event.type is "coin.created" | "trade" | "price.move"
}
```

**Rules.**
- Handlers are synchronous and return quickly: `onTick` gets 1 s, `onEvent` 250 ms.
- No `import` or `require`.
- No `fetch`, timers, `while` loops or recursion.
- `for` loops need a numeric literal bound of at most 1000. `for…of` over what `api.read` gives is fine.
- The audit's rules are in the feast-audit skill.

## `api`

| Member | Gives or does |
| --- | --- |
| `api.read.now()` | the time, epoch ms |
| `api.read.balance()` | BNB the wallet can spend, above the gas reserve |
| `api.read.limits()` | the hard limits in force (L1–L14) |
| `api.read.warmup()` | `{ active, remaining, sizeBnb }` or null |
| `api.read.coins({ sort, limit })` | coins: `sort` is `"new"`, `"holders"` or `"volume"`; each `{ coin, symbol, quote, creator, launchedAt, ageSeconds, holders, volume24hBnb, trades24h, priceBnb, hasMetadata }` |
| `api.read.coin(addressOrSymbol)` | one coin, or null (`"FEAST"` works) |
| `api.read.trades(coin?, { limit, sinceMs })` | recent trades from the event stream: `{ coin, side, payer, bnb, coins, priceBnb, at }` |
| `api.read.positions()` | `{ coin, symbol, coins, costBnb, markBnb, pnlPct, peakBnb, openedAt, ageSeconds, ownLaunch, armed }` |
| `api.read.position(coin)` | one position, or null |
| `api.read.holders(coin, sinceMs?)` | holder-count samples `{ at, holders }` |
| `api.read.launchesBy(creator, sinceMs?)` | how many coins a creator launched |
| `api.read.launched()` | the coin this agent launched, or null |
| `api.read.stale()` | null while the market data is fresh; while the runtime's market feed backs off, `{ sinceMs, reason }`: the coins, holders and trades are the last good read's, not refreshed since `sinceMs` (positions and the balance are read from the chain) |
| `api.buy({ coin, bnb, reason })` | ask for a buy of `bnb` BNB |
| `api.sell({ coin, fraction, reason })` | ask to sell a share (0–1) of a position |
| `api.launch({ name, symbol, quote, description, burn, referrer, reason })` | ask for a launch |
| `api.state` | an object kept between calls (≤ 64 KB) |
| `api.params` | your `params`, as the user set them |
| `api.log(text)` | a line in the agent's log |

**What an ask is.** `buy`, `sell` and `launch` ask; they do not send.
- The runtime checks every ask against the hard limits.
- It forces the warm-up size.
- It builds the transaction and previews it with the wallet before anything is sent.
- A refused ask is logged with the limit that refused it.

## Example: buy a coin with many holders, exit at −20 % or +50 %

```js
export const meta = { name: "holders", tickSeconds: 300 };
export const params = { size: 0.002 };

export function onTick(api) {
  for (const p of api.read.positions()) {
    if (p.pnlPct !== null && (p.pnlPct <= -20 || p.pnlPct >= 50)) api.sell({ coin: p.coin, fraction: 1, reason: "exit" });
  }
  if (api.read.positions().length > 0) return;
  const top = api.read.coins({ sort: "holders", limit: 1 })[0];
  if (top && top.ageSeconds > 3600) api.buy({ coin: top.coin, bnb: api.params.size, reason: "most holders" });
}
```
