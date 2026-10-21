import { hashTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { joinSignature, nextIssuedAt, normalizeManifesto, previewDescribes, registerTypedData, registerTypedDataJson, signatureMatches, signRequestMessage, type RegisterFields } from "./message.ts";

// Synthetic fields; the wallet is a well-known documentation address, mixed-case so the checksum is exercised.
const FIELDS: RegisterFields = {
  wallet: "0x8ba1f109551bd432803012645ac136ddd64dba72",
  name: "maplegrin",
  strategy: "Small, fast bites on brand-new coins. I cut losses early and never chase.",
  issuedAt: 1792675500,
};

/**
 * Produced by 927's own builder (`src/lib/league/message.ts` at ce268d59, blob 9f2924fb):
 * `registerTypedDataJson(parseFields({ ...FIELDS, copies: null }).fields, 56)` and `registerDigest(…, "eip712")`.
 */
const GOLDEN_JSON =
  '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"}],"Register":[{"name":"wallet","type":"address"},{"name":"name","type":"string"},{"name":"strategy","type":"string"},{"name":"copies","type":"address"},{"name":"issuedAt","type":"uint256"}]},"primaryType":"Register","domain":{"name":"Feast League","version":"1","chainId":56},"message":{"wallet":"0x8ba1f109551bD432803012645Ac136ddd64DBA72","name":"maplegrin","strategy":"Small, fast bites on brand-new coins. I cut losses early and never chase.","copies":"0x0000000000000000000000000000000000000000","issuedAt":"1792675500"}}';
const GOLDEN_DIGEST_EN = "0x524a98283fe3669c0d15a86bee56a5dfa24f37024de5dd6b73d835a3d9848931";
const GOLDEN_DIGEST_ZH = "0x24391f6f21819cd1279d3e7075ebed7b2646a00142b36ea873a4a1a255da3545";

describe("the Register message", () => {
  it("is 927's typed data byte for byte, and hashes to 927's digest", () => {
    expect(registerTypedDataJson(FIELDS)).toBe(GOLDEN_JSON);
    expect(hashTypedData(registerTypedData(FIELDS))).toBe(GOLDEN_DIGEST_EN);
  });

  it("signs the normalised zh manifesto: NFKC turns the full-width comma into the one 927 hashed", () => {
    const zh = normalizeManifesto("只咬刚出生的新币，小口快吃。亏了就走，从不追高。");
    expect(zh.ok).toBe(true);
    expect(hashTypedData(registerTypedData({ ...FIELDS, strategy: (zh as { text: string }).text }))).toBe(GOLDEN_DIGEST_ZH);
  });

  it("asks the wallet with an eth_signTypedData_v4 request whose first parameter is the checksummed wallet", () => {
    const request = JSON.parse(signRequestMessage(FIELDS)) as { method: string; params: [string, string] };
    expect(request.method).toBe("eth_signTypedData_v4");
    expect(request.params[0]).toBe("0x8ba1f109551bD432803012645Ac136ddd64DBA72");
    expect(request.params[1]).toBe(GOLDEN_JSON);
  });
});

describe("the manifesto, as the page normalises it (927's normalizeStrategy, probed at ce268d59)", () => {
  it("folds whitespace and full-width forms", () => {
    expect(normalizeManifesto("  a\t\tb\n\nc  ")).toEqual({ ok: true, text: "a b c", length: 5 });
    expect(normalizeManifesto("ＡＢＣ　ｘ")).toEqual({ ok: true, text: "ABC x", length: 5 });
    expect(normalizeManifesto("é")).toEqual({ ok: true, text: "é", length: 1 });
  });

  it("counts code points: 280 is the most, in any script", () => {
    expect(normalizeManifesto("x".repeat(280)).ok).toBe(true);
    expect(normalizeManifesto("x".repeat(281))).toEqual({ ok: false, reason: "too-long", length: 281 });
    expect(normalizeManifesto("中".repeat(280)).ok).toBe(true);
    expect(normalizeManifesto("👍".repeat(280)).ok).toBe(true);
    expect(normalizeManifesto("👍".repeat(281)).ok).toBe(false);
  });

  it("refuses an emoji joiner and control characters, and says which", () => {
    expect(normalizeManifesto("👨‍👩")).toMatchObject({ ok: false, reason: "joiner" });
    expect(normalizeManifesto("a\u0007b")).toMatchObject({ ok: false, reason: "control" });
    expect(normalizeManifesto("a⁦b")).toMatchObject({ ok: false, reason: "control" });
    expect(normalizeManifesto(42)).toMatchObject({ ok: false, reason: "not-text" });
  });

  it("may be empty: the page takes an empty manifesto", () => {
    expect(normalizeManifesto("   ")).toEqual({ ok: true, text: "", length: 0 });
  });
});

describe("issuedAt", () => {
  it("is now, and always newer than the registration the page keeps", () => {
    expect(nextIssuedAt(1_792_675_500_900, null)).toBe(1792675500);
    expect(nextIssuedAt(1_792_675_500_000, 1792675400)).toBe(1792675500);
    expect(nextIssuedAt(1_792_675_500_000, 1792675500)).toBe(1792675501);
    expect(nextIssuedAt(1_792_675_500_000, 1792675600)).toBe(1792675601);
  });
});

describe("the wallet's signature", () => {
  it("is joined from r‖s and the recovery byte, and recovers the wallet", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fields = { ...FIELDS, wallet: account.address };
    const full = await account.signTypedData(registerTypedData(fields));
    const rs = full.slice(2, 130);
    const v = Number.parseInt(full.slice(130), 16);
    const joined = joinSignature(rs, v === 28 ? "01" : "00");
    expect(joined).toBe(full);
    expect(await signatureMatches(fields, joined!)).toBe(true);
    // 65 bytes, with or without 0x, with v as 27/28 or 0/1.
    expect(joinSignature(full, null)).toBe(full);
    expect(joinSignature(`${rs}${v === 28 ? "01" : "00"}`, null)).toBe(full);
  });

  it("does not recover the wallet for other fields, a wrong recovery byte or another signer", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fields = { ...FIELDS, wallet: account.address };
    const full = await account.signTypedData(registerTypedData(fields));
    const rs = full.slice(2, 130);
    const wrongV = joinSignature(rs, full.endsWith("1c") ? "00" : "01")!;
    expect(await signatureMatches(fields, wrongV)).toBe(false);
    expect(await signatureMatches({ ...fields, strategy: "something else" }, full)).toBe(false);
    expect(await signatureMatches({ ...fields, wallet: FIELDS.wallet }, full)).toBe(false);
  });

  it("refuses shapes it cannot read, so they are never sent", () => {
    expect(joinSignature("abc", "00")).toBeNull();
    expect(joinSignature("a".repeat(128), null)).toBeNull();
    expect(joinSignature("a".repeat(128), "02")).toBeNull();
    expect(joinSignature(`${"a".repeat(128)}05`, null)).toBeNull();
    expect(joinSignature(null, "00")).toBeNull();
  });
});

describe("the wallet's preview of the message", () => {
  const parsed = (overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
    messageType: "SignTypedData",
    preCheckCode: "",
    version: "V4",
    message: JSON.stringify({ ...JSON.parse(GOLDEN_JSON), ...overrides, message: { ...JSON.parse(GOLDEN_JSON).message, ...message } }),
  });

  it("matches when it reads back the same domain and fields", () => {
    expect(previewDescribes(parsed(), FIELDS)).toEqual({ ok: true });
  });

  it("matches the reading the wallet gives live: the message part alone, as JSON (measured 2026-10-22)", () => {
    const live = { messageType: "SignTypedData", preCheckCode: "", version: "V4", message: JSON.stringify(JSON.parse(GOLDEN_JSON).message) };
    expect(previewDescribes(live, FIELDS)).toEqual({ ok: true });
    const other = { ...live, message: JSON.stringify({ ...JSON.parse(GOLDEN_JSON).message, name: "someoneelse" }) };
    expect(previewDescribes(other, FIELDS).ok).toBe(false);
  });

  it("refuses another domain, another type, other fields, or a pre-check code", () => {
    expect(previewDescribes(parsed({ domain: { name: "Permit2", version: "1", chainId: 56 } }), FIELDS).ok).toBe(false);
    expect(previewDescribes(parsed({ domain: { name: "Feast League", version: "1", chainId: 56, verifyingContract: "0x0000000000000000000000000000000000000001" } }), FIELDS).ok).toBe(false);
    expect(previewDescribes(parsed({ primaryType: "Permit" }), FIELDS).ok).toBe(false);
    expect(previewDescribes(parsed({}, { strategy: "another manifesto" }), FIELDS).ok).toBe(false);
    expect(previewDescribes(parsed({}, { issuedAt: "1" }), FIELDS).ok).toBe(false);
    expect(previewDescribes({ ...parsed(), preCheckCode: "E1" }, FIELDS).ok).toBe(false);
    expect(previewDescribes({ messageType: "PersonalSign", message: "x" }, FIELDS).ok).toBe(false);
    expect(previewDescribes({ messageType: "SignTypedData", message: "not json" }, FIELDS).ok).toBe(false);
  });
});
