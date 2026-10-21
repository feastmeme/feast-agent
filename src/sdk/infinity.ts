import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  maxUint256,
  numberToHex,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";

import { coinAbi, hookAbi } from "./abi.ts";
import type { Hop } from "./networks.ts";
import { permit2Abi, universalRouterAbi } from "./venue-abi.ts";

/**
 * A mainnet trade, as bytes: the calldata of PancakeSwap Infinity's Universal
 * Router for a Feast buy or sale, built exactly as the feast.meme site builds it
 * (`src/lib/trade/universal-router.ts` there; `infinity.test.ts` holds these
 * functions to that encoder's output, byte for byte).
 *
 * Pure functions from a plan to `{ to, data, value }`: no chain, no wallet, no
 * clock. Whoever signs is somebody else's business; in this repository it is the
 * league runtime, through the Binance Agentic Wallet.
 *
 * Two layers. A COMMAND is one byte of `commands` with one `inputs[i]` beside it;
 * `INFI_SWAP`'s input is itself a list of ACTIONS run inside one vault lock. The
 * Feast pool is always one CL action there; the v3 hops a stock-paired coin
 * needs on the way to or from wrapped native are a `V3_SWAP_EXACT_IN` command
 * beside it.
 */

/** `Commands.sol`: the command bytes a Feast trade sends. */
export const COMMAND = {
  V3_SWAP_EXACT_IN: 0x00,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  INFI_SWAP: 0x10,
} as const;

/** `Actions.sol`: the action bytes inside `INFI_SWAP`. */
export const ACTION = {
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

/** "Whatever the open delta is": an input amount of zero. */
export const OPEN_DELTA = 0n;
/** "The router's whole balance of this token": 1 << 255. */
export const CONTRACT_BALANCE = 1n << 255n;
/** The recipient flag for whoever called `execute`. */
export const MSG_SENDER: Hex = "0x0000000000000000000000000000000000000001";
/** The recipient flag for the router itself. */
export const ADDRESS_THIS: Hex = "0x0000000000000000000000000000000000000002";
/** The largest Permit2 allowance, `uint160` max: what the venue's own site grants. */
export const MAX_UINT160 = (1n << 160n) - 1n;

/** An Infinity pool's key: the six words its id is the hash of. */
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  hooks: Address;
  poolManager: Address;
  fee: number;
  parameters: Hex;
};

/** Permit2's `PermitSingle`. `expiration` and `nonce` are `uint48`, carried as bigints. */
export type PermitSingle = {
  details: { token: Address; amount: bigint; expiration: bigint; nonce: bigint };
  spender: Address;
  sigDeadline: bigint;
};

export type Action =
  | { action: "CL_SWAP_EXACT_IN_SINGLE"; poolKey: PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; hookData: Hex }
  | { action: "SETTLE"; currency: Address; amount: bigint; payerIsUser: boolean }
  | { action: "SETTLE_ALL"; currency: Address; maxAmount: bigint }
  | { action: "TAKE"; currency: Address; recipient: Hex; amount: bigint }
  | { action: "TAKE_ALL"; currency: Address; minAmount: bigint };

export type Command =
  | { command: "V3_SWAP_EXACT_IN"; recipient: Hex; amountIn: bigint; amountOutMin: bigint; path: Hex; payerIsUser: boolean }
  | { command: "PERMIT2_PERMIT"; permit: PermitSingle; signature: Hex }
  | { command: "WRAP_ETH"; recipient: Hex; amount: bigint }
  | { command: "UNWRAP_WETH"; recipient: Hex; amountMin: bigint }
  | { command: "INFI_SWAP"; actions: Action[] };

/** A transaction, ready for somebody to sign. */
export type Call = { to: Address; data: Hex; value: bigint };

const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "hooks", type: "address" },
    { name: "poolManager", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "parameters", type: "bytes32" },
  ],
} as const;

const CL_SWAP_EXACT_IN_SINGLE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", ...POOL_KEY },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/** Widened on purpose, not `as const`: the `uint48` fields travel as bigints, which the encoder takes as it takes any uint. */
const PERMIT_SINGLE: AbiParameter = {
  type: "tuple",
  components: [
    {
      name: "details",
      type: "tuple",
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
    },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
};

/** One action's `params[i]`. */
export function encodeAction(step: Action): Hex {
  switch (step.action) {
    case "CL_SWAP_EXACT_IN_SINGLE":
      return encodeAbiParameters(CL_SWAP_EXACT_IN_SINGLE_PARAMS, [
        {
          poolKey: step.poolKey,
          zeroForOne: step.zeroForOne,
          amountIn: step.amountIn,
          amountOutMinimum: step.amountOutMinimum,
          hookData: step.hookData,
        },
      ]);
    case "SETTLE":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [step.currency, step.amount, step.payerIsUser]);
    case "SETTLE_ALL":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.currency, step.maxAmount]);
    case "TAKE":
      return encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [step.currency, step.recipient, step.amount]);
    case "TAKE_ALL":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.currency, step.minAmount]);
  }
}

/** `INFI_SWAP`'s input: `abi.encode(bytes actions, bytes[] params)`. */
export function encodeActions(actions: readonly Action[]): Hex {
  const bytes = actions.length === 0 ? "0x" : concat(actions.map((step) => numberToHex(ACTION[step.action], { size: 1 })));
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [bytes, actions.map(encodeAction)]);
}

/** One command's `inputs[i]`. */
export function encodeCommandInput(step: Command): Hex {
  switch (step.command) {
    case "V3_SWAP_EXACT_IN":
      return encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
        [step.recipient, step.amountIn, step.amountOutMin, step.path, step.payerIsUser],
      );
    case "PERMIT2_PERMIT":
      return encodeAbiParameters([PERMIT_SINGLE, { type: "bytes" }], [step.permit, step.signature]);
    case "WRAP_ETH":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.recipient, step.amount]);
    case "UNWRAP_WETH":
      return encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [step.recipient, step.amountMin]);
    case "INFI_SWAP":
      return encodeActions(step.actions);
  }
}

/** The whole calldata: `execute(commands, inputs, deadline)`. */
export function encodeExecute(steps: readonly Command[], deadline: bigint): Hex {
  const commands = steps.length === 0 ? "0x" : concat(steps.map((step) => numberToHex(COMMAND[step.command], { size: 1 })));
  return encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [commands, steps.map(encodeCommandInput), deadline] });
}

/** A v3 route as the router's `path`: `token ‖ fee (3 bytes) ‖ token …`, walking the address book's hops from `tokenIn`. */
export function v3Path(tokenIn: Address, hops: readonly Hop[]): Hex {
  return concat([tokenIn, ...hops.flatMap((hop) => [numberToHex(hop.fee, { size: 3 }), hop.tokenOut])]).toLowerCase() as Hex;
}

/** `PoolIdLibrary.toId`: the keccak of the key's six words. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY], [key]));
}

/** The hook's referrer word: one 32-byte word naming the referrer, or nothing for nobody. */
export function hookDataFor(referrer: Address | null | undefined): Hex {
  if (!referrer || !isAddress(referrer) || BigInt(referrer) === 0n) return "0x";
  return encodeAbiParameters([{ type: "address" }], [getAddress(referrer)]);
}

/** The pool's quote token: whichever currency the coin is not. */
export function quoteOfKey(key: PoolKey, coin: Address): Address {
  return key.currency0.toLowerCase() === coin.toLowerCase() ? key.currency1 : key.currency0;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type TradePlan = {
  wrappedNative: Address;
  quote: Address;
  coin: Address;
  /** Wrapped native → quote on a buy, quote → wrapped native on a sale; empty for a WBNB pool. */
  hops: readonly Hop[];
  poolKey: PoolKey;
  amountIn: bigint;
  minOut: bigint;
  hookData: Hex;
  /** Native through the hops (absent), or the quote token from/to the caller through Permit2. */
  payIn?: "native" | "quote";
  permit?: { permit: PermitSingle; signature: Hex } | null;
};

/**
 * A BUY. Native in, the coin out, to the caller:
 *
 *   WRAP_ETH(router, amount)
 *   [V3_SWAP_EXACT_IN(router, all of it, 0, wrapped native → … → quote, router pays)]
 *   INFI_SWAP[ SETTLE(quote, all of it, router pays)
 *              CL_SWAP_EXACT_IN_SINGLE(the Feast pool, the open delta, minOut, hookData)
 *              TAKE_ALL(coin, minOut) ]
 *
 * PAID IN THE QUOTE, the same lock with the first half taken away: the caller's
 * quote token is settled through Permit2 for exactly the amount, no wrap, no hop,
 * no `value`.
 */
export function buyCommands(plan: TradePlan): Command[] {
  if (plan.payIn === "quote") {
    const steps: Command[] = [];
    if (plan.permit) steps.push({ command: "PERMIT2_PERMIT", ...plan.permit });
    steps.push({ command: "INFI_SWAP", actions: feastBuy(plan, { amount: plan.amountIn, payerIsUser: true }) });
    return steps;
  }
  const steps: Command[] = [{ command: "WRAP_ETH", recipient: ADDRESS_THIS, amount: plan.amountIn }];
  if (plan.hops.length > 0) {
    steps.push({
      command: "V3_SWAP_EXACT_IN",
      recipient: ADDRESS_THIS,
      amountIn: CONTRACT_BALANCE,
      amountOutMin: 0n,
      path: v3Path(plan.wrappedNative, plan.hops),
      payerIsUser: false,
    });
  }
  steps.push({ command: "INFI_SWAP", actions: feastBuy(plan, { amount: CONTRACT_BALANCE, payerIsUser: false }) });
  return steps;
}

function feastBuy(plan: TradePlan, settle: { amount: bigint; payerIsUser: boolean }): Action[] {
  return [
    { action: "SETTLE", currency: plan.quote, amount: settle.amount, payerIsUser: settle.payerIsUser },
    {
      action: "CL_SWAP_EXACT_IN_SINGLE",
      poolKey: plan.poolKey,
      zeroForOne: same(plan.quote, plan.poolKey.currency0),
      amountIn: OPEN_DELTA,
      amountOutMinimum: plan.minOut,
      hookData: plan.hookData,
    },
    { action: "TAKE_ALL", currency: plan.coin, minAmount: plan.minOut },
  ];
}

/**
 * A SALE. The coin in, from the caller through Permit2, native out, to the caller:
 *
 *   [PERMIT2_PERMIT(permit, signature)]
 *   INFI_SWAP[ CL_SWAP_EXACT_IN_SINGLE(the Feast pool, amount, minOut when no hops, hookData)
 *              SETTLE_ALL(coin, amount)
 *              TAKE(quote, router, the open delta) ]
 *   [V3_SWAP_EXACT_IN(router, all of it, 0, quote → … → wrapped native, router pays)]
 *   UNWRAP_WETH(caller, minOut)
 *
 * The floor is in native, so it is checked where the native is paid out.
 */
export function sellCommands(plan: TradePlan): Command[] {
  const steps: Command[] = [];
  if (plan.permit) steps.push({ command: "PERMIT2_PERMIT", ...plan.permit });
  if (plan.payIn === "quote") {
    steps.push({
      command: "INFI_SWAP",
      actions: [
        {
          action: "CL_SWAP_EXACT_IN_SINGLE",
          poolKey: plan.poolKey,
          zeroForOne: same(plan.coin, plan.poolKey.currency0),
          amountIn: plan.amountIn,
          amountOutMinimum: plan.minOut,
          hookData: plan.hookData,
        },
        { action: "SETTLE_ALL", currency: plan.coin, maxAmount: plan.amountIn },
        { action: "TAKE_ALL", currency: plan.quote, minAmount: plan.minOut },
      ],
    });
    return steps;
  }
  steps.push({
    command: "INFI_SWAP",
    actions: [
      {
        action: "CL_SWAP_EXACT_IN_SINGLE",
        poolKey: plan.poolKey,
        zeroForOne: same(plan.coin, plan.poolKey.currency0),
        amountIn: plan.amountIn,
        amountOutMinimum: plan.hops.length > 0 ? 0n : plan.minOut,
        hookData: plan.hookData,
      },
      { action: "SETTLE_ALL", currency: plan.coin, maxAmount: plan.amountIn },
      { action: "TAKE", currency: plan.quote, recipient: ADDRESS_THIS, amount: OPEN_DELTA },
    ],
  });
  if (plan.hops.length > 0) {
    steps.push({
      command: "V3_SWAP_EXACT_IN",
      recipient: ADDRESS_THIS,
      amountIn: CONTRACT_BALANCE,
      amountOutMin: 0n,
      path: v3Path(plan.quote, plan.hops),
      payerIsUser: false,
    });
  }
  steps.push({ command: "UNWRAP_WETH", recipient: MSG_SENDER, amountMin: plan.minOut });
  return steps;
}

/** The buy as a transaction to the router: native `value` unless it is paid in the quote. */
export function buyCall(router: Address, plan: TradePlan, deadline: bigint): Call {
  return { to: router, data: encodeExecute(buyCommands(plan), deadline), value: plan.payIn === "quote" ? 0n : plan.amountIn };
}

/** The sale as a transaction to the router. */
export function sellCall(router: Address, plan: TradePlan, deadline: bigint): Call {
  return { to: router, data: encodeExecute(sellCommands(plan), deadline), value: 0n };
}

/** `token.approve(spender, amount)`: once per token, so Permit2 may move it (the site does the same). */
export function approveCall(token: Address, spender: Address, amount: bigint = maxUint256): Call {
  return { to: token, data: encodeFunctionData({ abi: coinAbi, functionName: "approve", args: [spender, amount] }), value: 0n };
}

/**
 * `Permit2.approve(token, spender, amount, expiration)`: the router's allowance,
 * granted on chain. It stands in for the site's EIP-712 permit signature, so a
 * later sale is one plain transaction.
 */
export function permit2ApproveCall(permit2: Address, token: Address, spender: Address, amount: bigint, expiration: bigint): Call {
  if (amount < 0n || amount > MAX_UINT160) throw new RangeError("a Permit2 allowance is a uint160");
  if (expiration < 0n || expiration >= 1n << 48n) throw new RangeError("a Permit2 expiration is a uint48");
  return {
    to: permit2,
    data: encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, spender, amount, Number(expiration)] }),
    value: 0n,
  };
}

/** `FeastHook.claimCreator(key)`: pays the pool's creator what it owes, in the pool's quote token. Callable by anyone. */
export function claimCreatorCall(hook: Address, key: PoolKey): Call {
  return { to: hook, data: encodeFunctionData({ abi: hookAbi, functionName: "claimCreator", args: [key] }), value: 0n };
}
