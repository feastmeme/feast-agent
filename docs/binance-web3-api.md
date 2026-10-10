# Binance Web3 API: what feast-agent calls

`feast-agent quote` prices a Feast coin in units of the bStock it is paired with, then in US dollars. It also compares the stock token's on-chain price with the underlying share's reference price. The dollar side comes from Binance, through two sources:

1. **The Binance Web3 API's RWA Data endpoints.** These are the primary source and need an API key plus its secret key.
2. **The official Wallet Skill `binance-tokenized-securities-info`.** It needs no key. The agent uses it, labelled as such, when the API credentials are absent.

Without either, every Binance figure reads "not configured", and the price comes from the stock token's PancakeSwap v3 pool instead. That pool price is read from chain, no API involved.

Code: `src/binance/client.ts` (signed client), `src/binance/stock.ts` (what `quote` shows), `src/binance/skill.ts` (keyless source), `src/agent/binance-check.ts` (live check).

## Authentication (as implemented)

Docs: https://web3.binance.com/en/dev-docs/authentication

| What | Value |
| --- | --- |
| Base URL | `https://web3.binance.com/build` |
| Credentials | `BINANCE_WEB3_API_KEY` (sent as `X-OC-APIKEY`) and `BINANCE_WEB3_API_SECRET` (signs; never sent) |
| `X-OC-TIMESTAMP` | `new Date().toISOString()`, ISO 8601 with milliseconds |
| `X-OC-SIGN` | `Base64(HMAC-SHA256(timestamp + "GET" + "/build" + path + "?" + query, secret))` |
| Query encoding | `encodeURIComponent` per key and value, joined with `&`, in a fixed order; the same string is signed and sent |
| Pacing | Each endpoint is called no more often than every 220 ms (the documented per-endpoint limit is 5 per second) |
| Success | Envelope `code === 0`. Any other code is an error, whatever the HTTP status (the docs disagree on the status; see `dx-log.md`) |

## RWA Data endpoints used

Docs: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data

| Endpoint | Parameters sent | Fields read | Used by |
| --- | --- | --- | --- |
| `GET /api/v1/dex/market/rwa/price` | `binanceChainId=56`, `tokenContractAddresses=<lower-case address>[,…]` (comma list, max 100) | `data[].tokenContractAddress`, `platformId`, `tokenPrice` (USD string), `referencePrice` (USD string), `tokenPriceUpdatedAt` (ms) | `quote`, `binance-check` |
| `GET /api/v1/dex/market/rwa/underlying-market` | `binanceChainId=56`, `tokenContractAddress=<address>` (singular) | `data.statusInfo.openState`, `data.statusInfo.marketStatus`, `data.marketData.referencePrice` | `quote`, `binance-check` |
| `GET /api/v1/dex/market/rwa/tokens` | `binanceChainId=56`, `platformId=bstock` | `data[].tokenContractAddress`, `tokenSymbol` (checks that every Feast quote is a listed bStock) | `binance-check` |
| `GET /api/v1/dex/market/rwa/underlying-profile` | `binanceChainId=56`, `tokenContractAddress` | `data.underlyingTicker`, `data.tokenToShareRatio` | `binance-check` |
| `GET /api/v1/dex/market/rwa/search` | `keyword=AAPL`, `platformId=bstock` | `data[].ticker`, `data[].assets[]` | `binance-check` |
| `GET /api/v1/dex/market/rwa/platforms` | `platformId=bstock` | `data[].platformId`, `tickerCount` | `binance-check` |

Response envelope, as documented: `{ code: number, msg: string, data: T, timestamp: number, success: boolean }`.
Error envelope, as **observed live** without a key: HTTP 401, header `x-oc-blocked-by: AuthenticationFilter/40101`, body `{"msg":"API Key is required","data":"","code":40101,"timestamp":1791594721678}`. Fixture: `src/binance/fixtures/rwa-nokey-401.live.json`.

The six endpoints have **not** been called with credentials yet: the key did not exist when this was written. The fixtures `rwa-price.aaplb.json` and `rwa-underlying-market.aaplb.json` copy the documented example shapes with illustrative values. Once the key exists, run:

```bash
BINANCE_WEB3_API_KEY=… BINANCE_WEB3_API_SECRET=… npm run agent -- binance-check --record
```

That calls each endpoint once and writes the live responses, without credentials, to `src/binance/fixtures/live/`.

## The keyless Wallet Skill call

Skill: https://github.com/binance/binance-skills-hub, `skills/binance-web3/binance-tokenized-securities-info/SKILL.md` ("API 5: RWA Dynamic V2").

| Endpoint | Parameters | Headers | Fields read |
| --- | --- | --- | --- |
| `GET https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai` | `chainId=56`, `contractAddress=<lower-case address>` | `User-Agent: binance-web3/1.1 (Skill)`, `Accept-Encoding: identity` | `code` (`"000000"` is success), `data.type` (3 = bStock), `data.tokenInfo.price`, `data.tokenInfo.sharesMultiplier`, `data.stockInfo.price` (null outside US trading hours), `data.statusInfo.openState`, `data.statusInfo.reasonCode` |

Recorded live for AAPLB at 2026-10-10T01:18:09Z: `src/binance/fixtures/skill-rwa-dynamic.aaplb.live.json`.

## Tokenized stocks this touches

Every stock Feast pairs a coin with (its other quote is WBNB) is a Binance bStock on BNB Smart Chain. All twelve appear in Binance's keyless bStock listing (`type=3`, chain 56) as read on 2026-10-10. The sandbox is a fork of BSC, so the same contracts serve both, and Binance prices them under `binanceChainId=56`.

| bStock | Underlying | BSC address | Feast mainnet quote | Feast sandbox quote |
| --- | --- | --- | --- | --- |
| AAPLB | AAPL (Apple) | `0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A` | yes | yes |
| BABAB | BABA (Alibaba) | `0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec` | yes | – |
| BNCB | BNC (CEA Industries) | `0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f` | yes | yes |
| CRCLB | CRCL (Circle) | `0x80f3D493EBCe97e343c53D29a137942416B4ffC0` | yes | – |
| GOOGLB | GOOGL (Alphabet) | `0x3F53De71c126BdaBAe20f9cD64848d317f6C3238` | yes | – |
| MSFTB | MSFT (Microsoft) | `0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0` | – | yes |
| MSTRB | MSTR (Strategy) | `0xE87afb3076AeB0f9B14E368DE8145ae6a2826A14` | – | yes |
| NVDAB | NVDA (NVIDIA) | `0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436` | yes | yes |
| QQQB | QQQ (Invesco QQQ) | `0x205812CdBed920aFf76C6580abD681a46D11efc7` | yes | yes |
| SKHYB | SKHY (SK hynix) | `0xCA750eF65f295BBECd685Abf54e82CAf297BDB61` | yes | – |
| SPCXB | SPCX (SpaceX) | `0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1` | yes | yes |
| TSLAB | TSLA (Tesla) | `0x5b1910eAaD6450E50f816082Aa078C41F10C292f` | yes | yes |
