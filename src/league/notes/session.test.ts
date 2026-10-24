import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import { BawSigner } from "../baw.ts";
import { fakeBaw } from "../register/fakes.ts";
import { LeagueSite } from "../register/site.ts";
import { FakeFeast, SITE } from "../data/fakes.ts";
import { NOTE_SESSION_TYPES, noteSessionTypedData, noteSessionTypedDataJson, notesLogin, openSession, readSession, sessionPath } from "./session.ts";

let homes: string[] = [];
afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

const NONCE: Hex = `0x${"5e".repeat(32)}`;

function world(answer: ConstructorParameters<typeof FakeFeast>[0] = { session: { status: 201, body: { token: "tok-1", expiresAt: "2026-11-04T13:00:00.000Z", season: 1 } } }, baw: Partial<Parameters<typeof fakeBaw>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), "feast-league-session-"));
  homes.push(home);
  const account = privateKeyToAccount(generatePrivateKey());
  const { runner, calls } = fakeBaw({ account, ...baw });
  const signer = new BawSigner(runner);
  const feast = new FakeFeast(answer);
  const site = new LeagueSite(SITE, feast.fetch, 200);
  return { home, account, signer, feast, site, calls };
}

describe("the NoteSession message", () => {
  it("is EIP-712 typed data on the league's domain: wallet, agentId, season, nonce", () => {
    expect(NOTE_SESSION_TYPES).toEqual({
      NoteSession: [
        { name: "wallet", type: "address" },
        { name: "agentId", type: "string" },
        { name: "season", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    });
    const fields = { wallet: "0x000000000000000000000000000000000000a11c" as const, agentId: "maplegrin", season: 1, nonce: NONCE };
    const typed = noteSessionTypedData(fields);
    expect(typed.domain).toEqual({ name: "Feast League", version: "1", chainId: 56 });
    expect(typed.primaryType).toBe("NoteSession");
    expect(JSON.parse(noteSessionTypedDataJson(fields))).toEqual({
      types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], NoteSession: NOTE_SESSION_TYPES.NoteSession },
      primaryType: "NoteSession",
      domain: { name: "Feast League", version: "1", chainId: 56 },
      message: { wallet: "0x000000000000000000000000000000000000a11c", agentId: "maplegrin", season: "1", nonce: NONCE },
    });
    expect(hashTypedData(typed)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("opening a notes session", () => {
  it("signs once through the wallet's own preview, POSTs it, and keeps the token beside the notes, without the wallet's address", async () => {
    const w = world();
    const out = await openSession({ home: w.home, signer: w.signer, site: w.site, agentId: "maplegrin", season: 1, nonce: NONCE, now: () => Date.parse("2026-10-28T13:00:00Z") });
    expect(out).toMatchObject({ kind: "open", session: { agentId: "maplegrin", season: 1, token: "tok-1", expiresAt: "2026-11-04T13:00:00.000Z" } });
    expect(w.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["wallet address", "wallet status", "wallet settings", "sign-message preview", "sign-message execute"]);
    const [body] = w.feast.sessions as { wallet: string; agentId: string; season: number; nonce: string; scheme: string; signature: string; signatureRecovery?: string }[];
    expect(body).toMatchObject({ wallet: w.account.address.toLowerCase(), agentId: "maplegrin", season: 1, nonce: NONCE, scheme: "eip712" });
    // The page can rebuild the typed data from the body and recover the wallet.
    const v = body!.signatureRecovery === "01" ? "1c" : "1b";
    const signer = await recoverTypedDataAddress({ ...noteSessionTypedData({ wallet: w.account.address, agentId: "maplegrin", season: 1, nonce: NONCE }), signature: `0x${body!.signature}${v}` });
    expect(signer).toBe(w.account.address);
    expect(readSession(w.home)).toMatchObject({ token: "tok-1", season: 1, agentId: "maplegrin" });
    expect(readFileSync(sessionPath(w.home), "utf8").toLowerCase()).not.toContain(w.account.address.slice(2).toLowerCase());
  });

  it("a route that is not there yet, a decline, or a refusal: no token, and each says so", async () => {
    const down = world({ session: { status: 404, body: {} } });
    expect(await openSession({ home: down.home, signer: down.signer, site: down.site, agentId: "maplegrin", season: 1 })).toMatchObject({ kind: "unavailable" });
    expect(readSession(down.home)).toBeNull();
    const declined = world(undefined, { confirm: { kind: "app", polls: 1, then: "REJECTED" } });
    expect(await openSession({ home: declined.home, signer: declined.signer, site: declined.site, agentId: "maplegrin", season: 1, signOptions: { pollMs: 1, sleep: async () => {} } })).toMatchObject({ kind: "not-signed", why: "declined" });
    expect(declined.feast.sessions).toEqual([]);
    const refused = world({ session: { status: 403, body: { code: "not-seated" } } });
    expect(await openSession({ home: refused.home, signer: refused.signer, site: refused.site, agentId: "maplegrin", season: 1 })).toMatchObject({ kind: "refused", status: 403, code: "not-seated" });
  });

  it("a tampered preview is never signed: only the signer's own NoteSession preview may be executed", async () => {
    const w = world(undefined, { tamper: true });
    expect(await openSession({ home: w.home, signer: w.signer, site: w.site, agentId: "maplegrin", season: 1 })).toMatchObject({ kind: "not-signed", why: "mismatch" });
    expect(w.calls.some((c) => c[1] === "execute")).toBe(false);
    await expect(w.signer.call("sign-message execute", ["--requestId", "req-1"])).rejects.toMatchObject({ errorName: "NOT_ALLOWED" });
  });

  it("FL note --login: the Agent ID from FL enter's record, the season from the page, one line", async () => {
    const w = world();
    const { writeJsonAtomic } = await import("../store.ts");
    writeJsonAtomic(join(w.home, "agents", "league-entry", "entry.json"), { agentId: "maplegrin", bodyCoin: null, launchTx: null, notes: null });
    const out = await notesLogin({ home: w.home, signer: w.signer, site: w.site });
    expect(out).toMatchObject({ code: 0, text: "Notes session open for maplegrin.ai, season 1: your agent's notes reach feast.meme." });
    const none = world();
    expect(await notesLogin({ home: none.home, signer: none.signer, site: none.site })).toMatchObject({ code: 2, text: "No Agent ID on this machine: run FL enter first." });
  });
});
