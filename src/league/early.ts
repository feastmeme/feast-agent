import { MAINNET } from "../sdk/networks.ts";
import type { AgentConfig } from "./agent.ts";
import { bookView } from "./book.ts";
import { guard } from "./guard.ts";
import type { LimitId } from "./limits.ts";
import { statusOf } from "./runtime.ts";
import { readLedger, stopReason } from "./store.ts";
import { normalizeIntent, type IntentRequest } from "./strategy.ts";

/**
 * A guard pass with an optimistic wallet: what it refuses, it refuses without
 * asking the wallet anything. `FL buy`, `FL launch` and `FL enter` run it before
 * any wallet call; the runtime's one-shot then runs the whole guard again, with
 * the wallet's real state.
 */
export function refuseEarly(home: string, agent: AgentConfig, request: IntentRequest, now = Date.now()): { limit: LimitId | "W"; message: string } | null {
  const feast = MAINNET.platformCoin!.address;
  const normal = normalizeIntent(request, { snapshot: { feast, now, limits: agent.limits }, source: "manual", slippagePct: Math.min(3, agent.limits.maxSlippagePct), ttlMs: 120_000 });
  if ("error" in normal) return { limit: "L15", message: normal.error };
  const book = statusOf(home, agent.name).book;
  const view = book ? bookView(book, normal.intent.coin, now) : { openPositions: 0, hasPosition: false, exposureWei: 0n, spent24hWei: 0n, realizedLoss24hWei: 0n, trades1h: 0, lastEntryAt: null, paused: null, drawdownWei: 0n };
  const verdict = guard({
    intent: normal.intent,
    limits: agent.limits,
    now,
    wallet: { connected: true, devMode: true, quotaLeftUsd: Number.POSITIVE_INFINITY, balanceWei: 10n ** 30n },
    bnbUsd: 0,
    stopped: stopReason(home, agent.name) !== null,
    coinIsFeast: true,
    book: view,
    walletSpentWei: readLedger(home).spentWei,
    claimFundsWei: book?.claimFundsWei ?? 0n,
    warmup: agent.track === "script" ? book?.warmup ?? null : null,
  });
  return verdict.ok ? null : { limit: verdict.limit, message: verdict.message };
}
