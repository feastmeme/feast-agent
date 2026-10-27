import { short, utc8, type Lang } from "../register/copy.ts";
import { LEAGUE_CHAIN_ID, LEAGUE_DOMAIN, shownName, ZERO_ADDRESS } from "../register/message.ts";
import { ACTIVITY_FLOOR_BNB, ACTIVITY_FLOOR_TRADES } from "../prompt/constants.ts";
import { utc8Day } from "../season-gate.ts";
import { DEFAULT_STRATEGY_VERSION, PERSONA_TEXT, type PersonaKey } from "./strategy.ts";

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

// --- the launch ---------------------------------------------------------------------------------

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

/** The notes card, when feast.meme already keeps this wallet's Register: entering is this one signature. */
/**
 * What the wallet is asked to sign, field by field (task 975, addendum 1): the EIP-712 domain and every field of the
 * Register and NoteSession messages, as `register/message.ts` and `notes/message.ts` build them, so a careful host can
 * match the card against the wallet's preview. The Agent ID is the chain's (checked), the wallet the one read.
 */
function signingRows(view: { wallet: string; agentId: string; season: number; register: boolean; notes: boolean }, lang: Lang): [string, string][] {
  const zh = lang === "zh";
  const rows: [string, string][] = [
    zh
      ? ["签名域", `EIP-712 typed data（V4）：name \`${LEAGUE_DOMAIN.name}\`，version \`${LEAGUE_DOMAIN.version}\`，chainId \`${LEAGUE_CHAIN_ID}\`（BNB Smart Chain），没有 verifying contract`]
      : ["Domain", `EIP-712 typed data (V4): name \`${LEAGUE_DOMAIN.name}\`, version \`${LEAGUE_DOMAIN.version}\`, chainId \`${LEAGUE_CHAIN_ID}\` (BNB Smart Chain), no verifying contract`],
  ];
  if (view.register)
    rows.push([
      "Register",
      zh
        ? `wallet \`${view.wallet}\`，name \`${view.agentId}\`，strategy \`""\`（空），copies \`${ZERO_ADDRESS}\`，issuedAt：签名那一刻（Unix 秒）`
        : `wallet \`${view.wallet}\`, name \`${view.agentId}\`, strategy \`""\` (empty), copies \`${ZERO_ADDRESS}\`, issuedAt: the moment it signs (Unix seconds)`,
    ]);
  if (view.notes)
    rows.push([
      "NoteSession",
      zh
        ? `wallet \`${view.wallet}\`，agentId \`${view.agentId}\`，season \`${view.season}\`，nonce：签名时随机生成的 32 字节`
        : `wallet \`${view.wallet}\`, agentId \`${view.agentId}\`, season \`${view.season}\`, nonce: 32 random bytes drawn when it signs`,
    ]);
  return rows;
}

export function notesCard(view: { agentId: string; season: number; wallet?: string }, lang: Lang): string {
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
      ...(view.wallet ? signingRows({ wallet: view.wallet, agentId: view.agentId, season: view.season, register: false, notes: true }, lang) : []),
    ]),
    "",
    zh ? "你说「好」之后，钱包会请你签这一条消息。" : "Your wallet asks for this one signature as soon as you say yes.",
  ].join("\n");
}

// --- the entry: one signed Register (task 968) --------------------------------------------------

/** When trading opens, as the cards say it. */
export type OpensShown = { kind: "at"; at: number } | { kind: "open" } | { kind: "unknown" };

/**
 * The opening as the cards say it (addenda 12 and 13): it is the season's start ("the season's start, Ddd MM/DD
 * HH:MM UTC+8"), the instant the page counts down to, never a date of the copy's own.
 */
const opensText = (opens: OpensShown, lang: Lang) => {
  const zh = lang === "zh";
  if (opens.kind === "at") return zh ? `赛季开始的 ${utc8DayZh(opens.at)}（UTC+8）` : `the season's start, ${utc8Day(opens.at)} UTC+8`;
  return zh ? "feast.meme 宣布开赛的时刻" : "feast.meme announces the start";
};

/** "MM/DD（周X）HH:MM", the zh form of `utc8Day`. */
const utc8DayZh = (ms: number) => {
  const d = new Date(ms + 8 * 3_600_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}（周${"日一二三四五六"[d.getUTCDay()]}）${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};

/** Once the season is on (task 975, addendum 1): it trades now, and when the backup would take over. */
const seasonOn = (lang: Lang, autopilot: AutopilotShown | undefined, sentence: boolean) => {
  const zh = lang === "zh";
  const later = !autopilot
    ? ""
    : asking(autopilot)
      ? zh
        ? `（你 ${autopilot.ask.every} 分钟不动，它就去问你的 ${hostName(autopilot.ask.with)}）`
        : ` (it asks your ${hostName(autopilot.ask.with)} in ${autopilot.ask.every} minutes if you go quiet)`
      : zh
        ? `（你 ${autopilot.idleMinutes} 分钟不动，autopilot 就接手）`
        : ` (autopilot in ${autopilot.idleMinutes} minutes if you go quiet)`;
  if (zh) return `赛季已经开始${sentence ? "：" : "，"}它现在就开始交易${later}`;
  return `${sentence ? "The" : "the"} season is on: it starts trading now${later}`;
};

/** Under the entry card: the agent's own card, and when it starts trading; before the season and once it is on, apart. */
export function waitingLine(opens: OpensShown, lang: Lang, autopilot?: AutopilotShown): string {
  const zh = lang === "zh";
  if (opens.kind === "open") return `${seasonOn(lang, autopilot ?? undefined, true)}${zh ? "。" : "."}`;
  // Addendum 13: trading opens at the season's start; the first dinner, a day later, is the warm-up.
  if (opens.kind === "at")
    return zh
      ? `现在就启动，等待赛季开始：${opensText(opens, lang)}开放交易，在那之前它不做任何交易。一天之后的第一次开饭是热身，不吃掉任何人。`
      : `Starts now and waits for the season: trading opens at ${opensText(opens, lang)}, and it trades nothing before. The first dinner, a day later, is the warm-up: it eats nobody.`;
  return zh ? "现在就启动，等待赛季开始：在 feast.meme 宣布开赛之前，它不做任何交易。" : "Starts now and waits for the season: it trades nothing until feast.meme announces the start.";
}

/** A prompt agent's autopilot backup as the entry shows it (task 975): its preset and minutes, or none. */
/** Task 975, addendum 4: with `ask`, the runtime asks the host's AI every `every` minutes; the preset is the floor keeper. */
export type AutopilotShown = { preset: string; idleMinutes: number; ask?: { every: number; with: string } | null } | null;

/** The host as the copy names it. */
// Addendum 11: the newer hosts by their own names; an endpoint as one ("your AI endpoint", then "that endpoint").
const hostName = (w: string) => (w === "claude" ? "Claude Code" : w === "codex" ? "Codex" : w === "gemini" ? "Gemini CLI" : w === "cursor" ? "Cursor" : w === "openai" ? "AI endpoint" : w);
/** The ask loop is on (a host to ask, not "none"). */
const asking = (a: AutopilotShown): a is NonNullable<AutopilotShown> & { ask: { every: number; with: string } } => Boolean(a?.ask && a.ask.with !== "none");

/** The backup in one sentence, under the agent's card and after "You're in" (the owner's ruling A, 2026-10-24). */
export function autopilotLine(autopilot: AutopilotShown, lang: Lang): string {
  const zh = lang === "zh";
  // Addendum 4: the three facts: it asks your AI on a timer; the floor keeper covers a failure and the dinner.
  if (asking(autopilot)) {
    const host = hostName(autopilot.ask.with);
    const again = autopilot.ask.with === "openai" ? "that endpoint" : host;
    return zh
      ? `它每 ${autopilot.ask.every} 分钟问一次你的 ${host} 该做什么（你自己没在交易的时候）；${autopilot.ask.with === "openai" ? "这个接口" : host} 联系不上，或开饭前 20 分钟当天活动门槛还没达到，它就自己守住门槛。`
      : `Every ${autopilot.ask.every} minutes it asks your ${host} what to do (while you are not trading yourself); if ${again} can't be reached, or the day's floor is still unmet 20 minutes before dinner, it keeps the floor itself.`;
  }
  if (autopilot)
    return zh
      ? `autopilot 兜底已开：你 ${autopilot.idleMinutes} 分钟不动，它就按 ${autopilot.preset} 预设交易；\`--no-autopilot\` 可关。`
      : `Autopilot backup is on: if you make no trade for ${autopilot.idleMinutes} minutes, it trades by the ${autopilot.preset} preset; \`--no-autopilot\` turns it off.`;
  return zh ? "autopilot 兜底已关：除了硬止损，只有你的 agent 自己交易；去掉 `--no-autopilot` 重新规划即可再开。" : "Autopilot backup is off: only your agent trades, besides the hard stop-loss; plan again without `--no-autopilot` to turn it back on.";
}

/**
 * The agent is a background process on this machine (task 975, addendum 3, the owner's words): asleep or stopped, it
 * trades nothing and is eaten at the dinner. The "You're in" line and `FL status` say it.
 */
/** Run 26 (the default v1.2/v1.3's closing ask, the owner's 09:1x ruling): what the wallet needs to last. */
export function fundsLine(lang: Lang): string {
  return lang === "zh" ? "钱包至少要有 0.03 BNB 才活得过第二顿。" : "The wallet needs at least 0.03 BNB to live past the second dinner.";
}

export function awakeLine(lang: Lang): string {
  return lang === "zh"
    ? "赛季期间保持这台电脑不休眠（或放到服务器 / 云电脑上跑）：它一睡，你的 agent 就停，开饭时会被吃掉。"
    : "Keep this machine awake for the season (or run it on a server or cloud computer); if it sleeps, your agent stops and gets eaten.";
}

/**
 * Once the season is on, the host is told in so many words to start (task 975, addendum 2: in the rehearsal a host
 * that was not told ended its session; told, it traded at once). The "You're in" line and `FL status` end with it.
 */
/**
 * Run 21 (the Grok cloud rehearsal): with `--ask-with none` nobody is asked on a timer, so the player's AI decides
 * through the pack by hand: `FL ask <name> --print`, then `FL answer <name> '<json>'`. Said where the closing lines and
 * `FL status` speak of the backup.
 */
export function driveByAnswerLine(name: string, lang: Lang): string {
  return lang === "zh"
    ? `运行时不会定时去问任何 AI：要让你的 AI 决策，运行 \`FL ask ${name} --print\`，用一个 JSON 对象回答这个包，再用 \`FL answer ${name} '<那个 JSON 对象>'\` 交给它。`
    : `Nobody is asked on a timer: to decide with your AI, run \`FL ask ${name} --print\`, answer the pack with one JSON object, and hand it over with \`FL answer ${name} '<the JSON object>'\`.`;
}

export function tradeNowLine(autopilot: AutopilotShown, promptFile: string, lang: Lang, name?: string): string {
  const zh = lang === "zh";
  if (asking(autopilot))
    return zh
      ? `赛季已经开始。现在就按 ${promptFile} 决策和交易；你 ${autopilot.ask.every} 分钟不动，运行时就去问你的 ${hostName(autopilot.ask.with)} 该做什么。`
      : `The season is on. Decide and trade now by ${promptFile}; if you go quiet for ${autopilot.ask.every} minutes, the runtime asks your ${hostName(autopilot.ask.with)} what to do.`;
  if (autopilot) {
    const drive = name ? `${zh ? "" : " "}${driveByAnswerLine(name, lang)}` : "";
    return zh
      ? `赛季已经开始。现在就按 ${promptFile} 决策和交易；你 ${autopilot.idleMinutes} 分钟不动，autopilot（${autopilot.preset}）就接手。${drive}`
      : `The season is on. Decide and trade now by ${promptFile}; if you go quiet for ${autopilot.idleMinutes} minutes, autopilot (${autopilot.preset}) takes over.${drive}`;
  }
  return zh
    ? `赛季已经开始。现在就按 ${promptFile} 决策和交易；没有 autopilot 兜底，你不动时除了硬止损什么都不交易。`
    : `The season is on. Decide and trade now by ${promptFile}; with no autopilot backup, nothing trades while you are quiet but the hard stop-loss.`;
}

/** `persona` (task 1020): the default's style, when the strategy is the season-1 default (copied now, or a copy left as it was). */
export type StrategyShown = { kind: "default"; path: string; persona?: PersonaKey | null } | { kind: "existing"; path: string; persona?: PersonaKey | null } | { kind: "given"; path: string };

export function strategyLine(view: StrategyShown, name: string, lang: Lang): string {
  const zh = lang === "zh";
  const style = view.kind !== "given" && view.persona ? (zh ? `；风格：${view.persona}（${PERSONA_TEXT[view.persona].zh}）` : `; style: ${view.persona} (${PERSONA_TEXT[view.persona].en})`) : "";
  if (view.kind === "default")
    return zh
      ? `策略：第一季默认策略 ${DEFAULT_STRATEGY_VERSION}，已复制到 ${view.path}${style}；随时可以改，改完运行 \`FL start ${name} --prompt ${view.path}\` 会给出新卡片。`
      : `Strategy: the season-1 default strategy, copied to ${view.path} (${DEFAULT_STRATEGY_VERSION})${style}; edit it any time, then \`FL start ${name} --prompt ${view.path}\` shows the new card.`;
  if (view.kind === "existing") return zh ? `策略：你的 strategy.md（已有的，没有改动）：${view.path}${style}` : `Strategy: your strategy.md (existing, left as it is): ${view.path}${style}`;
  return zh ? `策略：你的 ${view.path}` : `Strategy: your ${view.path}`;
}

/** The entry card: the Register signature, the notes signature, and the agent's start, under one yes. */
export function entryCard(view: { agentId: string; season: number; notes: boolean; agent: string | null; wallet?: string; seasonOn?: boolean; ref?: string | null; manual?: boolean }, lang: Lang): string {
  const zh = lang === "zh";
  const who = shownName(view.agentId);
  const rows: [string, string][] = [
    [zh ? "内容" : "What", zh ? "签一条消息报名本季：不是交易，不花 gas，不动资金" : "sign one message to enter the season: no transaction, no gas, no funds"],
    [zh ? "消息里有" : "It carries", zh ? `这个钱包、Agent ID ${who}、一段空的公开宣言、签名时间（EIP-712 Register）` : `this wallet, the Agent ID ${who}, an empty public manifesto, the time (EIP-712 Register)`],
    [zh ? "发送到" : "Sent to", zh ? "feast.meme（/api/league/register）" : "feast.meme (/api/league/register)"],
  ];
  // Addendum 12: the tutorial's referral code goes beside the signature, never in it.
  if (view.ref) rows.push([zh ? "推荐码" : "Referral", zh ? `${view.ref}：随报名一起发送（不签进消息）` : `${view.ref}: sent with the registration (not part of the signed message)`]);
  if (view.notes) rows.push([zh ? "然后" : "Then", zh ? `再签一条消息，开通 ${who} 第 ${view.season} 季的笔记会话（EIP-712 NoteSession），同一个「好」` : `one more message, under the same yes, that opens ${who}'s notes session for season ${view.season} (EIP-712 NoteSession)`]);
  if (view.agent)
    rows.push([
      zh ? "最后" : "Last",
      view.manual
        ? zh ? `记下你的 agent「${view.agent}」，手动模式：不启动运行循环，不安装守护进程，由你逐条命令驱动（它的卡片在下面）` : `your agent "${view.agent}" is recorded in manual mode: no loop starts and no daemon is installed; you drive it command by command (its card is below)`
        : view.seasonOn
        ? zh ? `启动你的 agent「${view.agent}」，赛季已经开始，它现在就交易（它的卡片在下面）` : `your agent "${view.agent}" starts and, the season being on, trades now (its card is below)`
        : zh ? `启动你的 agent「${view.agent}」，等待赛季开始（它的卡片在下面）` : `your agent "${view.agent}" starts and waits for the season (its card is below)`,
    ]);
  if (view.wallet) rows.push(...signingRows({ wallet: view.wallet, agentId: view.agentId, season: view.season, register: true, notes: view.notes }, lang));
  const count = view.notes ? 2 : 1;
  return [
    zh ? `${who} 报名第 ${view.season} 季` : `Enter ${who} in season ${view.season}`,
    "",
    table(rows),
    "",
    zh
      ? `你说「好」之后，钱包会请你签${count === 2 ? "最多两条" : "一条"}消息；Binance App 可能要你逐条确认。`
      : `Your wallet asks for ${count === 2 ? "at most two signatures" : "one signature"} as soon as you say yes; the Binance App may ask you to confirm ${count === 2 ? "each" : "it"}.`,
  ].join("\n");
}

/** The agent's part of a card: the strategy, its card, when it trades, and its autopilot backup. */
export function agentSection(view: { strategy: StrategyShown; name: string; card: string; opens: OpensShown; autopilot?: AutopilotShown; signInEnd?: number | null; manual?: boolean }, lang: Lang): string {
  // Run 21: in manual mode nothing starts and nothing backs it up: the card's own manual line says so, no "starts now".
  if (view.manual) return [strategyLine(view.strategy, view.name, lang), "", view.card, ...(view.signInEnd ? ["", signInSentence(view.signInEnd, lang)] : [])].join("\n");
  return [strategyLine(view.strategy, view.name, lang), "", view.card, "", waitingLine(view.opens, lang, view.autopilot), ...(view.autopilot !== undefined ? [autopilotLine(view.autopilot, lang)] : []), ...(view.signInEnd ? [signInSentence(view.signInEnd, lang)] : [])].join("\n");
}

/** The wallet's sign-in on the entry card (task 975, addendum 8): the date to scan again by, en and zh. */
export function signInSentence(end: number, lang: Lang): string {
  return lang === "zh"
    ? `钱包登录将于 ${utc8(end)} UTC+8 到期：在那之前重新扫码，否则 agent 会停止交易，连守门和止损也不会做（\`FL login\` 会告诉你怎么做）。`
    : `Wallet sign-in ends at ${utc8(end)} UTC+8: re-scan before then or the agent stops trading, the floor keeper and the stop-loss included (\`FL login\` says how).`;
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

/** Addendum 11: started by the machine's supervisor, which starts it again after a reboot or a crash. */
export function daemonLine(name: string, lang: Lang): string {
  return lang === "zh"
    ? `「${name}」已交给本机的守护进程启动：重启或崩溃后它会自己再起来；\`FL daemon ${name} --uninstall\` 可取消。`
    : `"${name}" is started by this machine's daemon: it comes back by itself after a reboot or a crash; \`FL daemon ${name} --uninstall\` removes it.`;
}

/** Run 19: the daemon is installed, but the machine's supervisor did not start the agent; it runs in the background. */
export function daemonNotStartedLine(name: string, lang: Lang): string {
  return lang === "zh"
    ? `守护进程已安装，但本机的守护进程管理器还没有启动「${name}」：它现在已在后台运行；下次登录或重启后由守护进程接管。`
    : `The daemon is installed, but this machine's supervisor did not start "${name}": it runs in the background now, and the daemon takes over at the next log-in or reboot.`;
}

/** Addendum 11: the player said no to the daemon. */
export function noDaemonLine(name: string, lang: Lang): string {
  return lang === "zh" ? `没有装守护进程：这台电脑重启后，运行 \`FL start ${name}\`。` : `No daemon: after this machine restarts, run \`FL start ${name}\`.`;
}

// --- the referral binding (task 975, run 17; signed by itself since run 18) ---------------------------------------

/**
 * Where a wallet's referrer stands, as one line: the entry's closing lines and `FL status` say the same.
 * Run 18 (the owner's ruling, 2026-10-25): a code the player put in the entry line is the consent, so the binding is
 * signed by itself, with no card; this line is how the player learns what was done.
 */
export type ReferrerSaid =
  | { kind: "bound"; code: string }
  | { kind: "kept"; code: string }
  | { kind: "other"; code: string }
  | { kind: "bound-unread"; code: string }
  | { kind: "unknown"; code: string }
  | { kind: "self"; code: string }
  | { kind: "later"; code: string; who: "wallet" | "chain" | "site" }
  | { kind: "failed"; code: string }
  | { kind: "kept-before"; code: string }
  | { kind: "not-signed"; code: string; why: string }
  | { kind: "refused"; code: string; name: string }
  | { kind: "next"; code: string }
  | { kind: "unread"; code: string };

export function referrerLine(r: ReferrerSaid, lang: Lang): string {
  const zh = lang === "zh";
  const c = r.code;
  switch (r.kind) {
    case "bound":
      return zh ? `引荐人:已绑定 ${c}` : `Referrer: bound to ${c}`;
    case "kept":
      return zh ? `引荐人:已绑定 ${c}（已自动签名，免费；feast.meme 的 keeper 正在上链）` : `Referrer: bound to ${c} (signed by itself, free; feast.meme's keeper is putting it on chain)`;
    case "other":
      return zh ? `引荐人:已绑定（早已绑定另一位，不是 ${c}；引荐人不会再变）` : `Referrer: bound, to someone else before ${c} (a referrer never changes)`;
    case "bound-unread":
      return zh ? "引荐人:已绑定" : "Referrer: bound";
    case "unknown":
      return zh ? `引荐人:未绑定（推荐码 ${c} 在 feast.meme 上对应不到任何人）` : `Referrer: not bound (the code ${c} names nobody on feast.meme)`;
    case "self":
      return zh ? `引荐人:不适用（推荐码 ${c} 是这个钱包自己的）` : `Referrer: not applicable (the code ${c} is this wallet's own)`;
    case "later": {
      const who = zh ? { wallet: "钱包", chain: "链", site: "feast.meme" }[r.who] : { wallet: "the wallet", chain: "the chain", site: "feast.meme" }[r.who];
      return zh ? `引荐人:未绑定（${who}暂时没有回应，什么都没签；下次 FL enter 会自动再试）` : `Referrer: not bound yet (${who} did not answer; nothing was signed; the next FL enter tries again)`;
    }
    case "kept-before":
      return zh ? `引荐人:推荐码 ${c} 的引荐绑定已保存，不再签名（FL status 显示是否已上链）` : `Referrer: referral kept (code ${c}), nothing signed again; FL status says whether it is on chain yet`;
    case "failed":
      return zh ? "引荐人:未绑定（这次没能完成绑定；下次 FL enter 会自动再试）" : "Referrer: not bound yet (the binding could not be done just now; the next FL enter tries again)";
    case "not-signed":
      return zh ? `引荐人:未绑定（钱包没有签名：${r.why}；什么都没发送；下次 FL enter 会自动再试）` : `Referrer: not bound yet (the wallet did not sign: ${r.why}; nothing was sent; the next FL enter tries again)`;
    case "refused":
      return zh ? `引荐人:未绑定（feast.meme 拒绝了：${r.name}；下次 FL enter 会自动再试）` : `Referrer: not bound (feast.meme refused it: ${r.name}; the next FL enter tries again)`;
    case "next":
      return zh ? `引荐人:未绑定（下次 FL enter 会自动签名绑定 ${c}）` : `Referrer: not bound yet (the next FL enter signs the binding to ${c} by itself)`;
    case "unread":
      return zh ? "引荐人:暂时读不到（链没有回应）" : "Referrer: not read just now (the chain did not answer)";
  }
}

/** Addendum 12: a code given once the wallet is registered: a referral goes with the registration only. */
export function refNotSent(ref: string, lang: Lang): string {
  return lang === "zh" ? `推荐码 ${ref} 没有发送：这个钱包已经报名，推荐码只能随报名一起发送。` : `The referral code ${ref} was not sent: this wallet is registered already, and a code goes with the registration only.`;
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

/** `meme.ts`'s reasons, in Chinese. */
const PICTURE_WHY_ZH: Record<string, string> = {
  "there is no file at that path": "这个路径下没有文件",
  "it is not a file": "它不是一个文件",
  "it could not be read": "读不出来",
  "it is over 262,144 bytes": "超过 262,144 字节",
  "it is a JPEG, not a PNG": "它是 JPEG，不是 PNG",
  "it is a WebP, not a PNG": "它是 WebP，不是 PNG",
  "it is a GIF, not a PNG": "它是 GIF，不是 PNG",
  "it is another kind of file, not a PNG": "它不是 PNG 图片",
};

export function hostPictureNotUsed(why: string, lang: Lang): string {
  return lang === "zh" ? `你的图片没有用上：${PICTURE_WHY_ZH[why] ?? plain(why)}；改用联赛形象。` : `Your picture was not used: ${plain(why)}; the league creature is used instead.`;
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
      [zh ? "限额" : "Limits", zh ? "走 league-entry 的硬限额（L16 钱包、Developer Mode 与停止文件）；每只 agent 只发一次" : "league-entry's hard limits apply (L16 the wallet, Developer Mode and the stop file); one launch per agent"],
    ]),
    "",
    ...(view.first ? [zh ? "这枚币会成为你的 agent 的币。" : "This coin becomes your agent's coin."] : []),
    zh ? "这个币永久公开在 Feast 上，不管你的 agent 后来怎样，它都照常交易。" : "The coin is permanent and public on Feast, and it keeps trading whatever happens to your agent.",
    "",
    zh ? "你说「好」之后，会立刻从你的钱包发出一笔真实交易。" : "This sends a real transaction from your wallet as soon as you say yes.",
  ].join("\n");
}

export function memePause(name: string, lang: Lang): string {
  return lang === "zh" ? `「${name}」正在运行：发币时它会暂停一下，发完马上重新启动（开赛前它照样等待）。` : `"${name}" is running: it pauses for the launch and starts again right after (before the season it goes on waiting).`;
}

export function pauseFailed(name: string, lang: Lang): string {
  return lang === "zh"
    ? `「${name}」没有在 150 秒内停下（它先把已发出的交易记完）。没有发币，它照常运行。过一分钟再运行同一条命令。`
    : `"${name}" did not stop within 150 s (it finishes recording a sent transaction first). Nothing was launched, and it keeps running. Run the same command again in a minute.`;
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

/** After the entry that started the agent (task 968), with its autopilot backup (task 975). */
export function doneRunning(name: string, opens: OpensShown, lang: Lang, autopilot?: AutopilotShown, promptFile = "strategy.md", upgrade: string | null = null): string {
  const line = doneRunningLine(name, opens, lang, autopilot, promptFile);
  // Addendum 8: a runtime behind the page's newest release says the upgrade command, last.
  return upgrade ? `${line}${lang === "zh" ? "" : " "}${upgrade}` : line;
}

function doneRunningLine(name: string, opens: OpensShown, lang: Lang, autopilot?: AutopilotShown, promptFile = "strategy.md"): string {
  const zh = lang === "zh";
  // Run 21: with an autopilot and nobody asked, how the player's AI decides by hand.
  const drive = autopilot && !asking(autopilot) ? `${driveByAnswerLine(name, lang)}${zh ? "" : " "}` : "";
  const backup = `${autopilot !== undefined ? `${autopilotLine(autopilot, lang)}${zh ? "" : " "}` : ""}${drive}${awakeLine(lang)}${zh ? "" : " "}`;
  const after = zh
    ? `如果它停了，运行 \`FL start ${name}\`。改了 strategy.md 之后，\`FL start ${name} --prompt strategy.md\` 会给出新卡片，需要你说「好」。`
    : `If it stops, run \`FL start ${name}\`. A changed strategy.md needs \`FL start ${name} --prompt strategy.md\`, its new card and your yes.`;
  const funds = `${zh ? "" : " "}${fundsLine(lang)}`;
  // The season on: the line ends by telling the host to trade now (addendum 2).
  if (opens.kind === "open") return zh ? `你已报名，「${name}」正在运行。${backup}${after}${funds}${tradeNowLine(autopilot ?? null, promptFile, lang)}` : `You're in, and ${name} is running. ${backup}${after}${funds} ${tradeNowLine(autopilot ?? null, promptFile, lang)}`;
  const when =
    opens.kind === "at" ? (zh ? `它等待赛季开始，从${opensText(opens, lang)}起交易` : `it waits for the season and trades from ${opensText(opens, lang)}`) : zh ? "它等待赛季开始，feast.meme 宣布开赛后才交易" : "it waits for the season and trades once feast.meme announces the start";
  return zh ? `你已报名，「${name}」正在运行：${when}。${backup}${after}${funds}` : `You're in, and ${name} is running: ${when}. ${backup}${after}${funds}`;
}

/**
 * Run 21: the closing lines of a manual entry (`--manual`): no loop and no daemon; how to drive it by hand, and what
 * nobody does for the player in manual mode. `already`: a rerun on a wallet that is entered (no signature asked).
 */
export function doneManual(name: string, opens: OpensShown, lang: Lang, already = false): string {
  const zh = lang === "zh";
  const when =
    opens.kind === "open"
      ? zh ? "赛季已经开始：现在就可以交易。" : "The season is on: you can trade now."
      : opens.kind === "at"
        ? zh ? `${opensText(opens, lang)}开放交易；在那之前，FL buy 会被拒绝（与运行循环时的说法相同）。` : `Trading opens at ${opensText(opens, lang)}; before that, FL buy is refused (with the same words the loop would use).`
        : zh ? "feast.meme 宣布开赛后才开放交易；在那之前，FL buy 会被拒绝。" : "Trading opens when feast.meme announces the start; before that, FL buy is refused.";
  const head = zh
    ? already
      ? `「${name}」处于手动模式：没有运行循环，也没有守护进程，不需要再签名。`
      : `你已报名，「${name}」处于手动模式：没有启动运行循环，也没有安装守护进程。`
    : already
      ? `"${name}" is in manual mode: no loop and no daemon run it, and nothing more is signed.`
      : `You're in, in manual mode: "${name}" runs no loop and no daemon.`;
  const how = zh
    ? [
        "由你一条命令一条命令地驱动它：",
        `  FL data ${name}                      行情、持仓、联赛`,
        `  FL buy ${name} <币> <BNB>            买入（在硬限额之内）`,
        `  FL sell ${name} <币> <比例>          卖出一个比例（0–1）或 all`,
        `  FL note ${name} "…" --tx <交易哈希>  在 feast.meme 上发一条笔记，附上这笔交易`,
        `  FL status ${name}                    它现在的状况，以及今天的达标进度`,
      ]
    : [
        "You drive it one command at a time:",
        `  FL data ${name}                      the market, the book, the league`,
        `  FL buy ${name} <coin> <bnb>          buy, within the hard limits`,
        `  FL sell ${name} <coin> <fraction>    sell a fraction (0–1), or all`,
        `  FL note ${name} "…" --tx <hash>      a note on feast.meme, with the trade's hash`,
        `  FL status ${name}                    where it stands, and the day's floor`,
      ];
  const honest = zh
    ? `手动模式下没有任何东西会自己交易：没有 autopilot，没有保底交易员，也没有止损盯盘。每个联赛日的达标线（${ACTIVITY_FLOOR_TRADES} 笔交易、${ACTIVITY_FLOOR_BNB} BNB）要你自己完成，否则它会在晚饭时被吃掉。`
    : `In manual mode nothing trades on its own: no autopilot, no floor keeper and no stop-loss watcher. Make the day's floor yourself (${ACTIVITY_FLOOR_TRADES} trades and ${ACTIVITY_FLOOR_BNB} BNB each league day), or it gets eaten at the dinner.`;
  const loop = zh ? `在一台一直开着的机器上，\`FL start ${name}\` 会把它切换到运行循环。` : `On a machine that stays on, \`FL start ${name}\` switches it to the loop.`;
  return [head, ...how, honest, fundsLine(lang), when, loop].join("\n");
}

/** Run 21: `FL enter --manual` while the loop runs this agent: stop it first. */
export function manualWhileRunning(name: string, lang: Lang): string {
  return lang === "zh" ? `「${name}」的运行循环正在运行：先 FL stop ${name}，再用 FL enter --manual 切换到手动模式。` : `"${name}" is running its loop: FL stop ${name} first, then FL enter --manual switches it to manual mode.`;
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
