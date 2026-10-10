import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";

import { refusalErrorsAbi } from "./abi.ts";

/** An error this SDK raises on purpose, with a sentence a person can act on. */
export class FeastError extends Error {
  override name = "FeastError";
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * PancakeSwap Infinity's pool manager re-raises a hook's revert inside
 * `WrappedError(target, selector, reason, details)`, so a buy the Feast hook
 * refuses (say `PurchaseCapExceeded()`) reaches the caller as `0x90bfb865…`.
 */
export const venueErrorsAbi = [
  {
    type: "error",
    name: "WrappedError",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "reason", type: "bytes" },
      { name: "details", type: "bytes" },
    ],
  },
] as const;

/** Everything a Feast call can be refused with, the venue's wrapper included. */
export const REFUSALS_ABI = [...refusalErrorsAbi, ...venueErrorsAbi] as const;

/** What a contract said when it refused a call, when it said anything decodable. */
export type Refusal = {
  errorName: string | null;
  args: readonly unknown[];
  /** The contract that raised it, when the venue wrapped it. */
  raisedBy?: Hex;
  message: string;
};

/** Plain-language notes for the refusals a trader is most likely to meet. */
const HINTS: Record<string, string> = {
  PurchaseCapExceeded:
    "the pool is in its opening window (its first two blocks with trades) and caps each wallet's buy; buy less, or wait for the window to pass",
  PoolNotOpenYet: "the pool does not accept public trades yet",
  ERC20InsufficientBalance: "the wallet does not hold that many tokens",
  TooLittleOut: "the price moved past the slippage bound (minimum out, actual out)",
  UnknownCoin: "the factory did not make this coin",
  SeedWouldNeedQuote: "the opening price is on the wrong side of the start tick",
  PoolTooShallow: "the opening liquidity is too small",
  PrebuyNeedsTheCreator: "only the creator may send a create that pre-buys",
  CreationStopped: "the factory is not accepting new coins",
};

function describe(errorName: string | null, args: readonly unknown[], fallback: string, raisedBy?: Hex): Refusal {
  const hint = errorName ? HINTS[errorName] : undefined;
  const base = errorName ? `${errorName}(${args.map(String).join(", ")})` : fallback;
  const where = raisedBy ? ` [raised by ${raisedBy}]` : "";
  return { errorName, args, raisedBy, message: `${base}${where}${hint ? `: ${hint}` : ""}` };
}

/** Decode raw revert data, unwrapping the venue's `WrappedError` to the hook's own refusal. */
export function decodeRefusalData(data: Hex): Refusal {
  try {
    const decoded = decodeErrorResult({ abi: REFUSALS_ABI, data });
    if (decoded.errorName === "WrappedError") {
      const [target, , reason] = decoded.args as readonly [Hex, Hex, Hex, Hex];
      const inner = decodeRefusalData(reason);
      return inner.errorName ? describe(inner.errorName, inner.args, inner.message, target) : describe(null, [], `WrappedError from ${target}: ${reason}`);
    }
    return describe(decoded.errorName, decoded.args ?? [], decoded.errorName);
  } catch {
    return describe(null, [], data.length > 2 ? `unrecognised revert ${data.slice(0, 10)}` : "reverted without a reason");
  }
}

/** Turn whatever a viem call threw into a refusal with the contract's own error name. */
export function refusalOf(error: unknown): Refusal {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.raw) return decodeRefusalData(reverted.raw);
      const errorName = reverted.data?.errorName ?? null;
      return describe(errorName, reverted.data?.args ?? [], reverted.signature ?? reverted.shortMessage);
    }
    return describe(null, [], error.shortMessage);
  }
  return describe(null, [], error instanceof Error ? error.message : String(error));
}
