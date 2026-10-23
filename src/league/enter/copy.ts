import { short, utc8, type Lang } from "../register/copy.ts";
import { shownName } from "../register/message.ts";

/**
 * Every word `FL enter` shows a person, in English and Chinese (task 961). The
 * runtime prints these; the skill shows them verbatim. What the chain, the
 * indexer or feast.meme said is data: it goes through `clean` before it is
 * printed, and never into a command, a path or a URL.
 */

// --- data, cleaned ------------------------------------------------------------------------

/** ANSI escape sequences (CSI and OSC), whole. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
/** Control characters (C0, DEL, C1) and the bidi and zero-width marks. */
const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;

/** A string from outside, fit to print: escapes and invisible marks removed, line breaks as spaces, at most `max` characters. */
export function clean(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const flat = text.replace(ANSI, "").replace(/[\t\n\r]+/g, " ").replace(UNSEEN, "").replace(/ {2,}/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

/** A reason from an error of ours (a fetch, the runtime): cleaned, and with any URL taken out, since an RPC URL may carry a key. */
const plain = (reason: string, max = 120) => clean(reason.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"), max);

/** A coin as the cards show it: its ticker when it is a plain one, and the address as 6+4. */
export const SAFE_SYMBOL = /^[A-Z0-9]{1,10}$/;
export const coinShown = (symbol: string | null, coin: string) => (symbol && SAFE_SYMBOL.test(symbol) ? `${symbol} (${short(coin)})` : short(coin));

const table = (rows: [string, string][]) => ["| | |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "/")} |`)].join("\n");
const at8 = (ms: number, lang: Lang) => (lang === "zh" ? `${utc8(ms)}（UTC+8）` : `${utc8(ms)} UTC+8`);

// --- the name and the wallet --------------------------------------------------------------

export function nameMissing(lang: Lang): string {
  return lang === "zh" ? "缺少 --name <id>.ai：这个钱包的 Agent ID，例如 FL enter --name maplegrin.ai。" : "Missing --name <id>.ai: this wallet's Agent ID, as in FL enter --name maplegrin.ai.";
}

export function nameBad(given: string, lang: Lang): string {
  const g = clean(given, 70);
  return lang === "zh"
    ? `「${g}」不是 Agent ID：Agent ID 是 1–64 个小写字母或数字，可带 .ai。`
    : `"${g}" is not an Agent ID: one is 1–64 lowercase letters or digits, with or without .ai.`;
}

export function nameMismatch(chainId: string, given: string, lang: Lang): string {
  return lang === "zh" ? `这个钱包的 Agent ID 是 ${shownName(chainId)}，不是 ${clean(given, 70)}。` : `This wallet's Agent ID is ${shownName(chainId)}, not ${clean(given, 70)}.`;
}

export function walletBusy(agent: string, lang: Lang): string {
  return lang === "zh"
    ? `agent「${agent}」正在用这个钱包运行；FL enter 不会碰它。请在 FL start 之前运行 FL enter，或者先停下「${agent}」。`
    : `Agent "${agent}" is running on this wallet; FL enter does not touch it. Run FL enter before FL start, or stop "${agent}" first.`;
}

export function walletReadFailed(reason: string, lang: Lang): string {
  return lang === "zh" ? `暂时读不到钱包（${plain(reason)}）。没有发送任何东西。过一分钟再运行一次 FL enter。` : `The wallet couldn't be read just now (${plain(reason)}). Nothing was sent. Run FL enter again in a minute.`;
}

export function entryAgentChanged(lang: Lang): string {
  return lang === "zh"
    ? "league-entry 的设置（agents/league-entry/agent.json）被改过，不是 FL enter 写的样子。没有发送任何东西。删掉这个文件夹里的 agent.json 后再运行 FL enter。"
    : "league-entry's settings (agents/league-entry/agent.json) were changed from what FL enter wrote. Nothing was sent. Remove that agent.json and run FL enter again.";
}

export function foreignHome(recorded: string, chainId: string, lang: Lang): string {
  return lang === "zh"
    ? `这个文件夹里的报名属于 ${shownName(recorded)}，而这个钱包是 ${shownName(chainId)}。没有发送任何东西。给这个钱包换一个 FEAST_LEAGUE_HOME。`
    : `The entry in this home is ${shownName(recorded)}'s; this wallet is ${shownName(chainId)}. Nothing was sent. Use another FEAST_LEAGUE_HOME for this wallet.`;
}

// --- eligibility ---------------------------------------------------------------------------

export function siteUnreadable(reason: string, lang: Lang): string {
  return lang === "zh" ? `暂时读不到 feast.meme（${plain(reason)}）；过几分钟再运行一次 FL enter。` : `feast.meme could not be read (${plain(reason)}); run FL enter again in a few minutes.`;
}

export function notEligible(why: "no-agent-id" | "differs" | "wallet" | "unreadable", detail: string | null, lang: Lang): string {
  const zh = lang === "zh";
  const d = clean(detail ?? "", 70);
  switch (why) {
    case "no-agent-id":
      return zh ? "feast.meme 还没读到这个钱包的 Agent ID，暂时不能报名。没有发送任何东西。" : "feast.meme does not see an Agent ID for this wallet yet, so it can't enter. Nothing was sent.";
    case "differs":
      return zh ? `feast.meme 读到的 Agent ID 是「${d}」，和链上的不一样。没有发送任何东西。` : `feast.meme reads this wallet's Agent ID as "${d}", not the chain's. Nothing was sent.`;
    case "wallet":
      return zh ? "feast.meme 答的是另一个钱包。没有发送任何东西。" : "feast.meme answered for another wallet. Nothing was sent.";
    case "unreadable":
      return zh ? `feast.meme 的回答读不懂（${d}）。没有发送任何东西。` : `feast.meme's answer could not be read (${d}). Nothing was sent.`;
  }
}

// --- the body coin -------------------------------------------------------------------------

export function launchCheckUnreadable(lang: Lang): string {
  return lang === "zh" ? "没能确认这个钱包是否已经发过币；请再运行一次 FL enter。" : "Could not check whether this wallet already launched; run FL enter again.";
}

export function alreadyLaunched(symbol: string | null, coin: string, lang: Lang): string {
  return lang === "zh" ? `10/23 以来已经发过币：${coinShown(symbol, coin)}；接下来买今天的币。` : `Already launched since 10/23: ${coinShown(symbol, coin)}; going on to today's coin.`;
}

export function avatarFallback(reason: string, lang: Lang): string {
  return lang === "zh" ? `联赛图片暂时还拿不到（${plain(reason)}）；改用按代码生成的图片。` : `The league picture is not available yet (${plain(reason)}); using the ticker's picture.`;
}

export function pendingOutcome(kind: string, lang: Lang): string {
  const zh = lang === "zh";
  const what = kind === "launch" ? (zh ? "发币" : "launch") : zh ? "买入" : "buy";
  return zh
    ? `之前发出的一笔${what}还不知道结果；没有再发送任何东西。过几分钟再运行一次 FL enter。`
    : `A ${what} sent earlier has no known outcome yet; nothing more was sent. Run FL enter again in a few minutes.`;
}

export function launchFailed(reason: string, lang: Lang): string {
  return lang === "zh" ? `发币没有成功：${plain(reason, 300)}。没有买入。` : `The launch did not go through: ${plain(reason, 300)}. Nothing was bought.`;
}

// --- the yes ----------------------------------------------------------------------------------

export function needsYes(lang: Lang): string {
  return lang === "zh" ? "还没完成：需要用户说「好」（--yes）。" : "Not done: this needs the user's yes (--yes).";
}

export function cardChanged(lang: Lang): string {
  return lang === "zh"
    ? "这一次的 --yes 没有对上刚给用户看的卡片（没看过、超过 10 分钟，或者内容变了），所以什么也没发送。下面是现在的卡片。"
    : "This --yes did not match a card the user was just shown (none shown, over 10 minutes ago, or it changed), so nothing was sent. This is the card now.";
}

// --- today's coin --------------------------------------------------------------------------

export type Wait = "not-registered" | "before-cutoff" | "no-table" | "missing";

export function comeBack(what: Wait, reason: string | null, atMs: number, lang: Lang): string {
  const zh = lang === "zh";
  const said = reason ? (zh ? `（feast.meme：「${clean(reason)}」）` : ` (feast.meme: "${clean(reason)}")`) : "";
  const head = {
    "not-registered": zh ? "feast.meme 还没看到这只 agent 的身体币，刚发的币要等索引跟上" : "feast.meme has not seen this agent's body coin yet: a coin just launched waits for the index",
    "before-cutoff": zh ? "今天的币还没抽出来（要等新加坡时间 08:00 的区块）" : "Today's coins are not drawn yet (they wait for the 08:00 SGT block)",
    "no-table": zh ? "今天的分配表还没准备好" : "Today's table is not up yet",
    missing: zh ? "feast.meme 还没开始分配今天的币" : "feast.meme does not hand out today's coin yet",
  }[what];
  return zh ? `${head}${said}。这次没有买。请在 ${at8(atMs, lang)} 再运行一次 FL enter。` : `${head}${said}. Nothing was bought. Run FL enter again at ${at8(atMs, lang)}.`;
}

export function assignmentUnreadable(reason: string, lang: Lang): string {
  return lang === "zh" ? `暂时读不到今天的币（${plain(reason)}）。这次没有买；过几分钟再运行一次 FL enter。` : `Today's coin could not be read (${plain(reason)}). Nothing was bought; run FL enter again in a few minutes.`;
}

export type BadRow = "wallet" | "address" | "not-feast" | "own-coin" | "unchecked";

export function badRow(why: BadRow, lang: Lang): string {
  const zh = lang === "zh";
  const what = {
    wallet: zh ? "它是给另一个钱包的" : "it is another wallet's",
    address: zh ? "它给的币不是一个地址" : "its coin is not an address",
    "not-feast": zh ? "它给的币不是 Feast 发的" : "its coin is not one the Feast factory made",
    "own-coin": zh ? "它给的是这个钱包自己的身体币" : "its coin is this wallet's own body coin",
    unchecked: zh ? "没能在链上核对它给的币" : "its coin could not be checked on the chain",
  }[why];
  return zh ? `feast.meme 给的今天的币不能用：${what}。这次没有买；过几分钟再运行一次 FL enter。` : `Today's coin from feast.meme can't be used: ${what}. Nothing was bought; run FL enter again in a few minutes.`;
}

export function refusedLine(limit: string, message: string, lang: Lang): string {
  return lang === "zh" ? `被 ${limit} 拒绝：${message}（没有向钱包请求任何东西）` : `refused by ${limit}: ${message} (nothing was asked of the wallet)`;
}

/** `usdt`: the amount's worth at the BNB price just read, for reference only; null when the price could not be read. */
export type BuyView = { agentId: string; coin: string; symbol: string | null; bnb: number; usdt: number | null; slippagePct: number; maxTradeBnb: number; budgetBnb: number; maxDailySpendBnb: number };

export function buyCard(view: BuyView, lang: Lang): string {
  const zh = lang === "zh";
  const shown = coinShown(view.symbol, view.coin);
  return [
    zh ? `为 ${shownName(view.agentId)} 买今天的币` : `Buy today's coin for ${shownName(view.agentId)}`,
    "",
    table([
      [zh ? "币" : "Coin", zh ? `${shown}：今天分到的币，按新加坡时间 08:00 的区块抽取` : `${shown}: today's coin, assigned from the 08:00 SGT block`],
      [zh ? "金额" : "Amount", `${view.bnb} BNB${zh ? "（报名金额）" : " (the entry's amount)"}${view.usdt === null ? "" : ` ≈ ${view.usdt.toFixed(2)} USDT`}`],
      [zh ? "滑点" : "Slippage", zh ? `最多 ${view.slippagePct}%` : `at most ${view.slippagePct}%`],
      [zh ? "买入之后" : "After the buy", zh ? "最多两笔授权，这样以后卖出只要一笔交易" : "up to two approvals, so that a later sale is one transaction"],
      [zh ? "费用" : "Cost", zh ? "上面的金额，加最多三笔交易的 gas；发送前钱包会先预览每一笔" : "the amount above, and gas for up to three transactions; your wallet previews each before it is sent"],
      [
        zh ? "限额" : "Limits",
        zh
          ? `默认硬限额照常生效（L1 单笔 ${view.maxTradeBnb} BNB；L2 每 24 小时 ${view.maxDailySpendBnb} BNB；L3 这个钱包总共 ${view.budgetBnb} BNB；L16 钱包、Developer Mode 与停止文件）`
          : `the default hard limits apply (L1 one trade ${view.maxTradeBnb} BNB; L2 ${view.maxDailySpendBnb} BNB in any 24 h; L3 ${view.budgetBnb} BNB from this wallet in all; L16 the wallet, Developer Mode and the stop file)`,
      ],
    ]),
    "",
    zh ? "这是联赛的第 1 步：买一次别的 agent 的身体币。买完之后不会自动交易：自动交易在开赛当天用另一个命令启动。" : "This is the league's step 1: one buy of another agent's body coin. Nothing trades after it: trading starts on season day, with its own command.",
    "",
    zh ? "你说「好」之后，会立刻从你的钱包发出一笔真实交易。" : "This sends a real transaction from your wallet as soon as you say yes.",
  ].join("\n");
}

export function boughtLine(symbol: string | null, coin: string, txHash: string | null, lang: Lang): string {
  const shown = coinShown(symbol, coin);
  return lang === "zh" ? `已买入 ${shown}，交易 ${txHash ? short(txHash) : "（无哈希）"}。` : `Bought ${shown}, transaction ${txHash ? short(txHash) : "(no hash)"}.`;
}

/** After the buy: the only line besides the transaction (the coordinator's ruling, 2026-10-23). */
export function doneLine(lang: Lang): string {
  return lang === "zh" ? "你已报名。开赛当天运行 `FL start`。" : "You're in. On season day run `FL start`.";
}

export function buyFailed(reason: string, lang: Lang): string {
  return lang === "zh" ? `买入没有成功：${plain(reason, 300)}。` : `The buy did not go through: ${plain(reason, 300)}.`;
}

export function alreadyEntered(view: { agentId: string; coin: string; txHash: string | null; atMs: number }, lang: Lang): string {
  return lang === "zh"
    ? [`已经报名：${shownName(view.agentId)} 在 ${at8(view.atMs, lang)} 买了今天的币 ${short(view.coin)}，交易 ${view.txHash ? short(view.txHash) : "（无哈希）"}。现在不用再做什么。`, doneLine(lang)].join("\n")
    : [`Already entered: ${shownName(view.agentId)} bought today's coin ${short(view.coin)} at ${at8(view.atMs, lang)}, transaction ${view.txHash ? short(view.txHash) : "(no hash)"}. Nothing more to do now.`, doneLine(lang)].join("\n");
}
