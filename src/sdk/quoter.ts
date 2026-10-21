import { concat, encodeAbiParameters, numberToHex, type Address, type Hex, type PublicClient } from "viem";

import { FeastError, INFINITY_REFUSALS_ABI, infinityRefusalOf } from "./errors.ts";
import type { PoolKey } from "./infinity.ts";
import type { Hop } from "./networks.ts";
import { mixedQuoterAbi } from "./venue-abi.ts";

/**
 * What a mainnet trade would bring, from the venue's MixedQuoter, which
 * simulates the very pools the router will swap — the address book's v3 hops
 * and the Feast pool with its hook.
 *
 * Simulated AS THE WALLET when one is given: the hook's opening cap asks
 * `tx.origin`, so only a quote simulated from the trader's address tells whether
 * this wallet's buy fits under it. The Feast leg is quoted on its own, so the
 * caller has the quote leg a price-impact check is measured on.
 */

/** `MixedQuoterActions.sol`. */
const MIXED_V3_EXACT_INPUT_SINGLE = 0x03;
const MIXED_INFI_CL_EXACT_INPUT_SINGLE = 0x04;

const QUOTER_CALL_ABI = [...mixedQuoterAbi.filter((entry) => entry.type === "function"), ...INFINITY_REFUSALS_ABI] as const;

export type QuoteRequest = {
  client: PublicClient;
  mixedQuoter: Address;
  wrappedNative: Address;
  coin: Address;
  quote: Address;
  poolKey: PoolKey;
  /** The address book's hops: wrapped native → quote for a buy, quote → wrapped native for a sale. */
  hops: readonly Hop[];
  amountIn: bigint;
  hookData: Hex;
  /** The wallet the trade will come from. */
  account?: Address;
};

export type TradeQuoteOut = {
  /** Coins out of a buy; native out of a sale. */
  out: bigint;
  /** The quote-token leg into (buy) or out of (sale) the Feast pool. */
  legQuote: bigint;
};

async function mixed(req: QuoteRequest, paths: Address[], actions: number[], params: Hex[], amountIn: bigint): Promise<bigint> {
  try {
    const { result } = await req.client.simulateContract({
      address: req.mixedQuoter,
      abi: QUOTER_CALL_ABI,
      functionName: "quoteMixedExactInput",
      args: [paths, concat(actions.map((action) => numberToHex(action, { size: 1 }))), params, amountIn],
      account: req.account,
    });
    return (result as readonly [bigint, bigint])[0];
  } catch (error) {
    const refusal = infinityRefusalOf(error);
    throw new FeastError(`the quoter refused: ${refusal.message}`, "quote_refused", refusal);
  }
}

function hopsQuote(req: QuoteRequest, tokenIn: Address, hops: readonly Hop[], amountIn: bigint): Promise<bigint> {
  return mixed(
    req,
    [tokenIn, ...hops.map((hop) => hop.tokenOut)],
    hops.map(() => MIXED_V3_EXACT_INPUT_SINGLE),
    hops.map((hop) => encodeAbiParameters([{ type: "uint24" }], [hop.fee])),
    amountIn,
  );
}

function feastQuote(req: QuoteRequest, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
  const param = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "hooks", type: "address" },
              { name: "poolManager", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "parameters", type: "bytes32" },
            ],
          },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey: req.poolKey, hookData: req.hookData }],
  );
  return mixed(req, [tokenIn, tokenOut], [MIXED_INFI_CL_EXACT_INPUT_SINGLE], [param], amountIn);
}

/** A buy of `amountIn` native wei: through the hops to the quote, then the Feast pool. */
export async function quoteBuy(req: QuoteRequest): Promise<TradeQuoteOut> {
  const legQuote = req.hops.length > 0 ? await hopsQuote(req, req.wrappedNative, req.hops, req.amountIn) : req.amountIn;
  const out = await feastQuote(req, req.quote, req.coin, legQuote);
  return { out, legQuote };
}

/** A sale of `amountIn` coins: the Feast pool to the quote, then the hops back to native. */
export async function quoteSell(req: QuoteRequest): Promise<TradeQuoteOut> {
  const legQuote = await feastQuote(req, req.coin, req.quote, req.amountIn);
  const out = req.hops.length > 0 ? await hopsQuote(req, req.quote, req.hops, legQuote) : legQuote;
  return { out, legQuote };
}

/** A buy paid in the quote token: the Feast pool alone. */
export async function quoteBuyInQuote(req: QuoteRequest): Promise<TradeQuoteOut> {
  const out = await feastQuote(req, req.quote, req.coin, req.amountIn);
  return { out, legQuote: req.amountIn };
}
