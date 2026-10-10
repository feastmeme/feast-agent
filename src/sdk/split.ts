import type { Address, Hex } from "viem";

/**
 * The fee split, as the hook banks it.
 *
 * Every trade pays a 1% fee in the pool's quote token (the paired stock token).
 * The hook divides it into four seats: the platform's 20 points are a contract
 * constant, and the creator chose the other 80 at launch — up to 30 burned
 * (bought back and burned), up to 30 to whoever referred the trade, the rest to
 * the creator. A trade nobody referred folds the referrer's points into the
 * creator's. Everything here is a restatement of `FeastHook.poolInfo`, never a
 * recomputation of fees.
 */

export const BURN_ADDRESS = "0x000000000000000000000000000000000000dead" as const;

/** `FeastHook.Pool`, as `poolInfo(poolId)` returns it. */
export type PoolInfo = {
  coinIsCurrency0: boolean;
  live: boolean;
  seeded: boolean;
  selfBurnBps: number;
  referrerBps: number;
  coin: Address;
  creator: Address;
  openAt: bigint;
  opener: Address;
  accruedQuote: bigint;
  selfBurnEarned: bigint;
  platformEarned: bigint;
  creatorEarned: bigint;
  referrerEarned: bigint;
  selfBurnUsed: bigint;
  platformUsed: bigint;
  creatorPaid: bigint;
  allowanceRemaining: bigint;
  allowanceUpdatedAt: bigint;
  tickLower: number;
  tickUpper: number;
  perWalletCap: bigint;
  servedBlocks: bigint;
  lastServedBlock: bigint;
  filledCoinPending: bigint;
};

export type Seat = "creator" | "burn" | "referrer" | "platform";
export const SEATS: readonly Seat[] = ["creator", "burn", "referrer", "platform"];

/** Points of the 1% fee each seat takes, out of 100. */
export type SplitPoints = Record<Seat, number>;

/** One seat's money, in the quote token's base units. */
export type SeatLedger = {
  points: number;
  /** Everything this seat has been credited since launch. */
  earned: bigint;
  /** What has left the pool for it: paid to the creator, spent on buy-back-and-burn, released to the platform sink. Null where the hook keeps no pool-wide figure (referrers are paid per referrer). */
  settled: bigint | null;
  /** earned − settled, where both are known. */
  pending: bigint | null;
};

export type FeeSplit = {
  coin: Address;
  poolId: Hex;
  quote: { address: Address; symbol: string; decimals: number };
  creator: Address;
  /** Everything the 1% has produced. The four `earned` figures sum to it. */
  accrued: bigint;
  seats: Record<Seat, SeatLedger>;
  /** True when the creator is the burn address and its points are folded into the burn seat. */
  creatorIsBurn: boolean;
};

export function isBurnAddress(address: string): boolean {
  return address.trim().toLowerCase() === BURN_ADDRESS;
}

/** The split in points of the 1%, the way the hook banks it. */
export function splitPoints(pool: Pick<PoolInfo, "selfBurnBps" | "referrerBps" | "creator">): SplitPoints {
  const burn = pool.selfBurnBps / 100;
  const referrer = pool.referrerBps / 100;
  const creator = 80 - burn - referrer;
  if (isBurnAddress(pool.creator)) return { creator: 0, burn: burn + creator, referrer, platform: 20 };
  return { creator, burn, referrer, platform: 20 };
}

/** The four seats and their totals, from one `poolInfo` read. */
export function feeSplitOf(
  pool: PoolInfo,
  context: { poolId: Hex; quote: { address: Address; symbol: string; decimals: number } },
): FeeSplit {
  const points = splitPoints(pool);
  return {
    coin: pool.coin,
    poolId: context.poolId,
    quote: context.quote,
    creator: pool.creator,
    accrued: pool.accruedQuote,
    creatorIsBurn: isBurnAddress(pool.creator),
    seats: {
      creator: {
        points: points.creator,
        earned: pool.creatorEarned,
        settled: pool.creatorPaid,
        pending: pool.creatorEarned - pool.creatorPaid,
      },
      burn: {
        points: points.burn,
        earned: pool.selfBurnEarned,
        settled: pool.selfBurnUsed,
        pending: pool.selfBurnEarned - pool.selfBurnUsed,
      },
      referrer: { points: points.referrer, earned: pool.referrerEarned, settled: null, pending: null },
      platform: {
        points: points.platform,
        earned: pool.platformEarned,
        settled: pool.platformUsed,
        pending: pool.platformEarned - pool.platformUsed,
      },
    },
  };
}

/** The sum of the four seats' `earned`, which the hook keeps equal to `accrued`. */
export function earnedTotal(split: FeeSplit): bigint {
  return SEATS.reduce((sum, seat) => sum + split.seats[seat].earned, 0n);
}

