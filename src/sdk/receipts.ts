import { parseEventLogs, type Address, type Log } from "viem";

import { factoryAbi, hookAbi, routerAbi } from "./abi.ts";
import { wrappedNativeAbi } from "./venue-abi.ts";

/**
 * What a mined receipt says happened, bound to who must have said it.
 *
 * Any contract can emit an event with the factory's or the router's signature,
 * so a log counts only if the configured contract emitted it, for the account
 * that signed — and a receipt holding two of them (a batch) is refused rather
 * than read as its first.
 */

type Logs = { logs: Log[] };

/** The factory's own `CoinCreated` events for this creator. */
export function creationsOf(receipt: Logs, bound: { factory: Address; creator: Address }) {
  return parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: "CoinCreated" }).filter(
    (log) =>
      log.address.toLowerCase() === bound.factory.toLowerCase() &&
      log.args.creator.toLowerCase() === bound.creator.toLowerCase(),
  );
}

/** The router's own `Traded` events for this trader and coin. */
export function fillsOf(receipt: Logs, bound: { router: Address; trader: Address; coin: Address }) {
  return parseEventLogs({ abi: routerAbi, logs: receipt.logs, eventName: "Traded" }).filter(
    (log) =>
      log.address.toLowerCase() === bound.router.toLowerCase() &&
      log.args.trader.toLowerCase() === bound.trader.toLowerCase() &&
      log.args.coin.toLowerCase() === bound.coin.toLowerCase(),
  );
}

/** One direction's fills in a receipt, summed: never the first of them alone. */
export type Fills = { coinAmount: bigint; quoteAmount: bigint; fee: bigint; fills: number };

const NO_FILLS: Fills = { coinAmount: 0n, quoteAmount: 0n, fee: 0n, fills: 0 };

/**
 * A mainnet trade's fills: the HOOK's own `Trade` events (the Universal Router
 * emits none), from the configured hook only, for this payer and this coin, the
 * buys summed apart from the sales. The payer is `tx.origin`, the wallet that
 * sent the transaction.
 */
export function hookFillsOf(receipt: Logs, bound: { hook: Address; payer: Address; coin: Address }): { buy: Fills; sell: Fills } {
  const same = (a: string | undefined, b: string) => Boolean(a) && a!.toLowerCase() === b.toLowerCase();
  const sums = { buy: { ...NO_FILLS }, sell: { ...NO_FILLS } };
  for (const log of parseEventLogs({ abi: hookAbi, logs: receipt.logs, eventName: "Trade", strict: false })) {
    if (!same(log.address, bound.hook) || !same(log.args.payer, bound.payer) || !same(log.args.coin, bound.coin)) continue;
    const side = log.args.buy ? sums.buy : sums.sell;
    side.coinAmount += log.args.coinAmount ?? 0n;
    side.quoteAmount += log.args.quoteAmount ?? 0n;
    side.fee += log.args.fee ?? 0n;
    side.fills += 1;
  }
  return sums;
}

/** The native leg of a router trade: WBNB's own record of the router's wrap (`Deposit`) and unwrap (`Withdrawal`). */
export function nativeLegsOf(receipt: Logs, bound: { wrappedNative: Address; router: Address }): { wrapped: bigint; unwrapped: bigint } {
  const same = (a: string | undefined, b: string) => Boolean(a) && a!.toLowerCase() === b.toLowerCase();
  let wrapped = 0n;
  let unwrapped = 0n;
  for (const log of parseEventLogs({ abi: wrappedNativeAbi, logs: receipt.logs, strict: false })) {
    if (!same(log.address, bound.wrappedNative)) continue;
    if (log.eventName === "Deposit" && same(log.args.dst, bound.router)) wrapped += log.args.wad ?? 0n;
    if (log.eventName === "Withdrawal" && same(log.args.src, bound.router)) unwrapped += log.args.wad ?? 0n;
  }
  return { wrapped, unwrapped };
}
