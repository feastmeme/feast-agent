import { decodeFunctionData, getAddress, toFunctionSelector, type Address, type Hex } from "viem";

import { coinAbi, factoryAbi, hookAbi } from "../sdk/abi.ts";
import type { Call } from "../sdk/infinity.ts";
import { permit2Abi, universalRouterAbi } from "../sdk/venue-abi.ts";
import { redactAddresses } from "./baw.ts";

/**
 * The gate between a preview and an execute (PLAN.md §2.5 step 4), and the call
 * allowlist that runs before any preview at all.
 *
 * A call is executed only if the wallet's own simulation passed, its risk check
 * listed nothing, no address in it is flagged, it needs no confirmation in the
 * App, the preview has not expired — and the call is one of the handful this
 * runtime builds, to one of our contracts. Anything else is a failure in the
 * preview's own words, and nothing is sent.
 */

export type PreviewSummary = {
  success: boolean;
  requestId: string | null;
  simulationCode: string | null;
  simulationError: string | null;
  risks: string[];
  flaggedAddresses: number;
  riskBehaviors: number;
  requireConfirmation: boolean | null;
  /** Epoch ms. */
  expiresAt: number | null;
  transactionType: string | null;
  error: string | null;
};

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function summarizePreview(answer: unknown): PreviewSummary {
  const envelope = asRecord(answer);
  const data = asRecord(envelope.data);
  const sim = asRecord(data.simulationResult);
  const risks = asRecord(data.risks);
  const details = Array.isArray(risks.riskDetails) ? risks.riskDetails : [];
  const addresses = asRecord(risks.addresses);
  const flagged = Object.values(addresses).filter((entry) => {
    const e = asRecord(entry);
    const list = Array.isArray(e.riskDetails) ? e.riskDetails : [];
    return list.length > 0 || (typeof e.riskLevel === "number" && e.riskLevel >= 3);
  }).length;
  const error = asRecord(envelope.error);
  const errorText = envelope.error ? redactAddresses(`${String(error.name ?? "error")} ${String(error.code ?? "")}: ${String(error.message ?? "")}`.trim()) : null;
  const expires = typeof data.expiresAt === "number" ? data.expiresAt : null;
  return {
    success: envelope.success === true && !envelope.error,
    requestId: typeof data.requestId === "string" && data.requestId ? data.requestId : null,
    simulationCode: typeof sim.simulationCode === "string" ? sim.simulationCode : null,
    simulationError: sim.simulationErrorDetail ? redactAddresses(String(typeof sim.simulationErrorDetail === "string" ? sim.simulationErrorDetail : JSON.stringify(sim.simulationErrorDetail))) : null,
    risks: details.map((d) => redactAddresses(String(asRecord(d).title ?? asRecord(d).code ?? "risk"))),
    flaggedAddresses: flagged,
    riskBehaviors: Array.isArray(risks.riskBehaviors) ? risks.riskBehaviors.length : 0,
    requireConfirmation: typeof data.requireConfirmation === "boolean" ? data.requireConfirmation : null,
    expiresAt: expires === null ? null : expires < 1e12 ? expires * 1_000 : expires,
    transactionType: typeof asRecord(data.parsedTx).transactionType === "string" ? (asRecord(data.parsedTx).transactionType as string) : null,
    error: errorText,
  };
}

/** Execute only if every condition holds; else the reason, in the preview's own words. */
export function gatePreview(s: PreviewSummary, now: number): { ok: true } | { ok: false; reason: string } {
  if (!s.success) return { ok: false, reason: `the wallet refused the preview: ${s.error ?? "no reason given"}` };
  if (!s.requestId) return { ok: false, reason: "the preview returned no request id" };
  if (s.simulationCode !== "000000000" || s.simulationError) {
    return { ok: false, reason: `the wallet's simulation failed (code ${s.simulationCode ?? "none"}${s.simulationError ? `: ${s.simulationError}` : ""})` };
  }
  if (s.risks.length > 0) return { ok: false, reason: `the wallet's risk check listed: ${s.risks.join("; ")}` };
  if (s.flaggedAddresses > 0) return { ok: false, reason: `the wallet flags ${s.flaggedAddresses} address(es) in the call` };
  if (s.riskBehaviors > 0) return { ok: false, reason: `the wallet lists ${s.riskBehaviors} risk behaviour(s)` };
  if (s.requireConfirmation !== false) return { ok: false, reason: "the call would need a confirmation in the Binance App" };
  if (s.expiresAt !== null && s.expiresAt <= now) return { ok: false, reason: "the preview has expired" };
  return { ok: true };
}

// --- the call allowlist -------------------------------------------------------------------

export type Targets = {
  router: Address;
  factory: Address;
  hook: Address;
  permit2: Address;
  /** A token Permit2 may be approved for: a Feast coin the factory made, or a pool's quote token. */
  approvable: (token: Address) => boolean;
};

const SELECTOR = {
  execute: toFunctionSelector("execute(bytes,bytes[],uint256)"),
  create: toFunctionSelector(factoryAbi.find((e) => e.type === "function" && e.name === "create") as never),
  claimCreator: toFunctionSelector(hookAbi.find((e) => e.type === "function" && e.name === "claimCreator") as never),
  approve: toFunctionSelector("approve(address,uint256)"),
  permit2Approve: toFunctionSelector("approve(address,address,uint160,uint48)"),
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Null when the call is one this runtime builds to one of our contracts; else why it is refused (L15). */
export function callRefusal(call: Call, t: Targets): string | null {
  const selector = call.data.slice(0, 10).toLowerCase() as Hex;
  if (same(call.to, t.router)) {
    if (selector !== SELECTOR.execute) return "the router may only be called with execute";
    try {
      decodeFunctionData({ abi: universalRouterAbi, data: call.data });
    } catch {
      return "the router call does not decode";
    }
    return null;
  }
  if (call.value !== 0n) return "only a buy through the router may carry BNB";
  if (same(call.to, t.factory)) return selector === SELECTOR.create ? null : "the factory may only be called with create";
  if (same(call.to, t.hook)) return selector === SELECTOR.claimCreator ? null : "the hook may only be called with claimCreator";
  if (same(call.to, t.permit2)) {
    if (selector !== SELECTOR.permit2Approve) return "Permit2 may only be called with approve";
    const { args } = decodeFunctionData({ abi: permit2Abi, data: call.data });
    const [token, spender] = args as readonly [Address, Address, bigint, number];
    if (!same(spender, t.router)) return "Permit2 may only approve the router";
    if (!t.approvable(getAddress(token))) return "Permit2 may only approve a Feast coin or a pool's quote token";
    return null;
  }
  if (t.approvable(getAddress(call.to))) {
    if (selector !== SELECTOR.approve) return "a token may only be called with approve";
    const { args } = decodeFunctionData({ abi: coinAbi, data: call.data });
    const [spender] = args as readonly [Address, bigint];
    return same(spender, t.permit2) ? null : "a token may only approve Permit2";
  }
  return `${call.to} is not a contract the league calls`;
}
