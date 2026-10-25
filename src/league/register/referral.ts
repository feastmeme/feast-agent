import { getAddress, isAddress, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";

import { withHostHeaders } from "../headers.ts";

/**
 * The referral binding (task 975, run 17; the coordinator's decision 3: a referral must pay, not only be recorded).
 * A tutorial's referrer earns its share of a wallet's trades only once the wallet is bound to it in the
 * `FeastReferrals` registry, the way the site's web flow binds it: the wallet signs the free EIP-712 message
 * `Bind(wallet, referrer, deadline)` and the site's `/api/v1/referral/bind` keeps it for the keeper, which relays
 * `bindWithSig` on chain and pays the gas. Nothing here sends a transaction.
 *
 * The wire is the site's (`src/lib/referral/bind-typed-data.ts`, `bind-request.ts`, read on the deploy tree at
 * 63d7d3aa): domain FeastReferrals / 1 / 56 / the registry, the three fields in that order, a deadline seven days
 * ahead. One byte different and the signature binds nothing, so the test pins it field by field.
 *
 * Never silent: the player says yes to its own card first (`FL enter`). Never again: a wallet the registry has bound
 * (to anyone) is never asked, and the registry itself refuses a second binding (`AlreadyBound`).
 */

/** `FeastReferrals` on BNB Smart Chain, from the site's mainnet address book (`sandbox/mainnet/addresses.json`). */
export const REFERRALS_REGISTRY: Address = "0x01bc8640af92f4E556cB38644bC3DA5f41f253a4";
export const REFERRALS_CHAIN_ID = 56;
/** How long a signature lives (the site's `BIND_TTL_SECONDS`, the owner's ruling of 2026-10-10): the keeper relays within it. */
export const BIND_TTL_SECONDS = 7 * 24 * 3_600;

export type BindFields = { wallet: Address; referrer: Address; deadline: bigint };

export const BIND_TYPES = {
  Bind: [
    { name: "wallet", type: "address" },
    { name: "referrer", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const bindDomain = { name: "FeastReferrals", version: "1", chainId: REFERRALS_CHAIN_ID, verifyingContract: REFERRALS_REGISTRY } as const;

export function bindDeadline(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1_000) + BIND_TTL_SECONDS);
}

/** The typed data as `eth_signTypedData_v4` takes it (the deadline as a decimal string, as JSON can carry it). */
export function bindTypedDataJson(f: BindFields): string {
  return JSON.stringify({
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...BIND_TYPES },
    primaryType: "Bind",
    domain: bindDomain,
    message: { wallet: getAddress(f.wallet), referrer: getAddress(f.referrer), deadline: f.deadline.toString() },
  });
}

/** The wallet's sign request: the message is built here from the fields, never taken raw. */
export function bindSignRequest(f: BindFields): string {
  return JSON.stringify({ method: "eth_signTypedData_v4", params: [getAddress(f.wallet), bindTypedDataJson(f)] });
}

/** The wallet's preview reads back exactly these three fields, as a Bind on the registry's domain. */
export function bindPreviewDescribes(parsed: unknown, f: BindFields): { ok: true } | { ok: false; reason: string } {
  const p = (parsed ?? {}) as Record<string, unknown>;
  if (p.messageType !== "SignTypedData") return { ok: false, reason: `the wallet reads it as ${String(p.messageType ?? "nothing")}, not typed data` };
  if (p.version !== undefined && p.version !== "V4") return { ok: false, reason: `the wallet reads it as typed data ${String(p.version)}, not V4` };
  if (typeof p.preCheckCode === "string" && p.preCheckCode !== "") return { ok: false, reason: `the wallet's pre-check said ${p.preCheckCode}` };
  let typed: unknown = p.message;
  if (typeof typed === "string") {
    try {
      typed = JSON.parse(typed);
    } catch {
      return { ok: false, reason: "the wallet's reading of the message is not JSON" };
    }
  }
  if (typeof typed !== "object" || typed === null) return { ok: false, reason: "the wallet's reading has no message" };
  const t = typed as { domain?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, unknown> } & Record<string, unknown>;
  if (t.domain !== undefined) {
    const d = t.domain;
    if (d.name !== bindDomain.name || String(d.version) !== bindDomain.version || Number(d.chainId) !== REFERRALS_CHAIN_ID || String(d.verifyingContract ?? "").toLowerCase() !== REFERRALS_REGISTRY.toLowerCase()) return { ok: false, reason: "the domain is not FeastReferrals / 1 / 56 / the registry" };
  }
  if (t.primaryType !== undefined && t.primaryType !== "Bind") return { ok: false, reason: `the message type is ${String(t.primaryType)}` };
  const m = (t.message ?? t) as Record<string, unknown>;
  const keys = Object.keys(m).sort().join(",");
  const same = keys === "deadline,referrer,wallet" && String(m.wallet).toLowerCase() === f.wallet.toLowerCase() && String(m.referrer).toLowerCase() === f.referrer.toLowerCase() && String(m.deadline) === f.deadline.toString();
  return same ? { ok: true } : { ok: false, reason: "the wallet's reading is not this Bind (its wallet, referrer or deadline differ)" };
}

/** The self-check before anything is sent: the signature recovers this wallet over exactly this Bind. */
export async function bindSignatureRecovers(f: BindFields, signature: Hex): Promise<boolean> {
  try {
    return await verifyTypedData({ address: getAddress(f.wallet), domain: bindDomain, types: BIND_TYPES, primaryType: "Bind", message: { wallet: getAddress(f.wallet), referrer: getAddress(f.referrer), deadline: f.deadline }, signature });
  } catch {
    return false;
  }
}

// --- the site and the chain ------------------------------------------------------------------------------------

export type Resolved = { kind: "address"; referrer: Address } | { kind: "unknown" } | { kind: "unreadable"; reason: string };
export type BindAnswer = { kind: "kept"; status: string } | { kind: "already-bound" } | { kind: "refused"; status: number; code: string | null; name: string | null } | { kind: "unreadable"; reason: string };

/** The site's referral doors, and the registry's one read, as `FL enter` uses them. */
export type ReferralDeps = {
  /** A code's referrer (`GET /api/v1/referral/resolve?code=`); an address is its own. */
  resolve(ref: string): Promise<Resolved>;
  /** The wallet's referrer on chain: null when none (the zero address); "unreadable" when the chain did not answer. */
  referrerOf(wallet: Address): Promise<Address | null | "unreadable">;
  /** `POST /api/v1/referral/bind`, the signed binding for the keeper. */
  submit(body: { wallet: string; referrer: string; deadline: string; signature: Hex; chainId: number }): Promise<BindAnswer>;
};

type Reader = { readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<unknown> };
const referrerOfAbi = [{ type: "function", name: "referrerOf", stateMutability: "view", inputs: [{ name: "wallet", type: "address" }], outputs: [{ name: "referrer", type: "address" }] }] as const;

/** The real doors: feast.meme (with the runtime's two headers, nothing else of the player) and the chain's one view. */
export function referralDeps(o: { site: string; fetch: typeof fetch; client: Reader; timeoutMs?: number }): ReferralDeps {
  const base = o.site.replace(/\/+$/, "");
  const f = withHostHeaders(o.fetch, [base]);
  const timeout = o.timeoutMs ?? 15_000;
  return {
    async resolve(ref) {
      if (isAddress(ref, { strict: false })) return { kind: "address", referrer: getAddress(ref) };
      try {
        const r = await f(`${base}/api/v1/referral/resolve?code=${encodeURIComponent(ref)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
        if (r.status === 404) return { kind: "unknown" };
        if (r.status !== 200) return { kind: "unreadable", reason: `HTTP ${r.status}` };
        const body = (await r.json()) as { referrer?: unknown };
        return typeof body.referrer === "string" && isAddress(body.referrer, { strict: false }) ? { kind: "address", referrer: getAddress(body.referrer) } : { kind: "unreadable", reason: "the answer names no referrer" };
      } catch (error) {
        return { kind: "unreadable", reason: (error as Error).name === "TimeoutError" ? "no answer in time" : "no answer" };
      }
    },
    async referrerOf(wallet) {
      try {
        const got = (await o.client.readContract({ address: REFERRALS_REGISTRY, abi: referrerOfAbi, functionName: "referrerOf", args: [wallet] })) as Address;
        return got.toLowerCase() === zeroAddress ? null : getAddress(got);
      } catch {
        return "unreadable";
      }
    },
    async submit(body) {
      try {
        const r = await f(`${base}/api/v1/referral/bind`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        const parsed = (await r.json().catch(() => null)) as { status?: unknown; error?: { code?: unknown; refusal?: unknown } } | null;
        if (r.status === 200) return { kind: "kept", status: typeof parsed?.status === "string" ? parsed.status : "pending" };
        const name = typeof parsed?.error?.refusal === "string" ? parsed.error.refusal : null;
        if (r.status === 409 && (name === "AlreadyBound" || name === null)) return { kind: "already-bound" };
        return { kind: "refused", status: r.status, code: typeof parsed?.error?.code === "string" ? parsed.error.code : null, name };
      } catch (error) {
        return { kind: "unreadable", reason: (error as Error).name === "TimeoutError" ? "no answer in time" : "no answer" };
      }
    },
  };
}
