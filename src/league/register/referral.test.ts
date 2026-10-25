import { hashTypedData, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { BAW_ALLOWLIST } from "../baw.ts";
import { BIND_TTL_SECONDS, bindDeadline, bindPreviewDescribes, bindSignRequest, bindTypedDataJson, REFERRALS_REGISTRY, referralDeps } from "./referral.ts";

/**
 * Task 975, run 17: the referral binding's wire, held to the site's and the contracts' own vector
 * (`src/lib/referral/bind-typed-data.test.ts` on the deploy tree: the contracts repository's `docs/interface.md`).
 */

// The contracts' vector: test keys 1 and 2 as wallet and referrer, a registry of its own, chain 56.
const VECTOR = {
  registry: "0x00000000000000000000000000000000000fea57" as Address,
  wallet: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address,
  referrer: "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF" as Address,
  deadline: 1_800_000_000n,
  digest: "0x9a7ee5d3d9bb3b5b5c998dc01464bb5807bad490b34a9e95f190f7df3bea948b",
};

describe("the Bind message", () => {
  it("hashes to the contracts' digest on their registry: domain, type and fields byte for byte", () => {
    const typed = JSON.parse(bindTypedDataJson({ wallet: VECTOR.wallet, referrer: VECTOR.referrer, deadline: VECTOR.deadline })) as { types: Record<string, { name: string; type: string }[]>; primaryType: "Bind"; domain: Record<string, unknown>; message: Record<string, unknown> };
    expect(typed.domain).toEqual({ name: "FeastReferrals", version: "1", chainId: 56, verifyingContract: REFERRALS_REGISTRY });
    const { EIP712Domain: _, ...types } = typed.types;
    const args = { domain: { ...typed.domain, verifyingContract: VECTOR.registry }, types, primaryType: "Bind", message: { ...typed.message, deadline: BigInt(String(typed.message.deadline)) } };
    const digest = hashTypedData(args as unknown as Parameters<typeof hashTypedData>[0]);
    expect(digest).toBe(VECTOR.digest);
  });

  it("the sign request is eth_signTypedData_v4 for the wallet; the deadline is seven days ahead", () => {
    const req = JSON.parse(bindSignRequest({ wallet: VECTOR.wallet, referrer: VECTOR.referrer, deadline: 1n })) as { method: string; params: [string, string] };
    expect(req.method).toBe("eth_signTypedData_v4");
    expect(req.params[0]).toBe(VECTOR.wallet);
    expect(bindDeadline(Date.parse("2026-10-26T00:00:00Z"))).toBe(BigInt(Date.parse("2026-10-26T00:00:00Z") / 1_000 + BIND_TTL_SECONDS));
    expect(BIND_TTL_SECONDS).toBe(604_800);
  });

  it("the wallet's preview must read back exactly this Bind on this domain", () => {
    const f = { wallet: VECTOR.wallet, referrer: VECTOR.referrer, deadline: VECTOR.deadline };
    const read = (message: unknown) => ({ messageType: "SignTypedData", version: "V4", preCheckCode: "", message: JSON.stringify(message) });
    const typed = JSON.parse(bindTypedDataJson(f));
    expect(bindPreviewDescribes(read(typed), f)).toEqual({ ok: true });
    expect(bindPreviewDescribes(read(typed.message), f)).toEqual({ ok: true });
    expect(bindPreviewDescribes(read({ ...typed, message: { ...typed.message, referrer: VECTOR.wallet } }), f).ok).toBe(false);
    expect(bindPreviewDescribes(read({ ...typed, domain: { ...typed.domain, verifyingContract: VECTOR.registry } }), f).ok).toBe(false);
    expect(bindPreviewDescribes(read({ ...typed, primaryType: "Register" }), f).ok).toBe(false);
    expect(bindPreviewDescribes({ ...read(typed), preCheckCode: "RISK" }, f).ok).toBe(false);
  });

  it("the wallet's allowlist is what it was: the binding is the same sign-message preview and execute", () => {
    expect(BAW_ALLOWLIST).toEqual(["wallet status", "wallet address", "wallet settings", "wallet tx-lock", "wallet balance", "contract-call preview", "contract-call execute", "sign-message preview", "sign-message execute", "sign-message result"]);
  });
});

describe("the doors", () => {
  const SITE = "https://feast.test";
  function deps(answer: (url: string, init?: RequestInit) => Response, read: () => Promise<unknown> = async () => "0x0000000000000000000000000000000000000000") {
    const asked: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => (asked.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : null }), answer(url, init))) as unknown as typeof fetch;
    return { asked, d: referralDeps({ site: SITE, fetch: fetchImpl, client: { readContract: read } }) };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("resolve: a code through /api/v1/referral/resolve, an address as itself, a 404 as nobody", async () => {
    const ok = deps(() => json(200, { code: "H7KMQ2", referrer: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf" }));
    expect(await ok.d.resolve("H7KMQ2")).toEqual({ kind: "address", referrer: VECTOR.referrer });
    expect(ok.asked[0]!.url).toBe(`${SITE}/api/v1/referral/resolve?code=H7KMQ2`);
    expect(ok.asked[0]!.headers["x-feast-runtime"]).toBeDefined();
    expect(await ok.d.resolve(VECTOR.referrer.toLowerCase())).toEqual({ kind: "address", referrer: VECTOR.referrer });
    expect(await deps(() => json(404, { error: { code: "not-found" } })).d.resolve("ZZZZZZ")).toEqual({ kind: "unknown" });
  });

  it("referrerOf: the zero address is none, another is bound, a failed read is unreadable", async () => {
    expect(await deps(() => json(200, {})).d.referrerOf(VECTOR.wallet)).toBeNull();
    expect(await deps(() => json(200, {}), async () => VECTOR.referrer).d.referrerOf(VECTOR.wallet)).toBe(VECTOR.referrer);
    expect(await deps(() => json(200, {}), async () => { throw new Error("rpc down"); }).d.referrerOf(VECTOR.wallet)).toBe("unreadable");
  });

  it("submit: the site's five fields; kept, already bound, refused by the registry's name", async () => {
    const body = { wallet: VECTOR.wallet.toLowerCase(), referrer: VECTOR.referrer.toLowerCase(), deadline: "1800000000", signature: "0x00" as const, chainId: 56 };
    const kept = deps(() => json(200, { chainId: 56, status: "pending" }));
    expect(await kept.d.submit(body)).toEqual({ kind: "kept", status: "pending" });
    expect(kept.asked[0]).toMatchObject({ url: `${SITE}/api/v1/referral/bind`, body });
    expect(await deps(() => json(409, { error: { code: "refused", refusal: "AlreadyBound" } })).d.submit(body)).toEqual({ kind: "already-bound" });
    expect(await deps(() => json(400, { error: { code: "refused", refusal: "SelfReferral" } })).d.submit(body)).toEqual({ kind: "refused", status: 400, code: "refused", name: "SelfReferral" });
  });
});
