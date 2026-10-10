import { encodeAbiParameters, keccak256, parseSignature, type Address, type Hex } from "viem";

/**
 * A sale in one signature and one transaction.
 *
 * Every Feast coin is an EIP-2612 permit token, so a sale through the sandbox
 * router needs no approval transaction: the seller signs a permit off chain and
 * `sellWithPermit` spends it in the same call. To QUOTE a sale before anything is
 * signed, the allowance the permit would grant is written into the simulation
 * with a state override at its storage slot.
 */

/** OpenZeppelin v5 `ERC20`: `_balances` is slot 0, `_allowances` slot 1. */
const ALLOWANCES_SLOT = 1n;

/** The storage slot of `allowance(owner, spender)` on a Feast coin. */
export function allowanceSlot(owner: Address, spender: Address): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, ALLOWANCES_SLOT]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

export function uint256Word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The EIP-712 payload a wallet signs. A coin's permit domain is its own name, version "1". */
export function permitTypedData(input: {
  coin: Address;
  coinName: string;
  chainId: number;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: { name: input.coinName, version: "1", chainId: input.chainId, verifyingContract: input.coin },
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: {
      owner: input.owner,
      spender: input.spender,
      value: input.value,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  };
}

/** `v, r, s` as `sellWithPermit` takes them. */
export function splitPermitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const parsed = parseSignature(signature);
  const v = parsed.v !== undefined ? Number(parsed.v) : 27 + (parsed.yParity ?? 0);
  return { v, r: parsed.r, s: parsed.s };
}
