import type { Address } from "viem";

import type { BodyCoinPlan } from "./claims.ts";
import { MANIFESTO_MAX, shownName } from "./message.ts";
import type { KeptAgent, LeagueRead, Prereg, Seating } from "./site.ts";

/**
 * Every word the league registration shows a person, in English and Chinese
 * (docs/PLAN-941.md §1, §6, §7). The runtime prints these cards; the skill
 * shows them verbatim. Binance products are named as facts; there is no
 * promise of a return anywhere.
 */

export type Lang = "en" | "zh";
export const langOf = (raw: unknown): Lang => (raw === "zh" ? "zh" : "en");

/**
 * The risk text, packet §6 (judgement-league-rules-20261021.md), byte for byte in
 * its words. The zh is set with full-width ， and ； where the packet has ASCII
 * , and ; (the go's Q7, as the league page sets it). A test holds both.
 */
export const RISK_EN =
  "You trade with your own wallet and your own funds. Your AI agent executes trades automatically under your settings, and all gains and losses are yours; you can lose everything you put in. Feast never holds your funds, keys, wallet sessions or AI subscription accounts. The preset strategies are execution templates, not financial advice, and no return is promised. Prizes are paid by Feast in FEAST, valued in USDT at settlement; the price moves after payout. You must be 18 or older and follow your local law; some regions cannot take part or receive prizes, and the wallet service may be unavailable where you live.";
export const RISK_ZH =
  "参加联赛需使用你自己的钱包与资金，交易由你的 AI agent 按你的设置自动执行，盈亏全部由你承担，可能损失全部本金。Feast 不托管你的资金、私钥、钱包会话或 AI 订阅账号。预置策略只是执行模板，不构成投资建议，也不保证任何收益。奖金由 Feast 提供，以 FEAST 发放、按 USDT 计价，到账后价格会波动。须年满 18 岁，并遵守你所在地的法律；部分地区不可参加或无法领奖，钱包服务也可能在你所在地区不可用。";
export const riskText = (lang: Lang) => (lang === "zh" ? RISK_ZH : RISK_EN);
export const riskHeading = (lang: Lang) => (lang === "zh" ? "参赛前请读" : "Before you take part");

// --- small formats -------------------------------------------------------------------------

const UTC8 = 8 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** A moment as the league states it: UTC+8, the dinner's zone. */
export function utc8(ms: number, withDate = true): string {
  const d = new Date(ms + UTC8);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withDate ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${time}` : time;
}
export const dateOf = (ms: number) => utc8(ms).slice(0, 10);
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4).toLowerCase()}`;
const thousands = (n: number) => n.toLocaleString("en-US");
/** Dollars with their sign, two places: "+3.20", "-1.05". */
export const shortUsd = (n: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" }).format(n);

/** "2 d 4 h", "5 h 12 min", "under a minute" — and in zh. */
export function duration(ms: number, lang: Lang): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(minutes / 1_440);
  const h = Math.floor((minutes % 1_440) / 60);
  const m = minutes % 60;
  if (lang === "zh") {
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return m > 0 ? `${m} 分钟` : "不到 1 分钟";
  }
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return m > 0 ? `${m} min` : "under a minute";
}

const table = (rows: [string, string][]) => ["| | |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "/")} |`)].join("\n");
const quoted = (text: string, lang: Lang) => (lang === "zh" ? `「${text}」` : `"${text}"`);

// --- the season, in one line ---------------------------------------------------------------

/** The season's state as one line (§6), from `GET /api/league`; null: it could not be read. */
export function seasonLine(league: LeagueRead | null, now: number, lang: Lang): string {
  const zh = lang === "zh";
  if (!league || league.state === "unavailable") return zh ? "暂时读不到联赛信息。你的 agent 不受影响。" : "The league couldn't be read just now. Your agent isn't affected.";
  const n = league.season.number;
  const left = league.season.countdownTo !== null ? duration(league.season.countdownTo - now, lang) : null;
  switch (league.state) {
    case "coming-soon":
      return zh ? `第 ${n} 季 · 即将开赛` : `Season ${n} · coming soon`;
    case "warm-up":
      return zh
        ? `热身中：第 ${n} 季${left ? `还有 ${left}开赛` : "即将开赛"}。照常排名，还不发奖、不淘汰。`
        : `Warm-up: Season ${n} starts ${left ? `in ${left}` : "soon"}. The boards rank, and nobody is paid or eaten yet.`;
    case "season":
      return zh
        ? `第 ${n} 季，第 ${league.season.day ?? "?"} 天（共 7 天）${left ? ` · 下一顿开饭还有 ${left}（21:00 UTC+8）` : ""}`
        : `Season ${n}, day ${league.season.day ?? "?"} of 7${left ? ` · next dinner in ${left} (21:00 UTC+8)` : ""}`;
    case "over":
      return zh ? `第 ${n} 季已结束。` : `Season ${n} is over.`;
  }
}

const seatsTaken = (league: LeagueRead | null, lang: Lang) =>
  league?.seats ? (lang === "zh" ? ` · ${thousands(league.seats.cap)} 个席位已占 ${thousands(league.seats.taken)} 个` : ` · ${thousands(league.seats.taken)} of ${thousands(league.seats.cap)} seats taken`) : "";

// --- seats ---------------------------------------------------------------------------------

/** A seat, in the present tense: for the check card and the status card. */
export function seatLine(seating: Seating, lang: Lang): string {
  const zh = lang === "zh";
  if (seating.kind === "pending") return seating.reason === "no-agent-id" ? (zh ? "已登记，还没有席位：没有 Agent ID" : "registered, no seat yet: no Agent ID") : zh ? "已登记，还没有席位：没有身体币" : "registered, no seat yet: no body coin";
  if (seating.waitlisted) return zh ? `候补第 ${seating.place ?? "?"} 位` : `waitlist, place ${seating.place ?? "?"}`;
  const seat = zh ? `第 ${thousands(seating.seatNo)} 号席位（共 1,000）` : `seat ${thousands(seating.seatNo)} of 1,000`;
  if (!seating.founding) return seat;
  return zh ? `${seat} · 创始席位${seating.foundingNo !== null ? ` #${seating.foundingNo}` : ""}` : `${seat} · founding seat${seating.foundingNo !== null ? ` #${seating.foundingNo}` : ""}`;
}

// --- A. the check --------------------------------------------------------------------------

export type CoinShown = { coin: Address; symbol: string | null };

export type CheckView = {
  agentId: string;
  plan: BodyCoinPlan;
  /** The proposed coin's symbol, read from the chain. */
  coin: CoinShown | null;
  kept: KeptAgent | null;
  keptSeating: Seating | null;
  keptUnreadable: boolean;
  league: LeagueRead | null;
  now: number;
};

function bodyCoinRow(view: CheckView, lang: Lang): string {
  const zh = lang === "zh";
  const plan = view.plan;
  const coin = view.coin ? `${view.coin.symbol ?? "?"} · ${short(view.coin.coin)}` : "";
  switch (plan.kind) {
    case "coin":
      if (plan.why === "fixed") return zh ? `${coin}，本季已锁定` : `${coin}, fixed for this season`;
      if (plan.why === "newest") return zh ? `${coin}，${plan.others.length + 1} 个里最新的（要用别的就说）` : `${coin}, the newest of ${plan.others.length + 1} (say which, if not this one)`;
      if (plan.why === "book") return zh ? `${coin}，这只 agent 发的（链上核对过）` : `${coin}, launched by this agent (checked on chain)`;
      if (plan.launchedAt) return zh ? `${coin}，${dateOf(plan.launchedAt)} 发行（链上核对：是这个钱包发的）` : `${coin}, launched ${dateOf(plan.launchedAt)} (by this wallet, checked on chain)`;
      return zh ? `${coin}（链上核对：是这个钱包发的）` : `${coin} (by this wallet, checked on chain)`;
    case "not-yours":
      return zh ? `${short(plan.coin)} 不是这个钱包发的` : `${short(plan.coin)} wasn't launched by this wallet`;
    case "bad-address":
      return zh ? `${quoted(plan.given, lang)}不是一个地址` : `${quoted(plan.given, lang)} is not an address`;
    case "unreadable":
      return zh ? "暂时没能在链上核对是谁发的币" : "the chain couldn't confirm who launched it just now";
    case "ask-address":
      return zh ? "暂时读不到你发过的币；如果发过，告诉我币的地址" : "the list of your coins couldn't be read; if you launched one, give its address";
    case "await-preset-launch":
      return zh ? "你的「发币并经营」agent 会在第一次运行时发出它" : "your launch-and-run agent launches it on its first tick";
    case "launch":
      return zh ? "还没有：每只 agent 都要发一个币，那是它的身体" : "none yet: every agent launches one coin, its body";
  }
}

function nextLine(view: CheckView, lang: Lang): string {
  const zh = lang === "zh";
  switch (view.plan.kind) {
    case "launch":
      return zh ? "下一步：先发身体币（一笔交易），再签名报名（不花 gas）。" : "Next: launch the body coin (one transaction), then sign the registration (no gas).";
    case "await-preset-launch":
      return zh ? "下一步：启动你的「发币并经营」agent；它的币发出后，再签名报名（不花 gas）。" : "Next: start your launch-and-run agent; once its coin lands, sign the registration (no gas).";
    case "coin":
      return view.kept
        ? zh
          ? "下一步：想改宣言或 X 账号就再签一次；席位不变。"
          : "Next: sign again to change the manifesto or the X account; the seat stays."
        : zh
          ? "下一步：写好宣言，再签名报名（不花 gas）。"
          : "Next: write the manifesto, then sign the registration (no gas).";
    default:
      return zh ? "下一步：告诉我身体币的地址，或者过一分钟再试。" : "Next: give the body coin's address, or try again in a minute.";
  }
}

/** Card A1. */
export function checkCard(view: CheckView, lang: Lang): string {
  const zh = lang === "zh";
  const registration = view.keptUnreadable
    ? zh
      ? "暂时读不到联赛页"
      : "the league page couldn't be read just now"
    : view.keptSeating
      ? seatLine(view.keptSeating, lang)
      : zh
        ? "还没报名"
        : "not registered yet";
  const n = view.league?.season.number ?? view.kept?.season ?? 1;
  return [
    zh ? "Feast 联赛：报名检查" : "Feast league: registration check",
    "",
    table([
      ["Agent ID", zh ? `${shownName(view.agentId)}（从 BNB Smart Chain 读取）` : `${shownName(view.agentId)} (read from BNB Smart Chain)`],
      [zh ? "身体币" : "Body coin", bodyCoinRow(view, lang)],
      [zh ? "报名" : "Registration", registration],
      [zh ? `第 ${n} 季` : `Season ${n}`, `${seasonLine(view.league, view.now, lang).replace(/^(Season \d+ · |第 \d+ 季 · )/, "")}${seatsTaken(view.league, lang)}`],
    ]),
    "",
    nextLine(view, lang),
  ].join("\n");
}

/** Card A2. */
export function noAgentIdCard(lang: Lang): string {
  return lang === "zh"
    ? [
        "这个钱包还没有 Binance Agent ID，暂时不能报名。",
        "",
        "请在 Binance App 的 Binance Agentic Wallet 里领一个 .ai 名字。这个名字就是你的 agent 在联赛里的名字；一个钱包一个名字。",
        "领好后再说一次「报名」。你的 agent 照常运行。",
      ].join("\n")
    : [
        "This wallet has no Binance Agent ID yet, so it can't register.",
        "",
        "Mint one in the Binance App: in your Binance Agentic Wallet, claim a .ai name. That name becomes your agent's name in the league; one wallet, one name.",
        'Then say "register" again. Your agent keeps running as it is.',
      ].join("\n");
}

/** Card A3. */
export function agentIdUnreadable(lang: Lang): string {
  return lang === "zh" ? "暂时没能从 BNB Smart Chain 读到 Agent ID。没有签名，也没有发送任何东西。过一分钟再试。" : "The Agent ID couldn't be read from BNB Smart Chain just now. Nothing was signed or sent. Try again in a minute.";
}

/** Card A4. */
export function walletNotReady(reason: "signed-out" | "devmode", lang: Lang): string {
  if (reason === "signed-out") return lang === "zh" ? "先登录：说「登录」，在 Binance App 里扫码。" : 'Sign in first: say "sign in" and scan the code in the Binance App.';
  return lang === "zh" ? "先在 Binance App 里打开 Developer Mode：钱包通过它签这条报名消息。" : "Turn on Developer Mode in the Binance App first: the wallet signs the registration through it.";
}

/** The manifesto's refusal, in plain words. */
export function manifestoProblem(reason: "not-text" | "too-long" | "joiner" | "control", length: number, lang: Lang): string {
  const zh = lang === "zh";
  if (reason === "too-long") return zh ? `宣言有 ${length} 个字，最多 ${MANIFESTO_MAX} 个。请缩短。` : `The manifesto is ${length} characters; the most is ${MANIFESTO_MAX}. Shorten it.`;
  if (reason === "joiner") return zh ? "宣言里有组合表情（带连接符的 emoji），页面不收。换成单个表情或去掉。" : "The manifesto has a joined emoji (one with a joiner), which the page refuses. Use a single emoji or none.";
  if (reason === "control") return zh ? "宣言里有看不见的控制字符，页面不收。去掉后再试。" : "The manifesto has an invisible control character, which the page refuses. Take it out and try again.";
  return zh ? "宣言必须是一段文字。" : "The manifesto must be text.";
}

// --- C. the body coin launch ---------------------------------------------------------------

export type LaunchView = {
  agentId: string | null;
  name: string;
  symbol: string;
  quote: string;
  description: string | null;
  /** Where the coin's picture comes from: the ticker's identicon (the default), the league's creature, or the identicon because the league's was not available. */
  picture?: "ticker" | "league" | "ticker-fallback";
};

function pictureRow(picture: LaunchView["picture"], lang: Lang): string {
  const zh = lang === "zh";
  if (picture === "league") return zh ? "来自 feast.meme 的联赛形象" : "the league creature from feast.meme";
  if (picture === "ticker-fallback") return zh ? "按代码自动生成（联赛图片暂时拿不到）" : "drawn from the ticker (the league picture was not available)";
  return zh ? "按代码自动生成" : "drawn from the ticker";
}

/** Card C. */
export function launchCard(view: LaunchView, lang: Lang): string {
  const zh = lang === "zh";
  const who = view.agentId ? shownName(view.agentId) : view.name;
  const fromId = view.agentId !== null && view.name === `${view.agentId.slice(0, 29)}.ai`;
  return [
    zh ? `发出 ${who} 的身体币` : `Launch ${who}'s body coin`,
    "",
    table([
      [zh ? "名字" : "Name", fromId ? (zh ? `${view.name}（来自你的 Agent ID）` : `${view.name} (from your Agent ID)`) : view.name],
      [zh ? "代码" : "Ticker", view.symbol],
      [zh ? "配对" : "Paired with", view.quote],
      [zh ? "简介" : "About", view.description ? (zh ? `${quoted(view.description, lang)}（你的宣言）` : `${quoted(view.description, lang)} (your manifesto)`) : zh ? "无" : "none"],
      [zh ? "图片" : "Picture", pictureRow(view.picture, lang)],
      [
        zh ? "手续费分配" : "Fee split",
        zh
          ? "默认：每笔交易 1% 的手续费里，平台 20 点，回购销毁 20 点，引荐人 10 点，你作为创建者 50 点（没有引荐人的交易是 60 点）"
          : "the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer)",
      ],
      [zh ? "费用" : "Cost", zh ? "只有 gas；发送前钱包会先预览这笔交易" : "gas only; your wallet previews the transaction before it is sent"],
      [
        zh ? "限额" : "Limits",
        zh
          ? "走这只 agent 的硬限额（L12 每小时交易数；L16 钱包、Developer Mode 与停止文件）；每只 agent 只发一次"
          : "this agent's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent",
      ],
    ]),
    "",
    zh ? "这枚币会成为你的 agent 在联赛里的币；发不发币都不影响参赛。" : "This coin becomes your agent's coin in the league; entering needs no coin.",
    zh ? "这个币永久公开在 Feast 上，不管你的 agent 后来怎样，它都照常交易。" : "The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.",
    "",
    zh ? "你说「好」之后，会立刻从你的钱包发出一笔真实交易。" : "This sends a real transaction from your wallet as soon as you say yes.",
  ].join("\n");
}

export function launchedLine(symbol: string, coin: string, txHash: string | null, lang: Lang): string {
  return lang === "zh" ? `已发出 ${symbol}（${short(coin)}），交易 ${txHash ? short(txHash) : "（无哈希）"}。这就是你的身体币。` : `Launched ${symbol} (${short(coin)}), transaction ${txHash ? short(txHash) : "(no hash)"}. It is your body coin.`;
}
export function launchFailedLine(reason: string, lang: Lang): string {
  return lang === "zh" ? `${reason}\n没有报名。` : `${reason}\nNothing was registered.`;
}

// --- D. the registration card --------------------------------------------------------------

export type RegisterView = {
  agentId: string;
  bodyCoin: CoinShown | null;
  manifesto: string;
  length: number;
  xHandle: string | null;
  issuedAt: number;
  replaces: { issuedAt: number; seated: boolean } | null;
};

/** Card D. */
export function registerCard(view: RegisterView, lang: Lang): string {
  const zh = lang === "zh";
  const rows: [string, string][] = [
    ["Agent ID", shownName(view.agentId)],
    [
      zh ? "身体币" : "Body coin",
      view.bodyCoin
        ? zh
          ? `${view.bodyCoin.symbol ?? "?"} · ${short(view.bodyCoin.coin)}（这个钱包发的）`
          : `${view.bodyCoin.symbol ?? "?"} · ${short(view.bodyCoin.coin)} (launched by this wallet)`
        : zh
          ? "没有：有了身体币才有席位"
          : "none: you get no seat until it exists",
    ],
    [zh ? "宣言" : "Manifesto", view.manifesto ? `${quoted(view.manifesto, lang)}${zh ? "（" : " ("}${view.length}/${MANIFESTO_MAX}${zh ? "）" : ")"}` : zh ? "（空）" : "(empty)"],
    [zh ? "X 账号" : "X account", view.xHandle ? (zh ? `@${view.xHandle}，用于匹配早鸟（不在签名内）` : `@${view.xHandle}, for the early-bird match (not signed)`) : zh ? "无" : "none"],
    [zh ? "签名时间" : "Signed at", zh ? `${utc8(view.issuedAt * 1_000)}（UTC+8）` : `${utc8(view.issuedAt * 1_000)} (UTC+8)`],
  ];
  if (view.replaces) {
    const when = utc8(view.replaces.issuedAt * 1_000);
    rows.push([zh ? "替换" : "Replaces", zh ? `你 ${when} 的报名${view.replaces.seated ? "；席位不变" : ""}` : `your registration of ${when}${view.replaces.seated ? "; the seat stays" : ""}`]);
  }
  return [
    zh ? `为 Feast 联赛报名 ${shownName(view.agentId)}` : `Register ${shownName(view.agentId)} for the Feast league`,
    "",
    zh ? "你用钱包签一条消息：不花 gas，不上链，不动资金。签好后发送到 feast.meme。" : "You sign one message with your wallet: no gas, nothing on chain, no funds move. It is sent to feast.meme.",
    "",
    table(rows),
    "",
    zh ? "在联赛页公开的：Agent ID、宣言、身体币和这条签名。" : "Public on the league page: the Agent ID, the manifesto, the body coin and this signature.",
    zh ? "只留在你电脑上的：策略预设、它的设置、你那句话，以及任何脚本。" : "Stays on your machine: the preset, its settings, your sentence and any script.",
    ...(view.bodyCoin ? [] : ["", zh ? "没有身体币也可以先登记，但不会有席位；席位按先后给。" : "You can sign up without a body coin, but you get no seat; seats go in order."]),
    "",
    riskHeading(lang),
    riskText(lang),
    "",
    zh ? "说「好」就签名并发送。" : "Say yes to sign it and send it.",
  ].join("\n");
}

// --- E. signing ----------------------------------------------------------------------------

export function signingLine(what: "pending" | "declined" | "expired" | "local-check", lang: Lang, reason?: string): string {
  const zh = lang === "zh";
  switch (what) {
    case "pending":
      return zh ? "请在 Binance App 里确认这次签名。最多等 10 分钟……" : "Confirm the signature in the Binance App. Waiting up to 10 minutes…";
    case "declined":
      return zh ? "你在 App 里拒绝了签名。没有发送任何东西。" : "The signature was declined in the App. Nothing was sent.";
    case "expired":
      return zh ? "签名请求过期了，没有发送任何东西。再说一次「报名」即可重试。" : 'The signature request expired. Nothing was sent. Say "register" to try again.';
    case "local-check":
      return zh ? `签名在本机核对时与这个钱包对不上，所以没有发送。${reason ? `（${reason}）` : ""}` : `The signature didn't check out against this wallet here, so it wasn't sent.${reason ? ` (${reason})` : ""}`;
  }
}

export function previewMismatch(reason: string, lang: Lang): string {
  return lang === "zh" ? `钱包预览和联赛消息对不上，或者提示了风险，所以没有签名。（${reason}）` : `Your wallet's preview didn't match the league message, or it flagged a risk, so nothing was signed: ${reason}.`;
}

// --- F. the answer -------------------------------------------------------------------------

export function seatedLine(seating: Seating, agentId: string, season: number, lang: Lang): string {
  const zh = lang === "zh";
  const name = shownName(agentId);
  if (seating.kind === "pending") {
    if (seating.reason === "no-agent-id") return noAgentIdCard(lang);
    return zh ? "已登记，但还没有席位：这个钱包还没有身体币。先发币，再报名一次；席位按先后。" : "Registered, but no seat yet: this wallet has no body coin. Launch it, then register again; seats go in order.";
  }
  if (seating.waitlisted) return zh ? `1,000 个席位已满，${name} 在候补第 ${seating.place ?? "?"} 位。` : `The 1,000 seats are taken. ${name} is on the waitlist, place ${seating.place ?? "?"}.`;
  const seat = thousands(seating.seatNo);
  if (seating.founding) {
    const no = seating.foundingNo !== null ? (zh ? `第 ${seating.foundingNo} 号，共 100` : `#${seating.foundingNo} of 100`) : zh ? "共 100" : "one of 100";
    return zh ? `报名成功：第 ${seat} 号席位（共 1,000），并且是创始席位（${no}）。${name} 进入第 ${season} 季。` : `Registered: seat ${seat} of 1,000, and a founding seat (${no}). ${name} is in Season ${season}.`;
  }
  return zh ? `报名成功：第 ${seat} 号席位（共 1,000）。${name} 进入第 ${season} 季。` : `Registered: seat ${seat} of 1,000. ${name} is in Season ${season}.`;
}

export function preregLine(prereg: Prereg, xHandle: string | null, agentId: string, lang: Lang): string | null {
  const zh = lang === "zh";
  if (prereg === "matched") return zh ? "X 预报名已匹配：获得早鸟标记。" : "Your X pre-registration matched: early-bird mark set.";
  if (prereg === "none")
    return zh
      ? `还没找到 @${xHandle ?? "?"} 写着 ${shownName(agentId)} 的预报名引用帖。之后可以带上账号再报名一次来匹配。`
      : `No pre-registration quote by @${xHandle ?? "?"} naming ${shownName(agentId)} was found yet. Register again later with the handle to match it.`;
  if (prereg === "unavailable") return zh ? "暂时没法核对预报名；之后再报名一次即可匹配。" : "The pre-registration couldn't be checked just now; register again later to match it.";
  return null;
}

export function nextStepLine(league: LeagueRead | null, now: number, lang: Lang): string {
  const zh = lang === "zh";
  const n = league?.season.number ?? 1;
  const left = league?.season.countdownTo != null ? duration(league.season.countdownTo - now, lang) : null;
  switch (league?.state) {
    case "warm-up":
      return zh ? "下一步：开赛前是热身。照常排名，还不发奖、不淘汰。当天满 5 笔交易才上「最赚钱」榜。" : "Next: warm-up runs until the start. The boards rank, and nobody is paid or eaten yet. Five trades in a day put it on Top earners.";
    case "season":
      return zh
        ? `下一步：现在是第 ${league.season.day ?? "?"} 天（共 7 天），从现在开始排名。${left ? `下一顿开饭还有 ${left}。` : ""}`
        : `Next: it's day ${league.season.day ?? "?"} of 7, and it ranks from now.${left ? ` The next dinner is in ${left}.` : ""}`;
    case "over":
      return zh ? `第 ${n} 季已结束。下一季开放后再报名。` : `Season ${n} is over. Register again when the next season opens.`;
    default:
      return zh
        ? `下一步：不用做什么。第 ${n} 季还没开始，你的 agent 照常运行。开赛后每天 21:00（UTC+8）开饭。`
        : `Next: nothing to do. Season ${n} hasn't started, and your agent keeps running as it is. Once it starts, dinner is at 21:00 (UTC+8) every day.`;
  }
}

/** A refusal from the page, by its code (927 API.md §2). */
export function refusalLine(code: string, field: string | null, agentId: string, lang: Lang): string {
  const zh = lang === "zh";
  const name = shownName(agentId);
  switch (code) {
    case "invalid-fields":
      if (field === "strategy") return zh ? "页面拒收了这段宣言。缩短一些或去掉特殊字符，再报名一次。" : "The page refused the manifesto. Shorten it or take out special characters, then register again.";
      if (field === "bodyCoin") return zh ? "页面拒收了身体币的地址。没有保存任何东西。" : "The page refused the body coin's address. Nothing was kept.";
      return zh ? "页面拒收了请求格式。这是这边的问题，不是你的。没有保存任何东西。" : "The page refused the request's shape. That is a bug here, not your doing. Nothing was kept.";
    case "bad-request":
      return zh ? "页面拒收了请求格式。这是这边的问题，不是你的。没有保存任何东西。" : "The page refused the request's shape. That is a bug here, not your doing. Nothing was kept.";
    case "stale":
      return zh ? "这台电脑的时间和页面相差太多，所以没有保存。校准时间后再报名一次。" : "This computer's clock and the page's differ by more than it allows, so nothing was kept. Check the clock and register again.";
    case "no-agent-id":
      return noAgentIdCard(lang);
    case "agent-id-mismatch":
      return zh ? "页面读到的 Agent ID 和这里不同。再说一次「报名」，会重新读取名字。" : 'The page reads a different Agent ID for this wallet. Say "register" again; it reads the name afresh.';
    case "body-coin-not-yours":
      return zh ? "页面说这个币不是这个钱包发的。请选一个这个钱包发的币。" : "The page says that coin wasn't launched by this wallet. Pick one this wallet launched.";
    case "bad-signature":
      return zh ? "页面没能把签名对上这个钱包。没有保存任何东西。" : "The page couldn't match the signature to this wallet. Nothing was kept.";
    case "replayed":
      return zh ? "页面上已经有这个钱包更新的报名。说「报名」重新签一次。" : 'The page already holds a newer registration from this wallet. Say "register" to sign a fresh one.';
    case "name-taken":
      return zh ? `本季已有另一只 agent 在页面上占用了 ${name}。没有改动任何东西；请告诉 Feast 团队。` : `Another agent this season holds ${name} on the page. Nothing was changed; tell the Feast team.`;
    case "rate-limited":
      return zh ? "一分钟内尝试太多次。等一分钟再报名。" : "Too many tries in a minute. Wait a minute and register again.";
    case "unavailable":
    case "upstream-unavailable":
      return zh ? "现在连不上联赛页或链。没有保存任何东西。稍后再试。" : "The league page or the chain can't be reached right now. Nothing was kept. Try again later.";
    default:
      return zh ? `页面拒绝了这次报名（${code}）。没有保存任何东西。` : `The page refused the registration (${code}). Nothing was kept.`;
  }
}

export function noAnswerLine(kept: boolean | null, lang: Lang): string {
  const zh = lang === "zh";
  if (kept === true) return zh ? "feast.meme 没有回应。已复查：报名已保存。" : "feast.meme didn't answer. I checked again: it was kept.";
  if (kept === false) return zh ? "feast.meme 没有回应。已复查：没有保存，请重试。" : "feast.meme didn't answer. I checked again: it wasn't kept, try again.";
  return zh ? "feast.meme 没有回应，也没法复查。稍后说「状态」看看是否已保存。" : 'feast.meme didn\'t answer, and it couldn\'t be checked again. Say "status" later to see whether it was kept.';
}

// --- the session notices (§7) --------------------------------------------------------------

export type SessionCode = "6h" | "1h" | "ended" | "back";

export function sessionNotice(code: SessionCode, endMs: number | null, lang: Lang): string {
  const zh = lang === "zh";
  const at = endMs !== null ? utc8(endMs) : null;
  switch (code) {
    case "6h":
      return zh
        ? `钱包登录不到 6 小时后到期${at ? `（${at} UTC+8）` : ""}。请在那之前重新扫码，agent 才能继续交易和止损。`
        : `Your wallet's sign-in ends in under 6 hours${at ? ` (at ${at} UTC+8)` : ""}. Scan again before then so the agent can keep trading and exiting.`;
    case "1h":
      return zh ? `钱包登录不到 1 小时后到期${at ? `（${utc8(endMs!, false)} UTC+8）` : ""}。请现在重新扫码。` : `Your wallet's sign-in ends in under an hour${at ? ` (at ${utc8(endMs!, false)} UTC+8)` : ""}. Scan again now.`;
    case "ended":
      return zh
        ? "钱包登录已到期。重新扫码之前 agent 无法交易，包括止损和卖出。说「登录」，在 Binance App 里扫码；扫完 agent 会自己恢复。"
        : 'Your wallet\'s sign-in has ended. The agent can\'t trade until you scan again, and that includes its exits. Say "sign in" and scan the code in the Binance App; the agent picks up by itself.';
    case "back":
      return zh ? "已重新登录，agent 恢复运行。" : "Signed in again: the agent resumes.";
  }
}

// --- what the commands say when something is missing ---------------------------------------

export function xHandleProblem(given: string, lang: Lang): string {
  return lang === "zh" ? `${quoted(given, lang)}不像 X 账号：1–15 个字母、数字或下划线，可以带 @。` : `${quoted(given, lang)} isn't an X handle: 1–15 letters, digits or underscores, with or without @.`;
}

export function bodyCoinProblem(plan: BodyCoinPlan, lang: Lang): string {
  const zh = lang === "zh";
  switch (plan.kind) {
    case "launch":
      return zh
        ? "还没有身体币。先发币（feast-league launch，卡片 C），或者加 --pending 先登记、暂不占席位；席位按先后给。"
        : "No body coin yet. Launch it first (feast-league launch, card C), or add --pending to sign up without a seat; seats go in order.";
    case "await-preset-launch":
      return zh ? "你的「发币并经营」agent 还没发出它的币：先启动它，或者加 --pending 先登记、暂不占席位。" : "Your launch-and-run agent hasn't launched its coin yet: start it, or add --pending to sign up without a seat.";
    case "not-yours":
      return zh ? `${short(plan.coin)} 不是这个钱包发的。请选一个这个钱包发的币。` : `${short(plan.coin)} wasn't launched by this wallet. Pick one this wallet launched.`;
    case "bad-address":
      return zh ? `${quoted(plan.given, lang)}不是一个地址。` : `${quoted(plan.given, lang)} is not an address.`;
    case "unreadable":
      return zh ? "暂时没能在链上核对是谁发的币。没有签名，也没有发送任何东西。过一分钟再试。" : "The chain couldn't confirm who launched the coin just now. Nothing was signed or sent. Try again in a minute.";
    case "ask-address":
      return zh ? "暂时读不到你发过的币。如果发过，用 --body-coin 告诉我币的地址。" : "The list of your coins couldn't be read. If you launched one, give its address with --body-coin.";
    case "coin":
      return "";
  }
}

export function launchPresetOwnLine(lang: Lang): string {
  return lang === "zh" ? "「发币并经营」agent 自己发它的币：启动它就会发出，那就是身体币。" : "A launch-and-run agent launches its own coin: start it, and that coin is its body coin.";
}

export function alreadyLaunchedLine(coin: string, lang: Lang): string {
  return lang === "zh" ? `这只 agent 已经发过币（${short(coin)}）：那就是它的身体币。每只 agent 只发一次。` : `This agent has launched its coin (${short(coin)}): that is its body coin. One launch per agent.`;
}

export function queuedLaunchLine(name: string, lang: Lang): string {
  return lang === "zh" ? `已交给正在运行的 agent「${name}」，下一次运行时发出。用 feast-league status ${name} 查看。` : `Queued for the running agent "${name}"; it launches within a tick. See feast-league status ${name}.`;
}

export function walletUnreadable(reason: string, lang: Lang): string {
  return lang === "zh" ? `暂时读不到钱包（${reason}）。没有签名，也没有发送任何东西。过一分钟再试。` : `The wallet couldn't be read just now (${reason}). Nothing was signed or sent. Try again in a minute.`;
}
