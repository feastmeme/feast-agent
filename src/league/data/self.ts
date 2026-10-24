import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address } from "viem";

import { bookView, type Book, type Position } from "../book.ts";
import { readEntry } from "../enter/flow.ts";
import { MIN_TRADE_BNB, weiToBnb, type Limits } from "../limits.ts";
import { MAINNET } from "../../sdk/networks.ts";
import { LEAGUE_CAP_BNB } from "../prompt/constants.ts";
import { dayCount, dayView, leftOut, tailLines, type DayView } from "../prompt/floor.ts";
import { lastHostAction, lastTradeAt, promptChanged, within } from "../prompt/host.ts";
import { statusOf } from "../runtime.ts";
import { agentPaths, readLedger } from "../store.ts";
import { untrusted, type Untrusted } from "./untrusted.ts";

/**
 * An agent's own figures, in BNB (task 963): what `FL data` and `FL status`
 * show of it. Its open positions, marked at spot on the chain; realized and
 * unrealized PnL and gas; the wallet-wide spend against the league's cap; the
 * last trade and the host's last action; the day's count (task 975). The wallet's own coin is not this
 * agent's PnL, nor are other agents' positions on this machine: both are
 * listed apart. A USDT figure is never kept here: a display may
 * add one from `usdRef`.
 */

export type SelfChain = { markWei(coin: Address, coins: bigint): Promise<bigint>; balance?(owner: Address): Promise<bigint> };

export type PositionOut = {
  coin: Address;
  symbol: Untrusted;
  coins: number;
  costBnb: number;
  markBnb: number | null;
  pnlBnb: number | null;
  openedAt: string;
  armed: boolean;
  /** Task 975, addendum 5: the mark against the cost, %; null when unmarked. */
  pnlPct: number | null;
  ageMinutes: number;
  /** The best mark the runtime has seen since the buy, against the cost, %. */
  peakPnlPct: number | null;
  /** The price impact of selling all of it now, %; null when not quoted. */
  exitImpactPct: number | null;
};

/** Task 975, addendum 5: how much the hard limits leave right now, from the book and the limits (one source for FL data, FL status and the pack). */
export type Headroom = {
  maxTradeBnb: number;
  minTradeBnb: number;
  spent24hBnb: number;
  leftTodayBnb: number;
  leftSeasonBnb: number;
  exposureBnb: number;
  leftExposureBnb: number;
  openPositions: number;
  maxOpenPositions: number;
  trades1h: number;
  maxTradesPerHour: number;
  realizedLoss24hBnb: number;
  leftLoss24hBnb: number;
  drawdownBnb: number;
  maxDrawdownBnb: number;
  /** Coins an entry may not be made into yet (L13), and until when. */
  cooldowns: { coin: Address; until: string }[];
};

export type FillOut = { at: string; side: "buy" | "sell"; coin: Address; bnb: number; quotedOut: string | null; filledOut: string | null; slippagePct: number | null; gasBnb: number | null; txHash: string | null };

export type SelfView = {
  agent: string;
  track: string;
  preset: string | null;
  prompt: { path: string; sha256: string; changed: boolean } | null;
  autopilot: { preset: string; idleMinutes: number; active: boolean } | null;
  running: boolean;
  stop: string | null;
  paused: string | null;
  positions: PositionOut[];
  ownCoin: PositionOut[];
  otherBooks: { agent: string; positions: PositionOut[] }[];
  pnl: { realizedBnb: number; unrealizedBnb: number; gasBnb: number; unmarked: number };
  capital: { spentBnb: number; capBnb: number; budgetBnb: number; leftBnb: number };
  lastTradeAt: string | null;
  lastActionAt: string | null;
  lastAction: string | null;
  /** Task 975: the day's trades and volume, dinner to dinner, as the page counts its floor (own coin and FEAST left out). */
  day: DayView;
  /** Task 975, addendum 5: the wallet's BNB, the gas reserve the limits keep back, and what may be spent; null when unread. */
  wallet: { balanceBnb: number; gasReserveBnb: number; spendableBnb: number } | null;
  headroom: Headroom;
  /** The last 10 fills, with the slippage against the quote and the gas. */
  recentFills: FillOut[];
  avgGasBnb: number | null;
};

const r = (x: number, d = 6) => Number(x.toFixed(d));

export function headroomOf(book: Book | null, limits: Limits, ledgerSpentWei: bigint, now: number): Headroom {
  const v = book ? bookView(book, undefined, now) : null;
  const spent = v ? weiToBnb(v.spent24hWei) : 0;
  const exposure = v ? weiToBnb(v.exposureWei) : 0;
  const loss = v ? weiToBnb(v.realizedLoss24hWei) : 0;
  const cooldowns = Object.entries(book?.lastEntryAt ?? {})
    .map(([coin, at]) => ({ coin, until: Number(at) + limits.coinCooldownSeconds * 1_000 }))
    .filter((c) => c.until > now)
    .map((c) => ({ coin: getAddress(c.coin), until: new Date(c.until).toISOString() }));
  return {
    maxTradeBnb: limits.maxTradeBnb,
    minTradeBnb: MIN_TRADE_BNB,
    spent24hBnb: r(spent),
    leftTodayBnb: r(Math.max(0, limits.maxDailySpendBnb - spent)),
    leftSeasonBnb: r(Math.max(0, Math.min(limits.budgetBnb, LEAGUE_CAP_BNB) - weiToBnb(ledgerSpentWei))),
    exposureBnb: r(exposure),
    leftExposureBnb: r(Math.max(0, limits.maxExposureBnb - exposure)),
    openPositions: v?.openPositions ?? 0,
    maxOpenPositions: limits.maxOpenPositions,
    trades1h: v?.trades1h ?? 0,
    maxTradesPerHour: limits.maxTradesPerHour,
    realizedLoss24hBnb: r(loss),
    leftLoss24hBnb: r(Math.max(0, limits.maxDailyLossBnb - loss)),
    drawdownBnb: v ? r(weiToBnb(v.drawdownWei)) : 0,
    maxDrawdownBnb: limits.maxDrawdownBnb,
    cooldowns,
  };
}

/** The last fills of the agent's log, each with its quote (the `*.prepared` line of the same id), oldest first. */
export function recentFillsOf(home: string, name: string, count = 10): FillOut[] {
  const lines = tailLines(agentPaths(home, name).log);
  const prepared = new Map<string, string>();
  const out: FillOut[] = [];
  for (const line of lines) {
    if (!line.includes('"buy.') && !line.includes('"sell.')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof e.id === "string" ? e.id : null;
    if ((e.event === "buy.prepared" || e.event === "sell.prepared") && id && typeof e.quotedOut === "string") prepared.set(id, e.quotedOut);
    if (e.event !== "buy.filled" && e.event !== "sell.filled") continue;
    if (typeof e.coin !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(e.coin)) continue;
    const side = e.event === "buy.filled" ? "buy" : "sell";
    const bnbWei = String((side === "buy" ? e.bnbInWei : e.bnbOutWei) ?? "0");
    const filled = String((side === "buy" ? e.coinsOut : e.bnbOutWei) ?? "");
    const quoted = id ? prepared.get(id) ?? null : null;
    const slip = quoted && /^\d+$/.test(quoted) && /^\d+$/.test(filled) && BigInt(quoted) > 0n ? Number(((BigInt(quoted) - BigInt(filled)) * 1_000_000n) / BigInt(quoted)) / 10_000 : null;
    const gas = typeof e.gasWei === "string" && /^\d+$/.test(e.gasWei) ? weiToBnb(BigInt(e.gasWei)) : null;
    out.push({ at: String(e.at), side, coin: getAddress(e.coin), bnb: /^\d+$/.test(bnbWei) ? weiToBnb(BigInt(bnbWei)) : 0, quotedOut: quoted, filledOut: /^\d+$/.test(filled) ? filled : null, slippagePct: slip, gasBnb: gas, txHash: typeof e.txHash === "string" ? e.txHash : null });
  }
  return out.slice(-count);
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

async function marked(chain: SelfChain | null, positions: Position[], timeoutMs: number, now: number, exitImpact?: (coin: Address, coins: bigint) => Promise<number | null>): Promise<{ out: PositionOut; markWei: bigint | null; costWei: bigint }[]> {
  const pct = (a: bigint, cost: bigint) => (cost > 0n ? Number(((a - cost) * 1_000_000n) / cost) / 10_000 : null);
  // At most 10 exit quotes a call (addendum 5's cap): the largest positions first.
  const quoted = new Set([...positions].sort((a, b) => (b.costWei > a.costWei ? 1 : -1)).slice(0, 10).map((p) => p.coin.toLowerCase()));
  return Promise.all(
    positions.map(async (p) => {
      const markWei = chain ? await within(chain.markWei(p.coin, p.coins), timeoutMs) : null;
      const impact = exitImpact && quoted.has(p.coin.toLowerCase()) ? await within(exitImpact(p.coin, p.coins), timeoutMs) : null;
      return {
        markWei,
        costWei: p.costWei,
        out: {
          coin: p.coin,
          symbol: untrusted(p.symbol),
          coins: weiToBnb(p.coins),
          costBnb: weiToBnb(p.costWei),
          markBnb: markWei === null ? null : weiToBnb(markWei),
          pnlBnb: markWei === null ? null : weiToBnb(markWei - p.costWei),
          openedAt: new Date(p.openedAt).toISOString(),
          armed: p.armed,
          pnlPct: markWei === null ? null : pct(markWei, p.costWei),
          ageMinutes: Math.max(0, Math.round((now - p.openedAt) / 60_000)),
          peakPnlPct: pct(p.peakMarkWei, p.costWei),
          exitImpactPct: impact === null ? null : Number(impact.toFixed(3)),
        },
      };
    }),
  );
}

export async function selfView(
  home: string,
  name: string,
  deps: {
    chain: SelfChain | null;
    now: number;
    marksTimeoutMs?: number;
    /** Task 975, addendum 5: the wallet whose balance is read (the chain's `balance`), or null. */
    wallet?: Address | null;
    /** The price impact of selling `coins` of `coin` now, %. */
    exitImpact?: (coin: Address, coins: bigint) => Promise<number | null>;
  },
): Promise<SelfView> {
  const s = statusOf(home, name);
  if (!s.agent) throw new Error(`no agent "${name}" on this machine`);
  const agent = s.agent;
  const book: Book | null = s.book;
  const timeout = deps.marksTimeoutMs ?? 8_000;
  // The wallet's own coin: this agent's launch, or the body coin FL enter launched or found.
  const own = new Set([book?.launched?.coin, readEntry(home)?.bodyCoin].filter((c): c is Address => Boolean(c)).map((c) => c.toLowerCase()));
  const all = Object.values(book?.positions ?? {});
  const isOwn = (p: Position) => p.ownLaunch || own.has(p.coin.toLowerCase());
  const counted = await marked(deps.chain, all.filter((p) => !isOwn(p)), timeout, deps.now, deps.exitImpact);
  const ownCoin = await marked(deps.chain, all.filter(isOwn), timeout, deps.now);
  const dir = join(home, "agents");
  const others = existsSync(dir) ? readdirSync(dir).filter((n) => n !== name && /^[a-z0-9][a-z0-9-]{0,39}$/.test(n)) : [];
  const otherBooks: SelfView["otherBooks"] = [];
  for (const other of others.sort()) {
    const positions = Object.values(statusOf(home, other).book?.positions ?? {});
    if (positions.length > 0) otherBooks.push({ agent: other, positions: (await marked(deps.chain, positions, timeout, deps.now)).map((m) => m.out) });
  }
  const unrealizedWei = counted.reduce((sum, m) => (m.markWei === null ? sum : sum + m.markWei - m.costWei), 0n);
  const spentWei = readLedger(home).spentWei;
  const host = lastHostAction(home, name);
  const lastTrade = lastTradeAt(home, name);
  const silentSince = Math.max(host?.at ?? 0, Date.parse(agent.confirmed?.at ?? "") || 0);
  const balanceWei = deps.wallet && deps.chain?.balance ? await within(deps.chain.balance(deps.wallet), timeout) : null;
  const fills = recentFillsOf(home, name);
  const gasFills = fills.filter((f) => f.gasBnb !== null);
  const autopilot = agent.track === "prompt" && agent.preset && agent.autopilot ? { preset: agent.preset, idleMinutes: agent.autopilot.idleMinutes, active: s.running && deps.now - silentSince >= agent.autopilot.idleMinutes * 60_000 } : null;
  return {
    agent: name,
    track: agent.track,
    preset: agent.preset,
    prompt: agent.track === "prompt" && agent.prompt ? { path: agent.prompt.path, sha256: agent.prompt.sha256, changed: promptChanged(agent) === true } : null,
    autopilot,
    running: s.running,
    stop: s.stop,
    paused: book?.paused ?? null,
    positions: counted.map((m) => m.out),
    ownCoin: ownCoin.map((m) => m.out),
    otherBooks,
    pnl: { realizedBnb: weiToBnb(book?.realizedTotalWei ?? 0n), unrealizedBnb: weiToBnb(unrealizedWei), gasBnb: weiToBnb(book?.gasWei ?? 0n), unmarked: counted.filter((m) => m.markWei === null).length },
    capital: { spentBnb: weiToBnb(spentWei), capBnb: LEAGUE_CAP_BNB, budgetBnb: agent.limits.budgetBnb, leftBnb: Math.max(0, Number((Math.min(LEAGUE_CAP_BNB, agent.limits.budgetBnb) - weiToBnb(spentWei)).toFixed(9))) },
    lastTradeAt: iso(lastTrade),
    lastActionAt: iso(host?.at ?? null),
    lastAction: host?.what ?? null,
    day: dayView(dayCount(home, name, deps.now, leftOut(home, book?.launched?.coin, MAINNET.platformCoin?.address))),
    wallet: balanceWei === null ? null : { balanceBnb: weiToBnb(balanceWei), gasReserveBnb: agent.limits.gasReserveBnb, spendableBnb: r(Math.max(0, weiToBnb(balanceWei) - agent.limits.gasReserveBnb)) },
    headroom: headroomOf(book, agent.limits, spentWei, deps.now),
    recentFills: fills,
    avgGasBnb: gasFills.length > 0 ? r(gasFills.reduce((s, f) => s + f.gasBnb!, 0) / gasFills.length, 9) : null,
  };
}
