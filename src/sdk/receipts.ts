import { parseEventLogs, type Address, type Log } from "viem";

import { factoryAbi, routerAbi } from "./abi.ts";

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
