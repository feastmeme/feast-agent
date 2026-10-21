import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import { approveCall, buyCall, claimCreatorCall, permit2ApproveCall, type PoolKey } from "../sdk/infinity.ts";
import { MAINNET } from "../sdk/networks.ts";
import { BAW_ALLOWLIST, BawError, BawSigner, redactAddresses, type BawRunner } from "./baw.ts";
import { callRefusal, gatePreview, summarizePreview, type Targets } from "./gate.ts";

const NOW = 1_800_000_000_000;
// Synthetic addresses only: never a real wallet.
const WALLET: Address = "0x000000000000000000000000000000000000a11c";
const COIN: Address = "0x00000000000000000000000000000000c0ffee01";

/** The success shape documented for `contract-call preview`, with an empty risk list, as seen live on 2026-10-21. */
function previewAnswer(over: { data?: Record<string, unknown>; risks?: Record<string, unknown>; sim?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  return {
    success: true,
    data: {
      requestId: "a1b2c3d4",
      parsedTx: { transactionType: "Swap" },
      simulationResult: { simulationCode: "000000000", simulationErrorDetail: null, ...over.sim },
      risks: { riskDetails: [], addresses: {}, riskBehaviors: [], ...over.risks },
      requireConfirmation: false,
      expiresAt: NOW + 60_000,
      ...over.data,
    },
    ...over.top,
  };
}
const gated = (answer: unknown) => gatePreview(summarizePreview(answer), NOW);

describe("the preview gate", () => {
  it("passes a clean preview", () => {
    expect(gated(previewAnswer())).toEqual({ ok: true });
  });

  it("refuses a listed risk, a flagged address and a risk behaviour", () => {
    const risky = gated(previewAnswer({ risks: { riskDetails: [{ code: "RISK_001", title: "High Risk Address", riskType: "RISK" }] } }));
    expect(risky).toMatchObject({ ok: false });
    if (!risky.ok) expect(risky.reason).toContain("High Risk Address");
    const flagged = { [COIN]: { riskLevel: 5, riskDetails: [{ title: "Suspicious Address" }] } };
    expect(gated(previewAnswer({ risks: { addresses: flagged } })).ok).toBe(false);
    expect(gated(previewAnswer({ risks: { riskBehaviors: [{ code: "x" }] } })).ok).toBe(false);
    // An address listed with no detail and a low level is not a flag.
    expect(gated(previewAnswer({ risks: { addresses: { [COIN]: { riskLevel: 0, riskDetails: [] } } } })).ok).toBe(true);
  });

  it("refuses an intercepted preview with the wallet's own words, addresses redacted", () => {
    const blocked = {
      success: false,
      error: { code: 351803, name: "AGENT_DEV_MODE_RISK_BLOCKED", message: `High risk transaction to ${COIN}`, data: { blockLevel: "Block" } },
    };
    const v = gated(blocked);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("AGENT_DEV_MODE_RISK_BLOCKED");
      expect(v.reason).not.toContain(COIN);
    }
  });

  it("refuses a failed simulation, a missing request id, a confirmation, an expired preview", () => {
    expect(gated(previewAnswer({ sim: { simulationCode: "351805", simulationErrorDetail: "TooLittleReceived" } })).ok).toBe(false);
    expect(gated(previewAnswer({ sim: { simulationErrorDetail: "reverted" } })).ok).toBe(false);
    expect(gated(previewAnswer({ data: { requestId: null } })).ok).toBe(false);
    expect(gated(previewAnswer({ data: { requireConfirmation: true } })).ok).toBe(false);
    expect(gated(previewAnswer({ data: { requireConfirmation: undefined } })).ok).toBe(false);
    expect(gated(previewAnswer({ data: { expiresAt: NOW - 1 } })).ok).toBe(false);
    // expiresAt in seconds is read as seconds.
    expect(gated(previewAnswer({ data: { expiresAt: Math.floor(NOW / 1000) + 30 } })).ok).toBe(true);
  });
});

describe("the call allowlist (L15)", () => {
  const trade = MAINNET.trade.kind === "infinity" ? MAINNET.trade : null!;
  const targets: Targets = {
    router: trade.router,
    factory: MAINNET.contracts.factory,
    hook: MAINNET.contracts.hook,
    permit2: trade.permit2,
    approvable: (token) => token.toLowerCase() === COIN.toLowerCase(),
  };
  const key: PoolKey = {
    currency0: COIN,
    currency1: MAINNET.contracts.wrappedNative,
    hooks: MAINNET.contracts.hook,
    poolManager: MAINNET.contracts.poolManager,
    fee: 100,
    parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1",
  };
  const buy = buyCall(
    trade.router,
    { wrappedNative: MAINNET.contracts.wrappedNative, quote: MAINNET.contracts.wrappedNative, coin: COIN, hops: [], poolKey: key, amountIn: 10n ** 15n, minOut: 1n, hookData: "0x" },
    1n,
  );

  it("lets through what the runtime builds", () => {
    expect(callRefusal(buy, targets)).toBeNull();
    expect(callRefusal(approveCall(COIN, trade.permit2), targets)).toBeNull();
    expect(callRefusal(permit2ApproveCall(trade.permit2, COIN, trade.router, 1n, 1n), targets)).toBeNull();
    expect(callRefusal(claimCreatorCall(MAINNET.contracts.hook, key), targets)).toBeNull();
    expect(callRefusal({ to: MAINNET.contracts.factory, data: `0x7fd96fff${"00".repeat(32)}` as Hex, value: 0n }, targets)).toBeNull();
  });

  it("refuses everything else", () => {
    expect(callRefusal({ ...buy, data: "0xdeadbeef" }, targets)).toMatch(/execute/);
    expect(callRefusal(approveCall(COIN, trade.router), targets)).toMatch(/Permit2/);
    expect(callRefusal(approveCall(WALLET, trade.permit2), targets)).toMatch(/not a contract/);
    expect(callRefusal(permit2ApproveCall(trade.permit2, COIN, WALLET, 1n, 1n), targets)).toMatch(/router/);
    expect(callRefusal(permit2ApproveCall(trade.permit2, WALLET, trade.router, 1n, 1n), targets)).toMatch(/Feast coin/);
    expect(callRefusal({ ...approveCall(COIN, trade.permit2), value: 1n }, targets)).toMatch(/BNB/);
    expect(callRefusal({ to: MAINNET.contracts.factory, data: "0x12345678", value: 0n }, targets)).toMatch(/create/);
    expect(callRefusal({ to: MAINNET.contracts.hook, data: "0x12345678", value: 0n }, targets)).toMatch(/claimCreator/);
    expect(callRefusal({ to: WALLET, data: "0x", value: 1n }, targets)).toBeTruthy();
  });
});

describe("the baw signer", () => {
  function fake(answers: Record<string, unknown>): { runner: BawRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: BawRunner = async (args) => {
      calls.push([...args]);
      const command = `${args[0]} ${args[1]}`;
      const answer = answers[command];
      if (answer === undefined) return { stdout: "", stderr: "unexpected", code: 1 };
      return { stdout: typeof answer === "string" ? answer : JSON.stringify(answer), stderr: "", code: 0 };
    };
    return { runner, calls };
  }

  it("refuses every command outside the allowlist before running anything", async () => {
    const { runner, calls } = fake({});
    const signer = new BawSigner(runner);
    for (const command of ["wallet send", "market-order swap", "sign-message execute", "approvals revoke", "auth signout", "wallet cancel"]) {
      await expect(signer.call(command, [])).rejects.toMatchObject({ errorName: "NOT_ALLOWED" });
    }
    expect(calls).toHaveLength(0);
    expect(BAW_ALLOWLIST).not.toContain("sign-message execute");
    expect(BAW_ALLOWLIST.some((c) => c.startsWith("market-order"))).toBe(false);
  });

  it("reads status, the chain-56 address, settings and the lock from the documented shapes", async () => {
    const { runner, calls } = fake({
      "wallet status": { success: true, data: { status: "CONNECTED" } },
      "wallet address": { success: true, data: { addresses: [{ binanceChainId: "CT_501", address: "So1ana" }, { binanceChainId: "56", address: WALLET }] } },
      "wallet settings": {
        success: true,
        data: {
          devMode: { enabled: true, expiresAt: 1793000000, dailyLimit: 1000, balanceExceeded: false },
          developerModeQuotaUsed: 12.5,
          sessionExpireTime: "2026-10-23T10:35:00+08:00",
          abnormalTxnHandling: "AutoReject",
        },
      },
      "wallet tx-lock": { success: true, data: { status: "UNLOCKED" } },
    });
    const seen: string[] = [];
    const signer = new BawSigner(runner, (c) => seen.push(c));
    expect(await signer.status()).toEqual({ connected: true, status: "CONNECTED" });
    expect((await signer.address()).toLowerCase()).toBe(WALLET);
    expect(await signer.settings()).toMatchObject({ devModeEnabled: true, devModeExpiresAt: 1793000000, devModeDailyLimitUsd: 1000, devModeQuotaUsedUsd: 12.5, balanceExceeded: false });
    expect(await signer.txLock()).toBe("UNLOCKED");
    expect(seen).toEqual(["wallet status", "wallet address", "wallet settings", "wallet tx-lock"]);
    expect(calls.every((args) => args.at(-1) === "--json")).toBe(true);
    expect(calls[3]).toEqual(["wallet", "tx-lock", "--binanceChainId", "56", "--json"]);
  });

  it("reads Developer Mode's expiry as the live wallet gives it: an ISO date (2026-10-21)", async () => {
    const { runner } = fake({ "wallet settings": { success: true, data: { devMode: { enabled: true, expiresAt: "2026-10-28T10:57:20+08:00", dailyLimit: 1000, balanceExceeded: false }, developerModeQuotaUsed: 2.22 } } });
    const settings = await new BawSigner(runner).settings();
    expect(settings.devModeExpiresAt).toBe(Math.floor(Date.parse("2026-10-28T10:57:20+08:00") / 1000));
  });

  it("previews with the call as separate arguments, value in wei", async () => {
    const { runner, calls } = fake({ "contract-call preview": previewAnswer() });
    const signer = new BawSigner(runner);
    const answer = await signer.preview({ from: WALLET, to: COIN, value: 2_000_000_000_000_000n, data: "0xabcdef" });
    expect(gatePreview(summarizePreview(answer), NOW).ok).toBe(true);
    expect(calls[0]).toEqual(["contract-call", "preview", "--binanceChainId", "56", "--from", WALLET, "--to", COIN, "--value", "2000000000000000", "--inputData", "0xabcdef", "--json"]);
  });

  it("executes a request id, and refuses one of an unexpected shape", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const { runner } = fake({ "contract-call execute": { success: true, data: { orderId: "o1", status: "BROADCASTED", txHash: hash, message: null } } });
    const signer = new BawSigner(runner);
    expect(await signer.execute("a1b2c3d4")).toEqual({ status: "BROADCASTED", txHash: hash, orderId: "o1", message: null });
    await expect(signer.execute("a; rm -rf /")).rejects.toBeInstanceOf(BawError);
  });

  it("turns the wallet's error and unparseable output into BawErrors, with addresses redacted", async () => {
    const { runner } = fake({
      "wallet status": { success: false, error: { code: 10002004, name: "AUTH_REJECTED", message: `no session for ${WALLET}` } },
      "wallet settings": `not json from ${WALLET}`,
    });
    const signer = new BawSigner(runner);
    const e = await signer.status().catch((error: unknown) => error as BawError);
    expect(e).toBeInstanceOf(BawError);
    expect((e as BawError).errorName).toBe("AUTH_REJECTED");
    expect((e as BawError).message).not.toContain(WALLET);
    const u = await signer.settings().catch((error: unknown) => error as BawError);
    expect((u as BawError).errorName).toBe("UNPARSEABLE");
    expect((u as BawError).message).not.toContain(WALLET);
    expect(redactAddresses(`a ${WALLET} b`)).toBe("a 0x… b");
  });
});
