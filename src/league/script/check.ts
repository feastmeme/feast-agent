import { join } from "node:path";
import type { Address } from "viem";

import { sha256Of } from "../audit/static.ts";
import { clean } from "../enter/copy.ts";
import { bookView, emptyBook, positionOf, recordBuy, recordSell, type Book } from "../book.ts";
import { guard, type Intent } from "../guard.ts";
import { MIN_TRADE_BNB, bnbToWei, resolveLimits, weiToBnb, type Limits } from "../limits.ts";
import { LEAGUE_CAP_BNB } from "../prompt/constants.ts";
import { readJson, writeJsonAtomic } from "../store.ts";
import { normalizeIntent, type IntentRequest, type PositionRow, type Snapshot } from "../strategy.ts";
import { ScriptSandbox } from "./sandbox.ts";
import { stubWorld, type StubWorld } from "./world.ts";

/**
 * `FL script check <file>` (task 963): the script, in the real sandbox, against
 * the stub world (`world.ts`) and never the network, the wallet or the home's
 * books. Every tick runs with the real time bound (1 s), every event it listens
 * for with its own (250 ms); every request is normalized as the runtime would,
 * then run through the real `guard()` with a stub book that fills it at the stub
 * price. The report lists each check, and on a failure the snapshot and the
 * request. It is written beside the script's audit, keyed the same way:
 *
 *   $FEAST_LEAGUE_HOME/audits/<sha256>.check.json
 *
 * A pass on record, with a passed audit, counts as the warm-up done for that
 * exact file (the runtime reads it when it starts the script). Any edit is a new
 * sha256: a new audit, a new check, a new warm-up.
 */

export type CheckId = "load" | "meta" | "calls" | "normalize" | "size" | "feast" | "held" | "launch" | "guard";
export type CheckLine = { id: CheckId; label: string; pass: boolean; detail?: string; snapshot?: number; request?: string };
export type CheckReport = {
  version: 1;
  sha256: string;
  file: string | null;
  at: string;
  verdict: "pass" | "fail";
  world: { seed: number; snapshots: number; coins: number; balanceBnb: number; limits: Limits };
  checks: CheckLine[];
  stats: { ticks: number; events: number; requests: number; buys: number; sells: number; launches: number; refusals: number };
};

const EVENTS = new Set(["coin.created", "trade", "price.move"]);

export const checkPath = (home: string, sha256: string) => join(home, "audits", `${sha256}.check.json`);

export function writeCheckReport(home: string, report: CheckReport): string {
  const path = checkPath(home, report.sha256);
  writeJsonAtomic(path, report);
  return path;
}

/** A passing check is on record for these exact bytes. */
export function scriptCheckPassed(home: string, sha256: string): boolean {
  try {
    const report = readJson<CheckReport>(checkPath(home, sha256));
    return report !== null && report.sha256 === sha256 && report.verdict === "pass" && report.checks.every((c) => c.pass);
  } catch {
    return false;
  }
}

/** The limits a planned agent gets by default: the defaults, with the league's capital cap. */
function checkLimits(): Limits {
  const limits = resolveLimits({ budgetBnb: LEAGUE_CAP_BNB });
  if (!limits.ok) throw new Error(limits.errors.join("; "));
  return limits.limits;
}

const shown = (request: unknown) => {
  const text = JSON.stringify(request) ?? String(request);
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
};

export async function checkScript(source: string, options: { file?: string; seed?: number; now?: () => number } = {}): Promise<CheckReport> {
  const limits = checkLimits();
  const world: StubWorld = stubWorld(options.seed);
  const checks: CheckLine[] = [
    { id: "load", label: "the module loads", pass: true },
    { id: "meta", label: "meta validates: a tick of 15–3600 s, known events", pass: true },
    { id: "calls", label: "no call throws or overruns (onTick 1 s, onEvent 250 ms)", pass: true },
    { id: "normalize", label: "every request normalizes as the runtime's would", pass: true },
    { id: "size", label: `every buy is at least ${MIN_TRADE_BNB} BNB and at most L1 (${limits.maxTradeBnb} BNB)`, pass: true },
    { id: "feast", label: "every buy names a Feast coin of the stub world (L15)", pass: true },
    { id: "held", label: "every sale names a coin the stub book holds", pass: true },
    { id: "launch", label: "at most one launch", pass: true },
    { id: "guard", label: "the real guard, with the stub book, refuses nothing (L2, L4, L5 and the rest)", pass: true },
  ];
  const stats = { ticks: 0, events: 0, requests: 0, buys: 0, sells: 0, launches: 0, refusals: 0 };
  const fail = (id: CheckId, detail: string, at: { snapshot?: number; request?: unknown } = {}) => {
    const line = checks.find((c) => c.id === id)!;
    if (!line.pass) return;
    line.pass = false;
    line.detail = detail;
    if (at.snapshot !== undefined) line.snapshot = at.snapshot;
    if (at.request !== undefined) line.request = shown(at.request);
  };
  const notRun = (from: CheckId) => {
    for (const line of checks.slice(checks.findIndex((c) => c.id === from))) if (line.pass) Object.assign(line, { pass: false, detail: "not run" });
  };
  const report = (): CheckReport => ({
    version: 1,
    sha256: sha256Of(source),
    file: options.file ?? null,
    at: new Date((options.now ?? Date.now)()).toISOString(),
    verdict: checks.every((c) => c.pass) ? "pass" : "fail",
    world: { seed: world.seed, snapshots: world.frames.length, coins: world.coins.length, balanceBnb: world.balanceBnb, limits },
    checks,
    stats,
  });

  let sandbox: ScriptSandbox;
  try {
    sandbox = await ScriptSandbox.start(source);
  } catch (error) {
    fail("load", (error as Error).message.slice(0, 300));
    notRun("meta");
    return report();
  }
  try {
    const meta = sandbox.meta;
    const unknown = (meta.events ?? []).filter((e) => !EVENTS.has(e));
    if (!Number.isInteger(meta.tickSeconds) || meta.tickSeconds < 15 || meta.tickSeconds > 3_600) fail("meta", `meta.tickSeconds ${meta.tickSeconds} is outside 15–3600`);
    else if (unknown.length > 0) fail("meta", `unknown events: ${unknown.join(", ")}; the events are coin.created, trade, price.move`);
    if (!checks[1]!.pass) {
      notRun("calls");
      return report();
    }

    const params = { ...sandbox.params };
    const slippagePct = typeof params.slippagePct === "number" ? params.slippagePct : Math.min(3, limits.maxSlippagePct);
    const feastSet = new Set(world.coins.map((c) => c.toLowerCase()));
    let book: Book = emptyBook();
    let balanceWei = bnbToWei(world.balanceBnb);
    let spentWei = 0n;
    let state: Record<string, unknown> = {};

    run: for (const [index, frame] of world.frames.entries()) {
      const priceOf = (coin: Address) => frame.coins.find((c) => c.coin.toLowerCase() === coin.toLowerCase())?.priceBnb ?? null;
      const snapshot = (): Snapshot => ({
        now: frame.now,
        balanceBnb: Math.max(0, weiToBnb(balanceWei) - limits.gasReserveBnb),
        limits,
        warmup: null,
        coins: frame.coins,
        positions: Object.values(book.positions).map((p): PositionRow => {
          const price = priceOf(p.coin);
          const coins = weiToBnb(p.coins);
          const costBnb = weiToBnb(p.costWei);
          const markBnb = price === null ? null : coins * price;
          return { coin: p.coin, symbol: p.symbol, coins, costBnb, markBnb, pnlPct: markBnb === null || costBnb === 0 ? null : ((markBnb - costBnb) / costBnb) * 100, peakBnb: weiToBnb(p.peakMarkWei), openedAt: p.openedAt, ageSeconds: Math.floor((frame.now - p.openedAt) / 1_000), ownLaunch: p.ownLaunch, armed: true };
        }),
        trades: frame.trades,
        holders: frame.holders,
        launchesByCreator: frame.launchesByCreator,
        feast: world.feast,
        launched: book.launched ? { coin: book.launched.coin, at: book.launched.at } : null,
      });
      const calls: { fn: "onTick" | "onEvent"; event?: unknown; ms: number }[] = [{ fn: "onTick", ms: 1_000 }, ...frame.events.filter((e) => meta.events.includes(e.type)).map((event) => ({ fn: "onEvent" as const, event, ms: 250 }))];
      for (const call of calls) {
        const now = snapshot();
        const result = await sandbox.call(call.fn, { snapshot: now, state, params, event: call.event }, call.ms);
        if (call.fn === "onTick") stats.ticks += 1;
        else stats.events += 1;
        if (!result.ok) {
          fail("calls", `${call.fn}: ${result.error}`.slice(0, 300), { snapshot: index });
          break run;
        }
        state = result.state;
        for (const request of result.requests) {
          stats.requests += 1;
          const at = { snapshot: index, request };
          const normal = normalizeIntent(request as IntentRequest, { snapshot: now, source: "script", slippagePct, ttlMs: call.fn === "onEvent" ? 30_000 : meta.tickSeconds * 1_000 });
          if ("error" in normal) {
            fail("normalize", normal.error, at);
            continue;
          }
          const intent: Intent = normal.intent;
          const coin = intent.coin?.toLowerCase();
          if (intent.kind === "buy") {
            if (!(intent.bnb! >= MIN_TRADE_BNB)) {
              fail("size", `a buy of ${intent.bnb} BNB is under the smallest trade, ${MIN_TRADE_BNB} BNB`, at);
              continue;
            }
            if (bnbToWei(intent.bnb!) > bnbToWei(limits.maxTradeBnb)) {
              fail("size", `a buy of ${intent.bnb} BNB is over L1 (${limits.maxTradeBnb} BNB)`, at);
              continue;
            }
            if (!coin || !feastSet.has(coin)) {
              fail("feast", `${intent.coin} is not a Feast coin of the stub world`, at);
              continue;
            }
          }
          if (intent.kind === "sell" && !positionOf(book, intent.coin!)) {
            fail("held", `a sale of ${intent.coin}, which the stub book does not hold`, at);
            continue;
          }
          if (intent.kind === "launch") {
            stats.launches += 1;
            if (stats.launches > 1) {
              fail("launch", "a second launch", at);
              continue;
            }
          }
          const verdict = guard({
            intent,
            limits,
            now: frame.now,
            wallet: { connected: true, devMode: true, quotaLeftUsd: Number.POSITIVE_INFINITY, balanceWei },
            bnbUsd: 600,
            stopped: false,
            coinIsFeast: intent.kind === "launch" || (coin !== undefined && feastSet.has(coin)),
            book: bookView(book, intent.coin, frame.now),
            walletSpentWei: spentWei,
            claimFundsWei: 0n,
            warmup: null,
          });
          if (!verdict.ok) {
            stats.refusals += 1;
            fail("guard", `${verdict.limit}: ${verdict.message}`, at);
            continue;
          }
          // The stub fills at its own price: enough for the next snapshot's book, and nothing more.
          if (intent.kind === "buy") {
            const price = priceOf(intent.coin!) ?? 1e-6;
            const sizeWei = verdict.sizeWei!;
            book = recordBuy(book, { coin: intent.coin!, symbol: frame.coins.find((c) => c.coin.toLowerCase() === coin)?.symbol ?? "?", quote: world.feast, coinsOut: bnbToWei(weiToBnb(sizeWei) / price), bnbInWei: sizeWei, gasWei: 0n, at: frame.now, fundedBy: "wallet", ownLaunch: false, source: "script" });
            balanceWei -= sizeWei;
            spentWei += sizeWei;
            stats.buys += 1;
          } else if (intent.kind === "sell") {
            const held = positionOf(book, intent.coin!)!;
            const coins = (held.coins * BigInt(Math.round((intent.fraction ?? 1) * 1_000_000))) / 1_000_000n;
            const out = bnbToWei(Math.max(0, weiToBnb(coins) * (priceOf(intent.coin!) ?? 0)));
            book = recordSell(book, { coin: intent.coin!, coinsIn: coins, bnbOutWei: out, gasWei: 0n, at: frame.now });
            balanceWei += out;
            stats.sells += 1;
          } else if (intent.kind === "launch") {
            book = { ...book, launched: { coin: world.feast, poolId: "0x00", at: frame.now, txHash: `0x${"0".repeat(64)}` } };
          }
        }
      }
    }
    if (!checks[2]!.pass) for (const line of checks.slice(3)) if (line.pass && stats.requests === 0) Object.assign(line, { pass: false, detail: "not run" });
    return report();
  } finally {
    sandbox.stop();
  }
}

/** `feast-league script check`, as a person reads it: each check, the failure's snapshot and request, and what a pass means. */
export function checkLines(report: CheckReport, path: string, audit: string | null): string {
  const sha = `${report.sha256.slice(0, 6)}…${report.sha256.slice(-4)}`;
  const s = report.stats;
  return [
    `FL script check: ${report.file ?? "the script"} (sha256 ${sha})`,
    `The stub world: ${report.world.snapshots} snapshots, ${report.world.coins} coins, ${report.world.balanceBnb} BNB, the default limits with the 0.15 BNB cap.`,
    ...report.checks.map((c) => `  ${c.pass ? "ok" : "NO"} ${c.id}: ${c.label}${c.pass ? "" : ` — ${c.detail ?? ""}${c.snapshot !== undefined ? ` (snapshot ${c.snapshot})` : ""}${c.request ? `: ${clean(c.request, 200)}` : ""}`}`),
    `${report.verdict.toUpperCase()}: ${s.ticks} ticks, ${s.events} events, ${s.requests} requests (${s.buys} buys, ${s.sells} sales, ${s.launches} launches), ${s.refusals} refused by the guard`,
    `Report: ${path}`,
    report.verdict === "pass"
      ? audit === null
        ? "With its audit passed, this counts as the warm-up done for this exact file: it starts at its own sizes, within the hard limits. Any edit is a new file."
        : `The audit has not passed yet (${audit}): once it does, this check counts as the warm-up done for this exact file.`
      : "Fix the script and run the check again; until a check passes, its first 5 trades run at 0.001 BNB.",
  ].join("\n");
}
