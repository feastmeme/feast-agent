# The five presets

Generated from the runtime's own specs (`src/league/presets/specs.ts`); a test holds this file to them.
Every size is bounded by L1, every stop-loss by L6, every slippage by L9, every position count by L5.

## `sniper`: New-coin sniper

It buys a brand-new coin within seconds of its launch, in small size, and exits by a hard stop-loss, a take-profit or a time stop. Tick 15 s; events: coin.created, trade.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `buyBnb` | 0.005 | 0.001 – L1 BNB | size of each snipe |
| `maxAgeSeconds` | 90 | 10 – 900 s | only coins launched less than this long ago |
| `quotes` | all | all, or a list | which pairs to snipe: all, or a list such as WBNB,BNCB |
| `requireMetadata` | true | true / false | skip coins launched without metadata |
| `maxCreatorLaunches24h` | 3 | 1 – 50 | skip creators who launched more than this in 24 h |
| `snipesPerHour` | 3 | 1 – 20 | at most this many entries an hour |
| `slippagePct` | 8 | 1 – L9 % | slippage bound |
| `stopLossPct` | 25 | 5 – L6 % | hard stop: sell all this far below entry |
| `takeProfitPct` | 100 | 10 – 1000 % | take profit this far above entry |
| `takeProfitSellPct` | 100 | 10 – 100 % | share of the position sold at the take-profit |
| `timeStopMinutes` | 30 | 1 – 1440 min | sell what is left after this long |

## `momentum`: Momentum

It enters coins whose volume and holder count are growing, and exits when that is exhausted. Tick 60 s; events: trade, price.move.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `lookbackMinutes` | 15 | 5 – 240 min | the entry window |
| `minVolumeBnb` | 0.5 | 0.01 – 100 BNB | volume in the window |
| `minNewHolders` | 10 | 1 – 1000 | holder-count growth in the window |
| `minPriceChangePct` | 10 | 0 – 500 % | price rise in the window |
| `minAgeMinutes` | 10 | 0 – 10080 min | skip a coin's first minutes |
| `maxAgeHours` | 72 | 1 – 720 h | skip coins older than this |
| `buyBnb` | 0.01 | 0.001 – L1 BNB | size of each entry |
| `maxPositions` | 3 | 1 – L5 | momentum positions at once |
| `exhaustionWindowMinutes` | 5 | 1 – 60 min | the exhaustion window |
| `exhaustionRatio` | 0.3 | 0.05 – 1 | exit when the volume rate falls below this × the entry rate |
| `trailingStopPct` | 15 | 3 – 50 % | exit this far below the peak since entry |
| `stopLossPct` | 20 | 5 – L6 % | stop-loss below entry |
| `timeStopHours` | 24 | 1 – 168 h | exit after this long |
| `slippagePct` | 3 | 0.1 – L9 % | slippage bound |

## `copy`: Copy the top agents

It follows the buys of the wallets you name, after a delay and at your size, and exits with them. Tick 15 s; events: trade.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `source` | wallets | wallets / leaderboard | whom to follow: a wallet list (the league leaderboard is not open yet) |
| `wallets` | asked | 1 – 20 wallets | the wallets to follow |
| `topN` | 5 | 1 – 20 | how many leaders to follow (leaderboard source) |
| `delaySeconds` | 5 | 0 – 600 s | wait before copying |
| `sizeMode` | fixed | fixed / proportional | fixed size, or a share of the leader's |
| `buyBnb` | 0.005 | 0.001 – L1 BNB | fixed size |
| `proportionalPct` | 10 | 1 – 100 % | share of the leader's size, capped by the per-trade limit |
| `minLeaderBuyBnb` | 0.01 | 0 – 10 BNB | ignore leader buys smaller than this |
| `maxChasePct` | 10 | 0 – 100 % | skip if the price rose more than this since the leader's fill |
| `copySells` | true | true / false | sell a copied coin when its leader sells it |
| `stopLossPct` | 30 | 5 – L6 % | stop-loss below entry |
| `timeStopHours` | 48 | 1 – 720 h | exit after this long |
| `slippagePct` | 5 | 0.1 – L9 % | slippage bound |

## `launch`: Launch and run

It launches one coin themed by your prompt, holds an opening buy, and buys it back with the creator's fee share. Tick 300 s.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `name` | asked | text, ≤ 32 | the coin's name |
| `symbol` | asked | text, ≤ 10 | the ticker, 1–10 letters or digits |
| `description` |  | text, ≤ 280 | one line about the coin |
| `image` | generated | text, ≤ 400 | a picture file, or generated |
| `quote` | WBNB | WBNB / AAPLB / BABAB / BNCB / CRCLB / GOOGLB / NVDAB / QQQB / SKHYB / SPCXB / TSLAB | the pair |
| `burnPoints` | 20 | 0 – 30 | points of the 1% fee bought back and burned |
| `referrerPoints` | 10 | 0 – 30 | points of the 1% fee for referrers |
| `openingBuyBnb` | 0.005 | 0 – L1 BNB | bought right after the launch, and held |
| `buybackEveryMinutes` | 60 | 15 – 1440 min | how often to claim and buy back |
| `minClaimBnb` | 0.0005 | 0 – 1 BNB | skip smaller claims (gas) |
| `buybackPct` | 100 | 0 – 100 % | share of each claim spent on the buyback |

## `dca`: DCA / dip-buy blue chips

It buys FEAST (or the coins with the most holders) on a schedule, with an extra buy on a dip. Tick 3600 s; events: price.move.

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `targets` | FEAST | FEAST / topHolders | what to buy |
| `topN` | 3 | 1 – 10 | how many of the most-held coins (topHolders) |
| `buyOnStart` | true | true / false | first buy as soon as it starts |
| `everyMinutes` | 1440 | 60 – 10080 min | how often to buy |
| `buyBnb` | 0.005 | 0.001 – L1 BNB | size of each scheduled buy |
| `dipPct` | 15 | 0 – 80 % | extra buy this far below the 24 h high (0: none) |
| `dipBuyBnb` | 0.005 | 0.001 – L1 BNB | size of a dip buy |
| `maxBuysPerDay` | 2 | 1 – 24 | at most this many buys a day |
| `takeProfitPct` | off | off, or 10 – 1000 % | sell all this far above entry (off by default: DCA holds) |
| `slippagePct` | 1 | 0.1 – L9 % | slippage bound |
