import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";

import { hookAbi } from "../sdk/abi.ts";
import { approveCall, buyCall, type PoolKey } from "../sdk/infinity.ts";
import { MAINNET } from "../sdk/networks.ts";
import { wrappedNativeAbi } from "../sdk/venue-abi.ts";
import type { ExecuteResult, Signer, WalletSettings } from "./baw.ts";
import type { CoinInfo, LeagueChain } from "./chain.ts";
import { Executor, type PreparedBuy } from "./executor.ts";

// Synthetic: never a real wallet.
const WALLET: Address = "0x000000000000000000000000000000000000a11c";
const STRANGER: Address = "0x000000000000000000000000000000000000b0b0";
const COIN: Address = "0x00000000000000000000000000000000c0ffee01";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const trade = MAINNET.trade.kind === "infinity" ? MAINNET.trade : null!;
const KEY: PoolKey = {
  currency0: COIN,
  currency1: MAINNET.contracts.wrappedNative,
  hooks: MAINNET.contracts.hook,
  poolManager: MAINNET.contracts.poolManager,
  fee: 100,
  parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1",
};
const INFO: CoinInfo = { coin: COIN, quote: MAINNET.contracts.wrappedNative, creator: STRANGER, poolId: "0x01", coinIsCurrency0: true, symbol: "TEST", name: "Test" };
const SIZE = 1_000_000_000_000_000n;
const BUY = buyCall(trade.router, { wrappedNative: MAINNET.contracts.wrappedNative, quote: MAINNET.contracts.wrappedNative, coin: COIN, hops: [], poolKey: KEY, amountIn: SIZE, minOut: 1n, hookData: "0x" }, 1n);

const cleanPreview = { success: true, data: { requestId: "req-1", simulationResult: { simulationCode: "000000000", simulationErrorDetail: null }, risks: { riskDetails: [], addresses: {}, riskBehaviors: [] }, requireConfirmation: false, expiresAt: Date.now() + 60_000 } };

type Script = { locks?: ("UNLOCKED" | "LOCKED")[]; preview?: unknown; execute?: ExecuteResult; onPreview?: () => void };

function fakeSigner(script: Script) {
  const calls: string[] = [];
  const locks = [...(script.locks ?? ["UNLOCKED"])];
  const signer: Signer = {
    status: async () => ({ connected: true, status: "CONNECTED" }),
    address: async () => WALLET,
    settings: async () => ({}) as WalletSettings,
    txLock: async () => {
      calls.push("tx-lock");
      return locks.length > 1 ? locks.shift()! : locks[0]!;
    },
    preview: async () => {
      calls.push("preview");
      script.onPreview?.();
      return script.preview ?? cleanPreview;
    },
    execute: async () => {
      calls.push("execute");
      return script.execute ?? { status: "BROADCASTED", txHash: HASH, orderId: "o1", message: null };
    },
    signMessagePreview: async () => ({}),
  };
  return { signer, calls };
}

function tradeLog(payer: Address, coinAmount: bigint): Log {
  const topics = encodeEventTopics({ abi: hookAbi, eventName: "Trade", args: { coin: COIN, quote: MAINNET.contracts.wrappedNative, payer } });
  const data = encodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint160" }, { type: "uint256" }], [true, coinAmount, SIZE, 1n, SIZE / 100n]);
  return { address: MAINNET.contracts.hook, topics, data } as unknown as Log;
}
function depositLog(wad: bigint): Log {
  const topics = encodeEventTopics({ abi: wrappedNativeAbi, eventName: "Deposit", args: { dst: trade.router } } as never);
  return { address: MAINNET.contracts.wrappedNative, topics, data: encodeAbiParameters([{ type: "uint256" }], [wad]) } as unknown as Log;
}
function receiptOf(logs: Log[], status: "success" | "reverted" = "success"): TransactionReceipt {
  return { status, logs, gasUsed: 200_000n, effectiveGasPrice: 50_000_000n, blockNumber: 1n } as unknown as TransactionReceipt;
}

function executor(signer: Signer, opts: { stop?: () => string | null; receipt?: TransactionReceipt; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: Date.now() };
  const log: { event: string; fields: Record<string, unknown> }[] = [];
  const chain = { receipt: async () => opts.receipt ?? receiptOf([tradeLog(WALLET, 5n), depositLog(SIZE)]) } as unknown as LeagueChain;
  const ex = new Executor({
    signer,
    chain,
    wallet: WALLET,
    network: MAINNET,
    rpcUrl: "http://127.0.0.1:1",
    stopReason: opts.stop ?? (() => null),
    log: (event, fields) => log.push({ event, fields }),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  // The coin is one the factory made, as `known()` would have found it.
  (ex as unknown as { approvable: Set<string> }).approvable.add(COIN.toLowerCase());
  return { ex, log };
}

describe("send: the one path every transaction takes", () => {
  it("allowlist → lock → preview → gate → execute → receipt", async () => {
    const { signer, calls } = fakeSigner({});
    const { ex } = executor(signer);
    const out = await ex.send("buy", BUY);
    expect(out).toMatchObject({ ok: true, txHash: HASH, gasWei: 200_000n * 50_000_000n });
    expect(calls).toEqual(["tx-lock", "preview", "execute"]);
  });

  it("a stop file present before anything: nothing is asked of the wallet", async () => {
    const { signer, calls } = fakeSigner({});
    const { ex } = executor(signer, { stop: () => "STOP" });
    expect(await ex.send("buy", BUY)).toMatchObject({ ok: false, stage: "stopped", sent: false });
    expect(calls).toEqual([]);
  });

  it("a stop file written between preview and execute wins: no execute", async () => {
    let stopped: string | null = null;
    const { signer, calls } = fakeSigner({ onPreview: () => (stopped = "STOP written during the preview") });
    const { ex } = executor(signer, { stop: () => stopped });
    const out = await ex.send("buy", BUY);
    expect(out).toMatchObject({ ok: false, stage: "stopped" });
    expect(calls).toEqual(["tx-lock", "preview"]);
  });

  it("waits while the wallet is locked, then goes on", async () => {
    const { signer, calls } = fakeSigner({ locks: ["LOCKED", "LOCKED", "UNLOCKED"] });
    const { ex } = executor(signer);
    expect((await ex.send("buy", BUY)).ok).toBe(true);
    expect(calls.filter((c) => c === "tx-lock")).toHaveLength(3);
  });

  it("gives up on a wallet that stays locked: no preview", async () => {
    const { signer, calls } = fakeSigner({ locks: ["LOCKED"] });
    const { ex } = executor(signer);
    expect(await ex.send("buy", BUY)).toMatchObject({ ok: false, stage: "busy" });
    expect(calls).not.toContain("preview");
  });

  it("a gate refusal sends nothing", async () => {
    const risky = { ...cleanPreview, data: { ...cleanPreview.data, risks: { riskDetails: [{ title: "High Risk Address" }], addresses: {}, riskBehaviors: [] } } };
    const { signer, calls } = fakeSigner({ preview: risky });
    const { ex } = executor(signer);
    expect(await ex.send("buy", BUY)).toMatchObject({ ok: false, stage: "gate" });
    expect(calls).not.toContain("execute");
  });

  it("an App confirmation is a failure, not a wait", async () => {
    const { signer } = fakeSigner({ execute: { status: "PENDING_CONFIRMATION", txHash: null, orderId: "o2", message: "Please confirm in the Binance App" } });
    const { ex } = executor(signer);
    expect(await ex.send("buy", BUY)).toMatchObject({ ok: false, stage: "confirmation" });
  });

  it("a reverted receipt is a failure of a sent transaction", async () => {
    const { signer } = fakeSigner({});
    const { ex } = executor(signer, { receipt: receiptOf([], "reverted") });
    expect(await ex.send("buy", BUY)).toMatchObject({ ok: false, stage: "reverted", sent: true, txHash: HASH });
  });

  it("refuses a call outside the allowlist before touching the wallet", async () => {
    const { signer, calls } = fakeSigner({});
    const { ex } = executor(signer);
    expect(await ex.send("approve", approveCall(COIN, STRANGER))).toMatchObject({ ok: false, stage: "allowlist" });
    expect(await ex.send("odd", { to: STRANGER, data: "0x", value: 1n })).toMatchObject({ ok: false, stage: "allowlist" });
    expect(calls).toEqual([]);
  });
});

describe("what a receipt says happened, for this wallet", () => {
  const prepared: PreparedBuy = { call: BUY, info: INFO, quotedOut: 5n, minOut: 4n, impactPct: 0, sizeWei: SIZE, payIn: "native" };
  const { signer } = fakeSigner({});
  const { ex } = executor(signer);

  it("reads the coins from the hook's Trade paid by this wallet, and holds the wrap to the size asked", () => {
    expect(ex.verifyBuy(receiptOf([tradeLog(WALLET, 5n), depositLog(SIZE)]), prepared)).toEqual({ ok: true, coinsOut: 5n, quoteIn: SIZE, fee: SIZE / 100n });
  });

  it("refuses a receipt whose Trade was paid by another wallet", () => {
    expect(ex.verifyBuy(receiptOf([tradeLog(STRANGER, 5n), depositLog(SIZE)]), prepared).ok).toBe(false);
  });

  it("refuses a receipt that wrapped another amount", () => {
    expect(ex.verifyBuy(receiptOf([tradeLog(WALLET, 5n), depositLog(SIZE + 1n)]), prepared).ok).toBe(false);
  });
});
