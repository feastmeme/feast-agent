import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";

import { hookAbi } from "../../sdk/abi.ts";
import { MAINNET } from "../../sdk/networks.ts";
import { wrappedNativeAbi } from "../../sdk/venue-abi.ts";
import type { Signer, WalletSettings } from "../baw.ts";
import type { LeagueChain } from "../chain.ts";

/**
 * TEST FAKES, NOT USED AT RUNTIME (task 963).
 *
 * A wallet and a chain that fill a trade end to end through the real executor:
 * the signer writes down every call, and the chain's receipt carries the hook's
 * Trade events and WBNB's wrap and unwrap of exactly what the last preview sent,
 * so a buy and a sale both verify. Every address here is made up.
 */

// Synthetic: never a real wallet.
export const WALLET: Address = "0x000000000000000000000000000000000000a11c";
export const FEAST: Address = MAINNET.platformCoin!.address;
const WBNB = MAINNET.contracts.wrappedNative;
const ROUTER = MAINNET.trade.kind === "infinity" ? MAINNET.trade.router : WALLET;

export type TradeWorld = {
  signer: Signer;
  chain: LeagueChain;
  /** Every wallet call, in order: status, settings, preview, execute, … */
  calls: string[];
  /** What the chain is asked to mark a position at, BNB in wei per call (default: its cost). */
  marks: { wei: bigint | null };
  /** Coins the factory does not know (L15). */
  notFeast: Set<string>;
  hashes: Hex[];
};

const settings = (): WalletSettings =>
  ({ devModeEnabled: true, devModeExpiresAt: null, devModeDailyLimitUsd: 1_000, devModeQuotaUsedUsd: 0, balanceExceeded: false, sessionExpireTime: null, inactiveSignOutTime: null, abnormalTxnHandling: null }) as WalletSettings;

/** One coin's trades: a buy fills `coins` for whatever BNB was sent; a sale of anything pays `sellBnbWei`. */
export function tradeWorld(options: { coin?: Address; symbol?: string; coins?: bigint; sellBnbWei?: bigint; balanceWei?: bigint; now?: () => number } = {}): TradeWorld {
  const coin = options.coin ?? FEAST;
  const coins = options.coins ?? 10_000n * 10n ** 18n;
  const calls: string[] = [];
  const hashes: Hex[] = [];
  const last = { value: 0n };
  const marks: TradeWorld["marks"] = { wei: null };
  const notFeast = new Set<string>();
  const clean = () => ({ success: true, data: { requestId: `r${calls.length}`, simulationResult: { simulationCode: "000000000", simulationErrorDetail: null }, risks: { riskDetails: [], addresses: {}, riskBehaviors: [] }, requireConfirmation: false, expiresAt: (options.now ?? Date.now)() + 600_000 } });
  const signer: Signer = {
    status: async () => (calls.push("status"), { connected: true, status: "CONNECTED" }),
    address: async () => (calls.push("address"), WALLET),
    settings: async () => (calls.push("settings"), settings()),
    txLock: async () => "UNLOCKED",
    preview: async (tx: { value?: bigint }) => {
      calls.push("preview");
      last.value = BigInt(tx?.value ?? 0n);
      return clean();
    },
    execute: async () => {
      calls.push("execute");
      const hash = `0x${String(hashes.length + 1).padStart(64, "0")}` as Hex;
      hashes.push(hash);
      return { status: "BROADCASTED", txHash: hash, orderId: "o", message: null };
    },
    signMessagePreview: async () => ({}),
  };
  const tradeLog = (buy: boolean, coinAmount: bigint, quoteAmount: bigint) => ({
    address: MAINNET.contracts.hook,
    topics: encodeEventTopics({ abi: hookAbi, eventName: "Trade", args: { coin, quote: WBNB, payer: WALLET } }),
    data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint160" }, { type: "uint256" }], [buy, coinAmount, quoteAmount, 1n, quoteAmount / 100n]),
  });
  const wnative = (eventName: "Deposit" | "Withdrawal", wad: bigint) => ({
    address: WBNB,
    topics: encodeEventTopics({ abi: wrappedNativeAbi, eventName, args: eventName === "Deposit" ? { dst: ROUTER } : { src: ROUTER } } as never),
    data: encodeAbiParameters([{ type: "uint256" }], [wad]),
  });
  const sellBnb = options.sellBnbWei ?? 10n ** 15n;
  const key = { currency0: coin, currency1: WBNB, hooks: MAINNET.contracts.hook, poolManager: MAINNET.contracts.poolManager, fee: 100, parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1" };
  const chain = {
    client: { simulateContract: async () => ({ result: [coins, 0n] }), getTransactionReceipt: async () => null, getTransaction: async () => null },
    coinInfo: async (c: Address) => (notFeast.has(c.toLowerCase()) ? null : { coin: c, quote: WBNB, creator: WALLET, poolId: MAINNET.platformCoin!.poolId, coinIsCurrency0: true, symbol: options.symbol ?? "FEAST", name: options.symbol ?? "Feast" }),
    isFeastCoin: async (c: Address) => !notFeast.has(c.toLowerCase()),
    poolKey: async () => key,
    hops: () => [],
    // Spot just under the fill's price, so the impact is inside L10.
    spotQuotePerCoinE18: async () => 10n ** 12n,
    chainTime: async () => 1n,
    receipt: async () => {
      const logs = last.value > 0n ? [tradeLog(true, coins, last.value), wnative("Deposit", last.value)] : [tradeLog(false, coins, sellBnb), wnative("Withdrawal", sellBnb)];
      return { status: "success", logs, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 2n };
    },
    balance: async () => options.balanceWei ?? 10n ** 18n,
    bnbUsd: async () => 600,
    // By default a position is marked at 0.002 BNB per 10,000 coins: about what a small buy paid.
    markWei: async (_c: Address, held: bigint) => marks.wei ?? held / (5n * 10n ** 6n),
    quoteBnbE18: async () => 10n ** 18n,
    quoteToBnbWei: async (_q: unknown, amount: bigint) => amount,
    tokenBalance: async () => coins,
    allowance: async () => 2n ** 256n - 1n,
    permit2Allowance: async () => ({ amount: 2n ** 160n - 1n, expiration: 2 ** 47 }),
  } as unknown as LeagueChain;
  return { signer, chain, calls, marks, notFeast, hashes };
}

/** A clock the loop's own sleep moves forward: an hour of the loop in a few hundred iterations. */
export function fakeClock(start: number) {
  const clock = { t: start, hooks: [] as { at: number; run: () => void }[] };
  const now = () => clock.t;
  const sleep = async (ms: number) => {
    clock.t += ms;
    for (const hook of clock.hooks.filter((h) => h.at <= clock.t)) {
      clock.hooks.splice(clock.hooks.indexOf(hook), 1);
      hook.run();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { clock, now, sleep, at: (ms: number, run: () => void) => clock.hooks.push({ at: ms, run }) };
}
