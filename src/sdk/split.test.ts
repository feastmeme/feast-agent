import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import { BURN_ADDRESS, earnedTotal, feeSplitOf, splitPoints, type PoolInfo } from "./split.ts";

/** `poolInfo` of a sandbox coin after one unreferred buy and one unreferred sale (burn 10, referrer 10). */
const POOL: PoolInfo = {
  coinIsCurrency0: false,
  live: true,
  seeded: true,
  selfBurnBps: 1_000,
  referrerBps: 1_000,
  coin: "0x8a44135C84ac1AdA0A8f0ffDC24369Fe6325F7B6",
  creator: "0xeF1797948a4451B19Cd837c69f29D7A71008e290",
  openAt: 0n,
  opener: "0x0000000000000000000000000000000000000000",
  accruedQuote: 324926594024477n,
  selfBurnEarned: 32492659402447n,
  platformEarned: 64985318804895n,
  creatorEarned: 227448615817135n,
  referrerEarned: 0n,
  selfBurnUsed: 0n,
  platformUsed: 0n,
  creatorPaid: 0n,
  allowanceRemaining: 0n,
  allowanceUpdatedAt: 0n,
  tickLower: 191_200,
  tickUpper: 887_200,
  perWalletCap: 5_000_000n * 10n ** 18n,
  servedBlocks: 2n,
  lastServedBlock: 0n,
  filledCoinPending: 0n,
};
const CONTEXT = {
  poolId: "0x08c8d78b3f010182fbd0c5c4a0705ba31addc7e1c601ad6bb0c1c778583c1be7" as Hex,
  quote: { address: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A" as Address, symbol: "AAPLB", decimals: 18 },
};

describe("splitPoints", () => {
  it("gives the platform its constant 20 and the creator the remainder of 80", () => {
    expect(splitPoints(POOL)).toEqual({ creator: 60, burn: 10, referrer: 10, platform: 20 });
    expect(splitPoints({ ...POOL, selfBurnBps: 3_000, referrerBps: 0 })).toEqual({ creator: 50, burn: 30, referrer: 0, platform: 20 });
  });
  it("folds a burn-address creator's points into the burn seat, as the hook banks them", () => {
    expect(splitPoints({ ...POOL, creator: BURN_ADDRESS })).toEqual({ creator: 0, burn: 70, referrer: 10, platform: 20 });
  });
});

describe("feeSplitOf", () => {
  it("restates the hook's ledger, and the four seats sum to what was accrued", () => {
    const split = feeSplitOf(POOL, CONTEXT);
    expect(split.accrued).toBe(324926594024477n);
    expect(earnedTotal(split)).toBe(split.accrued);
    expect(split.seats.creator).toEqual({ points: 60, earned: 227448615817135n, settled: 0n, pending: 227448615817135n });
    expect(split.seats.referrer.settled).toBeNull();
    expect(split.seats.platform.pending).toBe(64985318804895n);
  });
  it("shows an unreferred trade's referrer points landing with the creator (60 + 10 = 70% of the fee)", () => {
    const split = feeSplitOf(POOL, CONTEXT);
    // Per mille, rounded: each trade's shares are floored on chain, so the platform's is a hair under 20%.
    const perMille = (x: bigint) => (x * 1000n + split.accrued / 2n) / split.accrued;
    expect(perMille(split.seats.creator.earned)).toBe(700n);
    expect(perMille(split.seats.platform.earned)).toBe(200n);
    expect(perMille(split.seats.burn.earned)).toBe(100n);
  });
  it("keeps paid-out money apart from what is still pending", () => {
    const paid = feeSplitOf({ ...POOL, creatorPaid: 27448615817135n, selfBurnUsed: 2492659402447n }, CONTEXT);
    expect(paid.seats.creator.pending).toBe(200000000000000n);
    expect(paid.seats.burn.pending).toBe(30000000000000n);
  });
});
