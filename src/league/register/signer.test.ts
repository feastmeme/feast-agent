import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { BawSigner } from "../baw.ts";
import { fakeBaw } from "./fakes.ts";

const fields = (wallet: `0x${string}`) => ({ wallet, name: "maplegrin", strategy: "preview-check", issuedAt: 1792675500 });

describe("the signer's one signing path (PLAN-941 §5.3)", () => {
  it("executes only its own Register preview's request id, once", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { runner, calls } = fakeBaw({ account });
    const signer = new BawSigner(runner);
    // A preview made through the raw preview method can never be executed.
    await signer.signMessagePreview("{}");
    await expect(signer.call("sign-message execute", ["--requestId", "req-1"])).rejects.toMatchObject({ errorName: "NOT_ALLOWED" });
    const signed = await signer.signRegistration(fields(account.address));
    expect(signed.kind).toBe("signed");
    // The request id it executed is spent.
    const executed = calls.find((c) => c[1] === "execute")!;
    await expect(signer.call("sign-message execute", ["--requestId", executed[executed.indexOf("--requestId") + 1]!])).rejects.toMatchObject({ errorName: "NOT_ALLOWED" });
  });

  it("refuses an execute after the preview's ten minutes", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    let now = 1_000_000;
    const { runner } = fakeBaw({ account, tamper: true });
    const signer = new BawSigner(runner, () => {}, "56", () => now);
    // A tampered preview is never registered for execution at all.
    expect((await signer.signRegistration(fields(account.address))).kind).toBe("mismatch");
    await expect(signer.call("sign-message execute", ["--requestId", "req-1"])).rejects.toMatchObject({ errorName: "NOT_ALLOWED" });
    now += 1;
  });

  it("asks for the App's result every poll until the wait runs out, then says it expired", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    let now = 0;
    const { runner, calls } = fakeBaw({ account, confirm: { kind: "app", polls: 1, then: "PENDING_CONFIRMATION" } });
    const signer = new BawSigner(runner, () => {}, "56", () => now);
    let pending = 0;
    const outcome = await signer.signRegistration(fields(account.address), { onPending: () => (pending += 1), pollMs: 5_000, waitMs: 60_000, sleep: async (ms) => void (now += ms) });
    expect(outcome).toEqual({ kind: "expired" });
    expect(pending).toBe(1);
    expect(calls.filter((c) => c[1] === "result")).toHaveLength(12);
    // The order id is forgotten once the wait is over.
    const order = "msg-order-1";
    await expect(signer.call("sign-message result", ["--order-id", order])).rejects.toMatchObject({ errorName: "NOT_ALLOWED" });
  });

  it("refuses an execute whose request id is given twice", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { runner } = fakeBaw({ account });
    const signer = new BawSigner(runner);
    await expect(signer.call("sign-message execute", ["--requestId", "req-1", "--requestId", "req-1"])).rejects.toMatchObject({ errorName: "NOT_ALLOWED" });
  });

  it("checks the wallet first: signed in, and in Developer Mode", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(await new BawSigner(fakeBaw({ account, connected: false }).runner).signRegistration(fields(account.address))).toEqual({ kind: "not-ready", reason: "signed-out" });
    expect(await new BawSigner(fakeBaw({ account, devMode: false }).runner).signRegistration(fields(account.address))).toEqual({ kind: "not-ready", reason: "devmode" });
  });

  it("reads signInMaxTime from the settings", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const settings = await new BawSigner(fakeBaw({ account, settings: { signInMaxTime: "2026-10-30T10:34:11+08:00", sessionExpireTime: "2026-10-24T00:26:09+08:00" } }).runner).settings();
    expect(settings.signInMaxTime).toBe("2026-10-30T10:34:11+08:00");
    expect(settings.sessionExpireTime).toBe("2026-10-24T00:26:09+08:00");
  });
});
