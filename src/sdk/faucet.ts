import type { Address } from "viem";

import { FeastError } from "./errors.ts";
import type { FeastNetwork } from "./networks.ts";

export type FaucetDrip = { address: Address; added: bigint; balance: bigint };

/**
 * Ask the sandbox faucet for test BNB: 100 tBNB a drip, three drips an hour per
 * address, and it stops topping up at 1,000 tBNB. No signature is needed.
 */
export async function requestFaucet(network: FeastNetwork, address: Address, fetchImpl: typeof fetch = fetch): Promise<FaucetDrip> {
  if (!network.faucetUrl) {
    throw new FeastError(`${network.chainName} has no faucet: it is real money.`, "no_faucet");
  }
  const response = await fetchImpl(network.faucetUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const text = await response.text();
  let payload: { ok?: boolean; added?: string; balance?: string; error?: string } = {};
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    // quoted below
  }
  if (!response.ok || payload.ok !== true || payload.added === undefined || payload.balance === undefined) {
    throw new FeastError(
      `the faucet refused (HTTP ${response.status}): ${payload.error ?? text.slice(0, 200)}`,
      response.status === 429 ? "faucet_rate_limited" : response.status === 409 ? "faucet_refused" : "faucet_failed",
      { status: response.status },
    );
  }
  return { address, added: BigInt(payload.added), balance: BigInt(payload.balance) };
}
