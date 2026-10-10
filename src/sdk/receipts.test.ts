import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from "viem";

import { factoryAbi, routerAbi } from "./abi.ts";
import { creationsOf, fillsOf } from "./receipts.ts";

const FACTORY = "0x0c68E97F14D6f934Fef6126a149508fA67B56C3f" as Address;
const ROUTER = "0xa8c7180912D4464fa66713758Fa7eB3418b81D01" as Address;
const IMPOSTOR = "0x1111111111111111111111111111111111111111" as Address;
const ME = "0x2222222222222222222222222222222222222222" as Address;
const SOMEONE = "0x3333333333333333333333333333333333333333" as Address;
const COIN = "0x4444444444444444444444444444444444444444" as Address;
const AAPLB = "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A" as Address;
const POOL_ID = `0x${"99".repeat(32)}` as Hex;

function log(address: Address, topics: Hex[], data: Hex, logIndex = 0): Log {
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${"aa".repeat(32)}`,
    blockNumber: 1n,
    logIndex,
    transactionHash: `0x${"bb".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

function coinCreated(emitter: Address, creator: Address, logIndex = 0): Log {
  const topics = encodeEventTopics({ abi: factoryAbi, eventName: "CoinCreated", args: { coin: COIN, creator, quote: AAPLB } }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "uint16" }, { type: "uint16" }, { type: "bytes32" }],
    [POOL_ID, 10n ** 27n, 1000, 1000, `0x${"ab".repeat(32)}`],
  );
  return log(emitter, topics, data, logIndex);
}

function traded(emitter: Address, trader: Address, buy: boolean): Log {
  const topics = encodeEventTopics({ abi: routerAbi, eventName: "Traded", args: { trader, coin: COIN } }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }],
    [buy, 10n ** 16n, 21n * 10n ** 15n, 4n * 10n ** 24n, 2n * 10n ** 14n, SOMEONE],
  );
  return log(emitter, topics, data);
}

describe("creationsOf", () => {
  it("decodes the factory's CoinCreated for this creator", () => {
    const [created] = creationsOf({ logs: [coinCreated(FACTORY, ME)] }, { factory: FACTORY, creator: ME });
    expect(created?.args.coin).toBe(COIN);
    expect(created?.args.poolId).toBe(POOL_ID);
    expect(created?.args.selfBurnBps).toBe(1000);
  });
  it("ignores a lookalike event from another contract, and another creator's coin", () => {
    expect(creationsOf({ logs: [coinCreated(IMPOSTOR, ME)] }, { factory: FACTORY, creator: ME })).toHaveLength(0);
    expect(creationsOf({ logs: [coinCreated(FACTORY, SOMEONE)] }, { factory: FACTORY, creator: ME })).toHaveLength(0);
  });
  it("returns both of a batch so the caller can refuse it", () => {
    expect(creationsOf({ logs: [coinCreated(FACTORY, ME, 0), coinCreated(FACTORY, ME, 1)] }, { factory: FACTORY, creator: ME })).toHaveLength(2);
  });
});

describe("fillsOf", () => {
  it("decodes the router's Traded for this trader and coin", () => {
    const [fill] = fillsOf({ logs: [traded(ROUTER, ME, true)] }, { router: ROUTER, trader: ME, coin: COIN });
    expect(fill?.args.buy).toBe(true);
    expect(fill?.args.coinAmount).toBe(4n * 10n ** 24n);
    expect(fill?.args.referrer).toBe(SOMEONE);
  });
  it("ignores fills from another emitter or for another trader", () => {
    expect(fillsOf({ logs: [traded(IMPOSTOR, ME, true)] }, { router: ROUTER, trader: ME, coin: COIN })).toHaveLength(0);
    expect(fillsOf({ logs: [traded(ROUTER, SOMEONE, true)] }, { router: ROUTER, trader: ME, coin: COIN })).toHaveLength(0);
  });
});
