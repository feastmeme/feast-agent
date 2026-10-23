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

// --- the entry: one signed Register (task 968) --------------------------------------------------

/** When trading opens, as the cards say it. */
export type OpensShown = { kind: "at"; at: number } | { kind: "open" } | { kind: "unknown" };

const opensText = (opens: OpensShown, lang: Lang) => {
  const zh = lang === "zh";
  if (opens.kind === "at") return zh ? `${utc8(opens.at)}（UTC+8）` : `${utc8(opens.at)} UTC+8`;
  return zh ? "feast.meme 宣布开赛的时刻" : "feast.meme announces the start";
};

/** Under the entry card: the agent's own card, and when it starts trading. */
export function waitingLine(opens: OpensShown, lang: Lang): string {
  const zh = lang === "zh";
  if (opens.kind === "open") return zh ? "现在就启动：赛季已经开始，它马上开始交易。" : "Starts now: the season is open, so it trades from the start.";
  if (opens.kind === "at") return zh ? `现在就启动，等待赛季开始：${opensText(opens, lang)}之前它不做任何交易。` : `Starts now and waits for the season: it trades nothing before ${opensText(opens, lang)}.`;
  return zh ? "现在就启动，等待赛季开始：在 feast.meme 宣布开赛之前，它不做任何交易。" : "Starts now and waits for the season: it trades nothing until feast.meme announces the start.";
}

export type StrategyShown = { kind: "default"; path: string } | { kind: "existing"; path: string } | { kind: "given"; path: string };

export function strategyLine(view: StrategyShown, name: string, lang: Lang): string {
  const zh = lang === "zh";
  if (view.kind === "default")
    return zh
      ? `策略：第一季默认策略，已复制到 ${view.path}；随时可以改，改完运行 \`FL start ${name} --prompt ${view.path}\` 会给出新卡片。`
      : `Strategy: the season-1 default strategy, copied to ${view.path}; edit it any time, then \`FL start ${name} --prompt ${view.path}\` shows the new card.`;
  if (view.kind === "existing") return zh ? `策略：你的 strategy.md（已有的，没有改动）：${view.path}` : `Strategy: your strategy.md (existing, left as it is): ${view.path}`;
  return zh ? `策略：你的 ${view.path}` : `Strategy: your ${view.path}`;
}

/** The entry card: the Register signature, the notes signature, and the agent's start, under one yes. */
export function entryCard(view: { agentId: string; season: number; notes: boolean; agent: string | null }, lang: Lang): string {
  const zh = lang === "zh";
  const who = shownName(view.agentId);
  const rows: [string, string][] = [
    [zh ? "内容" : "What", zh ? "签一条消息报名本季：不是交易，不花 gas，不动资金" : "sign one message to enter the season: no transaction, no gas, no funds"],
    [zh ? "消息里有" : "It carries", zh ? `这个钱包、Agent ID ${who}、一段空的公开宣言、签名时间（EIP-712 Register）` : `this wallet, the Agent ID ${who}, an empty public manifesto, the time (EIP-712 Register)`],
    [zh ? "发送到" : "Sent to", zh ? "feast.meme（/api/league/register）" : "feast.meme (/api/league/register)"],
  ];
  if (view.notes) rows.push([zh ? "然后" : "Then", zh ? `再签一条消息，开通 ${who} 第 ${view.season} 季的笔记会话（EIP-712 NoteSession），同一个「好」` : `one more message, under the same yes, that opens ${who}'s notes session for season ${view.season} (EIP-712 NoteSession)`]);
  if (view.agent) rows.push([zh ? "最后" : "Last", zh ? `启动你的 agent「${view.agent}」，等待赛季开始（它的卡片在下面）` : `your agent "${view.agent}" starts and waits for the season (its card is below)`]);
  const count = view.notes ? 2 : 1;
  return [
    zh ? `${who} 报名第 ${view.season} 季` : `Enter ${who} in season ${view.season}`,
    "",
    table(rows),
    "",
    zh
      ? `你说「好」之后，钱包会请你签 ${count === 2 ? "最多两条" : "一条"}消息；Binance App 可能要你逐条确认。`
      : `Your wallet asks for ${count === 2 ? "at most two signatures" : "one signature"} as soon as you say yes; the Binance App may ask you to confirm ${count === 2 ? "each" : "it"}.`,
  ].join("\n");
}

/** The agent's part of a card: the strategy, its card, and when it trades. */
export function agentSection(view: { strategy: StrategyShown; name: string; card: string; opens: OpensShown }, lang: Lang): string {
  return [strategyLine(view.strategy, view.name, lang), "", view.card, "", waitingLine(view.opens, lang)].join("\n");
}

export function keptUnreadable(reason: string, lang: Lang): string {
  return lang === "zh"
    ? `暂时读不到 feast.meme 上这个钱包的报名记录（${plain(reason)}）。没有签名，也没有发送任何东西。过几分钟再运行一次 FL enter。`
    : `feast.meme's record of this wallet could not be read (${plain(reason)}). Nothing was signed or sent. Run FL enter again in a few minutes.`;
}

/** The site kept the Register, without a seat: it was not updated for seats without a coin yet (ruling C1). */
export function seatPending(season: number, lang: Lang): string {
  return lang === "zh"
    ? `已签名报名第 ${season} 季。feast.meme 还没给出席位（网站还没更新到不发币也给席位）：笔记会话等有了席位再开；过一会儿再运行一次 FL enter。`
    : `Signed in for season ${season}. feast.meme has not given the seat yet (the site is not yet updated to seat an agent without a coin): the notes session waits for the seat; run FL enter again in a while.`;
}

export function agentNameNeeded(agentId: string, lang: Lang): string {
  return lang === "zh"
    ? `${shownName(agentId)} 太长，不能直接做 agent 的名字（最多 40 个小写字母、数字或横线）：用 --agent <name> 给它起个名字。没有发送任何东西。`
    : `${shownName(agentId)} is too long for an agent's name (at most 40 lowercase letters, digits or dashes): name it with --agent <name>. Nothing was sent.`;
}

export function agentNameBad(given: string, lang: Lang): string {
  const g = clean(given, 60);
  return lang === "zh" ? `「${g}」不能做 agent 的名字：1–40 个小写字母、数字或横线，且不能是 league-entry。没有发送任何东西。` : `"${g}" can't be an agent's name: 1–40 lowercase letters, digits or dashes, and not league-entry. Nothing was sent.`;
}

export function notPlanned(errors: string[], lang: Lang): string {
  const list = errors.map((e) => `- ${clean(e, 200)}`).join("\n");
  return lang === "zh" ? `agent 没能规划，没有发送任何东西：\n${list}` : `The agent could not be planned, and nothing was sent:\n${list}`;
}

export function runningOtherCard(name: string, lang: Lang): string {
  return lang === "zh"
    ? `agent「${name}」正在运行，但卡片变了：先停下它（FL stop ${name}），再运行 FL enter。没有发送任何东西。`
    : `Agent "${name}" is running, and its card changed: stop it first (FL stop ${name}), then run FL enter again. Nothing was sent.`;
}

export function startRefused(why: string, lang: Lang): string {
  return lang === "zh" ? `没有启动：${clean(why, 300)}` : `Not started: ${clean(why, 300)}`;
}

export function startedLine(name: string, pid: number, lang: Lang): string {
  return lang === "zh" ? `已在后台启动「${name}」（pid ${pid}）；FL status ${name} 查看。` : `started "${name}" in the background (pid ${pid}); FL status ${name}`;
}

export function alreadyRunning(name: string, lang: Lang): string {
  return lang === "zh" ? `「${name}」已经在运行，没有再启动一个。` : `"${name}" is already running; it was not started again.`;
}

export function startCard(lang: Lang): string {
  return lang === "zh" ? "启动你的 agent" : "Start your agent";
}

// --- the meme (task 968) ----------------------------------------------------------------------------

export const MEME_RULES_EN =
  'the name ends with "feed", at most 20 letters, digits and spaces; the symbol at most 8 capitals or digits; the description one sentence on one line, at most 140 characters, with no address and no link; from the player\'s concept only, and no other platform\'s name. A picture is optional: a PNG of at most 256 KB made from the name and the description; without one, the league creature is used';
export const MEME_RULES_ZH = "名字以 feed 结尾，最多 20 个字母、数字或空格；代码最多 8 个大写字母或数字；简介一句话、一行、最多 140 个字符，不能有地址或链接；只用玩家的概念，不提其他平台的名字。图片可选：用名字和简介生成一张不超过 256 KB 的 PNG；没有的话用联赛形象。";

/** `--meme` without the composed fields: the host composes them from the concept, and runs the command again. */
export function composeCard(concept: string, lang: Lang): string {
  const zh = lang === "zh";
  return [
    zh ? `按玩家的概念组一枚 meme：「${clean(concept, 120)}」` : `Compose the meme from the player's concept: "${clean(concept, 120)}"`,
    "",
    zh ? "然后带上这些参数再运行同一条命令：" : "Then run the same command again with:",
    '  --coin-name "<…feed>" --symbol <SYMBOL> --description "<one sentence>" [--image <file.png>]',
    "",
    zh ? `规则：${MEME_RULES_ZH}` : `The rules: ${MEME_RULES_EN}.`,
    "",
    zh ? "还没有发送任何东西。" : "Nothing was sent.",
  ].join("\n");
}

export function memeRefused(reason: string, lang: Lang): string {
  const zh = lang === "zh";
  const why: Record<string, [string, string]> = {
    "concept-empty": ["give the meme a one-line concept", "给 meme 一句话的概念"],
    "concept-too-long": ["the concept is over 120 characters: make it one line", "概念超过 120 个字符：写成一句话"],
    "name-empty": ["give the coin a name (letters, digits and spaces)", "给这个币起个名字（字母、数字或空格）"],
    "symbol-empty": ["give the coin a symbol (capitals or digits)", "给这个币一个代码（大写字母或数字）"],
    "description-empty": ["give the coin a one-sentence description", "给这个币一句话简介"],
    "description-too-long": ["the description is over 140 characters", "简介超过 140 个字符"],
    "description-lines": ["the description is one line", "简介只能一行"],
    "description-address": ["the description holds an address: it would be published for good", "简介里有地址：它会被永久公开"],
    "description-url": ["the description holds a link: it would be published for good", "简介里有链接：它会被永久公开"],
  };
  const [en, cn] = why[reason] ?? [reason, reason];
  return zh ? `这枚 meme 不能发：${cn}。没有发送任何东西；改好后再运行一次。` : `The meme can't launch as composed: ${en}. Nothing was sent; fix it and run the command again.`;
}

export type MemePictureShown = { source: "host"; name: string; bytes: number } | { source: "league"; url: string } | { source: "ticker" };

function memePictureRow(picture: MemePictureShown, lang: Lang): string {
  const zh = lang === "zh";
  if (picture.source === "host") return zh ? `你的图片 ${clean(picture.name, 60)}（PNG，${Math.ceil(picture.bytes / 1024)} KB）` : `your picture ${clean(picture.name, 60)} (PNG, ${Math.ceil(picture.bytes / 1024)} KB)`;
  if (picture.source === "league") return zh ? `联赛形象 ${picture.url}` : `the league creature, ${picture.url}`;
  return zh ? "按代码生成的图案" : "the ticker's identicon";
}

export function hostPictureNotUsed(why: string, lang: Lang): string {
  return lang === "zh" ? `你的图片没有用上：${plain(why)}；改用联赛形象。` : `Your picture was not used: ${plain(why)}; the league creature is used instead.`;
}

/** The meme's preview card: what will launch, and the yes it needs. */
export function memeCard(view: { name: string; symbol: string; description: string; quote: string; picture: MemePictureShown; first: boolean }, lang: Lang): string {
  const zh = lang === "zh";
  return [
    zh ? `发出你的 meme：${view.name}` : `Launch your meme: ${view.name}`,
    "",
    table([
      [zh ? "名字" : "Name", view.name],
      [zh ? "代码" : "Ticker", view.symbol],
      [zh ? "简介" : "About", zh ? `「${clean(view.description, 140)}」` : `"${clean(view.description, 140)}"`],
      [zh ? "图片" : "Picture", memePictureRow(view.picture, lang)],
      [zh ? "配对" : "Paired with", view.quote],
      [
        zh ? "手续费分配" : "Fee split",
        zh
          ? "默认：每笔交易 1% 的手续费里，平台 20 点，回购销毁 20 点，引荐人 10 点，你作为创建者 50 点（没有引荐人的交易是 60 点）"
          : "the default: of the 1% fee on every trade, 20 points go to the platform, 20 are bought back and burned, 10 go to referrers, and 50 go to you as its creator (60 when a trade has no referrer)",
      ],
      [zh ? "费用" : "Cost", zh ? "只有 gas；发送前钱包会先预览这笔交易" : "gas only; your wallet previews the transaction before it is sent"],
      [zh ? "限额" : "Limits", zh ? "走 league-entry 的硬限额（L12 每小时交易数；L16 钱包、Developer Mode 与停止文件）；每只 agent 只发一次" : "league-entry's hard limits apply (L12 trades per hour; L16 the wallet, Developer Mode and the stop file); one launch per agent"],
    ]),
    "",
    ...(view.first ? [zh ? "这枚币会成为你的 agent 的币。" : "This coin becomes your agent's coin."] : []),
    zh ? "这个币永久公开在 Feast 上，不管你的 agent 后来怎样，它都照常交易。" : "The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.",
    "",
    zh ? "你说「好」之后，会立刻从你的钱包发出一笔真实交易。" : "This sends a real transaction from your wallet as soon as you say yes.",
  ].join("\n");
}

export function secondMeme(symbol: string | null, coin: string, lang: Lang): string {
  return lang === "zh"
    ? `你的 agent 的币是 ${coinShown(symbol, coin)}，它一直是你的 agent 的币。league-entry 只发一枚币，这次没有发。`
    : `Your agent's coin is ${coinShown(symbol, coin)}; it stays your agent's coin. league-entry launches one coin, so nothing was launched.`;
}

export function seatAfterLaunch(seat: number | null, lang: Lang): string {
  if (seat !== null) return lang === "zh" ? `你的席位：第 ${seat} 号。` : `Your seat: ${seat}.`;
  return lang === "zh" ? "feast.meme 很快会按这次发币给你的 agent 席位；FL status 会显示。" : "feast.meme seats your agent from its launch shortly; FL status shows the seat.";
}

export function memeNoEntry(lang: Lang): string {
  return lang === "zh" ? "这台电脑上还没有报名：先运行 FL enter。" : "No entry on this machine: run FL enter first.";
}

// --- done ------------------------------------------------------------------------------------

/** After the entry with --no-start: the next step is the prompt (the owner's ruling, 2026-10-24). */
export function doneLine(lang: Lang): string {
  return lang === "zh" ? "你已报名。写好你的 strategy.md，然后运行 `FL start <name> --prompt strategy.md`" : "You're in. Write your strategy.md and run `FL start <name> --prompt strategy.md`";
}

/** After the entry that started the agent (task 968). */
export function doneRunning(name: string, opens: OpensShown, lang: Lang): string {
  const zh = lang === "zh";
  const when =
    opens.kind === "open" ? (zh ? "赛季已经开始，它现在就交易" : "the season is open, so it trades now") : opens.kind === "at" ? (zh ? `它等待赛季开始，从 ${opensText(opens, lang)}起交易` : `it waits for the season and trades from ${opensText(opens, lang)}`) : zh ? "它等待赛季开始，feast.meme 宣布开赛后才交易" : "it waits for the season and trades once feast.meme announces the start";
  return zh
    ? `你已报名，「${name}」正在运行：${when}。如果它停了，运行 \`FL start ${name}\`。改了 strategy.md 之后，\`FL start ${name} --prompt strategy.md\` 会给出新卡片，需要你说「好」。`
    : `You're in, and ${name} is running: ${when}. If it stops, run \`FL start ${name}\`. A changed strategy.md needs \`FL start ${name} --prompt strategy.md\`, its new card and your yes.`;
}

export function alreadyEntered(view: { agentId: string; coin: string | null; notes: string | null; season?: number | null; seat?: number | null }, lang: Lang): string {
  const zh = lang === "zh";
  const who = shownName(view.agentId);
  const seat = view.seat !== null && view.seat !== undefined ? (zh ? `，第 ${view.seat} 号席位` : `, seat ${view.seat}`) : "";
  const coin = view.coin ? (zh ? `；它的币是 ${short(view.coin)}` : `; its coin is ${short(view.coin)}`) : "";
  const head = zh ? `已经报名：${who}${view.season ? ` 在第 ${view.season} 季` : ""}${seat}${coin}。现在不用再做什么。` : `Already entered: ${who}${view.season ? ` is in season ${view.season}` : ""}${seat}${coin}. Nothing more to do now.`;
  const notes = view.notes === "open" || view.notes === "dev" ? [] : [zh ? "还没有笔记会话：用 FL note --login 开通（签一条消息，不花 gas）。" : "No notes session yet: FL note --login opens one (one signed message, no gas)."];
  return [head, ...notes].join("\n");
}
