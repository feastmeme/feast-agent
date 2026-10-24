import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";

import type { Book, Position } from "../book.ts";
import { readEntry } from "../enter/flow.ts";
import { weiToBnb } from "../limits.ts";
import { MAINNET } from "../../sdk/networks.ts";
import { LEAGUE_CAP_BNB } from "../prompt/constants.ts";
import { dayCount, dayView, leftOut, type DayView } from "../prompt/floor.ts";
import { lastHostAction, lastTradeAt, promptChanged, within } from "../prompt/host.ts";
import { statusOf } from "../runtime.ts";
import { readLedger } from "../store.ts";
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

export type SelfChain = { markWei(coin: Address, coins: bigint): Promise<bigint> };

export type PositionOut = { coin: Address; symbol: Untrusted; coins: number; costBnb: number; markBnb: number | null; pnlBnb: number | null; openedAt: string; armed: boolean };

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
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

async function marked(chain: SelfChain | null, positions: Position[], timeoutMs: number): Promise<{ out: PositionOut; markWei: bigint | null; costWei: bigint }[]> {
  return Promise.all(
    positions.map(async (p) => {
      const markWei = chain ? await within(chain.markWei(p.coin, p.coins), timeoutMs) : null;
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
        },
      };
    }),
  );
}

export async function selfView(home: string, name: string, deps: { chain: SelfChain | null; now: number; marksTimeoutMs?: number }): Promise<SelfView> {
  const s = statusOf(home, name);
  if (!s.agent) throw new Error(`no agent "${name}" on this machine`);
  const agent = s.agent;
  const book: Book | null = s.book;
  const timeout = deps.marksTimeoutMs ?? 8_000;
  // The wallet's own coin: this agent's launch, or the body coin FL enter launched or found.
  const own = new Set([book?.launched?.coin, readEntry(home)?.bodyCoin].filter((c): c is Address => Boolean(c)).map((c) => c.toLowerCase()));
  const all = Object.values(book?.positions ?? {});
  const isOwn = (p: Position) => p.ownLaunch || own.has(p.coin.toLowerCase());
  const counted = await marked(deps.chain, all.filter((p) => !isOwn(p)), timeout);
  const ownCoin = await marked(deps.chain, all.filter(isOwn), timeout);
  const dir = join(home, "agents");
  const others = existsSync(dir) ? readdirSync(dir).filter((n) => n !== name && /^[a-z0-9][a-z0-9-]{0,39}$/.test(n)) : [];
  const otherBooks: SelfView["otherBooks"] = [];
  for (const other of others.sort()) {
    const positions = Object.values(statusOf(home, other).book?.positions ?? {});
    if (positions.length > 0) otherBooks.push({ agent: other, positions: (await marked(deps.chain, positions, timeout)).map((m) => m.out) });
  }
  const unrealizedWei = counted.reduce((sum, m) => (m.markWei === null ? sum : sum + m.markWei - m.costWei), 0n);
  const spentWei = readLedger(home).spentWei;
  const host = lastHostAction(home, name);
  const lastTrade = lastTradeAt(home, name);
  const silentSince = Math.max(host?.at ?? 0, Date.parse(agent.confirmed?.at ?? "") || 0);
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
  };
}
