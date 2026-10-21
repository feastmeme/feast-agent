import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAgent, planAgent, saveAgent } from "./agent.ts";
import type { Signer, WalletSettings } from "./baw.ts";
import type { LeagueChain } from "./chain.ts";
import { runAgent } from "./runtime.ts";
import { agentPaths, walletLockHolder, writeStop } from "./store.ts";

// Synthetic: never a real wallet.
const WALLET: Address = "0x000000000000000000000000000000000000a11c";
let homes: string[] = [];
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

function setup(confirm = true) {
  const home = mkdtempSync(join(tmpdir(), "feast-league-test-"));
  homes.push(home);
  // A DCA agent that has nothing to do for a day: the loop idles.
  const planned = planAgent({ name: "idle", preset: "dca", params: { buyOnStart: false, everyMinutes: 10080 } });
  if (!planned.ok) throw new Error(planned.errors.join("; "));
  saveAgent(home, confirm ? confirmAgent(planned.agent) : planned.agent);
  const calls: string[] = [];
  const signer: Signer = {
    status: async () => (calls.push("status"), { connected: true, status: "CONNECTED" }),
    address: async () => (calls.push("address"), WALLET),
    settings: async () => (calls.push("settings"), { devModeEnabled: true, devModeExpiresAt: null, devModeDailyLimitUsd: 1000, devModeQuotaUsedUsd: 0, balanceExceeded: false, sessionExpireTime: null, inactiveSignOutTime: null, abnormalTxnHandling: null } as WalletSettings),
    txLock: async () => (calls.push("tx-lock"), "UNLOCKED"),
    preview: async () => (calls.push("preview"), {}),
    execute: async () => (calls.push("execute"), { status: "BROADCASTED", txHash: null, orderId: null, message: null }),
    signMessagePreview: async () => ({}),
  };
  const chain = {
    balance: async () => 10n ** 18n,
    bnbUsd: async () => 600,
    markWei: async () => 0n,
    coinInfo: async () => ({ coin: WALLET, quote: WALLET, creator: WALLET, poolId: "0x01", coinIsCurrency0: true, symbol: "FEAST", name: "Feast" }),
    quoteBnbE18: async () => 10n ** 18n,
    isFeastCoin: async () => true,
  } as unknown as LeagueChain;
  const board = (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;
  return { home, signer, calls, chain, board };
}

describe("the runtime loop", () => {
  it("refuses to start an agent the user never confirmed, before touching the wallet", async () => {
    const { home, signer, calls, chain } = setup(false);
    const outcome = await runAgent({ home, name: "idle", signer, chain });
    expect(outcome.exit).toBe("refused");
    expect(outcome.reason).toMatch(/never confirmed/);
    expect(calls).toEqual([]);
  });

  it("refuses to start while a stop file is present", async () => {
    const { home, signer, calls, chain } = setup();
    writeStop(agentPaths(home, "idle").stop, "a test stop");
    const outcome = await runAgent({ home, name: "idle", signer, chain });
    expect(outcome.exit).toBe("refused");
    expect(calls).toEqual([]);
  });

  it("halts within a second of a stop file, previews nothing after it, and releases the wallet", async () => {
    const { home, signer, calls, chain, board } = setup();
    const running = runAgent({ home, name: "idle", signer, chain, fetch: board, loopMs: 100 });
    await new Promise((r) => setTimeout(r, 600));
    expect(walletLockHolder(home)?.agent).toBe("idle");
    const stoppedAt = Date.now();
    writeStop(agentPaths(home, "idle").stop, "stop requested by the user");
    const outcome = await running;
    expect(outcome.exit).toBe("stopped");
    expect(Date.now() - stoppedAt).toBeLessThan(1_500);
    expect(calls).not.toContain("preview");
    expect(calls).not.toContain("execute");
    expect(walletLockHolder(home)).toBeNull();
  });
});
