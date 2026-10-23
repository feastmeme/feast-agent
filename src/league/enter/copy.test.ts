import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as copy from "./copy.ts";

/**
 * The entry reward is cancelled (the coordinator's ruling, 2026-10-23 22:49 SGT):
 * the buy is part of entering, not a reward. No sentence of the entry's copy
 * may promise one, in either language.
 */

const SOURCE = readFileSync(join(import.meta.dirname, "copy.ts"), "utf8");
/**
 * The reward's phrasings, and the step-1 open time that only mattered for it. "in any 24 h" (L2's window)
 * is not among them, and neither is the buy card's "the league's step 1", which names the buy, not a reward.
 */
const REWARD = [/USDT worth/i, /worth of FEAST/i, /hold it/i, /held 24/i, /\b72 ?h\b/i, /\bearns?\b/i, /\breward/i, /\bseats?\b/i, /Step 1 opens/i, /does not count/i, /拿住/, /持有/, /等值/, /奖励/, /席位/, /第 1 步在/, /不算数/];

describe("the entry's copy promises no reward", () => {
  it("no reward sentence anywhere in the copy module", () => {
    for (const pattern of REWARD) expect(SOURCE, String(pattern)).not.toMatch(pattern);
  });

  it("after the buy, one line: you're in, and the season-day command", () => {
    expect(copy.doneLine("en")).toBe("You're in. On season day run `FL start`.");
    expect(copy.doneLine("zh")).toBe("你已报名。开赛当天运行 `FL start`。");
    for (const lang of ["en", "zh"] as const) {
      const entered = copy.alreadyEntered({ agentId: "maplegrin", coin: "0x00000000000000000000000000000000000c0de1", txHash: `0x${"ab".repeat(32)}`, atMs: Date.parse("2026-10-24T13:00:00Z") }, lang);
      expect(entered.split("\n").at(-1)).toBe(copy.doneLine(lang));
      for (const pattern of REWARD) expect(entered).not.toMatch(pattern);
    }
  });

  it("the buy card in BNB (the owner's ruling, 2026-10-24), byte for byte, and names no reward", () => {
    const view = { agentId: "maplegrin", coin: "0x00000000000000000000000000000000000c0de1", symbol: "TODAY", bnb: 0.01, usdt: 6, slippagePct: 3, maxTradeBnb: 0.02, budgetBnb: 0.25, maxDailySpendBnb: 0.1 };
    expect(copy.buyCard(view, "en")).toBe(BUY_CARD_EN);
    expect(copy.buyCard(view, "zh")).toBe(BUY_CARD_ZH);
    for (const card of [BUY_CARD_EN, BUY_CARD_ZH]) for (const pattern of REWARD) expect(card, String(pattern)).not.toMatch(pattern);
    // Without a price, the amount row has no USDT figure at all.
    expect(copy.buyCard({ ...view, usdt: null }, "en")).toBe(BUY_CARD_EN.replace(" ≈ 6.00 USDT", ""));
    expect(copy.buyCard({ ...view, usdt: null }, "zh")).toBe(BUY_CARD_ZH.replace(" ≈ 6.00 USDT", ""));
  });
});

/** The buy card after the owner's ruling of 2026-10-24: 0.01 BNB, with a USDT figure only for reference. */
const BUY_CARD_EN = "Buy today's coin for maplegrin.ai\n\n| | |\n| --- | --- |\n| Coin | TODAY (0x0000…0de1): today's coin, assigned from the 08:00 SGT block |\n| Amount | 0.01 BNB (the entry's amount) ≈ 6.00 USDT |\n| Slippage | at most 3% |\n| After the buy | up to two approvals, so that a later sale is one transaction |\n| Cost | the amount above, and gas for up to three transactions; your wallet previews each before it is sent |\n| Limits | the default hard limits apply (L1 one trade 0.02 BNB; L2 0.1 BNB in any 24 h; L3 0.25 BNB from this wallet in all; L16 the wallet, Developer Mode and the stop file) |\n\nThis is the league's step 1: one buy of another agent's body coin. Nothing trades after it: trading starts on season day, with its own command.\n\nThis sends a real transaction from your wallet as soon as you say yes.";
const BUY_CARD_ZH = "为 maplegrin.ai 买今天的币\n\n| | |\n| --- | --- |\n| 币 | TODAY (0x0000…0de1)：今天分到的币，按新加坡时间 08:00 的区块抽取 |\n| 金额 | 0.01 BNB（报名金额） ≈ 6.00 USDT |\n| 滑点 | 最多 3% |\n| 买入之后 | 最多两笔授权，这样以后卖出只要一笔交易 |\n| 费用 | 上面的金额，加最多三笔交易的 gas；发送前钱包会先预览每一笔 |\n| 限额 | 默认硬限额照常生效（L1 单笔 0.02 BNB；L2 每 24 小时 0.1 BNB；L3 这个钱包总共 0.25 BNB；L16 钱包、Developer Mode 与停止文件） |\n\n这是联赛的第 1 步：买一次别的 agent 的身体币。买完之后不会自动交易：自动交易在开赛当天用另一个命令启动。\n\n你说「好」之后，会立刻从你的钱包发出一笔真实交易。";
