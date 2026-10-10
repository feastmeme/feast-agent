# Binance Web3 API: developer-experience log

Raw material for the team's Developer Experience Report: observations, one per line, each with its time or its source. It is evidence, not the report.

- Times are UTC, 2026-10-10.
- "curl" means curl 8 from a desktop machine, once with a desktop-browser User-Agent and once with curl's default one.
- "Fetch tool" means a hosted HTTP fetcher with a different egress and User-Agent that returns page text. Its page text is a near-verbatim rendering, not byte-exact.
- Byte-exact bodies are quoted only where curl received them.

## 1. Timeline: from opening the docs to the first call

- 01:00:17 — the operator session starts (the empty repository was created at 00:59:15).
- 01:01:14 — first request to Binance: `GET https://web3.binance.com/en/dev-portal` (curl, browser UA) returns HTTP 202, a 2,102-byte AWS WAF JavaScript challenge, and no portal content.
- 01:01:15 — the same URL with curl's default UA returns HTTP 202 with an empty body.
- 01:01:16–01:01:35 — `/llms.txt`, `/llms-full.txt`, `/en/dev-docs` and `/en/dev-docs/llms.txt` all return HTTP 202 WAF challenges to curl, with both UAs.
- 01:01:41 — the Fetch tool gets `https://web3.binance.com/llms.txt` (HTTP 200). It describes the consumer Web3 site and has no link to the developer docs, the API or API keys.
- 01:01:41 — the Fetch tool gets HTTP 404 for `https://web3.binance.com/llms-full.txt`.
- 01:02:19 — the Fetch tool reads `/en/dev-portal`. It is a landing page ("Build with Binance Web3 API … One unified API — powered by Binance Wallet") with Log In, Documentation and Get Started, and no endpoints, base URL or key instructions.
- 01:02:19 — the Fetch tool gets empty text for `/en/dev-docs`, which renders only with JavaScript.
- 01:04:28 — the RWA Data reference (`/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data`) and the Authentication page (`/en/dev-docs/authentication`) render through the Fetch tool. This is the first time the base URL, auth headers and RWA endpoints were readable. Elapsed since opening the docs: 3 min 14 s.
- 01:07:33 — the real docs index for LLMs is at `/en/dev-docs/llms.txt`, not at the site root. It is readable through the Fetch tool and still a WAF 202 for curl.
- 01:11:22 — RWA parameter names confirmed against the official JS connector source (`binance/binance-web3-connector-js`, `clients/web3-wallet/src/rest-api/modules/rwadata-api.ts`, commit `a234ece`).
- 01:12:01 — first attempted API call: `GET https://web3.binance.com/build/api/v1/dex/market/rwa/tokens?binanceChainId=56&platformId=bstock` without credentials. It returned HTTP 401 (verbatim in §4). Elapsed since opening the docs: 10 min 47 s.
- 01:12:13 — first successful Binance data call, without a key: the `binance-tokenized-securities-info` Wallet Skill's token list (`/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai`). HTTP 200, 363,398 bytes, 1,938 items. On chain 56 there were 91 items of `type` 3 (bStock). The bStock subset is kept in `src/binance/fixtures/skill-bstock-list.bsc.live.json`.
- 01:18:09 — the Wallet Skill's "RWA Dynamic V2" call for AAPLB (`0x431a…9b7a`) returns HTTP 200 with `tokenInfo.price` "336.54311776947818998044", `stockInfo.price` null and `statusInfo.reasonCode` "TRADING", on a Saturday.
- 01:19:31 — the RWA Data client (signing, six endpoints, fixtures) is committed. It has not been called with credentials, because the team's key did not exist yet.
- No authenticated call has been made so far. Run `npm run agent -- binance-check --record` once the key exists; it records every response.

## 2. llms.txt and llms-full.txt (the route the DX form asks about)

- `https://web3.binance.com/llms.txt` with curl: HTTP 202 and `content-type: text/html`. The browser UA gets a 2,118-byte WAF JS challenge (`x-amzn-waf-action: challenge`); the default UA gets 0 bytes.
- `https://web3.binance.com/llms.txt` through the Fetch tool: HTTP 200. The content is the consumer site's link list, with no developer, API or key information.
- `https://web3.binance.com/llms-full.txt` with curl: HTTP 202 WAF challenge. Through the Fetch tool: HTTP 404.
- `https://web3.binance.com/en/dev-docs/llms.txt` with curl: HTTP 202. The browser UA gets a 2,102-byte challenge; the default UA gets an empty body.
- `https://web3.binance.com/en/dev-docs/llms.txt` through the Fetch tool: the real index ("# Binance Web3 API"). It lists about 60 doc pages as `.md` links and 66 REST endpoints as method plus path, with no link per endpoint.
- `https://web3.binance.com/en/dev-docs/llms-full.txt` with curl: HTTP 202 WAF challenge. Through the Fetch tool: too large to read whole; only a slice starting at the Trading API introduction came back.
- `.md` pages listed in `/en/dev-docs/llms.txt` (for example `/en/dev-docs/products/market-api/introduction.md`) are also a WAF 202 for curl. Through the Fetch tool they return raw markdown.
- The API-reference pages have no `.md` export: `/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data.md` came back empty.
- The Agent Native overview (`/en/dev-docs/agent-native/overview`, as rendered) says the llms files can be fetched via curl. With curl they returned the WAF challenge every time.
- Raw `.md` exports contain MDX/JSX. `authentication.md` begins with `import { Callout } from "zudoku/ui/Callout.js";` and `mcp-server.md` contains `import { Link } from "zudoku/components";` and Tailwind `className` markup.
- `https://developers.binance.com/llms.txt` returns HTTP 404 with an empty body, from both UAs.
- The API host itself is not WAF-gated: `https://web3.binance.com/build/api/v1/...` answered curl's default UA with JSON (§4).

## 3. Documentation errors and inconsistencies

| Page | Section | What is wrong | What it should say |
| --- | --- | --- | --- |
| `/en/dev-docs/authentication` | Step 1 | The API needs an **API Key and a Secret Key**, and every request is HMAC-SHA256 signed with the secret. This page's Step 1 is the first place that appears: the dev-portal landing page and the Overview page, as rendered, do not say so. | Say up front, on the portal and on the Overview, that every request is signed with a secret key issued with the API key. |
| `/en/dev-docs/authentication` | Step 2 | "Every authenticated request must include the following three headers", followed by a five-row table (two rows optional). | "three required headers and two optional ones". |
| `/en/dev-docs/authentication` | 3.1 examples, Node.js / Python / Java samples | The signing examples use `GET /build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT`. The docs index lists that endpoint as `POST /api/v1/dex/market/price`, with a body of `{binanceChainId, tokenContractAddress}` items, and no `chainId` or `symbol` query parameters. | Sign a real request, e.g. `GET /build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0x…`. |
| `/en/dev-docs/authentication` | 3.1, POST example | Signs `POST /build/api/v1/dex/swap`. The index has no such endpoint; swaps are `GET /api/v1/dex/aggregator/swap`. | Use an endpoint that exists. |
| `/en/dev-docs/authentication` | Step 4, signature example | The only example signature is truncated (`k3Y2mNpQr...base64sig...==`). No page gives a full timestamp + secret + pre-hash + signature vector, so a client cannot be checked offline before a key exists. | Publish one complete test vector (a dummy secret and its expected `X-OC-SIGN`). |
| `/en/dev-docs/authentication` vs `/en/dev-docs/products/market-api/error-codes` | Error Codes | The Authentication page maps 40101 to HTTP 401 and 42900 to HTTP 429. The Market API error page says "All Market API responses — including errors — return HTTP 200". Live, a missing key returned HTTP 401 (§4). | One statement of the status codes, matching the gateway. |
| `/en/dev-docs/authentication` | Error Codes, unified format | The example error body is `{"code": 40102, "msg": "Invalid signature", "data": null, "timestamp": …}`. The live error body had `"data": ""` (an empty string). | Document `data` as it is sent, or send `null`. |
| `/en/dev-docs/products/market-api/error-codes` | 40101 / 40102 rows | `msg` is given as `Invalid API Key` and `Signature error`. The Authentication page's example says `Invalid signature`, and the live 40101 said `API Key is required`. | Document the `msg` strings the gateway actually sends, or tell clients to key on `code` only. |
| `/en/dev-docs/products/market-api/error-codes` | Troubleshooting, 50001 | "Check the status page" links to `https://developers.binance.com`, the generic Binance developer hub, not a status page. | Link a real status page, or remove the link. |
| `/en/dev-docs/products/market-api/error-codes` | 40102 row | Mentions an "Ed25519 signature". The Authentication page documents only HMAC-SHA256. | Document asymmetric-key signing on the Authentication page, or drop the mention. |
| RWA Data reference | `/rwa/price` → `referencePrice` | Described as "A per-share converted price derived from the on-chain token price, not an official quote from the traditional stock market". `/rwa/underlying-market` → `marketData.referencePrice` has the same name and is described as "Underlying reference price (USD)". The examples give both as `61.746364`. | Say whether either field is ever an exchange quote, and name them differently if they differ. |
| RWA Data reference | examples | For the same token the examples give `tokenPrice` 61.89, `tokenToShareRatio` 1.003701 and `referencePrice` 61.746364. But 61.89 ÷ 1.003701 = 61.662, not 61.746364. | Internally consistent example numbers. |
| RWA Data reference | `/rwa/tokens` → `decimals` | Typed `string`; the example value is the number `18`. | One type. |
| RWA Data reference | `statusInfo.reasonCode` | Described as the "Reason code when market not tradable", yet the enum includes `TRADING`. The keyless Wallet Skill returned `reasonCode` "TRADING", `openState` true and `marketStatus` null on Saturday 2026-10-10. | Say when each status field is null, and what `TRADING` means when the US market is closed. |
| RWA Data reference | parameter names | `/rwa/price` takes `tokenContractAddresses` (plural, comma-separated); every other RWA endpoint takes `tokenContractAddress`. The keyless skill endpoints use `chainId` and `contractAddress`. | Fine as designed, but call it out on the page; it is easy to send the wrong one. |
| RWA Data reference vs Trading API vs Wallet Skill | "type" | RWA Data `assetType`: 1 = Stock, 2 = Pre-IPO, 3 = ETF. The Wallet Skill's `type`: 1 = Ondo, 2 = xStocks-style, 3 = bStock. The same numbers mean different things in neighbouring APIs. | One vocabulary, or distinct field names. |
| RWA Data reference | examples | Example logo and PDF URLs point to `static.onchainos.com`, which is not a binance.com domain. | Use Binance-hosted URLs, or explain the domain. |
| `/en/dev-docs/introduction` | API modules | Lists five modules (Market, Trading, Transaction, Wallet, DeFi). RWA Data is not among them, though the index files it under the Market API. | List RWA Data where a reader looks first. |
| `/en/dev-docs` and `/en/dev-docs/catalog/web3-wallet/api/rest-api` | – | Render only with JavaScript. No text reaches a non-JS client, and with curl they are behind the WAF challenge (§2). | Serve server-rendered HTML, or exempt the docs from the bot check. |
| Wallet Skill `binance-tokenized-securities-info` (`SKILL.md`, skills-hub commit `9960c67`) | description | Says "Query Ondo tokenized US stock data", but the same API answered for a bStock (AAPLB, `type` 3) at 01:18:09. | Say it covers bStocks, Ondo and xStocks. |
| `/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-eligible-tokens` | header | "Effective week 2026-08-11 → 2026-09-01", "Last updated 2026-08-27", "The list is updated weekly", "This page is the authoritative source". On 2026-10-10 that is more than five weeks past its effective week. | Update it, or date-stamp it as historical. |
| `github.com/binance/binance-skills-hub` README | Security link | `./skills/binance/spot/SKILL.md#security` → HTTP 404 (checked 01:14:12). | A link that resolves. |
| `/en/dev-docs/sdks-tools/connectors/javascript` | example | Reads `BINANCE_API_KEY` / `BINANCE_API_SECRET`, the same names the Binance spot-exchange API uses. | Distinct names, such as `BINANCE_WEB3_API_KEY`. |
| Node.js minimums | various | Node 18+ (Agentic Wallet install page; npm `@binance/agentic-wallet` engines), Node 22+ (skills-hub README), Node ≥ 22.12.0 (JS connector). | One stated minimum per tool, consistent across pages. |
| Search results | – | "Binance Web3 API Specification V0.0.6 (2024-01-09)" (`developers.binance.com/docs/zh-CN/binance-web3-api/apis`) still ranks, and now lands on the generic Binance API hub. | Redirect old spec URLs to `/en/dev-docs`. |

## 4. Error messages, verbatim

- `GET https://web3.binance.com/build/api/v1/dex/market/rwa/tokens?binanceChainId=56&platformId=bstock` with no `X-OC-*` headers, at 01:12:01:
  - HTTP 401
  - `content-type: application/json`
  - `x-oc-blocked-by: AuthenticationFilter/40101`
  - `x-oc-trace-id: unknown-gateway-434ef6a5df574a0588a3322d208ba125`
  - body `{"msg":"API Key is required","data":"","code":40101,"timestamp":1791594721678}`
- That message names the missing key but not the missing signature headers. Nothing in the response says that `X-OC-TIMESTAMP` and `X-OC-SIGN` (and therefore a secret) are also required.
- The response has no `success` field, which the RWA Data reference lists in every response.
- Every docs URL fetched with curl answered HTTP 202 with `x-amzn-waf-action: challenge`: an HTML challenge with a browser UA, an empty body with curl's default UA. A 202 with an empty body says nothing about why the content is missing.

## 5. Rate limits

- None hit. The calls were:
  - one unauthenticated API call;
  - one keyless Wallet Skill list call;
  - keyless RWA Dynamic calls, one per `quote` and two per demo run (not separately counted);
  - documentation fetches.
- Documented (Authentication page, Rate Limits):
  - 1,200 requests / 60 s per IP;
  - 1,200 requests / 60 s per API key;
  - 6,000 / 60 s per user;
  - 5 requests a second per endpoint by default;
  - HTTP 429 with `Retry-After`.
- The client spaces calls to one endpoint at least 220 ms apart, to stay under 5 a second.

## 6. Did the code examples run as written?

- The Wallet Skill's curl example for RWA Dynamic V2 (`SKILL.md`, "API 5") ran as written with the AAPLB address and returned HTTP 200 (01:18:09).
- The Wallet Skill's token-list call ran as written and returned HTTP 200 (01:12:13).
- The Authentication page's Node.js signing example was not run: no key yet. It signs a GET form of `/dex/market/price` that the index lists as POST (§3).
- The RWA Data reference's curl examples were not run with credentials: no key yet. Run without headers, the `/rwa/tokens` call gave the 401 in §4.
- This project's signing follows the Authentication page: pre-hash = timestamp + method + `/build` path + raw query + body, then HMAC-SHA256, then Base64. It is unit-tested against Node's own HMAC. Without a published test vector, it is unverified against the gateway until the key exists.

## 7. Looked for, and could not find

- A complete signature test vector (secret, timestamp, path, expected `X-OC-SIGN`).
- An OpenAPI / Swagger file for the REST API. The JS connector's sources are generated from one, but the spec itself is not linked from the docs or `llms.txt`.
- A way to fetch `llms.txt`, `llms-full.txt` or the `.md` pages with curl, as the Agent Native page says.
- An MCP server: `/en/dev-docs/agent-native/mcp-server` says "Coming soon", with no URL or package.
- Any statement of whether `referencePrice` is ever the listed share's exchange price, rather than a conversion of the token price (§3).
- A trading-hours or holiday calendar for the underlying US market. Only `statusInfo.nextOpenTime` / `nextCloseTime` exist per token.
- A sandbox or testnet for the Web3 API, so a client can be exercised before a key is issued.

## 8. Agentic Wallet and Wallet Skills

We looked for a public SDK or docs for the Agentic Wallet and Wallet Skills, and found them without logging in:

- the docs at `/en/dev-docs/products/agentic-wallet/*`;
- the GitHub repo `binance/binance-skills-hub`;
- the npm CLI `@binance/agentic-wallet` 1.10.0 (`baw`), installed with `npx skills add binance/binance-skills-hub/skills/binance-web3/binance-agentic-wallet`.

Using the wallet needs a Binance account, its MPC wallet and a QR sign-in in the Binance App, so this project signs with plain viem. Of the skills, it uses only the read-only `binance-tokenized-securities-info`.

## 9. What we would change

- Let curl and other non-browser clients fetch `/en/dev-docs/llms.txt`, `/en/dev-docs/llms-full.txt` and the `.md` pages (exempt them from the WAF challenge), and make root `/llms.txt` point to them.
- Say "API key + secret key" everywhere the API key is mentioned, including the hackathon registration copy.
- Publish one complete signature test vector, and an OpenAPI file per product.
- Make the 401 for a missing key list every missing header.
- Make the error-code pages agree with each other and with the gateway, on both status codes and `msg` strings.
- Rename or document the two `referencePrice` fields, and fix the example arithmetic.
- Ship the MCP server the docs announce. Until then, link the Wallet Skills from the Agent Native page; they are the closest thing that works today.
