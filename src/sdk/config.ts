import { defineChain, type Chain } from "viem";
import { bsc } from "viem/chains";

import { FeastError } from "./errors.ts";
import { NETWORKS, type FeastNetwork, type NetworkName } from "./networks.ts";

/**
 * `FEAST_NETWORK=sandbox|mainnet` (default `sandbox`), with an optional
 * `FEAST_RPC_URL` override for a private endpoint. Never print the resolved URL:
 * a private endpoint usually carries its key in the path.
 */
export function networkFromEnv(env: Record<string, string | undefined> = process.env): FeastNetwork {
  const raw = (env.FEAST_NETWORK ?? "sandbox").trim().toLowerCase() || "sandbox";
  if (raw !== "sandbox" && raw !== "mainnet") {
    throw new FeastError(`FEAST_NETWORK must be "sandbox" or "mainnet", not "${raw}"`, "bad_network");
  }
  const base = NETWORKS[raw as NetworkName];
  const rpc = env.FEAST_RPC_URL?.trim();
  return rpc ? { ...base, rpcUrl: rpc } : base;
}

/** The viem chain for a network. */
export function chainOf(network: FeastNetwork): Chain {
  if (network.chainId === 56) {
    return { ...bsc, rpcUrls: { default: { http: [network.rpcUrl] } } };
  }
  return defineChain({
    id: network.chainId,
    name: network.chainName,
    nativeCurrency: { name: "Test BNB", symbol: network.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    testnet: true,
  });
}
