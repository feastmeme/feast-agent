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

describe("a sent transaction whose receipt is late", () => {
  it("pauses entries, counts the pending buy as spent, survives a restart, and books the late fill when it lands", async () => {
    const { encodeAbiParameters, encodeEventTopics } = await import("viem");
    const { hookAbi } = await import("../sdk/abi.ts");
    const { wrappedNativeAbi } = await import("../sdk/venue-abi.ts");
    const { MAINNET } = await import("../sdk/networks.ts");
    const { readLedger } = await import("./store.ts");
    const { parseBook } = await import("./book.ts");
    const { readFileSync } = await import("node:fs");
    const FEAST = MAINNET.platformCoin!.address;
    const WBNB = MAINNET.contracts.wrappedNative;
    const router = MAINNET.trade.kind === "infinity" ? MAINNET.trade.router : WALLET;
    const HASH = `0x${"cd".repeat(32)}` as const;
    const home = mkdtempSync(join(tmpdir(), "feast-league-test-"));
    homes.push(home);
    const planned = planAgent({ name: "late", preset: "dca", params: { buyBnb: 0.002 } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const calls: string[] = [];
    const clean = { success: true, data: { requestId: "r1", simulationResult: { simulationCode: "000000000", simulationErrorDetail: null }, risks: { riskDetails: [], addresses: {}, riskBehaviors: [] }, requireConfirmation: false, expiresAt: Date.now() + 600_000 } };
    const signer: Signer = {
      status: async () => ({ connected: true, status: "CONNECTED" }),
      address: async () => WALLET,
      settings: async () => ({ devModeEnabled: true, devModeExpiresAt: null, devModeDailyLimitUsd: 1000, devModeQuotaUsedUsd: 0, balanceExceeded: false, sessionExpireTime: null, inactiveSignOutTime: null, abnormalTxnHandling: null }) as WalletSettings,
      txLock: async () => "UNLOCKED",
      preview: async () => (calls.push("preview"), clean),
      execute: async () => (calls.push("execute"), { status: "BROADCASTED", txHash: HASH, orderId: "o", message: null }),
      signMessagePreview: async () => ({}),
    };
    const coins = 10_000n * 10n ** 18n;
    const trade = { address: MAINNET.contracts.hook, topics: encodeEventTopics({ abi: hookAbi, eventName: "Trade", args: { coin: FEAST, quote: WBNB, payer: WALLET } }), data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint160" }, { type: "uint256" }], [true, coins, 2n * 10n ** 15n, 1n, 2n * 10n ** 13n]) };
    const deposit = { address: WBNB, topics: encodeEventTopics({ abi: wrappedNativeAbi, eventName: "Deposit", args: { dst: router } } as never), data: encodeAbiParameters([{ type: "uint256" }], [2n * 10n ** 15n]) };
    let landed = false;
    const key = { currency0: FEAST, currency1: WBNB, hooks: MAINNET.contracts.hook, poolManager: MAINNET.contracts.poolManager, fee: 100, parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1" };
    const chain = {
      client: {
        simulateContract: async () => ({ result: [coins, 0n] }),
        getTransactionReceipt: async () => (landed ? { status: "success", logs: [trade, deposit], gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 2n } : null),
      },
      coinInfo: async () => ({ coin: FEAST, quote: WBNB, creator: WALLET, poolId: MAINNET.platformCoin!.poolId, coinIsCurrency0: true, symbol: "FEAST", name: "Feast" }),
      isFeastCoin: async () => true,
      poolKey: async () => key,
      hops: () => [],
      spotQuotePerCoinE18: async () => 2n * 10n ** 11n,
      chainTime: async () => 1n,
      receipt: async () => {
        throw new Error("timed out");
      },
      balance: async () => 10n ** 18n,
      bnbUsd: async () => 600,
      markWei: async () => 2n * 10n ** 15n,
      quoteBnbE18: async () => 10n ** 18n,
      quoteToBnbWei: async (_q: unknown, amount: bigint) => amount,
      tokenBalance: async () => coins,
      allowance: async () => 2n ** 256n - 1n,
      permit2Allowance: async () => ({ amount: 2n ** 160n - 1n, expiration: 2 ** 47 }),
    } as unknown as LeagueChain;
    const run = () => runAgent({ home, name: "late", signer, chain, fetch: (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch, loopMs: 50, unresolvedCheckMs: 100, pollMs: 10_000_000 });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 50));
    };
    const state = () => (() => { try { return parseBook(readFileSync(agentPaths(home, "late").state, "utf8")); } catch { return null; } })();
    const { bookView } = await import("./book.ts");
    const { rmSync } = await import("node:fs");

    // First run: the buy is sent, its receipt never comes.
    const first = run();
    const { pauseReason } = await import("./book.ts");
    await until(() => (state()?.unresolved.length ?? 0) === 1);
    writeStop(agentPaths(home, "late").stop, "stop requested by the user");
    await first;
    const paused = state()!;
    expect(paused.unresolved).toHaveLength(1);
    // Task 1020: the note line is settled when the buy is sent, so the late fill's note still says who asked.
    expect(paused.unresolved[0]!.why).toBe("the dca preset");
    expect(pauseReason(paused)).toMatch(/not known yet/);
    expect(paused.paused).toBeNull();
    expect(Object.keys(paused.positions)).toHaveLength(0);
    // Meanwhile the pending buy counts against the spend limits.
    expect(bookView(paused, undefined, Date.now()).spent24hWei).toBe(2n * 10n ** 15n);

    // Second run, after a restart: the runtime remembers the transaction, and books it when it lands.
    rmSync(agentPaths(home, "late").stop, { force: true });
    landed = true;
    const second = run();
    await until(() => Object.keys(state()?.positions ?? {}).length === 1 && state()?.positions[FEAST.toLowerCase()]?.armed === true);
    writeStop(agentPaths(home, "late").stop, "stop requested by the user");
    await second;
    const book = state()!;
    expect(book.positions[FEAST.toLowerCase()]).toMatchObject({ coins, costWei: 2n * 10n ** 15n, armed: true });
    expect(book.paused).toBeNull();
    expect(book.unresolved).toEqual([]);
    expect(readLedger(home).spentWei).toBe(2n * 10n ** 15n);
    expect(calls.filter((c) => c === "execute")).toHaveLength(1);
    const { readNotes } = await import("./notes/queue.ts");
    expect(readNotes(home, "late").map((n) => n.text)).toEqual(["bought FEAST for 0.002 BNB: the dca preset"]);
  });
});

describe("outcomes that are not known, and the user's resume", () => {
  async function harness(over: { execute?: () => Promise<never | { status: string; txHash: null; orderId: null; message: null }>; balances?: bigint[] } = {}) {
    const { MAINNET } = await import("../sdk/networks.ts");
    const FEAST = MAINNET.platformCoin!.address;
    const WBNB = MAINNET.contracts.wrappedNative;
    const home = mkdtempSync(join(tmpdir(), "feast-league-test-"));
    homes.push(home);
    const planned = planAgent({ name: "u", preset: "dca", params: { buyBnb: 0.002 } });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const clean = { success: true, data: { requestId: "r1", simulationResult: { simulationCode: "000000000", simulationErrorDetail: null }, risks: { riskDetails: [], addresses: {}, riskBehaviors: [] }, requireConfirmation: false, expiresAt: Date.now() + 600_000 } };
    const calls: string[] = [];
    const signer: Signer = {
      status: async () => ({ connected: true, status: "CONNECTED" }),
      address: async () => WALLET,
      settings: async () => ({ devModeEnabled: true, devModeExpiresAt: null, devModeDailyLimitUsd: 1000, devModeQuotaUsedUsd: 0, balanceExceeded: false, sessionExpireTime: null, inactiveSignOutTime: null, abnormalTxnHandling: null }) as WalletSettings,
      txLock: async () => "UNLOCKED",
      preview: async () => (calls.push("preview"), clean),
      execute: over.execute ?? (async () => { calls.push("execute"); throw new Error("baw timed out"); }),
      signMessagePreview: async () => ({}),
    };
    const balances = [...(over.balances ?? [0n])];
    const key = { currency0: FEAST, currency1: WBNB, hooks: MAINNET.contracts.hook, poolManager: MAINNET.contracts.poolManager, fee: 100, parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1" };
    const chain = {
      client: { simulateContract: async () => ({ result: [10n ** 21n, 0n] }), getTransactionReceipt: async () => null, getTransaction: async () => null },
      coinInfo: async () => ({ coin: FEAST, quote: WBNB, creator: WALLET, poolId: MAINNET.platformCoin!.poolId, coinIsCurrency0: true, symbol: "FEAST", name: "Feast" }),
      isFeastCoin: async () => true,
      poolKey: async () => key,
      hops: () => [],
      spotQuotePerCoinE18: async () => 2n * 10n ** 12n,
      chainTime: async () => 1n,
      receipt: async () => ({ status: "success", logs: [], gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n }),
      balance: async () => 10n ** 18n,
      bnbUsd: async () => 600,
      markWei: async () => 2n * 10n ** 15n,
      quoteBnbE18: async () => 10n ** 18n,
      quoteToBnbWei: async (_q: unknown, amount: bigint) => amount,
      tokenBalance: async () => (balances.length > 1 ? balances.shift()! : balances[0]!),
      allowance: async () => 2n ** 256n - 1n,
      permit2Allowance: async () => ({ amount: 2n ** 160n - 1n, expiration: 2 ** 47 }),
    } as unknown as LeagueChain;
    return { home, signer, chain, calls, FEAST };
  }

  it("an execute that fails may still have sent: the buy is read from the coin's balance, and booked", async () => {
    const { parseBook, pauseReason } = await import("./book.ts");
    const { readFileSync } = await import("node:fs");
    // The balance before the send, then the balance after: 1,000 coins arrived.
    const { home, signer, chain, FEAST } = await harness({ balances: [0n, 0n, 1_000n * 10n ** 18n] });
    const running = runAgent({ home, name: "u", signer, chain, fetch: (async () => new Response("{}")) as unknown as typeof fetch, loopMs: 50, unresolvedCheckMs: 100, pollMs: 10_000_000 });
    const state = () => (() => { try { return parseBook(readFileSync(agentPaths(home, "u").state, "utf8")); } catch { return null; } })();
    for (let i = 0; i < 100 && Object.keys(state()?.positions ?? {}).length === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    writeStop(agentPaths(home, "u").stop, "stop requested by the user");
    await running;
    const book = state()!;
    expect(book.positions[FEAST.toLowerCase()]?.coins).toBe(1_000n * 10n ** 18n);
    expect(book.unresolved).toEqual([]);
    expect(pauseReason(book)).toBeNull();
    expect(book.counters.failures).toBe(0);
  });

  it("the user's resume clears an L14 pause; nothing else does", async () => {
    const { parseBook, recordFailure, serializeBook, emptyBook } = await import("./book.ts");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { home, signer, chain } = await harness({ execute: async () => ({ status: "FAILED", txHash: null, orderId: null, message: null }) });
    let paused = emptyBook();
    for (let i = 0; i < 3; i += 1) paused = recordFailure(paused, "x", 3);
    writeFileSync(agentPaths(home, "u").state, serializeBook(paused));
    writeStop(agentPaths(home, "u").stop, "stop requested by the user");
    // A plain start (with the stop removed) keeps the pause; a resume clears it.
    const { rmSync } = await import("node:fs");
    rmSync(agentPaths(home, "u").stop);
    const kept = runAgent({ home, name: "u", signer, chain, fetch: (async () => new Response("{}")) as unknown as typeof fetch, loopMs: 50, maxRuntimeMs: 300, pollMs: 10_000_000 });
    await kept;
    expect(parseBook(readFileSync(agentPaths(home, "u").state, "utf8")).paused).toMatch(/consecutive failures/);
    const resumed = runAgent({ home, name: "u", signer, chain, fetch: (async () => new Response("{}")) as unknown as typeof fetch, loopMs: 50, maxRuntimeMs: 300, pollMs: 10_000_000, clearPause: true });
    await resumed;
    expect(parseBook(readFileSync(agentPaths(home, "u").state, "utf8")).paused === null || /unresolved|not known/.test(String(parseBook(readFileSync(agentPaths(home, "u").state, "utf8")).paused))).toBe(true);
  });
});

describe("the one-shot and the entry track (task 961)", () => {
  it("the loop refuses the entry track, before touching the wallet", async () => {
    const { entryAgent } = await import("./enter/flow.ts");
    const { home, signer, calls, chain } = setup();
    saveAgent(home, confirmAgent(entryAgent()));
    const outcome = await runAgent({ home, name: "league-entry", signer, chain, maxRuntimeMs: 200 });
    expect(outcome.exit).toBe("refused");
    expect(outcome.reason).toMatch(/FL enter/);
    expect(calls).toEqual([]);
  });

  it("an entry agent's one-shot runs: there is no strategy to load", async () => {
    const { entryAgent } = await import("./enter/flow.ts");
    const { home, signer, chain, board } = setup();
    saveAgent(home, confirmAgent(entryAgent()));
    const outcome = await runAgent({ home, name: "league-entry", signer, chain, fetch: board, only: [] });
    expect(outcome).toEqual({ exit: "finished", reason: "the manual request ran" });
  });

  it("a one-shot never starts a listening strategy's event poller", async () => {
    const { home, signer, chain } = setup();
    const planned = planAgent({ name: "snipe", preset: "sniper" });
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    saveAgent(home, confirmAgent(planned.agent));
    const asked: string[] = [];
    const indexer = (async (url: string) => (asked.push(String(url)), new Response(JSON.stringify({ data: [], cursor: null })))) as unknown as typeof fetch;
    const outcome = await runAgent({ home, name: "snipe", signer, chain, fetch: indexer, only: [] });
    expect(outcome.exit).toBe("finished");
    expect(asked).toEqual([]);
  });

  it("a one-shot first asks about a transaction whose outcome was not known", async () => {
    const { parseBook, serializeBook, emptyBook } = await import("./book.ts");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { home, signer, chain } = setup();
    const HASH = `0x${"ee".repeat(32)}` as const;
    const unresolved = { txHash: HASH, kind: "buy" as const, at: Date.now(), intentId: "b", source: "manual", fundedBy: "wallet" as const, coin: WALLET, symbol: "X", quote: WALLET, payIn: "native" as const, sizeWei: 1n, balanceBefore: 0n, minCoins: 1n };
    writeFileSync(agentPaths(home, "idle").state, serializeBook({ ...emptyBook(), unresolved: [unresolved] }));
    (chain as unknown as { client: unknown }).client = { getTransactionReceipt: async () => ({ status: "reverted", logs: [], gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 3n }) };
    const outcome = await runAgent({ home, name: "idle", signer, chain, only: [] });
    expect(outcome.exit).toBe("finished");
    expect(parseBook(readFileSync(agentPaths(home, "idle").state, "utf8")).unresolved).toEqual([]);
  });
});
