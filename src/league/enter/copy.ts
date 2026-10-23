import { short, type Lang } from "../register/copy.ts";
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
  return lang === "zh" ? `10/23 以来已经发过币：${coinShown(symbol, coin)}，它就是你的身体币。` : `Already launched since 10/23: ${coinShown(symbol, coin)}: it is your body coin.`;
}

/** After the launch: the coin, and its transaction in full. */
export function launchedTx(symbol: string, coin: string, txHash: string | null, lang: Lang): string {
  return lang === "zh" ? `已发出 ${symbol}（${short(coin)}）。交易：${txHash ?? "（无哈希）"}` : `Launched ${symbol} (${short(coin)}). Transaction: ${txHash ?? "(no hash)"}`;
}

export function avatarFallback(reason: string, lang: Lang): string {
  return lang === "zh" ? `联赛图片暂时还拿不到（${plain(reason)}）；改用按代码生成的图片。` : `The league picture is not available yet (${plain(reason)}); using the ticker's picture.`;
}

export function pendingOutcome(_kind: string, lang: Lang): string {
  const zh = lang === "zh";
  const what = zh ? "发币" : "launch";
  return zh
    ? `之前发出的一笔${what}还不知道结果；没有再发送任何东西。过几分钟再运行一次 FL enter。`
    : `A ${what} sent earlier has no known outcome yet; nothing more was sent. Run FL enter again in a few minutes.`;
}

export function launchFailed(reason: string, lang: Lang): string {
  return lang === "zh" ? `发币没有成功：${plain(reason, 300)}。没有发送别的。` : `The launch did not go through: ${plain(reason, 300)}. Nothing else was sent.`;
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

export function refusedLine(limit: string, message: string, lang: Lang): string {
  return lang === "zh" ? `被 ${limit} 拒绝：${message}（没有向钱包请求任何东西）` : `refused by ${limit}: ${message} (nothing was asked of the wallet)`;
}

// --- the notes session -----------------------------------------------------------------

/** Under the launch card: the same yes signs the notes session's one message. */
export function notesOnLaunch(view: { agentId: string; season: number }, lang: Lang): string {
  return lang === "zh"
    ? `同一个「好」之后还会签一条消息（不是交易，不花 gas，不动资金），为 ${shownName(view.agentId)} 在 feast.meme 开通第 ${view.season} 季的笔记会话。`
    : `The same yes then signs one message (no transaction, no gas, no funds) that opens ${shownName(view.agentId)}'s notes session on feast.meme for season ${view.season}.`;
}

/** The notes card, when the body coin already exists: entering is this one signature. */
export function notesCard(view: { agentId: string; season: number }, lang: Lang): string {
  const zh = lang === "zh";
  const who = shownName(view.agentId);
  return [
    zh ? `开通 ${who} 的笔记会话` : `Open ${who}'s notes session`,
    "",
    table([
      [zh ? "内容" : "What", zh ? "签一条消息（EIP-712 NoteSession）：不是交易，不花 gas，不动资金" : "one signed message (EIP-712 NoteSession): no transaction, no gas, no funds moved"],
      [zh ? "签名" : "Signs", zh ? `你的钱包，为 ${who}，第 ${view.season} 季` : `your wallet, for ${who}, season ${view.season}`],
      [zh ? "用途" : "Why", zh ? "feast.meme 只收为本季签过名的钱包发来的笔记（FL note）" : "feast.meme takes your agent's notes (FL note) from a wallet that signed for the season"],
      [zh ? "保存" : "Kept", zh ? "会话的令牌，存在这台电脑上（notes-session.json）；从不保存私钥" : "the session's token, in this home (notes-session.json); never a key"],
    ]),
    "",
    zh ? "你说「好」之后，钱包会请你签这一条消息。" : "Your wallet asks for this one signature as soon as you say yes.",
  ].join("\n");
}

// --- done ------------------------------------------------------------------------------------

/** After the entry: the next step is the prompt (the owner's ruling, 2026-10-24). */
export function doneLine(lang: Lang): string {
  return lang === "zh" ? "你已报名。写好你的 strategy.md，然后运行 `FL start <name> --prompt strategy.md`" : "You're in. Write your strategy.md and run `FL start <name> --prompt strategy.md`";
}

export function alreadyEntered(view: { agentId: string; coin: string; notes: string | null }, lang: Lang): string {
  const zh = lang === "zh";
  const head = zh ? `已经报名：${shownName(view.agentId)} 的身体币是 ${short(view.coin)}。现在不用再做什么。` : `Already entered: ${shownName(view.agentId)}'s body coin is ${short(view.coin)}. Nothing more to do now.`;
  const notes = view.notes === "open" || view.notes === "dev" ? [] : [zh ? "还没有笔记会话：用 FL note --login 开通（签一条消息，不花 gas）。" : "No notes session yet: FL note --login opens one (one signed message, no gas)."];
  return [head, ...notes, doneLine(lang)].join("\n");
}
