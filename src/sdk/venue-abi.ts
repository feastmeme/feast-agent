/**
 * The venue's contracts on BNB Smart Chain, as far as a mainnet trade calls them:
 * PancakeSwap Infinity's Universal Router, its Permit2 and its MixedQuoter, and
 * the wrapped native asset's two events.
 *
 * Hand-written fragments, unlike `abi.ts` (which is generated from the Feast
 * contracts): the functions a trade calls, and every error the path can be
 * refused with, the same set the feast.meme site decodes.
 */

const error = (name: string, types: readonly string[] = []) =>
  ({ type: "error", name, inputs: types.map((type, index) => ({ name: `arg${index}`, type })) }) as const;

/** `execute(bytes commands, bytes[] inputs, uint256 deadline)` and the router's own refusals. */
export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  error("ExecutionFailed", ["uint256", "bytes"]),
  error("TransactionDeadlinePassed"),
  error("LengthMismatch"),
  error("ETHNotAccepted"),
  error("InvalidEthSender"),
  error("InvalidCommandType", ["uint256"]),
  error("InsufficientToken"),
  error("InsufficientETH"),
  error("FromAddressIsNotOwner"),
  error("V3InvalidSwap"),
  error("V3TooLittleReceived"),
  error("V3TooMuchRequested"),
  error("V3InvalidAmountOut"),
  error("V3InvalidCaller"),
  error("TooLittleReceived", ["uint256", "uint256"]),
  error("TooMuchRequested", ["uint256", "uint256"]),
  error("ExactOutputUnfilled", ["uint256", "uint256"]),
  error("DeltaNotPositive", ["address"]),
  error("DeltaNotNegative", ["address"]),
  error("InsufficientBalance"),
  error("InputLengthMismatch"),
  error("UnsupportedAction", ["uint256"]),
  error("ContractLocked"),
  error("NotVault"),
  error("EnforcedPause"),
] as const;

/** Permit2: the allowance a sale needs, the on-chain `approve` that grants it, and every refusal of `transferFrom`. */
export const permit2Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  error("AllowanceExpired", ["uint256"]),
  error("InsufficientAllowance", ["uint256"]),
  error("ExcessiveInvalidation"),
  error("InvalidAmount", ["uint256"]),
  error("InvalidNonce"),
  error("SignatureExpired", ["uint256"]),
  error("InvalidSignature"),
  error("InvalidSignatureLength"),
  error("InvalidSigner"),
  error("InvalidContractSignature"),
] as const;

/** The MixedQuoter. Not a view: it quotes by simulating and reverting, so it is only ever simulated. */
export const mixedQuoterAbi = [
  {
    type: "function",
    name: "quoteMixedExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paths", type: "address[]" },
      { name: "actions", type: "bytes" },
      { name: "params", type: "bytes[]" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  error("UnexpectedRevertBytes", ["bytes"]),
  error("NotEnoughLiquidity", ["bytes32"]),
  error("NotSelf"),
  error("UnexpectedCallSuccess"),
  error("INVALID_ADDRESS"),
  error("InputLengthMismatch"),
  error("InvalidPath"),
  error("InvalidPoolKeyCurrency"),
  error("NoActions"),
  error("UnsupportedAction", ["uint256"]),
] as const;

/** WBNB's two events: the native leg of a trade through the router, read off the receipt. */
export const wrappedNativeAbi = [
  {
    type: "event",
    name: "Deposit",
    anonymous: false,
    inputs: [
      { name: "dst", type: "address", indexed: true },
      { name: "wad", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawal",
    anonymous: false,
    inputs: [
      { name: "src", type: "address", indexed: true },
      { name: "wad", type: "uint256", indexed: false },
    ],
  },
] as const;

/** The venue's errors, for decoding a refusal anywhere on the path. */
export const venueRefusalsAbi = [...universalRouterAbi, ...permit2Abi, ...mixedQuoterAbi].filter(
  (entry) => entry.type === "error",
);
