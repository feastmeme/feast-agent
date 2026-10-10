# feast-agent

A TypeScript SDK and an agent for [Feast](https://feast.meme), a meme-coin launchpad on BNB Smart Chain where every coin is paired with a tokenized stock. With one command it launches a coin paired with a Binance bStock (AAPLB, NVDAB, TSLAB, …), trades it, and reads the on-chain fee split. It prices the coin in the stock and in dollars with the **Binance Web3 API**.

It was built for the BNB Hack: Tokenized Stocks Edition.

```
$ npm run demo:sandbox
== 3. Launch $FAAAPL75C8, paired with AAPLB
launched: Feast Agent AAPL 75C8 ($FAAAPL75C8) paired with AAPLB
== 4. Buy
- 0.02 tBNB: refused in simulation (PurchaseCapExceeded() … opening window …)
bought: 0.01 tBNB → 4,332,789.181058 coins
== 6. The fee split, as the hook holds it
| creator  | 60 | 60.00% | 0.0001949 AAPLB  | …
| burn     | 10 | 10.00% | 0.00003249 AAPLB | …
| referrer | 10 | 10.00% | 0.00003249 AAPLB | …
| platform | 20 | 20.00% | 0.00006498 AAPLB | …
```

The full transcript of that run is [`demo/transcript-2026-10-10T012729Z.md`](demo/transcript-2026-10-10T012729Z.md).

## Quickstart (five commands, about a minute)

Requires Node.js 22.12 or newer. Everything runs on the **Feast sandbox**, a public fork of BNB Smart Chain (chain 56096). Test BNB there is free, and nothing touches real money.

```bash
git clone <repository-url> feast-agent && cd feast-agent
npm install
cp .env.example .env
npm run faucet          # creates a throwaway sandbox wallet in .env (never printed) and drips 100 test BNB
npm run demo:sandbox    # faucet → launch a coin paired with AAPLB → buy → sell → fee split, saved to demo/
```

The quickstart needs no Binance credentials. Without them the agent says "Binance Web3 API not configured" and falls back to Binance's keyless Wallet Skill, then to the stock token's PancakeSwap pool. To use the RWA Data API, set `BINANCE_WEB3_API_KEY` and `BINANCE_WEB3_API_SECRET` in `.env`, then run `npm run agent -- binance-check`.

## What it does

| Part | Where | What |
| --- | --- | --- |
| SDK | `src/sdk/` | `FeastClient`, a typed client over [viem]: `quotes()`, `predictCoin()`, `prepareLaunch()` / `launch()`, `quoteBuy()` / `buy()`, `quoteSell()` / `sell()`, `feeSplit()`, `payouts()`, `referrerOf()`, `stockUsdPrice()`. Sandbox and mainnet are selected by `FEAST_NETWORK`. |
| Binance client | `src/binance/` | Signed client for the Binance Web3 API's RWA Data endpoints, plus the keyless `binance-tokenized-securities-info` Wallet Skill. |
| Agent CLI | `src/agent/cli.ts` | `feast-agent quotes · quote · launch · buy · sell · split · payouts · wallet · faucet · demo · binance-check` |
| MCP server | `src/agent/mcp.ts` | The same verbs as eight MCP tools over stdio, so a Claude or Codex session can drive Feast. |

How each step matches the feast.meme app:

- **Launch.** The agent pins a picture and the metadata JSON through the Feast site's `/api/pin`. It asks the factory for the coin's address (`predictCoin`), then builds `CreateParams`: the opening tick, the price on the single-sided side of it, and liquidity for the whole supply. It simulates `create`, sends it, and reads the coin back from the factory's own `CoinCreated` event. The coin lands at the predicted address.
- **Buy.** Test BNB goes through the Feast sandbox router, which wraps it, walks the PancakeSwap v3 route to the stock token and buys the coin in its Feast pool. The hook takes a 1% fee in the stock token. In the pool's first two traded blocks the hook caps each wallet's buy. The agent simulates first, so `PurchaseCapExceeded` arrives by name: the SDK unwraps the pool manager's `WrappedError` around the hook's own revert.
- **Sell.** One EIP-2612 permit signature, then `sellWithPermit`. There is no approval transaction.
- **Fee split.** `FeastHook.poolInfo(poolId)` holds the split. Of every 1% fee, the platform takes 20 points and the creator divides the other 80 into burn (0–30), referrer (0–30) and creator (the rest). The four seats' `earned` totals sum to `accruedQuote`, and the agent checks that sum every time. A wallet's first referred trade binds its referrer (`referrerOf`). After that, every trade by the wallet pays that referrer.
- **Quote.** The coin's spot price in its stock comes from the pool's `slot0`. That is multiplied by the stock token's USD price from Binance. The output shows Binance's on-chain token price, the underlying share's reference price, the gap between them, and the gap to the token's own PancakeSwap pool.

```bash
npm run agent -- quote AAPLB                                   # a stock token: pool price vs Binance
npm run agent -- launch --name "Dinner Bell" --symbol BELL --quote NVDAB --burn 20 --referrer 10
npm run agent -- buy  0xCoin… 0.01
npm run agent -- sell 0xCoin… 50%
npm run agent -- split 0xCoin…
npm run agent -- quote 0xCoin…                                 # the coin in NVDAB and in USD
npm run agent -- launch --symbol DRY --quote TSLAB --network mainnet --dry-run   # calldata only
```

Every command takes `--json`. After `npm install`, `npx feast-agent …` works too.

### MCP

```bash
claude mcp add feast-agent -- npx tsx /absolute/path/to/feast-agent/src/agent/mcp.ts
```

The tools are `feast_quotes`, `feast_quote`, `feast_launch`, `feast_buy`, `feast_sell`, `feast_split`, `feast_payouts` and `feast_wallet`. They follow the same rule as the CLI: they send transactions on the sandbox only.

The server reads `.env` from the directory it is started in, which is usually your Claude session's project, not this repository. Pass the variables explicitly instead, for example `claude mcp add feast-agent -e FEAST_AGENT_PRIVATE_KEY=0x… -- npx tsx …`, with a throwaway sandbox key.

## Binance Web3 API: what it calls

The full record of endpoints, parameters and response fields is in [`docs/binance-web3-api.md`](docs/binance-web3-api.md). Base URL: `https://web3.binance.com/build`. Every request is HMAC-SHA256 signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`).

| Endpoint | Used for |
| --- | --- |
| `GET /api/v1/dex/market/rwa/price` | The bStock's on-chain USD price (`tokenPrice`) and the per-share reference price (`referencePrice`), used by `quote` |
| `GET /api/v1/dex/market/rwa/underlying-market` | Whether the underlying market is open, and its reference price, used by `quote` |
| `GET /api/v1/dex/market/rwa/tokens` | Checks that every Feast quote is a listed bStock (`binance-check`) |
| `GET /api/v1/dex/market/rwa/underlying-profile` | Ticker and token-to-share ratio (`binance-check`) |
| `GET /api/v1/dex/market/rwa/search` | Lookup by ticker (`binance-check`) |
| `GET /api/v1/dex/market/rwa/platforms` | bStocks platform summary (`binance-check`) |
| Wallet Skill `binance-tokenized-securities-info`, RWA Dynamic V2 (keyless) | The labelled fallback when no credentials are set |

**Status.** All six RWA Data endpoints have been called live with the team's key, on 2026-10-10. The responses, recorded without credentials, are in [`src/binance/fixtures/live/`](src/binance/fixtures/live/). A demo run with Binance prices is [`demo/transcript-2026-10-10T023224Z.md`](demo/transcript-2026-10-10T023224Z.md). Also recorded live: the API's answer without a key (HTTP 401, code 40101) and the keyless Wallet Skill's answer for AAPLB.

What the live responses showed, in detail in [`docs/dx-log.md`](docs/dx-log.md):
- `referencePrice` is `tokenPrice` divided by the token-to-share ratio, so `quote` labels that gap as the ratio. It shows the listed share price from the Wallet Skill when one is published.
- The 5-requests-a-second limit is shared across endpoints, so the client spaces calls 250 ms apart and retries a 429 once.

**Tokenized stocks it touches.** These are the bStocks Feast pairs coins with: AAPLB, BABAB, BNCB, CRCLB, GOOGLB, NVDAB, QQQB, SKHYB, SPCXB and TSLAB on BNB Smart Chain, plus MSFTB and MSTRB on the sandbox. All twelve are in Binance's own bStock list, read live on 2026-10-10 and kept as a fixture: [`src/binance/fixtures/skill-bstock-list.bsc.live.json`](src/binance/fixtures/skill-bstock-list.bsc.live.json), checked by `src/binance/bstock-list.test.ts`.

## Feast contracts it touches (BNB Smart Chain, chain 56)

| Contract | Address | Used for |
| --- | --- | --- |
| FeastFactory | `0x1003b54659F5e31A7391fEBE824A137e8CDa90da` | `predictCoin`, `create`, `getCoin`, `listCoins` |
| FeastHook | `0xABFB955e4582f49dc741DCf5354fbB0edaD0A7c5` | `poolInfo` (the fee split), `referrerOf` |
| FeastPricer | `0x3c6a41fa2d743D4b6DbE741A7a64340a2bd8FCE5` | `quotes()`, the curated list of pairable tokens |
| FeastLedger | `0xDbc80A945e67579fF23a7D9E1c658AE4C966C637` | weekly fee totals (ABI shipped in the SDK) |
| FeastVesting | `0xDEFAd8D209d808dD4d35CEA02E3E6b1959c7cAbc` | creator pre-buy vesting (refusals decoded) |
| FeastOracle | `0x25cb1C770d36B4a7dFdC5eD2D6Bc71269Cd57911` | refusals decoded |
| FeastConverter | `0xf95D2F0c52A3e7B1e86b4DbEFeA3C45B163D5b96` | refusals decoded |
| FeastReferrals | `0x01bc8640af92f4E556cB38644bC3DA5f41f253a4` | not called; the binding is read from the hook's `referrerOf` |
| Platform sink | `0x59BA4f39Ce8a405d1C08979680f051c17dC8BBFB` | where the platform's 20 points are released to (listed, not called) |
| PancakeSwap Infinity CL pool manager | `0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b` | `getSlot0`, the coin's spot price |
| PancakeSwap Infinity vault | `0x238a358808379702088667322f80aC48bAd5e6c4` | listed, not called |
| PancakeSwap Infinity Universal Router | `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB` | the mainnet trade route (not driven by this release) |
| Permit2 | `0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768` | the mainnet trade route (not driven by this release) |
| MixedQuoter | `0x2dCbF7B985c8C5C931818e4E107bAe8aaC8dAB7C` | the mainnet trade route (not driven by this release) |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | the native quote |
| USDT / WBNB v3 pool | `0x172fcD41E0913e95784454622d1c3724f546f849` | BNB's dollar price |

On the sandbox (chain 56096) the agent trades through `FeastSandboxRouter` `0xa8c7180912D4464fa66713758Fa7eB3418b81D01`. Its other addresses are in [`src/sdk/networks.ts`](src/sdk/networks.ts).

**Mainnet is read-only in this release.** `quotes`, `quote`, `split`, `payouts` and `launch --dry-run` work against chain 56. That read path was verified on 2026-10-10: the factory has code, the pricer listed eleven quotes (WBNB and ten bStocks), and the factory's `predictCoin` matches the SDK's local CREATE2 port. `npm run test:mainnet-read` repeats the check. Any write on chain 56 is refused in the SDK, and no flag changes that.

## No private keys, ever

- The agent signs with `FEAST_AGENT_PRIVATE_KEY`, read from the environment or `.env`. `.env` is git-ignored.
- `npm run faucet` creates a **throwaway sandbox** key only when none is set. It writes the key into `.env` with mode 600 and never prints it; only the address is printed.
- Do not put a key that holds real money in `.env`. This release never sends a transaction to BNB Smart Chain anyway.
- `BINANCE_WEB3_API_SECRET` signs requests and is never sent. The Binance recorder strips credentials from what it saves.
- Nothing in this repository is a secret. Tests generate their keys at run time.

## Checks

```bash
npm test                 # offline: encoders and decoders, config, signing, Binance client on fixtures, MCP
npm run typecheck        # tsc --noEmit, strict
npm run test:sandbox     # FEAST_AGENT_SANDBOX=1: the whole loop against the live sandbox
npm run test:mainnet-read  # FEAST_AGENT_MAINNET=1: chain 56 read path (factory code, quotes, predictCoin); sends nothing
```

## Limits

- On BNB Smart Chain, trading goes through PancakeSwap Infinity's Universal Router with Permit2. This release does not drive that route. The Feast read API's `/api/v1/quote` prices mainnet trades.
- `payouts` reads the Feast public read API. It reports only settled payouts (claims, buy-back-and-burns, platform releases), and only as far as its index has caught up.
- `referencePrice` is derived from the on-chain token price (live: exactly `tokenPrice ÷ tokenToShareRatio`), not quoted by an exchange. A gap to the listed share appears only when the Wallet Skill publishes `stockInfo.price`, during US trading hours.

## License

[MIT](LICENSE)

[viem]: https://viem.sh
