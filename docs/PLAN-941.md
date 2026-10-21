# Task 941: sign up for the league from one sentence (Agent ID, body coin, manifesto), v2. PLAN (stop for the go)

`state=awaiting-plan-review ball=coordinator`

**Branch.** `todo/82d3022a4eabf295`, on `main` at `1d5b226` (tag `league-v1`, not pushed).

**Built so far.** Nothing. This file is the plan.

**Sources read.**
- This repository: `src/league/**` (`cli.ts`, `baw.ts`, `chain.ts`, `runtime.ts`, `guard.ts`, `strategy.ts`, `executor.ts`, `store.ts`, `card.ts`, the presets), `skills/feast-league/**`, the README's league section, `docs/league/PLAN.md` §9.
- Task 927, branch `todo/02ae9342a9eab7b6`:
  - committed: `PLAN-v2.md` §0 Q1–Q3, §3, §4, and `API.md`;
  - read first in its worktree while in flight, then re-checked at its seal `ce268d59`: `src/app/api/league/register/route.ts`, `src/app/api/league/agent-id/route.ts`, `src/app/api/league/route.ts`, `src/lib/league/{message,agent-id,body-coin,registry,wire,season,prereg}.ts` and the rig.
- The judgement packet `judgement-league-rules-20261021.md`, §1 and §6 (§5 and §8 for context).
- The Binance Agentic Wallet skill: `sign-message`, `wallet settings` and authentication.

**Measured before planning (2026-10-22).** Reads only: nothing signed, sent or spent.

| What | Result |
| --- | --- |
| The lane wallet | `CONNECTED`. `handleOf(lane wallet)` is `""`: **it has no Agent ID.** A live registration from it stops at step A, by design. |
| The HandleRegistry `0x60b9…022f` on BSC | 8,756 bytes of code. `handleOf(0x…01)` answers `""` without reverting. |
| `wallet settings`, session fields | See the next table. |
| Indexer `GET /v1/creators` | Live: `{ schemaVersion: 1, asOf, data: [{ coin, poolId, quote, creator, selfBurnBps, referrerBps, launchedAt, … }] }`, every launch with its creator: 27 rows. The default split shows as 2000/1000 bps. The lane wallet created one of them, on 2026-10-21. |
| feast.meme `GET /api/league` | Still v1: `{ schemaVersion: 1, state: "no-season", … }`. `/api/league/agent-id` is not deployed yet (an HTML 404). |
| `npx skills` | `skills@1.7.4` (vercel-labs). Its README asks for **Node 22.20+** for the installer itself. This machine's default Node is 22.7.0; `baw` lives under nvm's 24.19.0. |

The session fields:

| Field | Value |
| --- | --- |
| `sessionExpireTime` | now + 48.00 h |
| `inactiveSignOutTime` | now + 48.00 h, the same value |
| `signInMaxTime` | 2026-10-28 10:34 +08:00, about 7 days after the 2026-10-21 sign-in |
| `maxSigninDuration` | `"48h"` |

**So the "48 h" is an inactivity timeout, and every wallet read pushes it forward.** The hard end is `signInMaxTime`.
- The runtime reads the wallet's settings every 5 minutes, so on a running agent `sessionExpireTime` never comes within 6 h, and its 6 h and 1 h warnings never fire.
- `signInMaxTime` is not read at all. §7 fixes both.

**927's route differs from its PLAN in two places**, unchanged at its seal `ce268d59`, and I bind to the route (Q1):
- **The 201 answer** is `{ agent, seating: { state: "seated", seatNo, founding, waitlisted } | { state: "pending", reason: "no-body-coin" }, prereg }`, not `seat | pending`.
- **"No Agent ID"** is a `400 no-agent-id` refusal, not a pending answer.

---

## 0. Decisions I need from the coordinator

| # | Question | My recommendation |
| --- | --- | --- |
| Q1 | **Which answer shape to bind to.** 927's PLAN-v2 §3 says `seat: { no, founding, waitlisted } \| pending: "no-agent-id" \| "no-body-coin"`. Its `route.ts`, sealed since at `ce268d59` (`0c421887`), answers `201 { agent, seating, prereg }` and refuses `no-agent-id` with a 400. | Bind to the sealed `route.ts`, and parse the PLAN shape too, so either lands. Ask 927 to write the shape it ships into `API.md`; at `ce268d59` it still describes v1 (140 characters, `copies`). |
| Q2 | **Waitlist place.** The page returns `seatNo` and `waitlisted`; its plan says "the 1,001st is waitlisted with place 1". | The agent shows place = `seatNo − seats.cap` (cap 1,000). Better: 927 returns `place` itself. |
| Q3 | **This wallet's own row for the status card.** `GET /api/league` has no "me" row. `me=` only places the viewer in the arena, and `limit` caps at 100, so a rank past 100, and an eaten agent listed after the living, can fall off the page. | Ask 927 for `me: { earners: row \| null, backed: row \| null }` when `me=` is given. Until then the card reads the top 100 by Agent ID and says "outside the top 100" when it is not there. |
| Q4 | **One real `sign-message execute` on mainnet.** The brief says previews only on mainnet. The execute answer's signature format (r‖s without `0x` plus `signatureRecovery`) is then checked only against the wallet's docs. | Allow one execute of a Register message on the lane wallet: gasless, **never POSTed**, manifesto "preview-check". The lane wallet has no Agent ID, so the page would refuse that signature anyway (`no-agent-id`). Without it, the production path still checks every signature locally before sending (§3). |
| Q5 | **The body coin's default pair.** | **WBNB**, as the launch preset defaults. It is the route `preview create` already passed live; backers pay in BNB, and the 0.02 BNB vote threshold is in BNB. The user may name any listed tokenized stock instead (AAPLB, NVDAB, TSLAB, …). |
| Q6 | **The release the skill installs.** `references/setup.md` pins `--branch league-v1`, which predates `register`. | A new tag `league-v2` at this lane's seal, with `setup.md` pinned to it; the owner pushes it with `league-v1` (task 934). The alternative is re-pointing `league-v1` before its first push; it was never pushed, but 926's report names its commit. |
| Q7 | **The risk text.** The brief says packet §6, verbatim. 927, sealed at `ce268d59`, ships two variants of it:<br>• **zh:** the packet's words with full-width `，` and `；` where the packet has ASCII `,` and `;`. Its i18n gate refuses ASCII `,` and `;` in Chinese.<br>• **en:** "the brief's" wording, which differs from the packet's ("investment advice", "promise no return", "priced in USDT", "the wallet may be unavailable where you are"). | Packet §6 for the agent, the skill and the README, byte for byte, held by a test. For the zh punctuation I would follow the page (full-width), so a reader sees one text in both places; that is a one-line switch. The en wording needs one canonical text: tell me which. |
| Q8 | **Registering without a body coin.** | Allowed, but never the default. The agent offers the launch first. If the user declines, it offers a seatless "pending" registration and says plainly that seats go in order. |
| Q9 | **The session reminder's premise** (measured above). | Watch the earlier of `sessionExpireTime` and `signInMaxTime`. Warn once per sign-in at 6 h and 1 h before it, and once when it ends, persisted so a restart does not repeat it. This replaces today's per-process warnings and the "signed out" notice that repeats every 10 minutes. It is a change to `runtime.ts`'s wallet read, not to the money path. |
| Q10 | **The 927 rig.** It is TLS Postgres, a Next production build and the task 743 stub chain, uncommitted, in 927's own worktree. | Not run from this lane. The tests use a fake site bound to `route.ts`'s codes and `wire.ts`'s types (§10). Optionally, once 927 seals, one run of `register` against the rig's loopback page with a fake `baw` holding the rig's throwaway key. |
| Q11 | **What "founding" means in the docs.** The brief: the first 100 names on the pre-registration roster who complete formal registration before the season starts. 927's PLAN Q2: seats 1–100 in arrival order. | The agent never decides it: it says "founding seat" only when the page answers `founding: true`. The docs use whichever definition you confirm. |

---

## 1. What the user sees

The cards are printed by the runtime with `--lang en|zh`, and the skill shows them verbatim, as it shows 926's agent card. The questions are the skill's own words. Their templates in both languages go into `references/register.md`. The examples use the Agent ID `maplegrin`, as 927's wireframes do. The shipped docs use `<your-agent-id>.ai`.

### 1.1 The three steps (docs, README, setup)

| | en | zh |
| --- | --- | --- |
| 1 | Mint a Binance Agent ID in your Binance Agentic Wallet, in the Binance App. Its .ai name is your agent's name. | 在 Binance App 的 Binance Agentic Wallet 里领一个 Binance Agent ID,它的 .ai 名字就是你 agent 的名字。 |
| 2 | Install the skill into your AI agent: `npx skills add feastmeme/feast-agent` | 把 skill 装进你的 AI agent:`npx skills add feastmeme/feast-agent` |
| 3 | Say one sentence about how it should trade, and "register for the league". | 用一句话说你想怎么交易,再说「报名联赛」。 |

### 1.2 The flow at a glance

```
user   "Snipe new coins with 0.005 BNB, and enter it in the league."
skill  FL doctor → FL plan … → the agent card → yes → FL start … --yes --detach     (926, unchanged)
skill  FL register <name> --check                                     A. reads only
         ├─ no Agent ID ............ card A2, stop
         ├─ wallet not ready ....... card A4, stop
         └─ ready .................. B. the questions, in one message
skill  [no body coin] FL launch <name> …                              C. launch card → yes
       FL launch <name> … --yes   (hard limits → preview → gate → execute → receipt check)
skill  FL register <name> --manifesto … --body-coin … [--x …]         D. registration card → yes
       FL register <name> … --yes                                     E. wallet preview → check → sign
                                                                      F. POST → the answer and the next step
```

That is **at most three yeses** for a new user: the agent, the body coin and the signature. When the body coin already exists, there are two.

### 1.3 A. The check: `FL register <name> --check`

**A1, ready or partly ready.**

en:
```
Feast league: registration check

| | |
| --- | --- |
| Agent ID | maplegrin.ai (read from BNB Smart Chain) |
| Body coin | none yet: every agent launches one coin, its body |
| Registration | not registered yet |
| Season 1 | coming soon · 412 of 1,000 seats taken |

Next: launch the body coin (one transaction), then sign the registration (no gas).
```

zh:
```
Feast 联赛:报名检查

| | |
| --- | --- |
| Agent ID | maplegrin.ai(从 BNB Smart Chain 读取) |
| 身体币 | 还没有:每只 agent 都要发一个币,那是它的身体 |
| 报名 | 还没报名 |
| 第 1 季 | 即将开赛 · 1,000 个席位已占 412 个 |

下一步:先发身体币(一笔交易),再签名报名(不花 gas)。
```

The rows that change with the state:

| Row, state | en | zh |
| --- | --- | --- |
| Body coin, one found | MAPLE · 0x1234…feed, launched 2026-10-20 (by this wallet, checked on chain) | MAPLE · 0x1234…feed,2026-10-20 发行(链上核对:是这个钱包发的) |
| Body coin, several | MAPLE · 0x1234…feed, the newest of 3 (say which, if not this one) | MAPLE · 0x1234…feed,3 个里最新的(要用别的就说) |
| Body coin, launch preset not launched yet | your launch-and-run agent launches it on its first tick | 你的「发币并经营」agent 会在第一次运行时发出它 |
| Body coin, seated this season | MAPLE · 0x1234…feed, fixed for this season | MAPLE · 0x1234…feed,本季已锁定 |
| Body coin, list unreadable | the list of your coins couldn't be read; if you launched one, give its address | 暂时读不到你发过的币;如果发过,告诉我币的地址 |
| Registration, seated | seat 412 of 1,000 (since 2026-10-22) | 第 412 号席位(共 1,000,2026-10-22 起) |
| Registration, founding | founding seat 12 of 100 | 创始席位第 12 号(共 100) |
| Registration, waitlisted | waitlist, place 12 | 候补第 12 位 |
| Registration, pending | registered, no seat yet: no body coin | 已登记,还没有席位:没有身体币 |
| Season row | as the status card, §6 | 同 §6 |

**A2, no Agent ID.**

en:
```
This wallet has no Binance Agent ID yet, so it can't register.

Mint one in the Binance App: in your Binance Agentic Wallet, claim a .ai name. That name becomes your agent's name in the league; one wallet, one name.
Then say "register" again. Your agent keeps running as it is.
```

zh:
```
这个钱包还没有 Binance Agent ID,暂时不能报名。

请在 Binance App 的 Binance Agentic Wallet 里领一个 .ai 名字。这个名字就是你的 agent 在联赛里的名字;一个钱包一个名字。
领好后再说一次「报名」。你的 agent 照常运行。
```

**A3, the Agent ID could not be read.** A failed read is never taken for "none".
- en: The Agent ID couldn't be read from BNB Smart Chain just now. Nothing was signed or sent. Try again in a minute.
- zh: 暂时没能从 BNB Smart Chain 读到 Agent ID。没有签名,也没有发送任何东西。过一分钟再试。

**A4, the wallet is not ready.**

| Case | en | zh |
| --- | --- | --- |
| signed out | Sign in first: say "sign in" and scan the code in the Binance App. | 先登录:说「登录」,在 Binance App 里扫码。 |
| Developer Mode off | Turn on Developer Mode in the Binance App first: the wallet signs the registration through it. | 先在 Binance App 里打开 Developer Mode:钱包通过它签这条报名消息。 |

### 1.4 B. The questions: one message, at most three

The skill asks them together. It asks item 3 only when a coin has to be launched.

en:
```
Three things before you sign up; answer any of them in one message:
1. Manifesto: public, up to 280 characters, shown next to maplegrin.ai on the league page. A draft from what you said:
   "Small, fast bites on brand-new coins. I cut losses early and never chase." (73/280)
   Keep it, edit it, or write your own.
2. X account (optional): if you quoted the teaser on X with maplegrin.ai, your handle links that pre-registration for the early-bird mark.
3. Your body coin, maplegrin.ai (MAPLEGRIN), pairs with WBNB unless you name a tokenized stock: AAPLB, NVDAB, TSLAB, …
```

zh:
```
报名前确认三件事,一条消息回我就行:
1. 宣言:公开,最多 280 个字,显示在联赛页 maplegrin.ai 旁边。根据你那句话起的草稿:
   「只咬刚出生的新币,小口快吃。亏了就走,从不追高。」(24/280)
   可以直接用、改一改,或者自己写。
2. X 账号(可选):如果你在 X 上引用了预告帖并写上 maplegrin.ai,告诉我你的账号,用来匹配早鸟标记。
3. 你的身体币 maplegrin.ai(MAPLEGRIN)默认和 WBNB 配对;想配代币化股票就说一个:AAPLB、NVDAB、TSLAB……
```

**How the skill drafts a manifesto** (written into SKILL.md):
- In the agent's voice, one paragraph, in the user's language.
- Nothing private by default: no sizes, thresholds, wallets or schedules from the sentence. The runtime is private and the manifesto is public. The user may add them.
- No promise of profit, no "guaranteed", no yield, no other platform's name.
- At most 280 characters, counted as the page counts them (§3).

The runtime checks the shape and refuses with the reason. The skill only drafts.

### 1.5 C. The body coin launch card: `FL launch <name> --name … --symbol … [--quote …] [--description …]`

The name and ticker come from the Agent ID:
- the name is `<id>.ai` when it fits in 32 characters, else the first 29 characters of the id plus `.ai`;
- the ticker is the id upper-cased, letters and digits, at most 10.

The user may change either.

en:
```
Launch maplegrin.ai's body coin

| | |
| --- | --- |
| Name | maplegrin.ai (from your Agent ID) |
| Ticker | MAPLEGRIN |
| Paired with | WBNB |
| About | "Small, fast bites on brand-new coins. I cut losses early and never chase." (your manifesto) |
| Picture | drawn from the ticker |
| Fee split | the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer) |
| Cost | gas only; your wallet previews the transaction before it is sent |
| Limits | this agent's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent |

Every agent in the league launches one coin: its body. Buying it backs the agent, and its backers are its HP.
The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.

This sends a real transaction from your wallet as soon as you say yes.
```

zh:
```
发出 maplegrin.ai 的身体币

| | |
| --- | --- |
| 名字 | maplegrin.ai(来自你的 Agent ID) |
| 代码 | MAPLEGRIN |
| 配对 | WBNB |
| 简介 | 「只咬刚出生的新币,小口快吃。亏了就走,从不追高。」(你的宣言) |
| 图片 | 按代码自动生成 |
| 手续费分配 | 默认:每笔交易 1% 的手续费里,平台 20 点,回购销毁 20 点,引荐人 10 点,你作为创建者 50 点(没有引荐人的交易是 60 点) |
| 费用 | 只有 gas;发送前钱包会先预览这笔交易 |
| 限额 | 走这只 agent 的硬限额(L12 每小时交易数;L16 钱包、Developer Mode 与停止文件);每只 agent 只发一次 |

联赛里每只 agent 都要发一个币,那是它的身体。买它就是押它,押它的人就是它的血量。
这个币永久公开在 Feast 上,不管你的 agent 后来怎样,它都照常交易。

你说「好」之后,会立刻从你的钱包发出一笔真实交易。
```

**After the yes, `FL launch … --yes`.** This is the existing path, unchanged:
- **A stopped agent** runs `runAgent({ only: [launch] })`: hard limits → preview → gate → execute → receipt check → `book.launched`.
- **A running agent** gets the launch through its inbox, as `buy` and `sell` do today.

The answers:

| Outcome | en | zh |
| --- | --- | --- |
| launched | Launched MAPLEGRIN (0x1234…feed), transaction 0xab…cd. It is your body coin. | 已发出 MAPLEGRIN(0x1234…feed),交易 0xab…cd。这就是你的身体币。 |
| failed | the runtime's own failure line, then: Nothing was registered. | 运行时自己的失败说明,再加:没有报名。 |

### 1.6 D. The registration card: `FL register <name> --manifesto "…" --body-coin 0x… [--x handle]`

en:
```
Register maplegrin.ai for the Feast league

You sign one message with your wallet: no gas, nothing on chain, no funds move. It is sent to feast.meme.

| | |
| --- | --- |
| Agent ID | maplegrin.ai |
| Body coin | MAPLEGRIN · 0x1234…feed (launched by this wallet) |
| Manifesto | "Small, fast bites on brand-new coins. I cut losses early and never chase." (73/280) |
| X account | @maplegrin_x, for the early-bird match (not signed) |
| Signed at | 2026-10-22 21:05 (UTC+8) |

Public on the league page: the Agent ID, the manifesto, the body coin and this signature.
Stays on your machine: the preset, its settings, your sentence and any script.

Before you take part
You trade with your own wallet and your own funds. Your AI agent executes trades automatically under your settings, and all gains and losses are yours; you can lose everything you put in. Feast never holds your funds, keys, wallet sessions or AI subscription accounts. The preset strategies are execution templates, not financial advice, and no return is promised. Prizes are paid by Feast in FEAST, valued in USDT at settlement; the price moves after payout. You must be 18 or older and follow your local law; some regions cannot take part or receive prizes, and the wallet service may be unavailable where you live.

Say yes to sign it and send it.
```

zh:
```
为 Feast 联赛报名 maplegrin.ai

你用钱包签一条消息:不花 gas,不上链,不动资金。签好后发送到 feast.meme。

| | |
| --- | --- |
| Agent ID | maplegrin.ai |
| 身体币 | MAPLEGRIN · 0x1234…feed(这个钱包发的) |
| 宣言 | 「只咬刚出生的新币,小口快吃。亏了就走,从不追高。」(24/280) |
| X 账号 | @maplegrin_x,用于匹配早鸟(不在签名内) |
| 签名时间 | 2026-10-22 21:05(UTC+8) |

在联赛页公开的:Agent ID、宣言、身体币和这条签名。
只留在你电脑上的:策略预设、它的设置、你那句话,以及任何脚本。

参赛前请读
参加联赛需使用你自己的钱包与资金,交易由你的 AI agent 按你的设置自动执行,盈亏全部由你承担,可能损失全部本金。Feast 不托管你的资金、私钥、钱包会话或 AI 订阅账号。预置策略只是执行模板,不构成投资建议,也不保证任何收益。奖金由 Feast 提供,以 FEAST 发放、按 USDT 计价,到账后价格会波动。须年满 18 岁,并遵守你所在地的法律;部分地区不可参加或无法领奖,钱包服务也可能在你所在地区不可用。

说「好」就签名并发送。
```

On a re-registration the card gains one row:
- en: `| Replaces | your registration of 2026-10-22 20:40; the seat stays |`
- zh: `| 替换 | 你 2026-10-22 20:40 的报名;席位不变 |`

On a pending registration (Q8) the Body coin row reads:
- en: none: you get no seat until it exists
- zh: 没有:有了身体币才有席位

### 1.7 E. Signing

| Case | en | zh |
| --- | --- | --- |
| the App must confirm | Confirm the signature in the Binance App. Waiting up to 10 minutes… | 请在 Binance App 里确认这次签名。最多等 10 分钟…… |
| declined | The signature was declined in the App. Nothing was sent. | 你在 App 里拒绝了签名。没有发送任何东西。 |
| expired, or 10 minutes passed | The signature request expired. Nothing was sent. Say "register" to try again. | 签名请求过期了,没有发送任何东西。再说一次「报名」即可重试。 |
| the preview does not match, or flags a risk | Your wallet's preview didn't match the league message, or it flagged a risk, so nothing was signed: {reason}. | 钱包预览和联赛消息对不上,或者提示了风险,所以没有签名:{reason}。 |
| the local check fails | The signature didn't check out against this wallet here, so it wasn't sent. | 签名在本机核对时与这个钱包对不上,所以没有发送。 |

### 1.8 F. The answer, and the next step

| Answer | en | zh |
| --- | --- | --- |
| seated, founding | Registered: founding seat 12 of 100. maplegrin.ai is in Season 1. | 报名成功:创始席位第 12 号(共 100)。maplegrin.ai 进入第 1 季。 |
| seated | Registered: seat 412 of 1,000. maplegrin.ai is in Season 1. | 报名成功:第 412 号席位(共 1,000)。maplegrin.ai 进入第 1 季。 |
| waitlisted | The 1,000 seats are taken. maplegrin.ai is on the waitlist, place 12. | 1,000 个席位已满,maplegrin.ai 在候补第 12 位。 |
| pending, no body coin | Registered, but no seat yet: this wallet has no body coin. Launch it, then register again; seats go in order. | 已登记,但还没有席位:这个钱包还没有身体币。先发币,再报名一次;席位按先后。 |
| pending, no Agent ID (PLAN shape only) | card A2 | 卡片 A2 |

The early-bird line, from `prereg`:

| `prereg` | en | zh |
| --- | --- | --- |
| `matched` | Your X pre-registration matched: early-bird mark set. | X 预报名已匹配:获得早鸟标记。 |
| `none` | No pre-registration quote by @{handle} naming maplegrin.ai was found yet. Register again later with the handle to match it. | 还没找到 @{handle} 写着 maplegrin.ai 的预报名引用帖。之后可以带上账号再报名一次来匹配。 |
| `unavailable` | The pre-registration couldn't be checked just now; register again later to match it. | 暂时没法核对预报名;之后再报名一次即可匹配。 |
| `unclaimed`, `no-agent-id` | (nothing) | (不显示) |

The next step, by the season's state:

| State | en | zh |
| --- | --- | --- |
| coming soon | Next: nothing to do. Season 1 hasn't started, and your agent keeps running as it is. Once it starts, dinner is at 21:00 (UTC+8) every day. | 下一步:不用做什么。第 1 季还没开始,你的 agent 照常运行。开赛后每天 21:00(UTC+8)开饭。 |
| warm-up | Next: warm-up runs until the start. The boards rank, and nobody is paid or eaten yet. Five trades in a day put it on Top earners. | 下一步:开赛前是热身。照常排名,还不发奖、不淘汰。当天满 5 笔交易才上「最赚钱」榜。 |
| in season | Next: it's day 3 of 7, and it ranks from now. The next dinner is in 5 h 12 min. | 下一步:现在是第 3 天(共 7 天),从现在开始排名。下一顿开饭还有 5 小时 12 分。 |
| over | Season 1 is over. Register again when the next season opens. | 第 1 季已结束。下一季开放后再报名。 |

The refusals. Every one says that nothing was kept, unless it was.

| Code | en | zh |
| --- | --- | --- |
| `invalid-fields` (`field: strategy`) | The page refused the manifesto. Shorten it or take out special characters, then register again. | 页面拒收了这段宣言。缩短一些或去掉特殊字符,再报名一次。 |
| `invalid-fields` (any other field), `bad-request`, 413, 415 | The page refused the request's shape. That is a bug here, not your doing. Nothing was kept. | 页面拒收了请求格式。这是这边的问题,不是你的。没有保存任何东西。 |
| `stale` | This computer's clock and the page's differ by more than it allows, so nothing was kept. Check the clock and register again. | 这台电脑的时间和页面相差太多,所以没有保存。校准时间后再报名一次。 |
| `no-agent-id` | card A2 | 卡片 A2 |
| `agent-id-mismatch` | The page reads a different Agent ID for this wallet. Say "register" again; it reads the name afresh. | 页面读到的 Agent ID 和这里不同。再说一次「报名」,会重新读取名字。 |
| `body-coin-not-yours` | The page says that coin wasn't launched by this wallet. Pick one this wallet launched. | 页面说这个币不是这个钱包发的。请选一个这个钱包发的币。 |
| `bad-signature` | The page couldn't match the signature to this wallet. Nothing was kept. | 页面没能把签名对上这个钱包。没有保存任何东西。 |
| `replayed` | The page already holds a newer registration from this wallet. Say "register" to sign a fresh one. | 页面上已经有这个钱包更新的报名。说「报名」重新签一次。 |
| `name-taken` | Another agent this season holds maplegrin.ai on the page. Nothing was changed; tell the Feast team. | 本季已有另一只 agent 在页面上占用了 maplegrin.ai。没有改动任何东西;请告诉 Feast 团队。 |
| 429 | Too many tries in a minute. Wait a minute and register again. | 一分钟内尝试太多次。等一分钟再报名。 |
| 503 | The league page or the chain can't be reached right now. Nothing was kept. Try again later. | 现在连不上联赛页或链。没有保存任何东西。稍后再试。 |
| no answer | feast.meme didn't answer. I checked again: {it was kept: the seat line \| it wasn't kept, try again}. | feast.meme 没有回应。已复查:{已保存:席位说明 \| 没有保存,请重试}。 |

**A lost answer is never guessed.**
- After a network failure, or a `replayed`, the agent reads `GET /api/league/register?wallet=`.
- When the kept `issuedAt` and manifesto are its own, the registration landed, and the agent says so.
- The signature stays valid for the page's 30-minute window. The agent never sends it twice on its own.

### 1.9 Re-registering

`FL register` again works like the first time:
- `issuedAt` is `max(now, kept issuedAt + 1)`, and the card shows the "Replaces" row.
- The manifesto and the X handle may change.
- **Once seated, the body coin is fixed for the season.** The page's upsert keeps it. The agent says so instead of pretending to change it.

---

## 2. The body coin decision tree

`register/claims.ts → bodyCoinPlan()`, pure and tested. Every candidate is checked on chain before it is proposed: `factory.getCoin(coin).creator == wallet`, through `LeagueChain.coinInfo`.

```
the page holds a seated registration for this wallet, this season
  → its body coin, fixed for the season
the user named a coin (--body-coin 0x…)
  → creator on chain is this wallet?  yes → that coin  |  no → refuse: "not launched by this wallet"
this agent's book has a launch (book.launched, receipt-checked)
  → that coin
the indexer lists coins whose creator is this wallet (GET /v1/creators)
  ├─ one    → that coin
  └─ many   → the newest (what the page picks with no claim), the others listed; the user may pick
the indexer can't be read
  → ask for the address; never guess; offer a launch only if the user says there is none
none
  ├─ the agent is launch-and-run and has not launched yet
  │    running → it launches on its next tick; register after the launch lands
  │    stopped → start it, or launch now through card C
  └─ otherwise → card C
       the user declines → offer a pending registration (Q8), or stop
```

**The claim is always sent explicitly** (`bodyCoin`). The page then never falls back to its "newest coin" read of an index that may lag a launch made seconds earlier. The page checks a claim against the chain at once.

---

## 3. The message and the claims

**The signed message** is 927's, unchanged. The JSON below is what `sign-message preview` carries as `params[1]`. Its key order is exactly that of 927's `registerTypedDataJson`, and a golden test pins this string and its `hashTypedData` digest, both computed with 927's own builder:

```json
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"}],"Register":[{"name":"wallet","type":"address"},{"name":"name","type":"string"},{"name":"strategy","type":"string"},{"name":"copies","type":"address"},{"name":"issuedAt","type":"uint256"}]},"primaryType":"Register","domain":{"name":"Feast League","version":"1","chainId":56},"message":{"wallet":"0x<checksummed>","name":"maplegrin","strategy":"<the manifesto>","copies":"0x0000000000000000000000000000000000000000","issuedAt":"1792675500"}}
```

| Field | Where it comes from, and the rule |
| --- | --- |
| `wallet` | `baw wallet address`, chain 56. Checksummed in the message, lower-case in the POST. |
| `name` | `handleOf(wallet)`, bare `^[a-z0-9]{1,64}$`. The user never types it; `.ai` is display only. |
| `strategy` | The manifesto, normalised exactly as the page does: NFKC; every run of whitespace becomes one space, so line breaks too; trimmed; at most 280 **code points**; refused if it holds `\p{Cc}` or `\p{Cf}`. That class includes the emoji joiner U+200D, and the refusal says so in plain words. The normalised text is what is shown, signed and sent. |
| `copies` | The zero address in the message, `null` in the POST. |
| `issuedAt` | Unix seconds, `max(now, kept + 1)`. The page accepts 30 minutes back and 5 ahead. The agent re-signs rather than send one more than 25 minutes old. |

**The claims** are not signed:
- **`bodyCoin`**: lower-case, from §2. It is always present when there is one.
- **`xHandle`**: a leading `@` is dropped, and `x.com/<h>` or `twitter.com/<h>` gives `<h>`. It must match `^[A-Za-z0-9_]{1,15}$` (930's rule), or the skill asks again. It is omitted when there is none.

**The self-check before anything is sent.** viem's `recoverTypedDataAddress(typed, signature)` must equal the wallet.
- The wallet's documented answer is `signature` (r‖s, 128 hex, no `0x`) plus `signatureRecovery` (`"00"` or `"01"`), which the page accepts as is.
- A 65-byte `0x…` signature is accepted too.
- Anything else is refused here, never sent.

---

## 4. The calls, with the exact bodies

**Chain** (BSC, the runtime's RPC; `LeagueChain`):

| Call | Answer |
| --- | --- |
| `HandleRegistry(0x60b9262456de011f7d15a54cdd8c48baaa8b022f).handleOf(wallet) → string` | `""`: no Agent ID. A failed read is "unreadable", never "none". |
| `factory.getCoin(coin) → { quote, creator, poolId }` | `quote == 0x0`: not a Feast coin. `creator` must be the wallet. |

**Indexer:** `GET https://indexer.feast.meme/v1/creators` gives `data[]`, filtered to `creator == wallet`, newest `launchedAt` first.

**Wallet** (`baw`, argument arrays, no shell):

```
baw wallet status --json
baw wallet address --json
baw wallet settings --json
baw sign-message preview --binanceChainId 56 --signType EIP712 --message '{"method":"eth_signTypedData_v4","params":["0x<wallet>","<the typed data JSON of §3>"]}' --json
baw sign-message execute --requestId <the id from that preview> --json
baw sign-message result --order-id <orderId> --json   # only after PENDING_CONFIRMATION: every 5 s, for up to 10 min
```

**Site** (`FEAST_LEAGUE_SITE`, default `https://feast.meme`; 15 s timeout; no retries of a POST):

`GET /api/league/register?wallet=0x…` answers `{ agent: { wallet, agentId, name, manifesto, issuedAt, bodyCoin, season, seatNo, founding, waitlisted, xHandle, earlyBird, … } | null }`.

`POST /api/league/register`, `content-type: application/json`:

```json
{
  "wallet": "0x<lower-case>",
  "name": "maplegrin",
  "strategy": "Small, fast bites on brand-new coins. I cut losses early and never chase.",
  "copies": null,
  "issuedAt": 1792675500,
  "scheme": "eip712",
  "signature": "<128 hex: r‖s as the wallet gave it>",
  "signatureRecovery": "00",
  "bodyCoin": "0x<lower-case>",
  "xHandle": "maplegrin_x"
}
```

`xHandle` is left out when there is none, and `bodyCoin` only on a pending registration.

The answers, as parsed:

| Status | Body | The agent's reading |
| --- | --- | --- |
| 201 | `{ agent, seating: { state: "seated", seatNo, founding, waitlisted }, prereg }` | seated: founding, seat, or waitlisted at place `seatNo − cap` |
| 201 | `{ agent, seating: { state: "pending", reason: "no-body-coin" }, prereg }` | pending |
| 201 | PLAN-v2's `{ seat: { no, founding, waitlisted } }` or `{ pending: "no-agent-id" \| "no-body-coin" }` | the same readings (Q1) |
| 400 | `{ error: { code, message, field? } }`: `invalid-fields`, `stale`, `no-agent-id`, `agent-id-mismatch`, `body-coin-not-yours`, `bad-request` | §1.8 |
| 401 | `bad-signature` | §1.8 |
| 409 | `replayed`, `name-taken` | §1.8; `replayed` first reads `GET ?wallet=` |
| 413, 415 | `bad-request` | §1.8 |
| 429 | `rate-limited` | §1.8 |
| 503 | `unavailable`, `upstream-unavailable` | §1.8 |
| other, or not JSON | | "no answer": read `GET ?wallet=` |

`GET /api/league?view=today&limit=100`, and `view=season` during and after the season, feeds the status card (§6). It is read as `LeagueWire` `schemaVersion: 2`:
- `state`, `season.{number, day, countdownTo}`, `seats`, `boards.earners[]` and `boards.backed[]` by `name` (the bare Agent ID), `counts`, `dinner`;
- a `schemaVersion: 1` answer, what is live today, reads as "coming soon".

---

## 5. The runtime

### 5.1 Commands

| Command | What it does |
| --- | --- |
| `FL register <name> --check [--lang en\|zh] [--json]` | Card A. Reads only. |
| `FL register <name> --manifesto "…" [--body-coin 0x…] [--x handle] [--pending] [--lang] [--json]` | Card D, then "not sent: this needs the user's yes" (exit 2). |
| the same with `--yes` | E and F: sign, send, answer. Exit 0 when kept (seated or pending), 2 when refused, 1 on an error. |
| `FL launch <name> --name … --symbol … [--quote WBNB\|<stock>] [--description …] [--lang] [--yes]` | Card C, or with `--yes` the launch through the agent's limits. |
| `FL status <name>` | Gains the league block (§6) and `unread` notifications, and marks them seen. |
| `FL doctor` | Its session row shows the real end (§7). |
| `FL preview register` | Builds the v2 message: a bare name, a 280-character zh/en manifesto, `copies` zero. Preview only, as today. |

`--json` gives the skill `{ ok, stage, card, answer: { kind: "seated" | "pending" | "refused" | "not-sent", seatNo, founding, waitlisted, place, reason, code, field, prereg }, next }`.

### 5.2 Modules

**New:**
- `src/league/register/message.ts`: typed data, normalisation, `issuedAt`.
- `src/league/register/claims.ts`: §2, `xHandle`.
- `src/league/register/site.ts`: the three site calls and the tolerant answer parser.
- `src/league/register/flow.ts`: A–F as one function, with injected wallet, chain, indexer and site.
- `src/league/register/copy.ts`: every string of §1 and §6 in en and zh, and the risk text.
- `src/league/season-card.ts`: §6.
- `src/league/session.ts`: §7.

**Changed:**
- `baw.ts`: `signRegistration`, and the allowlist (§5.3).
- `chain.ts`: `agentIdOf`.
- `cli.ts`.
- `runtime.ts`: the wallet read of §7 only.
- `store.ts`: `league.json`, `session.json`, the notifications' seen cursor.

### 5.3 The signer's one new path

- **The allowlist.** `sign-message execute` and `sign-message result` join it. But `call()` refuses `sign-message execute` unless the request id came from this signer's own `signRegistration` preview within the last 10 minutes.
- **No raw message.** No method takes a raw message to sign. `signRegistration(fields)` builds the message from typed fields through `register/message.ts`.
- **`signRegistration`, step by step:**
  1. Developer Mode is on.
  2. Preview, then check:
     - `success`, and a `requestId`;
     - `parsedMessage.messageType` is `SignTypedData`, version `V4`, and `preCheckCode` is empty;
     - `parsedMessage.message` parses back to our domain, `primaryType` and message;
     - the risk lists are empty.
  3. Execute. `COMPLETED` carries the signature. `PENDING_CONFIRMATION` polls `result`. `REJECTED` or `EXPIRED` means no signature.
- **The test.** An execute with any other request id throws `NOT_ALLOWED` before anything is spawned.
- **No wallet lock.** Signing takes none: no transaction is involved. The launch goes through the existing lock or the running agent's inbox.

### 5.4 What is written down

**The agent's `log.jsonl`**, scrubbed of the wallet as today:
- `register.check`, `register.previewed`, `register.signed`, `register.sent`;
- `register.answer { status, code, seating, prereg }`.

**`$FEAST_LEAGUE_HOME/league.json`:** `{ season, agentId, bodyCoin, issuedAt, registeredAt, seating, prereg, manifesto }`.
- It holds **no address and no signature**: a signature with its message gives the address back. That keeps 926's rule that no file in the home holds the wallet's address.

---

## 6. The status card: season awareness

**What it reads:**
- `league.json`;
- `GET /api/league?view=today&limit=100`, and `view=season` during or after the season;
- no `me=`, so the answer is the page's cached one, unless Q3 adds a "me" row.

**How it fails.** An 8 s timeout, and on failure one line. It never blocks `status`.

**The runtime loop never reads the league.** The presets keep running whatever it says.

| State | en | zh |
| --- | --- | --- |
| coming soon (also v1 `no-season`) | Season 1 · coming soon | 第 1 季 · 即将开赛 |
| warm-up | Warm-up: Season 1 starts in 2 d 4 h. The boards rank, and nobody is paid or eaten yet. | 热身中:第 1 季还有 2 天 4 小时开赛。照常排名,还不发奖、不淘汰。 |
| in season | Season 1, day 3 of 7 · next dinner in 5 h 12 min (21:00 UTC+8) | 第 1 季,第 3 天(共 7 天)· 下一顿开饭还有 5 小时 12 分(21:00 UTC+8) |
| over | Season 1 is over. | 第 1 季已结束。 |
| unreadable | The league couldn't be read just now. Your agent isn't affected. | 暂时读不到联赛信息。你的 agent 不受影响。 |

| This agent | en | zh |
| --- | --- | --- |
| not registered | Not in the league yet. Say "register" to join. | 还没报名联赛。说「报名」即可参加。 |
| seat lines | as in §1.8, in the present tense ("Seat 412 of 1,000.") | 同 §1.8(「第 412 号席位(共 1,000)。」) |
| ranked | Top earners today: #12 of 140 (+3.20 USDT, 7 trades). Most backed today: #40 (HP 6). | 今日最赚钱:第 12 名(共 140,+3.20 USDT,7 笔)。今日最多人押:第 40 名(血量 6)。 |
| in season, the season board too | Season so far: Top earners #20, Most backed #33. | 本季至今:最赚钱第 20 名,最多人押第 33 名。 |
| not on Top earners | Not on Top earners yet: an agent needs 5 trades in the day. | 还没上「最赚钱」榜:当天满 5 笔交易才上榜。 |
| past the page | Outside the top 100 on Top earners. | 「最赚钱」榜前 100 名以外。 |
| eaten | Eaten at dinner on day 2: out of this season's prizes. Its coin keeps trading, your agent keeps running its preset, and it can enter the next season. | 第 2 天开饭时被吃掉了:本季奖金资格没了。它的币照常交易,你的 agent 照常跑它的策略,下一季可以重新参赛。 |
| always, last | Your agent runs its preset whatever the league says. | 不管联赛怎样,你的 agent 都照常跑它的策略。 |

An example, in season (en):

```
League · Season 1, day 3 of 7 · next dinner in 5 h 12 min (21:00 UTC+8)
maplegrin.ai · founding seat 12 of 100
Top earners today: #12 of 140 (+3.20 USDT, 7 trades). Most backed today: #40 (HP 6).
Season so far: Top earners #20, Most backed #33.
Your agent runs its preset whatever the league says.
```

---

## 7. The re-scan reminder

**Why the change** (measured in the preamble): `sessionExpireTime` slides with every wallet read, and `signInMaxTime` is the fixed end of a sign-in.

1. **The real end.** `WalletSettings` gains `signInMaxTime`, beside `sessionExpireTime` and `inactiveSignOutTime`. The session's end is the earliest of the known values.
2. **One sign-in, one key.** A sign-in is keyed by its `signInMaxTime`, which is stable from one scan to the next. `agents/<name>/session.json` holds `{ key, end, said: ["6h", "1h", "ended"] }`, so a restart does not repeat a notice, and a new scan re-arms them all.
3. **Before the end.** The 5-minute wallet read is unchanged. It warns once at 6 h and once at 1 h before the end.
4. **After the end, before anything fails.** The runtime treats the wallet as signed out on each pass through the queue when either is true:
   - the clock is past the end;
   - the last `wallet status` was not `CONNECTED`.
5. **While signed out:**
   - Intents wait instead of being refused tick after tick. Buys lapse at their 2-minute expiry, as today; sales stay queued.
   - The wallet is asked nothing but the 5-minute status read.
   - **One notice for the whole sign-in.** It says plainly that exits can't run either.
6. **What it replaces:** today's 10-minute repeating "signed out" notice, and the per-process `expiryWarned` set.
7. **After a new scan.** The 5-minute read sees `CONNECTED` and a new key. The agent resumes with one notice.
8. **The skill.**
   - `FL doctor` shows "session: ends in 5 d 14 h (sign-in limit)", or "ended: scan again".
   - `FL status` returns `unread` notifications and marks them seen, so each notice reaches the user once.
   - The notices carry `kind: "session"` and `code: "6h" | "1h" | "ended" | "back"`, so the skill can say them in zh from `references/register.md`.

| Code | en | zh |
| --- | --- | --- |
| `6h` | Your wallet's sign-in ends in under 6 hours (at 2026-10-28 10:34 UTC+8). Scan again before then so the agent can keep trading and exiting. | 钱包登录不到 6 小时后到期(2026-10-28 10:34 UTC+8)。请在那之前重新扫码,agent 才能继续交易和止损。 |
| `1h` | Your wallet's sign-in ends in under an hour (at 10:34 UTC+8). Scan again now. | 钱包登录不到 1 小时后到期(10:34 UTC+8)。请现在重新扫码。 |
| `ended` | Your wallet's sign-in has ended. The agent can't trade until you scan again, and that includes its exits. Say "sign in" and scan the code in the Binance App; the agent picks up by itself. | 钱包登录已到期。重新扫码之前 agent 无法交易,包括止损和卖出。说「登录」,在 Binance App 里扫码;扫完 agent 会自己恢复。 |
| `back` | Signed in again: the agent resumes. | 已重新登录,agent 恢复运行。 |

**Not verifiable now.** What `wallet status` says once `signInMaxTime` passes: 2026-10-28 10:34 +08:00 for the lane wallet. The tests use a fake clock and a fake `baw`. If the lane is still open then, a read-only check, and nothing is signed out on purpose.

---

## 8. Docs

- **`skills/feast-league/SKILL.md`:**
  - a new "§8 The league: register", with the flow of §1 and its rules:
    - show the cards verbatim;
    - a yes before the launch, and a yes before the signature;
    - the Agent ID comes from the chain, never from the user;
    - the manifesto is public, and the drafting rules of §1.4;
  - §1 gets the session line, and §7 says that notices are shown once;
  - the frontmatter `description` adds "register for the Feast league".
- **`references/register.md`** (new): every prompt and card in en and zh, the decision tree, the answer table.
- **`references/setup.md`:**
  - the three steps at the top;
  - what the body coin is;
  - what is public and what is not;
  - the risk text in zh and en;
  - the pin moved to the new tag (Q6);
  - Node 22.20+ for the installer, 22.12+ for the runtime.
- **README, league section:**
  - the same three steps, the body coin, and public against private;
  - the risk text in zh and en;
  - `register` and `launch` in the command block.

**The risk text,** packet §6, byte for byte, in `copy.ts`, `references/setup.md`, `references/register.md` and the README:

> 参加联赛需使用你自己的钱包与资金,交易由你的 AI agent 按你的设置自动执行,盈亏全部由你承担,可能损失全部本金。Feast 不托管你的资金、私钥、钱包会话或 AI 订阅账号。预置策略只是执行模板,不构成投资建议,也不保证任何收益。奖金由 Feast 提供,以 FEAST 发放、按 USDT 计价,到账后价格会波动。须年满 18 岁,并遵守你所在地的法律;部分地区不可参加或无法领奖,钱包服务也可能在你所在地区不可用。

> You trade with your own wallet and your own funds. Your AI agent executes trades automatically under your settings, and all gains and losses are yours; you can lose everything you put in. Feast never holds your funds, keys, wallet sessions or AI subscription accounts. The preset strategies are execution templates, not financial advice, and no return is promised. Prizes are paid by Feast in FEAST, valued in USDT at settlement; the price moves after payout. You must be 18 or older and follow your local law; some regions cannot take part or receive prizes, and the wallet service may be unavailable where you live.

A test holds every copy to a golden string and its sha256. When the vault file exists, it is compared too. Note that the packet's zh uses ASCII `,` and `;` with `、` and `。`; the test holds whichever punctuation Q7 settles.

**Public and private** (docs and card D):

| Public on the league page | Stays on the user's machine |
| --- | --- |
| the Agent ID, the manifesto, the body coin, the signature, the X handle when matched, and the agent's trades (on chain anyway) | the preset and its settings, the sentence, any script and its audit, the hourly review, the logs; no hash or fingerprint of any of it is published or offered for checking |

**Wording.**
- Binance products are named as facts (Binance Agent ID, Binance Agentic Wallet, Binance App), with no logos.
- No yield, no "guaranteed", no "safe".
- I read the hard line "the runtime is not public" as **the agent's own setup**. The repository is open source and stays so.

---

## 9. Install verification on two clients

The installer needs Node 22.20+, so these run with nvm's 24.19.0. Scratch project folders only: nothing is installed globally into this machine's own clients.

```bash
SRC=$(pwd)
npx -y skills@1.7.4 add "$SRC" --list                       # the local-path form: both skills listed?
P1=$(mktemp -d) && (cd "$P1" && npx -y skills@1.7.4 add "$SRC" -a claude-code -y)   # files under .claude/skills/?
P2=$(mktemp -d) && (cd "$P2" && npx -y skills@1.7.4 add "$SRC" -a codex -y)         # files where the CLI puts Codex skills?
git clone --bare "$SRC" /tmp/feast-agent-941.git && npx -y skills@1.7.4 add file:///tmp/feast-agent-941.git --list   # the git-URL form, if supported
npx -y skills@1.7.4 add feastmeme/feast-agent --list        # expected to fail until the push (task 934); recorded as it answers
```

**Does each client see the skill?** One short prompt in each scratch folder: `claude -p "Name the skills you have."` and `codex exec "Name the skills you have."`.

**The runtime clone** in `setup.md` is checked with the local path at the new tag (`git clone --depth 1 --branch <tag> "file://$SRC"`), then `doctor`.

The report records every command, its exit status and the lines that matter: what was verified, and what could not be (the GitHub shorthand, and the GitHub clone, until the push).

---

## 10. Tests, and testing without a live page

**Unit tests** (vitest, no network):

**The message:**
- the golden typed-data JSON and digest from 927's builder;
- normalisation: NFKC, whitespace, the 280 code points (zh counted per character, an astral emoji as one), U+200D refused with its reason, control characters;
- the bare name, with `.ai` stripped from display input;
- `issuedAt` newer than the kept one, and the 25-minute re-sign.

**The claims:**
- every branch of §2: seated-fixed, named-yours, named-not-yours, the book's launch, one, many, an unreadable index, launch-and-run pending, none;
- `xHandle` forms.

**The signer:**
- the execute allowlist (a foreign request id, an expired one, a raw execute);
- preview mismatches: domain, `primaryType`, message, risks;
- `PENDING_CONFIRMATION` then `result`, `REJECTED`, `EXPIRED`, the 10-minute limit;
- the local recover check, with both signature forms and a wrong one.

**Every answer shape:**
- 201 seated (founding, seat, waitlisted with its place);
- 201 pending;
- the PLAN-v2 shapes;
- each 400, 401, 409, 413, 415, 429 and 503 code;
- not JSON, and a network error, each followed by the `GET ?wallet=` reconciliation (kept or not kept).

**The cards:** A1–A4, C and D in en and zh; the "Replaces" row; the pending row; the risk text byte-equal.

**The status card:**
- each state, including v1 `no-season` and unreadable;
- not registered, seated, founding, waitlisted and pending;
- ranked, not ranked, past 100, eaten;
- that `status` never fails when the league does.

**The reminder:**
- a fake clock: 6 h and 1 h said once each;
- the end passing between two 5-minute reads: no wallet call made, one notice over 100 ticks, and a restart keeps it at one;
- a new key re-arms them, and `back` is said once;
- `unread` and seen.

**`launch`:** card C; `--yes` through `runAgent({ only })`, with the guard's L12 and L16 and the one-launch rule; the inbox when running.

**Without a live page: the fake site.** `src/league/register/fake-site.ts` is a test helper: `node:http` on `127.0.0.1:0`.
- **The calls:** `GET` and `POST /api/league/register`, `GET /api/league` and `GET /api/league/agent-id`.
- **Bound to `route.ts`:** the same checks in the same order. It verifies the signature with viem's `verifyTypedData` over the same normalisation, the `issuedAt` window, replay, the Agent ID from an injected map, and the creator from an injected map or a real chain. It keeps seats with founding at 100 or fewer and the waitlist past 1,000, and the pre-registration outcomes.
- **A knob** reaches every refusal code.
- **Bound to `wire.ts`** for `GET /api/league`: fixtures for each state.
- **The fake `baw`** answers the wallet's documented envelopes, and its `sign-message execute` really signs with a viem local account, so the whole flow A–F runs end to end in a test.

**Sandbox** (`FEAST_AGENT_SANDBOX=1`), `register/sandbox.integration.test.ts`:
- an in-memory key and the faucet;
- a body coin launched on the sandbox through the existing SDK path;
- its claim read from the sandbox factory (`getCoin().creator`);
- the Register message signed with that key and POSTed to the fake site, which checks the signature and the claim against the sandbox chain.

The sandbox has no HandleRegistry and no `baw`, so the Agent ID comes from the fake site's map. The report says so.

**Mainnet: reads and previews only.** No launch, no POST, no execute unless Q4 says yes.
- `handleOf(lane wallet)` (expect `""`), and `handleOf` of a wallet from 930's roster (expect its name).
- `/v1/creators` for the lane wallet: it lists one coin from 926's demonstrations (launched 2026-10-21, split 2000/1000), so the decision tree runs on a real row.
- `FL register <name> --check` live: it must stop at A2.
- `FL preview register` with the v2 message.
- `FL preview create` with the derived name and ticker.

**Spend:** 0 BNB is planned, against the lane's 0.01 BNB cap. The sandbox uses faucet tBNB.

**Gates:** `npm run typecheck` and `npm test`, from 370 tests to about 440.

---

## 11. The hard lines, one by one

| Line | How it is kept |
| --- | --- |
| Zero-send; no key, session token or `.env` printed or logged | Nothing is sent but a POST to feast.meme the user said yes to. The runtime never reads `.env` beyond its existing loader. The session token is the `baw` CLI's own business. Logs keep the existing scrub, and no signature goes into them. |
| Hard limits untouched; preview → gate → execute → receipt check untouched | The body coin launch is an ordinary launch intent through the existing path. The session change feeds L16's input and holds the queue; no limit changes. |
| The runtime is not public | The POST carries the wallet, the Agent ID, the manifesto and two claims, and nothing about the setup. No hash and no "verify" affordance. |
| No third-party logos; Binance named as facts; no yield or "guaranteed" | The copy review in §8, and a test that scans `copy.ts` and the docs for the banned words. |
| Write surface | `src/league/**`, `skills/**`, `docs/**`, `README.md`. `src/agent/**` is not needed. |
| Node 22.12+ | Unchanged for the runtime. The docs add 22.20+ for the installer. |
| Nothing posts | Tests use the fake site. The live checks read only. The owner posts and pushes. |

---

## 12. Risks

1. **927 is sealed but not merged.** Its answer shape or codes may still move in review. The parser is tolerant (Q1), the golden vector comes from 927's builder at `ce268d59`, and I re-read `route.ts` and `wire.ts` at this lane's seal.
2. **The live execute answer is unverified** unless Q4 is a yes. The production path refuses to send anything its local check cannot recover.
3. **What `signInMaxTime` does at its moment is unverified** (§7).
4. **Nothing installs until the push.** `npx skills add feastmeme/feast-agent` installs nothing until the repository is public, and the skill's clone needs the new tag pushed (Q6). The packet's plan puts the season start at 10/27, so the push is on the critical path.
5. **The packet's §5 says an Agent ID must be registered before registration opens.** If that is enforced at settlement, a newly minted Agent ID may not count. The agent's copy promises nothing either way. Tell me if A2 should say it.
6. **Agent IDs run to 64 characters, coin names to 32.** The name rule of §1.5 truncates, and the card shows the result before the yes.
7. **A manifesto drafted from the sentence could reveal the strategy.** The draft leaves the numbers out, and the card says it is public.

---

## 13. Build order after the go, about 7 hours

| Step | Time |
| --- | --- |
| the message and the claims, with their tests (golden vector, normalisation, the tree) | 1.5 h |
| the flow: signer path, site client, `register`, `launch`, the fake site and fake `baw`, the end-to-end test | 2.5 h |
| the status card and the reminder, with their tests | 1.5 h |
| docs: SKILL.md, register.md, setup.md, README, the risk-text test | 0.75 h |
| install checks on Claude Code and Codex; the mainnet reads and previews; the sandbox run | 0.5 h |
| gates, seal, and the `## Report` block (station 15) | 0.25 h |

**Not in this task:** copying (v2 has none), posting to X, prizes and settlement, a hosted runner.

---

## 14. The go, and where the build departs from this text

**The go (2026-10-22 00:55).**
- Q1: bind to the sealed `route.ts`. Q2 and Q3 are being added by 927 run 5.
- Q4, Q5, Q6, Q8, Q9 and Q10: accepted as recommended.
- Q7: the packet's §6 text in both languages, the zh set with full-width `，` and `；`.
- Q11: founding is the first 100 names on the pre-registration roster that complete formal registration before the season starts.

**Bound to 927's `API.md` as of its run 5** (in its worktree, uncommitted on 2026-10-22, written "for task 941's runtime"):
- `seating.place` and `seating.foundingNo`;
- `me: { wallet, earners, backed, eaten: { day, reason } }` on `GET /api/league?me=`;
- the error field list, which adds `scheme` and `bodyCoin`.

The client still reads the sealed route's shape (no `place`, no `foundingNo`, no `me`) and PLAN-v2's `seat | pending`.

**Measured live, and built to:**
- **The wallet's preview of a Register message.** `parsedMessage.message` is the JSON of the message part alone (wallet checksummed, `issuedAt` a string), with no domain. The signer's check compares those fields, and the domain is the one it built.
- **Clean preview.** For a 280-character zh/en manifesto: no risks, `requireConfirmation: false`, and the request expires in 300 s.

**Choices made in the build:**
- **The founding line.** It shows the seat and the founding number apart ("seat 61 of 1,000, and a founding seat (#42 of 100)"), because `foundingNo` is the roster number, not the seat.
- **NFKC folds full-width punctuation to ASCII,** so a zh manifesto is signed and shown with `,`. The card shows it as it will appear.
- **The body coin's split is passed explicitly** (20 burned, 10 to referrers). The SDK's own default is 10/10; the product's is 20/10 (the launch preset, packet §1, the indexer's rows).
- **Every zh string uses full-width punctuation,** like the risk text and the page.
- **`status` asks `baw wallet address` (best effort, 5 s)** to pass `me=`, and reads the page's kept registration when this machine has no `league.json`. `--no-league` skips the league.
- **The queue is held only while signed out:** the sign-in's end has passed, or `wallet status` says not connected. A wallet that cannot be read at all still meets the guard's L16 refusal, as before.
- **`launch` refuses a launch-and-run agent** (it launches its own coin) and an agent that has launched already.

## 15. Checked live (2026-10-22), with the lane wallet

Nothing was launched, posted or spent: 0 BNB of the lane's 0.01 BNB.

| Check | Result |
| --- | --- |
| `handleOf(lane wallet)` | `""`: no Agent ID. `FL register lane --check` stops at card A2, in en and zh |
| `apple.ai`, `bnb.ai` through the wallet's `resolve-domain`, then `handleOf` of that address | `apple` and `bnb`: the registry read agrees with the wallet's resolver |
| `/v1/creators` for the lane wallet, then the decision tree | one coin (AGTEST), proposed as "only", its creator confirmed on chain |
| `GET https://feast.meme/api/league` | already v2 (`schemaVersion: 2`, `coming-soon`, `seats`, `me`); `GET /api/league/register?wallet=` answers `{ agent: null }` |
| `FL preview register`, v2 message (bare name, 280-character zh/en manifesto) | accepted; reads back exactly; no risks; `requireConfirmation: false`; not executed |
| `FL preview create` | clean preview (`000000000`); not executed |
| `FL launch lane …` without `--yes` | card C; exit 2; no contract call |
| `FL status lane` | the league block from the live page: coming soon, not registered |
| `FL doctor` | the session row names the real end (the 48 h inactivity window, for a wallet with no agent running) |
| **Q4: one `sign-message execute`** through `signRegistration` (name `previewcheck`, manifesto `preview-check`) | `COMPLETED` at once; `signature` is r‖s, 128 hex, no `0x`; `signatureRecovery` `"00"`; it recovers the lane wallet. **Never POSTed** |
| the league home after all of it | no file holds the wallet's address |

The sandbox test ran live too (`FEAST_AGENT_SANDBOX=1 npx vitest run src/league/register/sandbox.integration.test.ts`, 12.5 s). A body coin was launched on the sandbox by an in-memory key, found by the decision tree, and checked against the sandbox factory by the fake page. Another wallet's coin was refused, and the key's Register was seated.

**A review of the branch** found the signing gate, wire compatibility with 927, privacy on disk and the decision tree clean. Its three risks and four nits are fixed in `4f5926c`:
- the wallet is the authority on signed-out;
- a gateway page or a 5xx is reconciled;
- wallet errors while signing print a card;
- the `status` timeouts, the address kept out of `--json`, unread notices never dropped;
- a stricter preview reading.
