import type { Address } from "viem";

import { MAINNET } from "../../sdk/networks.ts";
import type { PositionRow, Strategy, StrategyApi, StrategyEvent } from "../strategy.ts";
import { PRESETS, type PresetId } from "./specs.ts";

/**
 * The five presets (PLAN.md §4), each a trusted strategy on the shared
 * interface. Their parameters were validated by `resolveParams`; every intent
 * they enqueue still goes through the guard like anyone's.
 *
 * Exits come before entries, and a preset exits only the positions it opened
 * (kept in its state as `mine`). The runtime's backstop stop-loss (L6) sits
 * under all of them.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type State = Record<string, unknown>;
const bag = <T>(state: State, key: string, empty: T): T => {
  if (state[key] === undefined) state[key] = empty;
  return state[key] as T;
};
const lc = (coin: string) => coin.toLowerCase();

/** A sale of a position the preset opened, at most once a minute per coin while it is pending. */
function exit(api: StrategyApi, state: State, coin: Address, fraction: number, reason: string): void {
  const exiting = bag<Record<string, number>>(state, "exiting", {});
  const now = api.read.now();
  if (now - (exiting[lc(coin)] ?? 0) < MINUTE) return;
  if (api.sell({ coin, fraction, reason })) exiting[lc(coin)] = now;
}

/** Forget the coins this preset opened that are no longer held. */
function mineHeld(api: StrategyApi, state: State): { mine: Record<string, number>; held: PositionRow[] } {
  const mine = bag<Record<string, number>>(state, "mine", {});
  const positions = api.read.positions();
  const held = positions.filter((p) => mine[lc(p.coin)] !== undefined);
  for (const coin of Object.keys(mine)) {
    const now = api.read.now();
    if (!positions.some((p) => lc(p.coin) === coin) && now - mine[coin]! > 10 * MINUTE) delete mine[coin];
  }
  return { mine, held };
}

const quoteSymbol = (quote: Address): string =>
  quote.toLowerCase() === MAINNET.contracts.wrappedNative.toLowerCase() ? "WBNB" : MAINNET.stocks.find((s) => s.address.toLowerCase() === quote.toLowerCase())?.symbol ?? "?";

// --- ① sniper ------------------------------------------------------------------------------

function sniper(): Strategy {
  const exits = (api: StrategyApi) => {
    const p = api.params as { stopLossPct: number; takeProfitPct: number; takeProfitSellPct: number; timeStopMinutes: number };
    const state = api.state;
    const tookProfit = bag<Record<string, boolean>>(state, "tookProfit", {});
    for (const position of mineHeld(api, state).held) {
      if (position.pnlPct !== null && position.pnlPct <= -p.stopLossPct) exit(api, state, position.coin, 1, `sniper: stop-loss at ${position.pnlPct.toFixed(1)}%`);
      else if (position.pnlPct !== null && position.pnlPct >= p.takeProfitPct && !tookProfit[lc(position.coin)]) {
        tookProfit[lc(position.coin)] = true;
        exit(api, state, position.coin, p.takeProfitSellPct / 100, `sniper: take-profit at +${position.pnlPct.toFixed(1)}%`);
      } else if (position.ageSeconds >= p.timeStopMinutes * 60) exit(api, state, position.coin, 1, `sniper: time stop after ${p.timeStopMinutes} min`);
    }
  };
  return {
    meta: { name: "sniper", tickSeconds: PRESETS.sniper.tickSeconds, events: PRESETS.sniper.events, watch: [] },
    onTick: exits,
    onEvent(api, event) {
      if (event.type === "trade") {
        if (bag<Record<string, number>>(api.state, "mine", {})[lc(event.coin)] !== undefined) exits(api);
        return;
      }
      if (event.type !== "coin.created") return;
      const p = api.params as { buyBnb: number; maxAgeSeconds: number; quotes: "all" | string[]; requireMetadata: boolean; maxCreatorLaunches24h: number; snipesPerHour: number };
      const now = api.read.now();
      const age = (now - event.at) / 1_000;
      if (age > p.maxAgeSeconds) return;
      if (p.quotes !== "all" && !p.quotes.includes(quoteSymbol(event.quote))) return;
      if (p.requireMetadata && !event.hasMetadata) return;
      if (api.read.launchesBy(event.creator, now - DAY) > p.maxCreatorLaunches24h) return;
      const snipes = bag<number[]>(api.state, "snipes", []).filter((t) => now - t < HOUR);
      api.state.snipes = snipes;
      if (snipes.length >= p.snipesPerHour || api.read.position(event.coin)) return;
      if (api.buy({ coin: event.coin, bnb: p.buyBnb, reason: `sniper: launched ${Math.round(age)} s ago` })) {
        snipes.push(now);
        bag<Record<string, number>>(api.state, "mine", {})[lc(event.coin)] = now;
      }
    },
  };
}

// --- ② momentum ----------------------------------------------------------------------------

function momentum(): Strategy {
  return {
    meta: { name: "momentum", tickSeconds: PRESETS.momentum.tickSeconds, events: PRESETS.momentum.events, watch: [] },
    onTick(api) {
      const p = api.params as {
        lookbackMinutes: number;
        minVolumeBnb: number;
        minNewHolders: number;
        minPriceChangePct: number;
        minAgeMinutes: number;
        maxAgeHours: number;
        buyBnb: number;
        maxPositions: number;
        exhaustionWindowMinutes: number;
        exhaustionRatio: number;
        trailingStopPct: number;
        stopLossPct: number;
        timeStopHours: number;
      };
      const now = api.read.now();
      const state = api.state;
      const entryRate = bag<Record<string, number>>(state, "entryRate", {});
      const { mine, held } = mineHeld(api, state);
      for (const position of held) {
        const k = lc(position.coin);
        const recent = api.read.trades(position.coin, { sinceMs: now - p.exhaustionWindowMinutes * MINUTE }).reduce((sum, t) => sum + (t.bnb ?? 0), 0);
        const rate = recent / p.exhaustionWindowMinutes;
        if (position.pnlPct !== null && position.pnlPct <= -p.stopLossPct) exit(api, state, position.coin, 1, `momentum: stop-loss at ${position.pnlPct.toFixed(1)}%`);
        else if (position.markBnb !== null && position.markBnb <= position.peakBnb * (1 - p.trailingStopPct / 100)) exit(api, state, position.coin, 1, "momentum: trailing stop");
        else if (position.ageSeconds >= p.timeStopHours * 3_600) exit(api, state, position.coin, 1, "momentum: time stop");
        else if (position.ageSeconds >= p.exhaustionWindowMinutes * 60 && entryRate[k] !== undefined && rate < p.exhaustionRatio * entryRate[k]!) {
          exit(api, state, position.coin, 1, "momentum: exhausted (volume rate fell)");
        }
      }
      if (held.length >= p.maxPositions) return;
      for (const row of api.read.coins({ sort: "volume", limit: 50 })) {
        const ageMinutes = row.ageSeconds / 60;
        if (ageMinutes < p.minAgeMinutes || ageMinutes > p.maxAgeHours * 60 || mine[lc(row.coin)] !== undefined || api.read.position(row.coin)) continue;
        const since = now - p.lookbackMinutes * MINUTE;
        const trades = api.read.trades(row.coin, { sinceMs: since });
        const volume = trades.reduce((sum, t) => sum + (t.bnb ?? 0), 0);
        const priced = trades.filter((t) => t.priceBnb !== null);
        const change = priced.length >= 2 ? ((priced.at(-1)!.priceBnb! - priced[0]!.priceBnb!) / priced[0]!.priceBnb!) * 100 : 0;
        const samples = api.read.holders(row.coin, since);
        const growth = samples.length >= 2 ? samples.at(-1)!.holders - samples[0]!.holders : 0;
        if (volume >= p.minVolumeBnb && growth >= p.minNewHolders && change >= p.minPriceChangePct) {
          if (api.buy({ coin: row.coin, bnb: p.buyBnb, reason: `momentum: ${volume.toFixed(3)} BNB volume, +${growth} holders, +${change.toFixed(1)}% in ${p.lookbackMinutes} min` })) {
            mine[lc(row.coin)] = now;
            entryRate[lc(row.coin)] = volume / p.lookbackMinutes;
            if (held.length + 1 >= p.maxPositions) return;
          }
        }
      }
    },
    onEvent(api, event) {
      if (event.type === "price.move" && bag<Record<string, number>>(api.state, "mine", {})[lc(event.coin)] !== undefined) this.onTick(api);
    },
  };
}

// --- ③ copy --------------------------------------------------------------------------------

function copy(): Strategy {
  type Pending = { coin: Address; due: number; leaderPrice: number | null; leaderBnb: number | null };
  const run = (api: StrategyApi) => {
    const p = api.params as { sizeMode: "fixed" | "proportional"; buyBnb: number; proportionalPct: number; maxChasePct: number; stopLossPct: number; timeStopHours: number };
    const now = api.read.now();
    const state = api.state;
    const { mine, held } = mineHeld(api, state);
    for (const position of held) {
      if (position.pnlPct !== null && position.pnlPct <= -p.stopLossPct) exit(api, state, position.coin, 1, `copy: stop-loss at ${position.pnlPct.toFixed(1)}%`);
      else if (position.ageSeconds >= p.timeStopHours * 3_600) exit(api, state, position.coin, 1, "copy: time stop");
    }
    const pending = bag<Pending[]>(state, "pending", []);
    const later: Pending[] = [];
    for (const item of pending) {
      if (item.due > now) {
        later.push(item);
        continue;
      }
      if (now - item.due > 10 * MINUTE || api.read.position(item.coin)) continue;
      // Fail closed: copy only when the chase can be measured and is inside the limit.
      const price = api.read.coin(item.coin)?.priceBnb ?? null;
      if (!item.leaderPrice || item.leaderPrice <= 0 || !price || price <= 0) {
        api.log("copy: skipped, the price move since the leader's fill cannot be measured");
        continue;
      }
      if (price > item.leaderPrice * (1 + p.maxChasePct / 100)) {
        api.log(`copy: skipped, the price is ${(((price - item.leaderPrice) / item.leaderPrice) * 100).toFixed(1)}% above the leader's fill`);
        continue;
      }
      const size = p.sizeMode === "fixed" ? p.buyBnb : Math.min((item.leaderBnb ?? 0) * (p.proportionalPct / 100), api.read.limits().maxTradeBnb);
      if (size < 0.001) continue;
      if (api.buy({ coin: item.coin, bnb: Number(size.toFixed(6)), reason: "copy: a followed wallet bought" })) mine[lc(item.coin)] = now;
    }
    state.pending = later;
  };
  return {
    meta: { name: "copy", tickSeconds: PRESETS.copy.tickSeconds, events: PRESETS.copy.events, watch: [] },
    onTick: run,
    onEvent(api, event: StrategyEvent) {
      if (event.type !== "trade") return;
      const p = api.params as { wallets: Address[]; minLeaderBuyBnb: number; delaySeconds: number; copySells: boolean };
      if (!p.wallets.some((w) => lc(w) === lc(event.payer))) return;
      if (event.side === "buy") {
        if ((event.bnb ?? 0) < p.minLeaderBuyBnb) return;
        bag<Pending[]>(api.state, "pending", []).push({ coin: event.coin, due: api.read.now() + p.delaySeconds * 1_000, leaderPrice: event.priceBnb, leaderBnb: event.bnb });
      } else if (p.copySells && bag<Record<string, number>>(api.state, "mine", {})[lc(event.coin)] !== undefined) {
        exit(api, api.state, event.coin, 1, "copy: the followed wallet sold");
      }
      run(api);
    },
  };
}

// --- ④ launch-and-run ----------------------------------------------------------------------

function launch(): Strategy {
  return {
    meta: { name: "launch", tickSeconds: PRESETS.launch.tickSeconds, events: [], watch: [] },
    onTick(api, extras) {
      const p = api.params as { name: string; symbol: string; description: string; quote: string; burnPoints: number; referrerPoints: number; openingBuyBnb: number; buybackEveryMinutes: number; minClaimBnb: number; buybackPct: number };
      const now = api.read.now();
      const state = api.state;
      const launched = api.read.launched();
      if (!launched) {
        const attempts = bag<number[]>(state, "launchAttempts", []);
        if (attempts.length >= 3 || (attempts.length > 0 && now - attempts.at(-1)! < 10 * MINUTE)) return;
        if (api.launch({ name: p.name, symbol: p.symbol, quote: p.quote, description: p.description || undefined, burn: p.burnPoints, referrer: p.referrerPoints, reason: "launch-and-run: the launch" })) attempts.push(now);
        return;
      }
      if (p.openingBuyBnb > 0 && !state.openingBought) {
        if (api.buy({ coin: launched.coin, bnb: p.openingBuyBnb, reason: "launch-and-run: the opening buy, held" })) state.openingBought = true;
        return;
      }
      const last = typeof state.lastBuyback === "number" ? state.lastBuyback : launched.at;
      if (now - last >= p.buybackEveryMinutes * MINUTE && extras) {
        if (extras.claimAndBuyBack(launched.coin, { buybackPct: p.buybackPct, minClaimBnb: p.minClaimBnb, reason: "launch-and-run: claim the creator's share and buy back" })) state.lastBuyback = now;
      }
    },
  };
}

// --- ⑤ dca ---------------------------------------------------------------------------------

function dca(): Strategy {
  const run = (api: StrategyApi) => {
    const p = api.params as { targets: "FEAST" | "topHolders"; topN: number; buyOnStart: boolean; everyMinutes: number; buyBnb: number; dipPct: number; dipBuyBnb: number; maxBuysPerDay: number; takeProfitPct: number | null };
    const now = api.read.now();
    const state = api.state;
    if (typeof state.startedAt !== "number") state.startedAt = now;
    const buys = bag<number[]>(state, "buys", []).filter((t) => now - t < DAY);
    state.buys = buys;
    const lastBuy = bag<Record<string, number>>(state, "lastBuy", {});
    const lastDip = bag<Record<string, number>>(state, "lastDip", {});
    const prices = bag<Record<string, { at: number; p: number }[]>>(state, "prices", {});
    let targets: string[];
    if (p.targets === "FEAST") targets = ["FEAST"];
    else {
      const chosenAt = typeof state.chosenAt === "number" ? state.chosenAt : 0;
      if (!Array.isArray(state.chosen) || now - chosenAt >= DAY) {
        state.chosen = api.read.coins({ sort: "holders", limit: p.topN }).map((c) => c.coin);
        state.chosenAt = now;
      }
      targets = state.chosen as string[];
    }
    for (const target of targets) {
      const row = api.read.coin(target);
      const k = lc(row?.coin ?? target);
      if (row?.priceBnb) prices[k] = [...(prices[k] ?? []), { at: now, p: row.priceBnb }].filter((x) => now - x.at < DAY);
      const last = lastBuy[k] ?? 0;
      const due = last === 0 ? p.buyOnStart || now - (state.startedAt as number) >= p.everyMinutes * MINUTE : now - last >= p.everyMinutes * MINUTE;
      if (due && buys.length < p.maxBuysPerDay) {
        if (api.buy({ coin: target, bnb: p.buyBnb, reason: last === 0 ? "dca: the first buy" : "dca: the scheduled buy" })) {
          lastBuy[k] = now;
          buys.push(now);
        }
      }
      const history = prices[k] ?? [];
      if (p.dipPct > 0 && row?.priceBnb && history.length >= 2 && buys.length < p.maxBuysPerDay && now - (lastDip[k] ?? 0) >= 6 * HOUR) {
        const high = Math.max(...history.map((x) => x.p));
        if (row.priceBnb <= high * (1 - p.dipPct / 100)) {
          if (api.buy({ coin: target, bnb: p.dipBuyBnb, reason: `dca: dip, ${(((high - row.priceBnb) / high) * 100).toFixed(1)}% below the 24 h high` })) {
            lastDip[k] = now;
            buys.push(now);
          }
        }
      }
      if (p.takeProfitPct !== null) {
        const position = api.read.position(target);
        if (position?.pnlPct !== null && position !== null && position.pnlPct! >= p.takeProfitPct) exit(api, state, position.coin, 1, `dca: take-profit at +${position.pnlPct!.toFixed(1)}%`);
      }
    }
  };
  return {
    meta: { name: "dca", tickSeconds: PRESETS.dca.tickSeconds, events: PRESETS.dca.events, watch: ["FEAST"] },
    onTick: run,
    onEvent(api, event) {
      if (event.type === "price.move") run(api);
    },
  };
}

const FACTORIES: Record<PresetId, () => Strategy> = { sniper, momentum, copy, launch, dca };

export function presetStrategy(id: PresetId): Strategy {
  return FACTORIES[id]();
}
